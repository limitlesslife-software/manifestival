// Kalenteritapahtuman luonti puheesta ilman kielimallia.
//
// PUHDAS MODUULI. Ei kelloa (tämä päivä annetaan), ei verkkoa, ei
// satunnaisuutta, ei mallia. Sama lause ja sama päivä tuottavat aina saman,
// jäädytetyn tuloksen.
//
// =====================================================================
// MITÄ TÄMÄ TEKEE
// =====================================================================
//
// "Lisää parturi ensi tiistaille klo 16" -> Parturi, ti, 16.00.
// "Teatteri lauantaina seitsemältä"       -> kysymys: klo 7 vai klo 19?
// "Hammaslääkäri huomenna 9.30 kestää tunnin" -> 9.30-10.30.
//
// Tulos on EHDOTUS, jonka käyttäjä vahvistaa. Jäsennin ei tallenna mitään.
//
// =====================================================================
// VAIN TARPEELLINEN KYSYMYS, EI KOSKAAN HILJAISTA ARVAUSTA
// =====================================================================
//
// Tärkeä kenttä (päivä, kellonaika, sanottu paikka) joko on selvä tai
// siitä kysytään. Epäselvästä ei valita "todennäköisintä": väärä päivä
// kalenterissa on pahempi kuin yksi kysymys. Kysymys esitetään vain, kun
// lause oikeasti on kaksitulkintainen -- puuttuvasta kentästä kerrotaan
// erikseen (missing), ja käyttäjä täyttää sen itse.
//
// TUHOAVA LAUSE EI OLE TAPAHTUMA: "poista", "peru" ja muut palauttavat null.
// Samoin keskeytykset ("olen myöhässä"), siirrot ja kysymykset.
//
// PAIKKA: tunnistus tulee kutsujalta funktiona (resolvePlace), jotta tämä
// moduuli ei riipu paikkojen tallennusmuodosta. Varma osuma (exact,
// learned) liitetään; epävarma näytetään ehdotuksena, ja jos käyttäjä
// sanoi paikan ("Kampissa"), siitä kysytään.

import {
  parseFinnishTemporal, DATE_ROLE, addDaysIso, weekdayOfIso, WEEKDAY_NUMBER, clockFromParts
} from './fiTemporal.js';
import { findFinnishDurations } from './fiDuration.js';
import { parseInterruption, mentionsDestructiveAction } from './interruptions.js';
import { isIsoDate, isTimeOfDay, toMinutes, fromMinutes } from './task.js';
import { wallClockToEpoch, durationText } from './wallClock.js';
import { shortDateLabel } from './calendar.js';
import { MAX_EVENT_TITLE_LENGTH } from './dailyLife.js';

export const CREATE_EVENT_INTENT = 'create_event';

/** Pidempi teksti ei ole yksittäinen komento (komentorivin raja on 300 merkkiä). */
export const MAX_EVENT_COMMAND_LENGTH = 300;

/** Ilman luontiverbiä ("Teatteri lauantaina ...") otsikossa saa olla enintään näin monta sanaa. */
export const MAX_VERBLESS_TITLE_WORDS = 6;

export const EVENT_PARSE_CONFIDENCE = Object.freeze({
  /** Luontiverbi, otsikko, päivä ja kellonaika selviä. */
  HIGH: 'high',
  /** Ei verbiä tai jokin kenttä puuttuu, mutta mitään ei tarvitse kysyä. */
  MEDIUM: 'medium',
  /** Jotain on kysyttävä tai otsikko puuttuu. */
  LOW: 'low'
});

export const EVENT_FIELD = Object.freeze({
  TITLE: 'title',
  DATE: 'date',
  TIME: 'time',
  DURATION: 'durationMinutes',
  PLACE: 'place'
});

const CONFIDENT_PLACE_STATUSES = new Set(['exact', 'learned']);

// ------------------------------------------------------------ sanastot

const POLITE = new Set(['voisitko', 'voitko', 'voisitteko', 'voisit', 'haluan', 'haluaisin', 'ole', 'hyvä', 'ja',
  'hei', 'moi', 'kiitos']);
const CREATE_VERBS = new Set(['lisää', 'lisätään', 'lisäisitkö', 'lisäätkö', 'laita', 'laitetaan', 'laitatko', 'pistä',
  'merkitse', 'merkitään', 'merkkaa', 'kirjaa', 'kirjataan', 'luo', 'varaa', 'varataan', 'tallenna', 'uusi']);
/** Lauseen alun verbit, jotka kuuluvat muille komennoille. */
const OTHER_VERBS = new Set(['siirrä', 'siirra', 'siirretään', 'siirtää', 'muuta', 'muutetaan', 'vaihda', 'näytä',
  'etsi', 'löydä', 'hae', 'muistuta', 'muista', 'muistuttaisitko', 'kuittaa', 'palauta', 'avaa', 'soita']);
