// Vietnamese diacritics check for every bundled motion-graphic template.
//
//   npx tsx scripts/vi-font-check.mts [--out <dir>] [--only <id,id>] [--concurrency 3]
//
// For each template it renders one transparent full-resolution frame three
// times with the app's own Remotion serve bundle, with every text/string prop set
// to:
//   ZW    "​"                       (renders nothing; isolates text pixels)
//   VI    "Đức Ủy Ở Hoàng Gia Nguyễn"
//   ASCII "Duc Uy O Hoang Gia Nguyen"    (same string, accents removed)
// and derives, programmatically:
//   textPx / bbox      pixels that differ VI vs ZW  -> where the text is
//   viVsAscii          pixels that differ VI vs ASCII -> accents present at all?
//   extraTopPx         how far VI ink rises above the ASCII ink (stacked accents)
//   edge               VI / ASCII text touches the frame border (overflow)
// plus a static font check (families the template references vs Vietnamese
// coverage). It writes <out>/results.json, one crop PNG per template for
// visual review, and contact sheets (<out>/sheets/*.png). Read-only for the repo.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openBrowser, renderStill, selectComposition } from '@remotion/renderer';
import sharp from 'sharp';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { getServeUrl, disposeServeBundle } from '../remotion/serve-bundle.mjs';
import { collectReferencedFonts } from '../src/fonts/projectFonts.ts';
import { GOOGLE_FONT_CATALOG, isGenericFontFamily, resolveCanonicalFamily } from '../src/fonts/googleFontCatalog.ts';
import { findLocalFont } from '../src/fonts/localFonts.ts';
import type { Tpl } from '../src/types.ts';

export const VI = 'Đức Ủy Ở Hoàng Gia Nguyễn';
export const ASCII = 'Duc Uy O Hoang Gia Nguyen';
const ZW = '​';
const ROOT = resolve(import.meta.dirname, '..');
const TEMPLATE_FILES = ['openchatcut-templates.json', 'social-shorts-templates.json', 'koubo-scenes-templates.json'];

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const OUT = resolve(arg('out') ?? join(ROOT, 'vi-font-check-out'));
const ONLY = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean);
const CONCURRENCY = Math.max(1, Number(arg('concurrency') ?? 3));
const FRAME_CANDIDATES = [0.6, 0.45, 0.8, 0.3, 0.95];
const MIN_TEXT_PX = 400;

// Families whose loaded face lacks U+1EA0–1EF9 (checked: Google subsets via
// @remotion/google-fonts getInfo(); Windows fonts via their cmap). Text set in
// them shows per-glyph fallback (mixed fonts) for ứ Ủ Ở ễ etc.
const GOOGLE_NO_VI = new Set(['DM Sans', 'Caveat', 'Fredoka', 'Special Elite']);
const SYSTEM_NO_VI = new Set(['Georgia', 'Impact', 'Comic Sans MS']);

type Box = { x0: number; y0: number; x1: number; y1: number } | null;

interface Raw { data: Buffer; width: number; height: number }

async function raw(png: Buffer): Promise<Raw> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Per-pixel premultiplied difference mask. */
function diffMask(a: Raw, b: Raw, threshold = 40): Uint8Array {
  const n = a.width * a.height;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const aa = a.data[o + 3] / 255;
    const ba = b.data[o + 3] / 255;
    let d = Math.abs(a.data[o + 3] - b.data[o + 3]);
    for (let c = 0; c < 3; c++) d += Math.abs(a.data[o + c] * aa - b.data[o + c] * ba);
    if (d > threshold) mask[i] = 1;
  }
  return mask;
}

function maskStats(mask: Uint8Array, width: number, height: number): { count: number; box: Box } {
  let count = 0; let x0 = width; let y0 = height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      count++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return { count, box: count ? { x0, y0, x1, y1 } : null };
}

const touchesEdge = (box: Box, w: number, h: number): boolean =>
  !!box && (box.x0 <= 1 || box.y0 <= 1 || box.x1 >= w - 2 || box.y1 >= h - 2);

