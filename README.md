# lpagent-sidetrack — LP Position Autopilot

A TypeScript backend that turns [LPAgent.io](https://lpagent.io) data into a fully automated Meteora LP management system. It monitors your DLMM positions, alerts you when they go out of range, and — when autopilot is enabled — automatically **zaps out** using the LP Agent API and can **zap back in** to a better-performing pool.

Built for the LPAgent.io hackathon track on SuperEarn.

---

## What it does

```
Every 30 min   syncPools        → Discover top Meteora pools via LP Agent, cache in Postgres
Every  5 min   monitorPositions → Check open positions per wallet, detect out-of-range
                    ↓ inRange=false
             [AUTOPILOT_ENABLED=false]   alertOutOfRange  → save Alert record
             [AUTOPILOT_ENABLED=true ]   executeZapOut    → sign + submit via Jito
                                              ↓ (manually after reviewing)
                                         executeZapIn     → re-enter a top-APR pool
```

---

## Stack

| Layer | Technology |
|---|---|
| Language | TypeScript (strict) |
| HTTP server | Express 4 |
| Background jobs | [Sidetrack](https://github.com/sidetrackhq/sidetrack) — Postgres-backed |
| ORM | Prisma 5 |
| Database | PostgreSQL |
| Transaction signing | `@solana/web3.js` |
| LP data + zaps | **LPAgent.io Open API** |

---

## Setup

### 1. Prerequisites

- Node.js ≥ 18
- PostgreSQL instance running

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Required vars:

| Variable | Description |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `LPAGENT_API_KEY` | From [portal.lpagent.io](https://portal.lpagent.io) (DM @thanhle27 for hackathon key) |
| `WALLET_PRIVATE_KEY` | Base58 Solana private key for the bot wallet (signing zap txs) |

Optional vars:

| Variable | Default | Description |
|---|---|---|
| `MONITOR_WALLETS` | — | Comma-separated wallet pubkeys to monitor |
| `AUTOPILOT_ENABLED` | `false` | Auto-execute zap-out on out-of-range positions |
| `PORT` | `3000` | HTTP server port |

### 4. Run database migrations

```bash
npm run db:migrate     # creates all tables + Sidetrack job tables
npm run db:generate    # regenerate Prisma client
```

### 5. Start the server

```bash
# Development (hot reload)
npm run dev

# Production
npm run build && npm start
```

---

## Background Queues

### `syncPools` `{ sortBy?, minTvlUsd?, limit? }`

Calls `GET /pools/discover` on LP Agent to find the top Meteora DLMM pools and upserts them into the `Pool` table. Runs on a 30-minute cron.

### `monitorPositions` `{ walletAddress, autoZapOut? }`

Calls `GET /lp-positions/opening` for the wallet, upserts every position into the `Position` table. For each position where `inRange = false`:

- **`AUTOPILOT_ENABLED=false`** → enqueues `alertOutOfRange` (creates an Alert record)
- **`AUTOPILOT_ENABLED=true`** → enqueues `executeZapOut` (auto-closes the position)

Runs on a 5-minute cron per configured wallet.

### `alertOutOfRange` `{ walletAddress, positionId, poolName }`

Creates a `PENDING` alert in the `Alert` table so you can review out-of-range positions and decide whether to manually zap out/in.

### `executeZapOut` `{ walletAddress, positionId, bps?, output?, slippageBps? }`

Full zap-out flow using LP Agent:
1. `POST /position/decrease-quotes` — fetch quote & estimated value
2. `POST /position/decrease-tx` — generate unsigned transaction
3. Sign with bot wallet (`@solana/web3.js`)
4. `POST /position/landing-decrease-tx` — submit via Jito bundle
5. Update `ZapTransaction` status through PENDING → SIGNED → SUBMITTED → CONFIRMED

### `executeZapIn` `{ walletAddress, poolId, strategy, fromBinId, toBinId, amountX?, amountY?, slippageBps? }`

Full zap-in flow:
1. `POST /pools/{poolId}/add-tx` — generate unsigned transaction
2. Sign with bot wallet
3. `POST /pools/landing-add-tx` — submit via Jito bundle
4. Update `ZapTransaction` status

---

## HTTP API

### `POST /sync-pools`
Immediately trigger a pool discovery sync.

```bash
curl -X POST http://localhost:3000/sync-pools \
  -H "Content-Type: application/json" \
  -d '{"sortBy": "apr", "minTvlUsd": 50000, "limit": 50}'
```

### `POST /monitor`
Immediately check positions for a wallet.

```bash
curl -X POST http://localhost:3000/monitor \
  -H "Content-Type: application/json" \
  -d '{"walletAddress": "YourSolanaWallet", "autoZapOut": false}'
```

### `POST /zap-out`
Manually zap out of a position.

```bash
curl -X POST http://localhost:3000/zap-out \
  -H "Content-Type: application/json" \
  -d '{
    "walletAddress": "YourSolanaWallet",
    "positionId": "PositionPubkey",
    "bps": 10000,
    "output": "both",
    "slippageBps": 50
  }'
```

`output` options: `allToken0` | `allToken1` | `both` | `allBaseToken`

### `POST /zap-in`
Manually zap into a pool.

```bash
curl -X POST http://localhost:3000/zap-in \
  -H "Content-Type: application/json" \
  -d '{
    "walletAddress": "YourSolanaWallet",
    "poolId": "MeteoraDLMMPoolAddress",
    "strategy": "Spot",
    "fromBinId": 8450,
    "toBinId": 8550,
    "amountX": "1000000",
    "slippageBps": 50
  }'
```

`strategy` options: `Spot` | `Curve` | `BidAsk`

### `GET /alerts`
List alerts.

```bash
# All pending alerts
curl "http://localhost:3000/alerts?status=PENDING"

# For a specific wallet
curl "http://localhost:3000/alerts?walletAddress=YourWallet&limit=20"
```

### `PATCH /alerts/:id`
Acknowledge or resolve an alert.

```bash
curl -X PATCH http://localhost:3000/alerts/<id> \
  -H "Content-Type: application/json" \
  -d '{"status": "ACKNOWLEDGED"}'
```

### `GET /transactions`
List all zap transactions with status.

```bash
curl "http://localhost:3000/transactions?walletAddress=YourWallet&status=CONFIRMED"
```

### `GET /pools`
Browse cached pool data.

```bash
curl "http://localhost:3000/pools?sortBy=apr&limit=10"
```

### `GET /positions`
Browse cached position data for a wallet.

```bash
curl "http://localhost:3000/positions?walletAddress=YourWallet&inRange=false"
```

---

## Database Schema

```
Pool             — Meteora DLMM pools discovered via /pools/discover
Position         — LP positions per wallet (updated every 5 min)
ZapTransaction   — Record of every zap-in / zap-out attempt with status + tx sig
Alert            — Out-of-range notifications (PENDING → ACKNOWLEDGED → RESOLVED)
```

---

## Project Structure

```
src/
  index.ts      — Express app, cron scheduling, graceful shutdown
  sidetrack.ts  — Sidetrack worker instance + all 5 queue handlers
  lpagent.ts    — Typed HTTP client for every LPAgent.io endpoint
  wallet.ts     — Solana tx signing via @solana/web3.js
  db.ts         — Singleton PrismaClient
prisma/
  schema.prisma — Pool, Position, ZapTransaction, Alert models
.env.example
```

---

## LP Agent Endpoints Used

| Endpoint | Used by |
|---|---|
| `GET /pools/discover` | `syncPools` queue |
| `GET /lp-positions/opening` | `monitorPositions` queue |
| `GET /lp-positions/historical` | `lpagent.getHistoricalPositions()` |
| `GET /lp-positions/overview` | `lpagent.getPositionOverview()` |
| `POST /position/decrease-quotes` | `executeZapOut` queue |
| `POST /position/decrease-tx` | `executeZapOut` queue ✅ **required** |
| `POST /position/landing-decrease-tx` | `executeZapOut` queue ✅ **required** |
| `POST /pools/{poolId}/add-tx` | `executeZapIn` queue ✅ **required** |
| `POST /pools/landing-add-tx` | `executeZapIn` queue ✅ **required** |
