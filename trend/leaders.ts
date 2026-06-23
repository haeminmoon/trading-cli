/**
 * 주도주/대장주 스캐너 — find trend-following market leaders.
 *
 *   npm run trend:leaders -- <exchange> [--top 60] [--show 20] [--count 252]
 *       [--symbols a,b,c] [--concurrency N] [--image] [--out dir] [--json]
 *
 * Balanced 0–100 leader score = mean of: relative-strength %ile, trend quality,
 * 52-bar-high proximity, liquidity %ile, and (KR only) 수급(외인·기관 순매수).
 * Universe: kiwoom → 거래대금 상위; exchanges with listSymbols (grvt) → all;
 * otherwise an explicit --symbols list.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Adapter, Candle } from './types';
import { computeIndicators } from './indicators';
import { rsRaw, trendQuality, highProximity, liquidityRaw, percentileRanks } from './score';
import { renderChart } from './chart';
import { evaluateSignal } from './signal';

import { adapter as hyperliquid } from './adapters/hyperliquid';
import { adapter as backpack } from './adapters/backpack';
import { adapter as grvt } from './adapters/grvt';
import { adapter as pacifica } from './adapters/pacifica';
import { adapter as kiwoom } from './adapters/kiwoom';
import { adapter as toss } from './adapters/toss';

const ADAPTERS: Record<string, Adapter> = { hyperliquid, backpack, grvt, pacifica, kiwoom, toss };

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
async function cliJson(bin: string, args: string[]): Promise<unknown> {
  const { stdout } = await execFileAsync(join(REPO_ROOT, 'node_modules', '.bin', bin), args, {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function arg(argv: string[], name: string, def?: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
}
function num(v: unknown): number {
  return Number(String(v ?? '').replace(/[, +]/g, '')) || 0;
}
/** Normalize a kiwoom code: drop a board suffix ('_AL') and a leading 'A' → bare 6-char code. */
function normCode(code: string): string {
  return String(code).replace(/_[A-Za-z]+$/, '').replace(/^A(?=\d{6})/, '');
}

/** KR ETF/ETN brand prefixes — excluded from leader scans by default (주도주 = 개별주). */
const ETF_RE = /^(KODEX|TIGER|KBSTAR|ARIRANG|HANARO|KOSEF|PLUS|SOL|ACE|RISE|TIMEFOLIO|히어로즈|마이티|FOCUS|BNK|파워|KIWOOM|WON|KCGI|마이다스|TREX|UNICORN)\b/i;
function isEtf(name?: string): boolean {
  return !!name && ETF_RE.test(name.trim());
}

interface UnivItem {
  symbol: string;
  name?: string;
}

/** Build the candidate universe for an exchange. */
async function buildUniverse(
  exchange: string,
  adapter: Adapter,
  explicit: string[] | null,
  top: number,
  includeEtf: boolean,
): Promise<UnivItem[]> {
  if (explicit) return explicit.map((s) => ({ symbol: s }));
  if (exchange === 'kiwoom') {
    const payload = (await cliJson('kiwoom-cli', ['ranking', 'amount', '-m', '000', '-x', '3', '-o', 'json'])) as Record<string, unknown>;
    const list = (payload.trde_prica_upper as Record<string, string>[]) ?? [];
    return list
      .filter((r) => includeEtf || !isEtf(r.stk_nm))
      .slice(0, top)
      .map((r) => ({ symbol: normCode(r.stk_cd), name: r.stk_nm }));
  }
  if (adapter.listSymbols) {
    const all = await adapter.listSymbols();
    return all.slice(0, top).map((s) => ({ symbol: s }));
  }
  throw new Error(`No universe for "${exchange}" — pass --symbols a,b,c (no listSymbols / 거래대금 source).`);
}

