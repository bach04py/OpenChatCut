// npx tsx src/fonts/projectFonts.verify.ts
// Font families read from motion-graphic code: every quoting style, and Georgia through a constant.
import assert from 'node:assert/strict';
import { collectReferencedFonts } from './projectFonts';
import { GEORGIA_STACKED_RANGE, isGeorgia } from './georgiaVietnamese';

function fonts(code: string): string[] {
  const state = { items: [{ id: 'x', kind: 'motion-graphic', code, props: {} }] };
  return collectReferencedFonts(state as never, { captions: null });
}

// double quotes inside single: the old pattern stopped at the first quote and read nothing
assert.deepEqual(fonts(`s={fontFamily: '"Playfair Display", "Georgia", serif'}`),
  ['Georgia', 'Playfair Display', 'serif']);
// single quotes inside double
assert.deepEqual(fonts(`s={fontFamily: "'Barlow Condensed', sans-serif"}`), ['Barlow Condensed', 'sans-serif']);
// template literal and plain stacks
assert.deepEqual(fonts('s={fontFamily: `"Abril Fatface", cursive`}'), ['Abril Fatface', 'cursive']);
assert.deepEqual(fonts(`s={fontFamily: 'Inter, sans-serif'}`), ['Inter', 'sans-serif']);
// Georgia reached through a constant still loads its Vietnamese patch
assert.deepEqual(fonts(`const serif = 'Georgia, "Songti SC", serif'; s={fontFamily: serif}`), ['Georgia']);
assert.deepEqual(fonts(`s={fontFamily: 'Inter'}; // no serif here`), ['Inter']);

assert.equal(isGeorgia('"Georgia"'), true);
assert.equal(isGeorgia('Georgia Pro'), false);
assert.equal(GEORGIA_STACKED_RANGE, 'U+1EA0-1EF9');
console.log('projectFonts.verify: ok');
