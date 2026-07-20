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

  /**
   * Like onPayload, but keeps calling back on every later payload update too
   * (settings toggled in the popup, IP refreshed, or — if the first payload
   * hadn't arrived yet — the real payload finally showing up after the
   * fallback timeout already fired once with null). Used by watchPosition so
   * a long-lived subscription can migrate between native and spoofed mode
   * instead of getting stuck with whatever was true at subscribe time.
   * @returns {() => void} unsubscribe
   */
  function onEveryPayload(callback) {
    let fired = false;
    const timer = payloadReady
      ? null
      : setTimeout(() => {
          if (!fired) {
            fired = true;
            callback(payload);
          }
        }, PAYLOAD_WAIT_TIMEOUT_MS);

    const listener = () => {
      fired = true;
      if (timer) clearTimeout(timer);
      callback(payload);
    };
    document.addEventListener(EVENT_NAME, listener, false);

    if (payloadReady) {
      fired = true;
      callback(payload);
    }

    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener(EVENT_NAME, listener);
    };
  }

  /**
   * Shared default-`locales` resolution: an explicit argument always wins,
   * otherwise falls back to the spoofed locale's language list (or
   * `undefined`, i.e. the real native default, if language spoofing is off).
   * Used independently of timezone spoofing by both patchIntl() and
   * patchDate()'s withZone() below, matching how the languageSpoof and
   * timezoneSpoof toggles are meant to work independently of each other.
   */
  function defaultLocales(explicitLocales) {
    if (explicitLocales !== undefined) return explicitLocales;
    return payload && payload.locale ? payload.locale.languages : undefined;
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

    // options.maximumAge means "how stale a cached position may be", not a
    // polling period — it is intentionally ignored here in favor of a fixed
    // poll interval matching the native default staleness expectation.
    const SPOOFED_POLL_INTERVAL_MS = 10000;

    Object.defineProperty(geo, 'watchPosition', {
      configurable: true,
      writable: true,
      value: function (successCallback, errorCallback, options) {
        const id = nextWatchId++;
        let mode = null; // 'native' | 'spoofed'
        let nativeId = null;
        let pollTimer = null;

        function stopNative() {
          if (nativeId != null) {
            nativeClearWatch(nativeId);
            nativeId = null;
          }
        }
        function stopSpoofed() {
          if (pollTimer != null) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        }

        // Re-evaluated on every payload update (not just once at subscribe
        // time) so toggling "spoof location" in the popup, refreshing the
        // egress IP, or a late-arriving first payload after the fallback
        // timeout all migrate an already-active watch to the right mode.
        function applyMode(p) {
          const shouldSpoof = !!(p && p.location);
          if (shouldSpoof && mode !== 'spoofed') {
            stopNative();
            mode = 'spoofed';
            successCallback(buildPosition(p.location));
            pollTimer = setInterval(() => {
              if (payload && payload.location) successCallback(buildPosition(payload.location));
            }, SPOOFED_POLL_INTERVAL_MS);
          } else if (!shouldSpoof && mode !== 'native') {
            stopSpoofed();
            mode = 'native';
            nativeId = nativeWatchPosition(successCallback, errorCallback, options);
          }
        }

        const unsubscribe = onEveryPayload(applyMode);
        watches.set(id, {
          stop() {
            unsubscribe();
            stopNative();
            stopSpoofed();
          },
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
        entry.stop();
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

    // Date.prototype.toLocaleString & co. are spec'd against the original
    // %DateTimeFormat% intrinsic, not the mutable `Intl.DateTimeFormat`
    // binding — patching that constructor (see patchIntl() below) has no
    // effect on these methods, which is why they need their own patch here.
    // locales and timeZone are resolved independently of each other so the
    // languageSpoof and timezoneSpoof toggles keep working independently,
    // same as Intl.DateTimeFormat's own behavior.
    function withZone(fn) {
      return function (locales, options) {
        const finalLocales = defaultLocales(locales);
        let finalOptions = options;
        if (payload && payload.timezone) {
          finalOptions = { ...(options || {}) };
          if (!finalOptions.timeZone) finalOptions.timeZone = payload.timezone;
        }
        return fn.call(this, finalLocales, finalOptions);
      };
    }

    Date.prototype.toLocaleString = withZone(nativeToLocaleString);
    Date.prototype.toLocaleDateString = withZone(nativeToLocaleDateString);
    Date.prototype.toLocaleTimeString = withZone(nativeToLocaleTimeString);
    void NativeDTF; // referenced for clarity; construction happens in patchIntl()
  })();

  // ---------------------------------------------------------------------
  // Intl.* default locale (+ default timeZone for DateTimeFormat).
  // Covers every Intl constructor that resolves a default locale from the
  // environment when called without an explicit `locales` argument.
  // ---------------------------------------------------------------------
  (function patchIntl() {
    const NativeDateTimeFormat = Intl.DateTimeFormat;

    function PatchedDateTimeFormat(locales, options) {
      const finalOptions = { ...(options || {}) };
      if (!finalOptions.timeZone && payload && payload.timezone) {
        finalOptions.timeZone = payload.timezone;
      }
      return new NativeDateTimeFormat(defaultLocales(locales), finalOptions);
    }
    PatchedDateTimeFormat.prototype = NativeDateTimeFormat.prototype;
    PatchedDateTimeFormat.supportedLocalesOf = NativeDateTimeFormat.supportedLocalesOf.bind(NativeDateTimeFormat);
    Object.defineProperty(Intl, 'DateTimeFormat', { configurable: true, writable: true, value: PatchedDateTimeFormat });

    // NumberFormat/Collator/Segmenter/PluralRules/ListFormat/RelativeTimeFormat
    // all share the same shape: pass through options untouched, only patch
    // the default-locale resolution. RelativeTimeFormat/Segmenter aren't in
    // every runtime, so each lookup is guarded.
    ['NumberFormat', 'Collator', 'Segmenter', 'PluralRules', 'ListFormat', 'RelativeTimeFormat'].forEach(
      (name) => {
        const Native = Intl[name];
        if (typeof Native !== 'function') return;

        function Patched(locales, options) {
          return new Native(defaultLocales(locales), options);
        }
        Patched.prototype = Native.prototype;
        if (typeof Native.supportedLocalesOf === 'function') {
          Patched.supportedLocalesOf = Native.supportedLocalesOf.bind(Native);
        }
        Object.defineProperty(Intl, name, { configurable: true, writable: true, value: Patched });
      }
    );
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
