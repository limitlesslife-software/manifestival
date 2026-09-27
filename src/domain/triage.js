// Saapuvien erä-käsittely: deterministinen ehdotus siitä, mihin asia kuuluu.
//
// PUHDAS MODUULI. Ei DOM:ia, ei verkkoa, ei kelloa (tämä päivä annetaan),
// ei tekoälyä. Sama teksti, sama päivä ja samat alueet tuottavat aina saman
// ehdotuksen.
//
// =====================================================================
// MIKSI TÄMÄ ON OLEMASSA
// =====================================================================
//
// Brain dump kirjaa asiat ilman päätöksiä (docs/MENTAL-LOAD-CORE.md).
// Luokittelu tehdään myöhemmin erässä, ja jotta erä olisi kevyt, jokaisella
// rivillä on valmiina EHDOTUS: horisontti (tänään, tällä viikolla,
// myöhemmin, ei vielä, odottaa tai meno), elämänalue ja asian luonne.
//
// EHDOTUS EI OLE PÄÄTÖS. Mitään ei luoda ilman käyttäjän napautusta
// (src/app/capture.js triageInboxItems). Epäselvä rivi saa horisontiksi
// null: "Päätä myöhemmin". Jäsennin ei arvaa — se tunnistaa vain selvät
// suomenkieliset vihjeet:
//
//   odottaminen   "odotan Mikalta", "kun isännöitsijä vastaa",
//                 "Mikan vastausta"                         -> WAITING
//   epävarmuus    "joskus", "ehkä", "jos ehdin"              -> NOT_YET
//   päivä + kello "tiistaina klo 14"                         -> EVENT (meno)
//   päivä         "tänään" / tällä viikolla / myöhemmin      -> NOW / THIS_WEEK / LATER
//   viikko        "tällä viikolla" / "ensi viikolla"         -> THIS_WEEK / LATER
//   kategoria     lasku, sali, siivoa, palaveri ...          -> alue ja luonne
//
// Päivät ja kellonajat jäsentää sama deterministinen jäsennin kuin
// komentopalkki (src/domain/fiTemporal.js), ja menon otsikon sama
// jäsennin kuin paikallinen menon luonti (src/domain/eventParse.js).
//
// =====================================================================
// PÄIVÄTÖN SÄÄNTÖ
// =====================================================================
//
// planTriageDecision ei koskaan keksi päivää. Tällä viikolla, myöhemmin,
// ei vielä ja odottaa tallentuvat päivättöminä vain, kun kanta tukee sitä
// (migraatio 0015, `allowDateless`). Muuten asia JÄÄ Saapuviin ja
// käyttöliittymä kertoo miksi.

import { temporalHints, parseFinnishTemporal, addDaysIso, weekdayOfIso, DATE_ROLE } from './fiTemporal.js';
import { parseCreateEvent } from './eventParse.js';
import { TASK_HORIZON, isIsoDate, isTimeOfDay, MAX_TITLE_LENGTH, MAX_WAITING_ON_LENGTH } from './task.js';
import { deriveNature, natureLabel } from './itemNature.js';
import { categoryOwnerArea, activeLifeAreas, areaNameKey, countOf } from './lifeArea.js';
import { categoryLabel, isCategory, DEFAULT_CATEGORY } from './categories.js';
import { shortDateLabel } from './calendar.js';

/** Ehdotuksen horisontti, kun asia on meno (kalenteriin), ei tehtävä. */
export const TRIAGE_EVENT = 'EVENT';

/** Erän päätökset (painikkeet Saapuvissa). */
export const TRIAGE_DECISION = Object.freeze({
  NOW: 'NOW',
  THIS_WEEK: 'THIS_WEEK',
  LATER: 'LATER',
  NOT_YET: 'NOT_YET',
  WAITING: 'WAITING',
  EVENT: 'EVENT',
  DISMISS: 'DISMISS'
});
export const TRIAGE_DECISIONS = Object.freeze(Object.values(TRIAGE_DECISION));

