import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferLocaleBundle, buildAcceptLanguageHeader } from '../lib/locale.js';

test('single-language country resolves directly', () => {
  const bundle = inferLocaleBundle('DE', 'Europe/Berlin');
  assert.equal(bundle.language, 'de-DE');
  assert.deepEqual(bundle.languages, ['de-DE', 'de']);
  assert.equal(bundle.acceptLanguage, 'de-DE,de;q=0.9');
});

test('country code is case-insensitive', () => {
  const bundle = inferLocaleBundle('de', 'Europe/Berlin');
  assert.equal(bundle.language, 'de-DE');
});

test('multilingual country: timezone disambiguates Canada English vs French', () => {
  const en = inferLocaleBundle('CA', 'America/Toronto');
  assert.equal(en.language, 'en-CA');

  const fr = inferLocaleBundle('CA', 'America/Montreal');
  assert.equal(fr.language, 'fr-CA');
});

test('multilingual country: timezone disambiguates Switzerland German vs French', () => {
  const de = inferLocaleBundle('CH', 'Europe/Zurich');
  assert.equal(de.language, 'de-CH');

  const fr = inferLocaleBundle('CH', 'Europe/Geneva');
  assert.equal(fr.language, 'fr-CH');
});

test('multilingual country without a matching timezone hint keeps table order', () => {
  const bundle = inferLocaleBundle('CA', 'America/Halifax');
  assert.equal(bundle.language, 'en-CA');
});

test('unknown country code falls back to timezone continent region', () => {
  const bundle = inferLocaleBundle('XX', 'Europe/Berlin');
  assert.equal(bundle.language, 'en-GB');
});

test('unknown country and unknown timezone falls back to default', () => {
  const bundle = inferLocaleBundle('', '');
  assert.equal(bundle.language, 'en-US');
});

test('languages array has no duplicates after hint reordering', () => {
  const bundle = inferLocaleBundle('CH', 'Europe/Zurich');
  assert.equal(new Set(bundle.languages).size, bundle.languages.length);
});

test('buildAcceptLanguageHeader produces descending q-values', () => {
  const header = buildAcceptLanguageHeader(['ja-JP', 'ja', 'en']);
  assert.equal(header, 'ja-JP,ja;q=0.9,en;q=0.8');
});

test('buildAcceptLanguageHeader floors q-value at 0.1 for long lists', () => {
  const header = buildAcceptLanguageHeader(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']);
  assert.ok(header.endsWith('l;q=0.1'));
});

test('previously-missing countries now resolve directly instead of falling back to the region default', () => {
  assert.equal(inferLocaleBundle('HR', 'Europe/Zagreb').language, 'hr-HR');
  assert.equal(inferLocaleBundle('MA', 'Africa/Casablanca').language, 'ar-MA');
  assert.equal(inferLocaleBundle('IR', 'Asia/Tehran').language, 'fa-IR');
  assert.equal(inferLocaleBundle('KZ', 'Asia/Almaty').language, 'kk-KZ');
  assert.equal(inferLocaleBundle('LU', 'Europe/Luxembourg').language, 'fr-LU');
});
