// Tilin poiston asiakas: kutsuu Supabase Edge Function delete-account.
//
// EI SISÄLLÄ MITÄÄN KOROTETTUA. Lähettää vain käyttäjän oman access
// tokenin; palvelin johtaa käyttäjän siitä eikä koskaan ota tunnistetta
// rungosta. Korotettu avain elää funktiossa, ks.
// supabase/functions/delete-account/handler.js.
//
// LIPPU EI OLE KOSMETIIKKAA: kun ACCOUNT_DELETION.endpointEnabled on
// false, mitään verkkokutsua ei tehdä ja tulos on rehellisesti
// "ei käytössä" -- ei väärää onnistumista eikä hiljaista epäonnistumista.
//
// KÄYTTÄJÄLLE NÄYTETÄÄN OMA VIESTI VIRHEKOODIN PERUSTEELLA. Palvelimen
// viestitekstiä ei näytetä eikä lokiteta; tokenia ja sähköpostia ei
// koskaan lokiteta.

import { SUPABASE_URL, SUPABASE_ANON_KEY, ACCOUNT_DELETION } from './config.js';
import { ok, fail } from '../lib/result.js';
import { logEvent, LOG_LEVEL } from '../lib/logger.js';

export const PREVIEW_TIMEOUT_MS = 15000;
export const DELETE_TIMEOUT_MS = 30000;

/** Palvelimen virhekoodi -> käyttäjälle näytettävä viesti. */
const MESSAGES = Object.freeze({
  unavailable: 'Tilin poisto ei ole vielä käytössä.',
  auth_required: 'Kirjaudu sisään ja yritä uudelleen.',
  auth_invalid: 'Kirjautuminen ei ole voimassa. Kirjaudu uudelleen.',
  recent_login_required: 'Kirjaudu ulos ja sisään uudelleen ennen tilin poistoa.',
  confirmation_required: 'Vahvistus puuttuu.',
  confirmation_mismatch: 'Vahvistus ei täsmää.',
  auth_delete_failed: 'Tilin poisto epäonnistui. Yritä hetken päästä uudelleen.',
  timeout: 'Palvelin ei vastannut ajoissa. Tarkista tilanne ennen uutta yritystä.',
  network: 'Yhteys palvelimeen epäonnistui.',
  internal: 'Palveluvirhe. Yritä myöhemmin uudelleen.',
  bad_response: 'Palvelimen vastaus oli odottamaton.'
});

export function deletionErrorMessage(code) {
  // Oma ominaisuus: MESSAGES['constructor'] olisi muuten Object-funktio.
  return Object.prototype.hasOwnProperty.call(MESSAGES, code) ? MESSAGES[code] : MESSAGES.internal;
}

function functionUrl() {
  return `${SUPABASE_URL}/functions/v1/${ACCOUNT_DELETION.functionName}`;
}

/** Tulos diagnostiikkaan: tila ja koodi, ei tokenia, sähköpostia eikä vastauksen sisältöä. */
function recorded(mode, result) {
  logEvent('account_deletion.call', {
    mode, ok: result.ok, code: result.ok ? null : result.error.code
  }, result.ok ? LOG_LEVEL.INFO : LOG_LEVEL.WARN);
  return result;
}

async function callFunction({ body, accessToken, fetchImpl, timeoutMs, enabled }) {
  return recorded(body.mode, await callFunctionRaw({ body, accessToken, fetchImpl, timeoutMs, enabled }));
}

async function callFunctionRaw({ body, accessToken, fetchImpl, timeoutMs, enabled }) {
  if (enabled !== true) {
    return fail(MESSAGES.unavailable, { code: 'accountDeletion.unavailable' });
  }
  if (!accessToken) {
    return fail(MESSAGES.auth_required, { code: 'accountDeletion.auth_required' });
  }

  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return fail(MESSAGES.network, { code: 'accountDeletion.nofetch' });

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await doFetch(functionUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        apikey: SUPABASE_ANON_KEY
      },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined
    });

    let data = null;
    try { data = await response.json(); } catch { /* ei JSONia */ }

    if (!response.ok) {
      const code = data && data.error && typeof data.error.code === 'string' ? data.error.code : 'internal';
      const known = Object.prototype.hasOwnProperty.call(MESSAGES, code) ? code : 'internal';
      return fail(MESSAGES[known], { code: 'accountDeletion.' + known });
    }
    if (!data || data.ok !== true) {
      return fail(MESSAGES.bad_response, { code: 'accountDeletion.bad_response' });
    }
    return ok(data);
  } catch (cause) {
    const timedOut = cause && cause.name === 'AbortError';
    return fail(timedOut ? MESSAGES.timeout : MESSAGES.network,
      { code: timedOut ? 'accountDeletion.timeout' : 'accountDeletion.network', cause });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Palvelimen kuiva-ajo: rivimäärät kokoelmittain. Ei poista mitään.
 * @returns {Promise<{ok:true, value:object}|{ok:false, error:object}>}
 */
export function previewAccountDeletion({ accessToken, fetchImpl, enabled = ACCOUNT_DELETION.endpointEnabled } = {}) {
  return callFunction({
    body: { mode: 'dry_run' }, accessToken, fetchImpl, enabled, timeoutMs: PREVIEW_TIMEOUT_MS
  });
}

/**
 * Suorita tilin poisto. PERUUTTAMATON. Kutsuja vastaa siitä, että
 * käyttäjä on läpäissyt koko vahvistusvirran (src/domain/accountDeletionFlow.js).
 */
export function executeAccountDeletion({
  accessToken, confirmEmail, confirmPhrase, fetchImpl, enabled = ACCOUNT_DELETION.endpointEnabled
} = {}) {
  return callFunction({
    body: { mode: 'delete', confirmEmail, confirmPhrase },
    accessToken, fetchImpl, enabled, timeoutMs: DELETE_TIMEOUT_MS
  });
}
