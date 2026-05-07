import type { PoolDetailResponse, ZapStrategy, LpPosition } from "./lpagent.js";

// price = (1 + binStep / 10_000) ^ binId  -- standard DLMM bin formula
export function binToPrice(binId: number, binStep: number): number {
  return Math.pow(1 + binStep / 10_000, binId);
}

export function priceToBin(price: number, binStep: number): number {
  return Math.round(Math.log(price) / Math.log(1 + binStep / 10_000));
}

// Concentrated-liquidity IL relative to a 50/50 HODL of the entry tokens.
// Returns a fraction (e.g. -0.012 = -1.2%). Uniswap v3 / DLMM closed form.
export function impermanentLossPct(args: {
  pEntry: number;
  pNow: number;
  pLower: number;
  pUpper: number;
}): number {
  const { pEntry, pNow, pLower, pUpper } = args;
  if (pEntry <= 0 || pNow <= 0 || pLower <= 0 || pUpper <= pLower) return 0;

  const sqrtL = Math.sqrt(pLower);
  const sqrtU = Math.sqrt(pUpper);
  const sqrtE = Math.max(sqrtL, Math.min(sqrtU, Math.sqrt(pEntry)));
  const sqrtN = Math.max(sqrtL, Math.min(sqrtU, Math.sqrt(pNow)));

  const xEntry = (sqrtU - sqrtE) / (sqrtE * sqrtU);
  const yEntry = sqrtE - sqrtL;
  const vEntry = xEntry * pEntry + yEntry;
  if (vEntry <= 0) return 0;

  const xNow = (sqrtU - sqrtN) / (sqrtN * sqrtU);
  const yNow = sqrtN - sqrtL;
  const vLp = xNow * pNow + yNow;

  const vHodl = xEntry * pNow + yEntry;
  if (vHodl <= 0) return 0;

  return vLp / vHodl - 1;
}

// Annualised volatility from log-returns. Cadence is unknown so we ballpark
// the sample as hourly (8760/yr); refine when timestamps are available.
export function annualisedVolatility(prices: number[]): number {
  if (prices.length < 2) return 0;
  const logReturns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const a = prices[i - 1];
    const b = prices[i];
    if (typeof a === "number" && typeof b === "number" && a > 0 && b > 0) {
      logReturns.push(Math.log(b / a));
    }
  }
  if (logReturns.length < 2) return 0;
  const mean = logReturns.reduce((s, x) => s + x, 0) / logReturns.length;
  const variance =
    logReturns.reduce((s, x) => s + (x - mean) ** 2, 0) / (logReturns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(8760);
}

export interface StrategyScore {
  strategy: ZapStrategy;
  score: number;
  rationale: string;
}

// Rough heuristic that picks among the three Meteora strategies based on
// observed annualised vol. Spot wins in low vol, BidAsk wins in high vol,
// Curve sits in between.
export function scoreStrategies(args: {
  annualisedVol: number;
  poolApr: number;
}): StrategyScore[] {
  const v = Math.max(0, args.annualisedVol);
  const apr = Math.max(0, args.poolApr);

  const spot: StrategyScore = {
    strategy: "Spot",
    score: 100 - Math.abs(v - 0.2) * 80 + apr * 0.1,
    rationale: `Spot concentrates capital around the active bin. Best below 30% annualised vol. Pool vol estimate: ${(v * 100).toFixed(0)}%.`,
  };
  const curve: StrategyScore = {
    strategy: "Curve",
    score: 100 - Math.abs(v - 0.55) * 60 + apr * 0.05,
    rationale: `Curve uses a normal-distribution range. Balanced fee yield vs IL between 30-80% vol. Pool vol: ${(v * 100).toFixed(0)}%.`,
  };
  const bidAsk: StrategyScore = {
    strategy: "BidAsk",
    score: 80 + Math.max(0, v - 0.6) * 40,
    rationale: `BidAsk widens the range so price drift is less likely to exit. Best above 80% vol or strongly trending pairs. Pool vol: ${(v * 100).toFixed(0)}%.`,
  };

  return [spot, curve, bidAsk].sort((a, b) => b.score - a.score);
}

