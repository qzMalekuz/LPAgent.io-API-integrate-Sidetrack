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
  getPoolInfo,
  getTopLpers,
  type ZapStrategy,
  type ZapOutput,
} from "./lpagent.js";
import { signTransaction, getWalletAddress } from "./wallet.js";
import { notifyWallet } from "./telegram.js";
import {
  scorePositionHealth,
  impermanentLossPct,
  binToPrice,
} from "./intelligence.js";

export interface SyncPoolsPayload {
  sortBy?: "tvl" | "volume" | "apr";
  minTvlUsd?: number;
  limit?: number;
}

export interface MonitorPositionsPayload {
  walletAddress: string;
  autoZapOut?: boolean;
}

export interface AlertOutOfRangePayload {
  walletAddress: string;
  positionId: string;
  poolName: string;
}

export interface ExecuteZapOutPayload {
  walletAddress: string;
  positionId: string;
  bps?: number;
  output?: ZapOutput;
  slippageBps?: number;
  zapTransactionId?: string;
}

export interface ExecuteZapInPayload {
  walletAddress: string;
  poolId: string;
  strategy: ZapStrategy;
  fromBinId: number;
  toBinId: number;
  amountX?: string;
  amountY?: string;
  slippageBps?: number;
  zapTransactionId?: string;
}

export interface CopyLpPollPayload {
  subscriptionId?: string;
}

export interface GenerateInsightsPayload {
  walletAddress: string;
}

export type AppQueues = {
  syncPools: SyncPoolsPayload;
  monitorPositions: MonitorPositionsPayload;
  alertOutOfRange: AlertOutOfRangePayload;
  executeZapOut: ExecuteZapOutPayload;
  executeZapIn: ExecuteZapInPayload;
  copyLpPoll: CopyLpPollPayload;
  generateInsights: GenerateInsightsPayload;
};

let _sidetrack: Sidetrack<AppQueues> | null = null;

export function getSidetrack(): Sidetrack<AppQueues> {
  if (!_sidetrack) {
    throw new Error("sidetrack not initialised, call initSidetrack() first");
  }
  return _sidetrack;
}

async function handleSyncPools(payload: SyncPoolsPayload): Promise<void> {
  const { sortBy = "tvl", minTvlUsd = 10_000, limit = 50 } = payload;
  console.log(`[syncPools] discovering top ${limit} (sortBy=${sortBy} minTvl=$${minTvlUsd})`);

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

  console.log(`[syncPools] upserted ${result.pools.length} pools`);
}

