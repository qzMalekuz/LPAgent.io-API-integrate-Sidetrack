import "dotenv/config";
import { Sidetrack, runMigrations } from "sidetrack";
import { getPrisma } from "./db.js";
import {
  discoverPools,
  getOpenPositions,
  generateZapOut,
  submitZapOut,
  getZapOutQuotes,
  generateZapIn,
  submitZapIn,
  type ZapStrategy,
  type ZapOutput,
} from "./lpagent.js";
import { signTransaction, getWalletAddress } from "./wallet.js";

// ---------------------------------------------------------------------------
// Queue payload types
// ---------------------------------------------------------------------------

/** Discover top Meteora pools and sync to DB */
export interface SyncPoolsPayload {
  sortBy?: "tvl" | "volume" | "apr";
  minTvlUsd?: number;
  limit?: number;
}

/** Fetch open positions for a wallet, upsert to DB, trigger alerts/zaps */
export interface MonitorPositionsPayload {
  walletAddress: string;
  /**
   * When true and AUTOPILOT_ENABLED=true, out-of-range positions will be
   * automatically zapped out. Default: false (alert-only).
   */
  autoZapOut?: boolean;
}

/** Alert when a position goes out of range */
export interface AlertOutOfRangePayload {
  walletAddress: string;
  positionId: string;
  poolName: string;
}

/**
 * Execute a full zap-out for a position:
 * 1. Get quotes from LP Agent
 * 2. Generate unsigned tx
 * 3. Sign with bot wallet
 * 4. Submit via Jito landing endpoint
 */
export interface ExecuteZapOutPayload {
  walletAddress: string;
  positionId: string;
  /** Percentage to withdraw in basis points (default: 10000 = 100%) */
  bps?: number;
  output?: ZapOutput;
  slippageBps?: number;
  /** Internal ZapTransaction.id to update status */
  zapTransactionId?: string;
}

/**
 * Execute a full zap-in for a pool:
 * 1. Generate unsigned tx from LP Agent
 * 2. Sign with bot wallet
 * 3. Submit via Jito landing endpoint
 */
export interface ExecuteZapInPayload {
  walletAddress: string;
  poolId: string;
  strategy: ZapStrategy;
  fromBinId: number;
  toBinId: number;
  amountX?: string;
  amountY?: string;
  slippageBps?: number;
  /** Internal ZapTransaction.id to update status */
  zapTransactionId?: string;
}

export type AppQueues = {
  syncPools: SyncPoolsPayload;
  monitorPositions: MonitorPositionsPayload;
  alertOutOfRange: AlertOutOfRangePayload;
  executeZapOut: ExecuteZapOutPayload;
  executeZapIn: ExecuteZapInPayload;
};

// ---------------------------------------------------------------------------
// Sidetrack singleton
// ---------------------------------------------------------------------------

let _sidetrack: Sidetrack<AppQueues> | null = null;

export function getSidetrack(): Sidetrack<AppQueues> {
  if (!_sidetrack) {
    throw new Error("Sidetrack has not been initialised — call initSidetrack() first");
  }
  return _sidetrack;
}

// ---------------------------------------------------------------------------
// Queue handler: syncPools
// ---------------------------------------------------------------------------

async function handleSyncPools(payload: SyncPoolsPayload): Promise<void> {
  const { sortBy = "tvl", minTvlUsd = 10_000, limit = 50 } = payload;
  console.log(`[syncPools] Discovering top ${limit} pools (sortBy: ${sortBy}, minTvl: $${minTvlUsd})`);

  const result = await discoverPools({ sortBy, minTvl: minTvlUsd, limit });
  const prisma = getPrisma();

  await Promise.all(
    result.pools.map((pool) =>
      prisma.pool.upsert({
        where: { poolId: pool.poolId },
        create: {
          poolId: pool.poolId,
          name: pool.name,
          tokenX: pool.tokenX,
          tokenY: pool.tokenY,
          tokenXSymbol: pool.tokenXSymbol,
          tokenYSymbol: pool.tokenYSymbol,
          binStep: pool.binStep,
          baseFeePercent: pool.baseFeePercent,
          tvlUsd: pool.tvlUsd,
          volume24hUsd: pool.volume24hUsd,
          apr: pool.apr,
          currentPrice: pool.currentPrice,
          lastSyncedAt: new Date(),
        },
        update: {
          tvlUsd: pool.tvlUsd,
          volume24hUsd: pool.volume24hUsd,
          apr: pool.apr,
          currentPrice: pool.currentPrice,
          lastSyncedAt: new Date(),
        },
      })
    )
  );

  console.log(`[syncPools] Upserted ${result.pools.length} pools`);
}

// ---------------------------------------------------------------------------
// Queue handler: monitorPositions
// ---------------------------------------------------------------------------

