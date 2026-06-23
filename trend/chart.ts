/**
 * PNG chart renderer for the trend tool.
 *
 * Draws a candlestick price panel (with EMA20/50/100 overlays) and a MACD
 * histogram panel into a single PNG using `@napi-rs/canvas`, then writes it to
 * disk. Indicator series are computed over the FULL candle array and sliced to
 * the shown window so the lines remain correct at the window edges.
 */

import { writeFile } from 'node:fs/promises';
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { Candle, Signal } from './types';
import { emaSeries, macdHistogramSeries } from './indicators';
import { signalLabel } from './signal';

/** Clean light theme palette. */
const THEME = {
  bg: '#ffffff',
  panelBg: '#fafafa',
  border: '#e2e2e6',
  grid: '#ececf0',
  text: '#1b1b1f',
  textMuted: '#6b6b73',
  up: '#16a34a',
  down: '#dc2626',
  ema20: '#2563eb',
  ema50: '#d97706',
  ema100: '#7c3aed',
  zeroLine: '#9ca3af',
} as const;

/** Badge background colors keyed by signal. */
function badgeColor(signal: Signal): string {
  return signal === 1 ? THEME.up : signal === -1 ? THEME.down : '#6b7280';
}

/** Nicely formatted price label (adapts decimals to magnitude). */
function fmtPrice(v: number): string {
  const abs = Math.abs(v);
  const decimals = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Compact HH:MM (or MM-DD for coarse timeframes) time label from epoch ms. */
function fmtTime(t: number): string {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (hh === '00' && mm === '00') {
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${mo}-${day}`;
  }
  return `${hh}:${mm}`;
}

/**
 * Render the trend chart to `outPath` and return it. Draws the last `bars`
 * (default 120) candles with EMA overlays and a MACD histogram panel.
 */
export async function renderChart(opts: {
  candles: Candle[];
  exchange: string;
  symbol: string;
  timeframe: string;
  signal: Signal;
  reason: string;
  outPath: string;
  bars?: number;
  name?: string;
}): Promise<string> {
  const { candles, exchange, symbol, timeframe, signal, reason, outPath, name } = opts;
  const bars = opts.bars ?? 120;

  const W = 1000;
  const H = 700;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d') as SKRSContext2D;

  // Background.
  ctx.fillStyle = THEME.bg;
  ctx.fillRect(0, 0, W, H);

  // ---- Layout regions ----
  const titleH = 56;
  const pad = { left: 16, right: 78, top: 8, bottom: 28 };
  const plotW = W - pad.left - pad.right;
  const contentTop = titleH;
  const contentH = H - contentTop;
  const priceH = Math.round(contentH * 0.7);
  const macdH = contentH - priceH;

  const priceTop = contentTop + pad.top;
  const priceBottom = contentTop + priceH - pad.bottom;
  const pricePlotH = priceBottom - priceTop;

  const macdRegionTop = contentTop + priceH;
  const macdTop = macdRegionTop + pad.top;
  const macdBottom = H - pad.bottom;
  const macdPlotH = macdBottom - macdTop;

  // ---- Full-series indicators, then slice to window ----
  const closes = candles.map((c) => c.c);
  const e20Full = emaSeries(closes, 20);
  const e50Full = emaSeries(closes, 50);
  const e100Full = emaSeries(closes, 100);
  const macdFull = macdHistogramSeries(closes);

  const start = Math.max(0, candles.length - bars);
  const shown = candles.slice(start);
  const e20 = e20Full.slice(start);
  const e50 = e50Full.slice(start);
  const e100 = e100Full.slice(start);
  const macd = macdFull.slice(start);
  const n = shown.length;

  // ---- Title bar ----
  drawTitleBar(ctx, W, titleH, exchange, symbol, timeframe, signal, reason, name);

  if (n === 0) {
    ctx.fillStyle = THEME.textMuted;
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('no data', W / 2, H / 2);
    const empty = await canvas.encode('png');
    await writeFile(outPath, empty);
    return outPath;
  }

  // ---- Price panel background + price scale ----
  ctx.fillStyle = THEME.panelBg;
  ctx.fillRect(pad.left, priceTop, plotW, pricePlotH);

  let priceMin = Infinity;
  let priceMax = -Infinity;
  for (const c of shown) {
    if (c.l < priceMin) priceMin = c.l;
    if (c.h > priceMax) priceMax = c.h;
  }
  // Include EMA overlays in the range so lines aren't clipped.
  for (const series of [e20, e50, e100]) {
    for (const v of series) {
      if (Number.isNaN(v)) continue;
      if (v < priceMin) priceMin = v;
      if (v > priceMax) priceMax = v;
    }
  }
  if (!Number.isFinite(priceMin) || !Number.isFinite(priceMax)) {
    priceMin = 0;
    priceMax = 1;
  }
  const priceRange = priceMax - priceMin || 1;
  const padFrac = 0.04;
  priceMin -= priceRange * padFrac;
  priceMax += priceRange * padFrac;

  const priceY = (p: number): number =>
    priceBottom - ((p - priceMin) / (priceMax - priceMin)) * pricePlotH;

  // Horizontal price gridlines + right-side labels.
  ctx.strokeStyle = THEME.grid;
  ctx.lineWidth = 1;
  ctx.fillStyle = THEME.textMuted;
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const priceTicks = 5;
  for (let i = 0; i <= priceTicks; i++) {
    const p = priceMin + ((priceMax - priceMin) * i) / priceTicks;
    const y = priceY(p);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.fillText(fmtPrice(p), pad.left + plotW + 6, y);
  }

  // Vertical time gridlines (shared with MACD region) + labels.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const slotW = plotW / n;
  const timeTicks = Math.min(6, n);
  for (let i = 0; i < timeTicks; i++) {
    const idx = Math.round(((n - 1) * i) / Math.max(1, timeTicks - 1));
    const x = pad.left + slotW * (idx + 0.5);
    ctx.strokeStyle = THEME.grid;
    ctx.beginPath();
    ctx.moveTo(x, priceTop);
    ctx.lineTo(x, macdBottom);
    ctx.stroke();
    ctx.fillStyle = THEME.textMuted;
    ctx.fillText(fmtTime(shown[idx].t), x, macdBottom + 6);
  }

  // ---- Candlesticks ----
  const bodyW = Math.max(1, Math.min(slotW * 0.7, 14));
  for (let i = 0; i < n; i++) {
    const c = shown[i];
    const x = pad.left + slotW * (i + 0.5);
    const up = c.c >= c.o;
    const color = up ? THEME.up : THEME.down;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    // Wick.
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, priceY(c.h));
    ctx.lineTo(x, priceY(c.l));
    ctx.stroke();

    // Body.
    const yo = priceY(c.o);
    const yc = priceY(c.c);
    const top = Math.min(yo, yc);
    const bh = Math.max(1, Math.abs(yc - yo));
    ctx.fillRect(x - bodyW / 2, top, bodyW, bh);
  }

  // ---- EMA overlays ----
  drawPolyline(ctx, e20, (i) => pad.left + slotW * (i + 0.5), priceY, THEME.ema20);
  drawPolyline(ctx, e50, (i) => pad.left + slotW * (i + 0.5), priceY, THEME.ema50);
  drawPolyline(ctx, e100, (i) => pad.left + slotW * (i + 0.5), priceY, THEME.ema100);

  // Legend (top-left of price panel).
  drawLegend(ctx, pad.left + 8, priceTop + 8, [
    { label: 'EMA20', color: THEME.ema20 },
    { label: 'EMA50', color: THEME.ema50 },
    { label: 'EMA100', color: THEME.ema100 },
  ]);

  // Price panel border.
  ctx.strokeStyle = THEME.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(pad.left, priceTop, plotW, pricePlotH);

  // ---- MACD panel ----
  ctx.fillStyle = THEME.panelBg;
  ctx.fillRect(pad.left, macdTop, plotW, macdPlotH);

  let macdAbsMax = 0;
  for (const v of macd) {
    if (Number.isNaN(v)) continue;
    const a = Math.abs(v);
    if (a > macdAbsMax) macdAbsMax = a;
  }
  if (macdAbsMax === 0) macdAbsMax = 1;
  macdAbsMax *= 1.1;

  const macdMidY = macdTop + macdPlotH / 2;
  const macdY = (v: number): number => macdMidY - (v / macdAbsMax) * (macdPlotH / 2);

  // Histogram bars.
  const histW = Math.max(1, Math.min(slotW * 0.7, 14));
  for (let i = 0; i < n; i++) {
    const v = macd[i];
    if (Number.isNaN(v)) continue;
    const x = pad.left + slotW * (i + 0.5);
    ctx.fillStyle = v >= 0 ? THEME.up : THEME.down;
    const y = macdY(v);
    const h = Math.max(1, Math.abs(macdMidY - y));
    ctx.fillRect(x - histW / 2, Math.min(y, macdMidY), histW, h);
  }

  // Zero line.
  ctx.strokeStyle = THEME.zeroLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, macdMidY);
  ctx.lineTo(pad.left + plotW, macdMidY);
  ctx.stroke();

  // MACD label + scale.
  ctx.fillStyle = THEME.textMuted;
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('0', pad.left + plotW + 6, macdMidY);
  ctx.textBaseline = 'top';
  ctx.fillStyle = THEME.text;
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText('MACD histogram', pad.left + 8, macdTop + 6);

  // MACD panel border.
  ctx.strokeStyle = THEME.border;
  ctx.strokeRect(pad.left, macdTop, plotW, macdPlotH);

  // ---- Encode + write ----
  const png = await canvas.encode('png');
  await writeFile(outPath, png);
  return outPath;
}

/** Draw the top title bar with exchange/symbol/timeframe and a colored signal badge. */
function drawTitleBar(
  ctx: SKRSContext2D,
  W: number,
  titleH: number,
  exchange: string,
  symbol: string,
  timeframe: string,
  signal: Signal,
  reason: string,
  name?: string,
): void {
  ctx.fillStyle = THEME.bg;
  ctx.fillRect(0, 0, W, titleH);
  ctx.strokeStyle = THEME.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, titleH);
  ctx.lineTo(W, titleH);
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = THEME.text;
  ctx.font = 'bold 18px sans-serif';
  const nameLabel = name ? `${name} (${symbol})` : symbol;
  const title = `${exchange} ${nameLabel} · ${timeframe}`;
  ctx.fillText(title, 16, 26);

  ctx.fillStyle = THEME.textMuted;
  ctx.font = '12px sans-serif';
  ctx.fillText(reason, 16, 46);

  // Signal badge (right-aligned).
  const label = signalLabel(signal);
  ctx.font = 'bold 14px sans-serif';
  const textW = ctx.measureText(label).width;
  const bw = textW + 24;
  const bh = 26;
  const bx = W - 16 - bw;
  const by = (titleH - bh) / 2;
  ctx.fillStyle = badgeColor(signal);
  roundRect(ctx, bx, by, bw, bh, 6);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, bx + bw / 2, by + bh / 2 + 1);
}

/** Draw a NaN-aware polyline; breaks the path across undefined gaps. */
function drawPolyline(
  ctx: SKRSContext2D,
  series: number[],
  xOf: (i: number) => number,
  yOf: (v: number) => number,
  color: string,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (Number.isNaN(v)) {
      started = false;
      continue;
    }
    const x = xOf(i);
    const y = yOf(v);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
}

/** Draw a horizontal legend of swatch+label entries starting at (x, y). */
function drawLegend(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  items: { label: string; color: string }[],
): void {
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let cx = x;
  const cy = y + 7;
  for (const it of items) {
    ctx.fillStyle = it.color;
    ctx.fillRect(cx, cy - 5, 14, 3);
    cx += 18;
    ctx.fillStyle = THEME.text;
    ctx.fillText(it.label, cx, cy);
    cx += ctx.measureText(it.label).width + 16;
  }
}

/** Trace a rounded-rectangle path (caller fills/strokes). */
function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
