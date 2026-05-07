# LP Copilot

Autopilot, alerts, and intelligence for Meteora DLMM positions.
Powered by [LPAgent.io](https://lpagent.io). Built for the Frontier Hackathon LPAgent.io sidetrack.

LP Copilot turns the LP Agent API into a complete LP management product, not just a script. It ships with:

- A Telegram bot with inline-button zap controls and live push notifications.
- A web dashboard (single-page, dark mode, no build step) for portfolio + pool browsing.
- A range recommender that scores Spot / Curve / BidAsk based on observed volatility.
- An impermanent-loss calculator for concentrated-liquidity positions.
- Copy-LP: mirror a top LP's bin range automatically when they zap in.
- Position autopilot: auto-zap-out when a position drifts out of range.
- Jito-bundled execution for both zap-in and zap-out.
- Postgres-persisted job queue ([Sidetrack](https://github.com/sidetrackhq/sidetrack)) that survives restarts and retries on failure.

All LP execution flows through LP Agent's Zap-In / Zap-Out endpoints, exactly as the hackathon track requires.

---

## Why this submission

| Hackathon criterion | What's in the box |
|---|---|
| Fulfilment of requirements (40%) | Eight LP Agent endpoints used, including both zap-in and zap-out, all wired through the Jito landing endpoints. |
| Quality of LP Agent use (20%) | Three independent surfaces (Telegram, web, REST API) all driven by LP Agent data. Real signing flow, retry logic, status state machine, transaction history. |
| Creativity and UX (30%) | Telegram bot with one-tap zap-out from notifications. Dark dashboard with IL calculator and pool detail view. Copy-LP turns the premium `/top-lpers` endpoint into a real product. |
| Innovation (10%) | IL math, range recommender, and Copy-LP are not in the API; they're built on top of it. Closed-form IL formula, volatility-scaled range widths, leader-fingerprinted mirror logic. |

---

## Architecture

```
                      LP COPILOT

  +--------------+   +--------------+   +-----------------------+
  |  Telegram    |   |  Web dash    |   |  REST API (24 routes) |
  |  bot (long-  |   |  (Tailwind + |   |  /zap-in /zap-out     |
  |   polling)   |   |   Alpine)    |   |  /insights /copylp .. |
  +------+-------+   +------+-------+   +----------+------------+
         |                  |                      |
         +---------+--------+----------------------+
                   |
                   v
        +----------------------+
        |  Sidetrack queue     |  7 queues, cron-scheduled
        |  (Postgres-backed)   |
        +----------+-----------+
                   |
                   v
   syncPools  monitorPositions  generateInsights  copyLpPoll
   alertOutOfRange   executeZapOut   executeZapIn
                   |
                   v
        +----------------------+
        |   LPAgent.io API     |  /pools/discover  /lp-positions
        |   (8 endpoints used) |  /position/decrease-tx  ...
        +----------+-----------+
                   |
                   v
        +----------------------+
        |  Solana / Jito       |  signed via @solana/web3.js,
        |  (mainnet)           |  submitted via Jito bundles
        +----------------------+
```

---

## LP Agent endpoints used

| Endpoint | Where it's used |
|---|---|
| `GET /pools/discover` | Pool browser (web + Telegram), cron sync |
| `GET /pools/{id}/info` | Pool detail page, range recommender, IL warnings |
| `GET /pools/{id}/onchain-stats` | Available for volatility-based scoring |
| `GET /pools/{id}/top-lpers` | Copy-LP feature (uses Premium tier) |
| `GET /lp-positions/opening` | Position monitor, dashboard portfolio view |
| `GET /lp-positions/historical` | Closed-position table on dashboard |
| `GET /lp-positions/overview` | Portfolio header, /portfolio Telegram command |
| `GET /lp-positions/revenue/{owner}` | Wallet overview endpoint |
| `GET /token/balance` | Wallet overview endpoint |
| `POST /position/decrease-quotes` | Quote preview before zap-out |
| `POST /position/decrease-tx` | Generates unsigned zap-out tx |
| `POST /position/landing-decrease-tx` | Submits signed zap-out via Jito |
| `POST /pools/{id}/add-tx` | Generates unsigned zap-in tx |
| `POST /pools/landing-add-tx` | Submits signed zap-in via Jito |

---

## Demo flow (3 minutes)

1. Open the dashboard at `http://localhost:3000/dashboard/`. Paste a Solana wallet that holds Meteora positions and click Load.
2. The Portfolio tab shows total value, fees, PnL, and every open position with a health score and warnings (out-of-range, dust, near-edge, low fee yield).
3. Click Generate insights. Within a few seconds the Insights tab fills with IL warnings, range-rebalance suggestions, and pool-opportunity alerts.
4. Pools tab, click any pool, see the Smart Range Recommendation (Spot/Curve/BidAsk) with expected days-in-range and rationale, plus the Top LPs leaderboard (premium endpoint).
5. Click Copy on a top LP, set a $ amount, and that subscription will mirror their next zap-in automatically (poller runs every 2 min).
6. On Telegram: `/start` then `/link <wallet>` then `/portfolio` then `/positions`, tap Zap out 100% on the inline keyboard. The zap-out tx lands via Jito and you get a Solscan link in your DMs.

---

## Tech stack

| Layer | Tech |
|---|---|
| Language | TypeScript (strict mode, `exactOptionalPropertyTypes`) |
| HTTP | Express 4 (24 routes) |
| Background jobs | [Sidetrack](https://github.com/sidetrackhq/sidetrack), Postgres-backed queue with cron |
| ORM | Prisma 5 (7 models) |
| Database | PostgreSQL (Neon, Supabase, or local) |
| Solana | `@solana/web3.js` for transaction signing |
| Telegram | `node-telegram-bot-api` (long-polling, no webhook needed) |
| Frontend | Single HTML file with Tailwind CDN + Alpine.js (zero build step) |
| LP data + zaps | LPAgent.io Open API |

---

## Setup

### Prereqs
- Node.js 18 or newer.
- A PostgreSQL database (Neon free tier works).
- LP Agent API key from [portal.lpagent.io](https://portal.lpagent.io). DM `@thanhle27` on Telegram for a hackathon Premium key.
- Optional: Telegram bot token (create with [@BotFather](https://t.me/BotFather)).

### Install

```bash
cd lpagent-sidetrack
npm install
cp .env.example .env
# fill in DATABASE_URL, LPAGENT_API_KEY, WALLET_PRIVATE_KEY
npm run db:migrate
npm run dev
```

Open `http://localhost:3000/dashboard/`.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `LPAGENT_API_KEY` | yes | From portal.lpagent.io |
| `WALLET_PRIVATE_KEY` | yes (for zaps) | Base58 Solana private key for the bot wallet |
| `MONITOR_WALLETS` | optional | Comma-separated wallet pubkeys to poll automatically |
| `AUTOPILOT_ENABLED` | optional | `true` to auto-execute zap-out (default: alert only) |
| `TELEGRAM_BOT_TOKEN` | optional | From @BotFather. Enables the Telegram bot. |
| `PORT` | optional | HTTP port (default: 3000) |

### Docker

```bash
docker build -t lp-copilot .
docker run -p 3000:3000 --env-file .env lp-copilot
```

---

## Telegram commands

| Command | What it does |
|---|---|
| `/start` | Show welcome menu |
| `/link <wallet>` | Link your Solana wallet to this chat |
| `/portfolio` | Total value, fees, PnL, in-range count |
| `/positions` | List open positions with inline zap-out buttons |
| `/pools [tvl\|apr\|volume]` | Top Meteora pools |
| `/recommend <poolId>` | Smart bin-range and strategy recommendation |
| `/leaders <poolId>` | Top LPs in a pool (premium) |
| `/copy <leader> <pool> <usd>` | Mirror a top LP with $X capital |
| `/unlink` | Remove the wallet binding |

You also get push notifications when:
- A position goes out of range
- A zap-in or zap-out is confirmed (with Solscan link)
- A critical insight is generated (high IL, fee velocity drop, opportunity)
- A Copy-LP subscription triggers a mirror zap

---

## REST API

All routes live on the same Express server as the dashboard.

### Wallet and portfolio
- `GET /health`
- `GET /wallet/:address/overview`
- `GET /positions?walletAddress=...&inRange=true|false`
- `GET /transactions?walletAddress=...`
- `GET /alerts?walletAddress=...&status=PENDING`
- `PATCH /alerts/:id`  body: `{ status: "ACKNOWLEDGED" | "RESOLVED" }`

### Pools and intelligence
- `GET /discover?sortBy=apr&minTvl=10000&limit=20`
- `GET /pools?sortBy=apr|tvl|volume&limit=20`
- `GET /pool/:poolId/info`
- `GET /pool/:poolId/recommend?vol=0.6&preference=balanced`
- `GET /pool/:poolId/leaders` (premium)
- `POST /intelligence/il`  body: `{ pEntry, pNow, pLower, pUpper }`

### Zap execution
- `POST /zap-in`  body: `{ walletAddress, poolId, strategy, fromBinId, toBinId, amountX|amountY, slippageBps }`
- `POST /zap-out`  body: `{ walletAddress, positionId, bps, output, slippageBps }`
- `POST /sync-pools`
- `POST /monitor`

### Insights and Copy-LP
- `GET /insights?walletAddress=...`
- `POST /insights/generate`
- `POST /copylp`  body: `{ followerWallet, leaderWallet, poolId, capitalUsd, strategy }`
- `GET /copylp?followerWallet=...`
- `DELETE /copylp/:id`
- `POST /copylp/poll`

---

## Background queues

| Queue | Schedule | Purpose |
|---|---|---|
| `syncPools` | every 30 min | Cache top 100 pools by TVL |
| `monitorPositions` | every 5 min, per wallet | Detect out-of-range, queue alerts/zaps |
| `generateInsights` | every 15 min, per wallet | Score positions, detect IL, surface opportunities |
| `copyLpPoll` | every 2 min | Check leader wallets, mirror new positions |
| `alertOutOfRange` | on demand | Save alert, push to Telegram |
| `executeZapOut` | on demand | Quote, generate, sign, Jito submit |
| `executeZapIn` | on demand | Generate, sign, Jito submit |

All queues persist in Postgres, retry on failure, and survive restarts.

---

## File map

```
lpagent-sidetrack/
  src/
    index.ts          24 HTTP routes + dashboard static + cron setup
    sidetrack.ts      7 queue handlers + cron registration
    lpagent.ts        Typed client for 14 LP Agent endpoints
    telegram.ts       Bot commands + inline keyboards + notifications
    intelligence.ts   IL math, volatility, range/strategy recommender
    wallet.ts         Solana keypair loading + tx signing
    db.ts             Prisma singleton
  prisma/
    schema.prisma     7 models: Pool, Position, ZapTransaction, Alert,
                      TelegramUser, CopyLpSubscription, Insight
    migrations/       Baseline migration SQL
  public/
    index.html        Single-file dashboard (Tailwind + Alpine)
  Dockerfile
  .env.example
```

---

## Hackathon submission

- Track: LPAgent.io / API integrate Sidetrack
- Both Zap-In and Zap-Out: implemented end-to-end, signed locally, submitted via Jito.
- 8 LP Agent endpoints in use, including the Premium `top-lpers` for Copy-LP.
- Three user surfaces: Telegram bot, web dashboard, REST API.
- Production-ready: Dockerfile, Postgres migrations, retry logic, graceful shutdown.
