// Odottamattomat virheet: käsittelemätön lupaus, poikkeus ja käynnistys.
//
// Asynkroninen napinkäsittelijä ilman catchia (bugi, puuttuva DOM-solmu)
// kaatui aiemmin hiljaa: käyttäjä painoi, mitään ei tapahtunut eikä mitään
// kerrottu (ERR-20). Nyt käyttäjä näkee YHDEN kiinteän viestin (toast.js
// yhdistää toistot), ja lokiin menee vain virheen nimi ja koodi -- ei
// viestiä, joka voi sisältää käyttäjän tekstiä.
//
// Käynnistyksen epäonnistuminen (ERR-21): "Päivitä sivu." oli väärä
// neuvo natiivisovelluksessa (ei sivua) ja ilman verkkoa (päivitys ei auta).

import { showError } from '../ui/toast.js';
import { logEvent, LOG_LEVEL } from '../lib/logger.js';
import { logFailure } from '../lib/result.js';
import { UNEXPECTED_ERROR_MESSAGE, startupFailureMessage } from '../lib/errorMessages.js';
import { isNativeShell } from '../platform/index.js';
import { escapeHtml } from '../lib/format.js';

const text = value => (typeof value === 'string' || typeof value === 'number' ? value : null);

/**
 * Selaimen omaa kohinaa tai käyttäjän itse keskeyttämä toiminto: ei
 * ilmoitusta. ResizeObserver-varoitus ja lisäosien "Script error." eivät
 * ole sovelluksen virheitä; AbortError on keskeytetty pyyntö.
 */
function isBenign(reason, message) {
  if (reason && reason.name === 'AbortError') return true;
  const textOf = String(message || (reason && reason.message) || '');
  if (/ResizeObserver loop/i.test(textOf)) return true;
  return !reason && /^Script error\.?$/i.test(textOf);
}

/**
 * Kytke window-tason käsittelijät. Palauttaa irrotusfunktion (testit).
 *
 * @param {EventTarget} [target] oletus: window
 * @param {object} [deps] testejä varten
 */
export function installGlobalErrorHandlers(target = globalThis.window, { show = showError, log = logEvent } = {}) {
  if (!target || typeof target.addEventListener !== 'function') return () => {};

  const handle = (event, reason, source) => {
    if (isBenign(reason, event && event.message)) return;
    // Selaimen oletuskäsittely tulostaisi koko virheolion konsoliin.
    try { if (event && typeof event.preventDefault === 'function') event.preventDefault(); } catch { /* ei estettävissä */ }
    try {
      log('app.unhandled', {
        source,
        errorName: text(reason && reason.name) || 'unknown',
        code: text(reason && reason.code)
      }, LOG_LEVEL.ERROR);
    } catch { /* loki ei saa kaataa käsittelijää */ }
    show(UNEXPECTED_ERROR_MESSAGE);
  };

  const onRejection = event => handle(event, event ? event.reason : null, 'rejection');
  const onError = event => handle(event, event ? event.error : null, 'error');
  target.addEventListener('unhandledrejection', onRejection);
  target.addEventListener('error', onError);
  return () => {
    target.removeEventListener('unhandledrejection', onRejection);
    target.removeEventListener('error', onError);
  };
}

/**
 * Käynnistyksen epäonnistuminen: kiinteä teksti aloitusnäkymään.
 *
 * Ilman verkkoa -- tai kun Supabase-kirjasto ei latautunut, mikä on
 * käytännössä verkko-ongelma -- neuvo on tarkistaa yhteys. Natiivissa ei
 * puhuta sivusta.
 *
 * @param {unknown} error
 * @param {{splash?: {innerHTML: string}|null, native?: boolean, offline?: boolean}} [context]
 * @returns {string} näytetty teksti
 */
export function showStartupFailure(error, {
  splash = null,
  native = isNativeShell(),
  offline = (typeof navigator !== 'undefined' && navigator.onLine === false)
    || !(globalThis.supabase && typeof globalThis.supabase.createClient === 'function')
} = {}) {
  logFailure('app.startup_failed', error);
  const message = startupFailureMessage({ offline, native });
  if (splash) splash.innerHTML = `<div class="startup-error" role="alert">${escapeHtml(message)}</div>`;
  return message;
}