/** Muut kohteet kuin kalenteritapahtuma. */
const OTHER_KINDS = new Set(['tehtävä', 'tehtäväksi', 'tehtävän', 'tehtävälistaan', 'tehtävälistalle', 'muistutus',
  'muistutukseksi', 'muistutuksen', 'ostoslistaan', 'kauppalistaan', 'ostoslistalle', 'kauppalistalle', 'rutiini',
  'rutiiniksi', 'rutiinin', 'projekti', 'projektiksi', 'projektin', 'tavoite', 'tavoitteeksi', 'tavoitteen',
  'lasku', 'laskuksi', 'laskun', 'budjetti', 'tehdyksi', 'valmiiksi', 'maksetuksi', 'hoidetuksi', 'tehty']);
const QUESTION_WORDS = new Set(['mitä', 'milloin', 'onko', 'kuinka', 'paljonko', 'miksi', 'mikä', 'missä', 'kenen',
  'montako', 'mihin', 'minkä', 'mitkä', 'monelta', 'moneltako', 'koska']);
/** Kalenterisanat: kertovat tapahtumasta, eivät kuulu otsikkoon. */
const CALENDAR_WORDS = new Set(['kalenteriin', 'kalenteriini', 'kalenteriisi', 'kalenteri', 'tapahtuma', 'tapahtumaksi',
  'tapahtumana', 'meno', 'menoksi', 'menona', 'merkintä', 'merkinnäksi', 'uusi', 'uudeksi']);
/** Sanat, jotka poistetaan otsikosta missä tahansa kohdassa. */
const DROP_ANYWHERE = new Set(['aamulla', 'aamupäivällä', 'iltapäivällä', 'illalla', 'yöllä', 'aamuyöllä', 'kestää',
  'kestäen', 'kesto', 'kestoltaan', 'klo', 'kello', 'alkaen', 'asti', 'saakka', 'noin', 'suunnilleen', 'ajan']);
/** Sanat, jotka poistetaan otsikon alusta ja lopusta ("mulla on hammaslääkäri"). */
const EDGE_FILLERS = new Set(['ja', 'on', 'eli', 'siis', 'että', 'se', 'mulla', 'minulla', 'mulle', 'minulle', 'meille',
  'meillä', 'meillä', 'mun', 'minun', 'mä', 'minä', 'me', 'kun', 'jossa', 'vielä']);
/** Ajankohtaan viittaavat sanat keston perässä: "tunnin päästä" ei ole kesto. */
const RELATIVE_FOLLOWERS = new Set(['päästä', 'kuluttua', 'sitten', 'ennen', 'aiemmin', 'aikaisemmin', 'myöhemmin',
  'myöhässä', 'etuajassa', 'jälkeen']);
const DAY_PART_TOKENS = new Set(['aamulla', 'aamupäivällä', 'iltapäivällä', 'illalla', 'yöllä', 'aamuyöllä']);

/** Paikan sijapäätteet: -ssa, -lla, -lle, illatiivin pitkä vokaali. Genetiivi (-n) ei ole paikka. */
const LOCATIVE_SUFFIX = /(?:ssa|ssä|lla|llä|lle|seen|siin|hin|hun|hon|hen|iin|aan|ään|een|oon|uun|yyn|öön)$/u;
const CASE_SUFFIXES = ['ssa', 'ssä', 'lla', 'llä', 'lle', 'lta', 'ltä', 'sta', 'stä'];
const LONG_VOWEL_ILLATIVE = ['aan', 'ään', 'een', 'iin', 'oon', 'uun', 'yyn', 'öön'];

const WORD = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;
const RANGE = /(?<![\p{L}\p{N}.:-])(?:(klo|kello)\s*)?(\d{1,2})(?:[.:](\d{2}))?\s*[-–—]\s*(?:(?:klo|kello)\s*)?(\d{1,2})(?:[.:](\d{2}))?(?![\p{N}]|[.:]\d)/gu;
const BARE_DOTTED_TIME = /(?<![\p{L}\p{N}.:,-])(\d{1,2})\.(\d{2})(?!\p{N})/gu;

// ------------------------------------------------------------ apurit

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** '07:00' -> '7', '09:30' -> '9.30' (puhuttu kellonaika kysymyksessä). */
function spokenClock(time) {
  const [hours, minutes] = time.split(':');
  return minutes === '00' ? String(Number(hours)) : `${Number(hours)}.${minutes}`;
}

/** 'ti 29.9.'; eri vuonna vuosi mukaan: 'ke 1.1.2020'. */
function dateLabel(iso, todayIso) {
  const label = shortDateLabel(iso);
  return iso.slice(0, 4) === todayIso.slice(0, 4) ? label : `${label}${Number(iso.slice(0, 4))}`;
}