async function handleMonitorPositions(
  payload: MonitorPositionsPayload
): Promise<void> {
  const { walletAddress, autoZapOut = false } = payload;
  const autopilotEnabled =
    autoZapOut && process.env["AUTOPILOT_ENABLED"] === "true";

  console.log(
    `[monitorPositions] Checking positions for ${walletAddress} (autopilot: ${autopilotEnabled})`
  );

  const result = await getOpenPositions(walletAddress);
  const prisma = getPrisma();
  const st = getSidetrack();

  for (const pos of result.positions) {
    // Ensure the pool exists in DB first (create a stub if not yet synced)
    await prisma.pool.upsert({
      where: { poolId: pos.poolId },
      create: {
        poolId: pos.poolId,
        name: pos.poolName,
        tokenX: "",
        tokenY: "",
        tokenXSymbol: pos.tokenXSymbol,
        tokenYSymbol: pos.tokenYSymbol,
        binStep: 0,
        baseFeePercent: 0,
        lastSyncedAt: new Date(),
      },
      update: {},
    });

    await prisma.position.upsert({
      where: { positionId: pos.positionId },
      create: {
        positionId: pos.positionId,
        walletAddress,
        poolId: pos.poolId,
        lowerBinId: pos.lowerBinId,
        upperBinId: pos.upperBinId,
        activeBinId: pos.activeBinId,
        inRange: pos.inRange,
        totalXAmount: pos.totalXAmount,
        totalYAmount: pos.totalYAmount,
        feeX: pos.feeX,
        feeY: pos.feeY,
        valueUsd: pos.valueUsd,
        feesEarnedUsd: pos.feesEarnedUsd,
        lastCheckedAt: new Date(),
      },
      update: {
        activeBinId: pos.activeBinId,
        inRange: pos.inRange,
        totalXAmount: pos.totalXAmount,
        totalYAmount: pos.totalYAmount,
        feeX: pos.feeX,
        feeY: pos.feeY,
        valueUsd: pos.valueUsd,
        feesEarnedUsd: pos.feesEarnedUsd,
        lastCheckedAt: new Date(),
      },
    });

    if (!pos.inRange) {
      if (autopilotEnabled) {
        // Create a ZapTransaction record then queue the zap-out job
        const zapTx = await prisma.zapTransaction.create({
          data: {
            type: "ZAP_OUT",
            status: "PENDING",
            walletAddress,
            positionId: pos.positionId,
            poolId: pos.poolId,
            bps: 10000,
            outputMode: "both",
            slippageBps: 50,
          },
        });

        await st.insertJob("executeZapOut", {
          walletAddress,
          positionId: pos.positionId,
          bps: 10000,
          output: "both",
          slippageBps: 50,
          zapTransactionId: zapTx.id,
        });

        console.log(
          `[monitorPositions] Queued auto-zap-out for position ${pos.positionId} (pool: ${pos.poolName})`
        );
      } else {
        // Alert-only mode
        await st.insertJob("alertOutOfRange", {
          walletAddress,
          positionId: pos.positionId,
          poolName: pos.poolName,
        });
      }
    }
  }

  const outOfRange = result.positions.filter((p) => !p.inRange).length;
  console.log(
    `[monitorPositions] ${result.positions.length} positions, ${outOfRange} out-of-range`
  );
}

// ---------------------------------------------------------------------------
// Queue handler: alertOutOfRange
// ---------------------------------------------------------------------------

async function handleAlertOutOfRange(
  payload: AlertOutOfRangePayload
): Promise<void> {
  const { walletAddress, positionId, poolName } = payload;
  console.log(
    `[alertOutOfRange] Creating alert for wallet ${walletAddress}, pool ${poolName}`
  );

  const prisma = getPrisma();
  await prisma.alert.create({
    data: {
      walletAddress,
      positionId,
      type: "OUT_OF_RANGE",
      status: "PENDING",
      message: `Position in pool "${poolName}" moved out of range. Consider re-ranging or closing the position.`,
      metadata: { triggeredAt: new Date().toISOString() },
    },
  });

  console.log(`[alertOutOfRange] Alert saved for ${walletAddress} / ${poolName}`);
}

// ---------------------------------------------------------------------------
// Queue handler: executeZapOut
// ---------------------------------------------------------------------------

