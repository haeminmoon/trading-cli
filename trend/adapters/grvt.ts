import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Adapter, Candle } from '../types';

const execFileAsync = promisify(execFile);

/** Repo root = two levels up from trend/adapters/. */
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
/** Installed grvt CLI bin. */
const BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'grvt-cli');

/** Run grvt-cli from the repo root and JSON.parse its stdout. */
async function runJson<T>(args: string[]): Promise<T> {
  const { stdout } = await execFileAsync(BIN, args, {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

/**
 * Coerce an epoch timestamp of unknown unit to ms. grvt emits open_time in
 * nanoseconds internally; we detect by magnitude so we stay correct if the CLI
 * ever switches: ISO strings → Date.parse; ns (≥ ~1e17) → ÷1e6; µs → ÷1e3;
 * s (< ~1e11) → ×1000; otherwise already ms.
 */
function toMs(value: string | number): number {
  if (typeof value === 'string' && /[-:tz]/i.test(value)) return Date.parse(value);
  const n = Number(value);
  const abs = Math.abs(n);
  if (abs >= 1e17) return Math.round(n / 1e6); // nanoseconds
  if (abs >= 1e14) return Math.round(n / 1e3); // microseconds
  if (abs < 1e11) return Math.round(n * 1000); // seconds
  return Math.round(n); // milliseconds
}

interface GrvtInstrument {
  instrument: string;
  base: string;
  quote: string;
  kind: string;
}

interface GrvtCandle {
  open_time: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume_b: string;
}

export const adapter: Adapter = {
  name: 'grvt',
  timeframes: ['1h', '4h', '8h', '1d'],

  async resolveSymbol(input: string): Promise<string> {
    const query = input.trim();
    // Already a full instrument name (e.g. 'BTC_USDT_Perp')? Pass it through.
    if (/_/.test(query)) return query;

    const instruments = await runJson<GrvtInstrument[]>(['market', 'instruments', '-o', 'json']);
    const base = query.toUpperCase();
    // Prefer a USDT perpetual on the matching base, else any matching base.
    const match =
      instruments.find((i) => i.base?.toUpperCase() === base && i.quote?.toUpperCase() === 'USDT') ??
      instruments.find((i) => i.base?.toUpperCase() === base);
    if (!match) throw new Error(`grvt: no instrument found for '${input}'.`);
    return match.instrument;
  },

  async fetchCandles(symbol: string, timeframe: string, count: number): Promise<Candle[]> {
    const raw = await runJson<GrvtCandle[]>([
      'market',
      'candles',
      symbol,
      '-i',
      timeframe,
      '--count',
      String(count),
      '-o',
      'json',
    ]);

    const candles: Candle[] = raw.map((c) => ({
      t: toMs(c.open_time),
      o: Number(c.open),
      h: Number(c.high),
      l: Number(c.low),
      c: Number(c.close),
      v: Number(c.volume_b),
    }));

    candles.sort((a, b) => a.t - b.t);
    return candles;
  },
};
