/**
 * Leader-scoring primitives for finding 대장주/주도주 (market leaders).
 *
 * Trend-following leadership ≠ "just an uptrend" — it's about *relative*
 * strength, proximity to highs, liquidity, and (KR) institutional/foreign
 * accumulation. These pure functions produce the raw inputs; the orchestrator
 * (leaders.ts) percentile-ranks the relative ones across the scanned universe
 * and blends everything into a 0–100 balanced score.
 */
import type { Candle, Indicators } from './types';

/** Simple return over `bars` bars: close[last]/close[last-bars] − 1. Clamped to available history. */
export function periodReturn(closes: number[], bars: number): number {
  if (closes.length < 2) return 0;
  const last = closes[closes.length - 1];
  const i = Math.max(0, closes.length - 1 - bars);
  const base = closes[i];
  if (!(base > 0)) return 0;
  return last / base - 1;
}

/**
 * Raw relative-strength metric: a momentum blend weighting 3M most, then 6M, 1M
 * (trading-day approximations: 21≈1M, 63≈3M, 126≈6M). Higher = stronger price
 * performance. Percentile-ranked across the universe by the caller.
 */
export function rsRaw(closes: number[]): number {
  return 0.4 * periodReturn(closes, 63) + 0.3 * periodReturn(closes, 126) + 0.3 * periodReturn(closes, 21);
}

/**
 * Trend quality 0..1 — fraction of four leadership conditions met:
 *   정배열 (EMA20>EMA50>EMA100), 가격 > EMA100, EMA100 기울기 > 0, MACD 히스토 > 0.
 */
export function trendQuality(ind: Indicators, lastClose: number): number {
  let n = 0;
  if (ind.ema20 > ind.ema50 && ind.ema50 > ind.ema100) n++;
  if (lastClose > ind.ema100) n++;
  if (ind.ema100Slope > 0) n++;
  if (ind.macdHist > 0) n++;
  return n / 4;
}

/**
 * Proximity to the period high 0..1 = close / max(high over `lookback`).
 * 1.0 = at a new high; 0.75 = 25% below the high (Minervini's ceiling).
 */
export function highProximity(candles: Candle[], lookback = 252): number {
  if (candles.length === 0) return 0;
  const from = Math.max(0, candles.length - lookback);
  let hi = -Infinity;
  for (let i = from; i < candles.length; i++) hi = Math.max(hi, candles[i].h);
  const close = candles[candles.length - 1].c;
  if (!(hi > 0)) return 0;
  return Math.min(1, close / hi);
}

/** Liquidity proxy: average notional turnover (close × volume) over the last `bars` bars. */
export function liquidityRaw(candles: Candle[], bars = 20): number {
  if (candles.length === 0) return 0;
  const from = Math.max(0, candles.length - bars);
  let sum = 0;
  let n = 0;
  for (let i = from; i < candles.length; i++) {
    sum += candles[i].c * candles[i].v;
    n++;
  }
  return n ? sum / n : 0;
}

/**
 * Percentile rank (0..100) of each value within the array — value's position
 * relative to the rest. Ties share the average rank; single element → 100.
 */
export function percentileRanks(values: number[]): number[] {
  const n = values.length;
  if (n <= 1) return values.map(() => 100);
  return values.map((v) => {
    let below = 0;
    let equal = 0;
    for (const w of values) {
      if (w < v) below++;
      else if (w === v) equal++;
    }
    return ((below + (equal - 1) / 2) / (n - 1)) * 100;
  });
}
