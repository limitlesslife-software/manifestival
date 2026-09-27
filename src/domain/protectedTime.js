// Suojattu aika: oma aika, vapaa-aika ja loma YHTENÄ arkkitehtuurina.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa.
//
// =====================================================================
// SUOJATTU AIKA EI OLE YLIJÄÄMÄÄ
// =====================================================================
//
// Kalenterissa on kahdenlaista aikaa: sitä, mikä on jo luvattu, ja sitä,
// mikä on "vapaata". Ilman suojausta vapaa aika on aina se, mihin
// joustava työ valuu. Siksi oma aika, vapaa-aika ja loma varataan
// kapasiteetista ENNEN kuin yhtäkään joustavaa tehtävää sijoitetaan
// (docs/MENTAL-LOAD-CORE.md, "Kapasiteettijarru").
//
// =====================================================================
// YKSI MALLI, NELJÄ VAPAA-AJAN SÄÄNTÖÄ
// =====================================================================
//
// Omistajan päätös 4: kaikki vapaa-ajan säännöt ovat saman taulun rivejä
// (protected_periods, migraatio 0015), eivät neljä suunnittelujärjestelmää:
//
//   suojattu ilta              FREE_TIME weekly, viikonpäivä, klo 17.00–
//   sunnuntai pääosin vapaa    FREE_TIME weekly [7], koko päivä, strength soft
//   ei velvoitteita klo X jälk FREE_TIME weekly [1..7], klo X– (nukkumaanmenoon)
//   vähintään N h viikossa     FREE_TIME weekly_target, target_minutes
//
// Oma aika on OWN_TIME (kerran tai viikoittain), loma VACATION (päiväväli).
//
// Jaksot muunnetaan kalenterilohkoiksi (periodBlocks), jolloin aikajana,
// vapaat välit, törmäykset, kapasiteetti, horisonttiaikatauluttaja ja
// päivän uudelleensuunnittelu kunnioittavat niitä ilman omaa logiikkaa.
// Vain viikon vähimmäisvapaa-aika on luku eikä lohko: se varataan viikon
// joustavasta kapasiteetista (weeklyFreeTimeReserve).
//
// LOMA EI POISTA MITÄÄN. Kiinteät menot ja kiinteät tehtävät pysyvät
// näkyvissä ja lasketaan. Loma estää vain AUTOMAATTISEN sijoittamisen.

import { isIsoDate, isTimeOfDay, toMinutes, fromMinutes } from './task.js';
import { addDaysIso, weekdayOfIso } from './fiTemporal.js';
import { BLOCK_KIND } from './scheduler.js';

export const PROTECTED_KIND = Object.freeze({
  OWN_TIME: 'OWN_TIME',
  FREE_TIME: 'FREE_TIME',
  VACATION: 'VACATION'
});
export const PROTECTED_KINDS = Object.freeze(Object.values(PROTECTED_KIND));

export const PERIOD_RECURRENCE = Object.freeze({
  ONCE: 'once',
  WEEKLY: 'weekly',
  WEEKLY_TARGET: 'weekly_target'
});
export const PERIOD_RECURRENCES = Object.freeze(Object.values(PERIOD_RECURRENCE));

/** firm = ei koskaan automaattisesti; soft = "pääosin vapaa": ei automaattisesti, oma valinta sallittu ilman varoitusta. */
export const PERIOD_STRENGTH = Object.freeze({ FIRM: 'firm', SOFT: 'soft' });
export const PERIOD_STRENGTHS = Object.freeze(Object.values(PERIOD_STRENGTH));

export const MAX_PERIOD_TITLE_LENGTH = 60;
export const MAX_PERIOD_NOTE_LENGTH = 500;
export const MINUTES_PER_WEEK = 10080;
/** Pisin loma tai kertajakso. Vuotta pidempi ei ole jakso vaan asetus. */
export const MAX_PERIOD_DAYS = 366;

const KIND_TO_BLOCK = Object.freeze({
  [PROTECTED_KIND.OWN_TIME]: BLOCK_KIND.OWN_TIME,
  [PROTECTED_KIND.FREE_TIME]: BLOCK_KIND.FREE_TIME,
  [PROTECTED_KIND.VACATION]: BLOCK_KIND.VACATION
});

