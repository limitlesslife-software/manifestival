// Mallin päivä ja kellonaika vs. käyttäjän oma lause.
//
// Kielimalli erehtyy päivämäärissä ja suomen kellonajoissa ("puoli
// yhdeksältä" -> 09:30). Tämä vaihe vertaa mallin ehdottamaa päivää ja
// kelloa deterministisen jäsentimen (src/domain/fiTemporal.js) tulokseen
// ja korjaa VAIN kun jäsennin on yksiselitteinen.
//
// KORJAUS ON LUKEMISTA, EI ARVAUSTA:
//   - epäselvä ilmaisu (sama viikonpäivä kuin tänään, klo 1-6 ilman
//     vuorokaudenaikaa, "viikonloppuna", kaksi eri päivää) jättää mallin
//     vastauksen ENNALLEEN
//   - jäsennin ei koskaan lisää tietoa, jota käyttäjä ei sanonut
//   - vain kiinteä joukko intenttejä ja kenttiä (TEMPORAL_FIELDS):
//     poisto, talous ja muut komennot eivät koske tähän
//
// Tulos kulkee silti normaalin putken läpi (resolveCommand, kohteen
// tunnistus, vahvistus), joten korjattu arvo näkyy käyttäjälle
// "nykyinen -> uusi" -riveinä ennen kuin mitään tallennetaan.
//
// PUHDAS: palauttaa uuden olion, ei mutatoi annettua.

import { temporalHints } from '../domain/fiTemporal.js';

/** Intentti -> mitkä kentät (date/time) saa täsmätä lauseeseen. */
export const TEMPORAL_FIELDS = Object.freeze({
  create_task: Object.freeze(['date', 'time']),
  schedule_task: Object.freeze(['date', 'time']),
  reschedule_task: Object.freeze(['date', 'time']),
  show_day_plan: Object.freeze(['date']),
  show_week_plan: Object.freeze(['date'])
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} raw   mallin raakavastaus
 * @param {string} text   käyttäjän oma lause
 * @param {string} todayIso
 * @returns {{raw: unknown, corrections: string[]}}
 */
export function reconcileTemporal(raw, text, todayIso) {
  if (!isPlainObject(raw) || typeof raw.intent !== 'string') return { raw, corrections: [] };

  const fields = Object.prototype.hasOwnProperty.call(TEMPORAL_FIELDS, raw.intent)
    ? TEMPORAL_FIELDS[raw.intent] : null;
  if (!fields) return { raw, corrections: [] };

  const hints = temporalHints(text, todayIso, { intent: raw.intent });

  // Payload voi olla juuressa tai omassa kentässään (resolveCommand tukee molempia).
  const nested = isPlainObject(raw.payload);
  const source = nested ? raw.payload : raw;

  const changes = {};
  for (const field of fields) {
    const wanted = hints[field];
    if (!wanted) continue;
    // "Kahdella tunnilla eteenpäin" laskee ajan tehtävän omasta ajasta: kellonaikaa ei kosketa.
    if (field === 'time' && source.shiftMinutes != null) continue;
    if (source[field] !== wanted) changes[field] = wanted;
  }

  const corrections = Object.keys(changes);
  if (corrections.length === 0) return { raw, corrections };

  return {
    raw: nested ? { ...raw, payload: { ...raw.payload, ...changes } } : { ...raw, ...changes },
    corrections
  };
}