function joinOptions(labels) {
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} vai ${labels[labels.length - 1]}`;
}

function overlaps(span, spans) {
  return spans.some(other => span.start < other.end && other.start < span.end);
}

function tokenize(lower) {
  const tokens = [];
  WORD.lastIndex = 0;
  let match;
  while ((match = WORD.exec(lower)) !== null) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

function blankOut(text, spans) {
  let out = text;
  for (const span of spans) {
    out = out.slice(0, span.start) + ' '.repeat(span.end - span.start) + out.slice(span.end);
  }
  return out;
}

function freezeAmbiguity(field, options, question, reason) {
  return Object.freeze({ field, options: Object.freeze([...options]), question, reason });
}

// ------------------------------------------------------------ kellonajat

/** Kellonaikaväli "klo 16-17", "16.00–17.30". Palauttaa välit ja niiden tiedot. */
function findRanges(lower, text) {
  const ranges = [];
  RANGE.lastIndex = 0;
  let match;
  while ((match = RANGE.exec(lower)) !== null) {
    const [whole, klo, startHour, startMinute, endHour, endMinute] = match;
    // Ilman klo-sanaa vaaditaan minuutit molemmissa: "16-17" voi olla muutakin.
    if (!klo && (startMinute === undefined || endMinute === undefined)) continue;
    const sh = Number(startHour);
    const sm = startMinute === undefined ? 0 : Number(startMinute);
    const eh = Number(endHour);
    const em = endMinute === undefined ? 0 : Number(endMinute);
    if (sh > 23 || eh > 24 || sm > 59 || em > 59 || (eh === 24 && em > 0)) continue;
    const start = clockFromParts(sh, sm, text);
    ranges.push({
      start: match.index,
      end: match.index + whole.length,
      startEntry: { ...start, expr: whole.trim(), start: match.index, end: match.index + whole.length },
      endHour: eh === 24 ? 0 : eh,
      endMinute: em,
      startHour: sh,
      startMinute: sm
    });
  }
  return ranges;
}

/** Välin loppu, kun alku tiedetään: "klo 7-9 illalla" -> 21.00, "klo 23-1" -> 01.00. */
function rangeEnd(startTime, range) {
  const start = toMinutes(startTime);
  let end = range.endHour * 60 + range.endMinute;
  if (end <= start && range.endHour < 12 && end + 720 > start) end += 720;
  return fromMinutes(end % 1440);
}

/** Välin kesto ilman alun aamu/ilta-tietoa: "klo 7-9" = 2 h kummin päin tahansa. */
function rangeDurationWithoutStart(range) {
  const start = range.startHour * 60 + range.startMinute;
  const end = range.endHour * 60 + range.endMinute;
  const diff = (((end - start) % 720) + 720) % 720;
  return diff > 0 ? diff : null;
}

function wrapDuration(startTime, endTime) {
  const diff = (toMinutes(endTime) - toMinutes(startTime) + 1440) % 1440;
  return diff > 0 ? diff : null;
}

// ------------------------------------------------------------ paikka

function stemCandidates(word) {
  const out = new Set([word]);
  const add = stem => {
    if (stem.length < 2) return;
    out.add(stem);
    // Konsonanttivartaloinen laina: "motoneti(ssa)" -> "motonet".
    if (stem.length > 3 && stem.endsWith('i')) out.add(stem.slice(0, -1));
    // Astevaihtelu: "kaupa(ssa)" -> "kauppa", "kampi(ssa)" -> "kamppi".
    const gradation = /([kpt])([aeiouyäö])$/u.exec(stem);
    if (gradation && !stem.endsWith(gradation[1] + gradation[1] + gradation[2])) {
      out.add(stem.slice(0, -2) + gradation[1] + gradation[1] + gradation[2]);
    }
  };
  for (const suffix of LONG_VOWEL_ILLATIVE) if (word.endsWith(suffix)) add(word.slice(0, -2));
  for (const suffix of CASE_SUFFIXES) if (word.endsWith(suffix)) add(word.slice(0, -suffix.length));
  if (word.endsWith('seen')) add(word.slice(0, -4));
  if (word.endsWith('n')) add(word.slice(0, -1));
  return [...out];
}

function projectMatch(match) {
  if (!isObject(match) || typeof match.status !== 'string') return null;
  const place = isObject(match.place) && typeof match.place.id === 'string' ? match.place : null;
  const nameOf = value => (typeof value.name === 'string' ? value.name.trim() : '');
  const candidates = (Array.isArray(match.candidates) ? match.candidates : [])
    .filter(candidate => isObject(candidate) && typeof candidate.id === 'string')
    .slice(0, 8)
    .map(candidate => Object.freeze({ id: candidate.id, name: nameOf(candidate) }));
  return Object.freeze({
    status: match.status,
    placeId: place ? place.id : null,
    placeName: place ? nameOf(place) : null,
    confidence: typeof match.confidence === 'string' ? match.confidence : null,
    reason: typeof match.reason === 'string' ? match.reason : '',
    candidates: Object.freeze(candidates)
  });
}

/**
 * Onko ehdokkaan nimi oikeasti lähellä sanottua? Tunnistus voi palauttaa
 * epävarmoja ehdokkaita myös alueen tai osoitteen perusteella ("Kampissa"
 * -> paikka, jonka alue on Kamppi). Sellaisesta ei kysytä "tarkoititko
 * paikkaa Hammaslääkäri?", koska käyttäjä ei sanonut mitään sen suuntaista.
 */
function nameRelevant(name, text) {
  const folded = typeof name === 'string' ? name.normalize('NFC').toLocaleLowerCase('fi').trim() : '';
  if (!folded || text.length < 3) return false;
  if (folded.includes(text) || text.includes(folded)) return true;
  return folded.split(/\s+/).some(word => word.length >= 3 && (word.startsWith(text) || text.startsWith(word)));
}

/** Kutsujan paikkatunnistus suojattuna: heittävä tai outo vastaus on "ei tulosta". */
function makeResolver(resolvePlace, places, aliases) {
  if (typeof resolvePlace !== 'function') return null;
  const cache = new Map();
  return text => {
    if (cache.has(text)) return cache.get(text);
    let projected = null;
    try {
      projected = projectMatch(resolvePlace(text, { places, aliases }));
    } catch {
      projected = null;
    }
    if (projected && projected.status === 'ambiguous') {
      const relevant = projected.candidates.filter(candidate => nameRelevant(candidate.name, text));
      projected = relevant.length > 0
        ? Object.freeze({ ...projected, candidates: Object.freeze(relevant) })
        : Object.freeze({ ...projected, status: 'none', candidates: Object.freeze([]), reason: 'Tallennettua paikkaa ei löytynyt.' });
    }
    cache.set(text, projected);
    return projected;
  };
}

function rankMatch(match) {
  if (!match) return 0;
  if (CONFIDENT_PLACE_STATUSES.has(match.status) && match.placeId) return 3;
  if (match.status === 'ambiguous') return 2;
  return 1;
}

function bestMatch(resolver, texts) {
  let best = null;
  for (const text of texts) {
    const match = resolver(text);
    if (rankMatch(match) > rankMatch(best)) best = match;
    if (rankMatch(best) === 3) break;
  }
  return best;
}

// ------------------------------------------------------------ päivät

function dateQuestion(entry, todayIso) {
  const label = iso => dateLabel(iso, todayIso);
  switch (entry.reason) {
    case 'same_weekday': {
      const later = addDaysIso(todayIso, 7);
      return freezeAmbiguity(EVENT_FIELD.DATE, [todayIso, later],
        `Tarkoitatko tänään (${label(todayIso)}) vai viikon päästä (${label(later)})?`, entry.reason);
    }
    case 'weekend': {
      const weekday = weekdayOfIso(todayIso);
      const saturday = weekday === 7 ? addDaysIso(todayIso, 6) : addDaysIso(todayIso, 6 - weekday);
      const options = weekday === 7 ? [todayIso, saturday, addDaysIso(saturday, 1)] : [saturday, addDaysIso(saturday, 1)];
      return freezeAmbiguity(EVENT_FIELD.DATE, options,
        `Kumpana päivänä: ${joinOptions(options.map(label))}?`, entry.reason);
    }
    case 'past_this_week': {
      const name = Object.keys(WEEKDAY_NUMBER).find(day => entry.expr.includes(day));
      const next = name ? addDaysIso(addDaysIso(todayIso, -(weekdayOfIso(todayIso) - 1)), 7 + WEEKDAY_NUMBER[name] - 1) : null;
      return next
        ? freezeAmbiguity(EVENT_FIELD.DATE, [next], `Tämän viikon ${name} on jo mennyt. Tarkoitatko ${label(next)}?`, entry.reason)
        : freezeAmbiguity(EVENT_FIELD.DATE, [], 'Päivä on jo mennyt. Minä päivänä tapahtuma on?', entry.reason);
    }
    case 'week_only':
      return freezeAmbiguity(EVENT_FIELD.DATE, [], `Minä päivänä ${entry.expr}?`, entry.reason);
    default:
      return freezeAmbiguity(EVENT_FIELD.DATE, [], 'Päivämäärä ei ole kalenterissa. Minä päivänä tapahtuma on?', entry.reason || 'invalid');
  }
}

function resolveDate(parsedDates, todayIso) {
  let relevant = parsedDates.filter(entry => entry.role === DATE_ROLE.TARGET);
  // "Lisää huomisen palaveri": genetiivi nimeää tapahtuman päivän, kun muuta päivää ei ole.
  if (relevant.length === 0) {
    relevant = parsedDates.filter(entry => entry.role === DATE_ROLE.REFERENCE && /n$/u.test(entry.expr));
  }
  relevant = relevant.map(entry => (entry.week ? { ...entry, iso: null, ambiguous: true, reason: 'week_only' } : entry));
  if (relevant.length === 0) return { date: null, ambiguity: null, any: false };

  const unclear = relevant.filter(entry => entry.ambiguous).sort((a, b) => a.start - b.start);
  const clear = [...new Set(relevant.filter(entry => !entry.ambiguous).map(entry => entry.iso))].sort();
  if (unclear.length > 0) return { date: null, ambiguity: dateQuestion(unclear[0], todayIso), any: true };
  if (clear.length > 1) {
    return {
      date: null,
      ambiguity: freezeAmbiguity(EVENT_FIELD.DATE, clear, `Kumpana päivänä: ${joinOptions(clear.map(iso => dateLabel(iso, todayIso)))}?`, 'multiple'),
      any: true
    };
  }
  const [date] = clear;
  if (date < todayIso) {
    return {
      date: null,
      ambiguity: freezeAmbiguity(EVENT_FIELD.DATE, [date], `Päivä ${dateLabel(date, todayIso)} on jo mennyt. Lisätäänkö silti?`, 'past'),
      any: true
    };
  }
  return { date, ambiguity: null, any: true };
}

// ------------------------------------------------------------ kellonaika

function resolveTime(entries) {
  if (entries.length === 0) return { time: null, ambiguity: null };
  const unclear = entries.filter(entry => entry.ambiguous);
  const clear = [...new Set(entries.filter(entry => !entry.ambiguous).map(entry => entry.time))].sort();

  if (unclear.length === 0) {
    if (clear.length === 1) return { time: clear[0], ambiguity: null };
    return {
      time: null,
      ambiguity: freezeAmbiguity(EVENT_FIELD.TIME, clear,
        `Mihin aikaan tapahtuma alkaa: ${joinOptions(clear.map(t => `klo ${spokenClock(t)}`))}?`, 'multiple')
    };
  }

  // "klo 19 eli seitsemältä": epäselvän vaihtoehdoissa on sama selvä aika.
  if (clear.length === 1 && unclear.every(entry => Array.isArray(entry.options) && entry.options.includes(clear[0]))) {
    return { time: clear[0], ambiguity: null };
  }

  const options = [...new Set([...clear, ...unclear.flatMap(entry => (Array.isArray(entry.options) ? entry.options : []))])].sort();
  const reason = unclear[0].reason || 'ambiguous';
  if (options.length === 2 && clear.length === 0 && unclear.every(entry => Array.isArray(entry.options))) {
    return {
      time: null,
      ambiguity: freezeAmbiguity(EVENT_FIELD.TIME, options,
        `Tarkoitatko klo ${spokenClock(options[0])} vai klo ${spokenClock(options[1])}?`, reason)
    };
  }
  if (options.length > 0) {
    return {
      time: null,
      ambiguity: freezeAmbiguity(EVENT_FIELD.TIME, options,
        `Mihin aikaan tapahtuma alkaa: ${joinOptions(options.map(t => `klo ${spokenClock(t)}`))}?`, reason)
    };
  }
  const question = reason === 'daypart_conflict'
    ? 'Kellonaika ja vuorokaudenaika eivät sovi yhteen. Mihin aikaan tapahtuma alkaa?'
    : 'Kellonaika ei ole kelvollinen. Mihin aikaan tapahtuma alkaa?';
  return { time: null, ambiguity: freezeAmbiguity(EVENT_FIELD.TIME, [], question, reason) };
}

/**
 * Kesäajan vaihtoyö: olematon kellonaika (kevät) kysytään, kahdesti
 * esiintyvä (syksy) kysytään. Ilman aikavyöhykefunktiota ei tarkisteta.
 */
function daylightSavingQuestion(date, time, offsetMinutesFn) {
  if (typeof offsetMinutesFn !== 'function') return null;
  let resolved = null;
  try {
    resolved = wallClockToEpoch(date, time, offsetMinutesFn);
  } catch {
    return null;
  }
  if (!resolved) return null;
  if (resolved.nonexistent) {
    return freezeAmbiguity(EVENT_FIELD.TIME, [resolved.time],
      `Kello ${spokenClock(time)} jää sinä yönä pois, kun kellot siirtyvät eteenpäin. Sopiiko klo ${spokenClock(resolved.time)}?`,
      'dst_gap');
  }
  if (resolved.ambiguous) {
    return freezeAmbiguity(EVENT_FIELD.TIME, [time],
      `Kello ${spokenClock(time)} toistuu sinä yönä kahdesti, kun kellot siirtyvät taaksepäin. Merkitäänkö ensimmäiseen kertaan?`,
      'dst_repeat');
  }
  return null;
}

// ------------------------------------------------------------ API

/**
 * Tulkitse tapahtuman luontilause.
 *
 * @param {string} text
 * @param {object} options
 * @param {string}   options.todayIso        tämä päivä (YYYY-MM-DD)
 * @param {Array}    [options.places]        tallennetut paikat (välitetään resolvePlace-funktiolle)
 * @param {Array}    [options.aliases]       opitut paikkanimet (välitetään resolvePlace-funktiolle)
 * @param {Function} [options.resolvePlace]  (text, {places, aliases}) -> {status, place, candidates, confidence, reason}
 * @param {Function} [options.offsetMinutesFn] aikavyöhyke (wallClock.js); kesäajan vaihtoyön tarkistus
 * @returns {null | {intent:'create_event', title:string|null, date:string|null, time:string|null,
 *   endTime:string|null, durationMinutes:number|null, allDay:boolean, placeText:string|null,
 *   placeMatch:object|null, placeId:string|null, missing:string[], ambiguities:Array<{field, options, question, reason}>,
 *   notes:string[], confidence:'high'|'medium'|'low'}}
 */
export function parseCreateEvent(text, options = {}) {
  if (typeof text !== 'string' || text.length > MAX_EVENT_COMMAND_LENGTH * 2) return null;
  const opts = isObject(options) ? options : {};
  const todayIso = isIsoDate(opts.todayIso) ? opts.todayIso : null;
  if (!todayIso) return null;

  const norm = text.normalize('NFC');
  if (norm.trim().length === 0 || norm.length > MAX_EVENT_COMMAND_LENGTH) return null;
  const lower = norm.toLocaleLowerCase('fi');
  // Otsikko otetaan alkuperäisestä kirjoitusasusta, jos kohdat vastaavat toisiaan.
  const display = lower.length === norm.length ? norm : lower;

  // Tuhoava, keskeytys, kysymys tai muu komento: ei tapahtuma.
  if (mentionsDestructiveAction(norm)) return null;
  if (parseInterruption(norm, { todayIso }) !== null) return null;
  if (/\?\s*$/u.test(norm)) return null;

  const tokens = tokenize(lower);
  if (tokens.length === 0) return null;
  if (tokens.some(token => OTHER_KINDS.has(token.text))) return null;

  let first = 0;
  while (first < tokens.length - 1 && first < 3 && POLITE.has(tokens[first].text)) first += 1;
  const lead = tokens[first].text;
  if (OTHER_VERBS.has(lead) || QUESTION_WORDS.has(lead) || QUESTION_WORDS.has(tokens[0].text)) return null;
  const hasVerb = CREATE_VERBS.has(lead);
  const masks = hasVerb ? [{ start: tokens[0].start, end: tokens[first].end }] : [];
  const notes = [];

  // 1. Kellonaikavälit ("klo 16-17") ennen muuta, jotta välin loppu ei näytä toiselta ajalta.
  const ranges = findRanges(lower, norm);
  const temporalInput = blankOut(lower, ranges);

  // 2. Päivät ja kellonajat.
  const parsed = parseFinnishTemporal(temporalInput, todayIso);
  const temporalSpans = [...parsed.dates, ...parsed.times, ...ranges.map(range => range.startEntry)];

  // 3. "9.30" ilman klo-sanaa: kellonaika, jos minuutit > 12 (ei voi olla
  //    kuukausi) tai päivä on sanottu muualla. Muuten se jätetään (voisi olla päiväys).
  const bareTimes = [];
  const dateSaid = parsed.dates.length > 0;
  BARE_DOTTED_TIME.lastIndex = 0;
  let bare;
  while ((bare = BARE_DOTTED_TIME.exec(temporalInput)) !== null) {
    const span = { start: bare.index, end: bare.index + bare[0].length };
    if (overlaps(span, temporalSpans)) continue;
    const hour = Number(bare[1]);
    const minute = Number(bare[2]);
    if (hour > 23 || minute > 59) continue;
    const followedByDot = temporalInput[span.end] === '.';
    if (minute <= 12 && (followedByDot || !dateSaid)) continue;
    bareTimes.push({ ...clockFromParts(hour, minute, norm), expr: bare[0], ...span });
  }

  const timeEntries = [...parsed.times, ...bareTimes, ...ranges.map(range => range.startEntry)]
    .sort((a, b) => a.start - b.start);
  const timeSpans = [...timeEntries, ...ranges];
  masks.push(...parsed.dates, ...timeSpans);

  // 4. Kesto ("kestää tunnin"). "Tunnin päästä" on ajankohta, ei kesto.
  const durations = [];
  let relativeTime = false;
  for (const entry of findFinnishDurations(norm)) {
    if (overlaps(entry, timeSpans) || overlaps(entry, parsed.dates)) continue;
    if (entry.followedBy && RELATIVE_FOLLOWERS.has(entry.followedBy)) {
      relativeTime = true;
      const follower = tokens.find(token => token.start >= entry.end);
      masks.push({ start: entry.start, end: follower ? follower.end : entry.end });
      continue;
    }
    masks.push(entry);
    durations.push(entry);
  }
  if (relativeTime) notes.push('Suhteellista ajankohtaa ("tunnin päästä") ei tulkita. Kerro kellonaika.');

  // 5. Koko päivän tapahtuma: "koko päivän".
  let allDay = false;
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    if (tokens[i].text === 'koko' && /^päivä(?:n|ksi)?$/u.test(tokens[i + 1].text)) {
      allDay = timeEntries.length === 0;
      masks.push({ start: tokens[i].start, end: tokens[i + 1].end });
    }
  }

  const anchor = parsed.dates.length > 0 || timeEntries.length > 0 || allDay;
  const calendarWord = tokens.some(token => CALENDAR_WORDS.has(token.text));
  // Ilman verbiä tapahtuma tarvitsee ajankohdan; verbin kanssa ajankohdan tai kalenterisanan.
  if (!anchor && !(hasVerb && calendarWord)) return null;

  // 6. Otsikon ehdokassanat.
  const isMasked = token => overlaps(token, masks);
  const contentTokens = tokens.filter(token => !isMasked(token)
    && !CALENDAR_WORDS.has(token.text) && !DROP_ANYWHERE.has(token.text));
  let lo = 0;
  let hi = contentTokens.length;
  while (lo < hi && EDGE_FILLERS.has(contentTokens[lo].text)) lo += 1;
  while (hi > lo && EDGE_FILLERS.has(contentTokens[hi - 1].text)) hi -= 1;
  let titleTokens = contentTokens.slice(lo, hi);

  if (!hasVerb && (titleTokens.length === 0 || titleTokens.length > MAX_VERBLESS_TITLE_WORDS)) return null;

  // 7. Paikka.
  const places = Array.isArray(opts.places) ? opts.places : [];
  const aliases = Array.isArray(opts.aliases) ? opts.aliases : [];
  const resolver = makeResolver(opts.resolvePlace, places, aliases);
  let placeText = null;
  let placeMatch = null;
  let placeTokens = [];
  let placeSaid = false;

  const sentenceStart = tokens[0].start;
  const locatives = titleTokens.filter(token => token.start !== sentenceStart
    && LOCATIVE_SUFFIX.test(token.text) && !DAY_PART_TOKENS.has(token.text));
  const capitalized = locatives.filter(token => {
    const ch = display[token.start];
    return ch !== ch.toLocaleLowerCase('fi');
  });
  // a) Isolla alkukirjaimella kirjoitettu paikan sija ("Kampissa") on sanottu paikka.
  if (capitalized.length > 0) {
    const token = capitalized[capitalized.length - 1];
    placeTokens = [token];
    placeSaid = true;
    placeText = display.slice(token.start, token.end);
    placeMatch = resolver ? bestMatch(resolver, stemCandidates(token.text)) : null;
  } else if (resolver) {
    // b) Pienellä kirjoitettu sija, joka on varmasti tallennettu paikka ("motonetilla").
    for (const token of locatives) {
      const match = bestMatch(resolver, stemCandidates(token.text).filter(stem => stem !== token.text));
      if (rankMatch(match) === 3) {
        placeTokens = [token];
        placeSaid = true;
        placeText = display.slice(token.start, token.end);
        placeMatch = match;
        break;
      }
    }
    // c) Otsikko itse on paikka ("Parturi"): koko otsikko, sitten sana kerrallaan.
    if (!placeMatch && titleTokens.length > 0) {
      const whole = titleTokens.map(token => token.text).join(' ');
      let match = resolver(whole);
      let matched = titleTokens;
      if (rankMatch(match) < 3) {
        for (const token of titleTokens.slice(0, 24)) {
          const candidate = bestMatch(resolver, stemCandidates(token.text));
          if (rankMatch(candidate) > rankMatch(match)) {
            match = candidate;
            matched = [token];
          }
          if (rankMatch(match) === 3) break;
        }
      }
      if (rankMatch(match) >= 2) {
        placeMatch = match;
        placeText = matched.map(token => display.slice(token.start, token.end)).join(' ');
        // Otsikon sana ei ole erillinen paikkamaininta, joten se jää otsikkoon --
        // paitsi sijamuoto, joka on varmasti paikka.
        if (rankMatch(match) === 3 && matched.length === 1 && LOCATIVE_SUFFIX.test(matched[0].text) && titleTokens.length > 1) {
          placeTokens = matched;
          placeSaid = true;
        }
      }
    }
  }

  // Sanottu paikka ei ole otsikkoa, jos otsikkoon jää muuta.
  if (placeTokens.length > 0) {
    const rest = titleTokens.filter(token => !placeTokens.includes(token));
    if (rest.length > 0) titleTokens = rest;
    else if (placeMatch && rankMatch(placeMatch) === 3 && placeMatch.placeName) titleTokens = [];
  }

  let title = titleTokens.map(token => display.slice(token.start, token.end)).join(' ');
  if (!title && placeMatch && rankMatch(placeMatch) === 3 && placeMatch.placeName) title = placeMatch.placeName;
  if (title) {
    const chars = Array.from(title);
    title = (chars[0].toLocaleUpperCase('fi') + chars.slice(1).join('')).slice(0, MAX_EVENT_TITLE_LENGTH).trim();
  }

  // 8. Päivä ja kellonaika.
  const ambiguities = [];
  const dateResult = resolveDate(parsed.dates, todayIso);
  if (dateResult.ambiguity) ambiguities.push(dateResult.ambiguity);
  const date = dateResult.date;

  const timeResult = resolveTime(timeEntries);
  let time = timeResult.time;
  if (timeResult.ambiguity) ambiguities.push(timeResult.ambiguity);
  if (date && time) {
    const dst = daylightSavingQuestion(date, time, opts.offsetMinutesFn);
    if (dst) {
      ambiguities.push(dst);
      time = null;
    }
  }

  // 9. Kesto ja loppuaika.
  const range = ranges.length === 1 ? ranges[0] : null;
  const clearDurations = [...new Set(durations.filter(entry => !entry.ambiguous).map(entry => entry.minutes))].sort((a, b) => a - b);
  if (durations.some(entry => entry.ambiguous)) notes.push('Kesto jäi avoimeksi.');
  let durationMinutes = null;
  let endTime = null;
  let rangeMinutes = null;
  if (range) {
    if (isTimeOfDay(time)) {
      endTime = rangeEnd(time, range);
      rangeMinutes = wrapDuration(time, endTime);
    } else {
      // Alku on vielä kysymättä (klo 7 vai 19): välin pituus tiedetään silti.
      rangeMinutes = rangeDurationWithoutStart(range);
    }
  }
  const spokenDurations = rangeMinutes !== null && !clearDurations.includes(rangeMinutes) && clearDurations.length > 0
    ? [...new Set([rangeMinutes, ...clearDurations])].sort((a, b) => a - b)
    : clearDurations;
  if (spokenDurations.length > 1) {
    ambiguities.push(freezeAmbiguity(EVENT_FIELD.DURATION, spokenDurations,
      `Kuinka kauan tapahtuma kestää: ${joinOptions(spokenDurations.map(durationText))}?`, 'multiple'));
    endTime = null;
  } else {
    durationMinutes = spokenDurations.length === 1 ? spokenDurations[0] : rangeMinutes;
    if (!endTime && time && durationMinutes !== null) endTime = fromMinutes(toMinutes(time) + durationMinutes);
  }
  if (!time) endTime = null;

  // 10. Sanottu paikka, jota ei tunnistettu varmasti: kysytään.
  if (placeSaid && placeMatch && placeMatch.status === 'ambiguous' && placeMatch.candidates.length > 0) {
    const names = placeMatch.candidates.slice(0, 5).map(candidate => candidate.name).filter(Boolean);
    const question = names.length === 1 ? `Tarkoitatko paikkaa ${names[0]}?` : `Mikä paikka: ${joinOptions(names)}?`;
    ambiguities.push(freezeAmbiguity(EVENT_FIELD.PLACE, placeMatch.candidates.slice(0, 5).map(candidate => candidate.id),
      question, 'ambiguous_place'));
  }
  const placeId = placeMatch && rankMatch(placeMatch) === 3 ? placeMatch.placeId : null;

  const missing = [];
  if (!title) missing.push(EVENT_FIELD.TITLE);
  if (!date && !ambiguities.some(a => a.field === EVENT_FIELD.DATE)) missing.push(EVENT_FIELD.DATE);
  if (!time && !allDay && !ambiguities.some(a => a.field === EVENT_FIELD.TIME)) missing.push(EVENT_FIELD.TIME);

  let confidence = EVENT_PARSE_CONFIDENCE.MEDIUM;
  if (ambiguities.length > 0 || !title) confidence = EVENT_PARSE_CONFIDENCE.LOW;
  else if (hasVerb && date && (time || allDay)) confidence = EVENT_PARSE_CONFIDENCE.HIGH;

  return Object.freeze({
    intent: CREATE_EVENT_INTENT,
    title: title || null,
    date,
    time,
    endTime,
    durationMinutes,
    allDay: allDay && !time,
    placeText,
    placeMatch,
    placeId,
    missing: Object.freeze(missing),
    ambiguities: Object.freeze(ambiguities),
    notes: Object.freeze(notes),
    confidence
  });
}
