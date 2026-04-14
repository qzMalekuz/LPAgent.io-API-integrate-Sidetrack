import "dotenv/config";

// ---------------------------------------------------------------------------
// Base URL & auth
// ---------------------------------------------------------------------------

const BASE_URL = "https://api.lpagent.io/open-api/v1";

function getApiKey(): string {
  const key = process.env["LPAGENT_API_KEY"];
  if (!key) throw new Error("LPAGENT_API_KEY environment variable is not set");
  return key;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": getApiKey(),
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "(no body)");
    throw new Error(
      `LPAgent API ${response.status} ${response.statusText} [${url}]: ${body}`
    );
  }

  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Types — Pool Discovery
// ---------------------------------------------------------------------------

export interface PoolDiscoverParams {
  /** Filter by token mint addresses (comma-separated or array handled externally) */
  tokenX?: string;
  tokenY?: string;
  /** Sort field: tvl | volume | apr */
  sortBy?: "tvl" | "volume" | "apr";
  /** Min TVL filter in USD */
  minTvl?: number;
  page?: number;
  limit?: number;
}

export interface PoolInfo {
  poolId: string;
  name: string;
  tokenX: string;
  tokenY: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  binStep: number;
  baseFeePercent: number;
  tvlUsd: number;
  volume24hUsd: number;
  apr: number;
  currentPrice: number;
  activeBinId: number;
}

export interface DiscoverPoolsResponse {
  pools: PoolInfo[];
  total: number;
  page: number;
}

export interface PoolDetailResponse extends PoolInfo {
  priceRange: { lower: number; upper: number };
  liquidityDistribution: Array<{ binId: number; liquidityUsd: number }>;
}

// ---------------------------------------------------------------------------
// Types — LP Positions
// ---------------------------------------------------------------------------

export interface LpPosition {
  positionId: string;
  walletAddress: string;
  poolId: string;
  poolName: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  lowerBinId: number;
  upperBinId: number;
  activeBinId: number;
  inRange: boolean;
  totalXAmount: string;
  totalYAmount: string;
  feeX: string;
  feeY: string;
  valueUsd: number;
  feesEarnedUsd: number;
}

export interface OpenPositionsResponse {
  owner: string;
  positions: LpPosition[];
}

export interface HistoricalPositionsResponse {
  owner: string;
  positions: Array<
    LpPosition & {
      closedAt: string;
      pnlUsd: number;
      holdingPeriodDays: number;
    }
  >;
}

export interface PositionOverview {
  owner: string;
  totalValueUsd: number;
  totalFeesEarnedUsd: number;
  totalPnlUsd: number;
  openPositionCount: number;
  inRangeCount: number;
  outOfRangeCount: number;
}

// ---------------------------------------------------------------------------
// Types — Wallet
// ---------------------------------------------------------------------------

export interface TokenBalance {
  mint: string;
  symbol: string;
  decimals: number;
  rawAmount: string;
  uiAmount: number;
  valueUsd: number;
}

export interface WalletBalanceResponse {
  owner: string;
  sol: number;
  tokens: TokenBalance[];
  totalValueUsd: number;
}

// ---------------------------------------------------------------------------
// Types — Zap-In
// ---------------------------------------------------------------------------

export type ZapStrategy = "Spot" | "Curve" | "BidAsk";
export type ZapOutput = "allToken0" | "allToken1" | "both" | "allBaseToken";

export interface ZapInParams {
  owner: string;
  strategy: ZapStrategy;
  fromBinId: number;
  toBinId: number;
  /** Amount of tokenX to deposit (raw string) */
  amountX?: string;
  /** Amount of tokenY to deposit (raw string) */
  amountY?: string;
  /** Slippage in basis points (e.g. 50 = 0.5%) */
  slippageBps: number;
}

