/**
 * Kiwoom Securities (키움증권) adapter — KR stocks.
 *
 * Shells out to the installed `kiwoom-cli` bin and normalizes its raw TR
 * payloads to `Candle[]`. The CLI emits zero-padded string OHLCV values; minute
 * prices additionally carry a +/- change-direction sign. We strip the sign and
 * leading zeros and take the absolute value before `Number()`.
 *
 * Timeframes (no intraday 4h/8h on Kiwoom):
 *   '1h' → `chart min <code> -i 60 -n <count>`  (60-minute bars, list key stk_min_pole_chart_qry, time cntr_tm)
 *   '1d' → `chart day  <code> -n <count>`        (daily,  list key stk_dt_pole_chart_qry,  date dt)
 *   '1w' → `chart week <code> -n <count>`        (weekly, list key stk_stk_pole_chart_qry, date dt)
 *
 * In every list a bar's close is `cur_prc`, open `open_pric`, high `high_pric`,
 * low `low_pric`, volume `trde_qty`. Times are KST (Asia/Seoul, UTC+9).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import type { Adapter, Candle } from '../types';

const execFileAsync = promisify(execFile);

/** Repo root = two levels up from trend/adapters/. CLIs are run with cwd = root. */
const REPO_ROOT = join(import.meta.dirname, '..', '..');
const KIWOOM_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'kiwoom-cli');

/** KST offset (UTC+9) in ms; Kiwoom date/time fields are wall-clock Seoul time. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Per-request hard caps from `kiwoom-cli chart --help`; the CLI auto-paginates beyond. */
const MAX_BUFFER = 64 * 1024 * 1024;

interface ChartConfig {
  /** `chart` subcommand to invoke. */
  cmd: string;
  /** Extra args (e.g. interval for minute bars). */
  extra: string[];
  /** Key in the TR payload holding the candle list. */
  listKey: string;
  /** Field holding the bar's timestamp (date yyyymmdd or datetime yyyymmddHHMMSS). */
  timeKey: 'dt' | 'cntr_tm';
}

const TIMEFRAME_CONFIG: Record<string, ChartConfig> = {
  '1h': { cmd: 'min', extra: ['-i', '60'], listKey: 'stk_min_pole_chart_qry', timeKey: 'cntr_tm' },
  '1d': { cmd: 'day', extra: [], listKey: 'stk_dt_pole_chart_qry', timeKey: 'dt' },
  '1w': { cmd: 'week', extra: [], listKey: 'stk_stk_pole_chart_qry', timeKey: 'dt' },
};

/** Run the kiwoom CLI and return parsed stdout, or throw on non-JSON / error output. */
async function runKiwoom(args: string[]): Promise<unknown> {
  const { stdout } = await execFileAsync(KIWOOM_BIN, args, {
    cwd: REPO_ROOT,
    maxBuffer: MAX_BUFFER,
  });
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`kiwoom-cli ${args.join(' ')}: non-JSON output: ${text.slice(0, 200)}`);
  }
}

/**
 * Parse a Kiwoom numeric string: zero-padded, possibly +/- prefixed. Returns the
 * absolute value as a Number (the sign only encodes change direction, not price).
 */
function num(raw: unknown): number {
  if (raw == null) return NaN;
  const s = String(raw).trim().replace(/^[+-]/, '');
  return Math.abs(Number(s));
}

/** Build epoch ms from a KST date (yyyymmdd) or datetime (yyyymmddHHMMSS) string. */
function toMs(raw: string): number {
  const s = raw.trim();
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const h = s.length >= 10 ? Number(s.slice(8, 10)) : 0;
  const mi = s.length >= 12 ? Number(s.slice(10, 12)) : 0;
  const se = s.length >= 14 ? Number(s.slice(12, 14)) : 0;
  // Treat components as wall-clock KST: build the UTC instant then subtract the offset.
  return Date.UTC(y, mo - 1, d, h, mi, se) - KST_OFFSET_MS;
}

const SEARCH_MARKETS = ['0', '10'] as const; // 0=KOSPI, 10=KOSDAQ

interface SearchHit {
  code: string;
  name: string;
}

/** Cache code → 종목명 so repeat lookups don't re-hit the CLI. */
const nameCache = new Map<string, string | undefined>();

