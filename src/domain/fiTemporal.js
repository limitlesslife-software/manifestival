// Suomenkielisten päivä- ja kellonaikailmaisujen deterministinen jäsennin.
//
// PUHDAS MODUULI. Ei kelloa (tämä päivä annetaan), ei verkkoa, ei
// satunnaisuutta, ei mallia. Sama teksti ja sama päivä tuottavat aina
// saman tuloksen.
//
// =====================================================================
// MIKSI TÄMÄ ON OLEMASSA
// =====================================================================
//
// Komennon luokittelee kielimalli (api/command.js), ja malli erehtyy
// päivämäärissä: "huomenna" voi tulla väärälle päivälle, "puoli
// yhdeksältä" voi tulla 09:30:ksi (englannin "half nine" -harha:
// suomessa se on 08:30). Nämä ovat juuri niitä virheitä, jotka
// luottamus rikkoutuu.
//
// Tämä jäsennin tunnistaa vain SELVÄT ilmaisut ja kertoo, milloin
// ilmaisu on EPÄSELVÄ (sama viikonpäivä kuin tänään, 1-6 ilman
// vuorokaudenaikaa, "viikonloppuna"). Epäselvässä tapauksessa se ei
// väitä mitään -- mallin vastaus jää ennalleen ja käyttäjä näkee sen
// vahvistuksessa. Jäsennin ei koskaan arvaa.
//
// Käyttö: src/app/commandBar.js vertaa mallin päivää ja kelloa tähän ja
// korjaa vain silloin, kun jäsennin on yksiselitteinen.
//
// KAAVA: viikko alkaa maanantaista (ISO), laskenta on UTC-kalenteria,
// joten kesäajan vaihtopäivät eivät vaikuta.

import { isIsoDate } from './task.js';

export const WEEKDAY_NUMBER = Object.freeze({
  maanantai: 1, tiistai: 2, keskiviikko: 3, torstai: 4, perjantai: 5, lauantai: 6, sunnuntai: 7
});

/** Tunnus, jolla ilmaisu viittaa: kohde ("huomenna", "perjantaille") vai olemassa oleva ("huomiselta", "perjantain"). */
export const DATE_ROLE = Object.freeze({ TARGET: 'target', REFERENCE: 'ref' });

// ---------------------------------------------------------- kalenteri

function dayNumber(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return Math.round(date.getTime() / 86400000);
}

function isoFromDayNumber(number) {
  const date = new Date(number * 86400000);
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function addDaysIso(iso, days) {
  return isoFromDayNumber(dayNumber(iso) + days);
}

/** ISO-viikonpäivä: 1 = maanantai ... 7 = sunnuntai. */
export function weekdayOfIso(iso) {
  return ((dayNumber(iso) % 7) + 7 + 3) % 7 + 1;
}

function mondayOf(iso) {
  return addDaysIso(iso, -(weekdayOfIso(iso) - 1));
}

function lastDayOfMonth(iso) {
  const [year, month] = iso.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0); // 0. päivä = edellisen kuun viimeinen
  return isoFromDayNumber(Math.round(date.getTime() / 86400000));
}

// ------------------------------------------------------------- luvut

/** Tuntien nimet: perusmuodot ja taivutukset, joita puhutussa kellonajassa esiintyy. */
const HOUR_FORMS = Object.freeze({
  1: ['yksi', 'yhden', 'yhdeltä', 'yhteen', 'yhdeksi'],
  2: ['kaksi', 'kahden', 'kahdelta', 'kahteen', 'kahdeksi'],
  3: ['kolme', 'kolmen', 'kolmelta', 'kolmeen', 'kolmeksi'],
  4: ['neljä', 'neljän', 'neljältä', 'neljään', 'neljäksi'],
  5: ['viisi', 'viiden', 'viideltä', 'viiteen', 'viideksi'],
  6: ['kuusi', 'kuuden', 'kuudelta', 'kuuteen', 'kuudeksi'],
  7: ['seitsemän', 'seitsemältä', 'seitsemään', 'seitsemäksi'],
  8: ['kahdeksan', 'kahdeksalta', 'kahdeksaan', 'kahdeksaksi'],
  9: ['yhdeksän', 'yhdeksältä', 'yhdeksään', 'yhdeksäksi'],
  10: ['kymmenen', 'kymmeneltä', 'kymmeneen', 'kymmeneksi'],
  11: ['yksitoista', 'yhdentoista', 'yhdeltätoista', 'yhteentoista', 'yhdeksitoista'],
  12: ['kaksitoista', 'kahdentoista', 'kahdeltatoista', 'kahteentoista', 'kahdeksitoista']
});

