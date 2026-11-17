// Stacked-diacritic check for every bundled motion-graphic template.
//
//   npx tsx scripts/vi-stack-check.mts [--out <dir>] [--only <id,id>] [--concurrency 3]
//
// vi-font-check.mts tested one line ("Đức Ủy Ở Hoàng Gia Nguyễn") with no letter that stacks
// a second mark on a circumflex, horn or breve. A font without the precomposed glyph (Ố) but
// with the base (Ô) and the combining mark (U+0301) gets the letter decomposed, and without
// mark anchors Chrome draws the second mark as a spacing glyph: "ĐỐT" renders "ĐÔ´T"
// (Windows Georgia does this). The defect belongs to the font the text is set in, so this
// script tests fonts in a clean harness instead of judging whole template frames, where
// resizing cards, wrapping labels and per-character fallback move pixels too.
//
// Per template:
//  1. Font stacks: every string literal in its code that is a CSS font-family list (a known
//     family or a generic one), every font-type prop value, and the inherited default
//     (no font-family). Over-inclusion only makes the check stricter.
//  2. Harness: a synthetic motion-graphic, rendered through the app's own Remotion bundle and
//     font loader, carrying the template's props and (as // comments) its code, so the loader
//     loads exactly the families the template would. It draws every letter of every family in
//     its own cell at a known left edge, once as the single-mark base (B) and once stacked
//     (S), at 400 and 700 weight and italic.
//  3. Per cell: the base letter's ink spans [bx0, bx1]; the new ink in S (S dark, B not) is the
//     second mark. Detached: it starts after a gap past the letter's right edge
//     (mx0 > bx1 + GAP_MAX x letter width): a spacing mark. Otherwise attached. No new ink at
//     all: the mark was dropped. A glyph from a fallback font changes the body and
//     counts as attached (it is: mixed fonts are vi-font-check's concern).
// A template passes only if every letter of every family is attached in every stack and style.
// The short realistic LINES are the test vocabulary: each letter is taken from them, and the
// self-check below fails if a family letter is missing from the lines.
// Writes vi-stack-review.json (repo root) and, per failing stack, a contact image in --out.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openBrowser, renderStill, selectComposition } from '@remotion/renderer';
import sharp from 'sharp';
import { getServeUrl, disposeServeBundle } from '../remotion/serve-bundle.mjs';
import { collectReferencedFonts } from '../src/fonts/projectFonts.ts';
import { GOOGLE_FONT_CATALOG } from '../src/fonts/googleFontCatalog.ts';
import { LOCAL_CJK_FONTS } from '../src/fonts/localFonts.ts';
import type { Tpl } from '../src/types.ts';

const ROOT = resolve(import.meta.dirname, '..');
const TEMPLATE_FILES = ['openchatcut-templates.json', 'social-shorts-templates.json', 'koubo-scenes-templates.json'];
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const OUT = resolve(arg('out') ?? join(ROOT, 'vi-stack-check-out'));
const ONLY = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean);
const CONCURRENCY = Math.max(1, Number(arg('concurrency') ?? 3));
const REVIEW_PATH = resolve(arg('review') ?? join(ROOT, 'vi-stack-review.json'));

// Stacked letter -> its single-mark base, by family.
export const FAMILIES: Record<string, Record<string, string>> = {
  circumflex: Object.fromEntries([
    ...[...'ỐỒỔỖỘ'].map((c) => [c, 'Ô']), ...[...'ốồổỗộ'].map((c) => [c, 'ô']),
    ...[...'ẾỀỂỄỆ'].map((c) => [c, 'Ê']), ...[...'ếềểễệ'].map((c) => [c, 'ê']),
    ...[...'ẤẦẨẪẬ'].map((c) => [c, 'Â']), ...[...'ấầẩẫậ'].map((c) => [c, 'â']),
  ]),
  horn: Object.fromEntries([
    ...[...'ỚỜỞỠỢ'].map((c) => [c, 'Ơ']), ...[...'ớờởỡợ'].map((c) => [c, 'ơ']),
    ...[...'ỨỪỬỮỰ'].map((c) => [c, 'Ư']), ...[...'ứừửữự'].map((c) => [c, 'ư']),
  ]),
  breve: Object.fromEntries([...[...'ẮẰẲẴẶ'].map((c) => [c, 'Ă']), ...[...'ắằẳẵặ'].map((c) => [c, 'ă'])]),
  plus: { Đ: 'D', đ: 'd', ỳ: 'y', ỷ: 'y', ỹ: 'y', ỵ: 'y' },
};