const DECISION_LABELS = Object.freeze({
  [TRIAGE_DECISION.NOW]: 'Tänään',
  [TRIAGE_DECISION.THIS_WEEK]: 'Tällä viikolla',
  [TRIAGE_DECISION.LATER]: 'Myöhemmin',
  [TRIAGE_DECISION.NOT_YET]: 'Ei vielä',
  [TRIAGE_DECISION.WAITING]: 'Odottaa',
  [TRIAGE_DECISION.EVENT]: 'Menoksi',
  [TRIAGE_DECISION.DISMISS]: 'Hylkää'
});

export function triageDecisionLabel(decision) {
  return DECISION_LABELS[decision] || '';
}

/** Miksi asia jäi Saapuviin. */
export const TRIAGE_KEEP_REASON = Object.freeze({
  /** Päivätön tallennus vaatii migraation 0015. */
  DATELESS_GATE: 'dateless_gate',
  /** Menolla on oltava päivä. */
  NO_DATE: 'no_date'
});

/** Päivättömän tallennuksen rehellinen selitys (portti kiinni). */
export const DATELESS_GATE_HINT = 'Päivätön tallennus tulee käyttöön, kun palvelin on päivitetty (migraatio 0015).';

const HORIZON_LABELS = Object.freeze({
  [TASK_HORIZON.NOW]: 'Tänään',
  [TASK_HORIZON.THIS_WEEK]: 'Tällä viikolla',
  [TASK_HORIZON.LATER]: 'Myöhemmin',
  [TASK_HORIZON.NOT_YET]: 'Ei vielä',
  [TASK_HORIZON.WAITING]: 'Odottaa',
  [TRIAGE_EVENT]: 'Meno'
});

/** Lyhyt nimi ehdotuksen horisontille. null -> "Päätä myöhemmin". */
export function triageHorizonLabel(horizon) {
  return HORIZON_LABELS[horizon] || 'Päätä myöhemmin';
}

// =====================================================================
// SANASTOT
// =====================================================================

const L = '\\p{L}\\p{N}';
const NOT_BEFORE = `(?<![${L}])`;
const NOT_AFTER = `(?![${L}])`;

function cue(words) {
  return new RegExp(`${NOT_BEFORE}(?:${words.join('|')})${NOT_AFTER}`, 'u');
}

/** Tallessa, ei tekeillä: käyttäjä itse epäröi. */
const NOT_YET_CUE = cue(['joskus', 'ehkä', 'jos ehdin', 'kun ehdin', 'jos jaksan', 'jossain vaiheessa',
  'joku päivä', 'jonain päivänä', 'mahdollisesti']);
/** Ei tällä viikolla, mutta ei unohdeta. */
const LATER_CUE = cue(['myöhemmin', 'ei kiire', 'ei kiirettä', 'ensi kuussa', 'ensi vuonna', 'kesällä',
  'syksyllä', 'talvella', 'keväällä']);
/** Käyttäjä sanoi, että asia on kiireellinen. */
const NOW_CUE = cue(['heti', 'kiire', 'kiireellinen', 'kiireesti', 'asap', 'pikaisesti']);

/** Yleinen odottamisen vihje ilman tietoa siitä, kenen varassa asia on. */
// 'odottaa' (hän/se odottaa) puuttuu tarkoituksella: "paketti odottaa noutoa" on käyttäjän oma asia.
const WAITING_CUE = cue(['odotan', 'odotetaan', 'odotamme', 'odottelen', 'odotellaan']);

/** "Kun X vastaa": X on perusmuodossa, joten se kelpaa sellaisenaan. */
const WHEN_REPLIES = new RegExp(
  `${NOT_BEFORE}kun\\s+([${L}][${L}:.-]*)\\s+(?:vastaa|vastaavat|soittaa|ilmoittaa|kuittaa|päättää|lähettää|`
  + `palauttaa|hyväksyy|kertoo|vahvistaa|palaa)${NOT_AFTER}`, 'u');

