import { DEFAULT_SETTINGS, normalizeSettings } from '../lib/storage-schema.js';

const el = (id) => document.getElementById(id);

async function loadState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    return response || { settings: DEFAULT_SETTINGS, profile: null };
  } catch (err) {
    return { settings: DEFAULT_SETTINGS, profile: null, loadError: err.message };
  }
}

function showError(message) {
  const errorBox = el('statError');
  errorBox.hidden = false;
  errorBox.textContent = message;
}

function fillSettingsForm(settings) {
  el('locationSpoof').checked = !!settings.locationSpoof;
  el('timezoneSpoof').checked = !!settings.timezoneSpoof;
  el('languageSpoof').checked = !!settings.languageSpoof;
  el('accuracy').value = settings.accuracy;
  el('refreshIntervalMinutes').value = settings.refreshIntervalMinutes;
  el('ipinfoToken').value = settings.ipinfoToken || '';
}

function readSettingsForm() {
  return normalizeSettings({
    locationSpoof: el('locationSpoof').checked,
    timezoneSpoof: el('timezoneSpoof').checked,
    languageSpoof: el('languageSpoof').checked,
    accuracy: el('accuracy').value,
    refreshIntervalMinutes: el('refreshIntervalMinutes').value,
    ipinfoToken: el('ipinfoToken').value,
  });
}

function clearProfileFields(locationPlaceholder) {
  el('statIp').textContent = '—';
  el('statLocation').textContent = locationPlaceholder;
  el('statIsp').textContent = '—';
  el('statTimezone').textContent = '—';
  el('statLocale').textContent = '—';
  el('statCoordSource').textContent = '—';
  el('statProvider').textContent = '—';
  el('statUpdated').textContent = '—';
}

function renderProfile(profile) {
  const errorBox = el('statError');
  if (!profile) {
    errorBox.hidden = true;
    clearProfileFields('not yet fetched');
    return;
  }

  if (profile.error) {
    errorBox.hidden = false;
    errorBox.textContent = profile.error;
    clearProfileFields('—');
    return;
  }
  errorBox.hidden = true;

  el('statIp').textContent = profile.ip || '—';
  el('statLocation').textContent = [profile.city, profile.region, profile.country]
    .filter(Boolean)
    .join(', ') || '—';
  el('statIsp').textContent = profile.isp || '—';
  el('statTimezone').textContent = profile.timezone || '—';
  el('statLocale').textContent = profile.locale?.acceptLanguage || '—';
  el('statCoordSource').textContent = profile.resolvedCoord
    ? `${profile.resolvedCoord.source} (${profile.resolvedCoord.lat.toFixed(5)}, ${profile.resolvedCoord.lon.toFixed(5)})`
    : '—';
  el('statProvider').textContent = profile.providerUsed || '—';
  el('statUpdated').textContent = profile.fetchedAt
    ? new Date(profile.fetchedAt).toLocaleString()
    : '—';
}

async function init() {
  const { settings, profile, loadError } = await loadState();
  fillSettingsForm(normalizeSettings(settings));
  renderProfile(profile);
  if (loadError) showError(`Could not load extension state: ${loadError}`);

  el('refreshBtn').addEventListener('click', async () => {
    el('refreshBtn').disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'MANUAL_REFRESH' });
      if (!response) throw new Error('no response from background service worker');
      renderProfile(response.profile);
    } catch (err) {
      showError(`Refresh failed: ${err.message}`);
    } finally {
      el('refreshBtn').disabled = false;
    }
  });

  el('saveBtn').addEventListener('click', async () => {
    const settingsToSave = readSettingsForm();
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SETTINGS_UPDATED',
        settings: settingsToSave,
      });
      if (!response) throw new Error('no response from background service worker');
      renderProfile(response.profile);
      const note = el('saveNote');
      note.hidden = false;
      setTimeout(() => {
        note.hidden = true;
      }, 1500);
    } catch (err) {
      showError(`Save failed: ${err.message}`);
    }
  });
}

init();