/** KR ETF/ETN brand prefixes — excluded from the scan universe (주도주 = 개별주). */
const ETF_RE = /^(KODEX|TIGER|KBSTAR|ARIRANG|HANARO|KOSEF|PLUS|SOL|ACE|RISE|TIMEFOLIO|히어로즈|마이티|FOCUS|BNK|파워|KIWOOM|WON|KCGI|마이다스|TREX|UNICORN)\b/i;

export const adapter: Adapter = {
  name: 'kiwoom',
  timeframes: ['1h', '1d', '1w'],

  /** Universe = 거래대금 상위 (most-liquid), ETF/ETN excluded. Codes normalized to bare 6-char. */
  async listSymbols(): Promise<string[]> {
    const payload = (await runKiwoom(['ranking', 'amount', '-m', '000', '-x', '3', '-o', 'json'])) as Record<string, unknown>;
    const list = (payload?.trde_prica_upper as Record<string, string>[]) ?? [];
    return list
      .filter((r) => !ETF_RE.test((r.stk_nm || '').trim()))
      .map((r) => String(r.stk_cd).replace(/_[A-Za-z]+$/, '').replace(/^A(?=\d{6})/, ''))
      .filter(Boolean);
  },

  async resolveSymbol(input: string): Promise<string> {
    const trimmed = input.trim();
    // A bare 6-digit code is already an exchange symbol.
    if (/^\d{6}$/.test(trimmed)) return trimmed;

    // Otherwise treat it as a (Korean) name and search both markets, preferring
    // an exact name match, then the first hit.
    const hits: SearchHit[] = [];
    for (const market of SEARCH_MARKETS) {
      let parsed: unknown;
      try {
        parsed = await runKiwoom(['stock', 'search', trimmed, '-m', market, '-o', 'json']);
      } catch {
        continue; // "No matches" prints non-JSON → skip this market.
      }
      if (Array.isArray(parsed)) {
        for (const row of parsed as SearchHit[]) {
          if (row && typeof row.code === 'string' && typeof row.name === 'string') hits.push(row);
        }
      }
    }

    if (hits.length === 0) throw new Error(`kiwoom: no symbol found for "${input}".`);
    const exact = hits.find((h) => h.name === trimmed);
    return (exact ?? hits[0]).code;
  },

  async nameFor(symbol: string): Promise<string | undefined> {
    const key = symbol.trim();
    if (nameCache.has(key)) return nameCache.get(key);
    let name: string | undefined;
    try {
      const info = (await runKiwoom(['stock', 'info', key, '-o', 'json'])) as Record<string, unknown>;
      name = typeof info?.stk_nm === 'string' ? (info.stk_nm as string).trim() : undefined;
    } catch {
      name = undefined; // best-effort
    }
    nameCache.set(key, name);
    return name;
  },

  async fetchCandles(symbol: string, timeframe: string, count: number): Promise<Candle[]> {
    const cfg = TIMEFRAME_CONFIG[timeframe];
    if (!cfg) {
      throw new Error(
        `kiwoom: unsupported timeframe "${timeframe}" (have ${adapter.timeframes.join(', ')}).`,
      );
    }

    const args = [
      'chart',
      cfg.cmd,
      symbol,
      ...cfg.extra,
      '-n',
      String(count),
      '-o',
      'json',
    ];
    const payload = await runKiwoom(args);

    const list = (payload as Record<string, unknown>)?.[cfg.listKey];
    if (!Array.isArray(list)) {
      throw new Error(`kiwoom: missing list "${cfg.listKey}" for ${symbol} ${timeframe}.`);
    }

    const candles: Candle[] = [];
    for (const row of list as Record<string, unknown>[]) {
      const timeRaw = row[cfg.timeKey];
      if (typeof timeRaw !== 'string') continue;
      const t = toMs(timeRaw);
      const o = num(row.open_pric);
      const h = num(row.high_pric);
      const l = num(row.low_pric);
      const c = num(row.cur_prc);
      const v = num(row.trde_qty);
      if (![t, o, h, l, c, v].every(Number.isFinite)) continue;
      candles.push({ t, o, h, l, c, v });
    }

    // The TR returns newest-first; normalize to ascending by open time.
    candles.sort((a, b) => a.t - b.t);
    return candles;
  },
};
