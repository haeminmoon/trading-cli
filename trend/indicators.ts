import type { Candle, Indicators } from './types';

/**
 * EMA series aligned to `values`. Entries before `period-1` are NaN; the entry
 * at `period-1` is seeded with the SMA of the first `period` values, then
 * standard EMA (k = 2/(period+1)) thereafter.
 */
export function emaSeries(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * MACD histogram series: macdLine = EMA(fast) − EMA(slow); signal = EMA(sig) of
 * the macdLine; histogram = macdLine − signal. Entries are NaN until defined.
 */
export function macdHistogramSeries(closes: number[], fast = 12, slow = 26, sig = 9): number[] {
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macdLine = closes.map((_, i) =>
    Number.isNaN(emaFast[i]) || Number.isNaN(emaSlow[i]) ? NaN : emaFast[i] - emaSlow[i],
  );
  // Signal EMA over the defined portion of macdLine, then re-aligned to full length.
  const firstIdx = macdLine.findIndex((v) => !Number.isNaN(v));
  const hist = new Array<number>(closes.length).fill(NaN);
  if (firstIdx === -1) return hist;
  const defined = macdLine.slice(firstIdx);
  const signalDefined = emaSeries(defined, sig);
  for (let j = 0; j < defined.length; j++) {
    if (!Number.isNaN(signalDefined[j])) hist[firstIdx + j] = defined[j] - signalDefined[j];
  }
  return hist;
}

/**
 * ATR(period, Wilder) series. TR[i] = max(h−l, |h−prevClose|, |l−prevClose|).
 * Seeded at index `period` with the mean of TR[1..period], then Wilder smoothing
 * ATR = (prevATR*(period−1) + TR) / period.
 */
export function atrWilderSeries(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): number[] {
  const n = closes.length;
  const out = new Array<number>(n).fill(NaN);
  if (n < period + 1) return out;
  const tr = new Array<number>(n).fill(NaN);
  tr[0] = highs[0] - lows[0];
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
  }
  // First ATR = average of TR[1..period].
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < n; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** Last finite value of a series (NaN if none). */
function last(series: number[]): number {
  for (let i = series.length - 1; i >= 0; i--) if (!Number.isNaN(series[i])) return series[i];
  return NaN;
}

/** Minimum bars needed for every indicator (EMA100 + 20-bar slope) to be valid. */
export const MIN_BARS = 120;

/**
 * Compute all indicators at the latest bar. `slopeLookback` bars back is used for
 * the EMA100 slope (default 20). Throws if there are too few bars for EMA100+slope.
 */
export function computeIndicators(candles: Candle[], slopeLookback = 20): Indicators {
  const closes = candles.map((c) => c.c);
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);

  const e20 = emaSeries(closes, 20);
  const e50 = emaSeries(closes, 50);
  const e100 = emaSeries(closes, 100);
  const hist = macdHistogramSeries(closes);
  const atr = atrWilderSeries(highs, lows, closes, 14);

  const lastIdx = e100.length - 1;
  const slopeFromIdx = lastIdx - slopeLookback;
  const ema100Now = e100[lastIdx];
  const ema100Past = slopeFromIdx >= 0 ? e100[slopeFromIdx] : NaN;
  if (Number.isNaN(ema100Now) || Number.isNaN(ema100Past)) {
    throw new Error(
      `Not enough bars for EMA100 + ${slopeLookback}-bar slope (need ≥ ${100 + slopeLookback}, got ${candles.length}).`,
    );
  }

  return {
    ema20: last(e20),
    ema50: last(e50),
    ema100: ema100Now,
    macdHist: last(hist),
    atr: last(atr),
    ema100Slope: ema100Now - ema100Past,
  };
}
