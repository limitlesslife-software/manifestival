// Oppiminen omista matkoista: kesto, myöhästely ja valmistautuminen.
//
// PUHDAS MODUULI. Ei kelloa, ei verkkoa, ei satunnaisuutta. Sama syöte
// tuottaa aina saman tuloksen, eikä syötettä muuteta.
//
// =====================================================================
// VAIN KÄYTTÄJÄN KUITTAAMAA TIETOA, EI SEURANTAA
// =====================================================================
//
// Havainto syntyy vain, kun käyttäjä itse kuittaa ("Lähdin", "Olin
// perillä"). Sijaintia ei lueta, reittiä ei tallenneta, ja historia on
// rajattu (MAX_OBSERVATIONS_PER_PLACE paikkaa kohden, vanhin pois ensin).
//
// =====================================================================
// OPITTU EI OLE AUTOMAATTINEN
// =====================================================================
//
// Tämä moduuli EHDOTTAA. Opittua kestoa käytetään lähtöaikaan vasta, kun
// käyttäjä on hyväksynyt sen paikalle (place.useLearned), ja myöhästelyn
// perusteella ehdotettu muistutuksen aikaistus tai pidempi valmistautuminen
// on aina kysymys, ei muutos. Jokainen luku on selitettävä: "Viimeisten 6
// matkan mediaani oli 38 min".
//
// Tuntematon kesto on null, ei nolla: havainto ilman kestoa jätetään pois
// eikä se vedä keskiarvoa alas.
//
// Kaikki laskenta on rajattua: yksi läpikäynti syötteestä ja pieni,
// kiinteän kokoinen ikkuna uusimmista havainnoista (O(n)).

import {
  ESTIMATE_SOURCE, MAX_OBSERVATIONS_PER_PLACE, MAX_REMINDER_OFFSET_MINUTES,
  MAX_PREPARATION_MINUTES, MAX_TRAVEL_MINUTES, MAX_OVERHEAD_MINUTES
} from './dailyLife.js';
import { isIsoDate, isTimeOfDay, toMinutes, fromMinutes } from './task.js';
import { weekdayOfIso } from './fiTemporal.js';

/** Kuinka monta uusinta matkaa kesto-oppiminen katsoo. Tietyöt ja aikataulut muuttuvat. */
export const LEARNING_WINDOW = 20;
/** Opittua kestoa ei ole ennen tätä määrää matkoja. */
export const MIN_LEARNING_OBSERVATIONS = 3;
/** Myöhästelyn arvio katsoo näin montaa viimeisintä lähtöä. */
export const LATENESS_WINDOW = 10;
export const MIN_LATENESS_OBSERVATIONS = 4;
/** Keskimääräinen myöhästely, josta alkaen ehdotetaan jotain. */
export const LATENESS_THRESHOLD_MINUTES = 5;
/**
 * Yli tunnin ero suunniteltuun ei ole myöhästelyä vaan muuttunut
 * suunnitelma (peruttu tai siirretty tapaaminen). Sellainen lähtö jätetään
 * pois, jottei yksi poikkeus yksin käännä ehdotusta.
 */
export const MAX_LATENESS_SAMPLE_MINUTES = 60;
export const TIME_BUCKET_MINUTES = 30;
/** Ehdotukset pyöristetään ylöspäin tämän monikertaan. */
export const SUGGESTION_STEP_MINUTES = 5;
/**
 * Pisin uskottava yksittäinen kuitattu matka (12 h). Kellonajoista laskettu
 * kesto kulkee keskiyön yli (23.50 -> 0.20 on 30 min), joten väärin päin
 * kuitatut ajat (lähtö 8.10, perillä 8.09) antaisivat muuten 1439 min
 * "matkan", ja yksi sellainen siirtäisi opitun lähdön edelliselle päivälle.
 * Perilläolo ennen lähtöä tai yli 12 h lähdön jälkeen on kirjausvirhe, ei
 * matka: se ei opeta mitään.
 */
export const MAX_OBSERVED_TRIP_MINUTES = 12 * 60;

