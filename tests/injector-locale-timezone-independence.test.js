import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Regression coverage for a bug where Date.prototype.toLocaleString & co.
// only ever got the spoofed timeZone, never the spoofed locale — so
// weekday/month names and number formatting kept leaking the real browser
// locale even when Intl.DateTimeFormat() would already report the spoofed
// one. Runs the actual content script in an isolated vm context (a fresh
// V8 realm gets its own Date/Intl intrinsics, so patching them here can't
// leak into this test process) rather than re-deriving the logic by hand.

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

function loadInjectorInSandbox() {
  const documentShim = new FakeEventTarget();

  const navigatorProto = {};
  Object.defineProperty(navigatorProto, 'language', {
    configurable: true,
    get() {
      return 'en-US';
    },
  });
  Object.defineProperty(navigatorProto, 'languages', {
    configurable: true,
    get() {
      return ['en-US', 'en'];
    },
  });
  const navigatorObj = Object.create(navigatorProto);
  navigatorObj.geolocation = {
    getCurrentPosition() {},
    watchPosition() {
      return 1;
    },
    clearWatch() {},
  };

  // Deliberately NOT passing Date/Intl in — a vm context that doesn't
  // receive them as sandbox properties gets its own independent realm's
  // built-ins, which is exactly what keeps this test's Date/Intl patches
  // from bleeding into the rest of the suite running in this process.
  const sandbox = {
    document: documentShim,
    navigator: navigatorObj,
    window: {},
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

test('toLocaleDateString defaults to the spoofed locale even when timezoneSpoof is off', () => {
  const sandbox = loadInjectorInSandbox();
  dispatchPayload(sandbox, {
    location: null,
    timezone: null, // timezoneSpoof OFF
    locale: { language: 'ja-JP', languages: ['ja-JP', 'ja'], acceptLanguage: 'ja-JP,ja;q=0.9' },
  });

  const isoMs = Date.UTC(2024, 0, 15, 12, 0, 0);
  const actual = vm.runInContext(`new Date(${isoMs}).toLocaleDateString()`, sandbox);
  const expected = new Date(isoMs).toLocaleDateString('ja-JP');
  assert.equal(actual, expected);
});

test('toLocaleString applies the spoofed timeZone even when languageSpoof is off', () => {
  const sandbox = loadInjectorInSandbox();
  dispatchPayload(sandbox, {
    location: null,
    timezone: 'Asia/Tokyo', // timezoneSpoof ON
    locale: null, // languageSpoof OFF
  });

  const isoMs = Date.UTC(2024, 0, 15, 12, 0, 0);
  const actual = vm.runInContext(`new Date(${isoMs}).toLocaleString()`, sandbox);
  const expected = new Date(isoMs).toLocaleString(undefined, { timeZone: 'Asia/Tokyo' });
  assert.equal(actual, expected);
});

test('toLocaleString applies both spoofed locale and timeZone together', () => {
  const sandbox = loadInjectorInSandbox();
  dispatchPayload(sandbox, {
    location: null,
    timezone: 'Asia/Tokyo',
    locale: { language: 'ja-JP', languages: ['ja-JP', 'ja'], acceptLanguage: 'ja-JP,ja;q=0.9' },
  });

  const isoMs = Date.UTC(2024, 0, 15, 12, 0, 0);
  const actual = vm.runInContext(`new Date(${isoMs}).toLocaleString()`, sandbox);
  const expected = new Date(isoMs).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  assert.equal(actual, expected);
});

test('an explicit caller-supplied locale always wins over the spoofed default', () => {
  const sandbox = loadInjectorInSandbox();
  dispatchPayload(sandbox, {
    location: null,
    timezone: null,
    locale: { language: 'ja-JP', languages: ['ja-JP', 'ja'], acceptLanguage: 'ja-JP,ja;q=0.9' },
  });

  const isoMs = Date.UTC(2024, 0, 15, 12, 0, 0);
  const actual = vm.runInContext(`new Date(${isoMs}).toLocaleDateString('fr-FR')`, sandbox);
  const expected = new Date(isoMs).toLocaleDateString('fr-FR');
  assert.equal(actual, expected);
});
