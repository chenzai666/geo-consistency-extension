import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { STORAGE_KEYS } from '../lib/storage-schema.js';

// content-scripts/isolated-bridge.js runs as a classic (non-module) content
// script, so it cannot `import` lib/storage-schema.js and instead hardcodes
// SETTINGS_KEY/PROFILE_KEY string literals. Mirrors the pattern used by
// tests/injector-tz-sync.test.js for main-injector.js's inlined tz formula:
// extract the literal from source and cross-check it against the single
// source of truth so a future STORAGE_KEYS rename fails loudly here instead
// of silently breaking the bridge at runtime.

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const bridgeSource = readFileSync(
  path.join(rootDir, 'content-scripts', 'isolated-bridge.js'),
  'utf8'
);

function extractConstString(source, constName) {
  const match = source.match(new RegExp(`const ${constName} = '([^']*)'`));
  assert.ok(match, `could not find "const ${constName} = '...'" in isolated-bridge.js`);
  return match[1];
}

test('isolated-bridge.js SETTINGS_KEY matches STORAGE_KEYS.SETTINGS', () => {
  assert.equal(extractConstString(bridgeSource, 'SETTINGS_KEY'), STORAGE_KEYS.SETTINGS);
});

test('isolated-bridge.js PROFILE_KEY matches STORAGE_KEYS.PROFILE', () => {
  assert.equal(extractConstString(bridgeSource, 'PROFILE_KEY'), STORAGE_KEYS.PROFILE);
});
