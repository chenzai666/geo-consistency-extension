import { fetchEgressGeo } from '../lib/providers.js';
import { resolveResidentialCoordinate } from '../lib/overpass.js';
import { inferLocaleBundle } from '../lib/locale.js';
import { buildAcceptLanguageRule, ACCEPT_LANGUAGE_RULE_ID } from '../lib/dnr.js';
import {
  STORAGE_KEYS,
  DEFAULT_SETTINGS,
  normalizeSettings,
  accuracyRadiusMeters,
} from '../lib/storage-schema.js';

const ALARM_NAME = 'geo-consistency-refresh';

/** Reads + normalizes settings, writing defaults back if nothing was stored yet. */
async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  if (!stored[STORAGE_KEYS.SETTINGS]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS });
    return { ...DEFAULT_SETTINGS };
  }
  return normalizeSettings(stored[STORAGE_KEYS.SETTINGS]);
}

async function getRawGeo() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.RAW_GEO);
  return stored[STORAGE_KEYS.RAW_GEO] || null;
}

/**
 * Full or partial refresh pipeline.
 * @param {object} opts
 * @param {boolean} [opts.useCachedRawGeo] skip hitting IP providers, reuse last raw geo
 */
async function runRefreshPipeline(opts = {}) {
  const settings = await getSettings();
  let rawGeo = opts.useCachedRawGeo ? await getRawGeo() : null;
  let providerId = rawGeo?.providerId;

  if (!rawGeo) {
    const result = await fetchEgressGeo({ ipinfoToken: settings.ipinfoToken });
    if (!result) {
      console.warn('[geo-consistency] all IP geolocation providers failed');
      await chrome.storage.local.set({
        [STORAGE_KEYS.PROFILE]: {
          error: 'All IP geolocation providers failed',
          fetchedAt: Date.now(),
        },
      });
      return null;
    }
    rawGeo = result.geo;
    providerId = result.providerId;
    await chrome.storage.local.set({
      [STORAGE_KEYS.RAW_GEO]: { ...rawGeo, providerId, fetchedAt: Date.now() },
    });
  }

  const radiusMeters = accuracyRadiusMeters(settings.accuracy);
  const resolvedCoord = await resolveResidentialCoordinate({
    lat: rawGeo.lat,
    lon: rawGeo.lon,
    radiusMeters,
  });
  const locale = inferLocaleBundle(rawGeo.countryCode, rawGeo.timezone);

  const profile = {
    ip: rawGeo.ip,
    countryCode: rawGeo.countryCode,
    country: rawGeo.country,
    region: rawGeo.region,
    city: rawGeo.city,
    isp: rawGeo.isp,
    timezone: rawGeo.timezone,
    providerLat: rawGeo.lat,
    providerLon: rawGeo.lon,
    resolvedCoord,
    accuracyMeters: radiusMeters,
    locale,
    providerUsed: providerId,
    fetchedAt: Date.now(),
    error: null,
  };

  await chrome.storage.local.set({ [STORAGE_KEYS.PROFILE]: profile });
  await syncDnrRules(settings, locale);
  return profile;
}

/** Adds/removes the Accept-Language dynamic rule based on the languageSpoof toggle. */
async function syncDnrRules(settings, locale) {
  // Only remove the specific rule this extension owns — never touch rules
  // added by other extensions or by future rules we may add later.
  const addRules =
    settings.languageSpoof && locale?.acceptLanguage
      ? [buildAcceptLanguageRule(locale.acceptLanguage)]
      : [];
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ACCEPT_LANGUAGE_RULE_ID],
    addRules,
  });
}

async function scheduleAlarm(settings) {
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: settings.refreshIntervalMinutes,
    delayInMinutes: settings.refreshIntervalMinutes,
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await scheduleAlarm(settings);
  await runRefreshPipeline({ useCachedRawGeo: false });
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  await scheduleAlarm(settings);
  const profile = (await chrome.storage.local.get(STORAGE_KEYS.PROFILE))[STORAGE_KEYS.PROFILE];
  const staleMs = settings.refreshIntervalMinutes * 60 * 1000;
  if (!profile || !profile.fetchedAt || Date.now() - profile.fetchedAt > staleMs) {
    await runRefreshPipeline({ useCachedRawGeo: false });
  } else {
    await syncDnrRules(settings, profile.locale);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    runRefreshPipeline({ useCachedRawGeo: false });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse);
  return true; // keep the message channel open for the async response
});

async function handleMessage(message) {
  switch (message?.type) {
    case 'MANUAL_REFRESH': {
      const profile = await runRefreshPipeline({ useCachedRawGeo: false });
      return { ok: !!profile, profile };
    }
    case 'SETTINGS_UPDATED': {
      const previous = await getSettings();
      const next = normalizeSettings(message.settings);
      await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: next });

      if (next.refreshIntervalMinutes !== previous.refreshIntervalMinutes) {
        await scheduleAlarm(next);
      }

      let profile = (await chrome.storage.local.get(STORAGE_KEYS.PROFILE))[STORAGE_KEYS.PROFILE];
      if (next.accuracy !== previous.accuracy) {
        profile = await runRefreshPipeline({ useCachedRawGeo: true });
      } else if (next.ipinfoToken !== previous.ipinfoToken) {
        profile = await runRefreshPipeline({ useCachedRawGeo: false });
      } else {
        await syncDnrRules(next, profile?.locale);
      }
      return { ok: true, profile };
    }
    case 'GET_STATE': {
      const settings = await getSettings();
      const profile = (await chrome.storage.local.get(STORAGE_KEYS.PROFILE))[STORAGE_KEYS.PROFILE];
      return { settings, profile };
    }
    default:
      return { ok: false, error: 'unknown message type' };
  }
}