// ------------------------------------------------------------ apurit

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Kokonaisluku väliltä [min, max] tai null. Puuttuva ei ole nolla. */
function intIn(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const n = Math.round(value);
  return n >= min && n <= max ? n : null;
}

/** Yksi suomalainen vertailija koko moduulille: sama kuin localeCompare(…, 'fi'), mutta ei luoda joka kerta. */
const FI = new Intl.Collator('fi');
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Järjestysavain lasketaan KERRAN alkiota kohden: havaintopäivä, luontihetki,
 * tunniste. ISO-päivä ja -aikaleima järjestyvät merkkijonoina oikein.
 */
function recencyKey(observation) {
  return {
    day: typeof observation.observedOn === 'string' && ISO_DAY.test(observation.observedOn) ? observation.observedOn : '',
    created: typeof observation.createdAt === 'string' ? observation.createdAt : '',
    id: typeof observation.id === 'string' ? observation.id : ''
  };
}

/**
 * Uusin ensin. Viimeinen tasapeli suomalaisella vertailulla, jotta
 * järjestys ei riipu syötteen järjestyksestä.
 */
function compareNewestFirst(a, b) {
  if (a.day !== b.day) return a.day < b.day ? 1 : -1;
  if (a.created !== b.created) return a.created < b.created ? 1 : -1;
  return a.id === b.id ? 0 : FI.compare(b.id, a.id);
}

/**
 * Enintään `k` uusinta ehdon täyttävää alkiota, uusin ensin.
 * Yksi läpikäynti ja k-kokoinen lajiteltu ikkuna: O(n * k), k on vakio.
 */
function newest(list, accept, k) {
  const kept = [];
  for (const item of list) {
    if (!isObject(item) || !accept(item)) continue;
    const key = recencyKey(item);
    if (kept.length === k && compareNewestFirst(key, kept[k - 1].key) >= 0) continue;
    let index = kept.length;
    while (index > 0 && compareNewestFirst(key, kept[index - 1].key) < 0) index -= 1;
    kept.splice(index, 0, { item, key });
    if (kept.length > k) kept.pop();
  }
  return kept.map(entry => entry.item);
}

/** Erotus b - a minuutteina kellotaulun ympäri: (-720, 720]. 23:58 -> 00:03 on +5. */
function clockDifference(a, b) {
  return ((((toMinutes(b) - toMinutes(a)) % 1440) + 1440 + 720) % 1440) - 720;
}

function roundUpToStep(value) {
  return Math.ceil(value / SUGGESTION_STEP_MINUTES) * SUGGESTION_STEP_MINUTES;
}

/**
 * Havainnon matka-aika minuutteina tai null.
 *
 * Ensisijaisesti kirjattu `travelMinutes`. Jos sitä ei ole mutta lähtö- ja
 * perilläoloaika ovat, kesto on niiden erotus MIINUS kirjattu pysäköinti ja
 * kävely: "Olin perillä" kuitataan ovelta, ja lähtöaika laskee pysäköinnin
 * erikseen -- muuten se tulisi kahteen kertaan.
 *
 * MAHDOTON EI OPETA. Perilläolo ennen lähtöä tai yli 12 h lähdön jälkeen
 * (MAX_OBSERVED_TRIP_MINUTES), samoin yli 12 h kirjattu kesto, on null.
 */
export function observedTravelMinutes(observation) {
  if (!isObject(observation)) return null;
  const recorded = intIn(observation.travelMinutes, 1, MAX_OBSERVED_TRIP_MINUTES);
  if (recorded !== null) return recorded;
  if (!isTimeOfDay(observation.actualDeparture) || !isTimeOfDay(observation.arrivalAt)) return null;
  // Kellotaulun ympäri, jotta keskiyön yli kulkeva matka on oikein. Väärin
  // päin kuitattu pari kiertäisi lähes vuorokauden: yli 12 h ei ole matka.
  const doorToDoor = ((toMinutes(observation.arrivalAt) - toMinutes(observation.actualDeparture)) + 1440) % 1440;
  if (doorToDoor > MAX_OBSERVED_TRIP_MINUTES) return null;
  const overhead = intIn(observation.overheadMinutes, 0, MAX_OVERHEAD_MINUTES) ?? 0;
  const travel = doorToDoor - overhead;
  return travel >= 1 ? travel : null;
}

