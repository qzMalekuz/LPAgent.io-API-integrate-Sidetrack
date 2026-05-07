import "dotenv/config";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import path from "node:path";
import { getPrisma, disconnectPrisma } from "./db.js";
import {
  initSidetrack,
  getSidetrack,
  type ExecuteZapInPayload,
} from "./sidetrack.js";
import {
  type ZapStrategy,
  type ZapOutput,
  getPositionOverview,
  getOpenPositions,
  getHistoricalPositions,
  getPositionRevenue,
  getWalletBalance,
  getPoolInfo,
  getTopLpers,
  discoverPools,
} from "./lpagent.js";
import { recommendRange, scorePositionHealth } from "./intelligence.js";
import { initTelegram, shutdownTelegram, isTelegramEnabled } from "./telegram.js";

const app = express();
app.use(express.json());

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);

const PUBLIC_DIR = path.resolve(__dirname, "../public");
app.use("/dashboard", express.static(PUBLIC_DIR));
app.get("/", (_req: Request, res: Response) => {
  res.redirect("/dashboard/");
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    telegram: isTelegramEnabled(),
    autopilot: process.env["AUTOPILOT_ENABLED"] === "true",
    monitoredWallets:
      process.env["MONITOR_WALLETS"]?.split(",").filter(Boolean).length ?? 0,
  });
});

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
        source: "dashboard",
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
        source: "dashboard",
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
    const pools = await prisma.pool.findMany({ orderBy, take: limit });
    res.json({ pools, count: pools.length });
  } catch (err) {
    next(err);
  }
});

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

app.get("/wallet/:address/overview", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { address } = req.params as { address: string };
    const [overview, balance, open, history, revenue] = await Promise.all([
      getPositionOverview(address).catch(() => null),
      getWalletBalance(address).catch(() => null),
      getOpenPositions(address).catch(() => ({ owner: address, positions: [] })),
      getHistoricalPositions(address).catch(() => ({ owner: address, positions: [] })),
      getPositionRevenue(address).catch(() => ({})),
    ]);

    const positions = open.positions.map((p) => ({
      ...p,
      health: scorePositionHealth(p),
    }));

    res.json({
      address,
      overview,
      balance,
      positions,
      history: history.positions,
      revenue,
    });
  } catch (err) {
    next(err);
  }
});

app.get("/pool/:poolId/info", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { poolId } = req.params as { poolId: string };
    const pool = await getPoolInfo(poolId);
    res.json(pool);
  } catch (err) {
    next(err);
  }
});

app.get("/pool/:poolId/recommend", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { poolId } = req.params as { poolId: string };
    const { vol, preference } = req.query as Record<string, string | undefined>;
    const pool = await getPoolInfo(poolId);
    const annualisedVol = vol ? parseFloat(vol) : 0.6;
    const pref =
      preference === "tight" || preference === "wide" ? preference : "balanced";
    const rec = recommendRange({ pool, annualisedVol, preference: pref });
    res.json({ pool, recommendation: rec });
  } catch (err) {
    next(err);
  }
});

