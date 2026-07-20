/**
 * Builds the chrome.declarativeNetRequest dynamic rule that rewrites the
 * outgoing Accept-Language header so it matches the spoofed locale. Kept as
 * a pure builder function so it's testable without the chrome.* API.
 */

export const ACCEPT_LANGUAGE_RULE_ID = 1;

/**
 * @param {string} acceptLanguageValue e.g. "de-DE,de;q=0.9,en;q=0.8"
 * @returns {object} a single declarativeNetRequest.Rule
 */
export function buildAcceptLanguageRule(acceptLanguageValue) {
  return {
    id: ACCEPT_LANGUAGE_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        {
          header: 'Accept-Language',
          operation: 'set',
          value: acceptLanguageValue,
        },
      ],
    },
    condition: {
      urlFilter: '*',
      resourceTypes: [
        'main_frame',
        'sub_frame',
        'xmlhttprequest',
        'script',
        'stylesheet',
        'image',
        'font',
        'media',
        'websocket',
        'object',
        'ping',
        'csp_report',
        'other',
      ],
    },
  };
}
