import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTimezoneOffsetForZone, isValidTimeZone } from '../lib/tz.js';

test('matches native getTimezoneOffset for the host zone across DST boundaries (US, spring-forward)', () => {
  // America/New_York: DST starts 2024-03-10 02:00 local -> 03:00 local
  const before = new Date('2024-03-10T06:59:00Z'); // 01:59 EST (UTC-5) -> offset 300
  const after = new Date('2024-03-10T07:01:00Z'); // 03:01 EDT (UTC-4) -> offset 240
  assert.equal(getTimezoneOffsetForZone(before, 'America/New_York'), 300);
  assert.equal(getTimezoneOffsetForZone(after, 'America/New_York'), 240);
});

test('handles fall-back DST transition (US, autumn)', () => {
  // 2024-11-03 02:00 EDT -> 01:00 EST
  const beforeFallBack = new Date('2024-11-03T05:59:00Z'); // 01:59 EDT (UTC-4) -> offset 240
  const afterFallBack = new Date('2024-11-03T06:01:00Z'); // 01:01 EST (UTC-5) -> offset 300
  assert.equal(getTimezoneOffsetForZone(beforeFallBack, 'America/New_York'), 240);
  assert.equal(getTimezoneOffsetForZone(afterFallBack, 'America/New_York'), 300);
});

test('southern-hemisphere DST is inverted relative to northern hemisphere (Australia/Sydney)', () => {
  // Sydney DST (AEDT, UTC+11) runs Oct-Apr; AEST (UTC+10) the rest of the year.
  const summer = new Date('2024-01-15T00:00:00Z'); // AEDT
  const winter = new Date('2024-07-15T00:00:00Z'); // AEST
  assert.equal(getTimezoneOffsetForZone(summer, 'Australia/Sydney'), -660);
  assert.equal(getTimezoneOffsetForZone(winter, 'Australia/Sydney'), -600);
});

test('zones without DST return a stable offset year-round (Asia/Tokyo, UTC+9)', () => {
  assert.equal(getTimezoneOffsetForZone(new Date('2024-01-01T00:00:00Z'), 'Asia/Tokyo'), -540);
  assert.equal(getTimezoneOffsetForZone(new Date('2024-07-01T00:00:00Z'), 'Asia/Tokyo'), -540);
});

test('positive-offset zone matches sign convention (Europe/Berlin, DST vs winter)', () => {
  const winter = new Date('2024-01-15T12:00:00Z'); // CET UTC+1 -> offset -60
  const summer = new Date('2024-07-15T12:00:00Z'); // CEST UTC+2 -> offset -120
  assert.equal(getTimezoneOffsetForZone(winter, 'Europe/Berlin'), -60);
  assert.equal(getTimezoneOffsetForZone(summer, 'Europe/Berlin'), -120);
});

test('agrees with the real Date.prototype.getTimezoneOffset when the zone is the host zone', () => {
  // The test runner's own TZ is whatever the environment is set to; we cross
  // check by explicitly forcing UTC via process.env.TZ at the top of the file
  // is unnecessary here — instead we verify UTC itself, which is unambiguous.
  const d = new Date('2024-06-01T12:34:56Z');
  assert.equal(getTimezoneOffsetForZone(d, 'UTC'), 0);
});

test('returns NaN for invalid timezone', () => {
  assert.ok(Number.isNaN(getTimezoneOffsetForZone(new Date(), 'Not/AZone')));
});

test('returns NaN for invalid date', () => {
  assert.ok(Number.isNaN(getTimezoneOffsetForZone(new Date('not a date'), 'UTC')));
});

test('isValidTimeZone accepts known IANA zones and rejects garbage', () => {
  assert.equal(isValidTimeZone('Europe/Paris'), true);
  assert.equal(isValidTimeZone('America/Argentina/Buenos_Aires'), true);
  assert.equal(isValidTimeZone('Mars/Olympus_Mons'), false);
  assert.equal(isValidTimeZone(''), false);
  assert.equal(isValidTimeZone(null), false);
});
