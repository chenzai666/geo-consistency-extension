import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getTimezoneOffsetForZone } from '../lib/tz.js';

// content-scripts/main-injector.js cannot `import` lib/tz.js (MV3 content
// scripts registered via manifest.json content_scripts don't support ES
// module imports, and the MAIN world injector must stay a self-contained
// classic script). Its tzOffsetForZone is therefore an inlined copy, marked
// with TZ_FORMULA_START/END comments. This test extracts that copy and
// cross-checks it against the tested lib/tz.js implementation so the two
// can never silently drift apart.

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const injectorSource = readFileSync(
  path.join(rootDir, 'content-scripts', 'main-injector.js'),
  'utf8'
);

function extractInlinedFormula(source) {
  const start = source.indexOf('// TZ_FORMULA_START');
  const end = source.indexOf('// TZ_FORMULA_END');
  assert.ok(start !== -1 && end !== -1 && end > start, 'TZ_FORMULA markers not found');
  return source.slice(start, end);
}

const inlinedSource = extractInlinedFormula(injectorSource);
// eslint-disable-next-line no-new-func
const inlinedTzOffsetForZone = new Function(`${inlinedSource}\nreturn tzOffsetForZone;`)();

const CASES = [
  ['UTC', new Date('2024-06-01T12:00:00Z')],
  ['America/New_York', new Date('2024-03-10T06:59:00Z')], // just before spring-forward
  ['America/New_York', new Date('2024-03-10T07:01:00Z')], // just after spring-forward
  ['America/New_York', new Date('2024-11-03T05:59:00Z')], // just before fall-back
  ['America/New_York', new Date('2024-11-03T06:01:00Z')], // just after fall-back
  ['Europe/Berlin', new Date('2024-01-15T12:00:00Z')],
  ['Europe/Berlin', new Date('2024-07-15T12:00:00Z')],
  ['Australia/Sydney', new Date('2024-01-15T00:00:00Z')],
  ['Australia/Sydney', new Date('2024-07-15T00:00:00Z')],
  ['Asia/Tokyo', new Date('2024-01-01T00:00:00Z')],
  ['Asia/Kolkata', new Date('2024-01-01T00:00:00Z')], // UTC+5:30, half-hour offset
];

test('inlined main-injector.js tz formula matches lib/tz.js across zones and DST edges', () => {
  for (const [zone, date] of CASES) {
    const expected = getTimezoneOffsetForZone(date, zone);
    const actual = inlinedTzOffsetForZone(date, zone);
    assert.equal(actual, expected, `mismatch for ${zone} @ ${date.toISOString()}`);
  }
});

test('inlined formula also agrees on invalid input handling', () => {
  assert.ok(Number.isNaN(inlinedTzOffsetForZone(new Date('invalid'), 'UTC')));
  assert.ok(Number.isNaN(inlinedTzOffsetForZone(new Date(), 'Not/AZone')));
});

test('main-injector.js declares content script patch points required by the spec', () => {
  // Sanity-check the injector actually patches everything item 7 requires,
  // so this test also fails loudly if a patch block is ever accidentally
  // removed during refactors.
  const required = [
    'getCurrentPosition',
    'watchPosition',
    'clearWatch',
    "name === 'geolocation'",
    'getTimezoneOffset',
    "'DateTimeFormat'",
    "'NumberFormat'",
    "'Collator'",
    "'language'",
    "'languages'",
  ];
  for (const token of required) {
    assert.ok(injectorSource.includes(token), `main-injector.js missing patch for: ${token}`);
  }
});
