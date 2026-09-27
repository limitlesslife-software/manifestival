// Päivän keskeytykset puheesta: myöhästyminen, venyminen, ohitus ja loppujen siirto.
//
// PUHDAS MODUULI. Ei kelloa, ei verkkoa, ei satunnaisuutta, ei mallia.
// Sama lause tuottaa aina saman, jäädytetyn tuloksen.
//
// =====================================================================
// MIKSI PAIKALLISESTI
// =====================================================================
//
// "Olen 10 min myöhässä" sanotaan kiireessä, usein huonolla yhteydellä.
// Nämä lauseet ovat lyhyitä ja muodoltaan vakiintuneita, joten ne
// tunnistetaan ilman kielimallia. Tunnistus EI muuta mitään: se kertoo
// vain, mitä käyttäjä sanoi. Päivän muutosehdotus syntyy erikseen
// (dayReplan.js) ja vaatii aina käyttäjän vahvistuksen.
//
// VAROVAISUUS
//
// - Tuhoava lause ("poista loput", "peru lenkki") ei ole keskeytys:
//   tulos on null, eikä mitään poisteta tämän kautta koskaan.
// - Epämääräinen määrä ("olen vähän myöhässä", "pari minuuttia") jättää
//   minuutit tuntemattomiksi (null) -- kysytään, ei arvata.
// - Tunnistamaton lause on null: kutsuja voi antaa sen mallille.

import { parseFinnishDuration } from './fiDuration.js';
import { parseFinnishTemporal, DATE_ROLE } from './fiTemporal.js';
import { isIsoDate } from './task.js';

export const INTERRUPTION_KIND = Object.freeze({
  /** "Olen myöhässä", "olen 10 min myöhässä". */
  RUNNING_LATE: 'running_late',
  /** "Tämä työ kestää vielä 30 min". */
  EXTEND_CURRENT: 'extend_current',
  /** "En ehdi lenkille nyt", "jätän lenkin väliin". */
  SKIP_ITEM: 'skip_item',
  /** "Siirrä loput", "siirrä loput huomiselle". */
  DEFER_REMAINING: 'defer_remaining'
});

export const INTERRUPTION_KINDS = Object.freeze(Object.values(INTERRUPTION_KIND));

/** Pidempi teksti ei ole keskeytyslause (komentorivin raja on 300 merkkiä). */
export const MAX_INTERRUPTION_TEXT_LENGTH = 300;

// Sanaraja kirjaimille ja numeroille (\b ei tunne ä- ja ö-kirjaimia).
const L = '(?<![\\p{L}\\p{N}])';
const R = '(?![\\p{L}\\p{N}])';
const word = source => new RegExp(`${L}(?:${source})${R}`, 'u');

/** Tuhoavat ja peruvat verbit: niitä ei koskaan tulkita keskeytykseksi. */
const DESTRUCTIVE = word('poist\\p{L}*|peru|perua|peruu\\p{L}*|perut\\p{L}*|tyhjennä\\p{L}*|tyhjennet\\p{L}*|tuhoa\\p{L}*|kumoa\\p{L}*|pyyhi|pyyhitään|hävitä|delete|remove|cancel');
/**
 * Muistutuksen luonti ("muistuta, jos olen myöhässä") ja lauseen alun
 * luonti- tai näyttökomento ("lisää lenkki") eivät ole keskeytyksiä.
 * "Lisää" keskellä lausetta on määrä ("tarvitsen lisää aikaa").
 */
const OTHER_INTENT = new RegExp(`${word('muistuta|muistutus|muistuttaisitko').source}|^(?:lisää|luo|näytä|etsi|löydä|merkitse|kirjaa)${R}`, 'u');

const DEFER = new RegExp(
  `(?:^|\\s)(?:(?:voisitko\\s+|voitko\\s+)?(?:siirrä|siirra|siirretään|siirtää|lykkää|lykätään)\\s+)?(?:(?:kaikki|ne)\\s+)?`
  + `(?:loput|lopu[\\p{L}]*|jäljellä\\s+olevat|jäljellä\\s+oleva[\\p{L}]*|jäljelle\\s+jääneet)${R}(.*)$`, 'u');
const DEFER_VERB = word('siirrä|siirra|siirretään|siirtää|lykkää|lykätään');

const SKIP_PATTERNS = [
  new RegExp(`${L}en\\s+(?:taida\\s+|tänään\\s+|nyt\\s+)?(?:ehdi|ehdikään|kerkeä|kerkiä|kerkii|jaksa|pysty|pääse)${R}(.*)$`, 'u'),
  new RegExp(`${L}(?:jätä|jätän|jätetään|jätämme)\\s+(.+?)\\s+väliin${R}`, 'u'),
  new RegExp(`${L}(?:ohita|ohitan|ohitetaan|skippaa|skippaan|skipataan)\\s+(.+)$`, 'u'),
  new RegExp(`^(.+?)\\s+jää\\s+(?:tänään\\s+|nyt\\s+)?väliin${R}`, 'u')
];

