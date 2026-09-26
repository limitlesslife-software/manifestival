// Reittitiedon raja: palveluriippumaton pyyntö, tulos ja rekisteri.
//
// PUHDAS MODUULI. Ei kelloa (nykyhetki annetaan), ei verkkoa, ei
// satunnaisuutta. Mahdollinen reittipalvelu annetaan rekisterille
// parametrina; tämä moduuli ei itse ota yhteyttä mihinkään.
//
// =====================================================================
// LIIKENNETIETOA EI KEKSITÄ
// =====================================================================
//
// Reittipalvelua ei ole valittu (omistajan päätös). Siksi rekisteri ilman
// palvelua vastaa JOKAISEEN kysymykseen "ei tiedossa" (UNKNOWN) -- ei
// koskaan oletuskestolla, arviolla tai nollalla. Keksitty kesto näyttäisi
// täsmälleen yhtä varmalta kuin oikea, ja käyttäjä myöhästyisi luottaen
// siihen.
//
// Kun palvelu joskus kytketään, sen jokainen vastaus kulkee saman tiukan
// tarkistuksen läpi (`normalizeRouteResponse`). Mikä tahansa puute tekee
// tuloksesta ERRORin; vanhentunut tulos on STALE eikä kanna kestoa.
//
// SIJAINTI: pyyntö kantaa paikan NIMEN tai OSOITTEEN tekstinä. Koordinaatteja
// ei hyväksytä pyyntöön eikä tallenneta mihinkään (ks. travel.js alku).
//
// Sopimus on travel.js:n TRAVEL_PROVIDER_CONTRACT; `validUntil` on sen
// `freshUntil`-kentän uusi nimi, ja vanha nimi hyväksytään yhä.

import { ROUTE_STATUS, TRAVEL_MODES, TRAVEL_MODE, MAX_TRAVEL_MINUTES } from './travel.js';

/** Tuloksen tila. Samat arvot kuin travel.js:n ROUTE_STATUS -- yksi totuus. */
export const ROUTING_STATUS = ROUTE_STATUS;

export const ROUTING_STATUSES = Object.freeze(Object.values(ROUTING_STATUS));

/** Tilan selite käyttäjälle. Rauhallinen, ei teknistä sanastoa. */
export const ROUTING_STATUS_TEXT = Object.freeze({
  [ROUTING_STATUS.OK]: 'Liikennetieto on ajan tasalla',
  [ROUTING_STATUS.UNKNOWN]: 'Liikennetietoa ei ole käytössä',
  [ROUTING_STATUS.STALE]: 'Liikennetieto on vanhentunut',
  [ROUTING_STATUS.ERROR]: 'Liikennetietoa ei saatu'
});

export function routingStatusText(status) {
  return ROUTING_STATUS_TEXT[status] || ROUTING_STATUS_TEXT[ROUTING_STATUS.UNKNOWN];
}

/** Pyynnön kentät. Kuvaus sopimuksesta, ei toteutus. */
export const ROUTE_REQUEST_FIELDS = Object.freeze(['origin', 'destination', 'departureTime', 'travelMode']);

/** Tuloksen kentät. */
export const ROUTE_RESULT_FIELDS = Object.freeze([
  'status', 'durationSeconds', 'distanceMeters', 'trafficAware', 'provider',
  'calculatedAt', 'validUntil', 'confidence', 'reason'
]);

export const ROUTE_CONFIDENCES = Object.freeze(['high', 'medium', 'low']);

const MAX_PLACE_TEXT = 300;
const MAX_PROVIDER_NAME = 40;
const MAX_ROUTE_SECONDS = MAX_TRAVEL_MINUTES * 60;
/** Laskenta-aika saa olla korkeintaan näin paljon "tulevaisuudessa" (kellojen ero). */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const NO_PROVIDER_REASON = 'Liikennetietoa ei ole käytössä.';

/** Ohjausmerkit pois; rivinvaihto ja sarkain välilyönniksi. Palauttaa null, jos tekstiä ei jää. */
function placeText(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\u{0}-\u{1F}\u{7F}-\u{9F}\u{200B}-\u{200F}\u{2028}-\u{202E}\u{2060}-\u{2069}\u{FEFF}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, MAX_PLACE_TEXT).join('');
}