/** "Odotan Mikalta", "odotan vastausta HSY:ltä". */
const WAIT_FROM = new RegExp(
  `${NOT_BEFORE}odot(?:an|amme|etaan|tan|tan|telen)\\s+(?:[${L}]+\\s+)?([${L}][${L}-]*?)(:lta|:ltä|lta|ltä)${NOT_AFTER}`, 'u');

/** "Mikan vastausta", "HSY:n päätöstä": omistaja + odotettava asia. */
const AWAITED_NOUNS = Object.freeze([
  ['vastau', 'vastaus'], ['vastaus', 'vastaus'], ['päätö', 'päätös'], ['päätös', 'päätös'],
  ['kuittau', 'kuittaus'], ['hyväksyn', 'hyväksyntä'], ['palaut', 'palaute'], ['tarjou', 'tarjous'],
  ['soitto', 'soitto'], ['soittoa', 'soitto'], ['viest', 'viesti'], ['arvio', 'arvio'], ['lausun', 'lausunto']
]);
const GENITIVE_AWAITED = new RegExp(
  `${NOT_BEFORE}([${L}][${L}-]*?)(:n|n)\\s+(${AWAITED_NOUNS.map(([stem]) => stem).join('|')})[${L}]*`, 'gu');
/** Genetiiviltä näyttävät sanat, jotka eivät ole odotuksen kohde ("odotan vastausta"). */
const NOT_OWNERS = new Set(['odota', 'ole', 'saa', 'minu', 'sinu', 'häne', 'meidä', 'teidä', 'heidä', 'ku',
  'enne', 'jälkee', 'vielä', 'tämä', 'tuo', 'se', 'sen', 'sie']);

/**
 * Kategoriavihjeet. `prefix`: sana alkaa tällä (taivutus: "salille").
 * Viisi merkkiä tai pidempi osuu myös yhdyssanan sisään ("sähkölasku").
 * `exact`: lyhyt sana, jonka pitää olla kokonaan sama ("uni").
 */
const CATEGORY_CUES = Object.freeze([
  ['talous', {
    prefix: ['lasku', 'maksa', 'maksu', 'vero', 'vakuutu', 'vuokra', 'pank', 'budjet', 'tilisiir', 'eräpäiv',
      'laina', 'säästö', 'osake', 'sijoitu', 'raha', 'kuitti', 'kela'],
    exact: []
  }],
  ['tyo', {
    prefix: ['työ', 'palaver', 'kokou', 'raport', 'asiak', 'esimie', 'sähköpost', 'tarjou', 'esity', 'esitel',
      'deadlin', 'kolleg', 'projekt', 'toimist', 'haastattel'],
    exact: ['pomo', 'pomolle', 'pomon']
  }],
  ['hyvinvointi', {
    prefix: ['sali', 'kuntosal', 'lenk', 'juoks', 'nukku', 'jooga', 'venyt', 'lääkär', 'tervey', 'medit',
      'liikun', 'uinti', 'uima', 'kävel', 'pyöräil', 'treen', 'hieron', 'fysio', 'terap', 'ulkoil', 'hammas'],
    exact: ['uni', 'unta', 'unen', 'unet', 'unille']
  }],
  ['koti', {
    prefix: ['siivo', 'imur', 'pyyk', 'tisk', 'kaupp', 'kaupa', 'ruokaost', 'osta', 'osto', 'korja', 'remont',
      'rosk', 'lakan', 'pöly', 'ikkun', 'kastel', 'kokkaa', 'leivo', 'astianpes', 'jääkaap', 'katsastu', 'auto',
      'rengas', 'renkaa', 'huolt'],
    exact: []
  }],
  ['perhe', {
    prefix: ['äiti', 'äidi', 'lapse', 'lapsi', 'lasten', 'mummo', 'mummi', 'mummu', 'vaari', 'pappa', 'ukki',
      'perhe', 'synttär', 'sisko', 'velje', 'puoliso', 'vaimo', 'anopp', 'päiväkot', 'vanhempai'],
    exact: ['isä', 'isälle', 'isän', 'isää', 'iskä', 'veli']
  }],
  ['harrastus', {
    prefix: ['kitar', 'piano', 'maalau', 'valokuv', 'kuoro', 'harrast', 'bändi', 'neulo', 'virkka', 'lautapel',
      'kalast', 'golf', 'sulkis', 'tanss', 'laulu', 'laula', 'leffa', 'teatt', 'konsert', 'museo', 'piirt', 'ompel'],
    exact: []
  }],
  ['kehitys', {
    prefix: ['kurss', 'opiskel', 'tentt', 'opetel', 'webinaar', 'luent', 'kielikurs'],
    exact: ['opi', 'opin']
  }]
]);

