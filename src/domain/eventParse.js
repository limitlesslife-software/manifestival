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
  parseFinnishTemporal, DATE_ROLE, addDaysIso, weekdayOfIso, WEEKDAY_NUMBER, clockFromParts,
  nominativeHourValue, bareHourFromParts
} from './fiTemporal.js';
import { findFinnishDurations } from './fiDuration.js';
import { parseInterruption, mentionsDestructiveAction } from './interruptions.js';
import { isIsoDate, isTimeOfDay, toMinutes, fromMinutes } from './task.js';
import { wallClockToEpoch, durationText } from './wallClock.js';
import { shortDateLabel } from './calendar.js';
import { MAX_EVENT_TITLE_LENGTH } from './dailyLife.js';

export const CREATE_EVENT_INTENT = 'create_event';
/** "Minun pitää käydä Motonetissä tällä viikolla": avoin asia, ei meno (parseOpenEndedTask). */
export const CREATE_OPEN_TASK_INTENT = 'create_open_task';

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
const LOCATIVE_SUFFIX = /(?:ssa|ssä|lla|llä|lle|seen|siin|hin|hun|hon|hen|hön|hyn|iin|aan|ään|een|oon|uun|yyn|öön)$/u;
/**
 * Työn arkiset muodot: "töissä", "töihin" (monikko töi-), "työpaikalla",
 * "duunissa". Nämä tarkoittavat samaa kuin "työ", joten ne haetaan myös
 * sanalla "työ" -- tallennettu paikka "Työ" on silloin täsmällinen osuma.
 */
const WORK_STEMS = new Set(['töi', 'työpaika', 'työpaikka', 'duuni']);
/** Sanat, joiden edessä pelkkä luku päivän perässä on kellonaika ("maanantaina 18 kestää tunnin"). */
const SPOKEN_TIME_FOLLOWERS = new Set(['aamulla', 'aamupäivällä', 'iltapäivällä', 'illalla', 'yöllä', 'aamuyöllä',
  'kestää', 'kestäen', 'kesto', 'alkaen', 'asti', 'saakka', 'ja', 'eli']);
/** Avoimen asian otsikon alusta pois: "(minun) pitää käydä Motonetissä" -> "Käydä Motonetissä". */
const TASK_LEAD_FILLERS = new Set(['pitää', 'pitäisi', 'pitäis', 'täytyy', 'täytyisi', 'tarvitsee', 'tarttee', 'pakko',
  'olisi', 'ois', 'pitänee']);
/** Avoimen asian otsikon lopusta pois: "hoitaa verot (tämän viikon) aikana". */
const TASK_TAIL_FILLERS = new Set(['aikana', 'mennessä', 'loppuun', 'lopussa', 'lopulla', 'sisällä', 'jossain', 'joskus',
  'vielä']);
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