app.get("/pool/:poolId/leaders", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { poolId } = req.params as { poolId: string };
    const data = await getTopLpers(poolId);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

app.get("/discover", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sortBy, minTvl, limit } = req.query as Record<string, string | undefined>;
    const result = await discoverPools({
      sortBy:
        sortBy === "apr" || sortBy === "volume" || sortBy === "tvl" ? sortBy : "apr",
      ...(minTvl ? { minTvl: parseFloat(minTvl) } : {}),
      ...(limit ? { limit: Math.min(parseInt(limit, 10) || 20, 100) } : { limit: 20 }),
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.get("/insights", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { walletAddress, limit: limitRaw } =
      req.query as Record<string, string | undefined>;
    const limit = Math.min(parseInt(limitRaw ?? "30", 10) || 30, 200);
    const prisma = getPrisma();
    const insights = await prisma.insight.findMany({
      where: { ...(walletAddress ? { walletAddress } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    res.json({ insights, count: insights.length });
  } catch (err) {
    next(err);
  }
});

app.post("/insights/generate", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as { walletAddress?: unknown };
    if (typeof body.walletAddress !== "string" || body.walletAddress.trim() === "") {
      res.status(400).json({ error: "'walletAddress' required" });
      return;
    }
    const job = await getSidetrack().insertJob("generateInsights", {
      walletAddress: body.walletAddress.trim(),
    });
    res.status(202).json({ jobId: job.id });
  } catch (err) {
    next(err);
  }
});

app.post("/copylp", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as {
      followerWallet?: unknown;
      leaderWallet?: unknown;
      poolId?: unknown;
      capitalUsd?: unknown;
      strategy?: unknown;
    };
    if (
      typeof body.followerWallet !== "string" ||
      typeof body.leaderWallet !== "string" ||
      typeof body.poolId !== "string" ||
      typeof body.capitalUsd !== "number" ||
      body.capitalUsd <= 0
    ) {
      res.status(400).json({
        error:
          "required: followerWallet, leaderWallet, poolId (strings) and capitalUsd (positive number)",
      });
      return;
    }
    const strategy =
      body.strategy === "Spot" || body.strategy === "Curve" || body.strategy === "BidAsk"
        ? body.strategy
        : "Curve";
    const prisma = getPrisma();
    const sub = await prisma.copyLpSubscription.upsert({
      where: {
        followerWallet_leaderWallet_poolId: {
          followerWallet: body.followerWallet,
          leaderWallet: body.leaderWallet,
          poolId: body.poolId,
        },
      },
      create: {
        followerWallet: body.followerWallet,
        leaderWallet: body.leaderWallet,
        poolId: body.poolId,
        capitalUsd: body.capitalUsd,
        strategy,
      },
      update: { capitalUsd: body.capitalUsd, strategy, active: true },
    });
    res.status(201).json(sub);
  } catch (err) {
    next(err);
  }
});

app.get("/copylp", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { followerWallet } = req.query as Record<string, string | undefined>;
    const prisma = getPrisma();
    const subs = await prisma.copyLpSubscription.findMany({
      where: { ...(followerWallet ? { followerWallet } : {}) },
      orderBy: { createdAt: "desc" },
    });
    res.json({ subscriptions: subs, count: subs.length });
  } catch (err) {
    next(err);
  }
});

app.delete("/copylp/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params as { id: string };
    const prisma = getPrisma();
    await prisma.copyLpSubscription.update({
      where: { id },
      data: { active: false },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.post("/copylp/poll", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await getSidetrack().insertJob("copyLpPoll", {});
    res.status(202).json({ jobId: job.id });
  } catch (err) {
    next(err);
  }
});

app.post("/intelligence/il", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { impermanentLossPct } = await import("./intelligence.js");
    const body = req.body as {
      pEntry?: unknown;
      pNow?: unknown;
      pLower?: unknown;
      pUpper?: unknown;
    };
    if (
      typeof body.pEntry !== "number" ||
      typeof body.pNow !== "number" ||
      typeof body.pLower !== "number" ||
      typeof body.pUpper !== "number"
    ) {
      res.status(400).json({ error: "pEntry, pNow, pLower, pUpper must be numbers" });
      return;
    }
    const il = impermanentLossPct({
      pEntry: body.pEntry,
      pNow: body.pNow,
      pLower: body.pLower,
      pUpper: body.pUpper,
    });
    res.json({ ilPct: il, ilPercent: il * 100 });
  } catch (err) {
    next(err);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : "Internal server error";
  if (process.env["NODE_ENV"] !== "production") {
    console.error("[error]", err instanceof Error ? err.stack : err);
  } else {
    console.error("[error]", message);
  }
  res.status(500).json({ error: message });
});

async function main(): Promise<void> {
  const sidetrack = await initSidetrack();

  await sidetrack.scheduleCron("syncPools", "*/30 * * * *", {
    sortBy: "tvl",
    minTvlUsd: 10_000,
    limit: 100,
  });
  console.log("[cron] syncPools every 30 min");

  const wallets = process.env["MONITOR_WALLETS"]?.split(",").filter(Boolean) ?? [];
  const autopilot = process.env["AUTOPILOT_ENABLED"] === "true";

  for (const wallet of wallets) {
    await sidetrack.scheduleCron("monitorPositions", "*/5 * * * *", {
      walletAddress: wallet.trim(),
      autoZapOut: autopilot,
    });
    await sidetrack.scheduleCron("generateInsights", "*/15 * * * *", {
      walletAddress: wallet.trim(),
    });
    console.log(
      `[cron] monitorPositions(5m) + generateInsights(15m) for ${wallet.trim()} (autopilot=${autopilot})`
    );
  }

  await sidetrack.scheduleCron("copyLpPoll", "*/2 * * * *", {});
  console.log("[cron] copyLpPoll every 2 min");

  await sidetrack.start();
  console.log("[sidetrack] worker started");

  initTelegram();

  const server = app.listen(PORT, () => {
    console.log(`[http] listening on http://localhost:${PORT}`);
    console.log(`[http] dashboard: http://localhost:${PORT}/dashboard/`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[shutdown] ${signal} received`);
    server.close(async () => {
      sidetrack.stop();
      await shutdownTelegram();
      await disconnectPrisma();
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
