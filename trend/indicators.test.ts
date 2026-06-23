import { describe, it, expect } from 'vitest';
import { emaSeries, atrWilderSeries, macdHistogramSeries, computeIndicators } from './indicators';
import { evaluateSignal } from './signal';
import type { Candle, Indicators } from './types';

describe('emaSeries', () => {
  it('seeds with SMA then applies k = 2/(period+1)', () => {
    // period 3, k = 0.5. seed at idx2 = mean(1,2,3)=2; idx3 = 4*.5 + 2*.5 = 3; idx4 = 5*.5 + 3*.5 = 4
    expect(emaSeries([1, 2, 3, 4, 5], 3)).toEqual([NaN, NaN, 2, 3, 4]);
  });
  it('is all NaN when fewer values than period', () => {
    expect(emaSeries([1, 2], 3)).toEqual([NaN, NaN]);
  });
});

describe('atrWilderSeries', () => {
  it('converges to a constant true range', () => {
    // Every bar spans exactly 10 (high = low + 10), closes flat → TR = 10 → ATR = 10
    const n = 40;
    const highs = Array.from({ length: n }, () => 110);
    const lows = Array.from({ length: n }, () => 100);
    const closes = Array.from({ length: n }, () => 105);
    const atr = atrWilderSeries(highs, lows, closes, 14);
    expect(atr[14]).toBeCloseTo(10, 6);
    expect(atr[n - 1]).toBeCloseTo(10, 6);
  });
});

describe('macdHistogramSeries', () => {
  it('is positive on an accelerating uptrend and negative on an accelerating downtrend', () => {
    // Compounding up accelerates; mirror it for a genuinely accelerating downtrend
    // (a 0.99^i decay decelerates, which correctly yields a positive histogram).
    const up = Array.from({ length: 120 }, (_, i) => 100 * Math.pow(1.01, i));
    const base = 100 * Math.pow(1.01, 120);
    const down = Array.from({ length: 120 }, (_, i) => base - 100 * Math.pow(1.01, i));
    const hUp = macdHistogramSeries(up);
    const hDown = macdHistogramSeries(down);
    expect(hUp[hUp.length - 1]).toBeGreaterThan(0);
    expect(hDown[hDown.length - 1]).toBeLessThan(0);
  });
});

function series(closes: number[]): Candle[] {
  return closes.map((c, i) => ({ t: i * 3600000, o: c, h: c * 1.01, l: c * 0.99, c, v: 1 }));
}

describe('computeIndicators', () => {
  it('throws when there are too few bars for EMA100 + slope', () => {
    expect(() => computeIndicators(series(Array.from({ length: 100 }, (_, i) => 100 + i)))).toThrow();
  });
  it('orders EMA20 > EMA50 > EMA100 on an uptrend', () => {
    const ind = computeIndicators(series(Array.from({ length: 200 }, (_, i) => 100 * Math.pow(1.01, i))));
    expect(ind.ema20).toBeGreaterThan(ind.ema50);
    expect(ind.ema50).toBeGreaterThan(ind.ema100);
    expect(ind.ema100Slope).toBeGreaterThan(0);
    expect(ind.atr).toBeGreaterThan(0);
  });
});

describe('evaluateSignal', () => {
  const base: Indicators = { ema20: 0, ema50: 0, ema100: 0, macdHist: 0, atr: 1, ema100Slope: 0 };
  it('returns +1 long on bullish alignment + positive MACD', () => {
    expect(evaluateSignal({ ...base, ema20: 30, ema50: 20, ema100: 10, macdHist: 0.5 }).signal).toBe(1);
  });
  it('returns −1 short on bearish alignment + negative MACD + negative slope', () => {
    expect(
      evaluateSignal({ ...base, ema20: 10, ema50: 20, ema100: 30, macdHist: -0.5, ema100Slope: -1 }).signal,
    ).toBe(-1);
  });
  it('returns 0 when short alignment holds but slope is not negative', () => {
    expect(
      evaluateSignal({ ...base, ema20: 10, ema50: 20, ema100: 30, macdHist: -0.5, ema100Slope: 1 }).signal,
    ).toBe(0);
  });
  it('returns 0 when bullish alignment but MACD not positive', () => {
    expect(evaluateSignal({ ...base, ema20: 30, ema50: 20, ema100: 10, macdHist: -0.1 }).signal).toBe(0);
  });
});
