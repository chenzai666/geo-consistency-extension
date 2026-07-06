# Geo-Locale Consistency

A Chrome MV3 extension that keeps the browser's *visible* regional signals —
geolocation, timezone, and language — consistent with wherever your traffic
is currently egressing from. It exists to fix the common "VPN in Tokyo, but
`Intl.DateTimeFormat().resolvedOptions().timeZone` still says
`America/New_York`" mismatch, which is itself a fingerprinting/inconsistency
signal.

## How it works

1. **Egress detection** (`lib/providers.js`, `background/service-worker.js`):
   the background service worker asks a chain of IP-geolocation providers
   (`ipapi.co` → `ipwho.is` → `freeipapi.com` → `ipinfo.io`) who they think you
   are, using the first one that returns a usable result. Country code,
   city/region/country, latitude/longitude, ISP, and IANA timezone are kept
   from whichever provider answered.
2. **Residential coordinate resolution** (`lib/overpass.js`): the raw
   provider lat/lon is usually a datacenter or ISP office, not a home address.
   Before using it, the extension queries OpenStreetMap's Overpass API for
   `highway=residential` roads near that point and picks a coordinate along
   one of them. If Overpass is unreachable or has no data nearby, it falls
   back to a uniformly-distributed random jitter within the configured
   accuracy radius (never the raw centroid).
3. **Locale inference** (`lib/locale.js`): country code + IANA timezone
   (as a tiebreaker for multilingual countries, e.g. `CA`/`CH`) map to a
   `navigator.language` / `navigator.languages` / `Accept-Language` bundle
   from a static offline table.
4. **Applying it to the page** (`content-scripts/`): an ISOLATED-world
   "bridge" script reads the computed profile from `chrome.storage.local`
   (the only place with access to it) and republishes it as a `CustomEvent`
   on `document`. A MAIN-world "injector" script, running at
   `document_start` — before any page script — listens for that event and
   patches the platform APIs that leak location/timezone/locale.
5. **Outgoing `Accept-Language` header**: a `declarativeNetRequest` dynamic
   rule rewrites the `Accept-Language` request header to match, but only
   while the language toggle is on.

## What gets patched

| API | Behavior |
|---|---|
| `navigator.geolocation.getCurrentPosition` / `watchPosition` / `clearWatch` | Returns the resolved residential coordinate instead of the real GPS/Wi-Fi position; falls through to the native implementation when location spoofing is off. |
| `navigator.permissions.query({name:'geolocation'})` | Reports `granted` when location spoofing is active; otherwise delegates to the native check. |
| `Date.prototype.getTimezoneOffset` | DST-aware: recomputed per calling `Date` instance against the target IANA zone (not a single cached offset), via `Intl.DateTimeFormat.formatToParts`. |
| `Date.prototype.toLocaleString/toLocaleDateString/toLocaleTimeString` | Default to the spoofed timezone when the caller didn't pass an explicit `timeZone` option, for internal consistency with the point below. |
| `Intl.DateTimeFormat` (constructor default + `resolvedOptions().timeZone`) | Defaults `timeZone` to the spoofed zone and `locales` to the spoofed language list when the caller didn't specify either — implemented by forwarding to the *real* native constructor with injected defaults, so the returned object is a genuine `Intl.DateTimeFormat` instance, not a fake shim. |
| `Intl.NumberFormat`, `Intl.Collator` (default locale) | Same forwarding-with-injected-defaults technique, locale only. |
| `navigator.language` / `navigator.languages` | Overridden getters on the `Navigator` prototype. |

## Known limitation: the synchronous-API race window

`chrome.storage.local` is asynchronous even though several of the patched
getters (`navigator.language`, `Date.prototype.getTimezoneOffset`,
`Intl.DateTimeFormat` defaults) are synchronous. The MAIN-world injector
patches these functions immediately at `document_start`, but the *values*
they should return only arrive once the ISOLATED bridge's `chrome.storage`
read resolves and dispatches its event — typically within a few
milliseconds, and normally before the page's own scripts run, but this is
not a hard guarantee for a script that reads these values in its very first
synchronous tick. Until the payload arrives, these getters fall back to the
real, un-spoofed value. This is a structural limitation of MV3's async
storage API, not a bug, and is called out here rather than papered over.