/** Horizontal band (text line block) holding the most accent-differing pixels. */
function bestBand(textMask: Uint8Array, accentMask: Uint8Array, w: number, h: number): Box {
  const bands: Array<{ y0: number; y1: number; score: number }> = [];
  let start = -1; let gap = 0; let score = 0;
  for (let y = 0; y < h; y++) {
    let rowText = 0; let rowAcc = 0;
    for (let x = 0; x < w; x++) { rowText += textMask[y * w + x]; rowAcc += accentMask[y * w + x]; }
    if (rowText) {
      if (start < 0) { start = y; score = 0; }
      gap = 0; score += rowAcc + rowText * 0.01;
    } else if (start >= 0 && ++gap >= 8) {
      bands.push({ y0: start, y1: y - gap, score }); start = -1; gap = 0;
    }
  }
  if (start >= 0) bands.push({ y0: start, y1: h - 1, score });
  if (!bands.length) return null;
  const band = bands.sort((a, b) => b.score - a.score)[0]!;
  let x0 = w; let x1 = -1;
  for (let y = band.y0; y <= band.y1; y++) {
    for (let x = 0; x < w; x++) if (textMask[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
  }
  return { x0, y0: band.y0, x1, y1: band.y1 };
}

function withText(tpl: Tpl, value: string): Record<string, unknown> {
  const props = { ...tpl.props };
  for (const spec of tpl.propSchema ?? []) {
    if (spec.type === 'text' || spec.type === 'string') props[spec.key] = value;
  }
  return props;
}

function stateFor(tpl: Tpl, props: Record<string, unknown>) {
  return {
    fps: tpl.fps || 30,
    width: tpl.width,
    height: tpl.height,
    selectedId: null,
    tracks: { track_v1: { kind: 'video' } },
    trackOrder: ['track_v1'],
    items: [{
      id: `vi_${tpl.id}`,
      kind: 'motion-graphic',
      templateId: tpl.id,
      name: tpl.name,
      code: tpl.code,
      props,
      width: tpl.width,
      height: tpl.height,
      track: 'track_v1',
      startFrame: 0,
      durationInFrames: tpl.durationInFrames,
    }],
  };
}

function fontVerdict(tpl: Tpl): { families: string[]; risky: string[]; unloaded: string[] } {
  const state = stateFor(tpl, tpl.props);
  const families = collectReferencedFonts(state as never);
  const risky: string[] = [];
  const unloaded: string[] = [];
  for (const family of families) {
    if (GOOGLE_NO_VI.has(family) || SYSTEM_NO_VI.has(family)) risky.push(family);
    if (isGenericFontFamily(family)) continue;
    const canonical = resolveCanonicalFamily(family);
    const loadable = canonical && (findLocalFont(canonical) || GOOGLE_FONT_CATALOG.some((e) => e.family === canonical));
    if (!loadable) unloaded.push(family);
  }
  return { families, risky, unloaded };
}

async function main(): Promise<void> {
  mkdirSync(join(OUT, 'crops'), { recursive: true });
  mkdirSync(join(OUT, 'frames'), { recursive: true });
  mkdirSync(join(OUT, 'sheets'), { recursive: true });
  const templates = TEMPLATE_FILES.flatMap((file) =>
    (JSON.parse(readFileSync(join(ROOT, 'assets/templates', file), 'utf8')) as Tpl[])
      .map((tpl) => ({ ...tpl, sourceFile: file })));
  const selected = ONLY ? templates.filter((t) => ONLY.some((id) => t.id.startsWith(id) || t.name === id)) : templates;

  const serveUrl = await getServeUrl();
  const browser = await openBrowser('chrome', { chromiumOptions: { gl: 'angle' } });
  const started = Date.now();

  async function still(tpl: Tpl, text: string, frame: number): Promise<Buffer> {
    const inputProps = { state: stateFor(tpl, withText(tpl, text)), transparent: true };
    const composition = await selectComposition({
      serveUrl, id: 'timeline', inputProps, puppeteerInstance: browser, timeoutInMilliseconds: 90_000,
    });
    const f = Math.max(0, Math.min(composition.durationInFrames - 1, frame));
    const { buffer } = await renderStill({
      serveUrl, composition, inputProps, frame: f, imageFormat: 'png', output: null,
      puppeteerInstance: browser, chromiumOptions: { gl: 'angle' }, timeoutInMilliseconds: 90_000,
    });
    if (!buffer) throw new Error('renderStill returned no buffer');
    return buffer;
  }

  const results: Record<string, unknown>[] = new Array(selected.length);
  let next = 0; let done = 0;

  async function checkOne(index: number): Promise<void> {
    const tpl = selected[index]!;
    const textFields = (tpl.propSchema ?? []).filter((s) => s.type === 'text' || s.type === 'string').map((s) => s.key);
    const fonts = fontVerdict(tpl);
    const base = {
      id: tpl.id, name: tpl.name, category: tpl.category, sourceFile: (tpl as Tpl & { sourceFile: string }).sourceFile,
      width: tpl.width, height: tpl.height, textFields, fonts,
    };
    if (!textFields.length) {
      results[index] = { ...base, status: 'no_text_field' };
      return;
    }
    try {
      const dur = Math.max(1, tpl.durationInFrames);
      let frame = -1; let viRaw: Raw | null = null; let zwRaw: Raw | null = null; let viPng: Buffer | null = null;
      let textMask: Uint8Array | null = null; let textStats = { count: 0, box: null as Box };
      for (const fraction of FRAME_CANDIDATES) {
        const f = Math.round((dur - 1) * fraction);
        const [zw, vi] = [await still(tpl, ZW, f), await still(tpl, VI, f)];
        const [zr, vr] = [await raw(zw), await raw(vi)];
        const mask = diffMask(vr, zr);
        const stats = maskStats(mask, vr.width, vr.height);
        if (stats.count > textStats.count) {
          frame = f; viRaw = vr; zwRaw = zr; viPng = vi; textMask = mask; textStats = stats;
        }
        if (stats.count >= MIN_TEXT_PX) break;
      }
      if (!viRaw || !zwRaw || !viPng || !textMask || textStats.count < MIN_TEXT_PX) {
        results[index] = { ...base, status: 'text_not_visible', frame, textPx: textStats.count };
        return;
      }
      const asciiRaw = await raw(await still(tpl, ASCII, frame));
      const asciiMask = diffMask(asciiRaw, zwRaw);
      const asciiStats = maskStats(asciiMask, asciiRaw.width, asciiRaw.height);
      const accentMask = diffMask(viRaw, asciiRaw);
      const accentStats = maskStats(accentMask, viRaw.width, viRaw.height);
      const { width: w, height: h } = viRaw;
      const extraTopPx = textStats.box && asciiStats.box ? asciiStats.box.y0 - textStats.box.y0 : null;

      // Visual-review crop: the text band with the most accent-differing ink,
      // composited on mid grey so both light and dark text stay readable.
      const band = bestBand(textMask, accentMask, w, h) ?? textStats.box!;
      const pad = 14;
      const left = Math.max(0, band.x0 - pad); const top = Math.max(0, band.y0 - pad);
      const cw = Math.min(w - left, band.x1 - band.x0 + 1 + pad * 2);
      const ch = Math.min(h - top, band.y1 - band.y0 + 1 + pad * 2);
      const grey = { r: 120, g: 128, b: 140, alpha: 1 };
      await sharp(viPng).extract({ left, top, width: cw, height: ch }).flatten({ background: grey })
        .resize({ width: Math.min(cw, 1100), withoutEnlargement: true }).png()
        .toFile(join(OUT, 'crops', `${String(index).padStart(3, '0')}.png`));
      await sharp(viPng).flatten({ background: grey }).resize({ width: Math.min(w, 960) }).png()
        .toFile(join(OUT, 'frames', `${String(index).padStart(3, '0')}.png`));

      const auto: string[] = [];
      if (accentStats.count < 30) auto.push('accents_stripped_or_identical');
      // extraTopPx is recorded but not auto-flagged: text-sized backgrounds
      // (cards, pills) make the bbox top unreliable. Clipping is judged visually.
      const viEdge = touchesEdge(textStats.box, w, h);
      const asciiEdge = touchesEdge(asciiStats.box, w, h);
      if (viEdge) auto.push(asciiEdge ? 'overflow_frame_edge_length' : 'overflow_frame_edge_vi_only');
      if (fonts.risky.length) auto.push(`font_without_vietnamese:${fonts.risky.join('|')}`);
      results[index] = {
        ...base, status: 'rendered', frame,
        textPx: textStats.count, asciiPx: asciiStats.count, viVsAsciiPx: accentStats.count,
        bbox: textStats.box, asciiBbox: asciiStats.box, extraTopPx, viEdge, asciiEdge,
        crop: `crops/${String(index).padStart(3, '0')}.png`, auto,
      };
    } catch (error) {
      results[index] = { ...base, status: 'error', error: error instanceof Error ? error.message.slice(0, 400) : String(error) };
    } finally {
      done++;
      if (done % 10 === 0 || done === selected.length) {
        console.log(`${done}/${selected.length} ${Math.round((Date.now() - started) / 1000)}s`);
      }
    }
  }

  async function worker(): Promise<void> {
    while (next < selected.length) await checkOne(next++);
  }
  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } finally {
    await browser.close({ silent: true }).catch(() => undefined);
    await disposeServeBundle().catch(() => undefined);
  }

  writeFileSync(join(OUT, 'results.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), vi: VI, ascii: ASCII, elapsedSeconds: Math.round((Date.now() - started) / 1000),
    results,
  }, null, 1));
  await buildSheets(results);
  console.log(`wrote ${join(OUT, 'results.json')}`);
}

