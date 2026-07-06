/**
 * ISOLATED world, document_start.
 *
 * Sole job: read chrome.storage.local (only reachable from the isolated
 * world / extension context, never from the page's own MAIN world) and hand
 * the relevant, already-computed values to the MAIN-world injector via a
 * DOM CustomEvent. This script never reads or touches page content — it
 * only ever writes one CustomEvent dispatch to `document`.
 *
 * Also subscribes to chrome.storage.onChanged so that toggling settings in
 * the popup takes effect on already-open tabs without a reload.
 */
(function () {
  'use strict';

  const EVENT_NAME = '__geoConsistencyPayload__';
  const SETTINGS_KEY = 'settings';
  const PROFILE_KEY = 'profile';

  function buildPayload(settings, profile) {
    if (!settings || !profile || profile.error) return null;

    const location =
      settings.locationSpoof && profile.resolvedCoord
        ? {
            latitude: profile.resolvedCoord.lat,
            longitude: profile.resolvedCoord.lon,
            accuracy: profile.accuracyMeters,
            source: profile.resolvedCoord.source,
          }
        : null;

    const timezone = settings.timezoneSpoof && profile.timezone ? profile.timezone : null;

    const locale = settings.languageSpoof && profile.locale ? profile.locale : null;

    return { location, timezone, locale };
  }

  function dispatch(payload) {
    document.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: payload }));
  }

  function loadAndDispatch() {
    chrome.storage.local.get([SETTINGS_KEY, PROFILE_KEY], (result) => {
      if (chrome.runtime.lastError) return;
      dispatch(buildPayload(result[SETTINGS_KEY], result[PROFILE_KEY]));
    });
  }

  loadAndDispatch();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes[SETTINGS_KEY] || changes[PROFILE_KEY]) {
      loadAndDispatch();
    }
  });
})();
