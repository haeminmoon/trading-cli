import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Adapter, Candle } from '../types';

const execFileAsync = promisify(execFile);

/**
 * The toss-cli bin, resolved from the repo root (this file sits at
 * <repo>/trend/adapters/toss.ts, so the root is three levels up). cwd is pinned
 * to the repo root so the CLI picks up the same config/credentials as a manual run.
 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const TOSS_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'toss-cli');

/** Generous output cap — a 300-bar daily series is small JSON, but paginated fetches grow. */
const MAX_BUFFER = 32 * 1024 * 1024;

/** Run toss-cli with JSON output and parse stdout. */
async function tossJson(args: string[]): Promise<unknown> {
  const { stdout } = await execFileAsync(TOSS_BIN, args, {
    cwd: REPO_ROOT,
    maxBuffer: MAX_BUFFER,
  });
  return JSON.parse(stdout);
}

/** Toss candle interval per trend timeframe (only 1d is exposed for trend). */
const INTERVAL: Record<string, string> = {
  '1d': '1d',
};

/** RECON candle shape from `toss-cli market candles ... -o json`; values are strings. */
interface TossCandle {
  timestamp: string; // ISO 8601, e.g. "2026-06-23T00:00:00.000+09:00"
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  volume: string;
}

/** `market candles` returns either { candles, nextBefore } or a bare array. */
function extractCandles(payload: unknown): TossCandle[] {
  if (Array.isArray(payload)) return payload as TossCandle[];
  if (payload && typeof payload === 'object' && Array.isArray((payload as { candles?: unknown }).candles)) {
    return (payload as { candles: TossCandle[] }).candles;
  }
  throw new Error('toss-cli market candles: unexpected JSON shape (no candle array).');
}

/** One master record from `toss-cli stock info <symbols> -o json` (an array). */
interface TossStockInfo {
  symbol: string;
  name?: string;
  status?: string;
}

/** Cache stock-master lookups so resolveSymbol + nameFor share a single CLI call per key. */
const infoCache = new Map<string, TossStockInfo | null>();
async function stockInfo(query: string): Promise<TossStockInfo | null> {
  const key = query.trim().toUpperCase();
  if (infoCache.has(key)) return infoCache.get(key)!;
  let result: TossStockInfo | null = null;
  try {
    const payload = await tossJson(['stock', 'info', key, '-o', 'json']);
    const rows = Array.isArray(payload) ? (payload as TossStockInfo[]) : [];
    result = rows.find((r) => r?.symbol?.toUpperCase() === key) ?? rows[0] ?? null;
  } catch {
    result = null; // best-effort
  }
  infoCache.set(key, result);
  return result;
}

export const adapter: Adapter = {
  name: 'toss',
  timeframes: ['1d'],

  /**
   * Input is a KR code or US ticker (e.g. '005930', 'AAPL') — used as-is, just
   * uppercased/trimmed. We validate it against the stock master and return the
   * exchange's canonical symbol; if the lookup fails we fall back to the raw input.
   */
  async resolveSymbol(input: string): Promise<string> {
    const sym = input.trim().toUpperCase();
    if (!sym) throw new Error('toss resolveSymbol: empty input.');
    return (await stockInfo(sym))?.symbol ?? sym;
  },

  async nameFor(symbol: string): Promise<string | undefined> {
    return (await stockInfo(symbol))?.name;
  },

  async fetchCandles(symbol: string, timeframe: string, count: number): Promise<Candle[]> {
    const interval = INTERVAL[timeframe];
    if (!interval) {
      throw new Error(
        `toss: unsupported timeframe '${timeframe}' (supported: ${adapter.timeframes.join(', ')}).`,
      );
    }

    const payload = await tossJson([
      'market',
      'candles',
      symbol,
      '-i',
      interval,
      '-n',
      String(count),
      '--paginate',
      '-o',
      'json',
    ]);

    const raw = extractCandles(payload);
    const candles: Candle[] = raw.map((k) => ({
      t: Date.parse(k.timestamp), // ISO 8601 → epoch ms
      o: Number(k.openPrice),
      h: Number(k.highPrice),
      l: Number(k.lowPrice),
      c: Number(k.closePrice),
      v: Number(k.volume),
    }));

    // The CLI's ordering is not guaranteed (single requests come back newest-first);
    // normalize to ascending-by-open-time as the indicator layer expects.
    candles.sort((a, b) => a.t - b.t);
    return candles;
  },
};