/** Sanat otsikoksi alkuperäisellä kirjoitusasulla, iso alkukirjain, rajattu. '' jos ei sanoja. */
function titleText(tokens, display) {
  const text = tokens.map(token => display.slice(token.start, token.end)).join(' ');
  if (!text) return '';
  const chars = Array.from(text);
  return (chars[0].toLocaleUpperCase('fi') + chars.slice(1).join('')).slice(0, MAX_EVENT_TITLE_LENGTH).trim();
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

const AFTER_DATE_NUMBER = /^[\s,]+(\d{1,2})(?:\s*[-–—]\s*(\d{1,2}))?(?![\p{L}\p{N}]|[.:,]\d)/u;
const AFTER_DATE_WORD = /^[\s,]+(\p{L}+)(?![\p{L}\p{N}])/u;

/**
 * Kellonaika ilman klo-sanaa HETI päivän perässä: "torstaina 14-15",
 * "maanantaina 18", "perjantaina kaksitoista". Luvun jälkeen saa tulla vain
 * lauseen loppu, vuorokaudenaika tai kesto-/rajasana ("18 kestää tunnin"),
 * jotta "lauantaina 18 hengelle" tai "huomenna 2 tuntia" eivät ole
 * kellonaikoja. Tunti 1-11 on epäselvä (klo 7 vai 19) kuten tuntisana.
 *
 * @returns {null | {entry:object} | {range:object}}
 */
function spokenTimeAfterDate(input, dates, text) {
  const endsClause = rest => /^[\s,.!]*$/u.test(rest) || (() => {
    const next = /^[\s,]*(\p{L}+)/u.exec(rest);
    return Boolean(next && SPOKEN_TIME_FOLLOWERS.has(next[1]));
  })();
  for (const date of [...dates].sort((a, b) => a.start - b.start)) {
    if (date.week || !Number.isInteger(date.end)) continue;
    const rest = input.slice(date.end);
    const number = AFTER_DATE_NUMBER.exec(rest);
    if (number) {
      if (!endsClause(rest.slice(number[0].length))) continue;
      const lead = number[0].length - number[0].trimStart().length;
      const start = date.end + lead;
      const end = date.end + number[0].length;
      const startHour = Number(number[1]);
      if (startHour < 1 || startHour > 23) continue;
      const entry = { ...bareHourFromParts(startHour, text), expr: number[0].trim(), start, end };
      if (number[2] === undefined) return { entry };
      const endHour = Number(number[2]);
      if (endHour > 24) continue;
      return {
        range: {
          start, end, startEntry: entry,
          endHour: endHour === 24 ? 0 : endHour, endMinute: 0, startHour, startMinute: 0
        }
      };
    }
    const word = AFTER_DATE_WORD.exec(rest);
    const hour = word ? nominativeHourValue(word[1]) : null;
    if (hour !== null && endsClause(rest.slice(word[0].length))) {
      const lead = word[0].length - word[0].trimStart().length;
      const start = date.end + lead;
      return { entry: { ...bareHourFromParts(hour, text), expr: word[1], start, end: start + word[1].length } };
    }
  }
  return null;
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
  // Lyhyen sanan illatiivi -hVn: "työhön" -> "työ", "töihin" -> "töi", "maahan" -> "maa".
  const illative = /h([aeiouyäö])n$/u.exec(word);
  if (illative && word.length >= 6 && word[word.length - 4] === illative[1]) add(word.slice(0, -3));
  if (word.endsWith('n')) add(word.slice(0, -1));
  // Työn arkiset muodot haetaan myös perusmuodolla "työ".
  if ([...out].some(stem => WORK_STEMS.has(stem))) out.add('työ');
  // Perusmuodot ensin, sana itse viimeisenä: yhtä hyvistä osumista voittaa
  // perusmuoto ("motonetissa" -> "motonet" osuu kaikkiin Motonet-paikkoihin),
  // ja se on myös opittava nimitys, joka tunnistaa seuraavankin taivutuksen.
  const [word0, ...stems] = [...out];
  return [...stems, word0];
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

/**
 * Tiukempi osuvuus otsikon sanalle, jota ei sanottu paikan sijassa
 * ("parturi"): sanan on oltava paikan nimen (tai sen sanan) alku. Pelkkä
 * sisältyminen ei riitä, koska yhdyssana ei ole paikkamaininta:
 * "työpalaveri" ei ehdota paikkaa Työ eikä "kotisiivous" paikkaa Koti.
 */
function titleRelevant(name, text) {
  const folded = typeof name === 'string' ? name.normalize('NFC').toLocaleLowerCase('fi').trim() : '';
  if (!folded || text.length < 3) return false;
  return folded.startsWith(text) || folded.split(/\s+/).some(word => word.startsWith(text));
}

/** Käyttäjän vahvistamat nimitykset (vähintään kerran): taitettu teksti -> paikkojen tunnisteet. */
function confirmedAliasIndex(aliases) {
  const index = new Map();
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    if (!isObject(alias) || typeof alias.placeId !== 'string' || typeof alias.alias !== 'string') continue;
    if (!(typeof alias.confirmations === 'number' && alias.confirmations >= 1)) continue;
    const folded = alias.alias.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('fi');
    if (!folded) continue;
    if (!index.has(folded)) index.set(folded, new Set());
    index.get(folded).add(alias.placeId);
  }
  return index;
}

/**
 * Kutsujan paikkatunnistus suojattuna: heittävä tai outo vastaus on "ei tulosta".
 *
 * Tapa (mode) kertoo, miten paikka mainittiin: 'said' = paikan sijassa
 * ("Kampissa", "parturiin"), 'title' = otsikon sana ("parturi"). Epävarmoista
 * ehdokkaista jätetään vain osuvat (ks. nameRelevant, titleRelevant); ehdokas,
 * jolle käyttäjä on jo kerran vahvistanut juuri tämän sanan, on aina osuva.
 * Tuloksessa `query` on teksti, jolla osuma löytyi: se on opittava nimitys.
 */
function makeResolver(resolvePlace, places, aliases) {
  if (typeof resolvePlace !== 'function') return null;
  const raw = new Map();
  const cache = new Map();
  const confirmed = confirmedAliasIndex(aliases);
  return (text, mode = 'said') => {
    const key = `${mode}:${text}`;
    if (cache.has(key)) return cache.get(key);
    if (!raw.has(text)) {
      let projectedRaw = null;
      try {
        projectedRaw = projectMatch(resolvePlace(text, { places, aliases }));
      } catch {
        projectedRaw = null;
      }
      raw.set(text, projectedRaw);
    }
    let projected = raw.get(text);
    if (projected && projected.status === 'ambiguous') {
      const relevantName = mode === 'title' ? titleRelevant : nameRelevant;
      const ownAlias = confirmed.get(text);
      const relevant = projected.candidates
        .filter(candidate => relevantName(candidate.name, text) || Boolean(ownAlias && ownAlias.has(candidate.id)));
      projected = relevant.length > 0
        ? Object.freeze({ ...projected, candidates: Object.freeze(relevant) })
        : Object.freeze({ ...projected, status: 'none', candidates: Object.freeze([]), reason: 'Tallennettua paikkaa ei löytynyt.' });
    }
    if (projected) projected = Object.freeze({ ...projected, query: text });
    cache.set(key, projected);
    return projected;
  };
}

function rankMatch(match) {
  if (!match) return 0;
  if (CONFIDENT_PLACE_STATUSES.has(match.status) && match.placeId) return 3;
  if (match.status === 'ambiguous') return 2;
  return 1;
}

function bestMatch(resolver, texts, mode = 'said') {
  let best = null;
  for (const text of texts) {
    const match = resolver(text, mode);
    if (rankMatch(match) > rankMatch(best)) best = match;
    // Kahdesta epävarmasta se, jossa on enemmän ehdokkaita: valintaa ei kavenneta
    // hiljaa ("motoneti" osuisi vain kerran vahvistettuun, "motonet" kaikkiin).
    else if (rankMatch(match) === 2 && rankMatch(best) === 2 && match.candidates.length > best.candidates.length) best = match;
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
    case 'week_only': {
      // Viikon päivät vaihtoehtoina (tällä viikolla vain jäljellä olevat),
      // jotta "kokous ensi viikolla klo 10" ei jää umpikujaan.
      const options = [];
      if (isIsoDate(entry.weekStart)) {
        for (let day = 0; day < 7; day += 1) {
          const iso = addDaysIso(entry.weekStart, day);
          if (iso >= todayIso) options.push(iso);
        }
      }
      return freezeAmbiguity(EVENT_FIELD.DATE, options, `Minä päivänä ${entry.expr}?`, entry.reason);
    }
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
  relevant = relevant.map(entry => (entry.week
    ? { ...entry, iso: null, ambiguous: true, reason: 'week_only', weekStart: entry.iso } : entry));
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
 *   placeMatch:object|null, placeId:string|null, placeSaid:boolean, placeTitle:string|null,
 *   placeAliasText:string|null, missing:string[], ambiguities:Array<{field, options, question, reason}>,
 *   notes:string[], confidence:'high'|'medium'|'low'}}
 *
 *   placeSaid       paikka sanottiin paikan sijassa ("Kampissa", "parturiin"): tunnistamattomana se
 *                   tallennetaan menon sijaintitekstiksi; otsikon sana ("parturi") ei ole sijainti
 *   placeTitle      otsikko, jos käyttäjä valitsee kysytyn paikan (sanottu paikka ei kuulu otsikkoon)
 *   placeAliasText  sana, jolla paikka löytyi ("parturiin" -> "parturi"): opitaan vasta hyväksynnästä
 *
 * "X tällä viikolla" ilman viikonpäivää ja kellonaikaa ei ole meno (null):
 * se on avoin asia, ks. parseOpenEndedTask.
 */
export function parseCreateEvent(text, options = {}) {
  const found = interpretCreateEvent(text, options);
  return found && !found.openTask ? found.event : null;
}

/**
 * "Minun pitää käydä Motonetissä tällä viikolla" -> avoin asia: tehtävä
 * ilman päivää, määräaikana viikon sunnuntai. Vain kun lauseessa on viikko
 * ilman viikonpäivää, kellonaikaa, koko päivää ja kalenterisanaa -- muuten
 * lause on meno (parseCreateEvent), ja viikon päivä kysytään vaihtoehtoina.
 * Tulos on EHDOTUS, jonka käyttäjä vahvistaa.
 *
 * @param {string} text
 * @param {{todayIso:string}} options
 * @returns {null | {intent:'create_open_task', title:string, deadline:string, weekStart:string, week:'this'|'next'}}
 */
export function parseOpenEndedTask(text, options = {}) {
  const found = interpretCreateEvent(text, options);
  return found && found.openTask ? found.openTask : null;
}

function interpretCreateEvent(text, options = {}) {
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

  // 3b. Kellonaika ilman klo-sanaa heti päivän perässä ("torstaina 14-15",
  //     "maanantaina 18", "perjantaina kaksitoista"), kun muuta aikaa ei ole.
  const spokenTimes = [];
  if (parsed.times.length === 0 && ranges.length === 0 && bareTimes.length === 0) {
    const spoken = spokenTimeAfterDate(temporalInput, parsed.dates, norm);
    if (spoken && spoken.range) ranges.push(spoken.range);
    else if (spoken) spokenTimes.push(spoken.entry);
  }

  const timeEntries = [...parsed.times, ...bareTimes, ...spokenTimes, ...ranges.map(range => range.startEntry)]
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
  // Avoimen asian otsikko on koko lause ilman ajankohtaa: paikka jää siihen
  // ("Käydä Motonetissä"), koska tehtävän paikka luetaan otsikosta.
  const taskTitleTokens = titleTokens;

  // 7. Paikka.
  const places = Array.isArray(opts.places) ? opts.places : [];
  const aliases = Array.isArray(opts.aliases) ? opts.aliases : [];
  const resolver = makeResolver(opts.resolvePlace, places, aliases);
  let placeText = null;
  let placeMatch = null;
  let placeTokens = [];
  let placeSaid = false;
  // Otsikon sana osui osittain tallennettuun paikkaan ("parturi" -> Parturi Kallio): ehdotetaan.
  let placeSuggested = false;

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
    // c) Otsikko itse on paikka ("Parturi") tai sisältää paikan ("hiustenleikkuu
    //    parturiin", "palaveri työpaikalla"). Järjestys: koko otsikko varmana,
    //    sana varmana, epävarma sija (sanottu paikka, kysytään), koko otsikko
    //    ehdotuksena, sana ehdotuksena. Koko otsikko ei koskaan ole sijainti,
    //    jos yksittäinen sana osuu: "palaveri työpaikalla" -> "työpaikalla".
    if (!placeMatch && titleTokens.length > 0) {
      const whole = titleTokens.map(token => token.text).join(' ');
      const wholeMatch = resolver(whole, 'title');
      let sure = null;
      let saidGuess = null;
      let titleGuess = null;
      for (const token of titleTokens.slice(0, 24)) {
        const locative = LOCATIVE_SUFFIX.test(token.text) && !DAY_PART_TOKENS.has(token.text);
        const candidate = bestMatch(resolver, stemCandidates(token.text), locative ? 'said' : 'title');
        if (rankMatch(candidate) === 3) {
          sure = { match: candidate, tokens: [token], locative };
          break;
        }
        if (rankMatch(candidate) === 2) {
          if (locative && !saidGuess) saidGuess = { match: candidate, tokens: [token], locative };
          if (!locative && !titleGuess) titleGuess = { match: candidate, tokens: [token], locative };
        }
      }
      const wholeFound = rankMatch(wholeMatch) >= 2 ? { match: wholeMatch, tokens: titleTokens, locative: false } : null;
      const chosen = (wholeFound && rankMatch(wholeMatch) === 3 ? wholeFound : null)
        || sure || saidGuess || wholeFound || titleGuess;
      if (chosen) {
        placeMatch = chosen.match;
        placeText = chosen.tokens.map(token => display.slice(token.start, token.end)).join(' ');
        if (chosen.locative) {
          // Sijamuoto on sanottu paikka: varmana se ei kuulu otsikkoon, epävarmana siitä kysytään.
          placeTokens = chosen.tokens;
          placeSaid = true;
        } else if (rankMatch(chosen.match) === 2) {
          // Otsikon sana jää otsikkoon; paikkaa vain ehdotetaan kysymyksellä.
          placeSuggested = true;
        }
      }
    }
  }

  // Varmasti tunnistettu paikka ei ole otsikkoa, jos otsikkoon jää muuta.
  // Tunnistamaton sija jää myös otsikkoon: "Liisalle" voi olla henkilö, ja
  // sanan pudottaminen otsikosta hukkaisi sen.
  if (placeTokens.length > 0 && rankMatch(placeMatch) === 3) {
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
  // Otsikko, jos käyttäjä valitsee kysytyn paikan: sanottu paikka ei silloin
  // kuulu otsikkoon ("Hiustenleikkuu parturiin" -> "Hiustenleikkuu").
  let placeTitle = title || null;
  if (placeMatch && placeMatch.status === 'ambiguous' && placeTokens.length > 0) {
    const rest = titleTokens.filter(token => !placeTokens.includes(token));
    if (rest.length > 0 && rest.length < titleTokens.length) placeTitle = titleText(rest, display);
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

  // 10. Sanottu paikka, jota ei tunnistettu varmasti: kysytään. Samoin
  //     otsikon sana, joka osuu tallennetun paikan nimen alkuun ("parturi"
  //     -> Parturi Kallio): ehdotetaan, ei liitetä hiljaa. Vahvistus opettaa
  //     nimityksen (confirmPlaceAlias), ja toistuvasti vahvistettu liitetään.
  if ((placeSaid || placeSuggested) && placeMatch && placeMatch.status === 'ambiguous' && placeMatch.candidates.length > 0) {
    const names = placeMatch.candidates.slice(0, 5).map(candidate => candidate.name).filter(Boolean);
    const question = names.length === 1 ? `Tarkoitatko paikkaa ${names[0]}?` : `Mikä paikka: ${joinOptions(names)}?`;
    ambiguities.push(freezeAmbiguity(EVENT_FIELD.PLACE, placeMatch.candidates.slice(0, 5).map(candidate => candidate.id),
      question, placeSaid ? 'ambiguous_place' : 'suggested_place'));
  }
  const placeId = placeMatch && rankMatch(placeMatch) === 3 ? placeMatch.placeId : null;

  const missing = [];
  if (!title) missing.push(EVENT_FIELD.TITLE);
  if (!date && !ambiguities.some(a => a.field === EVENT_FIELD.DATE)) missing.push(EVENT_FIELD.DATE);
  if (!time && !allDay && !ambiguities.some(a => a.field === EVENT_FIELD.TIME)) missing.push(EVENT_FIELD.TIME);

  let confidence = EVENT_PARSE_CONFIDENCE.MEDIUM;
  if (ambiguities.length > 0 || !title) confidence = EVENT_PARSE_CONFIDENCE.LOW;
  else if (hasVerb && date && (time || allDay)) confidence = EVENT_PARSE_CONFIDENCE.HIGH;

  const event = Object.freeze({
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
    placeSaid,
    placeTitle: placeTitle || null,
    placeAliasText: placeMatch && typeof placeMatch.query === 'string' ? placeMatch.query : null,
    missing: Object.freeze(missing),
    ambiguities: Object.freeze(ambiguities),
    notes: Object.freeze(notes),
    confidence
  });

  // 11. Pelkkä viikko ilman viikonpäivää, kellonaikaa, koko päivää ja
  //     kalenterisanaa: avoin asia, määräaikana viikon sunnuntai.
  const openTask = calendarWord || allDay || relativeTime || timeEntries.length > 0 || ranges.length > 0
    ? null
    : openTaskOf({ dates: parsed.dates, tokens, titleTokens: taskTitleTokens, display, todayIso });
  return { event, openTask };
}

/**
 * Avoin asia viikon ilmauksesta. Kaikkien päivien on oltava saman viikon
 * ilmauksia ("tällä viikolla", "tämän viikon aikana", "ensi viikolla").
 * "Ensi viikkoon mennessä" = ennen ensi viikkoa, eli tämän viikon sunnuntai.
 */
function openTaskOf({ dates, tokens, titleTokens, display, todayIso }) {
  if (dates.length === 0 || !dates.every(entry => entry.week && isIsoDate(entry.iso))) return null;
  const weekStarts = new Set(dates.map(entry => entry.iso));
  if (weekStarts.size !== 1) return null;
  const [entry] = dates;
  const next = tokens.find(token => token.start >= entry.end);
  const beforeWeek = /viikkoon$/u.test(entry.expr) && next && next.text === 'mennessä';
  const deadline = addDaysIso(entry.iso, beforeWeek ? -1 : 6);
  if (deadline < todayIso) return null;

  let lo = 0;
  let hi = titleTokens.length;
  while (lo < hi && (TASK_LEAD_FILLERS.has(titleTokens[lo].text) || EDGE_FILLERS.has(titleTokens[lo].text))) lo += 1;
  while (hi > lo && (TASK_TAIL_FILLERS.has(titleTokens[hi - 1].text) || EDGE_FILLERS.has(titleTokens[hi - 1].text))) hi -= 1;
  const title = titleText(titleTokens.slice(lo, hi), display);
  if (!title) return null;

  const thisMonday = addDaysIso(todayIso, -(weekdayOfIso(todayIso) - 1));
  const weekStart = addDaysIso(deadline, -(weekdayOfIso(deadline) - 1));
  return Object.freeze({
    intent: CREATE_OPEN_TASK_INTENT,
    title,
    deadline,
    weekStart,
    week: weekStart === thisMonday ? 'this' : 'next'
  });
}