function weekdayOf(observation) {
  const stored = intIn(observation.weekday, 1, 7);
  if (stored !== null) return stored;
  return isIsoDate(observation.observedOn) ? weekdayOfIso(observation.observedOn) : null;
}

function departureTimeOf(observation) {
  if (isTimeOfDay(observation.plannedDeparture)) return observation.plannedDeparture;
  if (isTimeOfDay(observation.actualDeparture)) return observation.actualDeparture;
  return null;
}

/**
 * Kellonajan aikaikkuna: 'HH:MM' -> ikkunan alku 'HH:MM' (oletus 30 min).
 * 07:44 -> 07:30. Kelvoton aika -> null.
 */
export function timeBucket(time, size = TIME_BUCKET_MINUTES) {
  if (!isTimeOfDay(time)) return null;
  const width = Number.isInteger(size) && size >= 1 && size <= 720 ? size : TIME_BUCKET_MINUTES;
  return fromMinutes(Math.floor(toMinutes(time) / width) * width);
}

// ------------------------------------------------------------ kesto

function emptySummary(filter) {
  return Object.freeze({
    count: 0, median: null, p80: null, min: null, max: null, window: null,
    placeId: filter.placeId, weekday: filter.weekday, timeBucket: filter.bucket
  });
}

function readFilter(options) {
  const opts = isObject(options) ? options : {};
  return {
    placeId: typeof opts.placeId === 'string' && opts.placeId ? opts.placeId : null,
    weekday: intIn(opts.weekday, 1, 7),
    bucket: timeBucket(opts.timeBucket),
    windowSize: intIn(opts.windowSize, 1, MAX_OBSERVATIONS_PER_PLACE) ?? LEARNING_WINDOW
  };
}

function summarize(observations, filter, anyPlace) {
  if (!anyPlace && filter.placeId === null) return emptySummary(filter);
  const list = Array.isArray(observations) ? observations : [];

  const recent = newest(list, observation => {
    if (!anyPlace && observation.placeId !== filter.placeId) return false;
    if (filter.weekday !== null && weekdayOf(observation) !== filter.weekday) return false;
    if (filter.bucket !== null && timeBucket(departureTimeOf(observation)) !== filter.bucket) return false;
    return observedTravelMinutes(observation) !== null;
  }, filter.windowSize);

  if (recent.length === 0) return emptySummary(filter);

  const values = recent.map(observedTravelMinutes).sort((a, b) => a - b);
  const n = values.length;
  const middle = Math.floor(n / 2);
  // Parillisella määrällä keskimmäisten keskiarvo YLÖSPÄIN: varovaisempi puoli.
  const median = n % 2 === 1 ? values[middle] : Math.ceil((values[middle - 1] + values[middle]) / 2);
  // "Useimmat matkat mahtuvat tähän": järjestyksessä ceil(0,8 n):s arvo.
  const p80 = values[Math.ceil(0.8 * n) - 1];
  const days = recent.map(o => (isIsoDate(o.observedOn) ? o.observedOn : null)).filter(Boolean);

  return Object.freeze({
    count: n,
    median,
    p80,
    min: values[0],
    max: values[n - 1],
    window: Object.freeze({
      size: filter.windowSize,
      used: n,
      from: days.length ? days[days.length - 1] : null,
      to: days.length ? days[0] : null
    }),
    placeId: filter.placeId,
    weekday: filter.weekday,
    timeBucket: filter.bucket
  });
}

/**
 * Yhteenveto paikan matkoista: {count, median, p80, min, max, window}.
 *
 * `placeId` on pakollinen: ilman sitä eri paikkojen matkat sekoittuisivat.
 * `weekday` (1-7) ja `timeBucket` ('HH:MM', 30 min ikkuna) rajaavat
 * valinnaisesti. Vain uusimmat `windowSize` (oletus 20) matkaa lasketaan.
 * Ilman yhtään kelvollista matkaa luvut ovat null -- ei nolla.
 */