Async APIs (`getCurrentPosition`, `watchPosition`, `permissions.query`) don't
have this problem — they simply wait for the payload before resolving, which
is indistinguishable from ordinary GPS/network latency.

## Privacy model

- **No telemetry, no analytics, no accounts, no remote config.** The
  extension does not phone home to any server operated by its developer —
  there isn't one.
- **No page content is read.** The MAIN-world injector only patches function
  references; it never inspects the DOM, page scripts, or page-supplied
  data. The ISOLATED-world bridge only reads `chrome.storage.local` and
  writes one `CustomEvent`.
- **Storage is 100% local.** Every setting and every derived value (IP,
  location, timezone, locale, ISP) lives in `chrome.storage.local` only.
  Nothing uses `chrome.storage.sync`, cookies, or any server-side store.
- **The only outbound network requests** this extension makes are:
  - to the IP-geolocation providers listed above, to learn the current
    egress IP's country/city/coordinates/ISP/timezone;
  - to OpenStreetMap's Overpass API, to find a plausible residential
    coordinate near that point.
  Both are necessary to compute the override values and match what a real
  site could already infer about your network position from your IP address
  alone — this extension does not increase what's learnable about you from a
  connecting server's point of view; it makes the browser's own
  self-reported signals consistent with it.
- **The optional `ipinfo.io` token** is entered by the user in the popup,
  stored only in `chrome.storage.local`, and only ever sent to `ipinfo.io`
  itself as a query parameter on requests the extension already makes to
  that provider.

## Settings (popup)

- Toggle location / timezone / language spoofing independently.
- Accuracy preset (precise ~100m / balanced ~500m / city ~3000m) — also
  controls the Overpass search radius and the jitter fallback radius.
- Refresh interval (minutes) for automatic re-detection via `chrome.alarms`.
- Optional `ipinfo.io` token for a higher provider rate limit.
- Manual "refresh now" button.

## Development

```sh
npm test
```

Runs the Node test suite (`node --test`) covering:

- DST-aware timezone offset math, including spring-forward/fall-back edge
  instants and southern-hemisphere-inverted DST (`tests/tz.test.js`), plus a
  cross-check that the formula inlined into the MAIN-world content script
  (which can't `import` — see below) stays byte-for-byte equivalent to the
  tested `lib/tz.js` implementation (`tests/injector-tz-sync.test.js`).
- Locale bundle inference, including multilingual-country timezone
  disambiguation and header formatting (`tests/locale.test.js`).
- Provider response parsing and fallback ordering for all four IP
  geolocation providers (`tests/providers.test.js`).
- Overpass query construction, response parsing, and jitter fallback
  geometry (`tests/overpass.test.js`).
- Manifest content-script injection order — the MAIN-world injector must be
  declared before the ISOLATED-world bridge so its event listener exists
  before the bridge dispatches (`tests/manifest.test.js`).
- Settings normalization and the declarativeNetRequest rule builder
  (`tests/storage-and-dnr.test.js`).

### Why `content-scripts/main-injector.js` doesn't `import` from `lib/`

Content scripts registered via `manifest.json`'s `content_scripts` array run
as classic (non-module) scripts and can't statically `import` other files,
so the small DST-aware offset formula is inlined there directly rather than
shared via a bundler. `tests/injector-tz-sync.test.js` extracts that inlined
copy (between `// TZ_FORMULA_START`/`END` markers) and runs it against the
same test matrix as `lib/tz.js`, so the two can't silently drift apart.

## Loading the extension

1. `chrome://extensions` → enable Developer Mode.
2. "Load unpacked" → select this directory.
3. Open the popup to configure toggles/accuracy/refresh interval, then hit
   refresh (or wait for the automatic first refresh on install).
