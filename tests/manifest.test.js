import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));

test('manifest is MV3 with the required privacy-relevant permission set only', () => {
  assert.equal(manifest.manifest_version, 3);
  // No telemetry/analytics-shaped permissions: no "identity", no "tabs" content
  // reading, no cookies, no browsingData, no remote-code capable permissions.
  const allowed = new Set(['storage', 'alarms', 'declarativeNetRequest']);
  for (const perm of manifest.permissions) {
    assert.ok(allowed.has(perm), `unexpected permission: ${perm}`);
  }
});

test('background service worker is registered as an ES module', () => {
  assert.equal(manifest.background.service_worker, 'background/service-worker.js');
  assert.equal(manifest.background.type, 'module');
});

test('exactly two content scripts are registered: MAIN injector + ISOLATED bridge', () => {
  assert.equal(manifest.content_scripts.length, 2);
});

test('the MAIN-world injector is injected before the ISOLATED bridge in manifest order', () => {
  // Chrome injects same run_at content scripts in manifest declaration order.
  // The MAIN-world patcher must be registered first so its event listener
  // exists before the isolated bridge dispatches the storage payload event.
  const [first, second] = manifest.content_scripts;
  assert.equal(first.world, 'MAIN');
  assert.ok(first.js.includes('content-scripts/main-injector.js'));

  assert.equal(second.world, undefined); // defaults to ISOLATED
  assert.ok(second.js.includes('content-scripts/isolated-bridge.js'));
});

test('both content scripts run at document_start, in all frames, on all URLs', () => {
  for (const entry of manifest.content_scripts) {
    assert.equal(entry.run_at, 'document_start');
    assert.equal(entry.all_frames, true);
    assert.deepEqual(entry.matches, ['<all_urls>']);
  }
});

test('no options_ui, no remote-config-shaped manifest keys', () => {
  assert.equal(manifest.options_ui, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.oauth2, undefined);
});

test('popup is wired to the action', () => {
  assert.equal(manifest.action.default_popup, 'popup/popup.html');
});
