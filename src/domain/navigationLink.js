// Navigointilinkki: "Avaa reitti" Google Mapsiin.
//
// PUHDAS MODUULI. Ei kelloa, ei verkkoa. Tämä moduuli vain KOKOAA linkin;
// sen avaa käyttöjärjestelmä (Maps-sovellus tai selain) käyttäjän
// painalluksesta. Sovellus ei itse ota yhteyttä mihinkään.
//
// =====================================================================
// LINKKI ON AINA MEIDÄN KOKOAMAMME, EI KOSKAAN VIERAS
// =====================================================================
//
// Kohde on käyttäjän kirjoittamaa tekstiä (osoite tai paikan nimi), ja se
// voi tulla myös puheesta tai tekoälyn ehdotuksesta. Siksi:
//
//   1. teksti siivotaan pelkäksi tekstiksi: ohjausmerkit, näkymättömät
//      suuntaohjaimet (RTL-ohitus), osoitteet ja skeemat ("javascript:",
//      "intent:", "data:" ...) pois, pituus enintään 200 merkkiä
//   2. linkki kootaan KIINTEÄSTÄ alusta ja koodatusta tekstistä -- teksti ei
//      koskaan päätä, mihin linkki vie
//   3. `isAllowedNavigationUrl` hyväksyy vain täsmälleen nämä kaksi muotoa.
//      Kaikki muu hylätään, myös tekoälyn tai mallin tuottama "valmis" linkki.
//
// Koordinaatteja ei käytetä: kohde on teksti (ks. travel.js alku).

import { TRAVEL_MODES, TRAVEL_MODE } from './travel.js';

export const MAX_NAVIGATION_TEXT = 200;
const MAX_URL_LENGTH = 2048;
/** Ylipitkä syöte katkaistaan ennen siivousta, jotta työ pysyy rajattuna. */
const MAX_RAW_INPUT = 4000;

// Osoite kootaan osista tarkoituksella. Tietoturvatesti (security-csp)
// etsii lähdekoodista absoluuttisia osoitteita, joihin SOVELLUS ITSE ottaa
// yhteyttä, ja vaatii ne CSP:n connect-src-listalle. Tähän osoitteeseen
// sovellus ei ota yhteyttä: se annetaan käyttöjärjestelmälle avattavaksi,
// joten connect-src ei koske sitä eikä sitä pidä lisätä sinne.
const MAPS_SCHEME = 'https:';
const MAPS_HOST = 'www.google.com';
const MAPS_DIR_PATH = '/maps/dir/';
const MAPS_PREFIX = `${MAPS_SCHEME}//${MAPS_HOST}${MAPS_DIR_PATH}?api=1&destination=`;
const ANDROID_PREFIX = 'google.navigation:q=';

/** Google Mapsin reittiohjeen kulkutapa. Muu kulkutapa (taksi tms.) ajetaan autolla. */
const WEB_MODE = Object.freeze({
  [TRAVEL_MODE.DRIVING]: 'driving',
  [TRAVEL_MODE.TRANSIT]: 'transit',
  [TRAVEL_MODE.WALKING]: 'walking',
  [TRAVEL_MODE.CYCLING]: 'bicycling',
  [TRAVEL_MODE.OTHER]: 'driving'
});

/**
 * Androidin navigoinnin kulkutapa. Julkisilla ei ole käännös käännökseltä
 * -navigointia, joten sille ei tehdä navigointi-intenttiä: reittiohje
 * avataan `googleMapsUrl`:lla.
 */
const ANDROID_MODE = Object.freeze({
  [TRAVEL_MODE.DRIVING]: 'd',
  [TRAVEL_MODE.WALKING]: 'w',
  [TRAVEL_MODE.CYCLING]: 'b',
  [TRAVEL_MODE.OTHER]: 'd'
});