async function handleMonitorPositions(
  payload: MonitorPositionsPayload
): Promise<void> {
  const { walletAddress, autoZapOut = false } = payload;
  const autopilotEnabled =
    autoZapOut && process.env["AUTOPILOT_ENABLED"] === "true";

  console.log(
    `[monitorPositions] ${walletAddress} (autopilot=${autopilotEnabled})`
  );

  const result = await getOpenPositions(walletAddress);
  const prisma = getPrisma();
  const st = getSidetrack();

  for (const pos of result.positions) {
    // stub the pool row if it hasn't been synced yet so the FK holds
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
          `[monitorPositions] auto-zap-out queued for ${pos.positionId} (${pos.poolName})`
        );
      } else {
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

async function handleAlertOutOfRange(
  payload: AlertOutOfRangePayload
): Promise<void> {
  const { walletAddress, positionId, poolName } = payload;
  console.log(`[alertOutOfRange] ${walletAddress} / ${poolName}`);

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

  await notifyWallet(
    walletAddress,
    [
      "*Position out of range*",
      "",
      `Pool: *${poolName}*`,
      `Position: \`${positionId.slice(0, 8)}...\``,
      "",
      "Use /positions to zap out, or enable autopilot to do it automatically.",
    ].join("\n"),
    { kind: "alert" }
  );
}

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
    `[executeZapOut] ${positionId} (${bps / 100}%, output=${output})`
  );

  try {
    const quote = await getZapOutQuotes({
      positionId,
      owner: walletAddress,
      bps,
      slippageBps,
      output,
    });

    console.log(
      `[executeZapOut] quote ~$${quote.estimatedValueUsd.toFixed(2)}, impact ${quote.priceImpactPct.toFixed(3)}%`
    );

    if (zapTransactionId) {
      await prisma.zapTransaction.update({
        where: { id: zapTransactionId },
        data: { estimatedValueUsd: quote.estimatedValueUsd },
      });
    }

    const zapOutTx = await generateZapOut({
      positionId,
      owner: walletAddress,
      bps,
      slippageBps,
      output,
    });

    const signedTx = signTransaction(zapOutTx.transaction);
    await updateZapStatus("SIGNED");
    console.log(`[executeZapOut] signed by ${getWalletAddress()}`);

    const result = await submitZapOut({ signedTransaction: signedTx });
    await updateZapStatus("SUBMITTED", { txSignature: result.txSignature });

    console.log(
      `[executeZapOut] submitted ${result.txSignature}${result.bundleId ? ` (bundle ${result.bundleId})` : ""}`
    );

    await updateZapStatus("CONFIRMED", { txSignature: result.txSignature });

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

    await notifyWallet(
      walletAddress,
      [
        "*Zap-out confirmed*",
        "",
        `Position: \`${positionId.slice(0, 8)}...\`  (${bps / 100}%)`,
        `Estimated value: *$${quote.estimatedValueUsd.toFixed(2)}*`,
        `Price impact: ${quote.priceImpactPct.toFixed(3)}%`,
        `Tx: [${result.txSignature.slice(0, 10)}...](https://solscan.io/tx/${result.txSignature})`,
      ].join("\n"),
      { kind: "zap" }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[executeZapOut] failed for ${positionId}: ${message}`);
    await updateZapStatus("FAILED", { errorMessage: message });
    await notifyWallet(
      walletAddress,
      `*Zap-out failed* for \`${positionId.slice(0, 8)}...\`\n\n\`${message}\``,
      { kind: "zap" }
    );
    throw err;
  }
}

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
    `[executeZapIn] pool=${poolId} strategy=${strategy} bins=${fromBinId}-${toBinId}`
  );

  try {
    const zapInTx = await generateZapIn(poolId, {
      owner: walletAddress,
      strategy,
      fromBinId,
      toBinId,
      ...(amountX !== undefined ? { amountX } : {}),
      ...(amountY !== undefined ? { amountY } : {}),
      slippageBps,
    });

    const signedTx = signTransaction(zapInTx.transaction);
    await updateZapStatus("SIGNED");
    console.log(`[executeZapIn] signed by ${getWalletAddress()}`);

    const result = await submitZapIn({ signedTransaction: signedTx });
    await updateZapStatus("SUBMITTED", { txSignature: result.txSignature });

    console.log(
      `[executeZapIn] submitted ${result.txSignature}${result.bundleId ? ` (bundle ${result.bundleId})` : ""}`
    );

    await updateZapStatus("CONFIRMED", { txSignature: result.txSignature });

    await notifyWallet(
      walletAddress,
      [
        "*Zap-in confirmed*",
        "",
        `Pool: \`${poolId.slice(0, 8)}...\`  (${strategy})`,
        `Bins: ${fromBinId} -> ${toBinId}`,
        `Tx: [${result.txSignature.slice(0, 10)}...](https://solscan.io/tx/${result.txSignature})`,
      ].join("\n"),
      { kind: "zap" }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[executeZapIn] failed for ${poolId}: ${message}`);
    await updateZapStatus("FAILED", { errorMessage: message });
    await notifyWallet(
      walletAddress,
      `*Zap-in failed* for pool \`${poolId.slice(0, 8)}...\`\n\n\`${message}\``,
      { kind: "zap" }
    );
    throw err;
  }
}

