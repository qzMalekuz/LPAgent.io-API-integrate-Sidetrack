import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import { getPrisma } from "./db.js";
import {
  discoverPools,
  getOpenPositions,
  getPositionOverview,
  getPoolInfo,
  getTopLpers,
  type LpPosition,
} from "./lpagent.js";
import { recommendRange, scorePositionHealth } from "./intelligence.js";
import { getSidetrack } from "./sidetrack.js";

let bot: TelegramBot | null = null;
let enabled = false;

export function isTelegramEnabled(): boolean {
  return enabled;
}

export function initTelegram(): void {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    console.log("[telegram] TELEGRAM_BOT_TOKEN not set, bot disabled");
    return;
  }

  bot = new TelegramBot(token, { polling: true });
  enabled = true;
  console.log("[telegram] bot started");

  registerCommands(bot);
}

export async function shutdownTelegram(): Promise<void> {
  if (bot) {
    await bot.stopPolling();
    bot = null;
    enabled = false;
  }
}

export async function notifyWallet(
  walletAddress: string,
  message: string,
  opts?: { kind?: "alert" | "zap" | "insight" }
): Promise<void> {
  if (!bot) return;
  const prisma = getPrisma();
  const users = await prisma.telegramUser.findMany({
    where: { walletAddress },
  });

  for (const user of users) {
    const kind = opts?.kind ?? "alert";
    if (kind === "alert" && !user.notifyAlerts) continue;
    if (kind === "zap" && !user.notifyZaps) continue;
    if (kind === "insight" && !user.notifyInsights) continue;

    try {
      await bot.sendMessage(user.chatId, message, { parse_mode: "Markdown" });
    } catch (err) {
      console.error(
        `[telegram] failed to notify ${user.chatId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

function registerCommands(b: TelegramBot): void {
  b.onText(/^\/start/, async (msg) => {
    await b.sendMessage(
      msg.chat.id,
      [
        "*Welcome to LP Copilot*",
        "",
        "I monitor your Meteora DLMM positions and zap them in/out via the LPAgent.io API.",
        "",
        "*Commands*",
        "`/link <wallet>` - link your Solana wallet",
        "`/portfolio` - your overall PnL + fees",
        "`/positions` - list open positions (with quick zap-out)",
        "`/pools` - top Meteora pools by APR",
        "`/recommend <poolId>` - get a smart bin range for a pool",
        "`/copy <leader> <poolId> <usd>` - copy a top LP",
        "`/help` - show this menu",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  });

  b.onText(/^\/help/, async (msg) => {
    await b.sendMessage(
      msg.chat.id,
      [
        "*LP Copilot commands*",
        "`/link <wallet>` - link your Solana wallet",
        "`/portfolio` - overall PnL + fees",
        "`/positions` - list open positions",
        "`/pools` - top pools by APR",
        "`/recommend <poolId>` - bin range for a pool",
        "`/copy <leader> <poolId> <usd>` - copy a top LP",
        "`/unlink` - disconnect your wallet",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  });

  b.onText(/^\/link\s+(\S+)/, async (msg, match) => {
    const wallet = match?.[1];
    if (!wallet || wallet.length < 32 || wallet.length > 44) {
      await b.sendMessage(msg.chat.id, "That doesn't look like a Solana pubkey.");
      return;
    }

    const prisma = getPrisma();
    await prisma.telegramUser.upsert({
      where: { chatId: String(msg.chat.id) },
      create: {
        chatId: String(msg.chat.id),
        username: msg.from?.username ?? null,
        walletAddress: wallet,
      },
      update: { walletAddress: wallet, username: msg.from?.username ?? null },
    });

    await b.sendMessage(
      msg.chat.id,
      `Linked wallet \`${wallet}\`.\nYou'll now get alerts when positions go out of range.`,
      { parse_mode: "Markdown" }
    );
  });

  b.onText(/^\/unlink/, async (msg) => {
    const prisma = getPrisma();
    await prisma.telegramUser
      .delete({ where: { chatId: String(msg.chat.id) } })
      .catch(() => null);
    await b.sendMessage(msg.chat.id, "Unlinked.");
  });

  b.onText(/^\/portfolio/, async (msg) => {
    const wallet = await getLinkedWallet(String(msg.chat.id));
    if (!wallet) {
      await b.sendMessage(msg.chat.id, "Link a wallet first: `/link <pubkey>`", {
        parse_mode: "Markdown",
      });
      return;
    }

    try {
      const overview = await getPositionOverview(wallet);
      const lines = [
        `*Portfolio for* \`${wallet.slice(0, 6)}...${wallet.slice(-4)}\``,
        "",
        `Total value:    *$${overview.totalValueUsd.toFixed(2)}*`,
        `Fees earned:    *$${overview.totalFeesEarnedUsd.toFixed(2)}*`,
        `Total PnL:      *${overview.totalPnlUsd >= 0 ? "+" : ""}$${overview.totalPnlUsd.toFixed(2)}*`,
        `Open positions: *${overview.openPositionCount}*  (${overview.inRangeCount} in range, ${overview.outOfRangeCount} out)`,
      ];
      await b.sendMessage(msg.chat.id, lines.join("\n"), {
        parse_mode: "Markdown",
      });
    } catch (err) {
      await b.sendMessage(
        msg.chat.id,
        `Failed to load portfolio: ${err instanceof Error ? err.message : err}`
      );
    }
  });

  b.onText(/^\/positions/, async (msg) => {
    const wallet = await getLinkedWallet(String(msg.chat.id));
    if (!wallet) {
      await b.sendMessage(msg.chat.id, "Link a wallet first: `/link <pubkey>`", {
        parse_mode: "Markdown",
      });
      return;
    }

    try {
      const result = await getOpenPositions(wallet);
      if (result.positions.length === 0) {
        await b.sendMessage(msg.chat.id, "No open positions.");
        return;
      }

      for (const pos of result.positions.slice(0, 10)) {
        const health = scorePositionHealth(pos);
        const status = pos.inRange ? "in range" : "OUT OF RANGE";
        const text = [
          `*${pos.poolName}*  (${pos.tokenXSymbol}/${pos.tokenYSymbol})`,
          `${status}  -  health *${health.score}/100*`,
          `Value: *$${pos.valueUsd.toFixed(2)}*  -  Fees: *$${pos.feesEarnedUsd.toFixed(2)}*`,
          `Bins: ${pos.lowerBinId} -> ${pos.upperBinId}  (active: ${pos.activeBinId})`,
          health.warnings.length > 0 ? `\n${health.warnings.map((w) => `- ${w}`).join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        await b.sendMessage(msg.chat.id, text, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Zap out 100%",
                  callback_data: `zapout:${pos.positionId}:10000`,
                },
                {
                  text: "Zap out 50%",
                  callback_data: `zapout:${pos.positionId}:5000`,
                },
              ],
              [
                {
                  text: "Pool details",
                  callback_data: `pool:${pos.poolId}`,
                },
              ],
            ],
          },
        });
      }
    } catch (err) {
      await b.sendMessage(
        msg.chat.id,
        `Failed to load positions: ${err instanceof Error ? err.message : err}`
      );
    }
  });

  b.onText(/^\/pools(?:\s+(tvl|apr|volume))?/, async (msg, match) => {
    const sortBy = (match?.[1] as "tvl" | "apr" | "volume") ?? "apr";
    try {
      const pools = await discoverPools({ sortBy, limit: 8, minTvl: 50_000 });
      if (pools.pools.length === 0) {
        await b.sendMessage(msg.chat.id, "No pools found.");
        return;
      }
      const lines = [`*Top pools by ${sortBy.toUpperCase()}*`, ""];
      for (const p of pools.pools) {
        lines.push(
          `*${p.tokenXSymbol}/${p.tokenYSymbol}*  -  APR *${p.apr.toFixed(1)}%*  -  TVL $${(p.tvlUsd / 1000).toFixed(1)}k  -  Vol $${(p.volume24hUsd / 1000).toFixed(1)}k`
        );
        lines.push(`  \`${p.poolId}\``);
      }
      await b.sendMessage(msg.chat.id, lines.join("\n"), {
        parse_mode: "Markdown",
      });
    } catch (err) {
      await b.sendMessage(
        msg.chat.id,
        `Failed to fetch pools: ${err instanceof Error ? err.message : err}`
      );
    }
  });

  b.onText(/^\/recommend\s+(\S+)/, async (msg, match) => {
    const poolId = match?.[1];
    if (!poolId) {
      await b.sendMessage(msg.chat.id, "Usage: `/recommend <poolId>`", {
        parse_mode: "Markdown",
      });
      return;
    }
    try {
      const pool = await getPoolInfo(poolId);
      const rec = recommendRange({ pool, annualisedVol: 0.6 });
      const text = [
        `*${pool.tokenXSymbol}/${pool.tokenYSymbol}*  recommendation`,
        "",
        `Strategy: *${rec.strategy}*`,
        `Bins: \`${rec.fromBinId}\` -> \`${rec.toBinId}\``,
        `Price range: $${rec.lowerPrice.toFixed(6)} - $${rec.upperPrice.toFixed(6)}`,
        `Expected days in range: *~${rec.expectedTimeInRangeDays.toFixed(1)}d*`,
        "",
        `_${rec.rationale}_`,
      ].join("\n");
      await b.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
    } catch (err) {
      await b.sendMessage(
        msg.chat.id,
        `Failed: ${err instanceof Error ? err.message : err}`
      );
    }
  });

  b.onText(/^\/copy\s+(\S+)\s+(\S+)\s+(\d+(?:\.\d+)?)/, async (msg, match) => {
    const wallet = await getLinkedWallet(String(msg.chat.id));
    if (!wallet) {
      await b.sendMessage(msg.chat.id, "Link a wallet first: `/link <pubkey>`", {
        parse_mode: "Markdown",
      });
      return;
    }
    const leader = match?.[1];
    const poolId = match?.[2];
    const usd = parseFloat(match?.[3] ?? "0");
    if (!leader || !poolId || !(usd > 0)) {
      await b.sendMessage(msg.chat.id, "Usage: `/copy <leaderWallet> <poolId> <usd>`", {
        parse_mode: "Markdown",
      });
      return;
    }
    const prisma = getPrisma();
    await prisma.copyLpSubscription.upsert({
      where: {
        followerWallet_leaderWallet_poolId: {
          followerWallet: wallet,
          leaderWallet: leader,
          poolId,
        },
      },
      create: {
        followerWallet: wallet,
        leaderWallet: leader,
        poolId,
        capitalUsd: usd,
      },
      update: { capitalUsd: usd, active: true },
    });
    await b.sendMessage(
      msg.chat.id,
      `Copying *${leader.slice(0, 6)}...* in pool \`${poolId.slice(0, 6)}...\` with *$${usd}*.\nI'll mirror their next zap-in automatically.`,
      { parse_mode: "Markdown" }
    );
  });

  b.onText(/^\/leaders\s+(\S+)/, async (msg, match) => {
    const poolId = match?.[1];
    if (!poolId) return;
    try {
      const top = await getTopLpers(poolId);
      const lines = [`*Top LPs in pool* \`${poolId.slice(0, 8)}...\``, ""];
      for (const l of top.lpers.slice(0, 10)) {
        lines.push(
          `\`${l.walletAddress.slice(0, 6)}...${l.walletAddress.slice(-4)}\`  -  $${l.totalValueUsd.toFixed(0)} value, $${l.feesEarnedUsd.toFixed(2)} fees`
        );
      }
      await b.sendMessage(msg.chat.id, lines.join("\n"), {
        parse_mode: "Markdown",
      });
    } catch (err) {
      await b.sendMessage(
        msg.chat.id,
        `/leaders requires the LP Agent *Premium* tier. ${err instanceof Error ? err.message : ""}`,
        { parse_mode: "Markdown" }
      );
    }
  });

  b.on("callback_query", async (cb) => {
    if (!cb.data || !cb.message) return;
    const chatId = cb.message.chat.id;
    const wallet = await getLinkedWallet(String(chatId));
    if (!wallet) {
      await b.answerCallbackQuery(cb.id, { text: "Link a wallet first." });
      return;
    }

    const [action, ...rest] = cb.data.split(":");

    if (action === "zapout") {
      const positionId = rest[0];
      const bps = parseInt(rest[1] ?? "10000", 10);
      if (!positionId) return;

      const prisma = getPrisma();
      const zapTx = await prisma.zapTransaction.create({
        data: {
          type: "ZAP_OUT",
          status: "PENDING",
          walletAddress: wallet,
          positionId,
          bps,
          outputMode: "both",
          slippageBps: 50,
          source: "telegram",
        },
      });
      await getSidetrack().insertJob("executeZapOut", {
        walletAddress: wallet,
        positionId,
        bps,
        output: "both",
        slippageBps: 50,
        zapTransactionId: zapTx.id,
      });

      await b.answerCallbackQuery(cb.id, { text: "Zap-out queued" });
      await b.sendMessage(
        chatId,
        `Zap-out queued for \`${positionId.slice(0, 8)}...\` (${bps / 100}%). I'll DM you when it lands.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (action === "pool") {
      const poolId = rest[0];
      if (!poolId) return;
      try {
        const pool = await getPoolInfo(poolId);
        const rec = recommendRange({ pool, annualisedVol: 0.6 });
        await b.answerCallbackQuery(cb.id);
        await b.sendMessage(
          chatId,
          [
            `*${pool.tokenXSymbol}/${pool.tokenYSymbol}*`,
            `TVL $${(pool.tvlUsd / 1000).toFixed(1)}k  -  APR ${pool.apr.toFixed(1)}%  -  Vol $${(pool.volume24hUsd / 1000).toFixed(1)}k`,
            `Active bin: ${pool.activeBinId}  -  Price ${pool.currentPrice.toFixed(6)}`,
            "",
            `*Recommendation:* ${rec.strategy} across ${rec.fromBinId}->${rec.toBinId} (~${rec.expectedTimeInRangeDays.toFixed(1)}d in range)`,
          ].join("\n"),
          { parse_mode: "Markdown" }
        );
      } catch (err) {
        await b.answerCallbackQuery(cb.id, {
          text: `Failed: ${err instanceof Error ? err.message : "error"}`,
        });
      }
      return;
    }
  });

  b.on("polling_error", (err) => {
    console.error("[telegram] polling_error:", err.message);
  });
}

async function getLinkedWallet(chatId: string): Promise<string | null> {
  const prisma = getPrisma();
  const user = await prisma.telegramUser.findUnique({ where: { chatId } });
  return user?.walletAddress ?? null;
}

export type { LpPosition };
