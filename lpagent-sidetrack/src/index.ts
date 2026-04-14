import "dotenv/config";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { getPrisma, disconnectPrisma } from "./db.js";
import { initSidetrack, getSidetrack, type ExecuteZapInPayload } from "./sidetrack.js";
import type { ZapStrategy, ZapOutput } from "./lpagent.js";

const app = express();
app.use(express.json());

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * POST /sync-pools
 * Body: { sortBy?: "tvl"|"volume"|"apr", minTvlUsd?: number, limit?: number }
 * Enqueues a syncPools job to discover and cache top Meteora pools.
 */
app.post("/sync-pools", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as {
      sortBy?: unknown;
      minTvlUsd?: unknown;
      limit?: unknown;
    };

    const sortBy =
      body.sortBy === "tvl" || body.sortBy === "volume" || body.sortBy === "apr"
        ? body.sortBy
        : "tvl";

    const minTvlUsd =
      typeof body.minTvlUsd === "number" ? body.minTvlUsd : 10_000;

    const limit =
      typeof body.limit === "number" ? Math.min(body.limit, 200) : 50;

    const job = await getSidetrack().insertJob("syncPools", {
      sortBy,
      minTvlUsd,
      limit,
    });

    res.status(202).json({ jobId: job.id, queue: "syncPools", sortBy, minTvlUsd, limit });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /monitor
 * Body: { walletAddress: string, autoZapOut?: boolean }
 * Immediately enqueues a monitorPositions job for the given wallet.
 */
app.post("/monitor", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as { walletAddress?: unknown; autoZapOut?: unknown };
    const walletAddress = body.walletAddress;

    if (typeof walletAddress !== "string" || walletAddress.trim() === "") {
      res.status(400).json({ error: "'walletAddress' must be a non-empty string" });
      return;
    }

    const autoZapOut = body.autoZapOut === true;
    const job = await getSidetrack().insertJob("monitorPositions", {
      walletAddress: walletAddress.trim(),
      autoZapOut,
    });

    res.status(202).json({ jobId: job.id, queue: "monitorPositions", walletAddress, autoZapOut });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /zap-out
 * Body: { walletAddress, positionId, bps?, output?, slippageBps? }
 * Manually trigger a zap-out for a specific position.
 */
app.post("/zap-out", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as {
      walletAddress?: unknown;
      positionId?: unknown;
      bps?: unknown;
      output?: unknown;
      slippageBps?: unknown;
    };

    if (typeof body.walletAddress !== "string" || body.walletAddress.trim() === "") {
      res.status(400).json({ error: "'walletAddress' must be a non-empty string" });
      return;
    }
    if (typeof body.positionId !== "string" || body.positionId.trim() === "") {
      res.status(400).json({ error: "'positionId' must be a non-empty string" });
      return;
    }

    const bps = typeof body.bps === "number" ? Math.min(Math.max(body.bps, 1), 10000) : 10000;
    const validOutputs: ZapOutput[] = ["allToken0", "allToken1", "both", "allBaseToken"];
    const output: ZapOutput =
      typeof body.output === "string" && validOutputs.includes(body.output as ZapOutput)
        ? (body.output as ZapOutput)
        : "both";
    const slippageBps =
      typeof body.slippageBps === "number" ? Math.min(body.slippageBps, 1000) : 50;

    const prisma = getPrisma();
    const zapTx = await prisma.zapTransaction.create({
      data: {
        type: "ZAP_OUT",
        status: "PENDING",
        walletAddress: body.walletAddress.trim(),
        positionId: body.positionId.trim(),
        bps,
        outputMode: output,
        slippageBps,
      },
    });

    const job = await getSidetrack().insertJob("executeZapOut", {
      walletAddress: body.walletAddress.trim(),
      positionId: body.positionId.trim(),
      bps,
      output,
      slippageBps,
      zapTransactionId: zapTx.id,
    });

    res.status(202).json({ jobId: job.id, zapTransactionId: zapTx.id, queue: "executeZapOut" });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /zap-in
 * Body: { walletAddress, poolId, strategy, fromBinId, toBinId, amountX?, amountY?, slippageBps? }
 * Manually trigger a zap-in for a pool.
 */
app.post("/zap-in", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as {
      walletAddress?: unknown;
      poolId?: unknown;
      strategy?: unknown;
      fromBinId?: unknown;
      toBinId?: unknown;
      amountX?: unknown;
      amountY?: unknown;
      slippageBps?: unknown;
    };

    if (typeof body.walletAddress !== "string" || body.walletAddress.trim() === "") {
      res.status(400).json({ error: "'walletAddress' must be a non-empty string" });
      return;
    }
    if (typeof body.poolId !== "string" || body.poolId.trim() === "") {
      res.status(400).json({ error: "'poolId' must be a non-empty string" });
      return;
    }

    const validStrategies: ZapStrategy[] = ["Spot", "Curve", "BidAsk"];
    if (
      typeof body.strategy !== "string" ||
      !validStrategies.includes(body.strategy as ZapStrategy)
    ) {
      res.status(400).json({ error: "'strategy' must be one of: Spot, Curve, BidAsk" });
      return;
    }
    if (typeof body.fromBinId !== "number" || typeof body.toBinId !== "number") {
      res.status(400).json({ error: "'fromBinId' and 'toBinId' must be numbers" });
      return;
    }
    if (!body.amountX && !body.amountY) {
      res.status(400).json({ error: "At least one of 'amountX' or 'amountY' must be provided" });
      return;
    }

    const strategy = body.strategy as ZapStrategy;
    const slippageBps =
      typeof body.slippageBps === "number" ? Math.min(body.slippageBps, 1000) : 50;

    const prisma = getPrisma();
    const zapTx = await prisma.zapTransaction.create({
      data: {
        type: "ZAP_IN",
        status: "PENDING",
        walletAddress: body.walletAddress.trim(),
        poolId: body.poolId.trim(),
        strategy,
        fromBinId: body.fromBinId,
        toBinId: body.toBinId,
        ...(typeof body.amountX === "string" ? { amountX: body.amountX } : {}),
        ...(typeof body.amountY === "string" ? { amountY: body.amountY } : {}),
        slippageBps,
      },
    });

    const jobPayload: ExecuteZapInPayload = {
      walletAddress: body.walletAddress.trim(),
      poolId: body.poolId.trim(),
      strategy,
      fromBinId: body.fromBinId,
      toBinId: body.toBinId,
      slippageBps,
      zapTransactionId: zapTx.id,
    };
    if (typeof body.amountX === "string") jobPayload.amountX = body.amountX;
    if (typeof body.amountY === "string") jobPayload.amountY = body.amountY;

    const job = await getSidetrack().insertJob("executeZapIn", jobPayload);

    res.status(202).json({ jobId: job.id, zapTransactionId: zapTx.id, queue: "executeZapIn" });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /alerts
 * Query: walletAddress?, status?, limit?, cursor?
 */
app.get("/alerts", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { walletAddress, status, limit: limitRaw, cursor } =
      req.query as Record<string, string | undefined>;

    const limit = Math.min(parseInt(limitRaw ?? "50", 10) || 50, 200);
    const prisma = getPrisma();

    const alerts = await prisma.alert.findMany({
      where: {
        ...(walletAddress ? { walletAddress } : {}),
        ...(status ? { status: status as "PENDING" | "ACKNOWLEDGED" | "RESOLVED" } : {}),
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        position: {
          select: {
            positionId: true,
            poolId: true,
            inRange: true,
            valueUsd: true,
            pool: { select: { name: true, tokenXSymbol: true, tokenYSymbol: true } },
          },
        },
      },
    });

    const nextCursor =
      alerts.length === limit ? (alerts[alerts.length - 1]?.id ?? null) : null;

    res.json({ alerts, nextCursor, count: alerts.length });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /alerts/:id
 * Body: { status: "ACKNOWLEDGED" | "RESOLVED" }
 */
app.patch("/alerts/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params as { id: string };
    const newStatus = (req.body as { status?: unknown }).status;

    if (newStatus !== "ACKNOWLEDGED" && newStatus !== "RESOLVED") {
      res.status(400).json({ error: "status must be 'ACKNOWLEDGED' or 'RESOLVED'" });
      return;
    }

    const prisma = getPrisma();
    const alert = await prisma.alert.update({
      where: { id },
      data: {
        status: newStatus,
        ...(newStatus === "RESOLVED" ? { resolvedAt: new Date() } : {}),
      },
    });

    res.json(alert);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /transactions
 * Query: walletAddress?, type?, status?, limit?, cursor?
 * List zap transactions.
 */
app.get("/transactions", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { walletAddress, type, status, limit: limitRaw, cursor } =
      req.query as Record<string, string | undefined>;

    const limit = Math.min(parseInt(limitRaw ?? "50", 10) || 50, 200);
    const prisma = getPrisma();

    const transactions = await prisma.zapTransaction.findMany({
      where: {
        ...(walletAddress ? { walletAddress } : {}),
        ...(type ? { type: type as "ZAP_IN" | "ZAP_OUT" } : {}),
        ...(status
          ? { status: status as "PENDING" | "SIGNED" | "SUBMITTED" | "CONFIRMED" | "FAILED" }
          : {}),
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        pool: { select: { name: true, tokenXSymbol: true, tokenYSymbol: true } },
        position: { select: { positionId: true, inRange: true, valueUsd: true } },
      },
    });

    const nextCursor =
      transactions.length === limit
        ? (transactions[transactions.length - 1]?.id ?? null)
        : null;

    res.json({ transactions, nextCursor, count: transactions.length });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /pools
 * Returns cached pool data from the DB.
 * Query: sortBy? (tvl|apr|volume), limit? (default 20)
 */
app.get("/pools", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sortBy, limit: limitRaw } = req.query as Record<string, string | undefined>;
    const limit = Math.min(parseInt(limitRaw ?? "20", 10) || 20, 100);
    const prisma = getPrisma();

    const orderBy =
      sortBy === "apr"
        ? { apr: "desc" as const }
        : sortBy === "volume"
          ? { volume24hUsd: "desc" as const }
          : { tvlUsd: "desc" as const };

    const pools = await prisma.pool.findMany({
      orderBy,
      take: limit,
    });

    res.json({ pools, count: pools.length });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /positions
 * Returns cached position data for a wallet.
 * Query: walletAddress (required), inRange? (true|false)
 */
app.get("/positions", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { walletAddress, inRange } = req.query as Record<string, string | undefined>;

    if (!walletAddress) {
      res.status(400).json({ error: "'walletAddress' query param is required" });
      return;
    }

    const prisma = getPrisma();
    const positions = await prisma.position.findMany({
      where: {
        walletAddress,
        ...(inRange !== undefined ? { inRange: inRange === "true" } : {}),
      },
      orderBy: { valueUsd: "desc" },
      include: {
        pool: { select: { name: true, tokenXSymbol: true, tokenYSymbol: true, apr: true } },
      },
    });

    res.json({ positions, count: positions.length });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : "Internal server error";
  if (process.env["NODE_ENV"] !== "production") {
    console.error("[error]", err instanceof Error ? err.stack : err);
  } else {
    console.error("[error]", message);
  }
  res.status(500).json({ error: message });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const sidetrack = await initSidetrack();

  // Sync top Meteora pools every 30 minutes
  await sidetrack.scheduleCron("syncPools", "*/30 * * * *", {
    sortBy: "tvl",
    minTvlUsd: 10_000,
    limit: 100,
  });
  console.log("[cron] syncPools scheduled every 30 min");

  // Monitor configured wallets every 5 minutes
  const wallets = process.env["MONITOR_WALLETS"]?.split(",").filter(Boolean) ?? [];
  const autopilot = process.env["AUTOPILOT_ENABLED"] === "true";

  for (const wallet of wallets) {
    await sidetrack.scheduleCron("monitorPositions", "*/5 * * * *", {
      walletAddress: wallet.trim(),
      autoZapOut: autopilot,
    });
    console.log(
      `[cron] monitorPositions every 5 min for ${wallet.trim()} (autopilot: ${autopilot})`
    );
  }

  await sidetrack.start();
  console.log("[sidetrack] Worker started");

  const server = app.listen(PORT, () => {
    console.log(`[http] Server listening on http://localhost:${PORT}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[shutdown] ${signal} received, shutting down...`);
    server.close(async () => {
      sidetrack.stop();
      await disconnectPrisma();
      console.log("[shutdown] Done.");
      process.exit(0);
    });
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("[fatal]", err instanceof Error ? err.stack : err);
  process.exit(1);
});
