import { describe, it, expect } from 'vitest';
import { periodReturn, rsRaw, trendQuality, highProximity, liquidityRaw, percentileRanks } from './score';
import type { Candle, Indicators } from './types';

const ind = (o: Partial<Indicators>): Indicators => ({
  ema20: 0, ema50: 0, ema100: 0, macdHist: 0, atr: 1, ema100Slope: 0, ...o,
});
const candle = (c: number, h = c, v = 1): Candle => ({ t: 0, o: c, h, l: c, c, v });

describe('periodReturn', () => {
  it('computes return over n bars', () => {
    expect(periodReturn([100, 110], 1)).toBeCloseTo(0.1, 6);
    expect(periodReturn([100, 90], 1)).toBeCloseTo(-0.1, 6);
  });
  it('clamps to available history', () => {
    expect(periodReturn([100, 200], 999)).toBeCloseTo(1.0, 6);
  });
});

describe('rsRaw', () => {
  it('is higher for a stronger uptrend', () => {
    const strong = Array.from({ length: 200 }, (_, i) => 100 * Math.pow(1.01, i));
    const weak = Array.from({ length: 200 }, (_, i) => 100 * Math.pow(1.001, i));
    expect(rsRaw(strong)).toBeGreaterThan(rsRaw(weak));
  });
  it('is negative for a downtrend', () => {
    const down = Array.from({ length: 200 }, (_, i) => 200 - i * 0.5);
    expect(rsRaw(down)).toBeLessThan(0);
  });
});

describe('trendQuality', () => {
  it('is 1 when all four conditions hold', () => {
    expect(trendQuality(ind({ ema20: 30, ema50: 20, ema100: 10, macdHist: 1, ema100Slope: 1 }), 35)).toBe(1);
  });
  it('is 0 when none hold', () => {
    expect(trendQuality(ind({ ema20: 10, ema50: 20, ema100: 30, macdHist: -1, ema100Slope: -1 }), 5)).toBe(0);
  });
  it('is 0.5 when two hold', () => {
    // 정배열 + price>EMA100 true; slope & macd not
    expect(trendQuality(ind({ ema20: 30, ema50: 20, ema100: 10, macdHist: -1, ema100Slope: -1 }), 35)).toBe(0.5);
  });
});

describe('highProximity', () => {
  it('is 1 at a new high and <1 below it', () => {
    const atHigh = [candle(50, 50), candle(80, 100), candle(100, 100)];
    expect(highProximity(atHigh)).toBeCloseTo(1, 6);
    const belowHigh = [candle(50, 50), candle(100, 100), candle(75, 80)];
    expect(highProximity(belowHigh)).toBeCloseTo(0.75, 6); // close 75 / hi 100
  });
});

describe('liquidityRaw', () => {
  it('averages close×volume over the window', () => {
    expect(liquidityRaw([candle(10, 10, 2), candle(20, 20, 3)], 20)).toBeCloseTo((20 + 60) / 2, 6);
  });
});

describe('percentileRanks', () => {
  it('ranks ascending: smallest→0, largest→100', () => {
    const r = percentileRanks([10, 20, 30]);
    expect(r[0]).toBeCloseTo(0, 6);
    expect(r[2]).toBeCloseTo(100, 6);
    expect(r[1]).toBeCloseTo(50, 6);
  });
  it('single element → 100', () => {
    expect(percentileRanks([42])).toEqual([100]);
  });
});
