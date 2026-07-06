/**
 * IP geolocation provider registry + fallback orchestration.
 *
 * Each provider entry has:
 *   - id: string
 *   - buildUrl(opts): string           (opts = { ipinfoToken })
 *   - parse(rawJson): NormalizedGeo | null   (null => treat as unusable, try next provider)
 *
 * NormalizedGeo shape:
 *   { ip, countryCode, country, region, city, lat, lon, isp, timezone, providerId }
 *
 * This module has no chrome.* dependency so it can be unit tested directly
 * under Node, and is imported by background/service-worker.js at runtime.
 */

function num(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * A parsed result is only usable if it has enough fields to build a
 * meaningful override (coordinates + timezone at minimum).
 */
function isUsable(geo) {
  return !!geo && num(geo.lat) !== null && num(geo.lon) !== null && str(geo.timezone);
}

export const PROVIDERS = [
  {
    id: 'ipapi.co',
    buildUrl: () => 'https://ipapi.co/json/',
    parse: (json) => {
      if (!json || json.error) return null;
      const geo = {
        ip: str(json.ip),
        countryCode: str(json.country_code) || str(json.country),
        country: str(json.country_name),
        region: str(json.region),
        city: str(json.city),
        lat: num(json.latitude),
        lon: num(json.longitude),
        isp: str(json.org),
        timezone: str(json.timezone),
        providerId: 'ipapi.co',
      };
      return isUsable(geo) ? geo : null;
    },
  },
  {
    id: 'ipwho.is',
    buildUrl: () => 'https://ipwho.is/',
    parse: (json) => {
      if (!json || json.success === false) return null;
      const geo = {
        ip: str(json.ip),
        countryCode: str(json.country_code),
        country: str(json.country),
        region: str(json.region),
        city: str(json.city),
        lat: num(json.latitude),
        lon: num(json.longitude),
        isp: str(json.connection?.isp) || str(json.connection?.org),
        timezone: str(json.timezone?.id),
        providerId: 'ipwho.is',
      };
      return isUsable(geo) ? geo : null;
    },
  },
  {
    id: 'freeipapi.com',
    buildUrl: () => 'https://freeipapi.com/api/json',
    parse: (json) => {
      if (!json) return null;
      const geo = {
        ip: str(json.ipAddress),
        countryCode: str(json.countryCode),
        country: str(json.countryName),
        region: str(json.regionName),
        city: str(json.cityName),
        lat: num(json.latitude),
        lon: num(json.longitude),
        isp: null, // provider does not return ISP/org
        timezone: str(json.timeZone),
        providerId: 'freeipapi.com',
      };
      return isUsable(geo) ? geo : null;
    },
  },
  {
    id: 'ipinfo.io',
    // ipinfo.io works token-less at low rate limits; token (if provided by
    // the user in the popup) is appended for a higher quota. Never sent
    // anywhere except ipinfo.io itself, and only if the user opted in.
    buildUrl: (opts) => {
      const token = opts && str(opts.ipinfoToken);
      return `https://ipinfo.io/json${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    },
    parse: (json) => {
      if (!json || json.bogon) return null;
      const [lat, lon] = str(json.loc) ? json.loc.split(',').map(Number) : [null, null];
      const geo = {
        ip: str(json.ip),
        countryCode: str(json.country),
        country: str(json.country),
        region: str(json.region),
        city: str(json.city),
        lat: num(lat),
        lon: num(lon),
        isp: str(json.org),
        timezone: str(json.timezone),
        providerId: 'ipinfo.io',
      };
      return isUsable(geo) ? geo : null;
    },
  },
];

/**
 * Tries each provider in order until one returns a usable normalized result.
 *
 * @param {object} opts
 * @param {typeof fetch} opts.fetchImpl injectable fetch (for tests), defaults to global fetch
 * @param {number} opts.timeoutMs per-provider timeout, default 6000
 * @param {string} [opts.ipinfoToken] optional user-supplied token, local only
 * @param {Array} [opts.providers] override provider list (for tests)
 * @returns {Promise<{geo: object, providerId: string} | null>}
 */
export async function fetchEgressGeo(opts = {}) {
  const providers = opts.providers || PROVIDERS;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 6000;

  for (const provider of providers) {
    try {
      const url = provider.buildUrl({ ipinfoToken: opts.ipinfoToken });
      const json = await fetchJsonWithTimeout(fetchImpl, url, timeoutMs);
      const geo = provider.parse(json);
      if (geo) return { geo, providerId: provider.id };
    } catch {
      // swallow and fall through to next provider
    }
  }
  return null;
}

async function fetchJsonWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