const HOUR_LOOKUP = new Map();
for (const [hour, forms] of Object.entries(HOUR_FORMS)) {
  for (const form of forms) HOUR_LOOKUP.set(form, Number(hour));
}
// Pisimmät ensin: "yksitoista" ennen "yksi".
const HOUR_WORDS = [...HOUR_LOOKUP.keys()].sort((a, b) => b.length - a.length).join('|');
const HOUR_TOKEN = `(\\d{1,2}|${HOUR_WORDS})`;

function hourFromToken(token) {
  if (/^\d+$/.test(token)) return Number(token);
  return HOUR_LOOKUP.get(token) ?? null;
}

const MINUTE_OFFSET = Object.freeze({
  varttia: 15, vartin: 15, viittä: 5, viiden: 5, kymmentä: 10, kymmenen: 10
});

// ------------------------------------------------------ vuorokaudenaika

function dayPart(text) {
  const found = new Set();
  if (/(?<![a-zäö])(aamulla|aamupäivällä|aamusta|aamuun)(?![a-zäö])/.test(text)) found.add('morning');
  if (/(?<![a-zäö])(iltapäivällä|iltapäivästä)(?![a-zäö])/.test(text)) found.add('afternoon');
  if (/(?<![a-zäö])(illalla|illasta|iltaan)(?![a-zäö])/.test(text)) found.add('evening');
  if (/(?<![a-zäö])(yöllä|yöstä|aamuyöllä)(?![a-zäö])/.test(text)) found.add('night');
  return found.size === 1 ? [...found][0] : (found.size > 1 ? 'conflict' : null);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Tunti + minuutit + vuorokaudenaika -> { time, ambiguous, reason }.
 *
 * Ilman vuorokaudenaikaa: 7-12 ja 13-23 ovat selviä (aamu- tai 24 h
 * -oletus), 0 on keskiyö, mutta 1-6 voisi olla yö tai iltapäivä --
 * epäselvä, jäsennin ei väitä mitään.
 */
function clock(hour, minute, part) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return { time: null, ambiguous: true, reason: 'invalid' };
  }
  if (part === 'conflict') return { time: null, ambiguous: true, reason: 'daypart_conflict' };

  let h = hour;
  if ((part === 'evening' || part === 'afternoon') && h >= 1 && h < 12) h += 12;
  else if (part === 'night' && h >= 9 && h <= 11) h += 12;
  else if (part === 'morning' && h > 12) return { time: null, ambiguous: true, reason: 'daypart_conflict' };
  else if (part === null && h >= 1 && h <= 6) return { time: null, ambiguous: true, reason: 'ambiguous_hour' };

  return { time: `${pad2(h)}:${pad2(minute)}`, ambiguous: false, reason: '' };
}

/**
 * Jäsennä kellonajat. Palauttaa myös tekstin, josta ajat on peitetty,
 * jotta niiden numerot eivät tulkittaisi päivämääriksi.
 */
function parseTimes(lower) {
  const part = dayPart(lower);
  const times = [];
  let masked = lower;

  const take = (regex, build) => {
    masked = masked.replace(regex, (...args) => {
      const groups = args.slice(1, -2);
      const result = build(groups, args[0]);
      if (result) times.push({ ...result, expr: args[0].trim() });
      return ' '.repeat(args[0].length);
    });
  };

  // puoli yhdeksältä (= 08:30), puoli 9
  take(new RegExp(`puoli\\s+${HOUR_TOKEN}(?![a-zäö])`, 'g'), ([token]) => {
    const spoken = hourFromToken(token);
    if (!spoken || spoken < 1 || spoken > 12) return { time: null, ambiguous: true, reason: 'invalid' };
    return clock(spoken === 1 ? 12 : spoken - 1, 30, part);
  });

  // varttia vaille yhdeksän (= 08:45), viittä yli kahdeksan (= 08:05)
  take(new RegExp(`(varttia|vartin|viittä|viiden|kymmentä|kymmenen)\\s+(vaille|yli)\\s+${HOUR_TOKEN}(?![a-zäö])`, 'g'),
    ([amount, direction, token]) => {
      const spoken = hourFromToken(token);
      if (!spoken || spoken < 1 || spoken > 12) return { time: null, ambiguous: true, reason: 'invalid' };
      const offset = MINUTE_OFFSET[amount];
      if (direction === 'yli') return clock(spoken, offset, part);
      return clock(spoken === 1 ? 12 : spoken - 1, 60 - offset, part);
    });

  // klo 8, kello 8:30, klo 8.30, klo 14
  take(/(?:klo|kello)\s*(\d{1,2})(?:[.:](\d{2}))?(?!\d)/g, ([hour, minute]) => clock(Number(hour), minute ? Number(minute) : 0, part));

  // 8:30 ilman klo-sanaa
  take(/(?<![\d.])(\d{1,2}):(\d{2})(?!\d)/g, ([hour, minute]) => clock(Number(hour), Number(minute), part));

  return { times, masked };
}

