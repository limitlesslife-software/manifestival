// Matka ja lähtöaika.
//
// =====================================================================
// MATKA-AIKAA EI KEKSITÄ
// =====================================================================
//
// Manifestivalilla ei ole reittipalvelua. Siksi tässä moduulissa ei ole
// yhtäkään kilometriä, ruuhkakerrointa eikä arvattua kestoa.
//
// Kesto on joko
//
//   KÄYTTÄJÄN ITSE ARVIOIMA    merkitty käsin syötetyksi
//   PALVELUNTARJOAJALTA        merkitty lähteineen ja tuoreuksineen
//   TUNTEMATON                 ja silloin lähtöaikaa EI LASKETA
//
// Keksitty matka-aika olisi tässä sovelluksessa erityisen vahingollinen:
// se tuottaisi lähtöajan, joka näyttää täsmälleen yhtä varmalta kuin
// oikea, ja käyttäjä myöhästyisi luottaen siihen.
//
// `TravelTimeProvider` alla on rajapinta myöhempää integraatiota varten.
// Sitä ei ole toteutettu, eikä sen puuttuminen estä mitään: käyttäjä voi
// kirjata keston itse.
//
// =====================================================================
// LÄHTÖAIKA ON VÄHENNYSLASKU, EI ARVIO
// =====================================================================
//
//   lähtöaika = saapumisaika
//               - matka-aika
//               - valmistautuminen
//               - pysäköinti ja kävely
//
// Jokainen osa on näkyvissä erikseen, koska käyttäjä säätää niitä
// erikseen. Yksi luku ilman erittelyä olisi mahdoton korjata.
//
// =====================================================================
// SIJAINTI ON HERKINTÄ TIETOA
// =====================================================================
//
// Tämä moduuli EI käsittele koordinaatteja. Se tuntee paikan NIMEN ja
// matkan KESTON. Koordinaatit, jos niitä joskus tarvitaan, kuuluvat
// alustasovittimeen eivätkä domainiin — eivätkä ne mene tekoälylle
// koskaan.

import { isIsoDate, isTimeOfDay, toMinutes, fromMinutes, MAX_TITLE_LENGTH }
  from './task.js';
import { fmtISO, parseISO, addDays } from '../lib/datetime.js';

/** Mistä matka-arvio on peräisin. */
export const TRAVEL_SOURCE = Object.freeze({
  /** Käyttäjä kirjasi keston itse. */
  MANUAL: 'manual',
  /** Reittipalvelu antoi keston. Ei toteutettu. */
  PROVIDER: 'provider',
  /** Ei tiedossa. Lähtöaikaa EI lasketa. */
  UNKNOWN: 'unknown'
});

export const TRAVEL_SOURCES = Object.freeze(Object.values(TRAVEL_SOURCE));

/** Kulkutapa. Vaikuttaa oletuspuskureihin, ei kestoon. */
export const TRAVEL_MODE = Object.freeze({
  DRIVING: 'driving',
  TRANSIT: 'transit',
  WALKING: 'walking',
  CYCLING: 'cycling',
  OTHER: 'other'
});

export const TRAVEL_MODES = Object.freeze(Object.values(TRAVEL_MODE));

const MODE_LABELS = Object.freeze({
  driving: 'Autolla',
  transit: 'Julkisilla',
  walking: 'Kävellen',
  cycling: 'Pyörällä',
  other: 'Muu'
});

export function travelModeLabel(mode) {
  return MODE_LABELS[mode] || MODE_LABELS.other;
}

/**
 * Oletuspuskurit kulkutavoittain, minuutteina.
 *
 * Autolla pysäköinti vie aikaa; kävellen ei. Nämä ovat OLETUKSIA, ja
 * käyttäjä voi korvata ne — siksi ne ovat näkyvissä eivätkä piilotettuja
 * laskennan sisään.
 */
export const DEFAULT_BUFFERS = Object.freeze({
  driving: { preparation: 10, arrival: 5 },
  transit: { preparation: 10, arrival: 5 },
  walking: { preparation: 5, arrival: 0 },
  cycling: { preparation: 10, arrival: 3 },
  other: { preparation: 10, arrival: 5 }
});

/**
 * Kuinka vanha matka-arvio saa olla.
 *
 * Ruuhka muuttuu. Tunnin vanha arvio aamuruuhkassa on eri asia kuin
 * tunnin vanha arvio sunnuntaina, mutta emme tiedä kumpi on kyseessä —
 * joten vanhentuminen sanotaan ääneen eikä sitä yritetä korjata.
 */
export const STALE_AFTER_MINUTES = 30;

/** Pisin uskottava matka-aika. Sitä pidempi on syöttövirhe. */
export const MAX_TRAVEL_MINUTES = 1440;

/**
 * Kokonaisluku tai null.
 *
 * PUUTTUVA ARVO TARKISTETAAN ENNEN MUUNNOSTA. `Number(null)` on nolla,
 * ja nolla tarkoittaisi tässä "matka kestää nolla minuuttia" eli ollaan
 * jo perillä. Se on täsmälleen se vale, jonka koko moduuli kieltää:
 * tuntematon matka-aika olisi muuttunut lasketuksi lähtöajaksi.
 */
function positiveInt(value, max) {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 0) return null;
  return max ? Math.min(n, max) : n;
}

function cleanText(value, maxLength) {
  if (value == null) return null;
  const trimmed = String(value).trim().slice(0, maxLength);
  return trimmed === '' ? null : trimmed;
}

/**
 * Normalisoi matkasuunnitelma.
 *
 * PAIKKA ON NIMI, EI KOORDINAATTI. `destination` on käyttäjän
 * kirjoittama teksti: "Kuopio", "asiakkaan toimisto", "hammaslääkäri".
 * Sitä ei geokoodata täällä eikä lähetetä minnekään.
 */