function tokensOf(lower) {
  return lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function stemHits(token, { prefix, exact }) {
  if (exact.includes(token)) return exact.find(word => word === token);
  for (const stem of prefix) {
    if (token.startsWith(stem)) return stem;
    if (stem.length >= 5 && token.includes(stem)) return stem;
  }
  return null;
}

/**
 * Kategoria sanoista. Eniten osumia voittaa; tasatilanteessa luettelon
 * järjestys (velvoitteet ensin), jotta tulos on deterministinen.
 * @returns {{categoryKey:string, word:string}|null}
 */
export function categoryFromText(text) {
  const tokens = tokensOf(String(text ?? '').normalize('NFC').toLocaleLowerCase('fi'));
  let best = null;
  for (const [categoryKey, cues] of CATEGORY_CUES) {
    let hits = 0;
    let word = null;
    for (const token of tokens) {
      const stem = stemHits(token, cues);
      if (stem) {
        hits += 1;
        if (!word) word = token;
      }
    }
    if (hits > 0 && (!best || hits > best.hits)) best = { categoryKey, word, hits };
  }
  return best ? { categoryKey: best.categoryKey, word: best.word } : null;
}

// =====================================================================
// ODOTTAMINEN
// =====================================================================

function clipWaitingOn(value) {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, MAX_WAITING_ON_LENGTH) : null;
}

/**
 * Onko asia toisen varassa, ja kenen?
 * @returns {{waiting:boolean, waitingOn:string|null}}
 */
export function waitingFromText(text) {
  const original = String(text ?? '').normalize('NFC');
  const lower = original.toLocaleLowerCase('fi');
  // Kohdat vastaavat toisiaan vain, jos pienaakkostus ei muuttanut pituutta.
  const source = lower.length === original.length ? original : lower;
  const pick = (match, group) => {
    const start = match.index + match[0].indexOf(match[group]);
    return source.slice(start, start + match[group].length);
  };

  const when = WHEN_REPLIES.exec(lower);
  if (when) return { waiting: true, waitingOn: clipWaitingOn(pick(when, 1)) };

  const owner = [...lower.matchAll(GENITIVE_AWAITED)].find(match => !NOT_OWNERS.has(match[1]));
  if (owner) {
    const noun = AWAITED_NOUNS.find(([stem]) => stem === owner[3]);
    const who = pick(owner, 1) + owner[2];
    return { waiting: true, waitingOn: clipWaitingOn(`${who} ${noun ? noun[1] : owner[3]}`) };
  }

  const from = WAIT_FROM.exec(lower);
  if (from) {
    const word = pick(from, 1);
    const suffix = from[2];
    // "HSY:ltä" -> "HSY". Muuten sana jää taivutettuna ("Pekalta"):
    // perusmuotoa ei voi päätellä luotettavasti astevaihtelun takia
    // (Pekka -> Pekalta, Matti -> Matilta), eikä väärä nimi ole ehdotus.
    const who = suffix.startsWith(':') ? word : word + suffix;
    return { waiting: true, waitingOn: clipWaitingOn(who) };
  }

  if (WAITING_CUE.test(lower)) return { waiting: true, waitingOn: null };
  return { waiting: false, waitingOn: null };
}

