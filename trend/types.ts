/**
 * Shared types for the trend-analysis tool.
 *
 * The 6 exchange CLIs each output candles in their own JSON shape; an Adapter
 * normalizes them to `Candle` (numeric OHLCV, open-time in ms ascending) and
 * resolves a user-typed symbol/name to that exchange's symbol. The indicator
 * and signal layers are exchange-agnostic and operate only on `Candle[]`.
 */

/** Normalized OHLCV bar. `t` = open time in epoch ms. Series are sorted ascending by `t`. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Indicators computed from a candle series (all evaluated at the latest bar). */
export interface Indicators {
  ema20: number;
  ema50: number;
  ema100: number;
  /** MACD histogram = (EMA12 − EMA26) − signalEMA9, at the latest bar. */
  macdHist: number;
  /** ATR(14, Wilder) at the latest bar. */
  atr: number;
  /** EMA100[now] − EMA100[20 bars ago]; short-regime filter. */
  ema100Slope: number;
}

/** Trend / entry signal: +1 long, −1 short, 0 stand-aside. */
export type Signal = -1 | 0 | 1;

/** Per-timeframe analysis result. */
export interface TimeframeResult {
  timeframe: string;
  bars: number;
  lastClose: number;
  indicators: Indicators;
  signal: Signal;
  reason: string;
  imagePath?: string;
}

/** An exchange data adapter: symbol resolution + normalized candle fetching. */
export interface Adapter {
  /** Exchange id, e.g. 'hyperliquid'. */
  readonly name: string;
  /** Trend timeframes this exchange supports, coarse→fine or as preferred for display. */
  readonly timeframes: readonly string[];
  /** Resolve user input (ticker, code, or name) to this exchange's canonical symbol. */
  resolveSymbol(input: string): Promise<string>;
  /** Fetch up to `count` normalized candles for symbol+timeframe, ascending by time. */
  fetchCandles(symbol: string, timeframe: string, count: number): Promise<Candle[]>;
  /** List every tradeable symbol on the exchange (for bulk scans). Optional. */
  listSymbols?(): Promise<string[]>;
  /** Human-readable name for a symbol (e.g. '329180' → 'HD현대중공업'). Optional. */
  nameFor?(symbol: string): Promise<string | undefined>;
}