async function handleCopyLpPoll(payload: CopyLpPollPayload): Promise<void> {
  const prisma = getPrisma();
  const subs = await prisma.copyLpSubscription.findMany({
    where: {
      active: true,
      ...(payload.subscriptionId ? { id: payload.subscriptionId } : {}),
    },
  });

  console.log(`[copyLpPoll] checking ${subs.length} subscription(s)`);

  for (const sub of subs) {
    try {
      const leaderPositions = await getOpenPositions(sub.leaderWallet);
      const targetPositions = leaderPositions.positions.filter(
        (p) => p.poolId === sub.poolId
      );

      if (targetPositions.length === 0) continue;

      const leaderPos = targetPositions[0]!;
      const fingerprint = `${leaderPos.lowerBinId}-${leaderPos.upperBinId}`;

      // already mirrored this exact range; skip
      if (sub.lastMirrorTxId === fingerprint) continue;

      const pool = await getPoolInfo(sub.poolId);

      // 50/50 USD split. Decimal assumptions are heuristics until /token/balance
      // is wired in to read the pair's real decimals.
      const halfUsd = sub.capitalUsd / 2;
      const amountYRaw = Math.floor(halfUsd * 1_000_000).toString();
      const amountXRaw = Math.floor(
        (halfUsd / pool.currentPrice) * 1_000_000_000
      ).toString();

      const st = getSidetrack();
      const zapTx = await prisma.zapTransaction.create({
        data: {
          type: "ZAP_IN",
          status: "PENDING",
          walletAddress: sub.followerWallet,
          poolId: sub.poolId,
          strategy: sub.strategy,
          fromBinId: leaderPos.lowerBinId,
          toBinId: leaderPos.upperBinId,
          amountX: amountXRaw,
          amountY: amountYRaw,
          slippageBps: 100,
          source: "copylp",
        },
      });

      await st.insertJob("executeZapIn", {
        walletAddress: sub.followerWallet,
        poolId: sub.poolId,
        strategy: sub.strategy as ZapStrategy,
        fromBinId: leaderPos.lowerBinId,
        toBinId: leaderPos.upperBinId,
        amountX: amountXRaw,
        amountY: amountYRaw,
        slippageBps: 100,
        zapTransactionId: zapTx.id,
      });

      await prisma.copyLpSubscription.update({
        where: { id: sub.id },
        data: { lastMirroredAt: new Date(), lastMirrorTxId: fingerprint },
      });

      await prisma.alert.create({
        data: {
          walletAddress: sub.followerWallet,
          positionId: leaderPos.positionId,
          type: "COPY_TRIGGER",
          status: "PENDING",
          message: `Copy-LP: mirroring ${sub.leaderWallet.slice(0, 6)} in ${pool.tokenXSymbol}/${pool.tokenYSymbol} bins ${leaderPos.lowerBinId}-${leaderPos.upperBinId} with $${sub.capitalUsd}.`,
          metadata: {
            leaderWallet: sub.leaderWallet,
            poolId: sub.poolId,
            fromBinId: leaderPos.lowerBinId,
            toBinId: leaderPos.upperBinId,
          },
        },
      });

      await notifyWallet(
        sub.followerWallet,
        [
          "*Copy-LP triggered*",
          "",
          `Mirroring \`${sub.leaderWallet.slice(0, 6)}...\` in *${pool.tokenXSymbol}/${pool.tokenYSymbol}*`,
          `Bins ${leaderPos.lowerBinId} -> ${leaderPos.upperBinId}  -  Capital: $${sub.capitalUsd}`,
          "",
          "Submitting zap-in now...",
        ].join("\n"),
        { kind: "zap" }
      );

      console.log(
        `[copyLpPoll] mirror queued for ${sub.followerWallet.slice(0, 6)} -> ${pool.tokenXSymbol}/${pool.tokenYSymbol}`
      );
    } catch (err) {
      console.error(
        `[copyLpPoll] subscription ${sub.id} failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

async function handleGenerateInsights(
  payload: GenerateInsightsPayload
): Promise<void> {
  const { walletAddress } = payload;
  const prisma = getPrisma();

  const open = await getOpenPositions(walletAddress);
  console.log(
    `[generateInsights] ${open.positions.length} positions for ${walletAddress.slice(0, 6)}`
  );

  for (const pos of open.positions) {
    const health = scorePositionHealth(pos);

    if (health.score < 60) {
      await prisma.insight.create({
        data: {
          walletAddress,
          poolId: pos.poolId,
          type: "PORTFOLIO_REBALANCE",
          severity: health.score < 40 ? "CRITICAL" : "WARNING",
          title: `Position health low: ${pos.poolName}`,
          body: health.warnings.join(" - "),
          data: {
            positionId: pos.positionId,
            score: health.score,
            valueUsd: pos.valueUsd,
            inRange: pos.inRange,
          },
        },
      });
    }

    const midBin = (pos.lowerBinId + pos.upperBinId) / 2;
    const drift = Math.abs(pos.activeBinId - midBin);
    const range = pos.upperBinId - pos.lowerBinId;
    if (range > 0 && drift / range > 0.4) {
      try {
        const pool = await getPoolInfo(pos.poolId);
        const pEntry = binToPrice(midBin, pool.binStep);
        const pNow = pool.currentPrice;
        const pLower = binToPrice(pos.lowerBinId, pool.binStep);
        const pUpper = binToPrice(pos.upperBinId, pool.binStep);
        const il = impermanentLossPct({ pEntry, pNow, pLower, pUpper });
        if (il < -0.005) {
          await prisma.insight.create({
            data: {
              walletAddress,
              poolId: pos.poolId,
              type: "IL_WARNING",
              severity: il < -0.02 ? "CRITICAL" : "WARNING",
              title: `IL accumulating in ${pos.poolName}`,
              body: `Estimated impermanent loss vs HODL: ${(il * 100).toFixed(2)}%. Consider rebalancing.`,
              data: { ilPct: il, pNow, pEntry, pLower, pUpper },
            },
          });
        }
      } catch {
        // pool fetch failed; skip the IL insight for this pos
      }
    }
  }

  const topPools = await prisma.pool.findMany({
    orderBy: { apr: "desc" },
    take: 3,
  });
  const heldPoolIds = new Set(open.positions.map((p) => p.poolId));
  for (const pool of topPools) {
    if (!heldPoolIds.has(pool.poolId) && pool.apr > 50) {
      await prisma.insight.create({
        data: {
          walletAddress,
          poolId: pool.poolId,
          type: "POOL_OPPORTUNITY",
          severity: "INFO",
          title: `High-APR pool available: ${pool.name}`,
          body: `${pool.name} is showing ${pool.apr.toFixed(1)}% APR with $${(pool.tvlUsd / 1000).toFixed(0)}k TVL. Consider zap-in.`,
          data: {
            poolId: pool.poolId,
            apr: pool.apr,
            tvlUsd: pool.tvlUsd,
          },
        },
      });
    }
  }

  const criticals = await prisma.insight.findMany({
    where: { walletAddress, severity: "CRITICAL", acknowledged: false },
    orderBy: { createdAt: "desc" },
    take: 3,
  });

  if (criticals.length > 0) {
    await notifyWallet(
      walletAddress,
      [
        "*New critical insights*",
        "",
        ...criticals.map((c) => `- *${c.title}*\n  ${c.body}`),
      ].join("\n"),
      { kind: "insight" }
    );
  }
}

export { getTopLpers };

export async function initSidetrack(): Promise<Sidetrack<AppQueues>> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");

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
      copyLpPoll: {
        maxAttempts: 3,
        run: (payload) => handleCopyLpPoll(payload),
      },
      generateInsights: {
        maxAttempts: 3,
        run: (payload) => handleGenerateInsights(payload),
      },
    },
  });

  return _sidetrack;
}
