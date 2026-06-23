/**
 * Bulk trend scan: judge every listed symbol on an exchange and list those in a
 * given trend (default: uptrend / +1 long).
 *
 *   npm run trend:scan -- <exchange> [--tf 4h] [--count 250]
 *                         [--filter long|short|all] [--concurrency 8] [--limit N] [--json]
 *
 * Requires the exchange adapter to implement listSymbols() (currently: grvt).
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Adapter, Candle, Indicators, Signal } from './types';
import { computeIndicators } from './indicators';
import { evaluateSignal, signalLabel } from './signal';
import { renderChart } from './chart';

import { adapter as hyperliquid } from './adapters/hyperliquid';
import { adapter as backpack } from './adapters/backpack';
import { adapter as grvt } from './adapters/grvt';
import { adapter as pacifica } from './adapters/pacifica';
import { adapter as kiwoom } from './adapters/kiwoom';
import { adapter as toss } from './adapters/toss';

const ADAPTERS: Record<string, Adapter> = { hyperliquid, backpack, grvt, pacifica, kiwoom, toss };

interface Row {
  symbol: string;
  name?: string;
  signal: Signal;
  reason: string;
  close: number;
  indicators: Indicators;
  candles: Candle[];
  imagePath?: string;
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function arg(argv: string[], name: string, def?: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
}

async function main() {
  const argv = process.argv.slice(2);
  const exchange = argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
  if (!exchange || !ADAPTERS[exchange.toLowerCase()]) {
    console.error(`Usage: npm run trend:scan -- <exchange> [--symbols a,b,c] [--tf 4h] [--filter long|short|all] [--json]\n` +
      `Full-list scan (listSymbols): ${Object.entries(ADAPTERS).filter(([, a]) => a.listSymbols).map(([k]) => k).join(', ') || '(none)'}. ` +
      `Any exchange works with an explicit --symbols list.`);
    process.exit(1);
  }
  const adapter = ADAPTERS[exchange.toLowerCase()];

  const tf = arg(argv, '--tf', '4h')!;
  const count = Math.max(120, parseInt(arg(argv, '--count', '250')!, 10) || 250);
  const filter = (arg(argv, '--filter', 'long') as 'long' | 'short' | 'all')!;
  const concurrency = Math.max(1, parseInt(arg(argv, '--concurrency', '8')!, 10) || 8);
  const limit = arg(argv, '--limit') ? parseInt(arg(argv, '--limit')!, 10) : undefined;
  const json = argv.includes('--json');
  const image = argv.includes('--image');
  const outDir = arg(argv, '--out', 'trend/out')!;
  const wantSignal: Signal | null = filter === 'long' ? 1 : filter === 'short' ? -1 : null;

  const symbolsArg = arg(argv, '--symbols');
  const explicit = symbolsArg ? symbolsArg.split(',').map((s) => s.trim()).filter(Boolean) : null;
  if (!explicit && !adapter.listSymbols) {
    console.error(`"${exchange}" has no symbol list — pass an explicit universe with --symbols a,b,c.`);
    process.exit(1);
  }
  let symbols = explicit ?? (await adapter.listSymbols!());
  if (limit) symbols = symbols.slice(0, limit);
  if (!json) console.error(`Scanning ${symbols.length} ${exchange} symbols on ${tf} (count=${count}, conc=${concurrency})…`);

  let skipped = 0;
  const results = await mapPool(symbols, concurrency, async (raw): Promise<Row | null> => {
    try {
      const symbol = explicit ? await adapter.resolveSymbol(raw) : raw;
      const name = adapter.nameFor ? await adapter.nameFor(symbol).catch(() => undefined) : undefined;
      const candles = await adapter.fetchCandles(symbol, tf, count);
      const indicators = computeIndicators(candles);
      const { signal, reason } = evaluateSignal(indicators);
      return { symbol, name, signal, reason, close: candles[candles.length - 1].c, indicators, candles };
    } catch {
      skipped++;
      return null;
    }
  });

  const rows = results.filter((r): r is Row => r !== null);
  const matched = wantSignal === null ? rows : rows.filter((r) => r.signal === wantSignal);
  // Strongest trend first: EMA20 distance above/below EMA100 (%), signed by direction.
  const strength = (r: Row) => ((r.indicators.ema20 - r.indicators.ema100) / r.indicators.ema100) * 100;
  matched.sort((a, b) => (wantSignal === -1 ? strength(a) - strength(b) : strength(b) - strength(a)));

  if (image) {
    mkdirSync(resolve(outDir), { recursive: true });
    for (const r of matched) {
      const outPath = resolve(outDir, `${exchange}-${sanitize(r.symbol)}-${tf}.png`);
      r.imagePath = await renderChart({
        candles: r.candles, exchange, symbol: r.symbol, timeframe: tf,
        signal: r.signal, reason: r.reason, outPath, name: r.name,
      });
    }
  }

  if (json) {
    console.log(JSON.stringify({
      exchange, tf, scanned: rows.length, skipped, filter,
      results: matched.map((r) => ({
        symbol: r.symbol, signal: r.signal, close: r.close,
        trendPct: Number(strength(r).toFixed(2)), macdHist: r.indicators.macdHist,
        atr: r.indicators.atr, ema100Slope: r.indicators.ema100Slope,
      })),
    }, null, 2));
    return;
  }

  const labelKo = filter === 'long' ? '상승추세' : filter === 'short' ? '하락추세' : '전체';
  console.log(`\n📈 ${exchange} — ${labelKo} 종목 (${tf} 기준)  ${matched.length}개 / 스캔 ${rows.length} (제외 ${skipped})\n`);
  console.table(
    matched.map((r, i) => ({
      '#': i + 1,
      symbol: r.symbol,
      종목: r.name ?? '-',
      signal: signalLabel(r.signal),
      close: round(r.close),
      EMA20: round(r.indicators.ema20),
      EMA50: round(r.indicators.ema50),
      EMA100: round(r.indicators.ema100),
      배열: r.indicators.ema20 > r.indicators.ema50 && r.indicators.ema50 > r.indicators.ema100
        ? '정배열' : r.indicators.ema20 < r.indicators.ema50 && r.indicators.ema50 < r.indicators.ema100
        ? '역배열' : '혼조',
      MACDhist: round(r.indicators.macdHist),
      '강도%': round(strength(r)),
    })),
  );
  if (image) {
    console.log('');
    for (const r of matched) if (r.imagePath) console.log(`  🖼  ${r.name ?? r.symbol} (${r.symbol}): ${r.imagePath}`);
  }
}

function round(n: number): number {
  if (!Number.isFinite(n)) return n;
  const abs = Math.abs(n);
  const d = abs >= 1000 ? 1 : abs >= 1 ? 2 : 4;
  return Number(n.toFixed(d));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
