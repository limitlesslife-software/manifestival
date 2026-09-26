// Repositorioiden virhetulos: syy -> tyypitetty AppError, jonka viesti
// kertoo käyttäjälle mitä tapahtui ja mitä tehdä.
//
// Luokitus on src/domain/offlineQueue.js:n classifyError (sama, jolla
// offline-jono ja aikakirjausten lähtökori päättävät uudelleenyrityksestä)
// ja viesti src/lib/errorMessages.js:n describeError. Tämä moduuli vain
// yhdistää ne, koska lib-kerros ei saa importoida domainia.
//
// ALKUPERÄINEN SYY SÄILYY `cause`-kentässä: kutsujat (jonotus, lähtökori,
// kaksoiskappaleen tunnistus) luokittelevat sen yhä itse. Käyttäjälle
// näkyy vain describeErrorin kiinteä teksti.

import { classifyError, ERROR_CLASS } from '../domain/offlineQueue.js';
import { describeError } from '../lib/errorMessages.js';
import { failWith } from '../lib/result.js';

/** Laite ilmoittaa olevansa offline (sama tarkistus kuin src/app/offline.js). */
function deviceOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * Virhe -> epäonnistunut tulos.
 *
 * HEITETTY POIKKEUS (`thrown: true`) EI OLE VERKKOVIRHE. Supabase-js ei
 * heitä verkkovirheestä vaan palauttaa sen `{ error }`-kentässä. Heitetty
 * poikkeus on siksi lähes aina jotain muuta (istunto puuttuu, asiakasta ei
 * ladattu, ohjelmavirhe), ja "Ei yhteyttä palvelimeen" olisi väärä neuvo.
 * Vain laitteen tiedossa oleva offline-tila on silloin verkko.
 *
 * @param {unknown} cause Supabasen `{ error }` tai heitetty poikkeus
 * @param {object} context
 * @param {'load'|'save'|'delete'} context.op
 * @param {string} context.fallback kiinteä teksti tuntemattomalle syylle
 * @param {string} context.code operaatio lokitukseen, esim. 'tasks.insert'
 * @param {boolean} [context.thrown] syy on catch-haarasta
 */
export function failFromCause(cause, { op, fallback, code, thrown = false }) {
  const offline = deviceOffline();
  const errorClass = thrown
    ? (offline ? ERROR_CLASS.NETWORK : ERROR_CLASS.UNKNOWN)
    : classifyError(cause, { offline });
  const described = describeError(cause, { op, offline, fallback, errorClass });
  return failWith(described.code, described.userMessage, { cause, op: code });
}

/** catch-haaran lyhenne: `failFromCause(cause, { ...context, thrown: true })`. */
export function failFromThrown(cause, context) {
  return failFromCause(cause, { ...context, thrown: true });
}
