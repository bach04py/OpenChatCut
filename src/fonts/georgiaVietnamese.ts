/**
 * Georgia with complete Vietnamese.
 *
 * Windows Georgia has Ô Ê Â Ă Ơ Ư and the combining marks, but not the precomposed stacked
 * letters U+1EA0–U+1EF9 (Ố Ề Ắ Ấ Ở …). Chrome then decomposes them and draws the second mark as
 * a spacing glyph beside the letter: "ĐỐT" renders as "ĐÔ´T" (scripts/vi-stack-check.mts).
 *
 * Georgia is Microsoft's font and cannot be redistributed. Instead, the family name "Georgia" is
 * defined as a composite in document.fonts:
 *   - every code point except U+1EA0–U+1EF9 → local("Georgia") (the installed system font, unchanged);
 *   - U+1EA0–U+1EF9 → Gelasio (SIL OFL 1.1), a serif designed to Georgia's metrics, bundled in
 *     assets/fonts/gelasio-vi/ (its Vietnamese subset only, normal + italic, variable 400–700).
 * Once any face named "Georgia" exists, the browser no longer falls back to the system Georgia on
 * its own, so the local faces are declared explicitly. Where Georgia is not installed (macOS
 * without it, Linux), the local faces fail to load and the text falls to the next family of the
 * stack, exactly as before.
 */

const FAMILY = 'Georgia';
export const GEORGIA_STACKED_RANGE = 'U+1EA0-1EF9';
const REST_RANGE = 'U+0000-1E9F, U+1EFA-10FFFF';
const PATCH_URL = (style: 'normal' | 'italic') => `/fonts/gelasio-vi/Gelasio-vietnamese-${style}.woff2`;

const LOCAL_SOURCES: ReadonlyArray<{ weight: string; style: 'normal' | 'italic'; src: string }> = [
  { weight: '400', style: 'normal', src: 'local("Georgia"), local("Georgia Regular")' },
  { weight: '700', style: 'normal', src: 'local("Georgia Bold"), local("Georgia-Bold")' },
  { weight: '400', style: 'italic', src: 'local("Georgia Italic"), local("Georgia-Italic")' },
  { weight: '700', style: 'italic', src: 'local("Georgia Bold Italic"), local("Georgia-BoldItalic")' },
];

export function isGeorgia(family: string): boolean {
  return family.trim().replace(/^["']|["']$/g, '').toLowerCase() === 'georgia';
}

let pending: Promise<void> | null = null;

/** Register and load the composite Georgia. Idempotent; never rejects (a missing system
 * Georgia only means the next family of the stack is used, as before). */
export function ensureGeorgiaVietnamese(): Promise<void> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return Promise.resolve();
  if (pending) return pending;
  const faces: FontFace[] = [
    ...LOCAL_SOURCES.map((f) => new FontFace(FAMILY, f.src, {
      weight: f.weight, style: f.style, unicodeRange: REST_RANGE, display: 'block',
    })),
    ...(['normal', 'italic'] as const).map((style) => new FontFace(
      FAMILY, `url(${PATCH_URL(style)}) format('woff2')`,
      { weight: '400 700', style, unicodeRange: GEORGIA_STACKED_RANGE, display: 'block' },
    )),
  ];
  for (const face of faces) document.fonts.add(face);
  pending = Promise.allSettled(faces.map((face) => face.load())).then(() => undefined);
  return pending;
}
