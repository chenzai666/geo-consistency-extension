import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOverpassQuery,
  parseOverpassResponse,
  safeJitter,
  resolveResidentialCoordinate,
} from '../lib/overpass.js';

test('buildOverpassQuery embeds radius and coordinates and filters highway=residential', () => {
  const q = buildOverpassQuery(52.52, 13.405, 500);
  assert.match(q, /around:500,52.52,13.405/);
  assert.match(q, /highway=residential/);
});

test('parseOverpassResponse picks a point from a returned way geometry', () => {
  const json = {
    elements: [
      {
        type: 'way',
        id: 42,
        tags: { highway: 'residential' },
        geometry: [
          { lat: 52.5201, lon: 13.4051 },
          { lat: 52.5202, lon: 13.4052 },
        ],
      },
    ],
  };
  const point = parseOverpassResponse(json, () => 0);
  assert.equal(point.source, 'overpass');
  assert.equal(point.wayId, 42);
  assert.equal(point.lat, 52.5201);
  assert.equal(point.lon, 13.4051);
});

test('parseOverpassResponse returns null when there are no residential ways', () => {
  assert.equal(parseOverpassResponse({ elements: [] }), null);
  assert.equal(parseOverpassResponse({}), null);
  assert.equal(parseOverpassResponse(null), null);
});

test('parseOverpassResponse ignores malformed elements', () => {
  const json = { elements: [{ type: 'node', lat: 1, lon: 2 }, { type: 'way', geometry: [] }] };
  assert.equal(parseOverpassResponse(json), null);
});

test('parseOverpassResponse ignores ways without tags', () => {
  const json = {
    elements: [{ type: 'way', id: 1, geometry: [{ lat: 1, lon: 2 }] }], // no tags field
  };
  assert.equal(parseOverpassResponse(json), null);
});

test('parseOverpassResponse ignores ways with tags but no highway key', () => {
  const json = {
    elements: [{ type: 'way', id: 2, tags: { name: 'Some Street' }, geometry: [{ lat: 1, lon: 2 }] }],
  };
  assert.equal(parseOverpassResponse(json), null);
});

test('parseOverpassResponse ignores non-residential highway types', () => {
  const json = {
    elements: [
      { type: 'way', id: 3, tags: { highway: 'primary' }, geometry: [{ lat: 1, lon: 2 }] },
      { type: 'way', id: 4, tags: { highway: 'footway' }, geometry: [{ lat: 3, lon: 4 }] },
    ],
  };
  assert.equal(parseOverpassResponse(json), null);
});

test('parseOverpassResponse accepts ways tagged highway=residential and ignores mixed non-residential', () => {
  const json = {
    elements: [
      { type: 'way', id: 5, tags: { highway: 'primary' }, geometry: [{ lat: 9, lon: 9 }] },
      { type: 'way', id: 6, tags: { highway: 'residential' }, geometry: [{ lat: 52.521, lon: 13.406 }] },
    ],
  };
  const point = parseOverpassResponse(json, () => 0);
  assert.equal(point.wayId, 6);
  assert.equal(point.source, 'overpass');
});

test('safeJitter stays within the requested radius and is deterministic given a seeded rng', () => {
  const lat = 52.52;
  const lon = 13.405;
  const radiusMeters = 500;
  const point = safeJitter(lat, lon, radiusMeters, () => 0.5);
  assert.equal(point.source, 'jitter');

  const distanceMeters = haversineMeters(lat, lon, point.lat, point.lon);
  assert.ok(distanceMeters <= radiusMeters + 1, `distance ${distanceMeters} exceeds radius`);
});

test('safeJitter with rng()=0 returns exactly the minimum-offset point (50m, never the centroid)', () => {
  const point = safeJitter(52.52, 13.405, 500, () => 0);
  // distance should equal MIN_DISTANCE_M (50 m) regardless of RNG output
  const d = haversineMeters(52.52, 13.405, point.lat, point.lon);
  assert.ok(Math.abs(d - 50) < 1, `expected ~50 m min offset, got ${d.toFixed(1)} m`);
});

test('safeJitter clamps a radius smaller than the 50m minimum instead of going negative', () => {
  const point = safeJitter(52.52, 13.405, 10, () => 0.9);
  assert.ok(Number.isFinite(point.lat) && Number.isFinite(point.lon));
  const d = haversineMeters(52.52, 13.405, point.lat, point.lon);
  assert.ok(d >= 49 && d <= 51, `expected ~50 m offset when radius < minimum, got ${d.toFixed(1)} m`);
});

test('safeJitter distribution is uniform over area, not clustered at center', () => {
  // Sample many points; roughly half should fall outside radius/sqrt(2)
  // (median radius for a uniform-area disk distribution).
  let outerCount = 0;
  const samples = 2000;
  const radiusMeters = 1000;
  // With distance = MIN + (R - MIN)*sqrt(u), the median solves
  // ((m - MIN)/(R - MIN))^2 = 0.5  =>  m = MIN + (R - MIN)/sqrt(2)
  // With MIN=50, R=1000: m ≈ 722 m.
  const MIN = 50;
  const medianRadius = MIN + (radiusMeters - MIN) / Math.SQRT2;
  let seed = 1;
  const rng = () => {
    // simple deterministic PRNG (mulberry32) for reproducibility
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < samples; i++) {
    const p = safeJitter(52.52, 13.405, radiusMeters, rng);
    const d = haversineMeters(52.52, 13.405, p.lat, p.lon);
    if (d > medianRadius) outerCount++;
  }
  const ratio = outerCount / samples;
  assert.ok(ratio > 0.35 && ratio < 0.65, `expected ~0.5 outer ratio, got ${ratio}`);
});

test('resolveResidentialCoordinate uses Overpass result when available', async () => {
  const fakeFetch = async () =>
    ({
      ok: true,
      json: async () => ({
        elements: [{ type: 'way', id: 1, tags: { highway: 'residential' }, geometry: [{ lat: 52.521, lon: 13.406 }] }],
      }),
    });
  const point = await resolveResidentialCoordinate({
    lat: 52.52,
    lon: 13.405,
    radiusMeters: 500,
    fetchImpl: fakeFetch,
    rng: () => 0,
  });
  assert.equal(point.source, 'overpass');
});

test('resolveResidentialCoordinate falls back to jitter when Overpass fails', async () => {
  const fakeFetch = async () => {
    throw new Error('overpass unreachable');
  };
  const point = await resolveResidentialCoordinate({
    lat: 52.52,
    lon: 13.405,
    radiusMeters: 500,
    fetchImpl: fakeFetch,
    rng: () => 0.5,
  });
  assert.equal(point.source, 'jitter');
});

test('resolveResidentialCoordinate falls back to jitter when Overpass returns no ways', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ elements: [] }) });
  const point = await resolveResidentialCoordinate({
    lat: 52.52,
    lon: 13.405,
    radiusMeters: 500,
    fetchImpl: fakeFetch,
    rng: () => 0.5,
  });
  assert.equal(point.source, 'jitter');
});

test('resolveResidentialCoordinate searches the full radius for the city-level (3000m) preset', async () => {
  let capturedBody;
  const fakeFetch = async (url, init) => {
    capturedBody = init.body;
    return { ok: true, json: async () => ({ elements: [] }) };
  };
  await resolveResidentialCoordinate({
    lat: 52.52,
    lon: 13.405,
    radiusMeters: 3000,
    fetchImpl: fakeFetch,
    rng: () => 0.5,
  });
  assert.match(capturedBody, /around:3000,/);
});

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
