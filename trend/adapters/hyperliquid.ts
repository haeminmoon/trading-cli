import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type { Adapter, Candle } from '../types';

const execFileAsync = promisify(execFile);

/** Repo root = two levels up from this file (trend/adapters → repo root). */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Installed Hyperliquid CLI bin, resolved from the repo root. */
const BIN = resolve(REPO_ROOT, 'node_modules', '.bin', 'hyperliquid-cli');

/** Raw candle as emitted by `hyperliquid-cli market candles`. OHLCV are strings. */
interface RawCandle {
  t: number | string;
  o: string | number;
  h: string | number;
  l: string | number;
  c: string | number;
  v: string | number;
}

/**
 * Hyperliquid adapter. Perps are bare coin names (e.g. 'BTC'), so symbol
 * resolution just uppercases the input and strips a trailing perp/USD suffix.
 * All four timeframes are native to the exchange.
 */
export const adapter: Adapter = {
  name: 'hyperliquid',
  timeframes: ['1h', '4h', '8h', '1d'],

  async resolveSymbol(input: string): Promise<string> {
    let sym = input.trim().toUpperCase();
    sym = sym.replace(/(-PERP|PERP|_USDC|_USD)$/, '');
    return sym;
  },

  async fetchCandles(symbol: string, timeframe: string, count: number): Promise<Candle[]> {
    const { stdout } = await execFileAsync(
      BIN,
      ['market', 'candles', symbol, '-i', timeframe, '-n', String(count), '-o', 'json'],
      { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 },
    );

    const raw = JSON.parse(stdout) as RawCandle[];
    const candles: Candle[] = raw.map((r) => ({
      t: Number(r.t),
      o: Number(r.o),
      h: Number(r.h),
      l: Number(r.l),
      c: Number(r.c),
      v: Number(r.v),
    }));

    candles.sort((a, b) => a.t - b.t);
    return candles;
  },
};
