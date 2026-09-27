// Tallennetut paikat: tekstin tunnistus, opitut nimet ja ehdotukset.
//
// PUHDAS MODUULI. Ei kelloa, ei verkkoa, ei satunnaisuutta, ei sijaintia.
// Paikka on NIMI ja OSOITETEKSTI -- ei koordinaatti (ks. travel.js alku).
//
// =====================================================================
// EI KOSKAAN ARVATA
// =====================================================================
//
// "Parturi" voi tarkoittaa kahta eri parturia. Väärin arvattu paikka on
// pahempi kuin kysymys: lähtöaika laskettaisiin väärään osoitteeseen ja
// näyttäisi silti varmalta. Siksi tunnistus palauttaa varman tuloksen vain
// kahdessa tapauksessa:
//
//   EXACT    teksti on täsmälleen tallennetun paikan nimi
//   LEARNED  teksti on opittu nimi, jonka käyttäjä on vahvistanut
//            vähintään kahdesti, ja se viittaa YHTEEN paikkaan
//
// Kaikki muu on AMBIGUOUS (ehdokkaat, käyttäjä valitsee) tai NONE.
//
// Opittu nimi (place_aliases) syntyy vain käyttäjän vahvistuksesta
// (confirmPlaceAlias); tämä moduuli ei kirjoita mitään.

import { MAX_ALIAS_LENGTH } from './dailyLife.js';
import { suggestPlaces } from './travel.js';

export const PLACE_MATCH = Object.freeze({
  EXACT: 'exact',
  LEARNED: 'learned',
  AMBIGUOUS: 'ambiguous',
  NONE: 'none'
});

export const PLACE_CONFIDENCE = Object.freeze({
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  NONE: 'none'
});

/** Opittu nimi ratkaisee paikan vasta näin monen vahvistuksen jälkeen. */
export const MIN_ALIAS_CONFIRMATIONS = 2;
/** Vahvistuksia, joista alkaen opittu nimi on "varma". */
export const HIGH_CONFIDENCE_CONFIRMATIONS = 4;
export const MAX_PLACE_CANDIDATES = 8;
export const DEFAULT_SUGGESTION_LIMIT = 8;
export const MAX_SUGGESTION_LIMIT = 20;
/** Osittainen haku vaatii vähintään näin monta merkkiä ("a" sopisi kaikkeen). */
const MIN_PARTIAL_QUERY = 2;
/** Teksti voi sisältää paikan nimen ("hammaslääkäri klo 10"), jos nimi on vähintään näin pitkä. */
const MIN_CONTAINED_NAME = 3;
/** Pidempi syöte ei ole paikannimi; katkaistaan, jotta työ pysyy rajattuna. */
const MAX_QUERY_LENGTH = 200;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Vertailumuoto: NFC, välilyönnit yhdeksi, reunat pois, pienet kirjaimet
 * suomen säännöillä. Sama sääntö kuin opittujen nimien tallennuksessa
 * (savedPlace.normalizeAliasText); molemmat puolet taitetaan tällä ennen
 * vertailua, joten pieni ero tallennuksessa ei riko tunnistusta.
 */
