import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Regression coverage for a bug where navigator.permissions.query({name:
// 'geolocation'}) resolved with a PermissionStatus frozen at 'granted'
// forever, even if the user later turned "spoof location" off. Runs the
// actual content script in an isolated vm context (see
// injector-locale-timezone-independence.test.js for why) with a fake
// window.Permissions standing in for the native Permissions API.

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const injectorSource = readFileSync(
  path.join(rootDir, 'content-scripts', 'main-injector.js'),
  'utf8'
);

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, cb) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(cb);
  }
  removeEventListener(type, cb) {
    const arr = this.listeners.get(type);
    if (!arr) return;
    const idx = arr.indexOf(cb);
    if (idx !== -1) arr.splice(idx, 1);
  }
  dispatchEvent(evt) {
    (this.listeners.get(evt.type) || []).slice().forEach((cb) => cb(evt));
  }
}

function loadInjectorInSandbox(nativePermissionState) {
  const documentShim = new FakeEventTarget();

  const navigatorProto = {};
  Object.defineProperty(navigatorProto, 'language', { configurable: true, get: () => 'en-US' });
  Object.defineProperty(navigatorProto, 'languages', { configurable: true, get: () => ['en-US', 'en'] });

  function FakePermissions() {}
  FakePermissions.prototype.query = function (descriptor) {
    return Promise.resolve({ name: descriptor.name, state: nativePermissionState.value });
  };

  const navigatorObj = Object.create(navigatorProto);
  navigatorObj.geolocation = {
    getCurrentPosition() {},
    watchPosition() {
      return 1;
    },
    clearWatch() {},
  };
  navigatorObj.permissions = new FakePermissions();

  const sandbox = {
    document: documentShim,
    navigator: navigatorObj,
    window: { Permissions: FakePermissions },
    EventTarget,
    Event,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(injectorSource, sandbox);
  return sandbox;
}

function dispatchPayload(sandbox, payload) {
  sandbox.document.dispatchEvent({ type: '__geoConsistencyPayload__', detail: payload });
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('permissions.query resolves granted while locationSpoof is on, then degrades when it turns off', async () => {
  const nativePermissionState = { value: 'prompt' };
  const sandbox = loadInjectorInSandbox(nativePermissionState);

  dispatchPayload(sandbox, {
    location: { latitude: 35.68, longitude: 139.69, accuracy: 500 },
    timezone: null,
    locale: null,
  });

  const statusPromise = vm.runInContext(
    `navigator.permissions.query({ name: 'geolocation' })`,
    sandbox
  );
  const status = await statusPromise;
  assert.equal(status.state, 'granted');

  let changeFired = 0;
  status.onchange = () => {
    changeFired += 1;
  };

  // User turns "spoof location" off; the real browser permission happens
  // to be 'denied'. The already-resolved status object should update
  // in place and fire onchange, instead of staying stuck at 'granted'.
  nativePermissionState.value = 'denied';
  dispatchPayload(sandbox, { location: null, timezone: null, locale: null });
  await tick();

  assert.equal(status.state, 'denied');
  assert.equal(changeFired, 1);
});

test('permissions.query delegates to the native result while locationSpoof is off from the start', async () => {
  const nativePermissionState = { value: 'denied' };
  const sandbox = loadInjectorInSandbox(nativePermissionState);

  dispatchPayload(sandbox, { location: null, timezone: null, locale: null });

  const status = await vm.runInContext(
    `navigator.permissions.query({ name: 'geolocation' })`,
    sandbox
  );
  assert.equal(status.state, 'denied');
});

test('permissions.query for a non-geolocation descriptor passes straight through to native', async () => {
  const nativePermissionState = { value: 'granted' };
  const sandbox = loadInjectorInSandbox(nativePermissionState);
  dispatchPayload(sandbox, { location: null, timezone: null, locale: null });

  const status = await vm.runInContext(
    `navigator.permissions.query({ name: 'camera' })`,
    sandbox
  );
  assert.equal(status.name, 'camera');
  assert.equal(status.state, 'granted');
});
