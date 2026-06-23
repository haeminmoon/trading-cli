/**
 * Backpack Exchange data adapter.
 *
 * Shells out to the installed `backpack` CLI (node_modules/.bin/backpack) and
 * normalizes its JSON output to the shared `Candle` / `Adapter` contracts.
 *
 *   - klines:  `backpack market klines -s <SYMBOL> -i <tf> --count <n> -f json`
 *              → array of { start, open, high, low, close, volume } (string values).
 *              `start` is the bar open time: either ms-since-epoch or a datetime
 *              string. Backpack emits its datetime strings in UTC, so the
 *              space-separated `"YYYY-MM-DD HH:MM:SS"` form is parsed as UTC
 *              explicitly (Date.parse would treat it as local time).
 *   - markets: `backpack market list -f json`
 *              → array of { symbol, baseSymbol, quoteSymbol, marketType }.
 *              Symbols look like 'SOL_USDC' (SPOT) or 'BTC_USDC_PERP' (PERP).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Adapter, Candle } from '../types';

const execFileAsync = promisify(execFile);

/** Repo root = two levels up from this file (trend/adapters/ → repo root). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BACKPACK_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'backpack');

/** Run the backpack CLI from the repo root and JSON.parse its stdout. */
async function runBackpack(args: string[]): Promise<unknown> {
  const { stdout } = await execFileAsync(BACKPACK_BIN, args, {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

/**
 * Convert a backpack `start` field to epoch ms.
 *   - number / numeric string: epoch in s (×1000), ms (as-is), or ns (÷1e6),
 *     detected by magnitude.
 *   - ISO string (has 'T'): Date.parse handles the timezone.
 *   - 'YYYY-MM-DD HH:MM:SS' (space): parsed as UTC (Backpack emits UTC).
 */
function toMs(start: unknown): number {
  if (typeof start === 'number' || (typeof start === 'string' && /^\d+(\.\d+)?$/.test(start))) {
    const n = Number(start);
    if (n >= 1e17) return Math.floor(n / 1e6); // nanoseconds
    if (n >= 1e11) return Math.floor(n); // milliseconds
    return Math.floor(n * 1000); // seconds
  }
  if (typeof start === 'string') {
    const m = start.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (m && !/[TZ]|[+-]\d{2}:?\d{2}$/.test(start)) {
      // Space-separated, no zone designator → Backpack UTC wall-clock.
      return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    }
    const parsed = Date.parse(start); // ISO or zoned string
    if (!Number.isNaN(parsed)) return parsed;
  }
  return NaN;
}

interface RawKline {
  start?: unknown;
  open?: unknown;
  high?: unknown;
  low?: unknown;
  close?: unknown;
  volume?: unknown;
}

interface RawMarket {
  symbol?: unknown;
  baseSymbol?: unknown;
  quoteSymbol?: unknown;
  marketType?: unknown;
}

export const adapter: Adapter = {
  name: 'backpack',
  timeframes: ['1h', '4h', '8h', '1d'],

  async resolveSymbol(input: string): Promise<string> {
    const q = input.trim().toUpperCase();
    if (!q) throw new Error('backpack: empty symbol input');

    const markets = (await runBackpack(['market', 'list', '-f', 'json'])) as RawMarket[];
    const matches = markets.filter((m) => String(m.baseSymbol ?? '').toUpperCase() === q);

    if (matches.length === 0) {
      // Fall back: exact symbol typed directly (e.g. 'BTC_USDC_PERP').
      const direct = markets.find((m) => String(m.symbol ?? '').toUpperCase() === q);
      if (direct) return String(direct.symbol);
      throw new Error(`backpack: no market with base asset '${input}'`);
    }

    const isUsdc = (m: RawMarket) => String(m.quoteSymbol ?? '').toUpperCase() === 'USDC';
    const isPerp = (m: RawMarket) => String(m.marketType ?? '').toUpperCase() === 'PERP';

    // Prefer USDC perp, then USDC spot, then any USDC, then anything.
    const usdcPerp = matches.find((m) => isUsdc(m) && isPerp(m));
    if (usdcPerp) return String(usdcPerp.symbol);
    const usdcSpot = matches.find((m) => isUsdc(m) && !isPerp(m));
    if (usdcSpot) return String(usdcSpot.symbol);
    const usdc = matches.find(isUsdc);
    if (usdc) return String(usdc.symbol);
    return String(matches[0].symbol);
  },

  async fetchCandles(symbol: string, timeframe: string, count: number): Promise<Candle[]> {
    const raw = (await runBackpack([
      'market',
      'klines',
      '-s',
      symbol,
      '-i',
      timeframe,
      '--count',
      String(count),
      '-f',
      'json',
    ])) as RawKline[];

    if (!Array.isArray(raw)) {
      throw new Error(`backpack: unexpected klines response for ${symbol} ${timeframe}`);
    }

    const candles: Candle[] = raw.map((k) => ({
      t: toMs(k.start),
      o: Number(k.open),
      h: Number(k.high),
      l: Number(k.low),
      c: Number(k.close),
      v: Number(k.volume),
    }));

    return candles.sort((a, b) => a.t - b.t);
  },
};
