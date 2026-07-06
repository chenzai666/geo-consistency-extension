/**
 * Resolves an IP provider's centroid to a plausible "lived-in" coordinate
 * instead of reporting the IP geolocation centroid directly (which is often
 * a datacenter/ISP office point, not a residential address).
 *
 * Strategy: query OpenStreetMap Overpass for nearby `highway=residential`
 * ways and pick a point along one of them. If Overpass is unreachable or
 * returns nothing usable, fall back to a safe random jitter around the
 * centroid, uniformly distributed within accuracyMeters.
 */

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

/**
 * @param {number} lat
 * @param {number} lon
 * @param {number} radiusMeters search radius
 * @returns {string} Overpass QL query
 */
export function buildOverpassQuery(lat, lon, radiusMeters) {
  return `[out:json][timeout:10];way(around:${Math.round(radiusMeters)},${lat},${lon})[highway=residential];out geom;`;
}

/**
 * Extracts a usable coordinate from an Overpass response: picks a residential
 * way (deterministically-seeded pseudo-random choice for testability) and a
 * point along its geometry.
 *
 * @param {object} json Overpass API response body
 * @param {() => number} [rng] injectable RNG in [0,1), defaults to Math.random
 * @returns {{lat: number, lon: number, source: 'overpass', wayId: number} | null}
 */
export function parseOverpassResponse(json, rng = Math.random) {
  const ways = (json && Array.isArray(json.elements) ? json.elements : []).filter(
    (el) =>
      el.type === 'way' &&
      Array.isArray(el.geometry) &&
      el.geometry.length > 0 &&
      // Strict check: only accept ways explicitly tagged highway=residential.
      // Ways missing tags entirely, or with a different highway value, are dropped.
      el.tags?.highway === 'residential'
  );
  if (ways.length === 0) return null;

  const way = ways[Math.floor(rng() * ways.length) % ways.length];
  const node = way.geometry[Math.floor(rng() * way.geometry.length) % way.geometry.length];
  if (!node || typeof node.lat !== 'number' || typeof node.lon !== 'number') return null;

  return { lat: node.lat, lon: node.lon, source: 'overpass', wayId: way.id };
}

/**
 * Safe fallback: a uniformly-distributed random point within `radiusMeters`
 * of (lat, lon), correcting for longitude compression at higher latitudes.
 * Uses sqrt(random) radial sampling so points are uniform over the disk area
 * (not clustered at the center).
 *
 * @param {number} lat
 * @param {number} lon
 * @param {number} radiusMeters
 * @param {() => number} [rng] injectable RNG in [0,1), defaults to Math.random
 * @returns {{lat: number, lon: number, source: 'jitter'}}
 */
export function safeJitter(lat, lon, radiusMeters, rng = Math.random) {
  const EARTH_RADIUS_M = 6371000;
  // Guarantee a minimum offset of 50 m so the returned coordinate can never
  // coincide with the raw IP centroid, regardless of the RNG output.
  const MIN_DISTANCE_M = 50;
  const distance = MIN_DISTANCE_M + (radiusMeters - MIN_DISTANCE_M) * Math.sqrt(rng());
  const bearing = 2 * Math.PI * rng();

  const latRad = (lat * Math.PI) / 180;
  const angularDistance = distance / EARTH_RADIUS_M;

  const newLatRad = Math.asin(
    Math.sin(latRad) * Math.cos(angularDistance) +
      Math.cos(latRad) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const newLonRad =
    (lon * Math.PI) / 180 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latRad),
      Math.cos(angularDistance) - Math.sin(latRad) * Math.sin(newLatRad)
    );

  return {
    lat: (newLatRad * 180) / Math.PI,
    lon: (newLonRad * 180) / Math.PI,
    source: 'jitter',
  };
}

/**
 * Full resolution pipeline: try Overpass, fall back to jitter on any failure.
 *
 * @param {object} opts
 * @param {number} opts.lat
 * @param {number} opts.lon
 * @param {number} opts.radiusMeters
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 * @param {() => number} [opts.rng]
 * @returns {Promise<{lat: number, lon: number, source: 'overpass'|'jitter'}>}
 */
export async function resolveResidentialCoordinate(opts) {
  const { lat, lon, radiusMeters, rng = Math.random } = opts;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;

  try {
    const query = buildOverpassQuery(lat, lon, Math.min(radiusMeters, 2000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let json;
    try {
      const res = await fetchImpl(OVERPASS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: query,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
    } finally {
      clearTimeout(timer);
    }
    const point = parseOverpassResponse(json, rng);
    if (point) return point;
  } catch {
    // fall through to jitter
  }

  return safeJitter(lat, lon, radiusMeters, rng);
}