function isoOrNull(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Normalisoi reittipyyntö. Palauttaa null, jos kohdetta ei ole.
 *
 * `origin` null tarkoittaa "tästä" -- sen ratkaisee alustasovitin
 * suorituksen ajaksi, eikä sijainti kulje tämän moduulin läpi. Muu kuin
 * teksti (esim. koordinaattiolio) pudotetaan: se ei kuulu tänne.
 * `departureTime` null tarkoittaa "nyt".
 */
export function normalizeRouteRequest(input) {
  if (!input || typeof input !== 'object') return null;
  let destination; let origin; let departureTime; let travelMode;
  try {
    if (Array.isArray(input)) return null;
    destination = placeText(input.destination);
    origin = placeText(input.origin);
    departureTime = isoOrNull(input.departureTime);
    travelMode = TRAVEL_MODES.includes(input.travelMode) ? input.travelMode : TRAVEL_MODE.DRIVING;
  } catch {
    return null;
  }
  if (!destination) return null;
  return Object.freeze({ origin, destination, departureTime, travelMode });
}

function failure(status, reason) {
  return Object.freeze({
    status,
    durationSeconds: null,
    distanceMeters: null,
    trafficAware: false,
    provider: null,
    calculatedAt: null,
    validUntil: null,
    confidence: null,
    reason
  });
}

/**
 * Tarkista reittipalvelun vastaus. EI KOSKAAN keksi kestoa.
 *
 * Suljettu epäonnistuminen:
 *   - nykyhetki puuttuu                       -> ERROR (tuoreutta ei voi todentaa)
 *   - vastaus ei ole olio                     -> ERROR
 *   - status UNKNOWN                          -> UNKNOWN
 *   - mikä tahansa muu kuin OK                -> ERROR
 *   - kesto ei ole 1 s .. 24 h äärellinen luku -> ERROR
 *   - palvelu, ajat tai varmuus puuttuvat     -> ERROR
 *   - laskenta-aika tulevaisuudessa           -> ERROR
 *   - voimassaolo päättynyt                   -> STALE (ilman kestoa)
 *
 * `trafficAware` on tosi VAIN, jos palvelu sanoo sen nimenomaisesti (true).
 *
 * @param {unknown} raw
 * @param {{nowMs:number}} options
 */
export function normalizeRouteResponse(raw, options) {
  const nowMs = options && typeof options === 'object' ? options.nowMs : undefined;
  if (!Number.isFinite(nowMs)) {
    return failure(ROUTING_STATUS.ERROR, 'Nykyhetkeä ei annettu, joten tuoreutta ei voi todentaa.');
  }
  if (!raw || typeof raw !== 'object') {
    return failure(ROUTING_STATUS.ERROR, 'Vastaus ei kelpaa.');
  }

  // Kentät luetaan kerran ja suojatusti: vieraan vastauksen getteri tai
  // välityspalvelin voi heittää, eikä se saa kaataa lähtölaskentaa.
  let fields;
  try {
    if (Array.isArray(raw)) return failure(ROUTING_STATUS.ERROR, 'Vastaus ei kelpaa.');
    fields = {
      status: raw.status,
      durationSeconds: raw.durationSeconds,
      distanceMeters: raw.distanceMeters,
      trafficAware: raw.trafficAware,
      provider: raw.provider,
      calculatedAt: raw.calculatedAt,
      validUntil: raw.validUntil ?? raw.freshUntil,
      confidence: raw.confidence
    };
  } catch {
    return failure(ROUTING_STATUS.ERROR, 'Vastaus ei kelpaa.');
  }

  if (fields.status === ROUTING_STATUS.UNKNOWN) {
    return failure(ROUTING_STATUS.UNKNOWN, 'Tälle matkalle ei ole liikennetietoa.');
  }
  if (fields.status !== ROUTING_STATUS.OK) {
    return failure(ROUTING_STATUS.ERROR, 'Liikennetietoa ei saatu.');
  }

  const seconds = fields.durationSeconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 1 || seconds > MAX_ROUTE_SECONDS) {
    return failure(ROUTING_STATUS.ERROR, 'Matkan kesto ei kelpaa.');
  }

  const provider = typeof fields.provider === 'string'
    ? fields.provider.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim().slice(0, MAX_PROVIDER_NAME) : '';
  if (!provider) return failure(ROUTING_STATUS.ERROR, 'Liikennetiedon lähde puuttuu.');

  const calculatedAt = isoOrNull(fields.calculatedAt);
  const validUntil = isoOrNull(fields.validUntil);
  if (!calculatedAt || !validUntil) {
    return failure(ROUTING_STATUS.ERROR, 'Liikennetiedolta puuttuvat ajat.');
  }
  const calculatedMs = Date.parse(calculatedAt);
  const validMs = Date.parse(validUntil);
  if (validMs <= calculatedMs) {
    return failure(ROUTING_STATUS.ERROR, 'Liikennetiedon voimassaolo ei kelpaa.');
  }
  if (calculatedMs > nowMs + MAX_CLOCK_SKEW_MS) {
    return failure(ROUTING_STATUS.ERROR, 'Liikennetiedon laskenta-aika on tulevaisuudessa.');
  }
  if (!ROUTE_CONFIDENCES.includes(fields.confidence)) {
    return failure(ROUTING_STATUS.ERROR, 'Liikennetiedon varmuus puuttuu.');
  }
  if (validMs <= nowMs) {
    return failure(ROUTING_STATUS.STALE, 'Liikennetieto on vanhentunut, joten sitä ei käytetä.');
  }

  const meters = fields.distanceMeters;
  const distanceMeters = typeof meters === 'number' && Number.isFinite(meters) && meters >= 0
    ? Math.round(meters) : null;

  return Object.freeze({
    status: ROUTING_STATUS.OK,
    durationSeconds: Math.round(seconds),
    distanceMeters,
    trafficAware: fields.trafficAware === true,
    provider,
    calculatedAt,
    validUntil,
    confidence: fields.confidence,
    reason: ''
  });
}