export function summarizeCommute(observations, options) {
  return summarize(observations, readFilter(options), false);
}

// ------------------------------------------------------------ viikonpäivä ja kellonaika
//
// Sama paikka voi olla eri matka eri aikaan: maanantaiaamun ruuhka ei ole
// perjantai-iltapäivä. Opittu kesto tarkentuu siksi lähdön viikonpäivään ja
// lähtöikkunaan (30 min), KUN niille on tarpeeksi omia matkoja — muuten
// käytetään väljempää rajausta. Järjestys tarkimmasta alkaen:
//
//   weekday_time  sama viikonpäivä ja sama lähtöikkuna
//   time          sama lähtöikkuna, mikä tahansa viikonpäivä
//   weekday       sama viikonpäivä, mikä tahansa kellonaika
//   all           kaikki paikan matkat (kuten ennen)
//
// Jokainen rajaus kerrotaan tekstinä (scopeText), ja vähimmäismäärä on sama
// kuin muuallakin (MIN_LEARNING_OBSERVATIONS). Tämä EI ota oppimista
// käyttöön: kutsuja käyttää tulosta vain, kun käyttäjä on hyväksynyt
// opitun keston paikalle (place.useLearned).

export const LEARNING_SCOPE = Object.freeze({
  WEEKDAY_TIME: 'weekday_time',
  TIME: 'time',
  WEEKDAY: 'weekday',
  ALL: 'all'
});

const WEEKDAY_ADVERBS = Object.freeze([
  'maanantaisin', 'tiistaisin', 'keskiviikkoisin', 'torstaisin', 'perjantaisin', 'lauantaisin', 'sunnuntaisin'
]);

/** Minuutit keskiyöstä -> '7.30' (suomalainen kellonaika). */
function clockFi(minutes) {
  const [hours, mins] = fromMinutes(((minutes % 1440) + 1440) % 1440).split(':');
  return `${Number(hours)}.${mins}`;
}

/**
 * Rajauksen selitys: "maanantaisin klo 7.30–8.00 lähteneet", "klo 7.30–8.00
 * lähteneet", "maanantaisin lähteneet" tai '' (kaikki matkat).
 */
export function learningScopeText(summary) {
  if (!isObject(summary)) return '';
  const weekday = intIn(summary.weekday, 1, 7);
  const bucket = timeBucket(summary.timeBucket);
  const parts = [];
  if (weekday !== null) parts.push(WEEKDAY_ADVERBS[weekday - 1]);
  if (bucket !== null) {
    const start = toMinutes(bucket);
    parts.push(`klo ${clockFi(start)}–${clockFi(start + TIME_BUCKET_MINUTES)}`);
  }
  return parts.length ? `${parts.join(' ')} lähteneet` : '';
}

function scoped(summary, scope) {
  return Object.freeze({ ...summary, scope, scopeText: scope === LEARNING_SCOPE.ALL ? '' : learningScopeText(summary) });
}

/**
 * Opittu kesto yhdelle lähdölle: tarkin rajaus, jolla on vähintään
 * MIN_LEARNING_OBSERVATIONS matkaa (ks. yllä).
 *
 * Lähtöikkuna riippuu lähtöajasta, joka riippuu matka-ajasta. Siksi
 * kutsuja antaa `leaveFor(summary) -> {date, time}|null`: se laskee
 * alustavan lähdön saman viikonpäivän matkoista (jos niitä on tarpeeksi,
 * muuten kaikista), ja sen lähtöikkuna ja -päivä valitsevat rajauksen.
 * Ilman sitä käytetään annettua `departureTime`-kellonaikaa.
 *
 * @param {Array} observations
 * @param {{placeId:string, weekday?:number, departureTime?:string,
 *          leaveFor?:(summary:object)=>({date?:string, time:string}|null), windowSize?:number}} options
 * @returns {object} summarizeCommute-yhteenveto + {scope, scopeText}
 */
