/**
 * Single source of truth for the chrome.storage.local schema. Everything the
 * extension persists lives under these two top-level keys — nothing else is
 * ever written to storage, and nothing is ever synced or sent off-device.
 */

export const STORAGE_KEYS = {
  SETTINGS: 'settings',
  PROFILE: 'profile',
  RAW_GEO: 'rawGeo',
};

export const ACCURACY_PRESETS = {
  precise: { label: 'Precise (~100m)', radiusMeters: 100 },
  balanced: { label: 'Balanced (~500m)', radiusMeters: 500 },
  city: { label: 'City-level (~3000m)', radiusMeters: 3000 },
};

export const DEFAULT_SETTINGS = {
  locationSpoof: true,
  timezoneSpoof: true,
  languageSpoof: true,
  accuracy: 'balanced',
  refreshIntervalMinutes: 60,
  ipinfoToken: '',
};

/**
 * Merges partial settings over defaults, dropping unknown keys.
 * @param {object} partial
 * @returns {object}
 */
export function normalizeSettings(partial) {
  const merged = { ...DEFAULT_SETTINGS, ...(partial || {}) };
  return {
    locationSpoof: !!merged.locationSpoof,
    timezoneSpoof: !!merged.timezoneSpoof,
    languageSpoof: !!merged.languageSpoof,
    accuracy: ACCURACY_PRESETS[merged.accuracy] ? merged.accuracy : DEFAULT_SETTINGS.accuracy,
    refreshIntervalMinutes: Math.max(5, Number(merged.refreshIntervalMinutes) || DEFAULT_SETTINGS.refreshIntervalMinutes),
    ipinfoToken: typeof merged.ipinfoToken === 'string' ? merged.ipinfoToken.trim() : '',
  };
}

export function accuracyRadiusMeters(accuracyKey) {
  return (ACCURACY_PRESETS[accuracyKey] || ACCURACY_PRESETS.balanced).radiusMeters;
}
