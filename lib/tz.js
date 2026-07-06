/**
 * Pure timezone math shared by the background service worker (for validation /
 * popup preview) and duplicated inline inside content-scripts/main-injector.js
 * (content scripts cannot import ES modules into the MAIN world reliably, so
 * the same formula is inlined there — kept in sync via tests/tz.test.js and
 * tests/injector-sync.test.js).
 *
 * No network access, no page data — pure functions over Date + IANA zone name.
 */

/**
 * Returns the timezone offset in minutes for `date` interpreted in `timeZone`,
 * using the exact sign convention of Date.prototype.getTimezoneOffset()
 * (positive west of UTC, e.g. America/New_York -> +300 in winter, +240 in DST).
 *
 * DST-aware because it re-derives the wall-clock fields for the *specific*
 * `date` instance via Intl, rather than caching a single offset.
 *
 * @param {Date} date
 * @param {string} timeZone IANA zone id, e.g. "Europe/Berlin"
 * @returns {number} offset in minutes, or NaN if date/timeZone is invalid
 */
export function getTimezoneOffsetForZone(date, timeZone) {
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
    return NaN; // unknown/invalid IANA zone
  }

  const map = {};
  for (const { type, value } of parts) map[type] = value;

  // Chrome/V8 can format hour "24" for midnight under hourCycle h23 in some
  // locales/versions; normalize defensively.
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

/**
 * Validates that a string is a timezone Intl/V8 recognizes.
 * @param {string} timeZone
 * @returns {boolean}
 */
export function isValidTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