export function learnedCommuteFor(observations, options) {
  const opts = isObject(options) ? options : {};
  const base = readFilter({ placeId: opts.placeId, windowSize: opts.windowSize });
  const list = Array.isArray(observations) ? observations : [];
  const overall = summarize(list, { ...base, weekday: null, bucket: null }, false);
  if (overall.count < MIN_LEARNING_OBSERVATIONS) return scoped(overall, LEARNING_SCOPE.ALL);

  let weekday = intIn(opts.weekday, 1, 7);
  let bucket = timeBucket(opts.departureTime);
  if (typeof opts.leaveFor === 'function') {
    const sameDay = weekday === null ? null : summarize(list, { ...base, weekday, bucket: null }, false);
    const rough = sameDay && sameDay.count >= MIN_LEARNING_OBSERVATIONS ? sameDay : overall;
    let leave = null;
    try {
      leave = opts.leaveFor(rough);
    } catch {
      leave = null;
    }
    if (isObject(leave)) {
      bucket = timeBucket(leave.time);
      // Keskiyön yli: lähtö edellisenä päivänä on sen päivän lähtö.
      if (isIsoDate(leave.date)) weekday = weekdayOfIso(leave.date);
    } else {
      bucket = null;
    }
  }

  const attempts = [];
  if (weekday !== null && bucket !== null) attempts.push([LEARNING_SCOPE.WEEKDAY_TIME, { weekday, bucket }]);
  if (bucket !== null) attempts.push([LEARNING_SCOPE.TIME, { weekday: null, bucket }]);
  if (weekday !== null) attempts.push([LEARNING_SCOPE.WEEKDAY, { weekday, bucket: null }]);
  for (const [scope, narrow] of attempts) {
    const summary = summarize(list, { ...base, ...narrow }, false);
    if (summary.count >= MIN_LEARNING_OBSERVATIONS) return scoped(summary, scope);
  }
  return scoped(overall, LEARNING_SCOPE.ALL);
}

/**
 * Paikan tarkentuneet luvut selitettäviksi (Profiili → Paikat): jokainen
 * viikonpäivä + lähtöikkuna, jolla on vähintään MIN_LEARNING_OBSERVATIONS
 * matkaa, ja lähtöikkuna ilman viikonpäivää, jos siinä on matkoja, joiden
 * omalla viikonpäivällä ei ole tarpeeksi. Eniten matkoja ensin.
 *
 * @returns {ReadonlyArray<object>} scoped-yhteenvedot, enintään `limit` (oletus 3)
 */
export function learnedCommuteBuckets(observations, options) {
  const opts = isObject(options) ? options : {};
  const base = readFilter({ placeId: opts.placeId, windowSize: opts.windowSize });
  if (base.placeId === null) return Object.freeze([]);
  const limit = intIn(opts.limit, 1, 20) ?? 3;
  const list = Array.isArray(observations) ? observations : [];

  const trips = [];
  for (const observation of list) {
    if (!isObject(observation) || observation.placeId !== base.placeId) continue;
    if (observedTravelMinutes(observation) === null) continue;
    const bucket = timeBucket(departureTimeOf(observation));
    if (bucket === null) continue;
    trips.push({ weekday: weekdayOf(observation), bucket });
  }

  const rows = [];
  const coveredDays = new Map();
  const pairs = new Map();
  for (const trip of trips) {
    if (trip.weekday !== null) pairs.set(`${trip.weekday}|${trip.bucket}`, trip);
  }
  for (const { weekday, bucket } of pairs.values()) {
    const summary = summarize(list, { ...base, weekday, bucket }, false);
    if (summary.count < MIN_LEARNING_OBSERVATIONS) continue;
    rows.push(scoped(summary, LEARNING_SCOPE.WEEKDAY_TIME));
    if (!coveredDays.has(bucket)) coveredDays.set(bucket, new Set());
    coveredDays.get(bucket).add(weekday);
  }
  const buckets = new Set();
  for (const trip of trips) {
    const covered = coveredDays.get(trip.bucket);
    if (!covered || trip.weekday === null || !covered.has(trip.weekday)) buckets.add(trip.bucket);
  }
  for (const bucket of buckets) {
    const summary = summarize(list, { ...base, weekday: null, bucket }, false);
    if (summary.count >= MIN_LEARNING_OBSERVATIONS) rows.push(scoped(summary, LEARNING_SCOPE.TIME));
  }

  rows.sort((a, b) => b.count - a.count
    || (a.weekday ?? 8) - (b.weekday ?? 8)
    || (a.timeBucket < b.timeBucket ? -1 : a.timeBucket > b.timeBucket ? 1 : 0));
  return Object.freeze(rows.slice(0, limit));
}

