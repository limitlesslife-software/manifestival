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

function absoluteMinutes(dateIso, minutes) {
  return dayNumber(dateIso) * 1440 + minutes;
}

function fromAbsolute(abs) {
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

/** Hetki `minutes` minuuttia ennen lähtöä: { date, time }. Kalenteripäivä rullaa oikein keskiyön yli. */
export function leaveAtMinus(schedule, minutes) {
  if (!schedule || !schedule.known) return null;
  const { date, time } = fromAbsolute(schedule.leave.abs - minutes);
  return { date, time };
}

function unknownSchedule(reason) {
  return Object.freeze({ known: false, reason, arrive: null, leave: null, prepare: null, parts: null, source: null });
}

const SOURCE_LABELS = Object.freeze({
  [TRAVEL_SOURCE.MANUAL]: 'itse arvioitu',
  [TRAVEL_SOURCE.PROVIDER]: 'reittipalvelusta'
});

/**
 * Lähtöaikataulu. `known: false`, ellei kestoa tiedetä.
 *
 * Ilman päivää saapuminen tulkitaan annetuksi päiväksi `todayIso`.
 */
export function departureSchedule(plan, { todayIso } = {}) {
  if (!plan || !isTimeOfDay(plan.arrivalTime)) return unknownSchedule('Saapumisaikaa ei ole annettu.');

  const minutes = plan.travelMinutes;
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) {
    return unknownSchedule('Matka-aikaa ei tiedetä, joten lähtöaikaa ei voi laskea. Kirjaa arvioitu matka-aika itse.');
  }

  const arrivalDate = plan.arrivalDate || todayIso;
  if (!isIsoDate(arrivalDate)) return unknownSchedule('Saapumispäivää ei tiedetä.');

  const arriveAbs = absoluteMinutes(arrivalDate, toMinutes(plan.arrivalTime));
  const arrivalBuffer = plan.arrivalBufferMinutes ?? 0;
  const preparation = plan.preparationMinutes ?? 0;
  const leaveAbs = arriveAbs - minutes - arrivalBuffer;
  const prepareAbs = leaveAbs - preparation;

  return Object.freeze({
    known: true,
    reason: '',
    arrive: fromAbsolute(arriveAbs),
    leave: fromAbsolute(leaveAbs),
    prepare: fromAbsolute(prepareAbs),
    parts: Object.freeze({ travel: minutes, arrivalBuffer, preparation }),
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
  const delta = schedule.leave.abs - nowAbs;
  const destination = plan.destination || 'perille';

  const where = schedule.leave.date === todayIso ? '' : `${schedule.leave.date} `;
  const leaveText = `${where}${schedule.leave.time}`;
  const detail = `Matka ${schedule.parts.travel} min`
    + (SOURCE_LABELS[schedule.source] ? ` (${SOURCE_LABELS[schedule.source]})` : '')
    + (schedule.parts.arrivalBuffer > 0 ? `, pysäköinti ja kävely ${schedule.parts.arrivalBuffer} min` : '')
    + (schedule.parts.preparation > 0 ? `, valmistautuminen ${schedule.parts.preparation} min` : '')
    + '.';

  let state;
  let message;
  let minutesLate = null;
  let minutesUntilLeave = null;

  if (delta < -LEAVE_NOW_GRACE_MINUTES) {
    state = DEPARTURE_STATE.LATE;
    minutesLate = -delta;
    message = nowAbs > schedule.arrive.abs
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
  } else if (nowAbs >= schedule.prepare.abs) {
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
    minutesToArrival: schedule.arrive.abs - nowAbs,
    schedule, message, detail
  });
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