const LATE = word('myöhässä|myöhästyn|myöhästyy|myöhästymässä|myöhästyt|myöhästyin|myöhästyimme|myöhästytään');
const BEHIND = new RegExp(`${L}(?:olen|oon|ollaan|olemme|olet)\\s+(?:[\\p{L}\\p{N},]+\\s+){0,3}?(?:jäljessä|perässä)${R}|${L}jäljessä\\s+aikataulusta${R}`, 'u');
/** "En ehdi ajoissa" on myöhästyminen, ei ohitus. */
const ON_TIME_WORDS = word('ajoissa|ajallaan|ajoiss');

const EXTEND_PATTERNS = [
  new RegExp(`${L}(?:kestää|kestänee|kestäisi|kestävät|vie|vievät|menee|jatkuu|jatkan|jatkamme|jatketaan|tarvitsen|tarvitaan|tarvitsee|tarvitsemme)\\s+(?:[\\p{L}\\p{N},]+\\s+){0,2}?vielä${R}`, 'u'),
  word('venyy|venyi|venyvät|venyivät|venähtää|venähti'),
  new RegExp(`${L}(?:kestää|kestävät|menee|vie)\\s+(?:vähän\\s+|hieman\\s+|vielä\\s+)?(?:pidempään|pitempään|kauemmin|kauemmin\\s+kuin)${R}`, 'u'),
  new RegExp(`^vielä\\s+(?=\\S)`, 'u')
];
const EXTEND_VERB = new RegExp(`${L}(?:kestää|kestänee|kestäisi|kestävät|vie|vievät|menee|jatkuu|jatkan|jatkamme|jatketaan|tarvitsen|tarvitaan|tarvitsee|tarvitsemme|venyy|venyi|venyvät|venyivät|venähtää|venähti|vielä)${R}`, 'u');

/** Kohteen ympäriltä pois jätettävät täytesanat. */
const FILLER = new Set([
  'nyt', 'tänään', 'tänä', 'päivänä', 'iltana', 'aamuna', 'enää', 'tällä', 'kertaa', 'kuitenkaan',
  'ollenkaan', 'taida', 'siis', 'sitten', 'kyllä', 'mitenkään', 'vielä', 'oikein', 'tämä', 'tää',
  'tämän', 'tätä', 'tuo', 'se', 'ja', 'mutta', 'että', 'koska', 'kun', 'minä', 'mä', 'mie', 'olen',
  'tehdä', 'käydä', 'mennä', 'lähteä', 'hoitaa', 'aloittaa', 'lähtemään', 'menemään', 'tekemään',
  'käymään', 'hoitamaan', 'ihan', 'vaan', 'vain', 'tähän', 'tuohon', 'siihen', 'tässä'
]);

const REFERENCE_TODAY = '2000-01-03';

/**
 * Mainitseeko lause poistamisen tai perumisen? Paikalliset jäsentimet
 * (keskeytykset, tapahtuman luonti) eivät koskaan tulkitse tällaista
 * lausetta: tuhoava toiminto kulkee aina oman, vahvistetun polkunsa kautta.
 */
export function mentionsDestructiveAction(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return DESTRUCTIVE.test(text.normalize('NFC').toLocaleLowerCase('fi'));
}

