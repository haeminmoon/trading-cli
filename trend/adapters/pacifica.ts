import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Adapter, Candle } from '../types';

const execFileAsync = promisify(execFile);

/** Repo root = two levels up from trend/adapters/. CLIs run with cwd = repo root. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'pacifica-cli');

/** Raw candle as emitted by `pacifica-cli market candles ... -o json`. Values are strings. */
interface PacificaCandle {
  time: string | number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/**
 * Normalize a Pacifica `time` field to epoch ms. The CLI emits an ISO string
 * (e.g. "2026-06-23T00:00:00.000Z"); be tolerant of numeric s / ms / ns too.
 */
function toMillis(time: string | number): number {
  if (typeof time === 'string' && !/^\d+$/.test(time.trim())) return Date.parse(time);
  const n = Number(time);
  if (n > 1e17) return n / 1e6; // nanoseconds
  if (n < 1e11) return n * 1000; // seconds
  return n; // milliseconds
}

export const adapter: Adapter = {
  name: 'pacifica',
  timeframes: ['1h', '4h', '8h', '1d'],

  /** Pacifica symbols are bare coins (e.g. BTC); just uppercase the user input. */
  async resolveSymbol(input: string): Promise<string> {
    return input.trim().toUpperCase();
  },

  async fetchCandles(symbol: string, timeframe: string, count: number): Promise<Candle[]> {
    const { stdout } = await execFileAsync(
      BIN,
      ['market', 'candles', symbol, '-i', timeframe, '--count', String(count), '-o', 'json'],
      { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 },
    );

    const raw = JSON.parse(stdout) as PacificaCandle[];
    const candles: Candle[] = raw.map((r) => ({
      t: toMillis(r.time),
      o: Number(r.open),
      h: Number(r.high),
      l: Number(r.low),
      c: Number(r.close),
      v: Number(r.volume),
    }));

    candles.sort((a, b) => a.t - b.t);
    return candles;
  },
};