// =====================================================================
// OTSIKKO
// =====================================================================

function capitalize(text) {
  return text ? text.charAt(0).toLocaleUpperCase('fi') + text.slice(1) : text;
}

/**
 * Otsikko ilman jäsennettyjä päivä- ja kellonaikailmauksia: "Osta maito
 * huomenna" -> "Osta maito", kun päivä tallentuu omaan kenttäänsä. Jos
 * jäljelle ei jää sanaa, alkuperäinen teksti säilyy.
 */
function titleWithout(text, spans) {
  const original = String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (spans.length === 0) return original;
  const lower = original.toLocaleLowerCase('fi');
  if (lower.length !== original.length) return original;
  let out = '';
  let cursor = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    if (span.start < cursor) continue;
    out += original.slice(cursor, span.start);
    cursor = span.end;
  }
  out += original.slice(cursor);
  const cleaned = out
    .replace(new RegExp(`${NOT_BEFORE}(?:klo|kello)${NOT_AFTER}`, 'giu'), ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;:–-]+|[\s,;:–-]+$/g, '')
    .trim();
  return /[\p{L}\p{N}]/u.test(cleaned) ? capitalize(cleaned) : original;
}

// =====================================================================
// EHDOTUS
// =====================================================================

const INACTIVE_GOAL = new Set(['paused', 'completed', 'abandoned', 'archived']);

function goalFromText(lower, goals) {
  for (const goal of Array.isArray(goals) ? goals : []) {
    if (!goal || !goal.id || INACTIVE_GOAL.has(goal.status)) continue;
    const title = String(goal.title ?? '').normalize('NFC').trim().toLocaleLowerCase('fi');
    if (title.length >= 4 && lower.includes(title)) return goal;
  }
  return null;
}

function areaFromName(lower, areas) {
  const tokens = tokensOf(lower);
  for (const area of activeLifeAreas(areas)) {
    const key = areaNameKey(area.name);
    if (key.length < 4 || /\s/.test(key)) continue;
    if (tokens.some(token => token.startsWith(key))) return area;
  }
  return null;
}

function mondayOf(iso) {
  return addDaysIso(iso, -(weekdayOfIso(iso) - 1));
}

/**
 * Deterministinen ehdotus saapuvalle riville.
 *
 * @param {string} text  käyttäjän kirjaama rivi
 * @param {object} [context]
 * @param {Array}  [context.areas]    elämänalueet (normalisoidut)
 * @param {string} [context.todayIso] tämä päivä (YYYY-MM-DD); ilman sitä päiviä ei jäsennetä
 * @param {Array}  [context.goals]    tavoitteet (otsikon osuma -> tavoitteen askel)
 * @returns {{horizon:string|null, date:string|null, time:string|null, followUpDate:string|null,
 *   waitingOn:string|null, categoryKey:string|null, areaId:string|null, goalId:string|null,
 *   nature:string, natureReason:string, title:string, reasons:string[]}}
 */