export function normalizeTravelPlan(input = {}) {
  const mode = TRAVEL_MODES.includes(input.mode) ? input.mode : TRAVEL_MODE.DRIVING;
  const source = TRAVEL_SOURCES.includes(input.travelSource)
    ? input.travelSource : TRAVEL_SOURCE.UNKNOWN;

  const travelMinutes = positiveInt(input.travelMinutes, MAX_TRAVEL_MINUTES);
  const buffers = DEFAULT_BUFFERS[mode];

  return {
    id: input.id != null ? String(input.id) : null,

    title: String(input.title ?? '').trim().slice(0, MAX_TITLE_LENGTH),

    /** Mistä. Vapaaehtoinen: usein "kotoa" ja se on oletus. */
    origin: cleanText(input.origin, 200),
    /** Minne. Nimi, ei koordinaatti. */
    destination: cleanText(input.destination, 200),

    /** Milloin pitää olla perillä. */
    arrivalDate: isIsoDate(input.arrivalDate) ? input.arrivalDate : null,
    arrivalTime: isTimeOfDay(input.arrivalTime) ? input.arrivalTime : null,

    mode,

    /**
     * Matkan kesto minuutteina.
     *
     * NULL TARKOITTAA TUNTEMATONTA, EI NOLLAA. Nolla tarkoittaisi, että
     * ollaan jo perillä.
     */
    travelMinutes,
    travelSource: travelMinutes === null ? TRAVEL_SOURCE.UNKNOWN : source,

    /** Milloin arvio haettiin. Ilman tätä arvio ei kerro ikäänsä. */
    estimatedAt: input.estimatedAt ?? null,

    /** Valmistautuminen ennen lähtöä. */
    preparationMinutes: positiveInt(input.preparationMinutes, 480)
      ?? buffers.preparation,
    /** Pysäköinti ja kävely perillä. */
    arrivalBufferMinutes: positiveInt(input.arrivalBufferMinutes, 480)
      ?? buffers.arrival,

    /** Liitos tehtävään, jos matka koskee tiettyä tapaamista. */
    taskId: input.taskId != null ? String(input.taskId) : null,

    note: cleanText(input.note, 500),

    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

export function validateTravelPlan(plan) {
  const errors = {};

  if (!plan) return { valid: false, errors: { plan: 'Suunnitelmaa ei ole.' } };

  if (!plan.title) errors.title = 'Anna matkalle nimi.';
  if (!plan.destination) errors.destination = 'Minne olet menossa?';
  if (!plan.arrivalTime) errors.arrivalTime = 'Mihin aikaan pitää olla perillä?';

  if (plan.arrivalDate != null && !isIsoDate(plan.arrivalDate)) {
    errors.arrivalDate = 'Päivämäärä ei kelpaa.';
  }

  if (plan.travelMinutes !== null && plan.travelMinutes <= 0) {
    errors.travelMinutes = 'Matka-ajan pitää olla suurempi kuin nolla.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

// =====================================================================
// LÄHTÖAIKA
// =====================================================================

/**
 * Laske lähtöaika.
 *
 * =================================================================
 * PALAUTTAA `known: false`, JOS MATKA-AIKAA EI TIEDETÄ.
 * =================================================================
 *
 * Se on koko moduulin tärkein rivi. Tuntemattomasta kestosta ei
 * lasketa lähtöaikaa, koska laskettu lähtöaika näyttää täsmälleen yhtä
 * varmalta kuin oikea — ja käyttäjä myöhästyisi luottaen siihen.
 *
 * Vähennyslasku on nimenomainen ja jokainen osa näkyy erikseen:
 *
 *   lähtöaika = saapuminen - matka - valmistautuminen - pysäköinti
 *
 * KESKIYÖN YLI MENEVÄ LÄHTÖ SIIRTÄÄ PÄIVÄÄ. Saapuminen klo 08:00 ja
 * kymmenen tunnin matka tarkoittaa edellisen päivän klo 21:45 — ei
 * saman päivän, joka olisi saapumisen jälkeen.
 *
 * @param {object} plan
 * @returns {{
 *   known: boolean, leaveByTime: string|null, leaveByDate: string|null,
 *   totalMinutes: number|null, parts: object, reason: string
 * }}
 */
export function computeLeaveBy(plan) {
  if (!plan || !plan.arrivalTime) {
    return unknownLeaveBy('Saapumisaikaa ei ole annettu.');
  }

  if (plan.travelMinutes === null) {
    return unknownLeaveBy(
      'Matka-aikaa ei tiedetä, joten lähtöaikaa ei voi laskea. '
      + 'Kirjaa arvioitu matka-aika itse.');
  }

  const parts = {
    travel: plan.travelMinutes,
    preparation: plan.preparationMinutes,
    arrivalBuffer: plan.arrivalBufferMinutes
  };

  const totalMinutes = parts.travel + parts.preparation + parts.arrivalBuffer;

  const arrival = toMinutes(plan.arrivalTime);
  let leaveMinutes = arrival - totalMinutes;
  let leaveDate = plan.arrivalDate;

  // Keskiyön yli: siirry taaksepäin päivä kerrallaan.
  let guard = 0;
  while (leaveMinutes < 0 && guard < 7) {
    leaveMinutes += 1440;
    leaveDate = leaveDate ? fmtISO(addDays(parseISO(leaveDate), -1)) : null;
    guard += 1;
  }

  return {
    known: true,
    leaveByTime: fromMinutes(leaveMinutes),
    leaveByDate: leaveDate,
    totalMinutes,
    parts,
    reason: buildLeaveByReason(plan, parts, totalMinutes)
  };
}

function unknownLeaveBy(reason) {
  return Object.freeze({
    known: false,
    leaveByTime: null,
    leaveByDate: null,
    totalMinutes: null,
    parts: Object.freeze({ travel: null, preparation: null, arrivalBuffer: null }),
    reason
  });
}

/**
 * Perustelu lähtöajalle.
 *
 * Erittely on osa vastausta eikä koriste: käyttäjä säätää puskureita
 * erikseen, eikä hän voi korjata lukua jonka osia hän ei näe.
 */
function buildLeaveByReason(plan, parts, total) {
  const osat = [`matka ${parts.travel} min`];
  if (parts.preparation > 0) osat.push(`valmistautuminen ${parts.preparation} min`);
  if (parts.arrivalBuffer > 0) osat.push(`pysäköinti ja kävely ${parts.arrivalBuffer} min`);

  const lahde = plan.travelSource === TRAVEL_SOURCE.MANUAL
    ? 'Matka-aika on itse kirjaamasi.'
    : plan.travelSource === TRAVEL_SOURCE.PROVIDER
      ? 'Matka-aika on reittipalvelusta.'
      : '';

  return `Yhteensä ${total} min ennen saapumista klo ${plan.arrivalTime}: `
    + osat.join(', ') + '.' + (lahde ? ' ' + lahde : '');
}

/**
 * Onko matka-arvio vanhentunut?
 *
 * Vanhentunut arvio ei ole väärä, mutta se on vanha — ja ruuhka
 * muuttuu. Käsin kirjattu arvio ei vanhene: käyttäjä tietää oman
 * matkansa, eikä sitä pidä merkitä epäluotettavaksi ajan kulumisen
 * takia.
 */
export function isEstimateStale(plan, nowIso, maxAgeMinutes = STALE_AFTER_MINUTES) {
  if (!plan || plan.travelSource !== TRAVEL_SOURCE.PROVIDER) return false;
  if (!plan.estimatedAt || !nowIso) return false;

  const estimated = Date.parse(plan.estimatedAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(estimated) || !Number.isFinite(now)) return false;

  return (now - estimated) / 60000 > maxAgeMinutes;
}

/**
 * Onko jo myöhä?
 *
 * =================================================================
 * MYÖHÄSSÄ SANOTAAN SUORAAN.
 * =================================================================
 *
 * "Lähde nyt" tilanteessa jossa lähtöaika meni ohi kaksikymmentä
 * minuuttia sitten on epärehellinen. Käyttäjän on tiedettävä, ettei
 * hän ehdi — jotta hän voi ilmoittaa siitä.
 *
 * @returns {{late: boolean, minutesLate: number|null, minutesUntilLeave: number|null}}
 */
export function leaveStatus(plan, { todayIso, nowMinutes }) {
  const leaveBy = computeLeaveBy(plan);

  if (!leaveBy.known || !leaveBy.leaveByTime) {
    return { late: false, minutesLate: null, minutesUntilLeave: null, leaveBy };
  }

  // Eri päivä: verrataan päivää ensin.
  if (leaveBy.leaveByDate && isIsoDate(todayIso)) {
    if (leaveBy.leaveByDate > todayIso) {
      return { late: false, minutesLate: null, minutesUntilLeave: null, leaveBy };
    }
    if (leaveBy.leaveByDate < todayIso) {
      return { late: true, minutesLate: null, minutesUntilLeave: null, leaveBy };
    }
  }

  const leave = toMinutes(leaveBy.leaveByTime);
  const now = Number(nowMinutes ?? 0);
  const diff = leave - now;

  return diff < 0
    ? { late: true, minutesLate: -diff, minutesUntilLeave: null, leaveBy }
    : { late: false, minutesLate: null, minutesUntilLeave: diff, leaveBy };
}

/**
 * Pitäisikö lähtöhälytys näyttää nyt?
 *
 * Näytetään, kun lähtöön on vähemmän kuin `leadMinutes`, tai kun ollaan
 * jo myöhässä. Ei näytetä, jos matka-aikaa ei tiedetä — hälytys ilman
 * lukua olisi pelkkä huoli.
 */
export function shouldAlertDeparture(plan, { todayIso, nowMinutes, leadMinutes = 15 }) {
  const status = leaveStatus(plan, { todayIso, nowMinutes });
  if (!status.leaveBy.known) return false;
  if (status.late) return true;
  return status.minutesUntilLeave !== null && status.minutesUntilLeave <= leadMinutes;
}

/** Ihmisluettava lähtöviesti. */
export function describeDeparture(plan, { todayIso, nowMinutes }) {
  const status = leaveStatus(plan, { todayIso, nowMinutes });
  const kohde = plan.destination || 'perille';

  if (!status.leaveBy.known) return status.leaveBy.reason;

  if (status.late) {
    return status.minutesLate !== null
      ? `Olet ${status.minutesLate} min myöhässä: lähtöaika kohteeseen ${kohde} `
        + `oli klo ${status.leaveBy.leaveByTime}.`
      : `Lähtöaika kohteeseen ${kohde} on mennyt.`;
  }

  if (status.minutesUntilLeave === 0) {
    return `Lähde nyt kohteeseen ${kohde}.`;
  }

  return `Lähde klo ${status.leaveBy.leaveByTime} kohteeseen ${kohde} `
    + `(${status.minutesUntilLeave} min kuluttua). ${status.leaveBy.reason}`;
}

// =====================================================================
// MATKA-AIKAPALVELUN RAJAPINTA — EI TOTEUTUSTA
// =====================================================================

/**
 * Rajapinta reittipalvelulle.
 *
 * REITTIPALVELUA EI OLE VALITTU EIKÄ KYTKETTY. Sopimus on olemassa, jotta
 * myöhempi integraatio ei vaadi tämän moduulin uudelleenkirjoitusta ja
 * jotta jokainen tulos kulkee saman tiukan tarkistuksen läpi
 * (`normalizeRouteResult`), olipa palvelu mikä tahansa.
 *
 * Sopimus:
 *   estimate({ origin, destination, departureTime, mode })
 *     -> Promise<{ status, durationSeconds, distanceMeters, provider,
 *                  calculatedAt, freshUntil, confidence }>
 *
 * Toteuttajan on:
 *   - palautettava `status: 'OK'` VAIN kun kesto on oikeasti laskettu
 *   - merkittävä `calculatedAt` ja `freshUntil`: ruuhka muuttuu, joten
 *     vanhentunutta tulosta ei käytetä lähtöaikaan (tulos on STALE)
 *   - kerrottava `provider` ja `confidence` (high|medium|low)
 *   - EPÄONNISTUTTAVA NÄKYVÄSTI (`UNKNOWN` tai `ERROR`), ei koskaan
 *     palautettava nollaa, oletuskestoa tai arvausta
 *
 * Origin voi olla nimi tai (vain muistissa, vain reittipalvelulle)
 * sijainti; sijaintia ei tallenneta eikä lähetetä muualle.
 */
export const TRAVEL_PROVIDER_CONTRACT = Object.freeze({
  method: 'estimate',
  input: '{ origin, destination, departureTime, mode }',
  output: 'status: OK|UNKNOWN|ERROR, durationSeconds: number, '
    + 'distanceMeters: number|null, provider: string, calculatedAt: ISO, '
    + 'freshUntil: ISO, confidence: high|medium|low',
  rules: Object.freeze([
    'status OK vain oikeasti lasketulle kestolle',
    'calculatedAt ja freshUntil ovat pakollisia, vanhentunutta ei käytetä',
    'katkos on UNKNOWN/ERROR, ei oletuskesto',
    'tuntematon reitti jätetään pois, ei palauteta nollana'
  ])
});

/**
 * Onko reittipalvelu käytettävissä?
 *
 * Aina epätosi. Funktio on olemassa, jotta kutsupaikat voidaan
 * kirjoittaa jo nyt oikein ja jotta tämän vastaus on yhdessä paikassa,
 * kun se joskus muuttuu.
 */
export function hasTravelProvider() {
  return false;
}

/**
 * Manuaalinen arvio matka-ajaksi.
 *
 * Tämä on se "palveluntarjoaja", joka on olemassa: käyttäjä itse.
 * Merkitään lähde nimenomaisesti, jottei käsin kirjattua arviota
 * luulla haetuksi.
 */
export function manualEstimate(minutes, { estimatedAt = null } = {}) {
  const value = positiveInt(minutes, MAX_TRAVEL_MINUTES);
  if (value === null || value === 0) return null;

  return Object.freeze({
    minutes: value,
    source: TRAVEL_SOURCE.MANUAL,
    estimatedAt,
    trafficIncluded: false,
    confidence: 'medium'
  });
}

/**
 * Liitä arvio suunnitelmaan.
 *
 * Palauttaa uuden suunnitelman — ei mutatoi. Tuntematon arvio
 * NOLLAA keston: puolittain päivitetty suunnitelma näyttäisi
 * tuoreelta vaikka luku olisi vanha.
 */
export function applyEstimate(plan, estimate) {
  if (!plan) return null;

  if (!estimate || estimate.minutes == null) {
    return normalizeTravelPlan({
      ...plan,
      travelMinutes: null,
      travelSource: TRAVEL_SOURCE.UNKNOWN,
      estimatedAt: null
    });
  }

  return normalizeTravelPlan({
    ...plan,
    travelMinutes: estimate.minutes,
    travelSource: estimate.source,
    estimatedAt: estimate.estimatedAt
  });
}

// =====================================================================
// SIJAINTILAUKAISIMET — SÄÄNTÖINÄ, EI TOTEUTUKSENA
// =====================================================================

/**
 * Sijaintilaukaisimen laji.
 *
 * NÄMÄ OVAT SÄÄNTÖJÄ, EIVÄT TOTEUTUS. Geoaitaa ei ole eikä sitä voi
 * luvata ilman laitehyväksyntää. Säännöt ovat olemassa, jotta ne
 * voidaan mallintaa, testata simuloiduilla sijainneilla ja kytkeä
 * myöhemmin oikeaan sovittimeen.
 */
export const LOCATION_TRIGGER = Object.freeze({
  ARRIVING: 'arriving',
  LEAVING: 'leaving',
  NEARBY: 'nearby'
});

export const LOCATION_TRIGGERS = Object.freeze(Object.values(LOCATION_TRIGGER));

/**
 * Normalisoi sijaintisääntö.
 *
 * `place` on NIMI eikä koordinaatti. Koordinaattien tallentaminen
 * domainiin tekisi niistä osan vientiä, varmuuskopiota ja mahdollista
 * vuotoa. Nimi riittää sääntöön; koordinaatti kuuluu sovittimelle
 * suorituksen ajaksi.
 */
export function normalizeLocationRule(input = {}) {
  const trigger = LOCATION_TRIGGERS.includes(input.trigger)
    ? input.trigger : LOCATION_TRIGGER.ARRIVING;

  return {
    id: input.id != null ? String(input.id) : null,
    place: cleanText(input.place, 200),
    trigger,
    /** Mitä muistutetaan. */
    message: cleanText(input.message, 300),
    /** Onko sääntö päällä. Oletus EPÄTOSI: sijainti vaatii luvan. */
    active: input.active === true,
    taskId: input.taskId != null ? String(input.taskId) : null
  };
}

/**
 * Täyttyykö sääntö simuloidulla sijainnilla?
 *
 * Testattavissa ilman laitetta: `context` kertoo missä ollaan ja mistä
 * tultiin. Oikea sovitin tuottaisi saman kontekstin.
 */
export function locationRuleMatches(rule, context = {}) {
  if (!rule || !rule.active || !rule.place) return false;

  const here = context.currentPlace ?? null;
  const previous = context.previousPlace ?? null;

  if (rule.trigger === LOCATION_TRIGGER.ARRIVING) {
    return here === rule.place && previous !== rule.place;
  }
  if (rule.trigger === LOCATION_TRIGGER.LEAVING) {
    return previous === rule.place && here !== rule.place;
  }
  if (rule.trigger === LOCATION_TRIGGER.NEARBY) {
    return Array.isArray(context.nearbyPlaces)
      && context.nearbyPlaces.includes(rule.place);
  }

  return false;
}

// =====================================================================
// REITTIPALVELUN TULOS: TIUKKA TARKISTUS
// =====================================================================

export const ROUTE_STATUS = Object.freeze({
  /** Kesto on oikeasti laskettu ja tuore. */
  OK: 'OK',
  /** Palvelu ei tiedä. Kestoa EI ole. */
  UNKNOWN: 'UNKNOWN',
  /** Tulos oli oikea mutta on vanhentunut. Ei käytetä lähtöaikaan. */
  STALE: 'STALE',
  /** Palvelu epäonnistui tai palautti kelvottoman tuloksen. */
  ERROR: 'ERROR'
});

const ROUTE_CONFIDENCE = Object.freeze(['high', 'medium', 'low']);
/** Yli vuorokauden kesto on virhe, ei matka. */
const MAX_ROUTE_SECONDS = MAX_TRAVEL_MINUTES * 60;

function validIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function routeFailure(status, reason) {
  return Object.freeze({
    status, durationSeconds: null, distanceMeters: null, provider: null,
    calculatedAt: null, freshUntil: null, confidence: null, reason
  });
}

/**
 * Tarkista reittipalvelun tulos. EI KOSKAAN keksi kestoa.
 *
 * Mikä tahansa puute (kesto ei ole positiivinen äärellinen luku, aika-
 * leimat puuttuvat, tuoreus puuttuu, palveluntarjoajaa ei nimetä) tekee
 * tuloksesta ERRORin -- ei "melkein kelvollista". Vanhentunut tulos
 * palautuu STALE:na ilman kestoa, jotta sitä ei vahingossa käytetä.
 *
 * @param {unknown} raw
 * @param {{nowMs: number}} options nykyhetki millisekunteina (pakollinen)
 */
export function normalizeRouteResult(raw, { nowMs } = {}) {
  // Domain ei lue kelloa: kutsuja antaa nykyhetken. Ilman sitä tuoreutta
  // ei voi todentaa, joten tulos hylätään (suljettu epäonnistuminen).
  if (!Number.isFinite(nowMs)) {
    return routeFailure(ROUTE_STATUS.ERROR, 'Nykyhetkeä ei annettu, joten tuoreutta ei voi todentaa.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return routeFailure(ROUTE_STATUS.ERROR, 'Reittipalvelun vastaus ei ollut olio.');
  }
  if (raw.status === ROUTE_STATUS.UNKNOWN) {
    return routeFailure(ROUTE_STATUS.UNKNOWN, 'Reittipalvelu ei tiedä matka-aikaa.');
  }
  if (raw.status !== ROUTE_STATUS.OK) {
    return routeFailure(ROUTE_STATUS.ERROR, 'Reittipalvelu ei onnistunut.');
  }

  const seconds = raw.durationSeconds;
  const provider = typeof raw.provider === 'string' ? raw.provider.trim().slice(0, 40) : '';
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_ROUTE_SECONDS) {
    return routeFailure(ROUTE_STATUS.ERROR, 'Reittipalvelun kesto ei kelpaa.');
  }
  if (!provider) return routeFailure(ROUTE_STATUS.ERROR, 'Reittipalvelu ei nimennyt itseään.');
  if (!validIso(raw.calculatedAt) || !validIso(raw.freshUntil)) {
    return routeFailure(ROUTE_STATUS.ERROR, 'Reittipalvelun tulokselta puuttuvat ajat.');
  }
  if (Date.parse(raw.freshUntil) <= Date.parse(raw.calculatedAt)) {
    return routeFailure(ROUTE_STATUS.ERROR, 'Reittipalvelun tuoreus ei kelpaa.');
  }
  if (!ROUTE_CONFIDENCE.includes(raw.confidence)) {
    return routeFailure(ROUTE_STATUS.ERROR, 'Reittipalvelu ei kertonut varmuutta.');
  }

  const meters = raw.distanceMeters;
  const distanceMeters = typeof meters === 'number' && Number.isFinite(meters) && meters >= 0
    ? Math.round(meters) : null;

  if (Date.parse(raw.freshUntil) <= nowMs) {
    return routeFailure(ROUTE_STATUS.STALE, 'Reittipalvelun tulos on vanhentunut.');
  }

  return Object.freeze({
    status: ROUTE_STATUS.OK,
    durationSeconds: Math.round(seconds),
    distanceMeters,
    provider,
    calculatedAt: new Date(raw.calculatedAt).toISOString(),
    freshUntil: new Date(raw.freshUntil).toISOString(),
    confidence: raw.confidence,
    reason: ''
  });
}

/**
 * Käytä tuoretta reittipalvelun tulosta suunnitelman kestona.
 *
 * PALAUTTAA UUDEN, TRANSIENTIN SUUNNITELMAN -- EI KIRJOITA MITÄÄN. Tulos
 * on laskettu tälle hetkelle, ja sen tallentaminen ylikirjoittaisi
 * käyttäjän itse antaman keston. Ilman käyttökelpoista tulosta
 * suunnitelma palautuu SELLAISENAAN: käsin kirjattu kesto säilyy, ja
 * jos sitäkään ei ole, kesto pysyy tuntemattomana.
 *
 * Minuutit pyöristetään YLÖSPÄIN: aliarvio olisi myöhästyminen.
 */
export function withRouteResult(plan, rawRoute, { nowMs } = {}) {
  if (!plan) return null;
  const route = normalizeRouteResult(rawRoute, { nowMs });
  if (route.status !== ROUTE_STATUS.OK) return plan;

  return normalizeTravelPlan({
    ...plan,
    travelMinutes: Math.ceil(route.durationSeconds / 60),
    travelSource: TRAVEL_SOURCE.PROVIDER,
    estimatedAt: route.calculatedAt
  });
}

// =====================================================================
// LÄHTÖMOOTTORI: TILAT
// =====================================================================
//
// UNKNOWN     kestoa ei tiedetä -> mitään lähtöaikaa ei väitetä
// NOT_YET     liian aikaista
// PREPARE     aloita valmistautuminen
// LEAVE_SOON  lähtöön on enintään LEAVE_SOON_MINUTES
// LEAVE_NOW   lähtöaika on nyt (tai meni alle LEAVE_NOW_GRACE_MINUTES sitten)
// LATE        lähtöaika on mennyt
//
//   saapuminen
//   - matka
//   - pysäköinti ja kävely   = LÄHTÖAIKA (ovelta)
//   - valmistautuminen       = VALMISTAUTUMISEN ALKU
//
// Aiempi computeLeaveBy() yhdistää valmistautumisen lähtöaikaan; tämä
// moottori erottaa ne, jotta "lähde 17:15" tarkoittaa oven ohitusta eikä
// valmistautumisen aloitusta.

export const DEPARTURE_STATE = Object.freeze({
  UNKNOWN: 'unknown',
  NOT_YET: 'not_yet',
  PREPARE: 'prepare',
  LEAVE_SOON: 'leave_soon',
  LEAVE_NOW: 'leave_now',
  LATE: 'late'
});

export const LEAVE_SOON_MINUTES = 15;
export const LEAVE_NOW_GRACE_MINUTES = 2;

/** Kalenteripäivän järjestysluku. UTC-laskenta: seinäkelloaika ei kärsi kesäajasta. */
function dayNumber(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return Math.round(date.getTime() / 86400000);
}

/**
 * Seinäkellon absoluuttiset minuutit: päivän järjestysluku * 1440 + minuutit.
 *
 * SEINÄKELLOA, EI KULUNUTTA AIKAA. Luku kertoo, mitä kello näyttää, joten
 * se rullaa keskiyön, kuukauden ja vuoden yli oikein eikä riipu laitteen
 * aikavyöhykkeestä. Kesäajan yön erikoistapaukset hoitavat `minusMinutes`
 * ja `minutesBetween` alla.
 */
export function absoluteMinutes(dateIso, minutes) {
  return dayNumber(dateIso) * 1440 + minutes;
}

/** Seinäkellon absoluuttiset minuutit -> { date, time, abs }. */
export function fromAbsolute(abs) {
  const day = Math.floor(abs / 1440);
  const minutes = ((abs % 1440) + 1440) % 1440;
  const date = new Date(day * 86400000);
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return {
    date: `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    time: fromMinutes(minutes),
    abs
  };
}

// =====================================================================
// KESÄAJAN YÖT: VAROVAINEN VÄHENNYSLASKU
// =====================================================================
//
// Seinäkellolaskenta on oikein 363 yönä vuodessa. Kahtena yönä se ei ole:
//
//   KEVÄT (maaliskuun viimeinen sunnuntai): kello hyppää 03 -> 04. Tunti
//   03:00-03:59 puuttuu. Saapuminen 04:30 miinus 60 min matkaa on
//   seinäkellolla "03:30", jota ei ole olemassa -- ja laite tulkitsee sen
//   ajaksi 04:30, eli lähtömuistutus tulisi saapumisaikaan. Oikea lähtö
//   on 02:30.
//
//   SYKSY (lokakuun viimeinen sunnuntai): kello palaa 04 -> 03. Tunti
//   03:00-03:59 toistuu. Seinäkellolla laskettu lähtö on silloin
//   enintään tunnin TURHAN AIKAISIN -- ei koskaan myöhässä.
//
// Sääntö on siksi yksipuolinen: lähtö, valmistautuminen ja muistutus
// lasketaan sekä seinäkellolla että Suomen ajan kuluneilla minuuteilla,
// ja AIKAISEMPI voittaa. Keväällä se korjaa puuttuvan tunnin, syksyllä
// se pitää seinäkellon tuloksen (ei moniselitteistä "03:30":aa, jonka
// voisi lukea toiseksi kerraksi ja myöhästyä tunnin). Muina öinä molemmat
// tavat antavat saman luvun, joten tulos ei muutu.
//
// Sovellus on suomalainen, joten sääntö on Suomen aika (EET/EEST, EU:n
// kesäaikasääntö: siirtymä klo 01:00 UTC). Jos laite on muualla,
// korjaus voi osua väärälle yölle -- mutta se voi vain aikaistaa, ei
// koskaan myöhästyttää. Laitteen aikavyöhykettä EI lueta: tulos on sama
// joka koneella.

const SUMMER_OFFSET_MINUTES = 180;
const WINTER_OFFSET_MINUTES = 120;
/** Siirtymä tapahtuu klo 01:00 UTC; seinäkellolla 03:00-04:00. */
const TRANSITION_UTC_MINUTE = 60;
const TRANSITION_WALL_START = 180;
const TRANSITION_WALL_END = 240;

/** Gregoriaaninen päivä -> päivän järjestysluku (1970-01-01 = 0). Pelkkää kokonaislukulaskua. */
function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Päivän järjestysluku -> vuosi. */
function yearOfDay(dayNum) {
  const z = dayNum + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const month = mp < 10 ? mp + 3 : mp - 9;
  return yoe + era * 400 + (month <= 2 ? 1 : 0);
}

/** Kuukauden viimeinen sunnuntai päivän järjestyslukuna. */
function lastSundayOf(year, month, lastDay) {
  const last = daysFromCivil(year, month, lastDay);
  const isoWeekday = ((last % 7) + 7 + 3) % 7 + 1; // 1970-01-01 oli torstai
  return last - (isoWeekday % 7);
}

function finnishDstDays(year) {
  return { spring: lastSundayOf(year, 3, 31), autumn: lastSundayOf(year, 10, 31) };
}

/**
 * Suomen ajan ero UTC:hen (minuutteina) seinäkellon hetkelle.
 *
 * Puuttuva kevättunti luetaan talviaikana (kuten laite: 03:30 = 04:30
 * kesäaikaa). Toistuva syystunti luetaan kesäaikana eli AIKAISEMMAKSI
 * hetkeksi: saapumisaika osuu silloin varmasti ajoissa.
 */
export function finnishUtcOffsetMinutes(wallAbs) {
  const day = Math.floor(wallAbs / 1440);
  const minute = wallAbs - day * 1440;
  const { spring, autumn } = finnishDstDays(yearOfDay(day));
  if (day < spring || day > autumn) return WINTER_OFFSET_MINUTES;
  if (day > spring && day < autumn) return SUMMER_OFFSET_MINUTES;
  if (day === spring) return minute < TRANSITION_WALL_END ? WINTER_OFFSET_MINUTES : SUMMER_OFFSET_MINUTES;
  return minute < TRANSITION_WALL_END ? SUMMER_OFFSET_MINUTES : WINTER_OFFSET_MINUTES;
}

function instantOf(wallAbs) {
  return wallAbs - finnishUtcOffsetMinutes(wallAbs);
}

function wallOf(instant) {
  const { spring, autumn } = finnishDstDays(yearOfDay(Math.floor(instant / 1440)));
  const summer = instant >= spring * 1440 + TRANSITION_UTC_MINUTE
    && instant < autumn * 1440 + TRANSITION_UTC_MINUTE;
  return instant + (summer ? SUMMER_OFFSET_MINUTES : WINTER_OFFSET_MINUTES);
}

/**
 * Seinäkellon hetki `minutes` minuuttia ennen hetkeä `wallAbs`, varovaisesti:
 * aikaisempi seinäkellon ja Suomen ajan kuluneiden minuuttien tuloksista.
 * Tulos ei koskaan osu kevään puuttuvaan tuntiin.
 */
export function minusMinutes(wallAbs, minutes) {
  return Math.min(wallAbs - minutes, wallOf(instantOf(wallAbs) - minutes));
}

/**
 * Minuutteja hetkestä `fromAbs` hetkeen `toAbs`, varovaisesti: pienempi
 * seinäkellon ja kuluneen ajan erotuksista. Pienempi ero tarkoittaa
 * aikaisempaa muistutusta -- ei koskaan myöhäisempää.
 */
export function minutesBetween(fromAbs, toAbs) {
  return Math.min(toAbs - fromAbs, instantOf(toAbs) - instantOf(fromAbs));
}

/** Seinäkellon kevättunti 03:00-03:59 puuttuu tältä päivältä? (testejä ja selityksiä varten) */
export function isFinnishSpringGap(dateIso, minutes) {
  if (!isIsoDate(dateIso) || !Number.isFinite(minutes)) return false;
  const day = dayNumber(dateIso);
  return day === finnishDstDays(yearOfDay(day)).spring
    && minutes >= TRANSITION_WALL_START && minutes < TRANSITION_WALL_END;
}

/** Hetki `minutes` minuuttia ennen lähtöä: { date, time }. Kalenteripäivä rullaa oikein keskiyön yli. */
export function leaveAtMinus(schedule, minutes) {
  if (!schedule || !schedule.known) return null;
  const { date, time } = fromAbsolute(minusMinutes(schedule.leave.abs, minutes));
  return { date, time };
}

function unknownSchedule(reason) {
  return Object.freeze({
    known: false, reason, start: null, arrive: null, leave: null, prepare: null, parts: null, source: null
  });
}

const SOURCE_LABELS = Object.freeze({
  [TRAVEL_SOURCE.MANUAL]: 'itse arvioitu',
  [TRAVEL_SOURCE.PROVIDER]: 'reittipalvelusta'
});

/** Pisin etuajassa olo (min). Sama yläraja kuin muilla puskureilla. */
const MAX_EARLY_ARRIVAL_MINUTES = 480;

/**
 * Lähtöaikataulu. `known: false`, ellei kestoa tiedetä.
 *
 * Ilman päivää saapuminen tulkitaan annetuksi päiväksi `todayIso`.
 *
 *   alku          = arrivalTime (tapahtuman alku)
 *   saapuminen    = alku - etuajassa olo (earlyArrivalMinutes, oletus 0)
 *   lähtö         = saapuminen - pysäköinti ja kävely - matka
 *   valmistautuminen alkaa = lähtö - valmistautuminen
 *
 * `earlyArrivalMinutes` on valinnainen, transientti kenttä (lähtömoottori
 * v2 antaa sen tapahtumalle, paikalle tai asetuksista). Tallennetulla
 * matkasuunnitelmalla sitä ei ole, joten vanha käytös ei muutu.
 */
export function departureSchedule(plan, { todayIso } = {}) {
  if (!plan || !isTimeOfDay(plan.arrivalTime)) return unknownSchedule('Saapumisaikaa ei ole annettu.');

  const minutes = plan.travelMinutes;
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) {
    return unknownSchedule('Matka-aikaa ei tiedetä, joten lähtöaikaa ei voi laskea. Kirjaa arvioitu matka-aika itse.');
  }

  const arrivalDate = plan.arrivalDate || todayIso;
  if (!isIsoDate(arrivalDate)) return unknownSchedule('Saapumispäivää ei tiedetä.');

  const startAbs = absoluteMinutes(arrivalDate, toMinutes(plan.arrivalTime));
  const earlyArrival = positiveInt(plan.earlyArrivalMinutes, MAX_EARLY_ARRIVAL_MINUTES) ?? 0;
  const arrivalBuffer = plan.arrivalBufferMinutes ?? 0;
  const preparation = plan.preparationMinutes ?? 0;
  const arriveAbs = minusMinutes(startAbs, earlyArrival);
  const leaveAbs = minusMinutes(arriveAbs, minutes + arrivalBuffer);
  const prepareAbs = minusMinutes(leaveAbs, preparation);

  return Object.freeze({
    known: true,
    reason: '',
    start: fromAbsolute(startAbs),
    arrive: fromAbsolute(arriveAbs),
    leave: fromAbsolute(leaveAbs),
    prepare: fromAbsolute(prepareAbs),
    parts: Object.freeze({ travel: minutes, arrivalBuffer, preparation, earlyArrival }),
    source: plan.travelSource
  });
}

/**
 * Lähtötila hetkelle `nowMinutes` (päivänä `todayIso`).
 *
 * @returns {{state:string, known:boolean, minutesUntilLeave:number|null,
 *            minutesLate:number|null, minutesToArrival:number|null,
 *            schedule:object, message:string, detail:string}}
 */
export function departureState(plan, { todayIso, nowMinutes, soonMinutes = LEAVE_SOON_MINUTES } = {}) {
  const schedule = departureSchedule(plan, { todayIso });

  if (!schedule.known || !isIsoDate(todayIso) || !Number.isFinite(nowMinutes)) {
    return Object.freeze({
      state: DEPARTURE_STATE.UNKNOWN, known: false, minutesUntilLeave: null, minutesLate: null,
      minutesToArrival: null, schedule, message: schedule.reason || 'Nykyhetkeä ei tiedetä.', detail: ''
    });
  }

  const nowAbs = absoluteMinutes(todayIso, nowMinutes);
  // Varovainen erotus: kesäajan yönä pienempi (aikaisempi) tulkinta, muulloin sama kuin seinäkello.
  const delta = minutesBetween(nowAbs, schedule.leave.abs);
  const destination = plan.destination || 'perille';

  const where = schedule.leave.date === todayIso ? '' : `${schedule.leave.date} `;
  const leaveText = `${where}${schedule.leave.time}`;
  const detail = `Matka ${schedule.parts.travel} min`
    + (SOURCE_LABELS[schedule.source] ? ` (${SOURCE_LABELS[schedule.source]})` : '')
    + (schedule.parts.arrivalBuffer > 0 ? `, pysäköinti ja kävely ${schedule.parts.arrivalBuffer} min` : '')
    + (schedule.parts.preparation > 0 ? `, valmistautuminen ${schedule.parts.preparation} min` : '')
    + (schedule.parts.earlyArrival > 0 ? `, perillä ${schedule.parts.earlyArrival} min etuajassa` : '')
    + '.';

  let state;
  let message;
  let minutesLate = null;
  let minutesUntilLeave = null;

  if (delta < -LEAVE_NOW_GRACE_MINUTES) {
    state = DEPARTURE_STATE.LATE;
    minutesLate = -delta;
    message = minutesBetween(nowAbs, schedule.start.abs) < 0
      ? `Saapumisaika klo ${plan.arrivalTime} kohteeseen ${destination} on jo mennyt.`
      : `Olet ${minutesLate} min myöhässä: lähtöaika kohteeseen ${destination} oli klo ${leaveText}.`;
  } else if (delta <= 0) {
    state = DEPARTURE_STATE.LEAVE_NOW;
    minutesUntilLeave = 0;
    message = `Lähde nyt kohteeseen ${destination}, jotta ehdit klo ${plan.arrivalTime}.`;
  } else if (delta <= soonMinutes) {
    state = DEPARTURE_STATE.LEAVE_SOON;
    minutesUntilLeave = delta;
    message = `Lähde noin ${leaveText} (${delta} min kuluttua), jotta ehdit klo ${plan.arrivalTime}.`;
  } else if (minutesBetween(nowAbs, schedule.prepare.abs) <= 0) {
    state = DEPARTURE_STATE.PREPARE;
    minutesUntilLeave = delta;
    message = `Aloita valmistautuminen: lähde noin ${leaveText}, jotta ehdit klo ${plan.arrivalTime}.`;
  } else {
    state = DEPARTURE_STATE.NOT_YET;
    minutesUntilLeave = delta;
    message = `Lähde noin ${leaveText}, jotta ehdit klo ${plan.arrivalTime}.`;
  }

  return Object.freeze({
    state, known: true, minutesUntilLeave, minutesLate,
    /** Minuutteja saapumiseen; negatiivinen, kun saapumisaika on mennyt. */
    minutesToArrival: minutesBetween(nowAbs, schedule.arrive.abs),
    schedule, message, detail
  });
}

// =====================================================================
// LÄHTÖMOOTTORI V2: TARKEMMAT VAIHEET
// =====================================================================
//
// DEPARTURE_STATE pysyy ennallaan (näkymät, avustaja ja ilmoitukset
// nojaavat sen merkkijonoihin ja rajoihin). Vaiheet JOHDETAAN siitä ja
// sen aikataulusta -- aikoja ei lasketa toiseen kertaan.
//
// UNKNOWN_TRAVEL  lähtöaikaa ei voi laskea (kesto tai saapumisaika puuttuu)
// NOT_YET         valmistautumiseen on yli PREPARE_SOON_MINUTES
// PREPARE_SOON    valmistautuminen alkaa enintään PREPARE_SOON_MINUTES päästä
// PREPARE_NOW     valmistautumisen aika on alkanut
// LEAVE_IN_5      lähtöön on enintään LEAVE_IN_MINUTES
// LEAVE_NOW       lähtöaika on nyt (tai meni alle LEAVE_NOW_GRACE_MINUTES sitten)
// LATE            lähtöaika on mennyt
//
// Ilman valmistautumista (0 min) valmistautumisen alku = lähtö, joten
// PREPARE_SOON tarkoittaa silloin "lähtö lähestyy" eikä PREPARE_NOW:ta tule.

export const DEPARTURE_PHASE = Object.freeze({
  UNKNOWN_TRAVEL: 'unknown_travel',
  NOT_YET: 'not_yet',
  PREPARE_SOON: 'prepare_soon',
  PREPARE_NOW: 'prepare_now',
  LEAVE_IN_5: 'leave_in_5',
  LEAVE_NOW: 'leave_now',
  LATE: 'late'
});

export const DEPARTURE_PHASES = Object.freeze(Object.values(DEPARTURE_PHASE));

export const PREPARE_SOON_MINUTES = 15;
export const LEAVE_IN_MINUTES = 5;
const MAX_PREPARE_SOON_MINUTES = 240;

const PHASE_LABELS = Object.freeze({
  [DEPARTURE_PHASE.UNKNOWN_TRAVEL]: 'Matka-aika puuttuu',
  [DEPARTURE_PHASE.NOT_YET]: 'Ei vielä',
  [DEPARTURE_PHASE.PREPARE_SOON]: 'Valmistautuminen pian',
  [DEPARTURE_PHASE.PREPARE_NOW]: 'Valmistaudu nyt',
  [DEPARTURE_PHASE.LEAVE_IN_5]: 'Lähtö pian',
  [DEPARTURE_PHASE.LEAVE_NOW]: 'Lähde nyt',
  [DEPARTURE_PHASE.LATE]: 'Lähtöaika meni'
});

export function departurePhaseLabel(phase) {
  return PHASE_LABELS[phase] || PHASE_LABELS[DEPARTURE_PHASE.UNKNOWN_TRAVEL];
}

function soonWindow(value) {
  const n = positiveInt(value, MAX_PREPARE_SOON_MINUTES);
  return n === null ? PREPARE_SOON_MINUTES : n;
}

/**
 * Vaihe kahdesta erotuksesta. Yksi paikka rajoille, jotta suunnitelma-
 * ja tapahtumapohjainen lähtö eivät voi erota toisistaan.
 *
 * @param {{minutesUntilLeave:number, minutesUntilPrepare:number, prepareSoonMinutes?:number}} input
 * @returns {string|null} DEPARTURE_PHASE-arvo, tai null kelvottomalla syötteellä
 */
export function classifyDeparturePhase({ minutesUntilLeave, minutesUntilPrepare, prepareSoonMinutes } = {}) {
  if (!Number.isFinite(minutesUntilLeave) || !Number.isFinite(minutesUntilPrepare)) return null;
  if (minutesUntilLeave < -LEAVE_NOW_GRACE_MINUTES) return DEPARTURE_PHASE.LATE;
  if (minutesUntilLeave <= 0) return DEPARTURE_PHASE.LEAVE_NOW;
  if (minutesUntilLeave <= LEAVE_IN_MINUTES) return DEPARTURE_PHASE.LEAVE_IN_5;
  if (minutesUntilPrepare <= 0) return DEPARTURE_PHASE.PREPARE_NOW;
  if (minutesUntilPrepare <= soonWindow(prepareSoonMinutes)) return DEPARTURE_PHASE.PREPARE_SOON;
  return DEPARTURE_PHASE.NOT_YET;
}

/**
 * Lähdön vaihe hetkellä `nowMinutes` (päivänä `todayIso`).
 *
 * Johdettu `departureState`:sta: LATE ja LEAVE_NOW vastaavat sen tiloja
 * täsmälleen, ja muut vaiheet tarkentavat sen NOT_YET/PREPARE/LEAVE_SOON-
 * tiloja saman aikataulun hetkillä.
 *
 * @returns {{phase:string, known:boolean, minutesUntilLeave:number|null,
 *            minutesUntilPrepare:number|null, minutesLate:number|null,
 *            label:string, message:string, departure:object}}
 */
export function departurePhase(plan, { todayIso, nowMinutes, prepareSoonMinutes = PREPARE_SOON_MINUTES } = {}) {
  const departure = departureState(plan, { todayIso, nowMinutes });

  if (departure.state === DEPARTURE_STATE.UNKNOWN) {
    return Object.freeze({
      phase: DEPARTURE_PHASE.UNKNOWN_TRAVEL, known: false,
      minutesUntilLeave: null, minutesUntilPrepare: null, minutesLate: null,
      label: departurePhaseLabel(DEPARTURE_PHASE.UNKNOWN_TRAVEL), message: departure.message, departure
    });
  }

  const { schedule } = departure;
  const nowAbs = absoluteMinutes(todayIso, nowMinutes);
  const untilLeave = minutesBetween(nowAbs, schedule.leave.abs);
  const untilPrepare = minutesBetween(nowAbs, schedule.prepare.abs);
  const phase = classifyDeparturePhase({
    minutesUntilLeave: untilLeave, minutesUntilPrepare: untilPrepare, prepareSoonMinutes
  });

  const prepareText = schedule.prepare.date === todayIso
    ? schedule.prepare.time : `${schedule.prepare.date} ${schedule.prepare.time}`;
  const message = phase === DEPARTURE_PHASE.PREPARE_SOON && schedule.parts.preparation > 0
    ? `Valmistautuminen alkaa klo ${prepareText} (${untilPrepare} min kuluttua). ${departure.message}`
    : departure.message;

  return Object.freeze({
    phase,
    known: true,
    minutesUntilLeave: untilLeave > 0 ? untilLeave : (phase === DEPARTURE_PHASE.LEAVE_NOW ? 0 : null),
    minutesUntilPrepare: untilPrepare > 0 ? untilPrepare : 0,
    minutesLate: departure.minutesLate,
    label: departurePhaseLabel(phase),
    message,
    departure
  });
}

// =====================================================================
// UUDELLEENLASKENNAN HYSTEREESI
// =====================================================================
//
// Liikennetieto heiluu minuutin tai kaksi joka haulla. Jos jokainen heilahdus
// siirtäisi näytettyä lähtöaikaa ja muistutusta, käyttäjä saisi ilmoitus-
// myrskyn eikä voisi luottaa mihinkään lukuun. Siksi aiemmin kerrottu
// lähtöaika pidetään, kunnes muutos on merkittävä:
//
//   AIKAISEMMAKSI  vähintään 5 min   (myöhästymisen vaara: kynnys matala)
//   MYÖHEMMÄKSI    vähintään 10 min  (vain mukavuutta: kynnys korkea)
//
// Pieni aikaistus (< 5 min) jää kertomatta, koska perillä on etuajassa
// oloa varten oma varansa. Tuntemattomaksi muuttunut kesto kerrotaan AINA:
// vanhaa lukua ei jätetä näkyviin ikään kuin se olisi yhä voimassa.

export const LEAVE_EARLIER_TOLERANCE_MINUTES = 5;
export const LEAVE_LATER_TOLERANCE_MINUTES = 10;

/** Lähtöhetki absoluuttisina seinäkellominuutteina: luku, {abs} tai {date, time}. Muuten null. */
export function leaveAbsOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (!value || typeof value !== 'object') return null;
  if (typeof value.abs === 'number' && Number.isFinite(value.abs)) return value.abs;
  if (isIsoDate(value.date) && isTimeOfDay(value.time)) return absoluteMinutes(value.date, toMinutes(value.time));
  return null;
}

function tolerance(value, fallback) {
  const n = positiveInt(value, 1440);
  return n === null ? fallback : n;
}

/**
 * Pidä aiemmin kerrottu lähtöaika, ellei muutos ole merkittävä.
 *
 * @param {number|{abs?:number,date?:string,time?:string}|null} previous aiemmin kerrottu
 * @param {number|{abs?:number,date?:string,time?:string}|null} next uusi laskettu
 * @returns {{leave:any, changed:boolean, direction:'initial'|'earlier'|'later'|'same'|'unknown',
 *            deltaMinutes:number|null}} `leave` on se arvo (previous tai next), joka näytetään;
 *            deltaMinutes = uusi - aiempi (negatiivinen = aikaisemmaksi).
 */
export function stabilizeLeave(previous, next, {
  earlierToleranceMinutes = LEAVE_EARLIER_TOLERANCE_MINUTES,
  laterToleranceMinutes = LEAVE_LATER_TOLERANCE_MINUTES
} = {}) {
  const prevAbs = leaveAbsOf(previous);
  const nextAbs = leaveAbsOf(next);

  if (nextAbs === null) {
    return Object.freeze({ leave: null, changed: prevAbs !== null, direction: 'unknown', deltaMinutes: null });
  }
  if (prevAbs === null) {
    return Object.freeze({ leave: next, changed: true, direction: 'initial', deltaMinutes: null });
  }

  const delta = nextAbs - prevAbs;
  if (delta < 0 && -delta >= tolerance(earlierToleranceMinutes, LEAVE_EARLIER_TOLERANCE_MINUTES)) {
    return Object.freeze({ leave: next, changed: true, direction: 'earlier', deltaMinutes: delta });
  }
  if (delta > 0 && delta >= tolerance(laterToleranceMinutes, LEAVE_LATER_TOLERANCE_MINUTES)) {
    return Object.freeze({ leave: next, changed: true, direction: 'later', deltaMinutes: delta });
  }
  return Object.freeze({ leave: previous, changed: false, direction: 'same', deltaMinutes: delta });
}

// =====================================================================
// TALLENNETUT PAIKAT: EHDOTUKSET ILMAN HISTORIAA
// =====================================================================

/** Enintään näin monta paikkaehdotusta. */
export const MAX_PLACE_SUGGESTIONS = 8;

/**
 * Käyttäjän aiemmin kirjoittamat paikannimet ("Koti", "Työ", "Asiakas X").
 *
 * EI UUTTA TIETOA, EI SIJAINTIHISTORIAA. Ehdotukset johdetaan matkojen
 * ja paikkamuistutusten OLEMASSA OLEVISTA nimikentistä; mitään ei
 * tallenneta erikseen eikä koordinaattia käytetä (paikka on nimi, ks.
 * tämän moduulin alku). Yleisin nimi ensin, sitten aakkosjärjestys.
 * Kirjainkoko ja välilyönnit eivät luo kaksoiskappaleita.
 *
 * Paikkatunniste (provider place ID) lisätään myöhemmin vasta kun
 * reittipalvelu on valittu -- nimi on aina pakollinen perusta.
 */
export function suggestPlaces(travelPlans = [], locationRules = [], limit = MAX_PLACE_SUGGESTIONS) {
  const counts = new Map();
  const add = raw => {
    const text = cleanText(raw, 200);
    if (!text) return;
    const key = text.toLocaleLowerCase('fi');
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { name: text, count: 1 });
  };

  for (const plan of Array.isArray(travelPlans) ? travelPlans : []) {
    if (!plan) continue;
    add(plan.origin);
    add(plan.destination);
  }
  for (const rule of Array.isArray(locationRules) ? locationRules : []) {
    if (rule) add(rule.place);
  }

  const max = Math.max(0, Math.min(Number.isInteger(limit) ? limit : MAX_PLACE_SUGGESTIONS, MAX_PLACE_SUGGESTIONS));
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'fi'))
    .slice(0, max)
    .map(entry => entry.name);
}