function tripWordOf(value) {
  if (typeof value !== 'string') return 'matkan';
  const word = value.trim();
  return /^[\p{L}-]{2,30}$/u.test(word) ? word : 'matkan';
}

/**
 * Matka-ajan ennuste ja sen selitys.
 *
 * Järjestys:
 *   1. tuore liikennetieto (`provider`, minuutteina) -- mutta jos käyttäjä
 *      on hyväksynyt oppimisen ja omat matkat ovat olleet hitaampia,
 *      käytetään varovaisempaa (suurempaa) lukua
 *   2. opittu (vain `useLearned === true` ja vähintään 3 matkaa):
 *      se kesto, johon useimmat matkat ovat mahtuneet
 *   3. käyttäjän oma arvio (`userMinutes`)
 *   4. tuntematon: minutes null, lähtöaikaa ei lasketa
 *
 * `observations` rajataan `placeId`:llä, jos se annetaan; muuten niiden
 * oletetaan jo olevan saman paikan matkoja. `summary` voi korvata ne.
 *
 * @returns {{minutes:number|null, source:string, explanation:string,
 *            learnedAvailable:boolean, summary:object}}
 */
export function forecastCommute(input) {
  const opts = isObject(input) ? input : {};
  const filter = readFilter(opts);
  let summary = isObject(opts.summary) && Number.isInteger(opts.summary.count) ? opts.summary : null;
  if (!summary) {
    const anyPlace = filter.placeId === null;
    summary = summarize(opts.observations, filter, anyPlace);
    // Liian tarkka rajaus (viikonpäivä, kellonaika) jättää usein alle
    // kolme matkaa: silloin katsotaan kaikkia saman paikan matkoja.
    if (summary.count < MIN_LEARNING_OBSERVATIONS && (filter.weekday !== null || filter.bucket !== null)) {
      summary = summarize(opts.observations, { ...filter, weekday: null, bucket: null }, anyPlace);
    }
  }

  const provider = intIn(opts.provider, 1, MAX_TRAVEL_MINUTES);
  const user = intIn(opts.userMinutes, 1, MAX_TRAVEL_MINUTES);
  const median = intIn(summary.median, 1, MAX_TRAVEL_MINUTES);
  const p80 = intIn(summary.p80, 1, MAX_TRAVEL_MINUTES);
  const learnedAvailable = Number.isInteger(summary.count) && summary.count >= MIN_LEARNING_OBSERVATIONS
    && median !== null && p80 !== null;
  const learned = learnedAvailable && opts.useLearned === true;
  const word = tripWordOf(opts.tripWord);

  const learnedText = learned
    ? `Viimeisten ${summary.count} ${word} mediaani oli ${median} min.`
      + (p80 > median ? ` Varman päälle lasketaan ${p80} min, johon useimmat matkat ovat mahtuneet.` : '')
    : '';

  let minutes = null;
  let source = ESTIMATE_SOURCE.UNKNOWN;
  let explanation;

  if (provider !== null) {
    if (learned && p80 > provider) {
      minutes = p80;
      source = ESTIMATE_SOURCE.LEARNED;
      explanation = `Liikennetiedon mukaan ${provider} min. ${learnedText}`;
    } else {
      minutes = provider;
      source = ESTIMATE_SOURCE.PROVIDER;
      explanation = `Liikennetiedon mukaan ${provider} min.`;
    }
  } else if (learned) {
    minutes = p80;
    source = ESTIMATE_SOURCE.LEARNED;
    explanation = learnedText;
  } else if (user !== null) {
    minutes = user;
    source = ESTIMATE_SOURCE.USER_SUPPLIED;
    explanation = `Oma arviosi: ${user} min.`;
  } else {
    explanation = 'Matka-aikaa ei tiedetä, joten lähtöaikaa ei lasketa.';
  }

  return Object.freeze({ minutes, source, explanation, learnedAvailable, summary });
}

