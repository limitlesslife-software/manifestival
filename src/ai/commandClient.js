// Asiakaspuolen kutsu omalle /api/command-välipalvelimelle.
//
// Selain EI koskaan kutsu Anthropicia suoraan eikä näe API-avainta.
// Ks. api/command.js ja docs/SECURITY.md.
//
// TOISIN KUIN parseClient.js: EI PALAUTA VARAEHDOTUSTA VERKKOVIRHEESSÄ.
// Tehtävän luonnissa varaehdotus (käyttäjän oma teksti otsikkona) on
// turvallinen, koska luonti ei muuta mitään olemassa olevaa. Komennolle
// ei ole vastaavaa turvallista arvausta -- "siirrä hammaslääkäri
// perjantaille" ei voi pudota mihinkään järkevään oletukseen, jos
// tulkinta epäonnistuu. Epäonnistuminen kerrotaan siis rehellisesti,
// jotta kutsuja voi tarjota käyttäjälle uudelleenyritystä tai reitittää
// tekstin tavalliseen kirjauspolkuun.

import { API } from '../data/config.js';
import { apiUrl } from '../platform/index.js';
import { WD_FULL } from '../lib/format.js';
import { extractJson } from './proposalSchema.js';
import { ok, fail } from '../lib/result.js';

/** Kutsun aikakatkaisu. */
export const REQUEST_TIMEOUT_MS = 15000;

/** Viikonpäivän nimi Date-oliosta. Palvelin validoi tämän sallittua listaa vasten. */
export function weekdayName(date) {
  return WD_FULL[date.getDay()];
}

/**
 * Pyydä komennon luokittelu lauseesta.
 *
 * EI SUORITA MITÄÄN. Palauttaa raakaehdotuksen (`raw`), joka on vielä
 * ajettava src/ai/intentSchema.js:n resolveCommand()-funktion läpi
 * ennen kuin siitä on mitään hyötyä -- tämä moduuli ei tunne
 * allowlistiä eikä validoi kenttiä, se vain poimii JSON:in mallin
 * tekstivastauksesta.
 *
 * @param {object} args
 * @param {string} args.text        käyttäjän kirjoittama tai puhuma komento
 * @param {string} args.today       ISO-päivä
 * @param {string} [args.weekday]   suomenkielinen viikonpäivä
 * @param {string} [args.source]    'text' | 'voice'
 * @param {string} [args.accessToken] Supabase-istunnon token
 * @param {Function} [args.fetchImpl] Testejä varten
 */
export async function requestCommand({ text, today, weekday, source, accessToken, fetchImpl }) {
  const cleanText = String(text ?? '').trim();
  if (!cleanText) return fail('Komento oli tyhjä.', { code: 'aiCommand.empty' });

  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return fail('Verkkokutsu ei ole käytettävissä.', { code: 'aiCommand.nofetch' });

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    const response = await doFetch(apiUrl(API.command), {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: cleanText, today, weekday, source: source || 'text' }),
      signal: controller ? controller.signal : undefined
    });

    if (!response.ok) {
      const status = response.status;
      const message = status === 401 || status === 403
        ? 'Kirjaudu uudelleen ja yritä sitten uudestaan.'
        : status === 429
          ? 'Liian monta pyyntöä peräkkäin. Odota hetki.'
          : 'Komentoa ei voitu tulkita juuri nyt.';
      return fail(message, { code: 'aiCommand.http.' + status, cause: new Error('HTTP ' + status) });
    }

    const data = await response.json();
    const blocks = Array.isArray(data && data.content) ? data.content : [];
    const combined = blocks.map(b => (b && b.text) || '').join('');

    const raw = extractJson(combined);
    if (!raw) return fail('Komentoa ei ymmärretty.', { code: 'aiCommand.noJson' });

    return ok({ raw });
  } catch (cause) {
    const timedOut = cause && cause.name === 'AbortError';
    return fail(timedOut ? 'Tulkinta kesti liian kauan' : 'Verkkovirhe on estänyt tulkinnan.',
      { code: timedOut ? 'aiCommand.timeout' : 'aiCommand.network', cause });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
