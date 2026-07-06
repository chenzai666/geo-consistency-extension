import { DEFAULT_SETTINGS, normalizeSettings } from '../lib/storage-schema.js';

const el = (id) => document.getElementById(id);

async function loadState() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  return response || { settings: DEFAULT_SETTINGS, profile: null };
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

function renderProfile(profile) {
  const errorBox = el('statError');
  if (!profile) {
    errorBox.hidden = true;
    el('statIp').textContent = '—';
    el('statLocation').textContent = 'not yet fetched';
    el('statIsp').textContent = '—';
    el('statTimezone').textContent = '—';
    el('statLocale').textContent = '—';
    el('statCoordSource').textContent = '—';
    el('statProvider').textContent = '—';
    el('statUpdated').textContent = '—';
    return;
  }

  if (profile.error) {
    errorBox.hidden = false;
    errorBox.textContent = profile.error;
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
  const { settings, profile } = await loadState();
  fillSettingsForm(normalizeSettings(settings));
  renderProfile(profile);

  el('refreshBtn').addEventListener('click', async () => {
    el('refreshBtn').disabled = true;
    const response = await chrome.runtime.sendMessage({ type: 'MANUAL_REFRESH' });
    renderProfile(response?.profile);
    el('refreshBtn').disabled = false;
  });

  el('saveBtn').addEventListener('click', async () => {
    const settingsToSave = readSettingsForm();
    const response = await chrome.runtime.sendMessage({
      type: 'SETTINGS_UPDATED',
      settings: settingsToSave,
    });
    renderProfile(response?.profile);
    const note = el('saveNote');
    note.hidden = false;
    setTimeout(() => {
      note.hidden = true;
    }, 1500);
  });
}

init();
