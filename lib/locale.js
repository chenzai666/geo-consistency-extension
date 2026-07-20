/**
 * Country code (+ timezone as a tiebreaker for multilingual countries) ->
 * locale bundle: navigator.language, navigator.languages, Accept-Language.
 *
 * Pure, offline, no network — a static table plus a small resolver.
 */

// country ISO-3166 alpha-2 -> ordered list of BCP-47 language tags for the
// *majority* population. First entry is the "primary" language.
// Countries with region-dependent language splits are resolved further down
// using `timezoneHints`.
const COUNTRY_LANGUAGES = {
  US: ['en-US', 'en'],
  GB: ['en-GB', 'en'],
  IE: ['en-IE', 'en'],
  AU: ['en-AU', 'en'],
  NZ: ['en-NZ', 'en'],
  CA: ['en-CA', 'fr-CA', 'en'],
  FR: ['fr-FR', 'fr'],
  DE: ['de-DE', 'de'],
  AT: ['de-AT', 'de'],
  CH: ['de-CH', 'fr-CH', 'it-CH', 'en'],
  IT: ['it-IT', 'it'],
  ES: ['es-ES', 'es'],
  PT: ['pt-PT', 'pt'],
  BR: ['pt-BR', 'pt'],
  NL: ['nl-NL', 'nl'],
  BE: ['nl-BE', 'fr-BE', 'en'],
  SE: ['sv-SE', 'sv'],
  NO: ['nb-NO', 'no'],
  DK: ['da-DK', 'da'],
  FI: ['fi-FI', 'sv-FI', 'fi'],
  PL: ['pl-PL', 'pl'],
  CZ: ['cs-CZ', 'cs'],
  SK: ['sk-SK', 'sk'],
  HU: ['hu-HU', 'hu'],
  RO: ['ro-RO', 'ro'],
  BG: ['bg-BG', 'bg'],
  GR: ['el-GR', 'el'],
  TR: ['tr-TR', 'tr'],
  RU: ['ru-RU', 'ru'],
  UA: ['uk-UA', 'uk', 'ru'],
  JP: ['ja-JP', 'ja'],
  KR: ['ko-KR', 'ko'],
  CN: ['zh-CN', 'zh'],
  TW: ['zh-TW', 'zh'],
  HK: ['zh-HK', 'zh-Hant-HK', 'en'],
  SG: ['en-SG', 'zh-SG', 'en'],
  IN: ['en-IN', 'hi-IN', 'en'],
  ID: ['id-ID', 'id'],
  MY: ['ms-MY', 'en-MY', 'ms'],
  TH: ['th-TH', 'th'],
  VN: ['vi-VN', 'vi'],
  PH: ['en-PH', 'fil-PH', 'en'],
  MX: ['es-MX', 'es'],
  AR: ['es-AR', 'es'],
  CL: ['es-CL', 'es'],
  CO: ['es-CO', 'es'],
  PE: ['es-PE', 'es'],
  VE: ['es-VE', 'es'],
  IL: ['he-IL', 'he'],
  SA: ['ar-SA', 'ar'],
  AE: ['ar-AE', 'en-AE', 'ar'],
  EG: ['ar-EG', 'ar'],
  ZA: ['en-ZA', 'af-ZA', 'en'],
  NG: ['en-NG', 'en'],
  KE: ['en-KE', 'sw-KE', 'en'],
  PK: ['en-PK', 'ur-PK', 'en'],
  BD: ['bn-BD', 'bn'],
  LU: ['fr-LU', 'de-LU', 'lb-LU', 'fr'],
  HR: ['hr-HR', 'hr'],
  SI: ['sl-SI', 'sl'],
  RS: ['sr-RS', 'sr'],
  BA: ['bs-BA', 'bs'],
  MK: ['mk-MK', 'mk'],
  AL: ['sq-AL', 'sq'],
  ME: ['sr-ME', 'sr'],
  LT: ['lt-LT', 'lt'],
  LV: ['lv-LV', 'lv'],
  EE: ['et-EE', 'et'],
  IS: ['is-IS', 'is'],
  MT: ['mt-MT', 'en-MT', 'mt'],
  CY: ['el-CY', 'tr-CY', 'el'],
  LK: ['si-LK', 'ta-LK', 'en'],
  NP: ['ne-NP', 'ne'],
  MM: ['my-MM', 'my'],
  KH: ['km-KH', 'km'],
  LA: ['lo-LA', 'lo'],
  MN: ['mn-MN', 'mn'],
  KZ: ['kk-KZ', 'ru-KZ', 'kk'],
  UZ: ['uz-UZ', 'uz'],
  GE: ['ka-GE', 'ka'],
  AM: ['hy-AM', 'hy'],
  AZ: ['az-AZ', 'az'],
  BY: ['be-BY', 'ru-BY', 'be'],
  MD: ['ro-MD', 'ro'],
  CU: ['es-CU', 'es'],
  DO: ['es-DO', 'es'],
  GT: ['es-GT', 'es'],
  HN: ['es-HN', 'es'],
  SV: ['es-SV', 'es'],
  NI: ['es-NI', 'es'],
  CR: ['es-CR', 'es'],
  PA: ['es-PA', 'es'],
  BO: ['es-BO', 'es'],
  PY: ['es-PY', 'es'],
  UY: ['es-UY', 'es'],
  EC: ['es-EC', 'es'],
  GH: ['en-GH', 'en'],
  TZ: ['sw-TZ', 'en-TZ', 'sw'],
  UG: ['en-UG', 'sw-UG', 'en'],
  ET: ['am-ET', 'en-ET', 'am'],
  CI: ['fr-CI', 'fr'],
  SN: ['fr-SN', 'fr'],
  CM: ['fr-CM', 'en-CM', 'fr'],
  MZ: ['pt-MZ', 'pt'],
  ZW: ['en-ZW', 'en'],
  ZM: ['en-ZM', 'en'],
  AO: ['pt-AO', 'pt'],
  MG: ['mg-MG', 'fr-MG', 'mg'],
  MA: ['ar-MA', 'fr-MA', 'ar'],
  DZ: ['ar-DZ', 'fr-DZ', 'ar'],
  TN: ['ar-TN', 'fr-TN', 'ar'],
  LY: ['ar-LY', 'ar'],
  JO: ['ar-JO', 'ar'],
  LB: ['ar-LB', 'fr-LB', 'ar'],
  IQ: ['ar-IQ', 'ku', 'ar'],
  KW: ['ar-KW', 'ar'],
  QA: ['ar-QA', 'ar'],
  BH: ['ar-BH', 'ar'],
  OM: ['ar-OM', 'ar'],
  YE: ['ar-YE', 'ar'],
  IR: ['fa-IR', 'fa'],
};