export function proposeTriage(text, { areas = [], todayIso = null, goals = [] } = {}) {
  const original = String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const lower = original.toLocaleLowerCase('fi');
  const reasons = [];
  const today = isIsoDate(todayIso) ? todayIso : null;

  // --- päivä ja kellonaika (sama jäsennin kuin komentopalkissa)
  let date = null;
  let time = null;
  let week = null;
  let spans = [];
  if (today && original) {
    const hints = temporalHints(original, today);
    const parsed = parseFinnishTemporal(original, today);
    date = isIsoDate(hints.date) ? hints.date : null;
    time = isTimeOfDay(hints.time) ? hints.time : null;
    const weekEntry = parsed.dates.find(entry => entry.week && entry.role === DATE_ROLE.TARGET && !entry.ambiguous);
    if (!date && weekEntry) week = weekEntry.iso === mondayOf(today) ? 'this' : 'next';
    const used = [
      ...(date ? parsed.dates.filter(entry => entry.iso === date) : []),
      ...(week ? [weekEntry] : []),
      // Kellonaika tallentuu vain päivän kanssa; ilman päivää se jää otsikkoon.
      ...(time && date ? parsed.times.filter(entry => entry.time === time) : [])
    ];
    spans = used.filter(entry => Number.isInteger(entry.start) && Number.isInteger(entry.end));
  }

  // --- horisontti: odottaminen > epäröinti > meno > päivä > viikko > sanat
  let horizon = null;
  let waitingOn = null;
  let followUpDate = null;
  const waiting = waitingFromText(original);
  if (waiting.waiting) {
    horizon = TASK_HORIZON.WAITING;
    waitingOn = waiting.waitingOn;
    reasons.push(waitingOn ? `Odottaa: ${waitingOn}` : 'Odottaa jotakuta');
    if (date) followUpDate = date;
  } else if (NOT_YET_CUE.test(lower)) {
    horizon = TASK_HORIZON.NOT_YET;
    reasons.push('Epävarma: "ei vielä"');
  } else if (date && time) {
    horizon = TRIAGE_EVENT;
    reasons.push(`Päivä ja kellonaika: ${shortDateLabel(date)} klo ${time}`);
  } else if (date) {
    const weekEnd = addDaysIso(today, 7 - weekdayOfIso(today));
    if (date <= today) horizon = TASK_HORIZON.NOW;
    else if (date <= weekEnd) horizon = TASK_HORIZON.THIS_WEEK;
    else horizon = TASK_HORIZON.LATER;
    reasons.push(`Päivä: ${shortDateLabel(date)}`);
  } else if (week) {
    horizon = week === 'this' ? TASK_HORIZON.THIS_WEEK : TASK_HORIZON.LATER;
    reasons.push(week === 'this' ? 'Tällä viikolla' : 'Ensi viikolla');
  } else if (LATER_CUE.test(lower)) {
    horizon = TASK_HORIZON.LATER;
    reasons.push('Ei kiirettä');
  } else if (NOW_CUE.test(lower)) {
    horizon = TASK_HORIZON.NOW;
    reasons.push('Kiireellinen');
  }
  if (time && !date) reasons.push(`Kellonaika ${time} ilman päivää`);
  if (horizon === null) reasons.push('Päätä myöhemmin');

  // --- alue, kategoria ja tavoite
  const activeAreas = activeLifeAreas(Array.isArray(areas) ? areas : []);
  const category = categoryFromText(original);
  let categoryKey = category ? category.categoryKey : null;
  let area = categoryKey ? categoryOwnerArea(activeAreas, categoryKey) : null;
  if (category) reasons.push(`Sana "${category.word}": ${categoryLabel(categoryKey)}`);
  if (!area) {
    const named = areaFromName(lower, activeAreas);
    if (named) {
      area = named;
      if (!categoryKey && isCategory(named.categoryKey)) categoryKey = named.categoryKey;
      reasons.push(`Alue: ${named.name}`);
    }
  }
  const goal = goalFromText(lower, goals);
  if (goal) reasons.push(`Tavoite: ${goal.title}`);

  const { nature, reason: natureReason } = deriveNature(
    { category: categoryKey || DEFAULT_CATEGORY, goalId: goal ? goal.id : null },
    { kind: 'task', area });

  // --- otsikko: menolle sama otsikko kuin paikallisessa menon luonnissa
  let title = titleWithout(original, spans);
  if (horizon === TRIAGE_EVENT && today) {
    const event = safeEvent(original, today);
    if (event && event.title) title = event.title;
  }

  return {
    horizon,
    date,
    time,
    followUpDate,
    waitingOn,
    categoryKey,
    areaId: area ? area.id : null,
    goalId: goal ? goal.id : null,
    nature,
    natureReason,
    title: title.slice(0, MAX_TITLE_LENGTH),
    reasons
  };
}