const KIND_LABELS = Object.freeze({
  [PROTECTED_KIND.OWN_TIME]: 'Oma aika',
  [PROTECTED_KIND.FREE_TIME]: 'Vapaa-aika',
  [PROTECTED_KIND.VACATION]: 'Loma'
});

const WEEKDAY_SHORT = Object.freeze(['', 'ma', 'ti', 'ke', 'to', 'pe', 'la', 'su']);

const EMPTY = Object.freeze([]);

export function protectedKindLabel(kind) {
  return KIND_LABELS[kind] || 'Suojattu aika';
}

function textOrNull(value, max) {
  if (value === null || value === undefined) return null;
  const text = String(value).normalize('NFC').trim();
  return text ? text.slice(0, max) : null;
}

function wholeOrNull(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

/** '19:00:00' (kanta) -> '19:00'. */
function clockOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).slice(0, 5);
  return isTimeOfDay(text) ? text : null;
}

function weekdaysOf(value) {
  if (!Array.isArray(value)) return null;
  const days = [...new Set(value.map(Number).filter(day => Number.isInteger(day) && day >= 1 && day <= 7))]
    .sort((a, b) => a - b);
  return days.length > 0 ? days : null;
}

export function normalizeProtectedPeriod(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const kind = PROTECTED_KINDS.includes(source.kind) ? source.kind : null;
  const recurrence = PERIOD_RECURRENCES.includes(source.recurrence) ? source.recurrence : null;
  return {
    id: source.id != null && String(source.id) !== '' ? String(source.id) : null,
    kind,
    recurrence,
    title: textOrNull(source.title, MAX_PERIOD_TITLE_LENGTH),
    startDate: isIsoDate(source.startDate) ? source.startDate : null,
    endDate: isIsoDate(source.endDate) ? source.endDate : null,
    weekdays: weekdaysOf(source.weekdays),
    startTime: clockOrNull(source.startTime),
    endTime: clockOrNull(source.endTime),
    targetMinutes: wholeOrNull(source.targetMinutes),
    strength: PERIOD_STRENGTHS.includes(source.strength) ? source.strength : PERIOD_STRENGTH.FIRM,
    active: source.active === undefined ? true : source.active !== false,
    note: textOrNull(source.note, MAX_PERIOD_NOTE_LENGTH),
    createdAt: source.createdAt ?? null,
    updatedAt: source.updatedAt ?? null
  };
}

