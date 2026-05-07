import "dotenv/config";

const BASE_URL = "https://api.lpagent.io/open-api/v1";

function getApiKey(): string {
  const key = process.env["LPAGENT_API_KEY"];
  if (!key) throw new Error("LPAGENT_API_KEY is not set");
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
      `LPAgent ${response.status} ${response.statusText} [${url}]: ${body}`
    );
  }

  return response.json() as Promise<T>;
}

export interface PoolDiscoverParams {
  tokenX?: string;
  tokenY?: string;
  sortBy?: "tvl" | "volume" | "apr";
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

export type ZapStrategy = "Spot" | "Curve" | "BidAsk";
export type ZapOutput = "allToken0" | "allToken1" | "both" | "allBaseToken";

export interface ZapInParams {
  owner: string;
  strategy: ZapStrategy;
  fromBinId: number;
  toBinId: number;
  amountX?: string;
  amountY?: string;
  slippageBps: number;
}

export interface ZapInTxResponse {
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface LandingTxParams {
  signedTransaction: string;
}

export interface LandingTxResponse {
  txSignature: string;
  bundleId?: string;
}

export interface ZapOutQuoteParams {
  positionId: string;
  owner: string;
  // basis points to withdraw, 10000 = 100%
  bps: number;
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
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

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

export async function getPoolInfo(poolId: string): Promise<PoolDetailResponse> {
  return request<PoolDetailResponse>(`/pools/${encodeURIComponent(poolId)}/info`);
}

export async function getPoolOnchainStats(
  poolId: string
): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(
    `/pools/${encodeURIComponent(poolId)}/onchain-stats`
  );
}

export interface TopLper {
  walletAddress: string;
  totalValueUsd: number;
  feesEarnedUsd: number;
  pnlUsd?: number;
  positionCount?: number;
  apr?: number;
  lowerBinId?: number;
  upperBinId?: number;
  strategy?: ZapStrategy;
}

export interface TopLpersResponse {
  poolId: string;
  lpers: TopLper[];
}

// Premium tier endpoint, used by the copy-LP feature.
export async function getTopLpers(poolId: string): Promise<TopLpersResponse> {
  return request<TopLpersResponse>(
    `/pools/${encodeURIComponent(poolId)}/top-lpers`
  );
}

export async function getOpenPositions(
  owner: string
): Promise<OpenPositionsResponse> {
  return request<OpenPositionsResponse>(
    `/lp-positions/opening?owner=${encodeURIComponent(owner)}`
  );
}

export async function getHistoricalPositions(
  owner: string
): Promise<HistoricalPositionsResponse> {
  return request<HistoricalPositionsResponse>(
    `/lp-positions/historical?owner=${encodeURIComponent(owner)}`
  );
}

export async function getPositionOverview(
  owner: string
): Promise<PositionOverview> {
  return request<PositionOverview>(
    `/lp-positions/overview?owner=${encodeURIComponent(owner)}`
  );
}

export async function getPositionRevenue(
  owner: string
): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(
    `/lp-positions/revenue/${encodeURIComponent(owner)}`
  );
}

export async function getWalletBalance(
  owner: string
): Promise<WalletBalanceResponse> {
  return request<WalletBalanceResponse>(
    `/token/balance?owner=${encodeURIComponent(owner)}`
  );
}

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

export async function submitZapIn(
  params: LandingTxParams
): Promise<LandingTxResponse> {
  return request<LandingTxResponse>("/pools/landing-add-tx", {
    method: "POST",
    body: JSON.stringify({ signedTransaction: params.signedTransaction }),
  });
}

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

export async function submitZapOut(
  params: LandingTxParams
): Promise<LandingTxResponse> {
  return request<LandingTxResponse>("/position/landing-decrease-tx", {
    method: "POST",
    body: JSON.stringify({ signedTransaction: params.signedTransaction }),
  });
}