// Disambiguates countries where language depends on the specific region /
// timezone (used only when COUNTRY_LANGUAGES has multiple candidates and we
// want to reorder so the timezone-appropriate language is first).
const TIMEZONE_LANGUAGE_HINTS = {
  'America/Toronto': 'en-CA',
  'America/Vancouver': 'en-CA',
  'America/Edmonton': 'en-CA',
  'America/Winnipeg': 'en-CA',
  'America/Montreal': 'fr-CA',
  'Europe/Zurich': 'de-CH',
  'Europe/Geneva': 'fr-CH',
  'Europe/Zug': 'de-CH',
  'Europe/Brussels': 'nl-BE',
};

const DEFAULT_LANGUAGES = ['en-US', 'en'];

/**
 * @param {string} countryCode ISO-3166 alpha-2, e.g. "DE"
 * @param {string} timezone IANA zone id, e.g. "Europe/Berlin"
 * @returns {{ language: string, languages: string[], acceptLanguage: string }}
 */
export function inferLocaleBundle(countryCode, timezone) {
  const cc = (countryCode || '').toUpperCase();
  let languages = COUNTRY_LANGUAGES[cc] ? [...COUNTRY_LANGUAGES[cc]] : null;

  if (!languages) {
    languages = deriveFromTimezoneRegion(timezone) || [...DEFAULT_LANGUAGES];
  }

  const hint = timezone && TIMEZONE_LANGUAGE_HINTS[timezone];
  if (hint && languages.includes(hint) && languages[0] !== hint) {
    languages = [hint, ...languages.filter((l) => l !== hint)];
  }

  // De-dupe while preserving order.
  languages = [...new Set(languages)];

  return {
    language: languages[0],
    languages,
    acceptLanguage: buildAcceptLanguageHeader(languages),
  };
}

/**
 * Very coarse fallback when the country code is unrecognized: derive a
 * plausible language purely from the timezone's continent/region prefix.
 * @param {string} timezone
 * @returns {string[] | null}
 */
function deriveFromTimezoneRegion(timezone) {
  if (!timezone || typeof timezone !== 'string') return null;
  const region = timezone.split('/')[0];
  const REGION_DEFAULTS = {
    Europe: ['en-GB', 'en'],
    Africa: ['en', 'en-US'],
    Asia: ['en', 'en-US'],
    Australia: ['en-AU', 'en'],
    Pacific: ['en', 'en-US'],
    Indian: ['en', 'en-US'],
    Atlantic: ['en', 'en-US'],
    America: ['en-US', 'en'],
  };
  return REGION_DEFAULTS[region] ? [...REGION_DEFAULTS[region]] : null;
}

/**
 * Builds a standards-compliant Accept-Language header value with descending
 * q-values, e.g. "de-DE,de;q=0.9,en;q=0.8".
 * @param {string[]} languages
 * @returns {string}
 */
export function buildAcceptLanguageHeader(languages) {
  return languages
    .map((lang, i) => (i === 0 ? lang : `${lang};q=${Math.max(0.1, 1 - i * 0.1).toFixed(1)}`))
    .join(',');
}