function daysBetween(fromIso, toIso) {
  const a = Date.parse(fromIso + 'T00:00:00Z');
  const b = Date.parse(toIso + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

/**
 * Sama sääntöjoukko kuin kannan CHECK-rajoitteissa (0015), jotta
 * muistipolku ei hyväksy riviä, jonka kanta hylkäisi.
 *
 * @returns {{valid:boolean, errors:Object<string,string>}}
 */
export function validateProtectedPeriod(period) {
  const errors = {};
  const p = period || {};
  if (!PROTECTED_KINDS.includes(p.kind)) errors.kind = 'Valitse, onko kyse omasta ajasta, vapaa-ajasta vai lomasta.';
  if (!PERIOD_RECURRENCES.includes(p.recurrence)) errors.recurrence = 'Valitse, toistuuko jakso.';
  if (p.title && p.title.length > MAX_PERIOD_TITLE_LENGTH) errors.title = `Nimi on enintään ${MAX_PERIOD_TITLE_LENGTH} merkkiä.`;

  if (p.recurrence === PERIOD_RECURRENCE.ONCE) {
    if (!p.startDate) errors.startDate = 'Anna alkupäivä.';
    else if (p.endDate && p.endDate < p.startDate) errors.endDate = 'Loppupäivä ei voi olla ennen alkupäivää.';
    else if (p.endDate && daysBetween(p.startDate, p.endDate) >= MAX_PERIOD_DAYS) errors.endDate = 'Jakso on enintään vuoden mittainen.';
    if (p.weekdays) errors.weekdays = 'Kertajaksolla ei ole viikonpäiviä.';
  }
  if (p.recurrence === PERIOD_RECURRENCE.WEEKLY) {
    if (!p.weekdays || p.weekdays.length === 0) errors.weekdays = 'Valitse vähintään yksi viikonpäivä.';
    if (p.startDate && p.endDate && p.endDate < p.startDate) errors.endDate = 'Loppupäivä ei voi olla ennen alkupäivää.';
  }
  if (p.recurrence === PERIOD_RECURRENCE.WEEKLY_TARGET) {
    if (p.kind !== PROTECTED_KIND.FREE_TIME) errors.kind = 'Viikon vähimmäisaika koskee vapaa-aikaa.';
    if (!Number.isInteger(p.targetMinutes) || p.targetMinutes < 0 || p.targetMinutes > MINUTES_PER_WEEK) {
      errors.targetMinutes = 'Anna vapaa-ajan vähimmäismäärä (0–168 h viikossa).';
    }
    if (p.startTime || p.endTime || p.weekdays) errors.recurrence = 'Viikon vähimmäisajalla ei ole kellonaikaa eikä viikonpäiviä.';
  } else if (p.targetMinutes !== null && p.targetMinutes !== undefined) {
    errors.targetMinutes = 'Vähimmäismäärä kuuluu vain viikon vapaa-ajan tavoitteeseen.';
  }
  // Kannan protected_periods_dates_check koskee jokaista toistuvuutta,
  // myös viikon vähimmäisaikaa (tests/mental-load-migration.test.mjs).
  if (!errors.endDate && p.startDate && p.endDate && p.endDate < p.startDate) {
    errors.endDate = 'Loppupäivä ei voi olla ennen alkupäivää.';
  }
  if (p.kind === PROTECTED_KIND.VACATION) {
    if (p.recurrence !== PERIOD_RECURRENCE.ONCE) errors.recurrence = 'Loma on päiväväli.';
    if (p.startTime || p.endTime) errors.startTime = 'Loma koskee kokonaisia päiviä.';
  }
  if (p.startTime && p.endTime && toMinutes(p.startTime) >= toMinutes(p.endTime)) {
    errors.endTime = 'Loppuajan pitää olla alkuajan jälkeen.';
  }
  if (!p.startTime && p.endTime) errors.startTime = 'Anna ensin alkuaika.';
  return { valid: Object.keys(errors).length === 0, errors };
}

/** Onko jakso voimassa annettuna päivänä (ei koske weekly_target-riviä)? */
export function periodAppliesOn(period, dateIso) {
  if (!period || period.active === false || !isIsoDate(dateIso)) return false;
  if (period.recurrence === PERIOD_RECURRENCE.ONCE) {
    if (!period.startDate) return false;
    const end = period.endDate || period.startDate;
    return dateIso >= period.startDate && dateIso <= end;
  }
  if (period.recurrence === PERIOD_RECURRENCE.WEEKLY) {
    if (period.startDate && dateIso < period.startDate) return false;
    if (period.endDate && dateIso > period.endDate) return false;
    return Array.isArray(period.weekdays) && period.weekdays.includes(weekdayOfIso(dateIso));
  }
  return false;
}

/** Päivän loma-jakso tai null. Kiinteät menot pysyvät; tämä kertoo vain tilan. */
export function vacationOn(periods = EMPTY, dateIso) {
  for (const period of Array.isArray(periods) ? periods : EMPTY) {
    if (period && period.kind === PROTECTED_KIND.VACATION && periodAppliesOn(period, dateIso)) return period;
  }
  return null;
}

/** Viikon vähimmäisvapaa-aika minuutteina (suurin aktiivinen tavoite) tai null. */
export function weeklyFreeTimeTargetMinutes(periods = EMPTY) {
  let best = null;
  for (const period of Array.isArray(periods) ? periods : EMPTY) {
    if (!period || period.active === false || period.recurrence !== PERIOD_RECURRENCE.WEEKLY_TARGET) continue;
    if (!Number.isInteger(period.targetMinutes)) continue;
    if (best === null || period.targetMinutes > best) best = period.targetMinutes;
  }
  return best;
}

/**
 * Lohkon loppu illalla: jakson loppuaika, tai jos sitä ei ole, rauhoittumisen
 * alku (nukkumaanmeno - rauhoittuminen), tai keskiyö. Suojattu vapaa-ilta ei
 * ulotu uneen: uni on jo suojattu omana lohkonaan.
 */
function eveningEndMinute(period, restStartMinute) {
  if (period.endTime) return toMinutes(period.endTime);
  if (Number.isInteger(restStartMinute) && restStartMinute > 0 && restStartMinute <= 1440) return restStartMinute;
  return 1440;
}

/**
 * Suojattujen jaksojen kalenterilohkot välille [from, to].
 *
 * @param {object} args
 * @param {Array}  args.periods
 * @param {string} args.from
 * @param {string} args.to
 * @param {(dateIso:string)=>number|null} [args.restStartFor] illan levon alku
 *        minuutteina (rauhoittuminen tai nukkumaanmeno); null = keskiyö
 * @returns {ReadonlyArray<object>} jäädytetyt lohkot calendarBlocks-muodossa
 */
export function periodBlocks({ periods = EMPTY, from, to, restStartFor = null } = {}) {
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) return EMPTY;
  const list = (Array.isArray(periods) ? periods : EMPTY)
    .filter(period => period && period.active !== false && period.id
      && PROTECTED_KINDS.includes(period.kind) && period.recurrence !== PERIOD_RECURRENCE.WEEKLY_TARGET);
  if (list.length === 0) return EMPTY;

  const blocks = [];
  let guard = 0;
  for (let date = from; date && date <= to && guard < MAX_PERIOD_DAYS; date = addDaysIso(date, 1), guard += 1) {
    const restStart = typeof restStartFor === 'function' ? safeMinute(() => restStartFor(date)) : null;
    for (const period of list) {
      if (!periodAppliesOn(period, date)) continue;
      const kind = KIND_TO_BLOCK[period.kind];
      let start;
      let end;
      if (period.kind === PROTECTED_KIND.VACATION || !period.startTime) {
        // Koko päivä: loma ja "sunnuntai pääosin vapaa".
        start = 0;
        end = period.kind === PROTECTED_KIND.VACATION ? 1440 : eveningEndMinute({ endTime: null }, restStart);
      } else {
        start = toMinutes(period.startTime);
        end = eveningEndMinute(period, restStart);
      }
      if (!(end > start)) continue;
      const minutes = end - start;
      blocks.push(Object.freeze({
        id: `block:${kind}:${period.id}:${date}`,
        kind,
        blockKind: kind,
        block: true,
        protected: true,
        completed: false,
        sourceId: period.id,
        periodId: period.id,
        periodKind: period.kind,
        strength: period.strength || PERIOD_STRENGTH.FIRM,
        date,
        time: fromMinutes(start),
        endTime: minutes >= 1440 ? null : fromMinutes(end),
        durationMinutes: minutes,
        startMinute: start,
        endMinute: end,
        wholeDay: start === 0 && end >= 1440,
        title: period.title || protectedKindLabel(period.kind),
        category: 'hyvinvointi',
        explanation: explainBlock(period)
      }));
    }
  }
  blocks.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
    || a.startMinute - b.startMinute || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return Object.freeze(blocks);
}

function safeMinute(fn) {
  try {
    const value = fn();
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

function explainBlock(period) {
  if (period.kind === PROTECTED_KIND.VACATION) {
    return 'Loma: joustavaa työtä ei sijoiteta tähän. Kiinteät menot pysyvät.';
  }
  if (period.strength === PERIOD_STRENGTH.SOFT) {
    return 'Pääosin vapaa: automaattinen suunnittelu jättää tämän rauhaan.';
  }
  return period.kind === PROTECTED_KIND.OWN_TIME
    ? 'Suojattu oma aika: tähän ei sijoiteta tehtäviä.'
    : 'Suojattu vapaa-aika: tähän ei sijoiteta velvoitteita.';
}

/**
 * Viikon vähimmäisvapaa-ajasta se osa, jota suojatut vapaa-ajan lohkot eivät
 * jo kata. Tämä varataan viikon joustavasta kapasiteetista.
 *
 * @param {object} args
 * @param {Array}  args.periods
 * @param {ReadonlyArray<object>} args.blocks  viikon lohkot (periodBlocks)
 * @param {Array<string>} args.weekDates        viikon päivät
 * @returns {{targetMinutes:number|null, coveredMinutes:number, reserveMinutes:number}}
 */
export function weeklyFreeTimeReserve({ periods = EMPTY, blocks = EMPTY, weekDates = EMPTY } = {}) {
  const target = weeklyFreeTimeTargetMinutes(periods);
  const days = new Set(Array.isArray(weekDates) ? weekDates : EMPTY);
  let covered = 0;
  for (const block of Array.isArray(blocks) ? blocks : EMPTY) {
    if (!block || !days.has(block.date)) continue;
    if (block.blockKind !== BLOCK_KIND.FREE_TIME && block.blockKind !== BLOCK_KIND.OWN_TIME
      && block.blockKind !== BLOCK_KIND.VACATION) continue;
    covered += Math.max(0, Number(block.durationMinutes) || 0);
  }
  return {
    targetMinutes: target,
    coveredMinutes: covered,
    reserveMinutes: target === null ? 0 : Math.max(0, target - covered)
  };
}

/**
 * Jaa varaus päiville niiden käytettävän ajan suhteessa (deterministinen,
 * minuutit kokonaislukuina, summa = varaus tai käytettävän ajan summa).
 *
 * @param {Array<{dateIso:string, usableMinutes:number}>} days
 * @param {number} reserveMinutes
 * @returns {Map<string, number>} päivä -> varattu minuuttimäärä
 */
export function distributeReserve(days = EMPTY, reserveMinutes = 0) {
  const result = new Map();
  const list = (Array.isArray(days) ? days : EMPTY).filter(day => day && isIsoDate(day.dateIso));
  const total = list.reduce((sum, day) => sum + Math.max(0, day.usableMinutes || 0), 0);
  const want = Math.max(0, Math.min(Math.round(reserveMinutes || 0), total));
  for (const day of list) result.set(day.dateIso, 0);
  if (want === 0 || total === 0) return result;
  let assigned = 0;
  const shares = list.map(day => {
    const exact = (Math.max(0, day.usableMinutes || 0) / total) * want;
    const floor = Math.floor(exact);
    assigned += floor;
    return { dateIso: day.dateIso, floor, remainder: exact - floor, cap: Math.max(0, day.usableMinutes || 0) };
  });
  // Jäännös suurimmille murto-osille; tasatilanteessa aikaisempi päivä.
  const order = [...shares].sort((a, b) => b.remainder - a.remainder || (a.dateIso < b.dateIso ? -1 : 1));
  let left = want - assigned;
  for (const share of order) {
    if (left <= 0) break;
    if (share.floor < share.cap) { share.floor += 1; left -= 1; }
  }
  for (const share of shares) result.set(share.dateIso, share.floor);
  return result;
}

// --------------------------------------------------- vapaa-ajan säännöt

/**
 * Käyttäjän vapaa-ajan säännöt jaksoista (asetusnäkymää varten).
 *
 * @returns {{minimumMinutes:number|null, eveningWeekdays:number[], eveningFrom:string|null,
 *   sundayMostlyFree:boolean, cutoffTime:string|null}}
 */
export function freeTimeRules(periods = EMPTY) {
  const rules = {
    minimumMinutes: weeklyFreeTimeTargetMinutes(periods),
    eveningWeekdays: [],
    eveningFrom: null,
    sundayMostlyFree: false,
    cutoffTime: null
  };
  for (const period of Array.isArray(periods) ? periods : EMPTY) {
    if (!period || period.active === false || period.kind !== PROTECTED_KIND.FREE_TIME) continue;
    if (period.recurrence !== PERIOD_RECURRENCE.WEEKLY) continue;
    const rule = ruleOf(period);
    if (rule === RULE.SUNDAY) rules.sundayMostlyFree = true;
    if (rule === RULE.CUTOFF) rules.cutoffTime = period.startTime;
    if (rule === RULE.EVENING) {
      rules.eveningWeekdays = [...new Set([...rules.eveningWeekdays, ...period.weekdays])].sort((a, b) => a - b);
      rules.eveningFrom = period.startTime;
    }
  }
  return rules;
}

/** Säännön tunniste title-kentän sijaan note-kentässä ei ole tarpeen: muoto kertoo sen. */
export const RULE = Object.freeze({ EVENING: 'evening', SUNDAY: 'sunday', CUTOFF: 'cutoff', OTHER: 'other' });

/**
 * Minkä vapaa-ajan säännön jakso toteuttaa?
 *   sunnuntai: weekly [7], koko päivä, soft
 *   takaraja:  weekly kaikki 7 päivää, alkuaika, ei loppuaikaa, firm
 *   ilta:      weekly, alkuaika, ei loppuaikaa, osa viikosta
 */
export function ruleOf(period) {
  if (!period || period.kind !== PROTECTED_KIND.FREE_TIME || period.recurrence !== PERIOD_RECURRENCE.WEEKLY) return RULE.OTHER;
  const days = Array.isArray(period.weekdays) ? period.weekdays : [];
  if (!period.startTime && days.length === 1 && days[0] === 7 && period.strength === PERIOD_STRENGTH.SOFT) return RULE.SUNDAY;
  if (period.startTime && !period.endTime && days.length === 7) return RULE.CUTOFF;
  if (period.startTime && !period.endTime) return RULE.EVENING;
  return RULE.OTHER;
}

/**
 * Säännöt -> jaksot. Palauttaa halutun jaksojoukon (ilman tunnisteita);
 * sovelluskerros vertaa sitä olemassa oleviin (reconcileFreeTimeRules).
 */
export function freeTimeRulePeriods(rules = {}) {
  const periods = [];
  const minimum = wholeOrNull(rules.minimumMinutes);
  if (minimum !== null && minimum > 0) {
    periods.push(normalizeProtectedPeriod({
      kind: PROTECTED_KIND.FREE_TIME, recurrence: PERIOD_RECURRENCE.WEEKLY_TARGET,
      title: 'Vapaa-aikaa viikossa', targetMinutes: Math.min(minimum, MINUTES_PER_WEEK)
    }));
  }
  const evenings = weekdaysOf(rules.eveningWeekdays);
  if (evenings && isTimeOfDay(rules.eveningFrom)) {
    periods.push(normalizeProtectedPeriod({
      kind: PROTECTED_KIND.FREE_TIME, recurrence: PERIOD_RECURRENCE.WEEKLY,
      title: 'Vapaa ilta', weekdays: evenings, startTime: rules.eveningFrom
    }));
  }
  if (rules.sundayMostlyFree === true) {
    periods.push(normalizeProtectedPeriod({
      kind: PROTECTED_KIND.FREE_TIME, recurrence: PERIOD_RECURRENCE.WEEKLY,
      title: 'Sunnuntai pääosin vapaa', weekdays: [7], strength: PERIOD_STRENGTH.SOFT
    }));
  }
  if (isTimeOfDay(rules.cutoffTime)) {
    periods.push(normalizeProtectedPeriod({
      kind: PROTECTED_KIND.FREE_TIME, recurrence: PERIOD_RECURRENCE.WEEKLY,
      title: `Ei velvoitteita klo ${rules.cutoffTime} jälkeen`, weekdays: [1, 2, 3, 4, 5, 6, 7],
      startTime: rules.cutoffTime
    }));
  }
  return periods;
}

/**
 * Vertaa haluttuja sääntöjaksoja olemassa oleviin: mitä luodaan, päivitetään
 * ja poistetaan. Muut FREE_TIME-jaksot (RULE.OTHER) eivät kuulu sääntöihin
 * eivätkä muutu.
 *
 * @returns {{create:Array, update:Array, remove:Array}}
 */
export function reconcileFreeTimeRules(existing = EMPTY, rules = {}) {
  const wanted = freeTimeRulePeriods(rules);
  const keyOf = period => (period.recurrence === PERIOD_RECURRENCE.WEEKLY_TARGET ? 'target' : ruleOf(period));
  const current = new Map();
  for (const period of Array.isArray(existing) ? existing : EMPTY) {
    if (!period || period.kind !== PROTECTED_KIND.FREE_TIME) continue;
    const key = keyOf(period);
    if (key === RULE.OTHER) continue;
    if (!current.has(key)) current.set(key, []);
    current.get(key).push(period);
  }
  const create = [];
  const update = [];
  const remove = [];
  const seen = new Set();
  for (const want of wanted) {
    const key = keyOf(want);
    seen.add(key);
    const [first, ...extra] = current.get(key) || [];
    remove.push(...extra);
    if (!first) { create.push(want); continue; }
    const next = { ...first, ...want, id: first.id, createdAt: first.createdAt, updatedAt: first.updatedAt, active: true };
    if (samePeriod(first, next)) continue;
    update.push(next);
  }
  for (const [key, list] of current) if (!seen.has(key)) remove.push(...list);
  return { create, update, remove };
}

function samePeriod(a, b) {
  const fields = ['kind', 'recurrence', 'title', 'startDate', 'endDate', 'startTime', 'endTime', 'targetMinutes', 'strength', 'active'];
  return fields.every(field => (a[field] ?? null) === (b[field] ?? null))
    && JSON.stringify(a.weekdays || null) === JSON.stringify(b.weekdays || null);
}

// ----------------------------------------------------------- selitteet

function weekdayList(days) {
  if (!Array.isArray(days) || days.length === 0) return '';
  if (days.length === 7) return 'joka päivä';
  if (days.join(',') === '1,2,3,4,5') return 'arkisin';
  if (days.join(',') === '6,7') return 'viikonloppuisin';
  return days.map(day => WEEKDAY_SHORT[day]).join(', ');
}

function dateLabel(iso) {
  if (!isIsoDate(iso)) return '';
  const [, m, d] = iso.split('-').map(Number);
  return `${d}.${m}.`;
}

/** Yksi lause jaksosta: "Vapaa ilta ti, to klo 17.00 alkaen". */
export function describePeriod(period) {
  if (!period) return '';
  const label = period.title || protectedKindLabel(period.kind);
  if (period.recurrence === PERIOD_RECURRENCE.WEEKLY_TARGET) {
    const hours = Math.round(((period.targetMinutes || 0) / 60) * 10) / 10;
    return `Vapaa-aikaa vähintään ${String(hours).replace('.', ',')} h viikossa`;
  }
  const time = period.startTime
    ? (period.endTime ? ` klo ${period.startTime.replace(':', '.')}–${period.endTime.replace(':', '.')}`
      : ` klo ${period.startTime.replace(':', '.')} alkaen`)
    : '';
  if (period.recurrence === PERIOD_RECURRENCE.ONCE) {
    const range = period.endDate && period.endDate !== period.startDate
      ? `${dateLabel(period.startDate)}–${dateLabel(period.endDate)}`
      : dateLabel(period.startDate);
    return `${label} ${range}${time}`.trim();
  }
  return `${label} ${weekdayList(period.weekdays)}${time}`.trim();
}

/**
 * Päivän suojattu aika yhteenvetona (Tänään-näkymä): loma, oma aika ja
 * vapaa-aika erikseen.
 *
 * @returns {{vacation:object|null, ownTime:Array, freeTime:Array, ownMinutes:number, freeMinutes:number}}
 */
export function protectedDaySummary({ periods = EMPTY, blocks = EMPTY, dateIso } = {}) {
  const dayBlocks = (Array.isArray(blocks) ? blocks : EMPTY).filter(block => block && block.date === dateIso);
  const ownTime = dayBlocks.filter(block => block.blockKind === BLOCK_KIND.OWN_TIME);
  const freeTime = dayBlocks.filter(block => block.blockKind === BLOCK_KIND.FREE_TIME);
  return {
    vacation: vacationOn(periods, dateIso),
    ownTime,
    freeTime,
    ownMinutes: ownTime.reduce((sum, block) => sum + (block.durationMinutes || 0), 0),
    freeMinutes: freeTime.reduce((sum, block) => sum + (block.durationMinutes || 0), 0)
  };
}

/**
 * Suunnittelun luvut suojatusta ajasta (tekoälysuunnitelman konteksti):
 * oma aika ja vapaa-aika keskimäärin viikossa tunteina ja lomapäivien määrä
 * välillä. Pelkkiä lukuja, ei jaksojen nimiä.
 *
 * @returns {{personalHoursPerWeek:number, vacationDays:number}}
 */
export function protectedPlanningHours({ blocks = EMPTY, from, to } = {}) {
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) return { personalHoursPerWeek: 0, vacationDays: 0 };
  const days = daysBetween(from, to) + 1;
  let personal = 0;
  const vacationDates = new Set();
  for (const block of Array.isArray(blocks) ? blocks : EMPTY) {
    if (!block || block.date < from || block.date > to) continue;
    if (block.blockKind === BLOCK_KIND.VACATION) vacationDates.add(block.date);
    else if (block.blockKind === BLOCK_KIND.OWN_TIME || block.blockKind === BLOCK_KIND.FREE_TIME) {
      personal += Math.max(0, Number(block.durationMinutes) || 0);
    }
  }
  return {
    personalHoursPerWeek: Math.round(((personal / days) * 7 / 60) * 2) / 2,
    vacationDays: vacationDates.size
  };
}

/** Lohko on suojatun ajan lohko (oma aika, vapaa-aika tai loma). */
export function isProtectedTimeBlock(item) {
  const kind = item && (item.blockKind ?? item.kind);
  return kind === BLOCK_KIND.OWN_TIME || kind === BLOCK_KIND.FREE_TIME || kind === BLOCK_KIND.VACATION;
}
