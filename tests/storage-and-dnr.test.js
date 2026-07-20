import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, accuracyRadiusMeters, DEFAULT_SETTINGS } from '../lib/storage-schema.js';
import { buildAcceptLanguageRule, ACCEPT_LANGUAGE_RULE_ID } from '../lib/dnr.js';

test('normalizeSettings fills in defaults for missing fields', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS);
});

test('normalizeSettings coerces and clamps refreshIntervalMinutes', () => {
  assert.equal(normalizeSettings({ refreshIntervalMinutes: 1 }).refreshIntervalMinutes, 5);
  assert.equal(normalizeSettings({ refreshIntervalMinutes: 'not a number' }).refreshIntervalMinutes, 60);
  assert.equal(normalizeSettings({ refreshIntervalMinutes: 120 }).refreshIntervalMinutes, 120);
});

test('normalizeSettings rejects unknown accuracy presets', () => {
  assert.equal(normalizeSettings({ accuracy: 'nonsense' }).accuracy, 'balanced');
  assert.equal(normalizeSettings({ accuracy: 'precise' }).accuracy, 'precise');
});

test('normalizeSettings trims the ipinfo token and never lets it be non-string', () => {
  assert.equal(normalizeSettings({ ipinfoToken: '  abc123  ' }).ipinfoToken, 'abc123');
  assert.equal(normalizeSettings({ ipinfoToken: 42 }).ipinfoToken, '');
});

test('accuracyRadiusMeters maps presets to meters and falls back to balanced', () => {
  assert.equal(accuracyRadiusMeters('precise'), 100);
  assert.equal(accuracyRadiusMeters('city'), 3000);
  assert.equal(accuracyRadiusMeters('unknown'), 500);
});

test('buildAcceptLanguageRule shapes a valid declarativeNetRequest modifyHeaders rule', () => {
  const rule = buildAcceptLanguageRule('de-DE,de;q=0.9,en;q=0.8');
  assert.equal(rule.id, ACCEPT_LANGUAGE_RULE_ID);
  assert.equal(rule.action.type, 'modifyHeaders');
  assert.equal(rule.action.requestHeaders[0].header, 'Accept-Language');
  assert.equal(rule.action.requestHeaders[0].operation, 'set');
  assert.equal(rule.action.requestHeaders[0].value, 'de-DE,de;q=0.9,en;q=0.8');
  assert.ok(rule.condition.resourceTypes.includes('main_frame'));
});

test('buildAcceptLanguageRule covers beacon/plugin/report request types too, not just document+asset loads', () => {
  // Otherwise navigator.sendBeacon()/<a ping> (ping), <object>/<embed> (object),
  // and CSP violation reports (csp_report) would keep leaking the real
  // Accept-Language while every other request type gets the spoofed one.
  const rule = buildAcceptLanguageRule('ja-JP,ja;q=0.9');
  for (const type of ['object', 'ping', 'csp_report']) {
    assert.ok(rule.condition.resourceTypes.includes(type), `missing resourceType: ${type}`);
  }
});
