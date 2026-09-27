// Tallennetut paikat ja niiden lisänimet.
//
// PUHDAS MODUULI: ei kelloa, ei DOM:ia, ei verkkoa.
//
// PAIKKA ON NIMI JA OSOITE TEKSTINÄ, EI KOORDINAATTI. Sijaintia ei
// tallenneta eikä päätellä (ks. migraatio 0014). `providerPlaceId` on
// liikennetietopalvelun oma tunniste samalle paikalle, ei sijainti.
//
// Matka-arvot ovat käyttäjän omia: `usualTravelMinutes` on "yleensä
// tähän menee noin", EI liikennetietoa. Tuntematon on null, ei nolla —
// nollasta laskettu lähtöaika olisi vale.
//
// LISÄNIMI ("sali", "mökki") syntyy vain käyttäjän vahvistuksesta. Se
// normalisoidaan niin, että puheesta ja näppäimistöltä tullut sama sana
// on sama avain: trimmattu, yksi välilyönti, NFC, pienet kirjaimet
// suomen säännöillä.

import {
  MAX_PLACE_NAME_LENGTH, MAX_ADDRESS_LENGTH, MAX_ALIAS_LENGTH, MAX_TRAVEL_MINUTES,
  MAX_PREPARATION_MINUTES, MAX_PLACE_ARRIVAL_BUFFER_MINUTES, MAX_OVERHEAD_MINUTES
} from './dailyLife.js';
import { TRAVEL_MODE, TRAVEL_MODES } from './travel.js';
import {
  idOrNull, textOrNull, requiredText, intOrNull, boolOr, oneOf, timestampOrNull
} from './entityFields.js';

// Rajat, joita dailyLife.js ei määrittele. Vastaavat migraation 0014
// CHECK-rajoitteita (saved_places_*_check, place_aliases_*_check).
export const MAX_PROVIDER_PLACE_ID_LENGTH = 200;
export const MAX_AREA_LENGTH = 80;
export const MAX_PLACE_NOTE_LENGTH = 500;
export const MAX_ALIAS_CONFIRMATIONS = 10000;

/**
 * Normalisoi tallennettu paikka. Ei heitä; roska -> null tai oletus.
 * @param {object} [input]
 */
export function normalizeSavedPlace(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    id: idOrNull(source.id),
    name: requiredText(source.name, MAX_PLACE_NAME_LENGTH),
    address: textOrNull(source.address, MAX_ADDRESS_LENGTH),
    providerPlaceId: textOrNull(source.providerPlaceId, MAX_PROVIDER_PLACE_ID_LENGTH),
    area: textOrNull(source.area, MAX_AREA_LENGTH),
    travelMode: oneOf(source.travelMode, TRAVEL_MODES, TRAVEL_MODE.DRIVING),
    usualTravelMinutes: intOrNull(source.usualTravelMinutes, 1, MAX_TRAVEL_MINUTES),
    preparationMinutes: intOrNull(source.preparationMinutes, 0, MAX_PREPARATION_MINUTES),
    arrivalBufferMinutes: intOrNull(source.arrivalBufferMinutes, 0, MAX_PLACE_ARRIVAL_BUFFER_MINUTES),
    overheadMinutes: intOrNull(source.overheadMinutes, 0, MAX_OVERHEAD_MINUTES),
    // Opittua matka-aikaa käytetään vain käyttäjän nimenomaisella luvalla.
    useLearned: boolOr(source.useLearned, false),
    note: textOrNull(source.note, MAX_PLACE_NOTE_LENGTH),
    createdAt: source.createdAt ?? null,
    updatedAt: source.updatedAt ?? null
  };
}

/** Nimen vertailuavain: kanta estää saman nimen kirjainkoosta riippumatta. */
export function placeNameKey(name) {
  return typeof name === 'string' ? name.trim().toLocaleLowerCase('fi') : '';
}

/**
 * Tarkista paikka. `existing` = muut tallennetut paikat: sama nimi
 * (kirjainkoosta riippumatta) toisella paikalla on virhe jo ennen kantaa.
 *
 * @returns {{valid: boolean, errors: Record<string, string>}}
 */
export function validateSavedPlace(place, { existing = [] } = {}) {
  const errors = {};
  if (!place || typeof place !== 'object') return { valid: false, errors: { place: 'Paikkaa ei ole.' } };
  if (!place.name) {
    errors.name = 'Anna paikalle nimi.';
  } else if (place.name.length > MAX_PLACE_NAME_LENGTH) {
    errors.name = `Nimi on liian pitkä (enintään ${MAX_PLACE_NAME_LENGTH} merkkiä).`;
  } else {
    const key = placeNameKey(place.name);
    const clash = (Array.isArray(existing) ? existing : [])
      .some(other => other && other.id !== place.id && placeNameKey(other.name) === key);
    if (clash) errors.name = 'Sinulla on jo tämänniminen paikka.';
  }
  if (place.usualTravelMinutes !== null && place.usualTravelMinutes !== undefined
    && !(Number.isInteger(place.usualTravelMinutes) && place.usualTravelMinutes >= 1
      && place.usualTravelMinutes <= MAX_TRAVEL_MINUTES)) {
    errors.usualTravelMinutes = 'Matka-aika on 1–1440 minuuttia.';
  }
  if (!TRAVEL_MODES.includes(place.travelMode)) errors.travelMode = 'Valitse kulkutapa.';
  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Lisänimen normalisoitu muoto: NFC, trimmattu, välilyönnit yhdeksi,
 * pienet kirjaimet suomen säännöillä, rajattu. Roska -> ''.
 */
export function normalizeAliasText(text) {
  if (typeof text !== 'string' && typeof text !== 'number') return '';
  return String(text)
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('fi')
    .slice(0, MAX_ALIAS_LENGTH)
    .trim();
}

/** Normalisoi lisänimi. Vahvistuksia on aina vähintään yksi. */
export function normalizePlaceAlias(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    id: idOrNull(source.id),
    placeId: idOrNull(source.placeId),
    alias: normalizeAliasText(source.alias),
    confirmations: intOrNull(source.confirmations, 1, MAX_ALIAS_CONFIRMATIONS) ?? 1,
    lastConfirmedAt: timestampOrNull(source.lastConfirmedAt),
    createdAt: source.createdAt ?? null,
    updatedAt: source.updatedAt ?? null
  };
}

export function validatePlaceAlias(alias) {
  const errors = {};
  if (!alias || typeof alias !== 'object') return { valid: false, errors: { alias: 'Lisänimeä ei ole.' } };
  if (!alias.placeId) errors.placeId = 'Valitse paikka, johon lisänimi kuuluu.';
  if (!alias.alias) errors.alias = 'Lisänimi puuttuu.';
  return { valid: Object.keys(errors).length === 0, errors };
}
