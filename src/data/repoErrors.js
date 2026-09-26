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
import { failWith, AppError, ERROR_CODE } from '../lib/result.js';

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
  return failWith(described.code, described.userMessage, { cause, op: code, errorClass: described.errorClass });
}

/** catch-haaran lyhenne: `failFromCause(cause, { ...context, thrown: true })`. */
export function failFromThrown(cause, context) {
  return failFromCause(cause, { ...context, thrown: true });
}

/**
 * Tyypitetyn koodin luokka. `unknown` ei ole tässä: se on myös
 * tyypittämättömän virheen (lib/result.js, ilman koodia) oletuskoodi,
 * jonka syy luokitellaan.
 */
const CODE_CLASS = Object.freeze({
  [ERROR_CODE.NETWORK_ERROR]: ERROR_CLASS.NETWORK,
  [ERROR_CODE.AUTH_REQUIRED]: ERROR_CLASS.AUTH,
  [ERROR_CODE.PERSISTENCE_UNAVAILABLE]: ERROR_CLASS.SCHEMA,
  [ERROR_CODE.SERVICE_UNAVAILABLE]: ERROR_CLASS.UNAVAILABLE
});

/**
 * Virheen luokka koosteeseen ja näkymän ohjeeseen (latausvirheet).
 *
 * TYYPITETTY VIRHE EI LUOKITU UUDELLEEN. failFromCause valitsi jo luokan
 * (errorClass), ja heitetty poikkeus (koodi '') olisi classifyErrorissa
 * verkkovirhe: "päivitä, kun yhteys toimii" väärästä syystä. Järjestys:
 * tallennettu luokka, tyypitetty koodi, vasta sitten syyn luokitus.
 *
 * @param {unknown} error AppError tai Supabase-virhe
 * @param {{offline?: boolean}} [context]
 * @returns {string} ERROR_CLASS-arvo
 */
export function errorClassOf(error, { offline = false } = {}) {
  if (error instanceof AppError) {
    if (error.errorClass) return error.errorClass;
    if (Object.prototype.hasOwnProperty.call(CODE_CLASS, error.code)) return CODE_CLASS[error.code];
  }
  return classifyError(error, { offline });
}