async function handleExecuteZapOut(
  payload: ExecuteZapOutPayload
): Promise<void> {
  const {
    walletAddress,
    positionId,
    bps = 10000,
    output = "both",
    slippageBps = 50,
    zapTransactionId,
  } = payload;

  const prisma = getPrisma();

  const updateZapStatus = async (
    status: "SIGNED" | "SUBMITTED" | "CONFIRMED" | "FAILED",
    extra?: { txSignature?: string; errorMessage?: string }
  ) => {
    if (!zapTransactionId) return;
    await prisma.zapTransaction.update({
      where: { id: zapTransactionId },
      data: { status, ...extra },
    });
  };

  console.log(
    `[executeZapOut] Starting zap-out for position ${positionId} (${bps / 100}%, output: ${output})`
  );

  try {
    // 1. Get quote first so we can log estimated value
    const quote = await getZapOutQuotes({
      positionId,
      owner: walletAddress,
      bps,
      slippageBps,
      output,
    });

    console.log(
      `[executeZapOut] Quote: ~$${quote.estimatedValueUsd.toFixed(2)}, impact: ${quote.priceImpactPct.toFixed(3)}%`
    );

    if (zapTransactionId) {
      await prisma.zapTransaction.update({
        where: { id: zapTransactionId },
        data: { estimatedValueUsd: quote.estimatedValueUsd },
      });
    }

    // 2. Generate unsigned transaction
    const zapOutTx = await generateZapOut({
      positionId,
      owner: walletAddress,
      bps,
      slippageBps,
      output,
    });

    // 3. Sign with bot wallet
    const signedTx = signTransaction(zapOutTx.transaction);
    await updateZapStatus("SIGNED");
    console.log(`[executeZapOut] Transaction signed by ${getWalletAddress()}`);

    // 4. Submit via Jito landing endpoint
    const result = await submitZapOut({ signedTransaction: signedTx });
    await updateZapStatus("SUBMITTED", { txSignature: result.txSignature });

    console.log(
      `[executeZapOut] Submitted tx: ${result.txSignature}${result.bundleId ? ` (bundle: ${result.bundleId})` : ""}`
    );

    await updateZapStatus("CONFIRMED", { txSignature: result.txSignature });

    // Create an alert so the user knows the action was taken
    await prisma.alert.create({
      data: {
        walletAddress,
        positionId,
        type: "OUT_OF_RANGE",
        status: "RESOLVED",
        message: `Auto-zapped out of position (${bps / 100}%). Tx: ${result.txSignature}`,
        metadata: {
          txSignature: result.txSignature,
          estimatedValueUsd: quote.estimatedValueUsd,
          triggeredAt: new Date().toISOString(),
        },
        resolvedAt: new Date(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[executeZapOut] Failed for position ${positionId}: ${message}`);
    await updateZapStatus("FAILED", { errorMessage: message });
    throw err; // let Sidetrack retry
  }
}

// ---------------------------------------------------------------------------
// Queue handler: executeZapIn
// ---------------------------------------------------------------------------

async function handleExecuteZapIn(payload: ExecuteZapInPayload): Promise<void> {
  const {
    walletAddress,
    poolId,
    strategy,
    fromBinId,
    toBinId,
    amountX,
    amountY,
    slippageBps = 50,
    zapTransactionId,
  } = payload;

  const prisma = getPrisma();

  const updateZapStatus = async (
    status: "SIGNED" | "SUBMITTED" | "CONFIRMED" | "FAILED",
    extra?: { txSignature?: string; errorMessage?: string }
  ) => {
    if (!zapTransactionId) return;
    await prisma.zapTransaction.update({
      where: { id: zapTransactionId },
      data: { status, ...extra },
    });
  };

  console.log(
    `[executeZapIn] Starting zap-in for pool ${poolId} (strategy: ${strategy}, bins: ${fromBinId}–${toBinId})`
  );

  try {
    // 1. Generate unsigned transaction
    const zapInTx = await generateZapIn(poolId, {
      owner: walletAddress,
      strategy,
      fromBinId,
      toBinId,
      ...(amountX !== undefined ? { amountX } : {}),
      ...(amountY !== undefined ? { amountY } : {}),
      slippageBps,
    });

    // 2. Sign with bot wallet
    const signedTx = signTransaction(zapInTx.transaction);
    await updateZapStatus("SIGNED");
    console.log(`[executeZapIn] Transaction signed by ${getWalletAddress()}`);

    // 3. Submit via Jito landing endpoint
    const result = await submitZapIn({ signedTransaction: signedTx });
    await updateZapStatus("SUBMITTED", { txSignature: result.txSignature });

    console.log(
      `[executeZapIn] Submitted tx: ${result.txSignature}${result.bundleId ? ` (bundle: ${result.bundleId})` : ""}`
    );

    await updateZapStatus("CONFIRMED", { txSignature: result.txSignature });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[executeZapIn] Failed for pool ${poolId}: ${message}`);
    await updateZapStatus("FAILED", { errorMessage: message });
    throw err; // let Sidetrack retry
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export async function initSidetrack(): Promise<Sidetrack<AppQueues>> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL environment variable is not set");

  await runMigrations(databaseUrl);

  _sidetrack = new Sidetrack<AppQueues>({
    databaseOptions: { databaseUrl },
    queues: {
      syncPools: {
        maxAttempts: 3,
        run: (payload) => handleSyncPools(payload),
      },
      monitorPositions: {
        maxAttempts: 3,
        run: (payload) => handleMonitorPositions(payload),
      },
      alertOutOfRange: {
        maxAttempts: 5,
        run: (payload) => handleAlertOutOfRange(payload),
      },
      executeZapOut: {
        maxAttempts: 3,
        run: (payload) => handleExecuteZapOut(payload),
      },
      executeZapIn: {
        maxAttempts: 3,
        run: (payload) => handleExecuteZapIn(payload),
      },
    },
  });

  return _sidetrack;
}