function normalizeText(text) {
  return text
    .normalize('NFC')
    .toLocaleLowerCase('fi')
    .replace(/[^\p{L}\p{N}.,:\s-]+/gu, ' ')
    .replace(/[.,:!?]+(?=\s|$)/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Poista päivä- ja aikailmaukset kohteesta. Palauttaa jäljelle jääneen
 * tekstin ja kohdepäivän (vain kun tämä päivä tiedetään).
 */
function stripTemporal(text, todayIso) {
  const reference = isIsoDate(todayIso) ? todayIso : REFERENCE_TODAY;
  const parsed = parseFinnishTemporal(text, reference);
  const spans = [...parsed.dates, ...parsed.times]
    .filter(entry => Number.isInteger(entry.start) && Number.isInteger(entry.end))
    .sort((a, b) => a.start - b.start);
  let rest = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    rest += text.slice(cursor, span.start) + ' ';
    cursor = span.end;
  }
  rest += text.slice(cursor);

  let date = null;
  if (isIsoDate(todayIso)) {
    const targets = parsed.dates.filter(entry => entry.role === DATE_ROLE.TARGET && !entry.week);
    const clear = [...new Set(targets.filter(entry => !entry.ambiguous).map(entry => entry.iso))];
    if (clear.length === 1 && !targets.some(entry => entry.ambiguous)) date = clear[0];
  }
  return { rest, date };
}

/** Täytesanoista siivottu kohde tai null. */
function cleanTarget(text) {
  const words = text.split(/\s+/).filter(Boolean);
  let start = 0;
  let end = words.length;
  while (start < end && FILLER.has(words[start])) start += 1;
  while (end > start && FILLER.has(words[end - 1])) end -= 1;
  const kept = words.slice(start, end).filter(w => !FILLER.has(w) || words.length <= 1);
  const target = kept.join(' ').replace(/^[-,.\s]+|[-,.\s]+$/g, '');
  return target ? target.slice(0, 80) : null;
}

function minutesOf(text) {
  const duration = parseFinnishDuration(text);
  return duration.ambiguous ? null : duration.minutes;
}

function result(kind, { minutes = null, targetText = null, toDate = null, onDate = null } = {}) {
  return Object.freeze({ kind, minutes, targetText, toDate, onDate });
}

/**
 * Tunnista keskeytyslause.
 *
 * @param {string} text
 * @param {{todayIso?: string}} [options]  tämä päivä: tarvitaan vain
 *        kohdepäivän ("huomiselle") ratkaisemiseen
 * @returns {null | {kind:string, minutes:number|null, targetText:string|null,
 *                   toDate:string|null, onDate:string|null}}
 *   toDate: loppujen siirron kohdepäivä, kun se sanottiin ja on tämän päivän jälkeen.
 *   onDate: ohituksen päivä, kun lause nimeää päivän ("en ehdi huomenna salille").
 */
export function parseInterruption(text, options = {}) {
  if (typeof text !== 'string') return null;
  const opts = options !== null && typeof options === 'object' ? options : {};
  const todayIso = isIsoDate(opts.todayIso) ? opts.todayIso : null;
  if (text.length > MAX_INTERRUPTION_TEXT_LENGTH * 2) return null;
  const s = normalizeText(text);
  if (!s || s.length > MAX_INTERRUPTION_TEXT_LENGTH) return null;
  if (DESTRUCTIVE.test(s) || OTHER_INTENT.test(s)) return null;

  // 1. Loppujen siirto: "siirrä loput (huomiselle)".
  const defer = DEFER.exec(s);
  if (defer && (DEFER_VERB.test(s) || /^(?:loput|jäljellä)/u.test(s))) {
    const { rest, date } = stripTemporal(defer[1], todayIso);
    const verbless = !DEFER_VERB.test(s);
    // Ilman verbiä ("loput huomenna") vaaditaan päivä, muuten lause on jotain muuta.
    if (!verbless || date) {
      const toDate = date && todayIso && date > todayIso ? date : null;
      const spoken = cleanTarget(defer[1].replace(/^\s*(?:tehtävät|asiat|jutut|päivän|tämän|päivän\s+tehtävät)(?=\s|$)/u, ''));
      const leftover = cleanTarget(rest.replace(/(?:^|\s)(?:tehtävät|asiat|jutut|päivän|tämän)(?=\s|$)/gu, ' '));
      if (!leftover) return result(INTERRUPTION_KIND.DEFER_REMAINING, { targetText: spoken, toDate });
    }
  }
  // Muu siirto ("siirrä palaveri", "siirrä myöhässä olevat") kuuluu muokkauskomennoille.
  if (DEFER_VERB.test(s)) return null;

  // 2. Ohitus: "en ehdi lenkille nyt", "jätän lenkin väliin".
  for (const pattern of SKIP_PATTERNS) {
    const match = pattern.exec(s);
    if (!match) continue;
    const raw = match[1] || '';
    if (ON_TIME_WORDS.test(raw) || LATE.test(raw)) break; // "en ehdi ajoissa" = myöhässä
    const { rest, date } = stripTemporal(raw, todayIso);
    const onDate = date && date !== todayIso ? date : null;
    return result(INTERRUPTION_KIND.SKIP_ITEM, { targetText: cleanTarget(rest), onDate });
  }

  // 3. Myöhästyminen: "olen (10 min) myöhässä".
  const notOnTime = ON_TIME_WORDS.test(s) && /(?:^|\s)en\s+(?:ehdi|kerkeä|kerkiä|pääse)(?=\s|$)/u.test(s);
  if (LATE.test(s) || BEHIND.test(s) || notOnTime) {
    const after = /(?:myöhässä|jäljessä|perässä)\s+([\p{L}-]+(?:sta|stä|lta|ltä))(?=\s|$)/u.exec(s);
    const target = after && !/^(?:aikataulusta|ajasta)$/u.test(after[1]) ? after[1] : null;
    return result(INTERRUPTION_KIND.RUNNING_LATE, { minutes: minutesOf(s), targetText: target });
  }

  // 4. Venyminen: "tämä työ kestää vielä 30 min".
  if (EXTEND_PATTERNS.some(pattern => pattern.test(s))) {
    const verb = EXTEND_VERB.exec(s);
    const before = verb ? s.slice(0, verb.index) : '';
    const { rest } = stripTemporal(before, todayIso);
    return result(INTERRUPTION_KIND.EXTEND_CURRENT, { minutes: minutesOf(s), targetText: cleanTarget(rest) });
  }

  return null;
}