/**
 * Käyttökelpoisen tuloksen kesto minuutteina, pyöristettynä YLÖSPÄIN
 * (aliarvio olisi myöhästyminen). Muuten null -- ei koskaan nolla.
 */
export function routeResultMinutes(result) {
  if (!result || result.status !== ROUTING_STATUS.OK) return null;
  const seconds = result.durationSeconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 1) return null;
  return Math.min(Math.ceil(seconds / 60), MAX_TRAVEL_MINUTES);
}

/** Onko tulos yhä tuore hetkellä `nowMs`? Tarkistaa uudelleen, ei luota aiempaan tilaan. */
export function isRouteResultFresh(result, nowMs) {
  return normalizeRouteResponse(result, { nowMs }).status === ROUTING_STATUS.OK;
}

function usableProvider(provider) {
  try {
    return Boolean(provider) && typeof provider === 'object' && typeof provider.estimate === 'function';
  } catch {
    return false;
  }
}

function nameOf(provider) {
  try {
    const name = provider.name;
    return typeof name === 'string' && name.trim() ? name.trim().slice(0, MAX_PROVIDER_NAME) : null;
  } catch {
    return null;
  }
}

/**
 * Reittirekisteri.
 *
 * Ilman palvelua (oletus) `hasProvider()` on epätosi ja `route()` palauttaa
 * aina UNKNOWN-tuloksen: "Liikennetietoa ei ole käytössä." Palvelu annetaan
 * luotaessa; rekisteri on muuttumaton (vaihto = uusi rekisteri), joten
 * kukaan ei voi vaihtaa palvelua kesken laskennan.
 *
 * Palvelun poikkeus, kelvoton vastaus tai kelvoton pyyntö EIVÄT kaada
 * kutsujaa: ne palautuvat ERROR-tuloksena.
 *
 * @param {{provider?: {name?:string, estimate:(request:object)=>Promise<unknown>}|null}} [options]
 */
export function createRoutingRegistry(options) {
  const provider = options && typeof options === 'object' ? options.provider : null;
  const active = usableProvider(provider) ? provider : null;
  const providerName = active ? nameOf(active) : null;

  async function route(request, options) {
    const nowMs = options && typeof options === 'object' ? options.nowMs : undefined;
    if (!active) return failure(ROUTING_STATUS.UNKNOWN, NO_PROVIDER_REASON);
    const normalized = normalizeRouteRequest(request);
    if (!normalized) return failure(ROUTING_STATUS.ERROR, 'Matkan kohde puuttuu.');
    let raw;
    try {
      raw = await active.estimate(normalized);
    } catch {
      return failure(ROUTING_STATUS.ERROR, 'Liikennetietoa ei saatu.');
    }
    return normalizeRouteResponse(raw, { nowMs });
  }

  return Object.freeze({
    hasProvider: () => active !== null,
    providerName,
    route
  });
}
