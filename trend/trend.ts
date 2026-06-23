/**
 * Trend analysis runner.
 *
 *   npm run trend -- <exchange> <symbol|name> [--tf 1h,4h,8h,1d] [--count 300]
 *                    [--image] [--out trend/out] [--json]
 *
 * Fetches candles for each timeframe via that exchange's CLI (through its
 * Adapter), computes indicators, evaluates the +1/−1/0 signal, prints a table
 * (and optional JSON), and optionally renders a PNG chart per timeframe.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Adapter, TimeframeResult } from './types';
import { computeIndicators, MIN_BARS } from './indicators';
import { evaluateSignal, signalLabel } from './signal';
import { renderChart } from './chart';

import { adapter as hyperliquid } from './adapters/hyperliquid';
import { adapter as backpack } from './adapters/backpack';
import { adapter as grvt } from './adapters/grvt';
import { adapter as pacifica } from './adapters/pacifica';
import { adapter as kiwoom } from './adapters/kiwoom';
import { adapter as toss } from './adapters/toss';

const ADAPTERS: Record<string, Adapter> = { hyperliquid, backpack, grvt, pacifica, kiwoom, toss };

interface Args {
  exchange: string;
  symbol: string;
  tf?: string[];
  count: number;
  image: boolean;
  out: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const a: Partial<Args> = { count: 300, image: false, out: 'trend/out', json: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--tf') a.tf = argv[++i]?.split(',').map((s) => s.trim()).filter(Boolean);
    else if (t === '--count') a.count = Math.max(MIN_BARS, parseInt(argv[++i], 10) || 300);
    else if (t === '--image' || t === '-i') a.image = true;
    else if (t === '--out') a.out = argv[++i];
    else if (t === '--json') a.json = true;
    else positional.push(t);
  }
  if (positional.length < 2) {
    throw new Error(
      `Usage: npm run trend -- <exchange> <symbol> [--tf 1h,4h,8h,1d] [--count 300] [--image] [--json]\n` +
        `Exchanges: ${Object.keys(ADAPTERS).join(', ')}`,
    );
  }
  return { exchange: positional[0], symbol: positional[1], ...a } as Args;
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

async function analyzeTimeframe(
  adapter: Adapter,
  symbol: string,
  tf: string,
  count: number,
): Promise<TimeframeResult> {
  const candles = await adapter.fetchCandles(symbol, tf, count);
  const indicators = computeIndicators(candles);
  const { signal, reason } = evaluateSignal(indicators);
  return {
    timeframe: tf,
    bars: candles.length,
    lastClose: candles[candles.length - 1].c,
    indicators,
    signal,
    reason,
    _candles: candles,
  } as TimeframeResult & { _candles: typeof candles };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const adapter = ADAPTERS[args.exchange.toLowerCase()];
  if (!adapter) {
    console.error(`Unknown exchange "${args.exchange}". Choose: ${Object.keys(ADAPTERS).join(', ')}`);
    process.exit(1);
  }

  const symbol = await adapter.resolveSymbol(args.symbol);
  const name = adapter.nameFor ? await adapter.nameFor(symbol).catch(() => undefined) : undefined;
  const timeframes = args.tf ?? [...adapter.timeframes];

  const results: TimeframeResult[] = [];
  const errors: { timeframe: string; error: string }[] = [];
  for (const tf of timeframes) {
    try {
      const r = await analyzeTimeframe(adapter, symbol, tf, args.count);
      if (args.image) {
        mkdirSync(resolve(args.out), { recursive: true });
        const outPath = resolve(args.out, `${args.exchange}-${sanitize(symbol)}-${tf}.png`);
        r.imagePath = await renderChart({
          candles: (r as TimeframeResult & { _candles: import('./types').Candle[] })._candles,
          exchange: args.exchange,
          symbol,
          timeframe: tf,
          signal: r.signal,
          reason: r.reason,
          outPath,
          name,
        });
      }
      delete (r as { _candles?: unknown })._candles;
      results.push(r);
    } catch (e) {
      errors.push({ timeframe: tf, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const net = results.reduce((s, r) => s + r.signal, 0);
  const bias = net > 0 ? 'LONG 우위' : net < 0 ? 'SHORT 우위' : '혼조/관망';

  if (args.json) {
    console.log(JSON.stringify({ exchange: args.exchange, symbol, name, results, errors, net, bias }, null, 2));
    return;
  }

  console.log(`\n📈 ${args.exchange} ${name ? `${name} (${symbol})` : symbol} — 추세 판단 (EMA20/50/100 + MACD)\n`);
  console.table(
    results.map((r) => ({
      TF: r.timeframe,
      signal: signalLabel(r.signal),
      close: r.lastClose,
      EMA20: round(r.indicators.ema20),
      EMA50: round(r.indicators.ema50),
      EMA100: round(r.indicators.ema100),
      MACDhist: round(r.indicators.macdHist),
      ATR: round(r.indicators.atr),
      'EMA100기울기': round(r.indicators.ema100Slope),
      bars: r.bars,
    })),
  );
  for (const e of errors) console.log(`  ⚠️  ${e.timeframe}: ${e.error}`);
  console.log(`\n종합: ${bias}  (신호 합계 ${net >= 0 ? '+' : ''}${net} / ${results.length}개 타임프레임)`);
  if (args.image) for (const r of results) console.log(`  🖼  ${r.timeframe}: ${r.imagePath}`);
}

function round(n: number): number {
  if (!Number.isFinite(n)) return n;
  const abs = Math.abs(n);
  const d = abs >= 1000 ? 1 : abs >= 1 ? 2 : 6;
  return Number(n.toFixed(d));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