// ---------------------------------------------------------- päivämäärät

const WEEKDAY_NAMES = Object.keys(WEEKDAY_NUMBER).join('|');

/** Sija määrää roolin: -lta/-sta/-n viittaa olemassa olevaan, muut kohteeseen. */
function roleOf(suffix) {
  return /^(lta|ltä|sta|stä|n)$/.test(suffix || '') ? DATE_ROLE.REFERENCE : DATE_ROLE.TARGET;
}

function parseDates(masked, todayIso) {
  const dates = [];
  const today = dayNumber(todayIso);
  let text = masked;

  const push = entry => dates.push(entry);
  const take = (regex, build) => {
    text = text.replace(regex, (...args) => {
      const groups = args.slice(1, -2);
      const built = build(groups, args[0]);
      if (built) push({ ...built, expr: args[0].trim() });
      return ' '.repeat(args[0].length);
    });
  };

  // ISO-päivä 2026-09-25
  take(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g, ([y, m, d]) => {
    const iso = `${y}-${m}-${d}`;
    return isoFromValid(iso, DATE_ROLE.TARGET);
  });

  // 30.9. tai 30.9.2026 (vuosi puuttuessa seuraava esiintymä)
  take(/(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4})?(?![\d])/g, ([d, m, y]) => {
    const year = y ? Number(y) : Number(todayIso.slice(0, 4));
    let iso = `${String(year).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
    if (!isIsoDate(iso)) return { iso: null, role: DATE_ROLE.TARGET, ambiguous: true, reason: 'invalid' };
    if (!y && dayNumber(iso) < today) {
      iso = `${String(year + 1).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
      if (!isIsoDate(iso)) return { iso: null, role: DATE_ROLE.TARGET, ambiguous: true, reason: 'invalid' };
    }
    return isoFromValid(iso, DATE_ROLE.TARGET);
  });

  // ylihuomenna, ylihuomiseksi (ennen "huomenna", koska se sisältyy siihen)
  take(/(?<![a-zäö])ylihuomen[a-zäö]*|(?<![a-zäö])ylihuomis[a-zäö]*/g, (groups, whole) =>
    ({ iso: addDaysIso(todayIso, 2), role: caseRole(whole), ambiguous: false, reason: '' }));

  // huomenna, huomiseksi, huomiselta, huomisen
  take(/(?<![a-zäö])(?:huomenna|huomis(?:e|ee)?[a-zäö]{0,4})(?![a-zäö])/g, (groups, whole) =>
    ({ iso: addDaysIso(todayIso, 1), role: caseRole(whole), ambiguous: false, reason: '' }));

  // tänään
  take(/(?<![a-zäö])tänään(?![a-zäö])/g, () => ({ iso: todayIso, role: DATE_ROLE.TARGET, ambiguous: false, reason: '' }));

  // ensi viikon perjantaina / tämän viikon maanantaina / ensi perjantaina / perjantaina
  const weekdayRegex = new RegExp(
    `(?<![a-zäö])(?:(ensi|seuraavana|tulevana)\\s+viikon\\s+|(tämän)\\s+viikon\\s+|(ensi|tulevana|seuraavana)\\s+)?(${WEEKDAY_NAMES})([a-zäö]{0,4})(?![a-zäö])`, 'g');
  take(weekdayRegex, ([nextWeek, thisWeek, nextPlain, name, suffix]) => {
    const wanted = WEEKDAY_NUMBER[name];
    const todayWeekday = weekdayOfIso(todayIso);
    const role = roleOf(suffix);

    if (nextWeek) return { iso: addDaysIso(mondayOf(todayIso), 7 + wanted - 1), role, ambiguous: false, reason: '' };
    if (thisWeek) {
      const iso = addDaysIso(mondayOf(todayIso), wanted - 1);
      return dayNumber(iso) < today
        ? { iso: null, role, ambiguous: true, reason: 'past_this_week' }
        : { iso, role, ambiguous: false, reason: '' };
    }
    if (nextPlain) {
      const distance = ((wanted - todayWeekday + 7) % 7) || 7;
      return { iso: addDaysIso(todayIso, distance), role, ambiguous: false, reason: '' };
    }
    // Pelkkä viikonpäivä: sama päivä kuin tänään on epäselvä (tänään vai viikon päästä).
    if (wanted === todayWeekday) return { iso: null, role, ambiguous: true, reason: 'same_weekday' };
    return { iso: addDaysIso(todayIso, (wanted - todayWeekday + 7) % 7), role, ambiguous: false, reason: '' };
  });

  // kuun lopussa
  take(/(?<![a-zäö])kuun\s+(?:lopussa|lopulla|loppuun|lopuksi)(?![a-zäö])/g, () =>
    ({ iso: lastDayOfMonth(todayIso), role: DATE_ROLE.TARGET, ambiguous: false, reason: '' }));

  // viikonloppuna: kaksi päivää, ei yhtä päivää
  take(/(?<![a-zäö])viikonloppu[a-zäö]{0,4}(?![a-zäö])/g, () =>
    ({ iso: null, role: DATE_ROLE.TARGET, ambiguous: true, reason: 'weekend' }));

  // ensi viikko / ensi viikolla / tämän viikon (ilman viikonpäivää): viikon maanantai.
  // Näyttökomennolle se on selvä (ensi viikko = ensi viikon maanantain viikko);
  // luontikomennolle se on epäselvä (mikä päivä?) -- ks. temporalHints.
  take(/(?<![a-zäö])(ensi|tämä|tämän|tällä|tälle)\s+viik(?:ko|on|o)[a-zäö]{0,4}(?![a-zäö])/g, ([which]) => ({
    iso: addDaysIso(mondayOf(todayIso), which === 'ensi' ? 7 : 0),
    role: DATE_ROLE.TARGET, ambiguous: false, reason: '', week: true
  }));

  return dates;

  function isoFromValid(iso, role) {
    return isIsoDate(iso) ? { iso, role, ambiguous: false, reason: '' } : { iso: null, role, ambiguous: true, reason: 'invalid' };
  }

  /**
   * Sana päättyy sijapäätteeseen: huomiselta/huomisen (viittaus), huomiseksi/huomiseen (kohde).
   * Genetiivi (-sen) viittaa olemassa olevaan; illatiivi (-seen) osoittaa kohteen.
   */
  function caseRole(word) {
    if (/(lta|ltä|sta|stä)$/.test(word) || /[^e]en$/.test(word)) return DATE_ROLE.REFERENCE;
    return DATE_ROLE.TARGET;
  }
}