// Short realistic lines (upper and lower case); together they hold every family letter.
export const LINES = [
  'ĐỐT MỠ ĐÓN TẾT', 'SẮP TẾT RỒI', 'TẬP LUYỆN MỖI NGÀY', 'KHỎE TỪ BÊN TRONG',
  'ĐẤU TRƯỜNG SỐ MỘT', 'NHỮNG BUỔI TẬP ĐẦU', 'ĐỂ CÓ ĐƯỢC SỨC BỀN', 'DỄ DÀNG HƠN BẠN NGHĨ',
  'HƯỚNG DẪN CHUẨN', 'TỰ TIN VỮNG BƯỚC', 'SẴN SÀNG ĐẶT LỊCH', 'CHẲNG NGẠI KHÓ KHĂN',
  'BẰNG CẢ TRÁI TIM', 'Ở ĐÂY CÓ HỒ BƠI', 'THỬ THÁCH 30 NGÀY',
  'đốt mỡ đón tết', 'sắp tết rồi', 'tập luyện mỗi ngày', 'khỏe từ bên trong', 'đấu trường số một', 'những buổi tập đầu',
  'để có được sức bền', 'dễ dàng hơn bạn nghĩ', 'hướng dẫn chuẩn', 'tự tin vững bước',
  'sẵn sàng đặt lịch', 'chẳng ngại khó khăn', 'bằng cả trái tim', 'ở đây có hồ bơi', 'thử thách 30 ngày',
  'kỳ tích, kỷ lục', 'kỹ thuật đúng', 'không bao giờ quỵ ngã',
];
const familyOf = (ch: string): string | null => Object.keys(FAMILIES).find((f) => ch in FAMILIES[f]!) ?? null;
// The letters under test, in the order they first occur in LINES.
export const LETTERS = [...new Set(LINES.join('').split('').filter((c) => familyOf(c)))];
{
  const all = Object.values(FAMILIES).flatMap((m) => Object.keys(m));
  const missing = all.filter((c) => !LETTERS.includes(c));
  if (missing.length) throw new Error(`LINES miss family letters: ${missing.join(' ')}`);
}

const STYLES = [
  { key: 'w400', fontWeight: 400, fontStyle: 'normal' },
  { key: 'w700', fontWeight: 700, fontStyle: 'normal' },
  { key: 'i400', fontWeight: 400, fontStyle: 'italic' },
];
const GAP_MAX = 0.05;
const W = 1920; const H = 1080; const CW = 135; const CH = 170; const PAD = 24; const SIZE = 88;
const COLS = Math.floor(W / CW);
const cell = (i: number) => ({ x: (i % COLS) * CW, y: Math.floor(i / COLS) * CH });
if (Math.ceil(LETTERS.length / COLS) * CH > H) throw new Error('harness grid does not fit');

// ------------------------------------------------------------------ font stacks

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif',
  'ui-sans-serif', 'ui-monospace', 'ui-rounded', '-apple-system', 'blinkmacsystemfont', 'emoji', 'math']);
const SYSTEM = ['Georgia', 'Impact', 'Arial', 'Arial Black', 'Helvetica', 'Helvetica Neue', 'Times New Roman',
  'Times', 'Segoe UI', 'Comic Sans MS', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Courier New', 'Courier',
  'Palatino', 'Palatino Linotype', 'Garamond', 'Lora', 'Songti SC', 'STSong', 'SimSun', 'SimHei', 'KaiTi',
  'STKaiti', 'PingFang SC', 'Microsoft YaHei', 'Hiragino Sans GB', 'Noto Serif SC', 'Noto Sans CJK SC',
  'Source Han Sans SC', 'Menlo', 'Monaco', 'Consolas', 'SF Mono', 'SF Pro Display', 'Roboto Mono'];
const KNOWN = new Set([...GOOGLE_FONT_CATALOG.map((e) => e.family), ...LOCAL_CJK_FONTS.map((e) => e.family),
  ...LOCAL_CJK_FONTS.flatMap((e) => e.aliasZh ?? []), ...SYSTEM].map((f) => f.toLowerCase()));