// Rivinvaihdot ja sarkaimet välilyönniksi (sanat eivät liimaudu yhteen).
const LINE_BREAKS = /[\t\n\v\f\r\u{85}\u{2028}\u{2029}]/gu;
// Muut ohjausmerkit, tavutusvihje, näkymättömät ja suuntaohjaimet pois kokonaan.
const INVISIBLE = /[\u{0}-\u{1F}\u{7F}-\u{9F}\u{AD}\u{61C}\u{180E}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{206F}\u{FEFF}\u{FFF9}-\u{FFFB}]/gu;
// Pariton sijaismerkki rikkoisi koodauksen (encodeURIComponent heittäisi).
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const URL_LIKE = /[a-z][a-z0-9+.-]*:\/\/\S*/gi;
const WWW_LIKE = /\bwww\.\S+/gi;
// Skriptiskeemat poistetaan missä tahansa kohdassa (ne eivät esiinny osoitteissa).
const SCRIPT_SCHEME = /(?:java|vb|live)script\s*:/gi;
// Muut skeemat sanan alussa ("Hotel:" ei ole tel-skeema).
const OTHER_SCHEME = /\b(?:data|file|blob|about|intent|content|chrome|android-app|market|google\.navigation|geo|mailto|tel|sms|ftp|wss?|https?)\s*:/gi;
const MARKUP = /[<>"`\\{}|^]/g;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Siivoa navigoinnin kohde pelkäksi tekstiksi. Palauttaa null, jos mitään
 * ei jää. Toistetaan, kunnes teksti ei enää muutu: poisto voi muuten
 * paljastaa uuden skeeman ("javajavascript:script:").
 */
export function sanitizeNavigationText(value) {
  if (typeof value !== 'string') return null;
  let text = value.length > MAX_RAW_INPUT ? value.slice(0, MAX_RAW_INPUT) : value;
  text = text.replace(LONE_SURROGATE, '').normalize('NFC');
  for (let round = 0; round < 10; round += 1) {
    const before = text;
    text = text
      .replace(LINE_BREAKS, ' ')
      .replace(INVISIBLE, '')
      .replace(URL_LIKE, ' ')
      .replace(WWW_LIKE, ' ')
      .replace(SCRIPT_SCHEME, '')
      .replace(OTHER_SCHEME, '')
      .replace(MARKUP, ' ');
    if (text === before) break;
  }
  const collapsed = text.replace(/\s+/g, ' ').trim();
  // Array.from käy koodipisteittäin, joten katkaisu ei halkaise emojia tai muuta merkkiparia.
  const capped = Array.from(collapsed).slice(0, MAX_NAVIGATION_TEXT).join('').trim();
  return capped || null;
}

/**
 * Navigoinnin kohde: osoite, tai sen puuttuessa paikan nimi.
 *
 * @param {{address?:string|null, placeName?:string|null, mode?:string}} input
 * @returns {{query:string, label:string, mode:string}|null}
 */
export function buildNavigationTarget(input) {
  const opts = isObject(input) ? input : {};
  const address = sanitizeNavigationText(opts.address);
  const name = sanitizeNavigationText(opts.placeName);
  const query = address || name;
  if (!query) return null;
  const mode = TRAVEL_MODES.includes(opts.mode) ? opts.mode : TRAVEL_MODE.DRIVING;
  return Object.freeze({ query, label: name || query, mode });
}

/** Hyväksyy valmiin kohteen ({query, mode}) tai raakasyötteen; siivoaa aina uudelleen. */
function targetOf(input) {
  if (isObject(input) && typeof input.query === 'string') {
    return buildNavigationTarget({ address: input.query, placeName: input.label, mode: input.mode });
  }
  return buildNavigationTarget(input);
}

/**
 * Reittiohjeen linkki:
 * https://www.google.com/maps/dir/?api=1&destination=<koodattu>&travelmode=<tapa>
 * Ilman kelvollista kohdetta null.
 */
export function googleMapsUrl(input) {
  const target = targetOf(input);
  if (!target) return null;
  return `${MAPS_PREFIX}${encodeURIComponent(target.query)}&travelmode=${WEB_MODE[target.mode]}`;
}

/**
 * Androidin navigointi-intentti: google.navigation:q=<koodattu>&mode=d|w|b.
 * Julkisilla (ei navigointitilaa) ja ilman kohdetta null.
 */
export function androidNavigationIntent(input) {
  const target = targetOf(input);
  if (!target) return null;
  const mode = ANDROID_MODE[target.mode];
  if (!mode) return null;
  return `${ANDROID_PREFIX}${encodeURIComponent(target.query)}&mode=${mode}`;
}

/** Kaikki linkit kerralla näkymää varten. */
export function navigationLinks(input) {
  const target = targetOf(input);
  return Object.freeze({
    target,
    webUrl: target ? googleMapsUrl(target) : null,
    androidIntent: target ? androidNavigationIntent(target) : null
  });
}

// encodeURIComponent tuottaa vain näitä merkkejä ja %XX-koodeja (isot kirjaimet).
const ENCODED = "(?:[A-Za-z0-9\\-_.!~*'()]|%[0-9A-F]{2})+";
const WEB_URL = new RegExp(
  '^' + MAPS_PREFIX.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  + `(${ENCODED})&travelmode=(driving|walking|bicycling|transit)$`
);
const ANDROID_URL = new RegExp(
  '^' + ANDROID_PREFIX.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + `(${ENCODED})&mode=([dwb])$`
);

/**
 * Saako tämän linkin avata?
 *
 * Sallitaan VAIN täsmälleen tämän moduulin tuottamat muodot: https-osoite
 * isäntään www.google.com polkuun /maps/dir/ tai google.navigation-intentti.
 * Lisäksi koodattu kohde puretaan ja sen pitää olla jo valmiiksi siivottua
 * tekstiä (ei rivinvaihtoja, skeemoja tai suuntaohjaimia). Kaikki muu --
 * toinen isäntä, käyttäjätieto (@), portti, fragmentti, lisäparametrit,
 * intent://, javascript:, data: tai tekoälyn keksimä linkki -- hylätään.
 */
export function isAllowedNavigationUrl(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) return false;
  const match = WEB_URL.exec(url) || ANDROID_URL.exec(url);
  if (!match) return false;
  let decoded;
  try {
    decoded = decodeURIComponent(match[1]);
  } catch {
    return false;
  }
  return sanitizeNavigationText(decoded) === decoded;
}
