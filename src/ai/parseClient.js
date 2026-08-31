// Asiakaspuolen kutsu omalle /api/parse-välipalvelimelle.
//
// Selain EI koskaan kutsu Anthropicia suoraan eikä näe API-avainta.
// Ks. api/parse.js ja docs/SECURITY.md.
//
// Pyyntöön liitetään kirjautuneen käyttäjän Supabase-token, jotta palvelin
// voi tunnistaa kutsujan eikä anonyymi internet-käyttäjä voi kuluttaa
// Manifestivalin Anthropic-kiintiötä.

import { API } from '../data/config.js';
import { WD_FULL } from '../lib/format.js';
import { extractJson, validateProposal, fallbackProposal } from './proposalSchema.js';
import { ok, fail } from '../lib/result.js';

/** Kutsun aikakatkaisu. Pidempi odotus ei paranna tulosta. */
export const REQUEST_TIMEOUT_MS = 20000;

/** Viikonpäivän nimi Date-oliosta. Palvelin validoi tämän sallittua listaa vasten. */
export function weekdayName(date) {
  return WD_FULL[date.getDay()];
}

/**
 * Pyydä rakenteinen tehtäväehdotus luonnollisen kielen syötteestä.
 *
 * Palauttaa AINA käyttökelpoisen ehdotuksen, jos syöte ei ole tyhjä:
 * jos AI ei ole käytettävissä tai sen vastaus ei kelpaa, palautetaan
 * varaehdotus, jossa käyttäjän oma teksti on otsikkona. Puheohjaus ei siis
 * koskaan päädy umpikujaan verkkovirheen takia.
 *
 * @param {object} args
 * @param {string} args.transcript
 * @param {string} args.today        ISO-päivä
 * @param {string} args.weekday      Suomenkielinen viikonpäivä
 * @param {string} [args.accessToken] Supabase-istunnon token
 * @param {Function} [args.fetchImpl] Testejä varten
 */
export async function requestProposal({ transcript, today, weekday, accessToken, fetchImpl }) {
  const text = String(transcript ?? '').trim();
  if (!text) return fail('En kuullut mitään. Yritä uudelleen.', { code: 'ai.empty' });

  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return fail('Verkkokutsu ei ole käytettävissä.', { code: 'ai.nofetch' });

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    const response = await doFetch(API.parse, {
      method: 'POST',
      headers,
      body: JSON.stringify({ transcript: text, today, weekday }),
      signal: controller ? controller.signal : undefined
    });

    if (!response.ok) {
      // Palvelin palauttaa tarkoituksella yleisiä virheviestejä.
      const status = response.status;
      const message = status === 401 || status === 403
        ? 'Kirjaudu uudelleen ja yritä sitten uudestaan.'
        : status === 429
          ? 'Liian monta pyyntöä peräkkäin. Odota hetki.'
          : 'Tulkinta ei onnistunut. Voit tallentaa tekstin sellaisenaan.';
      return fail(message, { code: 'ai.http.' + status, cause: new Error('HTTP ' + status) });
    }

    const data = await response.json();
    const blocks = Array.isArray(data && data.content) ? data.content : [];
    const combined = blocks.map(b => (b && b.text) || '').join('');

    const raw = extractJson(combined);
    const result = validateProposal(raw, { today, fallbackTitle: text });

    if (!result.valid) {
      return ok({ proposal: fallbackProposal(text, today), source: 'fallback', reason: result.reason });
    }
    return ok({ proposal: result.proposal, source: 'ai', rejected: result.rejected });
  } catch (cause) {
    const timedOut = cause && cause.name === 'AbortError';
    return ok({
      proposal: fallbackProposal(text, today),
      source: 'fallback',
      reason: timedOut ? 'Tulkinta kesti liian kauan' : 'Verkkovirhe'
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