// -------------------------------------------------------------- API

/**
 * Jäsennä päivä- ja kellonaikailmaisut tekstistä.
 *
 * @param {string} text
 * @param {string} todayIso YYYY-MM-DD
 * @returns {{dates: Array, times: Array}}
 */
export function parseFinnishTemporal(text, todayIso) {
  if (typeof text !== 'string' || !isIsoDate(todayIso)) return { dates: [], times: [] };
  const lower = text.normalize('NFC').toLocaleLowerCase('fi');
  const { times, masked } = parseTimes(lower);
  return { dates: parseDates(masked, todayIso), times };
}

/**
 * Yksiselitteinen päivä ja kellonaika komentoa varten.
 *
 * Palauttaa arvon VAIN kun ilmaisu on selvä: täsmälleen yksi eri päivä
 * (kohderoolissa; näyttökomennoille myös viittausroolissa), ei
 * epäselviä ilmaisuja. Muuten `null` ja lippu, joka kertoo miksi --
 * kutsuja jättää mallin vastauksen ennalleen.
 *
 * @param {string} text
 * @param {string} todayIso
 * @param {{intent?: string}} [options]
 * @returns {{date:string|null, time:string|null, dateAmbiguous:boolean, timeAmbiguous:boolean}}
 */
export function temporalHints(text, todayIso, { intent = '' } = {}) {
  const { dates, times } = parseFinnishTemporal(text, todayIso);

  const viewing = intent === 'show_day_plan' || intent === 'show_week_plan';
  const relevant = dates
    .filter(entry => viewing || entry.role === DATE_ROLE.TARGET)
    // "ensi viikolla" on selvä vain näyttökomennolle; muulle se ei nimeä päivää.
    .map(entry => (entry.week && !viewing ? { ...entry, iso: null, ambiguous: true, reason: 'week_only' } : entry));
  const clear = relevant.filter(entry => !entry.ambiguous);
  const distinct = new Set(clear.map(entry => entry.iso));
  const dateAmbiguous = relevant.some(entry => entry.ambiguous) || distinct.size > 1;
  const date = !dateAmbiguous && distinct.size === 1 ? [...distinct][0] : null;

  const clearTimes = times.filter(entry => !entry.ambiguous);
  const distinctTimes = new Set(clearTimes.map(entry => entry.time));
  const timeAmbiguous = times.some(entry => entry.ambiguous) || distinctTimes.size > 1;
  const time = !timeAmbiguous && distinctTimes.size === 1 ? [...distinctTimes][0] : null;

  return { date, time, dateAmbiguous, timeAmbiguous };
}