export interface ZapInTxResponse {
  /** Base64-encoded serialized unsigned transaction */
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface LandingTxParams {
  /** Base64-encoded signed transaction */
  signedTransaction: string;
}

export interface LandingTxResponse {
  txSignature: string;
  bundleId?: string;
}

// ---------------------------------------------------------------------------
// Types — Zap-Out
// ---------------------------------------------------------------------------

export interface ZapOutQuoteParams {
  positionId: string;
  owner: string;
  /** Basis points to withdraw: 10000 = 100% */
  bps: number;
  /** Slippage in basis points */
  slippageBps: number;
  output: ZapOutput;
}

export interface ZapOutQuoteResponse {
  estimatedXAmount: string;
  estimatedYAmount: string;
  estimatedValueUsd: number;
  priceImpactPct: number;
}

export interface ZapOutTxResponse {
  /** Base64-encoded serialized unsigned transaction */
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

// ---------------------------------------------------------------------------
// Pool endpoints
// ---------------------------------------------------------------------------

/**
 * Discover Meteora pools with optional filtering and sorting.
 */
export async function discoverPools(
  params: PoolDiscoverParams = {}
): Promise<DiscoverPoolsResponse> {
  const qs = new URLSearchParams();
  if (params.tokenX) qs.set("tokenX", params.tokenX);
  if (params.tokenY) qs.set("tokenY", params.tokenY);
  if (params.sortBy) qs.set("sortBy", params.sortBy);
  if (params.minTvl != null) qs.set("minTvl", String(params.minTvl));
  if (params.page != null) qs.set("page", String(params.page));
  if (params.limit != null) qs.set("limit", String(params.limit));

  const query = qs.toString() ? `?${qs.toString()}` : "";
  return request<DiscoverPoolsResponse>(`/pools/discover${query}`);
}

/**
 * Get detailed info for a single pool including bin distribution.
 */
export async function getPoolInfo(poolId: string): Promise<PoolDetailResponse> {
  return request<PoolDetailResponse>(`/pools/${encodeURIComponent(poolId)}/info`);
}

/**
 * Get on-chain stats for a pool (volume, fees, TVL over time).
 */
export async function getPoolOnchainStats(
  poolId: string
): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(
    `/pools/${encodeURIComponent(poolId)}/onchain-stats`
  );
}

// ---------------------------------------------------------------------------
// Position endpoints
// ---------------------------------------------------------------------------

/**
 * Get all currently open LP positions for a wallet.
 */
export async function getOpenPositions(
  owner: string
): Promise<OpenPositionsResponse> {
  return request<OpenPositionsResponse>(
    `/lp-positions/opening?owner=${encodeURIComponent(owner)}`
  );
}

/**
 * Get historical (closed) LP positions for a wallet.
 */
export async function getHistoricalPositions(
  owner: string
): Promise<HistoricalPositionsResponse> {
  return request<HistoricalPositionsResponse>(
    `/lp-positions/historical?owner=${encodeURIComponent(owner)}`
  );
}

/**
 * Get an aggregated portfolio overview (total value, PnL, fee income).
 */
export async function getPositionOverview(
  owner: string
): Promise<PositionOverview> {
  return request<PositionOverview>(
    `/lp-positions/overview?owner=${encodeURIComponent(owner)}`
  );
}

/**
 * Get revenue data for a wallet (7D / 1M ranges).
 */
export async function getPositionRevenue(
  owner: string
): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(
    `/lp-positions/revenue/${encodeURIComponent(owner)}`
  );
}

/**
 * Get all SPL + SOL token balances for a wallet.
 */
export async function getWalletBalance(
  owner: string
): Promise<WalletBalanceResponse> {
  return request<WalletBalanceResponse>(
    `/token/balance?owner=${encodeURIComponent(owner)}`
  );
}

// ---------------------------------------------------------------------------
// Zap-In: add liquidity to a Meteora DLMM pool
// ---------------------------------------------------------------------------

/**
 * Generate an unsigned zap-in transaction.
 * The caller must sign it and submit via submitZapIn().
 */
export async function generateZapIn(
  poolId: string,
  params: ZapInParams
): Promise<ZapInTxResponse> {
  return request<ZapInTxResponse>(`/pools/${encodeURIComponent(poolId)}/add-tx`, {
    method: "POST",
    body: JSON.stringify({
      strategy: params.strategy,
      owner: params.owner,
      fromBinId: params.fromBinId,
      toBinId: params.toBinId,
      amountX: params.amountX,
      amountY: params.amountY,
      slippage_bps: params.slippageBps,
      mode: "zap-in",
    }),
  });
}

/**
 * Submit a signed zap-in transaction via Jito bundle for fast landing.
 */
export async function submitZapIn(
  params: LandingTxParams
): Promise<LandingTxResponse> {
  return request<LandingTxResponse>("/pools/landing-add-tx", {
    method: "POST",
    body: JSON.stringify({ signedTransaction: params.signedTransaction }),
  });
}

// ---------------------------------------------------------------------------
// Zap-Out: remove liquidity from a Meteora DLMM position
// ---------------------------------------------------------------------------

/**
 * Preview how much you'd receive from withdrawing a position.
 * Use this before generating the actual zap-out tx.
 */
export async function getZapOutQuotes(
  params: ZapOutQuoteParams
): Promise<ZapOutQuoteResponse> {
  return request<ZapOutQuoteResponse>("/position/decrease-quotes", {
    method: "POST",
    body: JSON.stringify({
      position_id: params.positionId,
      owner: params.owner,
      bps: params.bps,
      slippage_bps: params.slippageBps,
      output: params.output,
    }),
  });
}

/**
 * Generate an unsigned zap-out transaction.
 * The caller must sign it and submit via submitZapOut().
 */
export async function generateZapOut(
  params: ZapOutQuoteParams
): Promise<ZapOutTxResponse> {
  return request<ZapOutTxResponse>("/position/decrease-tx", {
    method: "POST",
    body: JSON.stringify({
      position_id: params.positionId,
      owner: params.owner,
      bps: params.bps,
      slippage_bps: params.slippageBps,
      output: params.output,
    }),
  });
}

/**
 * Submit a signed zap-out transaction via Jito bundle for fast landing.
 */
export async function submitZapOut(
  params: LandingTxParams
): Promise<LandingTxResponse> {
  return request<LandingTxResponse>("/position/landing-decrease-tx", {
    method: "POST",
    body: JSON.stringify({ signedTransaction: params.signedTransaction }),
  });
}