// ------------------------------------------------------------ myöhästely

/**
 * Viimeisimpien lähtöjen keskimääräinen myöhästely (min) tai null. Poikkeamat (> 1 h) pois.
 * `preparationMinutes` (kokonaisluku) rajaa lähtöihin, jotka kuitattiin tällä
 * valmistautumisajalla: pidennyksen jälkeen vanhat lähdöt eivät enää todista.
 */
function latenessStats(observations, placeId, preparationMinutes = null) {
  const list = Array.isArray(observations) ? observations : [];
  const recent = newest(list, observation =>
    (placeId === null || observation.placeId === placeId)
    && (preparationMinutes === null
      || intIn(observation.preparationMinutes, 0, MAX_PREPARATION_MINUTES) === preparationMinutes)
    && isTimeOfDay(observation.plannedDeparture)
    && isTimeOfDay(observation.actualDeparture), LATENESS_WINDOW);

  let sum = 0;
  let count = 0;
  for (const observation of recent) {
    const late = clockDifference(observation.plannedDeparture, observation.actualDeparture);
    if (Math.abs(late) > MAX_LATENESS_SAMPLE_MINUTES) continue;
    sum += late;
    count += 1;
  }
  if (count < MIN_LATENESS_OBSERVATIONS) return null;
  return { count, mean: sum / count };
}

function lateSentence(meanLate) {
  return `Olet viime kerroilla lähtenyt keskimäärin ${meanLate} min suunniteltua myöhemmin.`;
}

/**
 * Ehdota lähtömuistutuksen aikaistusta, jos lähdöt ovat toistuvasti
 * myöhästyneet. EI MUUTA MITÄÄN: palauttaa kysymyksen tai null.
 *
 * Ehdot: vähintään 4 viimeisintä lähtöä, joilla on sekä suunniteltu että
 * toteutunut aika, ja keskimäärin vähintään 5 min myöhässä. Ehdotus
 * pyöristetään ylöspäin 5 minuutin monikertaan (enintään 60). Jos nykyinen
 * aikaistus (`currentOffsetMinutes`) jo riittää, ehdotusta ei ole.
 *
 * Sävy on neutraali: "olet lähtenyt myöhemmin", ei moitetta.
 *
 * @returns {null|{meanLateMinutes:number, suggestedOffsetMinutes:number, count:number, message:string}}
 */
export function latenessSuggestion(observations, options) {
  const opts = isObject(options) ? options : {};
  const placeId = typeof opts.placeId === 'string' && opts.placeId ? opts.placeId : null;
  const stats = latenessStats(observations, placeId);
  if (!stats || stats.mean < LATENESS_THRESHOLD_MINUTES) return null;

  const meanLateMinutes = Math.round(stats.mean);
  const suggestedOffsetMinutes = Math.min(MAX_REMINDER_OFFSET_MINUTES, roundUpToStep(stats.mean));
  const current = intIn(opts.currentOffsetMinutes, 0, MAX_REMINDER_OFFSET_MINUTES) ?? 0;
  if (suggestedOffsetMinutes <= current) return null;

  return Object.freeze({
    meanLateMinutes,
    suggestedOffsetMinutes,
    count: stats.count,
    message: `${lateSentence(meanLateMinutes)} Aloitetaanko lähtömuistutus ${suggestedOffsetMinutes} min aikaisemmin?`
  });
}