/** KR 수급: codes that appear in foreign and/or institution net-buy tops. */
async function kiwoomSupply(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const r = (await cliJson('kiwoom-cli', ['ranking', 'net-buy', '-b', 'both', '-n', '50', '-q', '1', '-o', 'json'])) as {
      foreign?: { code: string }[];
      institution?: { code: string }[];
    };
    for (const x of r.foreign ?? []) map.set(normCode(x.code), (map.get(normCode(x.code)) ?? 0) + 1);
    for (const x of r.institution ?? []) map.set(normCode(x.code), (map.get(normCode(x.code)) ?? 0) + 1);
  } catch {
    /* best-effort */
  }
  return map;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (idx < items.length) {
        const i = idx++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

interface Metric {
  symbol: string;
  name?: string;
  close: number;
  rsRaw: number;
  trendQ: number; // 0..1
  highProx: number; // 0..1
  liqRaw: number;
  supply: number; // 0,50,100 (KR) or NaN (omit)
  candles: Candle[];
  reason: string;
  signalNum: number;
}

function round(n: number): number {
  if (!Number.isFinite(n)) return n;
  const abs = Math.abs(n);
  return Number(n.toFixed(abs >= 1000 ? 1 : abs >= 1 ? 2 : 4));
}

async function main() {
  const argv = process.argv.slice(2);
  const exchange = (argv.find((a) => !a.startsWith('--')) ?? '').toLowerCase();
  const adapter = ADAPTERS[exchange];
  if (!adapter) {
    console.error(`Usage: npm run trend:leaders -- <exchange> [--top 60] [--show 20] [--image] [--json]\n` +
      `Exchanges: ${Object.keys(ADAPTERS).join(', ')}`);
    process.exit(1);
  }
  const tf = '1d';
  const top = parseInt(arg(argv, '--top', exchange === 'kiwoom' ? '60' : '200')!, 10) || 60;
  const show = parseInt(arg(argv, '--show', '20')!, 10) || 20;
  const count = Math.max(150, parseInt(arg(argv, '--count', '252')!, 10) || 252);
  const concurrency = Math.max(1, parseInt(arg(argv, '--concurrency', exchange === 'kiwoom' ? '4' : '8')!, 10) || 4);
  const symbolsArg = arg(argv, '--symbols');
  const explicit = symbolsArg ? symbolsArg.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const json = argv.includes('--json');
  const image = argv.includes('--image');
  const includeEtf = argv.includes('--include-etf');
  const outDir = arg(argv, '--out', 'trend/out')!;
  const isKR = exchange === 'kiwoom' || exchange === 'toss';

  const universe = await buildUniverse(exchange, adapter, explicit, top, includeEtf);
  const supply = exchange === 'kiwoom' ? await kiwoomSupply() : new Map<string, number>();
  if (!json) console.error(`Ranking ${universe.length} ${exchange} candidates by leadership (RS·추세·신고가·유동성${isKR ? '·수급' : ''})…`);

  let skipped = 0;
  const metrics = (
    await mapPool(universe, concurrency, async (u): Promise<Metric | null> => {
      try {
        const symbol = explicit ? await adapter.resolveSymbol(u.symbol) : u.symbol;
        const name = u.name ?? (adapter.nameFor ? await adapter.nameFor(symbol).catch(() => undefined) : undefined);
        const candles = await adapter.fetchCandles(symbol, tf, count);
        const closes = candles.map((c) => c.c);
        const ind = computeIndicators(candles);
        const supplyHits = supply.get(normCode(symbol)) ?? 0;
        return {
          symbol, name, close: closes[closes.length - 1],
          rsRaw: rsRaw(closes), trendQ: trendQuality(ind, closes[closes.length - 1]),
          highProx: highProximity(candles), liqRaw: liquidityRaw(candles),
          supply: exchange === 'kiwoom' ? supplyHits * 50 : NaN,
          candles, reason: evaluateSignal(ind).reason, signalNum: evaluateSignal(ind).signal,
        };
      } catch {
        skipped++;
        return null;
      }
    })
  ).filter((m): m is Metric => m !== null);

  // Percentile-rank the relative components across the scanned set.
  const rsPct = percentileRanks(metrics.map((m) => m.rsRaw));
  const liqPct = percentileRanks(metrics.map((m) => m.liqRaw));
  const scored = metrics.map((m, i) => {
    const parts = [rsPct[i], m.trendQ * 100, m.highProx * 100, liqPct[i]];
    if (Number.isFinite(m.supply)) parts.push(m.supply);
    const score = parts.reduce((a, b) => a + b, 0) / parts.length;
    return { ...m, rsPct: rsPct[i], liqPct: liqPct[i], score, imagePath: undefined as string | undefined };
  });
  scored.sort((a, b) => b.score - a.score);
  const shown = scored.slice(0, show);

  if (image) {
    mkdirSync(resolve(outDir), { recursive: true });
    for (const r of shown) {
      const outPath = resolve(outDir, `${exchange}-${r.symbol.replace(/[^A-Za-z0-9._-]/g, '_')}-leader.png`);
      r.imagePath = await renderChart({ candles: r.candles, exchange, symbol: r.symbol, timeframe: tf, signal: r.signalNum as -1 | 0 | 1, reason: r.reason, outPath, name: r.name });
    }
  }

  if (json) {
    console.log(JSON.stringify({
      exchange, scanned: scored.length, skipped,
      leaders: shown.map((r) => ({
        symbol: r.symbol, name: r.name, score: round(r.score), rsPct: round(r.rsPct),
        trendQuality: round(r.trendQ * 100), highProximity: round(r.highProx * 100),
        liqPct: round(r.liqPct), supply: Number.isFinite(r.supply) ? r.supply : null, close: r.close,
        imagePath: r.imagePath,
      })),
    }, null, 2));
    return;
  }

  const hasNames = shown.some((r) => r.name);
  console.log(`\n🏆 ${exchange} 주도주 랭킹 (1d, 후보 ${scored.length}개)  상위 ${shown.length}\n`);
  console.table(
    shown.map((r, i) => {
      const row: Record<string, unknown> = { '#': i + 1, symbol: r.symbol };
      if (hasNames) row['종목'] = r.name ?? '-';
      row['점수'] = round(r.score);
      row['RS%'] = round(r.rsPct);
      row['추세'] = round(r.trendQ * 100);
      row['신고가%'] = round(r.highProx * 100);
      row['유동성%'] = round(r.liqPct);
      if (isKR) row['수급'] = r.supply >= 100 ? '외인+기관' : r.supply >= 50 ? '한쪽' : '-';
      row['close'] = r.close;
      return row;
    }),
  );
  if (image) {
    console.log('');
    for (const r of shown) if (r.imagePath) console.log(`  🖼  ${r.name ?? r.symbol} (${r.symbol}): ${r.imagePath}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