/** Contact sheets: one labelled row per rendered template. */
async function buildSheets(results: Record<string, unknown>[]): Promise<void> {
  const rows = results.map((r, i) => ({ r, i })).filter(({ r }) => r?.status === 'rendered');
  const WIDTH = 1200; const MAX_H = 1700; const LABEL = 26;
  let sheet = 0; let batch: Array<{ r: Record<string, unknown>; i: number; img: Awaited<ReturnType<typeof loadImage>> }> = [];
  let height = 0;
  const flush = async () => {
    if (!batch.length) return;
    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#202020'; ctx.fillRect(0, 0, WIDTH, height);
    let y = 0;
    for (const { r, i, img } of batch) {
      ctx.fillStyle = '#ffd24a'; ctx.font = '18px sans-serif';
      ctx.fillText(`#${i} ${String(r.name)} [${String(r.category)}] ${(r.auto as string[]).join(' ')}`, 8, y + 19);
      y += LABEL;
      ctx.drawImage(img, 8, y);
      y += img.height + 10;
    }
    writeFileSync(join(OUT, 'sheets', `sheet-${String(sheet++).padStart(2, '0')}.png`), canvas.toBuffer('image/png'));
    batch = []; height = 0;
  };
  for (const { r, i } of rows) {
    const img = await loadImage(readFileSync(join(OUT, String(r.crop))));
    const rowH = LABEL + img.height + 10;
    if (height + rowH > MAX_H) await flush();
    batch.push({ r, i, img }); height += rowH;
  }
  await flush();
}

await main();