export interface RangeRecommendation {
  strategy: ZapStrategy;
  fromBinId: number;
  toBinId: number;
  lowerPrice: number;
  upperPrice: number;
  expectedTimeInRangeDays: number;
  rationale: string;
}

export function recommendRange(args: {
  pool: PoolDetailResponse;
  annualisedVol?: number;
  preference?: "tight" | "balanced" | "wide";
}): RangeRecommendation {
  const { pool } = args;
  const vol = args.annualisedVol ?? 0.5;
  const pref = args.preference ?? "balanced";

  // expected weekly move expressed in bins
  const dailyMove = vol / Math.sqrt(365);
  const weeklyMove = dailyMove * Math.sqrt(7);
  const binsPerWeeklyMove = Math.max(
    8,
    Math.ceil(weeklyMove / (pool.binStep / 10_000))
  );

  const widthMultiplier =
    pref === "tight" ? 0.6 : pref === "wide" ? 1.6 : 1.0;
  const halfWidth = Math.max(5, Math.round(binsPerWeeklyMove * widthMultiplier));

  const fromBinId = pool.activeBinId - halfWidth;
  const toBinId = pool.activeBinId + halfWidth;

  const lowerPrice = binToPrice(fromBinId, pool.binStep);
  const upperPrice = binToPrice(toBinId, pool.binStep);

  // first-exit time of a random walk: ~ (width / dailyMove)^2, capped at 60d
  const widthFraction = (upperPrice - lowerPrice) / pool.currentPrice / 2;
  const expectedDays = Math.min(
    60,
    Math.max(0.5, Math.pow(widthFraction / Math.max(dailyMove, 0.001), 2))
  );

  const strategies = scoreStrategies({
    annualisedVol: vol,
    poolApr: pool.apr,
  });
  const best = strategies[0]!;

  return {
    strategy: best.strategy,
    fromBinId,
    toBinId,
    lowerPrice,
    upperPrice,
    expectedTimeInRangeDays: expectedDays,
    rationale: `${best.strategy} across ${halfWidth * 2 + 1} bins (+/-${halfWidth} from active). Expected to stay in range ~${expectedDays.toFixed(1)} days at ${(vol * 100).toFixed(0)}% annualised vol. ${best.rationale}`,
  };
}

export interface PositionHealth {
  positionId: string;
  score: number;
  inRange: boolean;
  feeEfficiency: number;
  warnings: string[];
}

export function scorePositionHealth(pos: LpPosition): PositionHealth {
  const warnings: string[] = [];
  let score = 100;

  if (!pos.inRange) {
    score -= 50;
    warnings.push("Position is out of range, earning no fees");
  }

  const feeEfficiency = pos.valueUsd > 0 ? pos.feesEarnedUsd / pos.valueUsd : 0;
  if (feeEfficiency < 0.001 && pos.inRange) {
    score -= 20;
    warnings.push("Very low fee yield, consider tighter range or different pool");
  }

  if (pos.valueUsd < 5) {
    score -= 15;
    warnings.push("Position size is dust (< $5)");
  }

  const range = pos.upperBinId - pos.lowerBinId;
  if (range > 0) {
    const distLeft = pos.activeBinId - pos.lowerBinId;
    const distRight = pos.upperBinId - pos.activeBinId;
    const edgeDist = Math.min(distLeft, distRight) / range;
    if (edgeDist < 0.1 && pos.inRange) {
      score -= 15;
      warnings.push("Active bin is near the edge of your range, likely to exit soon");
    }
  }

  return {
    positionId: pos.positionId,
    score: Math.max(0, Math.min(100, score)),
    inRange: pos.inRange,
    feeEfficiency,
    warnings,
  };
}
