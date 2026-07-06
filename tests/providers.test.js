import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, fetchEgressGeo } from '../lib/providers.js';

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

test('ipapi.co parser normalizes a successful response', () => {
  const provider = PROVIDERS.find((p) => p.id === 'ipapi.co');
  const geo = provider.parse({
    ip: '1.2.3.4',
    country_code: 'DE',
    country_name: 'Germany',
    region: 'Berlin',
    city: 'Berlin',
    latitude: 52.52,
    longitude: 13.405,
    org: 'Example ISP',
    timezone: 'Europe/Berlin',
  });
  assert.deepEqual(geo, {
    ip: '1.2.3.4',
    countryCode: 'DE',
    country: 'Germany',
    region: 'Berlin',
    city: 'Berlin',
    lat: 52.52,
    lon: 13.405,
    isp: 'Example ISP',
    timezone: 'Europe/Berlin',
    providerId: 'ipapi.co',
  });
});

test('ipapi.co parser rejects an error response', () => {
  const provider = PROVIDERS.find((p) => p.id === 'ipapi.co');
  assert.equal(provider.parse({ error: true, reason: 'rate limited' }), null);
});

test('ipwho.is parser reads nested connection.isp and timezone.id', () => {
  const provider = PROVIDERS.find((p) => p.id === 'ipwho.is');
  const geo = provider.parse({
    success: true,
    ip: '5.6.7.8',
    country_code: 'FR',
    country: 'France',
    region: 'Ile-de-France',
    city: 'Paris',
    latitude: 48.85,
    longitude: 2.35,
    connection: { isp: 'Some Telecom' },
    timezone: { id: 'Europe/Paris' },
  });
  assert.equal(geo.isp, 'Some Telecom');
  assert.equal(geo.timezone, 'Europe/Paris');
});

test('ipwho.is parser rejects success:false', () => {
  const provider = PROVIDERS.find((p) => p.id === 'ipwho.is');
  assert.equal(provider.parse({ success: false, message: 'invalid ip' }), null);
});

test('freeipapi.com parser has no ISP field but is still usable', () => {
  const provider = PROVIDERS.find((p) => p.id === 'freeipapi.com');
  const geo = provider.parse({
    ipAddress: '9.9.9.9',
    countryCode: 'JP',
    countryName: 'Japan',
    regionName: 'Tokyo',
    cityName: 'Tokyo',
    latitude: 35.68,
    longitude: 139.69,
    timeZone: 'Asia/Tokyo',
  });
  assert.equal(geo.isp, null);
  assert.equal(geo.timezone, 'Asia/Tokyo');
});

test('ipinfo.io parser splits the "lat,lon" loc string and appends token to URL only when provided', () => {
  const provider = PROVIDERS.find((p) => p.id === 'ipinfo.io');
  const geo = provider.parse({
    ip: '1.1.1.1',
    country: 'US',
    region: 'California',
    city: 'Mountain View',
    loc: '37.3861,-122.0839',
    org: 'AS15169 Google LLC',
    timezone: 'America/Los_Angeles',
  });
  assert.equal(geo.lat, 37.3861);
  assert.equal(geo.lon, -122.0839);

  assert.equal(provider.buildUrl({}), 'https://ipinfo.io/json');
  assert.equal(
    provider.buildUrl({ ipinfoToken: 'secret-token' }),
    'https://ipinfo.io/json?token=secret-token'
  );
});

test('a provider missing coordinates or timezone is treated as unusable', () => {
  const provider = PROVIDERS.find((p) => p.id === 'ipapi.co');
  assert.equal(
    provider.parse({ ip: '1.2.3.4', country_code: 'DE', latitude: 52.5 /* no longitude, no tz */ }),
    null
  );
});

test('fetchEgressGeo falls back to the next provider on failure', async () => {
  let calls = 0;
  const fakeFetch = async (url) => {
    calls += 1;
    const host = new URL(url).hostname;
    if (host === 'ipapi.co') throw new Error('network error');
    if (host === 'ipwho.is') return jsonResponse({ success: false });
    if (host === 'freeipapi.com') {
      return jsonResponse({
        ipAddress: '9.9.9.9',
        countryCode: 'JP',
        countryName: 'Japan',
        regionName: 'Tokyo',
        cityName: 'Tokyo',
        latitude: 35.68,
        longitude: 139.69,
        timeZone: 'Asia/Tokyo',
      });
    }
    throw new Error('unexpected provider reached');
  };

  const result = await fetchEgressGeo({ fetchImpl: fakeFetch });
  assert.equal(result.providerId, 'freeipapi.com');
  assert.equal(result.geo.city, 'Tokyo');
  assert.equal(calls, 3);
});

test('fetchEgressGeo returns null when every provider fails', async () => {
  const fakeFetch = async () => jsonResponse({}, false, 500);
  const result = await fetchEgressGeo({ fetchImpl: fakeFetch });
  assert.equal(result, null);
});

test('fetchEgressGeo stops at the first usable provider', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return jsonResponse({
      ip: '1.2.3.4',
      country_code: 'DE',
      country_name: 'Germany',
      city: 'Berlin',
      latitude: 52.52,
      longitude: 13.405,
      org: 'ISP',
      timezone: 'Europe/Berlin',
    });
  };
  const result = await fetchEgressGeo({ fetchImpl: fakeFetch });
  assert.equal(result.providerId, 'ipapi.co');
  assert.equal(calls, 1);
});