/**
 * Ehdota pidempää valmistautumista samoin perustein kuin muistutuksen
 * aikaistusta (vaihtoehto sille). EI MUUTA MITÄÄN.
 *
 * `onlyAtCurrentPreparation: true` laskee vain lähdöt, jotka kuitattiin
 * nykyisellä valmistautumisajalla (havainnon preparationMinutes). Muuten
 * hyväksytty pidennys ehdotettaisiin heti uudelleen vanhojen lähtöjen
 * perusteella, ja valmistautuminen kasvaisi portaittain ilman uutta näyttöä.
 *
 * @param {Array} observations
 * @param {{placeId?:string, currentPreparationMinutes?:number|null, onlyAtCurrentPreparation?:boolean}} [options]
 * @returns {null|{currentMinutes:number|null, suggestedMinutes:number, meanLateMinutes:number,
 *                 count:number, message:string}}
 */
export function preparationSuggestion(observations, options) {
  const opts = isObject(options) ? options : {};
  const placeId = typeof opts.placeId === 'string' && opts.placeId ? opts.placeId : null;
  const current = intIn(opts.currentPreparationMinutes, 0, MAX_PREPARATION_MINUTES);
  const only = opts.onlyAtCurrentPreparation === true && current !== null ? current : null;
  const stats = latenessStats(observations, placeId, only);
  if (!stats || stats.mean < LATENESS_THRESHOLD_MINUTES) return null;

  const meanLateMinutes = Math.round(stats.mean);
  const suggestedMinutes = Math.min(MAX_PREPARATION_MINUTES, (current ?? 0) + roundUpToStep(stats.mean));
  if (current !== null && suggestedMinutes <= current) return null;

  const question = current !== null && current > 0
    ? `Pidennetäänkö valmistautumista ${current} minuutista ${suggestedMinutes} minuuttiin?`
    : `Varataanko valmistautumiseen ${suggestedMinutes} min?`;

  return Object.freeze({
    currentMinutes: current,
    suggestedMinutes,
    meanLateMinutes,
    count: stats.count,
    message: `${lateSentence(meanLateMinutes)} ${question}`
  });
}

// ------------------------------------------------------------ karsinta

/** Vanhin ensin -- käänteinen uusimman järjestykselle, sama tasapelisääntö; lopuksi syötteen järjestys. */
function compareOldestFirst(a, b) {
  return compareNewestFirst(b.key, a.key) || a.index - b.index;
}

function pruneSplit(list, max) {
  const limit = Number.isInteger(max) && max >= 0 ? max : MAX_OBSERVATIONS_PER_PLACE;
  const items = Array.isArray(list) ? list : [];
  const groups = new Map();
  items.forEach((item, index) => {
    if (!isObject(item)) return;
    const place = typeof item.placeId === 'string' ? item.placeId : '';
    const group = groups.get(place);
    if (group) group.push(index);
    else groups.set(place, [index]);
  });

  const removedIndexes = new Set();
  const removed = [];
  for (const indexes of groups.values()) {
    if (indexes.length <= limit) continue;
    const oldestFirst = indexes
      .map(index => ({ index, item: items[index], key: recencyKey(items[index]) }))
      .sort(compareOldestFirst);
    for (const entry of oldestFirst.slice(0, indexes.length - limit)) {
      removedIndexes.add(entry.index);
      removed.push(entry);
    }
  }
  removed.sort(compareOldestFirst);
  const kept = items.filter((item, index) => isObject(item) && !removedIndexes.has(index));
  return { kept, removed: removed.map(entry => entry.item) };
}

/**
 * Pidä enintään `max` (oletus 60) havaintoa paikkaa kohden; vanhin pois ensin.
 * Palauttaa säilytettävät syötteen järjestyksessä. Kelvottomat alkiot jäävät pois.
 */
export function pruneObservations(list, max = MAX_OBSERVATIONS_PER_PLACE) {
  return Object.freeze(pruneSplit(list, max).kept);
}

/** Poistettavat havainnot (vanhin ensin) samalla säännöllä kuin `pruneObservations`. */
export function prunableObservations(list, max = MAX_OBSERVATIONS_PER_PLACE) {
  return Object.freeze(pruneSplit(list, max).removed);
}