const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '').trim();
/** A CSS font-family list naming at least one known or generic family, else null. */
export function asStack(s: string): string | null {
  if (!s || s.length > 200 || /[:;(){}#<>=]/.test(s)) return null;
  const items = s.split(',').map(unquote);
  if (items.some((i) => !i || !/^[\p{L}\p{N} _.\-]+$/u.test(i))) return null;
  if (!items.some((i) => GENERIC.has(i.toLowerCase()) || KNOWN.has(i.toLowerCase()))) return null;
  return s.trim();
}
function stacksOf(tpl: Tpl): string[] {
  const out = new Set<string>(['']);                                  // '' = inherited default
  const code = String(tpl.code ?? '');
  // fontFamily values, then any string literal on a single line. Literals must not cross a
  // newline: a template literal's closing backtick would otherwise pair with the next one and
  // swallow the code in between.
  for (const m of code.matchAll(/font(?:Family|-family)\s*[:=]\s*(['"`])([^\n]*?)\1/gi)) {
    const st = asStack(m[2] ?? '');
    if (st) out.add(st);
  }
  for (const m of code.matchAll(/(['"])((?:(?!\1)[^\\\n])*)\1|`([^`$\\\n]*)`/g)) {
    const st = asStack(m[2] ?? m[3] ?? '');
    if (st) out.add(st);
  }
  for (const spec of tpl.propSchema ?? []) {
    const v = tpl.props?.[spec.key];
    if ((spec.type === 'font' || /font/i.test(spec.key)) && typeof v === 'string') {
      const st = asStack(v);
      if (st) out.add(st);
    }
  }
  return [...out];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * True only when the stack provably never carries editable text: every element that sets it
 * (directly, or through `const NAME = '<stack>'` + `fontFamily: NAME`) shows only fixed text or
 * values read from props that are NOT declared text fields (e.g. `const bgText1 = props.bgText1
 * || 'You're In'` with no bgText1 in propSchema: a plan can never set it). Anything else,
 * including a stack whose use cannot be found, counts: the check stays strict when unsure.
 */
export function decorativeStack(tpl: Tpl, stack: string): boolean {
  if (!stack) return false;
  const code = String(tpl.code ?? '');
  const textKeys = new Set((tpl.propSchema ?? []).filter((s) => s.type === 'text' || s.type === 'string').map((s) => s.key));
  // identifiers read straight from a prop: const X = props.K || 'fallback'
  const fromProp = new Map<string, string>();
  for (const m of code.matchAll(/const\s+(\w+)\s*=\s*(?:item\.props|props|p)\.(\w+)\s*(?:\|\||\?\?|;|\n)/g)) fromProp.set(m[1]!, m[2]!);
  const lit = escapeRe(stack);
  const uses: number[] = [];
  for (const m of code.matchAll(new RegExp(`font(?:Family|-family)\\s*[:=]\\s*(['"\`])${lit}\\1`, 'g'))) uses.push(m.index!);
  for (const v of code.matchAll(new RegExp(`const\\s+(\\w+)\\s*=\\s*(['"\`])${lit}\\2`, 'g'))) {
    for (const m of code.matchAll(new RegExp(`fontFamily\\s*:\\s*${v[1]}\\b`, 'g'))) uses.push(m.index!);
  }
  if (!uses.length) return false;
  return uses.every((pos) => {
    // Only the shape that can be read reliably: fontFamily inside an inline JSX style={{ … }},
    // whose element's children follow the closing `}}>`. A style object variable applied
    // elsewhere (const rootStyle = { fontFamily … }) is not followed: it counts as text-bearing.
    const open = code.lastIndexOf('style={{', pos);
    if (open < 0 || code.lastIndexOf('}}', pos) > open) return false;
    const attrEnd = /\}\}\s*>/.exec(code.slice(pos));
    if (!attrEnd) return false;
    const childStart = pos + attrEnd.index + attrEnd[0].length;
    const close = code.indexOf('</', childStart);
    if (close < 0) return false;
    const children = code.slice(childStart, close);
    if (/<\w/.test(children)) return false;           // nested elements: not followed, count it
    return [...children.matchAll(/\{([^{}]*)\}/g)].every((m) => {
      const e = m[1]!.trim();
      if (!e || /^\/\*.*\*\/$/s.test(e) || /^(['"`])[^'"`]*\1$/.test(e)) return true;   // comment or literal
      const key = fromProp.get(e);
      return key !== undefined && !textKeys.has(key);
    });
  });
}

// ------------------------------------------------------------------ harness

const HARNESS = `const StackHarness = ({ item }) => {
  const p = item.props || {};
  const letters = p.__letters || [];
  const font = p.__stack ? { fontFamily: p.__stack } : {};
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#ffffff' }}>
      {letters.map((ch, i) => (
        <div key={i} style={{ position: 'absolute', left: (i % ${COLS}) * ${CW} + ${PAD},
          top: Math.floor(i / ${COLS}) * ${CH} + 40, fontSize: ${SIZE}, lineHeight: 1, whiteSpace: 'pre',
          color: '#000000', fontWeight: p.__weight, fontStyle: p.__style, ...font }}>{ch}</div>
      ))}
    </div>
  );
};
`;
function harnessCode(tpl: Tpl): string {
  // the template's code as comments: the font loader scans code text, comments included
  return HARNESS + String(tpl.code ?? '').split('\n').map((l) => `// ${l}`).join('\n');
}
function stateFor(tpl: Tpl, props: Record<string, unknown>) {
  return {
    fps: 30, width: W, height: H, selectedId: null,
    tracks: { track_v1: { kind: 'video' } }, trackOrder: ['track_v1'],
    items: [{ id: 'harness', kind: 'motion-graphic', templateId: 'vi-stack-harness', name: 'harness',
      code: harnessCode(tpl), props, width: W, height: H, track: 'track_v1', startFrame: 0, durationInFrames: 1 }],
  };
}

interface Raw { data: Buffer; width: number; height: number }
async function raw(png: Buffer): Promise<Raw> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
const dark = (r: Raw, x: number, y: number) => {
  const o = (y * r.width + x) * 3;
  return r.data[o]! + r.data[o + 1]! + r.data[o + 2]! < 3 * 128;
};

type Verdict = { letter: string; base: string; family: string; result: 'attached' | 'detached' | 'no_mark' | 'missing';
  bx0?: number; bx1?: number; mx0?: number };
function judge(b: Raw, s: Raw, letters: string[]): Verdict[] {
  return letters.map((letter, i) => {
    const family = familyOf(letter)!; const base = FAMILIES[family]![letter]!;
    const { x, y } = cell(i);
    let bx0 = Infinity; let bx1 = -1; let mx0 = Infinity; let marks = 0;
    for (let yy = y; yy < Math.min(H, y + CH); yy++) {
      for (let xx = x; xx < Math.min(W, x + CW); xx++) {
        const db = dark(b, xx, yy); const ds = dark(s, xx, yy);
        if (db) { if (xx < bx0) bx0 = xx; if (xx > bx1) bx1 = xx; }
        if (ds && !db) { marks++; if (xx < mx0) mx0 = xx; }
      }
    }
    if (bx1 < 0) return { letter, base, family, result: 'missing' };
    if (marks < 20) return { letter, base, family, result: 'no_mark', bx0: bx0 - x, bx1: bx1 - x };
    // Calibrated on the full run: detached marks (Georgia, every weight and italic) start
    // 0.13-0.65 letter widths past the letter's right edge; attached marks of slanted faces
    // (Space Mono italic acute) reach -0.05. The threshold sits in that gap.
    const attached = mx0 <= bx1 + GAP_MAX * (bx1 - bx0);
    return { letter, base, family, result: attached ? 'attached' : 'detached', bx0: bx0 - x, bx1: bx1 - x, mx0: mx0 - x };
  });
}

async function main(): Promise<void> {
  mkdirSync(join(OUT, 'fails'), { recursive: true });
  const templates = TEMPLATE_FILES.flatMap((file) =>
    (JSON.parse(readFileSync(join(ROOT, 'assets/templates', file), 'utf8')) as Tpl[]).map((t) => ({ ...t, sourceFile: file })));
  const selected = ONLY ? templates.filter((t) => ONLY.some((id) => t.id.startsWith(id) || t.name === id)) : templates;
  const serveUrl = await getServeUrl();
  const browser = await openBrowser('chrome', { chromiumOptions: { gl: 'angle' } });
  const started = Date.now();

  async function still(tpl: Tpl, props: Record<string, unknown>): Promise<Buffer> {
    const inputProps = { state: stateFor(tpl, props), transparent: false };
    const composition = await selectComposition({ serveUrl, id: 'timeline', inputProps, puppeteerInstance: browser, timeoutInMilliseconds: 90_000 });
    const { buffer } = await renderStill({ serveUrl, composition, inputProps, frame: 0, imageFormat: 'png', output: null,
      puppeteerInstance: browser, chromiumOptions: { gl: 'angle' }, timeoutInMilliseconds: 90_000 });
    if (!buffer) throw new Error('renderStill returned no buffer');
    return buffer;
  }

  // (stack, style, families the loader sees) -> verdicts; shared across templates
  const cache = new Map<string, Promise<{ verdicts: Verdict[]; image?: string }>>();
  let fails = 0;
  function testStack(tpl: Tpl, stack: string, style: typeof STYLES[number]) {
    const loaded = collectReferencedFonts(stateFor(tpl, { ...tpl.props }) as never).sort();
    const key = JSON.stringify([stack, style.key, loaded]);
    if (!cache.has(key)) {
      cache.set(key, (async () => {
        const common = { ...tpl.props, __stack: stack, __weight: style.fontWeight, __style: style.fontStyle };
        const bPng = await still(tpl, { ...common, __letters: LETTERS.map((c) => FAMILIES[familyOf(c)!]![c]) });
        const sPng = await still(tpl, { ...common, __letters: LETTERS });
        const verdicts = judge(await raw(bPng), await raw(sPng), LETTERS);
        let image: string | undefined;
        if (verdicts.some((v) => v.result !== 'attached')) {
          image = `fails/${String(fails++).padStart(3, '0')}.png`;
          await sharp(sPng).resize({ width: 960 }).png().toFile(join(OUT, image));
        }
        return { verdicts, image };
      })());
    }
    return cache.get(key)!;
  }

  const results: Record<string, unknown>[] = new Array(selected.length);
  let next = 0; let done = 0;
  async function checkOne(index: number): Promise<void> {
    const tpl = selected[index]!;
    const textFields = (tpl.propSchema ?? []).filter((s) => s.type === 'text' || s.type === 'string').map((s) => s.key);
    const base = { id: tpl.id, name: tpl.name, category: tpl.category, sourceFile: (tpl as Tpl & { sourceFile: string }).sourceFile };
    if (!textFields.length) { results[index] = { ...base, status: 'no_text_field', stack_ok: false }; return; }
    try {
      const stacks = stacksOf(tpl);
      const failedFamilies = new Set<string>();
      const failures: Record<string, unknown>[] = [];
      const decorativeFamilies = new Set<string>();
      for (const stack of stacks) {
        const decorative = decorativeStack(tpl, stack);
        for (const style of STYLES) {
          const { verdicts, image } = await testStack(tpl, stack, style);
          const bad = verdicts.filter((v) => v.result !== 'attached');
          if (!bad.length) continue;
          bad.forEach((v) => (decorative ? decorativeFamilies : failedFamilies).add(v.family));
          failures.push({ stack: stack || '(inherited default)', style: style.key, image, decorative,
            letters: bad.map((v) => `${v.letter}:${v.result}${v.mx0 !== undefined ? `(${((v.mx0 - v.bx1!) / (v.bx1! - v.bx0!)).toFixed(2)})` : ''}`).join(' ') });
        }
      }
      const failed = Object.keys(FAMILIES).filter((f) => failedFamilies.has(f));
      // decorative: the stack only shows fixed text / undeclared props, never an editable field
      const decorativeOnly = Object.keys(FAMILIES).filter((f) => decorativeFamilies.has(f) && !failedFamilies.has(f));
      results[index] = { ...base, status: failed.length ? 'fail_stacked_marks' : decorativeOnly.length ? 'ok_decorative_only' : 'ok',
        stack_ok: !failed.length, failed_families: failed, decorative_failed_families: decorativeOnly,
        stacks: stacks.map((s) => s || '(inherited default)'), failures };
    } catch (error) {
      results[index] = { ...base, status: 'error', stack_ok: false, error: error instanceof Error ? error.message.slice(0, 400) : String(error) };
    } finally {
      done++;
      if (done % 10 === 0 || done === selected.length) console.log(`${done}/${selected.length} ${Math.round((Date.now() - started) / 1000)}s, ${cache.size} stack tests`);
    }
  }
  const worker = async () => { while (next < selected.length) await checkOne(next++); };
  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } finally {
    await browser.close({ silent: true }).catch(() => undefined);
    await disposeServeBundle().catch(() => undefined);
  }
  writeFileSync(REVIEW_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(), method: 'scripts/vi-stack-check.mts (font harness, see header)',
    lines: LINES, letters: LETTERS.join(''),
    families: Object.fromEntries(Object.entries(FAMILIES).map(([f, m]) => [f, Object.keys(m).join('')])),
    styles: STYLES.map((s) => s.key), elapsedSeconds: Math.round((Date.now() - started) / 1000), templates: results,
  }, null, 1));
  console.log(`wrote ${REVIEW_PATH}`);
}

await main();