function safeEvent(text, todayIso) {
  try {
    return parseCreateEvent(text, { todayIso });
  } catch {
    return null;
  }
}

/**
 * Ehdotus yhtenä lyhyenä rivinä: "Ehdotus: Tällä viikolla · Koti · Arjen ylläpito".
 */
export function triageSummary(proposal, { areas = [] } = {}) {
  if (!proposal) return '';
  let when = triageHorizonLabel(proposal.horizon);
  if (proposal.horizon === TRIAGE_EVENT && proposal.date) {
    when = `Meno ${shortDateLabel(proposal.date)}${proposal.time ? ` klo ${proposal.time}` : ''}`;
  } else if (proposal.horizon === TASK_HORIZON.WAITING && proposal.waitingOn) {
    when = `Odottaa: ${proposal.waitingOn}`;
  } else if (proposal.date && proposal.horizon !== TASK_HORIZON.NOW) {
    when = `${when} (${shortDateLabel(proposal.date)})`;
  }
  const area = proposal.areaId ? (areas || []).find(entry => entry && entry.id === proposal.areaId) : null;
  const where = area ? area.name
    : (proposal.categoryKey && proposal.categoryKey !== DEFAULT_CATEGORY ? categoryLabel(proposal.categoryKey) : null);
  // Sama sana kahdesti (alue Hyvinvointi, luonne Hyvinvointi) ei kerro mitään lisää.
  const nature = natureLabel(proposal.nature);
  return ['Ehdotus: ' + when, where, nature && nature !== where ? nature : null].filter(Boolean).join(' · ');
}

// =====================================================================
// PÄÄTÖS -> DOMAIN-RIVI
// =====================================================================

/**
 * Mitä erän päätös tekisi tälle riville. EI KUTSU MITÄÄN: sovelluskerros
 * (src/app/capture.js triageInboxItems) toteuttaa tuloksen vasta
 * käyttäjän napautuksesta.
 *
 * @param {string} text  saapuvan rivin teksti
 * @param {string} decision TRIAGE_DECISION
 * @param {object} options
 * @param {object} options.proposal       proposeTriage()-tulos
 * @param {string|null} [options.areaId]  käyttäjän valitsema alue (undefined = ehdotus)
 * @param {Array}  [options.areas]
 * @param {string} options.todayIso
 * @param {boolean} options.allowDateless  datelessTasksAllowed() (migraatio 0015)
 * @param {string|null} [options.waitingOn] käyttäjän antama "kenen varassa"
 * @returns {{action:'task'|'event'|'dismiss'|'keep', payload?:object, reason?:string}}
 */