export function foldPlaceText(value) {
  if (typeof value !== 'string') return '';
  const folded = value
    .normalize('NFC')
    .replace(/[\u{0}-\u{1F}\u{7F}-\u{9F}\u{200B}-\u{200F}\u{2028}-\u{202E}\u{2060}-\u{2069}\u{FEFF}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('fi');
  return folded.length > MAX_QUERY_LENGTH ? folded.slice(0, MAX_QUERY_LENGTH) : folded;
}

/** Suomalainen aakkosjärjestys (sama kuin localeCompare(…, 'fi')), luotu kerran. */
const FI = new Intl.Collator('fi');

function byName(a, b) {
  return FI.compare(a.name, b.name) || FI.compare(a.id, b.id);
}

/** Kelvolliset paikat (id ja nimi), tunnisteen mukaan kerran, deterministisessä järjestyksessä. */
function validPlaces(list) {
  const seen = new Map();
  for (const place of Array.isArray(list) ? list : []) {
    if (!isObject(place) || typeof place.id !== 'string' || !place.id) continue;
    if (typeof place.name !== 'string' || !foldPlaceText(place.name)) continue;
    const existing = seen.get(place.id);
    // Sama tunniste kahdesti on datavirhe: valitaan aina sama (nimen mukaan), ei syötejärjestyksen.
    if (!existing || byName(place, existing) < 0) seen.set(place.id, place);
  }
  return [...seen.values()].sort(byName);
}

function confirmationsOf(alias) {
  const n = isObject(alias) ? alias.confirmations : null;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0;
}

/** Opitut nimet paikoittain: placeId -> [{ folded, confirmations, alias }]. Vain olemassa oleville paikoille. */
function aliasIndex(list, placeIds) {
  const index = new Map();
  for (const alias of Array.isArray(list) ? list : []) {
    if (!isObject(alias) || typeof alias.placeId !== 'string' || !placeIds.has(alias.placeId)) continue;
    const folded = foldPlaceText(alias.alias);
    const confirmations = confirmationsOf(alias);
    if (!folded || confirmations === 0) continue;
    const entries = index.get(alias.placeId);
    const entry = { folded, confirmations, alias };
    if (entries) entries.push(entry);
    else index.set(alias.placeId, [entry]);
  }
  return index;
}

/**
 * Opitun nimen varmuus vahvistusten määrästä.
 *   0 -> none, 1 -> low, 2-3 -> medium, 4+ -> high
 * Hyväksyy luvun tai alias-olion ({confirmations}).
 */
export function aliasConfidence(aliasOrConfirmations) {
  const n = typeof aliasOrConfirmations === 'number'
    ? (Number.isFinite(aliasOrConfirmations) && aliasOrConfirmations >= 1 ? Math.floor(aliasOrConfirmations) : 0)
    : confirmationsOf(aliasOrConfirmations);
  if (n >= HIGH_CONFIDENCE_CONFIRMATIONS) return PLACE_CONFIDENCE.HIGH;
  if (n >= MIN_ALIAS_CONFIRMATIONS) return PLACE_CONFIDENCE.MEDIUM;
  if (n >= 1) return PLACE_CONFIDENCE.LOW;
  return PLACE_CONFIDENCE.NONE;
}

function timesText(n) {
  return n === 1 ? 'kerran' : `${n} kertaa`;
}

function displayAlias(folded) {
  const chars = Array.from(folded);
  if (chars.length === 0) return '';
  return chars[0].toLocaleUpperCase('fi') + chars.slice(1).join('');
}

/**
 * Opitun nimen kuvaus käyttäjälle: "Parturi → Parturi Kallio (vahvistettu 3 kertaa)".
 * Kelvottomalla syötteellä null.
 */
export function describeLearning(alias, place) {
  if (!isObject(alias) || !isObject(place) || typeof place.name !== 'string') return null;
  const folded = foldPlaceText(alias.alias);
  const name = place.name.trim();
  const confirmations = confirmationsOf(alias);
  if (!folded || !name || confirmations === 0) return null;
  const shown = Array.from(folded).slice(0, MAX_ALIAS_LENGTH).join('');
  return `${displayAlias(shown)} → ${name} (vahvistettu ${timesText(confirmations)})`;
}

function result(status, place, candidates, confidence, reason) {
  return Object.freeze({
    status,
    place,
    candidates: Object.freeze(candidates.slice(0, MAX_PLACE_CANDIDATES)),
    confidence,
    reason
  });
}

/** Osittaisen osuman pisteet; 0 = ei osu. */
function partialScore(place, query, aliases) {
  const name = foldPlaceText(place.name);
  let score = 0;
  if (name.startsWith(query)) score = Math.max(score, 4);
  else if (name.split(' ').some(word => word.startsWith(query))) score = Math.max(score, 3);
  else if (name.includes(query)) score = Math.max(score, 2);
  if (name.length >= MIN_CONTAINED_NAME && query.includes(name)) score = Math.max(score, 3);
  if (aliases && aliases.some(entry => entry.folded.includes(query) || (entry.folded.length >= MIN_CONTAINED_NAME && query.includes(entry.folded)))) {
    score = Math.max(score, 2);
  }
  const area = foldPlaceText(place.area);
  if (area && area.includes(query)) score = Math.max(score, 1);
  const address = foldPlaceText(place.address);
  if (address && address.includes(query)) score = Math.max(score, 1);
  return score;
}

function rankCandidates(places, query, index) {
  const scored = [];
  for (const place of places) {
    const score = partialScore(place, query, index.get(place.id));
    if (score > 0) scored.push({ place, score });
  }
  scored.sort((a, b) => b.score - a.score || byName(a.place, b.place));
  return scored.map(entry => entry.place);
}

/**
 * Tunnista käyttäjän kirjoittama tai sanoma paikka.
 *
 * @param {string} text
 * @param {{places?:Array, aliases?:Array}} context
 * @returns {{status:'exact'|'learned'|'ambiguous'|'none', place:object|null,
 *            candidates:object[], confidence:'high'|'medium'|'low'|'none', reason:string}}
 */
export function resolvePlaceText(text, context) {
  const ctx = isObject(context) ? context : {};
  const query = foldPlaceText(text);
  if (!query) return result(PLACE_MATCH.NONE, null, [], PLACE_CONFIDENCE.NONE, 'Paikkaa ei annettu.');

  const places = validPlaces(ctx.places);
  const placeById = new Map(places.map(place => [place.id, place]));
  const index = aliasIndex(ctx.aliases, placeById);

  // 1. Täsmälleen tallennetun paikan nimi.
  const exact = places.filter(place => foldPlaceText(place.name) === query);
  if (exact.length === 1) {
    return result(PLACE_MATCH.EXACT, exact[0], exact, PLACE_CONFIDENCE.HIGH,
      `Nimi on tallennettu paikka ${exact[0].name.trim()}.`);
  }
  if (exact.length > 1) {
    return result(PLACE_MATCH.AMBIGUOUS, null, exact, PLACE_CONFIDENCE.LOW,
      'Samalla nimellä on useampi paikka. Valitse oikea.');
  }

  // 2. Opittu nimi.
  const learned = [];
  for (const [placeId, entries] of index) {
    let confirmations = 0;
    for (const entry of entries) if (entry.folded === query) confirmations += entry.confirmations;
    if (confirmations > 0) learned.push({ place: placeById.get(placeId), confirmations });
  }
  if (learned.length === 1) {
    const [{ place, confirmations }] = learned;
    if (confirmations >= MIN_ALIAS_CONFIRMATIONS) {
      return result(PLACE_MATCH.LEARNED, place, [place], aliasConfidence(confirmations),
        `Olet vahvistanut tämän nimen paikaksi ${place.name.trim()} ${timesText(confirmations)}.`);
    }
    // Kerran vahvistettu ei vielä päätä: kerran valittu paikka ensin, mutta
    // muutkin nimeen sopivat paikat pysyvät valittavina (useampi ehdokas -> kysytään).
    const others = Array.from(query).length >= MIN_PARTIAL_QUERY
      ? rankCandidates(places, query, index).filter(candidate => candidate.id !== place.id)
      : [];
    return result(PLACE_MATCH.AMBIGUOUS, null, [place, ...others], PLACE_CONFIDENCE.LOW,
      `Tarkoititko paikkaa ${place.name.trim()}? Nimi on yhdistetty siihen vasta kerran.${others.length > 0 ? ' Valitse oikea.' : ''}`);
  }
  if (learned.length > 1) {
    learned.sort((a, b) => b.confirmations - a.confirmations || byName(a.place, b.place));
    return result(PLACE_MATCH.AMBIGUOUS, null, learned.map(entry => entry.place), PLACE_CONFIDENCE.LOW,
      'Nimi on yhdistetty useampaan paikkaan. Valitse oikea.');
  }

  // 3. Osittaiset osumat: aina kysymys, ei koskaan päätös.
  if (Array.from(query).length >= MIN_PARTIAL_QUERY) {
    const candidates = rankCandidates(places, query, index);
    if (candidates.length === 1) {
      return result(PLACE_MATCH.AMBIGUOUS, null, candidates, PLACE_CONFIDENCE.LOW,
        `Tarkoititko paikkaa ${candidates[0].name.trim()}?`);
    }
    if (candidates.length > 1) {
      return result(PLACE_MATCH.AMBIGUOUS, null, candidates, PLACE_CONFIDENCE.LOW,
        'Useampi paikka sopii. Valitse oikea.');
    }
  }

  return result(PLACE_MATCH.NONE, null, [], PLACE_CONFIDENCE.NONE, 'Tallennettua paikkaa ei löytynyt.');
}

function suggestionOf(place) {
  return Object.freeze({
    placeId: place.id,
    name: place.name.trim(),
    area: typeof place.area === 'string' && place.area.trim() ? place.area.trim() : null,
    saved: true
  });
}

/**
 * Paikkaehdotukset valintalistaan: tallennetut paikat ensin, sitten
 * matkoista ja paikkamuistutuksista tutut nimet (travel.js suggestPlaces).
 *
 * Ilman hakua tallennetut järjestetään käytön mukaan (opittujen nimien
 * vahvistukset yhteensä), sitten nimen mukaan. Haulla järjestys on
 * osuman laadun mukaan. Kaksoiskappaleita (sama nimi) ei tule.
 *
 * @param {{places?:Array, aliases?:Array, query?:string, limit?:number,
 *          travelPlans?:Array, locationRules?:Array}} input
 * @returns {ReadonlyArray<{placeId:string|null, name:string, area:string|null, saved:boolean}>}
 */
export function placeSuggestions(input) {
  const opts = isObject(input) ? input : {};
  const limit = Number.isInteger(opts.limit) && opts.limit >= 0
    ? Math.min(opts.limit, MAX_SUGGESTION_LIMIT) : DEFAULT_SUGGESTION_LIMIT;
  if (limit === 0) return Object.freeze([]);

  const places = validPlaces(opts.places);
  const placeById = new Map(places.map(place => [place.id, place]));
  const index = aliasIndex(opts.aliases, placeById);
  const query = foldPlaceText(opts.query);

  let saved;
  if (query) {
    saved = rankCandidates(places, query, index);
  } else {
    const usage = place => (index.get(place.id) || []).reduce((sum, entry) => sum + entry.confirmations, 0);
    saved = places
      .map(place => ({ place, uses: usage(place) }))
      .sort((a, b) => b.uses - a.uses || byName(a.place, b.place))
      .map(entry => entry.place);
  }

  const out = saved.slice(0, limit).map(suggestionOf);
  const taken = new Set(places.map(place => foldPlaceText(place.name)));
  if (out.length < limit) {
    for (const name of suggestPlaces(opts.travelPlans, opts.locationRules)) {
      if (out.length >= limit) break;
      const folded = foldPlaceText(name);
      if (!folded || taken.has(folded)) continue;
      if (query && !folded.includes(query)) continue;
      taken.add(folded);
      out.push(Object.freeze({ placeId: null, name, area: null, saved: false }));
    }
  }
  return Object.freeze(out);
}
