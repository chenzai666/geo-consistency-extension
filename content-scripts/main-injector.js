/**
 * MAIN world, document_start.
 *
 * Runs in the page's own JS realm, before any page script (inline or
 * external) executes. Patches the handful of web-platform APIs that leak a
 * browser's geolocation/timezone/locale so they stay consistent with the
 * profile the background service worker derived from the current egress IP.
 *
 * Receives that profile from content-scripts/isolated-bridge.js (the only
 * script with chrome.storage access) via a CustomEvent on `document` — this
 * script never talks to chrome.* directly and never reads page content.
 *
 * KNOWN LIMITATION: chrome.storage is asynchronous even though this script
 * patches synchronously. Synchronous getters (navigator.language, Intl
 * default locale/timeZone, Date.prototype.getTimezoneOffset) fall back to
 * the real native value until the isolated bridge's storage read resolves
 * and dispatches the payload event — typically within a few milliseconds,
 * before most page scripts run, but not guaranteed for a script that reads
 * these values in its very first synchronous tick. This is a fundamental
 * constraint of MV3's async storage API, not a bug.
 */
(function () {
  'use strict';

  const EVENT_NAME = '__geoConsistencyPayload__';
  const PAYLOAD_WAIT_TIMEOUT_MS = 4000;

  /** @type {{location: object|null, timezone: string|null, locale: object|null}|null} */
  let payload = null;
  let payloadReady = false;
  /** @type {Array<(p: typeof payload) => void>} */
  const waiters = [];

  document.addEventListener(
    EVENT_NAME,
    (event) => {
      payload = event.detail || null;
      payloadReady = true;
      const toRun = waiters.splice(0, waiters.length);
      toRun.forEach((fn) => fn(payload));
    },
    false
  );

  function onPayload(callback) {
    if (payloadReady) {
      callback(payload);
      return;
    }
    const timer = setTimeout(() => {
      const idx = waiters.indexOf(entry);
      if (idx !== -1) waiters.splice(idx, 1);
      callback(payload);
    }, PAYLOAD_WAIT_TIMEOUT_MS);
    const entry = (p) => {
      clearTimeout(timer);
      callback(p);
    };
    waiters.push(entry);
  }

  // ---------------------------------------------------------------------
  // Shared DST-aware timezone offset math.
  // Kept byte-for-byte equivalent to lib/tz.js#getTimezoneOffsetForZone —
  // tests/injector-tz-sync.test.js extracts this block and cross-checks it
  // against the lib implementation across a matrix of dates/zones.
  // ---------------------------------------------------------------------
  // TZ_FORMULA_START
  function tzOffsetForZone(date, timeZone) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return NaN;
    if (!timeZone || typeof timeZone !== 'string') return NaN;

    let parts;
    try {
      parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).formatToParts(date);
    } catch {
      return NaN;
    }

    const map = {};
    for (const { type, value } of parts) map[type] = value;
    const hour = map.hour === '24' ? '00' : map.hour;

    const asUTC = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(hour),
      Number(map.minute),
      Number(map.second)
    );

    return Math.round((date.getTime() - asUTC) / 60000);
  }
  // TZ_FORMULA_END

  // ---------------------------------------------------------------------
  // navigator.geolocation
  // ---------------------------------------------------------------------
  (function patchGeolocation() {
    const geo = navigator.geolocation;
    if (!geo) return;

    const nativeGetCurrentPosition = geo.getCurrentPosition.bind(geo);
    const nativeWatchPosition = geo.watchPosition.bind(geo);
    const nativeClearWatch = geo.clearWatch.bind(geo);

    let nextWatchId = 1;
    const watches = new Map();

    function buildPosition(loc) {
      return {
        coords: {
          latitude: loc.latitude,
          longitude: loc.longitude,
          accuracy: loc.accuracy,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
          toJSON() {
            return { ...this };
          },
        },
        timestamp: Date.now(),
        toJSON() {
          return { coords: this.coords, timestamp: this.timestamp };
        },
      };
    }

    Object.defineProperty(geo, 'getCurrentPosition', {
      configurable: true,
      writable: true,
      value: function (successCallback, errorCallback, options) {
        onPayload((p) => {
          if (!p || !p.location) {
            nativeGetCurrentPosition(successCallback, errorCallback, options);
            return;
          }
          try {
            successCallback(buildPosition(p.location));
          } catch {
            /* ignore, matches native fire-and-forget callback semantics */
          }
        });
      },
    });

    Object.defineProperty(geo, 'watchPosition', {
      configurable: true,
      writable: true,
      value: function (successCallback, errorCallback, options) {
        const id = nextWatchId++;
        onPayload((p) => {
          if (!p || !p.location) {
            const nativeId = nativeWatchPosition(successCallback, errorCallback, options);
            watches.set(id, { nativeId });
            return;
          }
          successCallback(buildPosition(p.location));
          const intervalMs = Math.max(1000, (options && options.maximumAge) || 10000);
          const timer = setInterval(() => successCallback(buildPosition(p.location)), intervalMs);
          watches.set(id, { timer });
        });
        return id;
      },
    });

    Object.defineProperty(geo, 'clearWatch', {
      configurable: true,
      writable: true,
      value: function (id) {
        const entry = watches.get(id);
        if (!entry) return;
        if (entry.timer) clearInterval(entry.timer);
        if (entry.nativeId != null) nativeClearWatch(entry.nativeId);
        watches.delete(id);
      },
    });
  })();

  // ---------------------------------------------------------------------
  // navigator.permissions.query({ name: 'geolocation' })
  // ---------------------------------------------------------------------
  (function patchPermissions() {
    const permissionsProto = window.Permissions && window.Permissions.prototype;
    if (!permissionsProto || !navigator.permissions) return;

    const nativeQuery = permissionsProto.query.bind(navigator.permissions);

    function buildFakeGeolocationStatus() {
      const target = new EventTarget();
      Object.defineProperty(target, 'state', { value: 'granted', enumerable: true });
      Object.defineProperty(target, 'name', { value: 'geolocation', enumerable: true });
      target.onchange = null;
      return target;
    }

    Object.defineProperty(permissionsProto, 'query', {
      configurable: true,
      writable: true,
      value: function (descriptor) {
        if (descriptor && descriptor.name === 'geolocation') {
          return new Promise((resolve, reject) => {
            onPayload((p) => {
              if (p && p.location) {
                resolve(buildFakeGeolocationStatus());
              } else {
                nativeQuery(descriptor).then(resolve, reject);
              }
            });
          });
        }
        return nativeQuery(descriptor);
      },
    });
  })();

  // ---------------------------------------------------------------------
  // Date.prototype.getTimezoneOffset (+ toLocale*String family, for
  // internal consistency with the Intl.DateTimeFormat patch below)
  // ---------------------------------------------------------------------
  (function patchDate() {
    const nativeGetTimezoneOffset = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = function () {
      if (payload && payload.timezone) {
        const offset = tzOffsetForZone(this, payload.timezone);
        if (!Number.isNaN(offset)) return offset;
      }
      return nativeGetTimezoneOffset.call(this);
    };

    const NativeDTF = Intl.DateTimeFormat;
    const nativeToLocaleString = Date.prototype.toLocaleString;
    const nativeToLocaleDateString = Date.prototype.toLocaleDateString;
    const nativeToLocaleTimeString = Date.prototype.toLocaleTimeString;

    function withZone(fn) {
      return function (locales, options) {
        if (payload && payload.timezone) {
          const merged = { ...(options || {}) };
          if (!merged.timeZone) merged.timeZone = payload.timezone;
          return fn.call(this, locales, merged);
        }
        return fn.call(this, locales, options);
      };
    }

    Date.prototype.toLocaleString = withZone(nativeToLocaleString);
    Date.prototype.toLocaleDateString = withZone(nativeToLocaleDateString);
    Date.prototype.toLocaleTimeString = withZone(nativeToLocaleTimeString);
    void NativeDTF; // referenced for clarity; construction happens in patchIntl()
  })();

  // ---------------------------------------------------------------------
  // Intl.DateTimeFormat / Intl.NumberFormat / Intl.Collator default locale
  // (+ default timeZone for DateTimeFormat)
  // ---------------------------------------------------------------------
  (function patchIntl() {
    const NativeDateTimeFormat = Intl.DateTimeFormat;
    const NativeNumberFormat = Intl.NumberFormat;
    const NativeCollator = Intl.Collator;

    function defaultLocales(explicitLocales) {
      if (explicitLocales !== undefined) return explicitLocales;
      return payload && payload.locale ? payload.locale.languages : undefined;
    }

    function PatchedDateTimeFormat(locales, options) {
      const finalOptions = { ...(options || {}) };
      if (!finalOptions.timeZone && payload && payload.timezone) {
        finalOptions.timeZone = payload.timezone;
      }
      return new NativeDateTimeFormat(defaultLocales(locales), finalOptions);
    }
    PatchedDateTimeFormat.prototype = NativeDateTimeFormat.prototype;
    PatchedDateTimeFormat.supportedLocalesOf = NativeDateTimeFormat.supportedLocalesOf.bind(NativeDateTimeFormat);

    function PatchedNumberFormat(locales, options) {
      return new NativeNumberFormat(defaultLocales(locales), options);
    }
    PatchedNumberFormat.prototype = NativeNumberFormat.prototype;
    PatchedNumberFormat.supportedLocalesOf = NativeNumberFormat.supportedLocalesOf.bind(NativeNumberFormat);

    function PatchedCollator(locales, options) {
      return new NativeCollator(defaultLocales(locales), options);
    }
    PatchedCollator.prototype = NativeCollator.prototype;
    PatchedCollator.supportedLocalesOf = NativeCollator.supportedLocalesOf.bind(NativeCollator);

    Object.defineProperty(Intl, 'DateTimeFormat', { configurable: true, writable: true, value: PatchedDateTimeFormat });
    Object.defineProperty(Intl, 'NumberFormat', { configurable: true, writable: true, value: PatchedNumberFormat });
    Object.defineProperty(Intl, 'Collator', { configurable: true, writable: true, value: PatchedCollator });
  })();

  // ---------------------------------------------------------------------
  // navigator.language / navigator.languages
  // ---------------------------------------------------------------------
  (function patchNavigatorLanguage() {
    const proto = Object.getPrototypeOf(navigator);

    const languageDesc = Object.getOwnPropertyDescriptor(proto, 'language');
    const languagesDesc = Object.getOwnPropertyDescriptor(proto, 'languages');
    if (!languageDesc || !languagesDesc) return;

    const nativeLanguageGet = languageDesc.get.bind(navigator);
    const nativeLanguagesGet = languagesDesc.get.bind(navigator);

    Object.defineProperty(proto, 'language', {
      configurable: true,
      enumerable: languageDesc.enumerable,
      get() {
        if (payload && payload.locale) return payload.locale.language;
        return nativeLanguageGet();
      },
    });

    Object.defineProperty(proto, 'languages', {
      configurable: true,
      enumerable: languagesDesc.enumerable,
      get() {
        if (payload && payload.locale) return Object.freeze(payload.locale.languages.slice());
        return nativeLanguagesGet();
      },
    });
  })();
})();
