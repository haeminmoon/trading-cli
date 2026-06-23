import type { Indicators, Signal } from './types';

export interface SignalResult {
  signal: Signal;
  reason: string;
}

/**
 * Trend / entry signal from the indicator set (spec):
 *   +1 long  : 정배열 (EMA20 > EMA50 > EMA100) AND MACD histogram > 0
 *   −1 short : 역배열 (EMA20 < EMA50 < EMA100) AND MACD histogram < 0 AND EMA100 slope < 0
 *    0       : otherwise (stand aside)
 */
export function evaluateSignal(ind: Indicators): SignalResult {
  const bull = ind.ema20 > ind.ema50 && ind.ema50 > ind.ema100;
  const bear = ind.ema20 < ind.ema50 && ind.ema50 < ind.ema100;

  if (bull && ind.macdHist > 0) {
    return { signal: 1, reason: '정배열(EMA20>50>100) + MACD히스토 > 0' };
  }
  if (bear && ind.macdHist < 0 && ind.ema100Slope < 0) {
    return { signal: -1, reason: '역배열(EMA20<50<100) + MACD히스토 < 0 + EMA100 기울기 < 0' };
  }
  return { signal: 0, reason: '진입조건 미충족 — 관망' };
}

/** Human label for a signal. */
export function signalLabel(s: Signal): string {
  return s === 1 ? 'LONG ▲' : s === -1 ? 'SHORT ▼' : 'FLAT ·';
}