export function planTriageDecision(text, decision, {
  proposal = null, areaId, areas = [], todayIso = null, allowDateless = false, waitingOn = null
} = {}) {
  if (decision === TRIAGE_DECISION.DISMISS) return { action: 'dismiss' };
  if (!TRIAGE_DECISIONS.includes(decision)) return { action: 'keep', reason: 'unknown' };

  const found = proposal || proposeTriage(text, { areas, todayIso });
  const title = (found.title || String(text ?? '').trim()).slice(0, MAX_TITLE_LENGTH);

  // Käyttäjän valitsema alue ratkaisee kategorian (tehtävä kytkeytyy
  // alueeseen kategorian kautta). Ilman valintaa: ehdotuksen kategoria.
  const chosenId = areaId === undefined ? found.areaId : areaId;
  const chosen = chosenId ? (areas || []).find(area => area && area.id === chosenId) : null;
  const category = chosen
    ? (isCategory(chosen.categoryKey) ? chosen.categoryKey : DEFAULT_CATEGORY)
    : (isCategory(found.categoryKey) ? found.categoryKey : DEFAULT_CATEGORY);
  const base = { title, category, ...(found.goalId ? { goalId: found.goalId } : {}) };

  if (decision === TRIAGE_DECISION.EVENT) {
    if (!isIsoDate(found.date)) return { action: 'keep', reason: TRIAGE_KEEP_REASON.NO_DATE };
    const timed = isTimeOfDay(found.time);
    return {
      action: 'event',
      payload: {
        title,
        date: found.date,
        startTime: timed ? found.time : null,
        endTime: null,
        allDay: !timed,
        ...(found.goalId ? { goalId: found.goalId } : {})
      }
    };
  }

  if (decision === TRIAGE_DECISION.NOW) {
    if (!isIsoDate(todayIso)) return { action: 'keep', reason: 'unknown' };
    // Tänään = päivä tänään. Horisontti johdetaan päivästä (lifeLoad),
    // eikä erä pinnaa kymmentä asiaa kerralla fokukseen.
    const keepsTime = found.date === todayIso && isTimeOfDay(found.time);
    return { action: 'task', payload: { ...base, date: todayIso, time: keepsTime ? found.time : null } };
  }

  // Tällä viikolla, myöhemmin, ei vielä ja odottaa: EI KEKSITTYÄ PÄIVÄÄ.
  if (!allowDateless) return { action: 'keep', reason: TRIAGE_KEEP_REASON.DATELESS_GATE };

  if (decision === TRIAGE_DECISION.WAITING) {
    const who = clipWaitingOn(waitingOn) || found.waitingOn || null;
    return {
      action: 'task',
      payload: {
        ...base, date: null, time: null, horizon: TASK_HORIZON.WAITING, waitingOn: who,
        ...(isIsoDate(found.followUpDate) ? { followUpDate: found.followUpDate } : {})
      }
    };
  }
  return { action: 'task', payload: { ...base, date: null, time: null, horizon: decision } };
}

// =====================================================================
// LOPPUTULOS SANOIKSI
// =====================================================================

/**
 * Erän lopputulos yhtenä rauhallisena viestinä tilariville.
 *
 * @param {{decision:string, converted?:Array, kept?:Array, failed?:Array, dismissed?:number}} outcome
 */
export function describeTriageOutcome({ decision, converted = [], kept = [], failed = [], dismissed = 0 } = {}) {
  const parts = [];
  if (converted.length > 0) {
    parts.push(decision === TRIAGE_DECISION.EVENT
      ? `Lisätty kalenteriin: ${countOf(converted.length, 'meno', 'menoa')}.`
      : `Siirretty ${countOf(converted.length, 'asia', 'asiaa')}: ${triageDecisionLabel(decision)}.`);
  }
  const unmarked = converted.filter(entry => entry && entry.markFailed).length;
  if (unmarked > 0) {
    parts.push(`${unmarked === 1 ? 'Yksi rivi' : `${unmarked} riviä`} jäi Saapuviin merkitsemättä käsitellyksi. `
      + 'Voit hylätä sen, kun olet tarkistanut, että asia on tallessa.');
  }
  if (dismissed > 0) {
    parts.push(`Hylätty ${countOf(dismissed, 'asia', 'asiaa')}. Voit palauttaa ne käsitellyistä.`);
  }
  const gate = kept.filter(entry => entry.reason === TRIAGE_KEEP_REASON.DATELESS_GATE).length;
  if (gate > 0) {
    parts.push(`${DATELESS_GATE_HINT} ${gate === 1 ? 'Asia on' : 'Asiat ovat'} tallessa Saapuvissa.`);
  }
  const noDate = kept.filter(entry => entry.reason === TRIAGE_KEEP_REASON.NO_DATE).length;
  if (noDate > 0) {
    parts.push(`Menoksi sopii vain asia, jolla on päivä. ${countOf(noDate, 'asia', 'asiaa')} jäi Saapuviin.`);
  }
  if (failed.length > 0) {
    parts.push(`${countOf(failed.length, 'asia', 'asiaa')} ei tallentunut. ${failed.length === 1 ? 'Se on' : 'Ne ovat'} yhä Saapuvissa.`);
  }
  return parts.join(' ');
}
