// Päivän uudelleensuunnittelu keskeytyksen jälkeen.
//
// PUHDAS MODUULI. Ei kelloa (nyt ja tämä päivä annetaan), ei DOM:ia, ei
// verkkoa, ei satunnaisuutta. Sama syöte tuottaa aina saman, jäädytetyn
// ehdotuksen. Roskasyöte ei kaada mitään.
//
// =====================================================================
// PERIAATE: PIENIN MUUTOS, EI UUTTA PÄIVÄÄ
// =====================================================================
//
// "Olen 10 min myöhässä" ei ole syy rakentaa koko päivää uudelleen. Tämä
// moduuli siirtää vain ne joustavat kohteet, joihin keskeytys oikeasti
// osuu, ja pysähtyy heti, kun väljyys imee siirron. Kaikki muu jää
// täsmälleen ennalleen.
//
// MIKÄ EI KOSKAAN LIIKU
//
//   - kalenterin tapahtumat (kiinteät sitoumukset)
//   - valmistautuminen, matka, pysäköinti, perilläolon varmuusaika
//   - rauhoittuminen ja suojattu uni
//   - suojatuiksi merkityt kohteet
//   - tehdyt kohteet
//   - käyttäjän itse ajastamat tehtävät (MANUAL), ellei kutsuja erikseen
//     salli niitä (includeManual) -- sama lupaus kuin aikataulumoottorissa
//
// Liikkuvat vain joustavat: automaattisesti sijoitetut (AUTO) ja
// aikatauluttamattomat tehtävät sekä joustavat rutiinit.
//
// KÄYNNISSÄ OLEVA KOHDE säilyy venymisessä, ohituksessa ja loppujen
// siirrossa. Myöhästymisessä kellon mukaan käynnissä oleva joustava kohde
// on juuri se, jota myöhästyminen koskee (sitä ei ole vielä aloitettu),
// joten se siirtyy myöhästymisen verran.
//
// TULOS ON AINA EHDOTUS: requiresConfirmation on aina true. Tämä moduuli
// ei muuta mitään; sovelluskerros tekee muutokset vasta vahvistuksen jälkeen.
//
// KESÄAIKA: "10 min myöhässä" on todellista aikaa. Kun kutsuja antaa
// aikavyöhykefunktion (offsetMinutesFn, ks. wallClock.js), siirto lasketaan
// hetkinä: kevään vaihtoyönä 02.50 + 20 min = 04.10. Syksyn toistuvassa
// tunnissa tulos ei koskaan osu aiottua aiemmaksi. Muuten laskenta on
// seinäkelloaikaa kuten muualla aikataulussa.

import {
  blockKindOf, isEventOccurrence, blocksOnDate, eventItemsOnDate, DEFAULT_TASK_MINUTES
} from './scheduler.js';
import { isIsoDate, isTimeOfDay, toMinutes, fromMinutes, durationOf, SCHEDULING } from './task.js';
import { priorityWeight } from './priority.js';
import { PROTECTION } from './dailyLife.js';
import { INTERRUPTION_KIND, INTERRUPTION_KINDS } from './interruptions.js';
import { addDaysIso } from './fiTemporal.js';
import { wallClockToEpoch, epochToWallClock, dayNumberOf, durationText, clockText } from './wallClock.js';
import { shortDateLabel } from './calendar.js';

export const REPLAN_CHANGE = Object.freeze({
  SHIFT: 'shift',
  EXTEND: 'extend',
  SKIP: 'skip',
  DEFER: 'defer'
});

export const REPLAN_CHANGE_KINDS = Object.freeze(Object.values(REPLAN_CHANGE));

/** Suurin hyväksytty myöhästyminen tai jatko: vuorokausi. */
export const MAX_REPLAN_MINUTES = 1440;

const MINUTES_PER_DAY = 1440;
const MS_PER_MINUTE = 60000;
/** Syksyn toistuva tunti: etsitään enintään näin monta minuuttia eteenpäin. */
const MAX_FOLD_SEARCH_MINUTES = 180;

const EMPTY = Object.freeze([]);

const TARGET_FILLER = new Set(['nyt', 'tänään', 'enää', 'vielä', 'tämä', 'tää', 'tämän']);
const TARGET_SUFFIXES = ['ssa', 'ssä', 'lla', 'llä', 'lle', 'lta', 'ltä', 'sta', 'stä', 'aan', 'ään', 'iin',
  'een', 'seen', 'hin', 'ksi', 'na', 'nä', 'n', 'a', 'ä'];

// ------------------------------------------------------------ apurit

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function compareIds(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function fold(text) {
  return typeof text === 'string' ? text.normalize('NFC').toLocaleLowerCase('fi').trim() : '';
}

function clockOf(minutes) {
  return clockText(fromMinutes(minutes));
}

/** Lauseen lopussa päiväyksen piste on lauseen piste: 'ti 29.9' + '.'. */
function endLabel(dateIso) {
  return shortDateLabel(dateIso).replace(/\.$/u, '');
}

/** Kohteen tunniste samassa muodossa kuin describe() sen antaa (merkkijono). null = ei tunnistetta. */
function cleanId(value) {
  if (typeof value === 'string') return value.trim() ? value : null;
  return Number.isFinite(value) ? String(value) : null;
}

function validMinutes(value) {
  return Number.isInteger(value) && value > 0 && value <= MAX_REPLAN_MINUTES ? value : null;
}

/**
 * Seinäkelloaika + todellinen kesto -> seinäkelloaika minuutteina päivän
 * alusta (voi ylittää 1440, jos mennään seuraavalle päivälle).
 */
function addRealMinutes(dateIso, wallMinutes, delta, offsetMinutesFn) {
  const plain = { minutes: wallMinutes + delta, dstAdjusted: false };
  if (typeof offsetMinutesFn !== 'function' || wallMinutes < 0 || wallMinutes >= MINUTES_PER_DAY) return plain;
  const start = safe(() => wallClockToEpoch(dateIso, fromMinutes(wallMinutes), offsetMinutesFn), null);
  if (!start) return plain;
  const targetMs = start.epochMs + delta * MS_PER_MINUTE;
  const wall = safe(() => epochToWallClock(targetMs, offsetMinutesFn), null);
  if (!wall) return plain;
  const dayDiff = dayNumberOf(wall.date) - dayNumberOf(dateIso);
  let minutes = dayDiff * MINUTES_PER_DAY + toMinutes(wall.time);
  // Syksyn toistuva tunti: tallennettu seinäkelloaika tulkitaan aina
  // ensimmäisenä esiintymänä. Jos se osuisi aiottua aiemmaksi, siirrytään
  // eteenpäin, kunnes aika varmasti on aiottu tai myöhempi.
  if (dayDiff === 0) {
    let check = safe(() => wallClockToEpoch(dateIso, fromMinutes(minutes), offsetMinutesFn), null);
    let guard = 0;
    while (check && check.epochMs < targetMs && guard < MAX_FOLD_SEARCH_MINUTES && minutes < MINUTES_PER_DAY - 1) {
      minutes += 1;
      guard += 1;
      check = safe(() => wallClockToEpoch(dateIso, fromMinutes(minutes), offsetMinutesFn), null);
    }
  }
  return { minutes, dstAdjusted: minutes !== wallMinutes + delta };
}

// ------------------------------------------------------------ kohteet

function protectedItem(item) {
  return item.protected === true || item.protection === PROTECTION.PROTECTED || item.protection === PROTECTION.MANDATORY;
}

/** Yksi päivän kohde yhtenäisessä muodossa. null = ei kelpaa. */
function describe(item, includeManual) {
  if (!isObject(item)) return null;
  return safe(() => {
    const id = item.id != null && String(item.id) !== '' ? String(item.id) : null;
    if (!id) return null;
    const timed = isTimeOfDay(item.time);
    const start = timed ? toMinutes(item.time) : null;
    const length = timed ? (durationOf(item) ?? DEFAULT_TASK_MINUTES) : (durationOf(item) ?? null);
    const base = {
      id,
      title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : 'Nimetön',
      start,
      end: timed ? start + length : null,
      duration: length,
      timed,
      completed: item.completed === true,
      deadline: isIsoDate(item.deadline) ? item.deadline : null,
      priority: typeof item.priority === 'string' ? item.priority : null,
      date: isIsoDate(item.date) ? item.date : null,
      source: item
    };

    if (item.virtual === true) return { ...base, kind: 'virtual', flexible: false, sleep: /sleep/.test(id) };
    if (blockKindOf(item)) return { ...base, kind: 'block', flexible: false, protected: true };
    if (isEventOccurrence(item) || item.continuation === true) return { ...base, kind: 'event', flexible: false };
    if (item.isRoutine === true || item.source === 'routine') {
      const flexible = item.scheduling === 'flexible' && !protectedItem(item);
      return {
        ...base, kind: 'routine', flexible, protected: protectedItem(item),
        routineOccurrenceId: id, routineId: item.routineId != null ? String(item.routineId) : null
      };
    }
    // Tehtävä.
    if (item.isWake === true || protectedItem(item)) return { ...base, kind: 'task', flexible: false, protected: protectedItem(item), taskId: id };
    const manual = timed && item.schedulingState !== SCHEDULING.AUTO;
    return { ...base, kind: 'task', flexible: !manual || includeManual === true, manual, taskId: id };
  }, null);
}

function collectItems({ plan, tasks, events, blocks, dateIso, includeManual }) {
  const byId = new Map();
  const add = raw => {
    const item = describe(raw, includeManual);
    if (!item) return;
    if (item.date && item.date !== dateIso && item.kind !== 'event' && item.kind !== 'block' && item.kind !== 'virtual') return;
    if (!byId.has(item.id)) byId.set(item.id, item);
  };
  const list = value => (Array.isArray(value) ? value : EMPTY);
  for (const item of list(plan.timeline)) add(item);
  for (const item of list(plan.scheduled)) add(item);
  for (const item of list(plan.unscheduled)) add(item);
  for (const item of list(plan.completed)) add(item);
  for (const item of list(plan.flexibleRoutines)) add(item);
  for (const item of list(plan.fixedRoutines)) add(item);
  for (const item of list(plan.eventItems)) add(item);
  for (const item of list(plan.blocks)) add(item);
  for (const item of safe(() => eventItemsOnDate(events, dateIso), EMPTY)) add(item);
  for (const item of safe(() => blocksOnDate(blocks, dateIso), EMPTY)) add(item);
  for (const task of list(tasks)) {
    if (isObject(task) && safe(() => task.date === dateIso, false)) add(task);
  }
  return [...byId.values()].sort((a, b) =>
    (a.start ?? Infinity) - (b.start ?? Infinity) || compareIds(a.id, b.id));
}

/** Päällekkäiset esteet yhdistettyinä, alkuajan mukaan. */
function mergeIntervals(items) {
  const sorted = items
    .filter(item => item.timed && item.end > item.start)
    .map(item => ({ start: item.start, end: item.end, item }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start < last.end) {
      if (interval.end > last.end) last.end = interval.end;
      last.items.push(interval.item);
    } else {
      merged.push({ start: interval.start, end: interval.end, items: [interval.item] });
    }
  }
  return merged;
}

/** Esteiden läpi eteenpäin kulkeva sijoittaja: alku ei koskaan pienene, joten työ on lineaarista. */
function makePlacer(obstacles) {
  let pointer = 0;
  return (from, duration) => {
    let start = from;
    const jumped = [];
    while (pointer < obstacles.length && obstacles[pointer].end <= start) pointer += 1;
    let index = pointer;
    while (index < obstacles.length && obstacles[index].start < start + duration) {
      if (obstacles[index].end > start) {
        for (const item of obstacles[index].items) jumped.push(item);
        start = obstacles[index].end;
      }
      index += 1;
    }
    return { start, jumped };
  };
}

function inProgress(item, now) {
  return item.timed && !item.completed && item.start <= now && now < item.end;
}

// ------------------------------------------------------------ kohteen tunnistus

function targetStems(text) {
  const stems = new Set();
  for (const word of fold(text).split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 3 || TARGET_FILLER.has(word)) continue;
    stems.add(word);
    for (const suffix of TARGET_SUFFIXES) {
      if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
        const stem = word.slice(0, -suffix.length);
        stems.add(stem);
        if (stem.endsWith('i') && stem.length >= 5) stems.add(stem.slice(0, -1));
      }
    }
  }
  return [...stems];
}

function matchesTarget(item, stems) {
  const title = fold(item.title);
  const words = title.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return stems.some(stem => words.some(word => word.startsWith(stem) || (word.length >= 4 && stem.startsWith(word)))
    || (stem.length >= 4 && title.includes(stem)));
}

// ------------------------------------------------------------ muutokset

function slot(dateIso, start, end) {
  return Object.freeze({
    date: dateIso,
    time: start === null ? null : fromMinutes(start),
    endTime: end === null ? null : fromMinutes(end)
  });
}

/**
 * "Myöhemmin" (0015): ei keksittyä päivää. Tehtävä jää tallessa olevaksi
 * ilman päivää, kun seuraavilla päivillä ei ole tilaa.
 */
function laterSlot() {
  return Object.freeze({ date: null, time: null, endTime: null, horizon: 'LATER' });
}

function change(kind, item, from, to, reason, extra = {}) {
  return Object.freeze({
    kind,
    taskId: item.kind === 'task' ? item.id : null,
    routineOccurrenceId: item.kind === 'routine' ? item.id : null,
    routineId: item.kind === 'routine' ? item.routineId ?? null : null,
    title: item.title,
    from,
    to,
    reason,
    dstAdjusted: extra.dstAdjusted === true
  });
}

/** Ei mahdu tälle päivälle: tehtävä huomiselle, rutiinin kerta väliin. */
function overflowChange(item, dateIso) {
  const from = slot(dateIso, item.start, item.end);
  if (item.kind === 'routine') {
    return change(REPLAN_CHANGE.SKIP, item, from, null,
      'Ei mahdu enää tälle päivälle ennen lepoa. Tämän päivän kerta jää väliin; rutiini jatkuu normaalisti.');
  }
  const next = addDaysIso(dateIso, 1);
  return change(REPLAN_CHANGE.DEFER, item, from, slot(next, null, null),
    `Ei mahdu enää tälle päivälle ennen lepoa. Siirtyy päivälle ${endLabel(next)}.`);
}

/**
 * Ketjusiirto: kohteet, jotka alkavat ennen kursoria, siirtyvät sen perään
 * järjestyksessä ja kiinteiden esteiden yli. Heti kun väljyys riittää,
 * loput jäävät ennalleen.
 */
function ripple({ pending, cursor, place, dayEnd, dateIso, changes, reasonFor, leadReason = null }) {
  let current = cursor;
  let first = true;
  for (const item of pending) {
    if (item.start >= current) continue;
    const { start, jumped } = place(current, item.duration);
    if (start + item.duration > dayEnd) {
      changes.push(overflowChange(item, dateIso));
      continue;
    }
    // Ensimmäisen siirron syy on keskeytys itse, ei edellinen kohde.
    const reason = first && leadReason ? leadReason(item, start, jumped) : reasonFor(item, start, jumped);
    changes.push(change(REPLAN_CHANGE.SHIFT, item, slot(dateIso, item.start, item.end),
      slot(dateIso, start, start + item.duration), reason));
    current = start + item.duration;
    first = false;
  }
  return current;
}

function fixedStartingWithin(items, from, to) {
  return items.filter(item => item.timed && !item.flexible && !item.completed
    && (item.kind === 'event' || item.kind === 'task' || item.kind === 'routine')
    && item.start >= from && item.start < to);
}

function warningForFixed(item) {
  return `${item.title} klo ${clockOf(item.start)} on kiinteä, eikä sitä siirretä.`;
}

/**
 * Viimeinen ohitettu kiinteä meno lauseeseen "X pysyy paikallaan".
 * Lohkoa (matka, valmistautuminen) ei nimetä: se kuuluu menoon.
 */
function lastFixedNamed(jumped) {
  const named = jumped.filter(other => !other.flexible && other.kind !== 'block' && other.kind !== 'virtual');
  return named.length > 0 ? named[named.length - 1] : null;
}

function rippleReason(item, start, jumped) {
  const fixed = lastFixedNamed(jumped);
  const around = fixed ? ` ${fixed.title} pysyy paikallaan, joten ${item.title} tulee sen jälkeen.` : '';
  return `Siirtyy klo ${clockOf(start)}, jotta edellinen ehtii loppuun.${around}`;
}

// ------------------------------------------------------------ lähtö ja kiinteät alut
//
// MYÖHÄSTYMINEN EI OLE VAIN JOUSTAVIEN SIIRTOA. Kun keskeytys osuu menon
// lähtöketjuun (valmistautuminen, matka, pysäköinti, perilläolon etuaika)
// tai kiinteän kohteen alkuun, väljyys ei riitä, vaikka joustavaa
// siirrettävää ei olisi. Menoa, matkaa tai valmistautumista ei silti
// koskaan siirretä: tulos kertoo rehellisesti, milloin lähdet ja ehditkö.
//
// SÄÄNTÖ lähtömoottorin luvuilla (departure.js planDeparture: valmistautumisen
// alku, lähtö, perilläolotavoite, alku):
//
//   valmis        = nyt + myöhästyminen          (todellisina minuutteina)
//   lähdön siirto = myöhästyminen, jos valmistautuminen on jo alkanut;
//                   muuten max(0, valmis - valmistautumisen alku)
//                   (vapaa aika ennen valmistautumista imee loput)
//   uusi lähtö    = lähtö + siirto
//   uusi perillä  = perilläolotavoite + siirto   (matka ja kävely eivät lyhene)
//   myöhästyt     = uusi perillä - alku, jos > 0; muuten ehdit (alku - uusi perillä) ennen alkua
//
// Venymisessä ("tämä kestää vielä 30 min") olet varattu hetkeen `valmis`
// asti: ennen valmistautumista siirto on max(0, valmis - valmistautumisen
// alku), valmistautumisen aikana max(0, valmis - lähtö). Matkalla venymistä
// ei arvioida (lause ei silloin kerro, mikä venyy).
//
// Kiinteä kohde ilman tunnettua lähtöä (meno ilman paikkaa, itse ajastettu
// tehtävä, kiinteä rutiini), joka alkaa ennen hetkeä `valmis`: myöhästyt
// siitä (valmis - alku) minuuttia.

/** Päivän alusta laskettu seinäkellominuutti lähtömoottorin pisteelle {date, time}. */
function relMinutes(point, dateIso) {
  if (!isObject(point) || !isIsoDate(point.date) || !isTimeOfDay(point.time)) return null;
  const days = dayNumberOf(point.date) - dayNumberOf(dateIso);
  return Number.isInteger(days) && Math.abs(days) <= 1 ? days * MINUTES_PER_DAY + toMinutes(point.time) : null;
}

/** Lähtösuunnitelma (planDeparture) luvuiksi. null = tuntematon tai epäjohdonmukainen. */
function readDeparture(raw, dateIso) {
  return safe(() => {
    if (!isObject(raw) || raw.known !== true) return null;
    const prepare = relMinutes(raw.prepareStart, dateIso);
    const leave = relMinutes(raw.leave, dateIso);
    const arrival = relMinutes(raw.arrivalTarget, dateIso);
    const start = relMinutes(raw.eventStart, dateIso);
    if ([prepare, leave, arrival, start].some(value => value === null)) return null;
    if (!(prepare <= leave && leave <= arrival && arrival <= start)) return null;
    const id = typeof raw.occurrenceId === 'string' && raw.occurrenceId ? raw.occurrenceId : null;
    return { id, prepare, leave, arrival, start };
  }, null);
}

/** Todellinen minuuttiero kahden saman päivän seinäkelloajan välillä (kesäaikaturvallinen). */
function realBetween(dateIso, from, to, offsetMinutesFn) {
  if (typeof offsetMinutesFn === 'function' && from >= 0 && from < MINUTES_PER_DAY && to >= 0 && to < MINUTES_PER_DAY) {
    const a = safe(() => wallClockToEpoch(dateIso, fromMinutes(from), offsetMinutesFn), null);
    const b = safe(() => wallClockToEpoch(dateIso, fromMinutes(to), offsetMinutesFn), null);
    if (a && b) return Math.round((b.epochMs - a.epochMs) / MS_PER_MINUTE);
  }
  return to - from;
}

function impactText({ kind, title, start, plannedLeave, leave, arrival, shift, diff, leaveAhead }) {
  const head = `${title} klo ${clockOf(start)}:`;
  const late = diff > 0;
  if (kind === 'start') {
    return `${head} ehdit vasta noin klo ${clockOf(arrival)}, eli myöhästyt noin ${durationText(diff)}.`;
  }
  const outcome = late
    ? `eli myöhästyt noin ${durationText(diff)}.`
    : (diff === 0 ? 'juuri alkuun.' : `${durationText(-diff)} ennen alkua.`);
  if (leaveAhead) {
    const verb = late ? 'myöhästyy' : 'siirtyy';
    return `${head} lähtö ${verb} ${durationText(shift)}, lähdet noin klo ${clockOf(leave)} (suunniteltu klo ${clockOf(plannedLeave)}). `
      + (late
        ? `Ehdit perille noin klo ${clockOf(arrival)}, ${outcome} Lähde heti kun pääset, ja kerro tarvittaessa myöhästymisestä.`
        : `Ehdit silti perille noin klo ${clockOf(arrival)}, ${outcome}`);
  }
  return late
    ? `${head} olet perillä noin klo ${clockOf(arrival)}, ${outcome} Kerro tarvittaessa myöhästymisestä.`
    : `${head} olet silti perillä noin klo ${clockOf(arrival)}, ${outcome}`;
}

function impactOf(fields, now) {
  const leaveAhead = fields.leave !== null && fields.leave > now;
  return {
    data: Object.freeze({
      kind: fields.kind,
      id: fields.id,
      title: fields.title,
      startTime: fromMinutes(fields.start),
      plannedLeaveTime: fields.plannedLeave === null ? null : fromMinutes(fields.plannedLeave),
      leaveTime: fields.leave === null ? null : fromMinutes(fields.leave),
      arrivalTargetTime: fields.arrivalTarget === null ? null : fromMinutes(fields.arrivalTarget),
      arrivalTime: fromMinutes(fields.arrival),
      delayMinutes: fields.shift,
      late: fields.diff > 0,
      lateMinutes: Math.max(0, fields.diff),
      marginMinutes: Math.max(0, -fields.diff)
    }),
    text: impactText({ ...fields, leaveAhead })
  };
}

/**
 * Keskeytyksen vaikutus menojen lähtöihin ja kiinteiden kohteiden alkuihin.
 *
 * @param {object} ctx replanDay-konteksti (departures, items, now, dateIso, offsetMinutesFn, impacts)
 * @param {number} readyAt hetki, jolloin olet taas vapaa (päivän minuutteina)
 * @param {Function} shiftFor lähtö -> lähdön siirto minuutteina (0 = ei vaikutusta)
 * @param {Array} hits kiinteät kohteet, joiden alku osuu keskeytykseen (fixedStartingWithin)
 */
function recordImpacts(ctx, readyAt, shiftFor, hits) {
  const { departures, items, now, dateIso, offsetMinutesFn: tz, impacts } = ctx;
  const titles = new Map(items.filter(item => item.kind === 'event').map(item => [item.id, item.title]));
  const covered = new Set();
  const found = [];
  for (const raw of departures) {
    const departure = readDeparture(raw, dateIso);
    if (!departure || departure.start <= now) continue;
    const shift = safe(() => shiftFor(departure), 0);
    if (!Number.isInteger(shift) || shift <= 0) continue;
    const leave = addRealMinutes(dateIso, departure.leave, shift, tz).minutes;
    const arrival = addRealMinutes(dateIso, departure.arrival, shift, tz).minutes;
    if (departure.id) covered.add(departure.id);
    found.push(impactOf({
      kind: 'departure', id: departure.id, title: titles.get(departure.id) || 'Meno', start: departure.start,
      plannedLeave: departure.leave, leave, arrivalTarget: departure.arrival, arrival, shift,
      diff: realBetween(dateIso, departure.start, arrival, tz)
    }, now));
  }
  for (const item of hits) {
    // Herätys ei ole kohde, josta "myöhästytään".
    if (covered.has(item.id) || (item.source && item.source.isWake === true)) continue;
    const diff = realBetween(dateIso, item.start, readyAt, tz);
    if (diff <= 0) continue;
    found.push(impactOf({
      kind: 'start', id: item.id, title: item.title, start: item.start,
      plannedLeave: null, leave: null, arrivalTarget: null, arrival: readyAt, shift: diff, diff
    }, now));
  }
  found.sort((a, b) => compareIds(a.data.startTime, b.data.startTime) || compareIds(a.data.id, b.data.id));
  for (const entry of found) impacts.push(entry);
}

// ------------------------------------------------------------ keskeytykset

function runningLate(ctx) {
  const { interruption, now, items, dateIso, dayEnd, offsetMinutesFn, changes, warnings, preserved } = ctx;
  const minutes = interruption.minutes;
  if (minutes === null) {
    return { question: 'Kuinka monta minuuttia olet myöhässä?' };
  }
  const flexibleTimed = items.filter(item => item.flexible && item.timed && !item.completed);
  const anchor = flexibleTimed
    .filter(item => inProgress(item, now))
    .sort((a, b) => b.start - a.start || compareIds(a.id, b.id))[0] || null;

  const moving = new Set(flexibleTimed.filter(item => item === anchor || item.start >= now).map(item => item.id));
  const obstacles = mergeIntervals(items.filter(item => !moving.has(item.id) && !item.completed && !(item.kind === 'virtual' && item.sleep)));
  const place = makePlacer(obstacles);

  let cursor;
  if (anchor) {
    const shifted = addRealMinutes(dateIso, anchor.start, minutes, offsetMinutesFn);
    const { start, jumped } = place(shifted.minutes, anchor.duration);
    if (start + anchor.duration > dayEnd) {
      changes.push(overflowChange(anchor, dateIso));
      cursor = shifted.minutes;
    } else {
      const fixed = lastFixedNamed(jumped);
      const around = fixed ? ` ${fixed.title} pysyy paikallaan.` : '';
      changes.push(change(REPLAN_CHANGE.SHIFT, anchor, slot(dateIso, anchor.start, anchor.end),
        slot(dateIso, start, start + anchor.duration),
        `Aikataulu on ${minutes} min jäljessä: alkaa klo ${clockOf(start)}.${around}${shifted.dstAdjusted ? ' Kellojen siirto on otettu huomioon.' : ''}`,
        { dstAdjusted: shifted.dstAdjusted }));
      cursor = start + anchor.duration;
    }
  } else {
    cursor = addRealMinutes(dateIso, now, minutes, offsetMinutesFn).minutes;
  }

  const pending = flexibleTimed.filter(item => item !== anchor && item.start >= now);
  ripple({
    pending, cursor, place, dayEnd, dateIso, changes, reasonFor: rippleReason,
    leadReason: anchor ? null : (item, start) => `Aikataulu on ${minutes} min jäljessä: alkaa klo ${clockOf(start)}.`
  });

  const readyAt = addRealMinutes(dateIso, now, minutes, offsetMinutesFn).minutes;
  const hits = fixedStartingWithin(items, now, readyAt);
  for (const item of hits) warnings.push(warningForFixed(item));
  // Lähtö ja kiinteät alut: ks. "lähtö ja kiinteät alut" yllä. Alkanut
  // valmistautuminen siirtää lähtöä koko myöhästymisen verran; muuten vain
  // se osa, jota vapaa aika ennen valmistautumista ei ime.
  recordImpacts(ctx, readyAt, departure => (now >= departure.prepare
    ? minutes
    : Math.min(minutes, Math.max(0, realBetween(dateIso, departure.prepare, readyAt, offsetMinutesFn)))), hits);
  for (const item of items) if (inProgress(item, now) && item !== anchor) preserved.add(item.id);
  return {};
}

function extendCurrent(ctx) {
  const { interruption, now, items, dateIso, dayEnd, offsetMinutesFn, changes, warnings, preserved } = ctx;
  const minutes = interruption.minutes;
  if (minutes === null) return { question: 'Kuinka paljon lisäaikaa tarvitset?' };

  const running = items.filter(item => inProgress(item, now) && item.kind !== 'virtual');
  const stems = interruption.targetText ? targetStems(interruption.targetText) : [];
  const preferred = stems.length > 0 ? running.filter(item => matchesTarget(item, stems)) : [];
  const rank = item => (item.kind === 'block' ? 2 : item.kind === 'event' ? 1 : 0);
  const current = (preferred.length > 0 ? preferred : running)
    .sort((a, b) => rank(a) - rank(b) || b.start - a.start || compareIds(a.id, b.id))[0] || null;

  const newEnd = addRealMinutes(dateIso, now, minutes, offsetMinutesFn);
  const flexibleTimed = items.filter(item => item.flexible && item.timed && !item.completed);
  const pending = flexibleTimed.filter(item => item !== current && item.start >= now);
  const moving = new Set(pending.map(item => item.id));
  if (current) moving.add(current.id);
  const obstacles = mergeIntervals(items.filter(item => !moving.has(item.id) && !item.completed && !(item.kind === 'virtual' && item.sleep)));
  const place = makePlacer(obstacles);

  // Kiinteät kohteet, joiden alkuun venyminen osuu (samat kuin varoituksissa).
  let hits = EMPTY;
  if (current && current.flexible) {
    if (newEnd.minutes > current.end) {
      const end = Math.min(newEnd.minutes, dayEnd);
      changes.push(change(REPLAN_CHANGE.EXTEND, current, slot(dateIso, current.start, current.end),
        slot(dateIso, current.start, end),
        `Kestää vielä ${durationText(minutes)}: loppuu klo ${clockOf(end)}.${newEnd.dstAdjusted ? ' Kellojen siirto on otettu huomioon.' : ''}`,
        { dstAdjusted: newEnd.dstAdjusted }));
      if (newEnd.minutes > dayEnd) warnings.push(`${current.title} venyy lepoon asti.`);
      hits = fixedStartingWithin(items, current.end, newEnd.minutes);
      for (const item of hits) warnings.push(warningForFixed(item));
    } else {
      // Varattu aika riittää jo: mitään ei tarvitse siirtää.
      warnings.push(`${current.title} on varattu klo ${clockOf(current.end)} asti, joten aikaa on jo tarpeeksi.`);
      for (const item of items) if (inProgress(item, now)) preserved.add(item.id);
      return {};
    }
  } else if (current) {
    preserved.add(current.id);
    warnings.push(`${current.title} on kiinteä, eikä sen aikaa muuteta. Seuraavat joustavat kohteet siirtyvät tarvittaessa.`);
    hits = fixedStartingWithin(items, now, newEnd.minutes).filter(item => item !== current);
    for (const item of hits) warnings.push(warningForFixed(item));
  }
  // Lähtö: olet varattu hetkeen newEnd asti. Ennen valmistautumista lähtö
  // siirtyy sen verran kuin varaus ylittää valmistautumisen alun,
  // valmistautumisen aikana sen verran kuin se ylittää lähdön. Matkalla
  // venymistä ei arvioida.
  recordImpacts(ctx, newEnd.minutes, departure => {
    if (now >= departure.leave) return 0;
    const from = now < departure.prepare ? departure.prepare : departure.leave;
    return Math.max(0, realBetween(dateIso, from, newEnd.minutes, offsetMinutesFn));
  }, hits);

  const busyUntil = clockOf(newEnd.minutes);
  ripple({
    pending, cursor: newEnd.minutes, place, dayEnd, dateIso, changes, reasonFor: rippleReason,
    leadReason: current && current.flexible
      ? null
      : (item, start) => `Olet varattu klo ${busyUntil} asti: alkaa klo ${clockOf(start)}.`
  });
  for (const item of items) if (inProgress(item, now) && item !== current) preserved.add(item.id);
  return {};
}

function skipItem(ctx) {
  const { interruption, now, items, dateIso, todayIso, changes, warnings } = ctx;
  if (interruption.onDate && interruption.onDate !== todayIso) {
    return { summary: `Ohitus koskee päivää ${endLabel(interruption.onDate)}. Tämän päivän suunnitelma pysyy ennallaan.` };
  }
  const open = items.filter(item => !item.completed && item.kind !== 'virtual' && item.kind !== 'block');
  let matches;
  if (interruption.targetId) {
    // Valinta (kortin painike tai puheen valintadialogi) kulkee tunnisteena:
    // kaksi samaan sanaan osuvaa kohdetta ei jää kiertämään kysymystä.
    matches = open.filter(item => item.id === interruption.targetId);
    if (matches.length === 0) {
      return {
        question: 'Mikä jää väliin?',
        candidates: open.filter(item => item.flexible).slice(0, 5),
        summary: 'Valittua kohdetta ei enää löytynyt tämän päivän suunnitelmasta. Päivän suunnitelma pysyy ennallaan.'
      };
    }
  } else if (interruption.targetText) {
    const stems = targetStems(interruption.targetText);
    matches = stems.length > 0 ? open.filter(item => matchesTarget(item, stems)) : [];
    if (matches.length === 0) {
      const choices = open.filter(item => item.flexible).slice(0, 5);
      return {
        question: 'Mikä jää väliin?',
        candidates: choices,
        summary: `Tämän päivän suunnitelmasta ei löytynyt kohdetta "${interruption.targetText}".`
      };
    }
  } else {
    const running = Number.isInteger(now) ? open.filter(item => inProgress(item, now)) : [];
    const upcoming = Number.isInteger(now)
      ? open.filter(item => item.flexible && item.timed && item.start >= now).slice(0, 1)
      : [];
    matches = running.length > 0 ? running : upcoming;
    if (matches.length === 0) return { question: 'Mikä jää väliin?', candidates: open.filter(item => item.flexible).slice(0, 5) };
  }

  const flexible = matches.filter(item => item.flexible);
  if (flexible.length === 0) {
    for (const item of matches) warnings.push(`${item.title} on kiinteä, eikä sitä ohiteta automaattisesti. Muuta sitä kalenterista, jos se ei toteudu.`);
    return {};
  }
  if (flexible.length > 1) {
    const names = flexible.slice(0, 5).map(item => item.title);
    return {
      question: `Mikä näistä jää väliin: ${names.slice(0, -1).join(', ')} vai ${names[names.length - 1]}?`,
      candidates: flexible.slice(0, 5)
    };
  }

  const [item] = flexible;
  const from = slot(dateIso, item.start, item.end);
  if (item.kind === 'routine') {
    changes.push(change(REPLAN_CHANGE.SKIP, item, from, null, 'Tämän päivän kerta jää väliin. Rutiini jatkuu normaalisti.'));
  } else if (item.timed) {
    changes.push(change(REPLAN_CHANGE.SKIP, item, from, slot(dateIso, null, null),
      'Aika vapautuu. Tehtävä jää tämän päivän listalle ilman kellonaikaa.'));
  } else {
    // L0: kohdepäivän tila tarkistetaan (sama valitsin kuin loppujen siirrossa).
    deferWithCapacity(ctx, item, from, 'Ei tälle päivälle.', capacityMapOf(ctx));
  }
  return {};
}

/**
 * Tulevien päivien vapaa aika (päivä -> minuutit tai null = ei tiedossa).
 * Kutsuja antaa päivät (dayReplanActions.horizonDays); ilman niitä tila on
 * tuntematon.
 */
function capacityMapOf(ctx) {
  const capacity = new Map();
  const dayList = (Array.isArray(ctx.days) ? ctx.days : EMPTY)
    .filter(day => isObject(day) && safe(() => isIsoDate(day.date) && day.date > ctx.todayIso, false))
    .sort((a, b) => compareIds(a.date, b.date));
  for (const day of dayList) if (!capacity.has(day.date)) capacity.set(day.date, capacityOf(day));
  return capacity;
}

/**
 * Siirrä joustava tehtävä ensimmäiselle päivälle, jolle se MAHTUU
 * (kapasiteettijarru, L0/L5). Jos yksikään päivä ei riitä:
 *   - päivätön "Myöhemmin" sallittu (0015) -> tehtävä jää tallessa ilman päivää
 *   - muuten tehtävää EI siirretä täydelle päivälle; varoitus kertoo sen
 * Täyttä päivää ei koskaan kasvateta hiljaa.
 */
function deferWithCapacity(ctx, item, from, lead, capacity) {
  const { changes, warnings, todayIso } = ctx;
  const need = item.duration ?? DEFAULT_TASK_MINUTES;
  const deadlineNote = date => (item.deadline && item.deadline < date
    ? ` Huom: määräaika on ${endLabel(item.deadline)}.` : '');
  if (capacity.size === 0) {
    // Tila ei ole tiedossa (kutsuja ei antanut päiviä): seuraava päivä kuten ennen.
    const next = addDaysIso(todayIso, 1);
    changes.push(change(REPLAN_CHANGE.DEFER, item, from, slot(next, null, null),
      `${lead} Siirtyy päivälle ${endLabel(next)}.${deadlineNote(next)}`.trim()));
    return;
  }
  let chosen = null;
  let unknownCapacity = false;
  for (const [date, free] of capacity) {
    if (item.deadline && date > item.deadline) break;
    if (free === null) { chosen = date; unknownCapacity = true; break; }
    if (free >= need) { chosen = date; break; }
  }
  if (chosen) {
    const free = capacity.get(chosen);
    if (free !== null) capacity.set(chosen, free - need);
    changes.push(change(REPLAN_CHANGE.DEFER, item, from, slot(chosen, null, null),
      `${lead} Siirtyy päivälle ${unknownCapacity ? endLabel(chosen) : `${shortDateLabel(chosen)}, jolle ${durationText(need)} vielä mahtuu`}.`.trim()));
    return;
  }
  if (ctx.laterAllowed) {
    changes.push(change(REPLAN_CHANGE.DEFER, item, from, laterSlot(),
      `${lead} Seuraavina päivinä ei ole tilaa, joten se siirtyy tallessa olevaksi ilman päivää (Myöhemmin).`.trim()));
    return;
  }
  warnings.push(`${item.title}: seuraavina päivinä ei ole tilaa ${durationText(need)} tehtävälle, joten sitä ei siirretty täydelle päivälle. Valitse itse, mikä jää pois.`);
}

function capacityOf(day) {
  for (const key of ['usableMinutes', 'freeMinutes', 'capacityMinutes']) {
    const value = day[key];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  }
  return null;
}

function deferRemaining(ctx) {
  const { interruption, now, items, dateIso, todayIso, changes, warnings, preserved } = ctx;
  const known = Number.isInteger(now);
  const remaining = items.filter(item => item.kind === 'task' && item.flexible && !item.completed
    && (!item.timed || !known || item.start >= now));
  for (const item of items) if (known && inProgress(item, now)) preserved.add(item.id);
  if (remaining.length === 0) return { summary: 'Siirrettävää ei ole jäljellä. Päivän suunnitelma pysyy ennallaan.' };

  const ordered = [...remaining].sort((a, b) =>
    compareIds(a.deadline ?? '9999-99-99', b.deadline ?? '9999-99-99')
    || priorityWeight(a.priority) - priorityWeight(b.priority)
    || (a.start ?? Infinity) - (b.start ?? Infinity)
    || a.title.localeCompare(b.title, 'fi')
    || compareIds(a.id, b.id));

  const explicit = isIsoDate(interruption.toDate) && interruption.toDate > todayIso ? interruption.toDate : null;
  const capacity = capacityMapOf(ctx);

  for (const item of ordered) {
    const from = slot(dateIso, item.start, item.end);
    const deadlineNote = date => (item.deadline && item.deadline < date
      ? ` Huom: määräaika on ${endLabel(item.deadline)}.` : '');
    if (explicit) {
      changes.push(change(REPLAN_CHANGE.DEFER, item, from, slot(explicit, null, null),
        `Siirtyy päivälle ${endLabel(explicit)}.${deadlineNote(explicit)}`));
      continue;
    }
    if (item.deadline && item.deadline <= todayIso) {
      warnings.push(`${item.title}: määräaika on ${item.deadline === todayIso ? 'tänään' : 'jo mennyt'}, joten sitä ei siirretty.`);
      continue;
    }
    // L0: kohdepäivän tila tarkistetaan; täyttä päivää ei kasvateta.
    deferWithCapacity(ctx, item, from, '', capacity);
  }
  return {};
}

// ------------------------------------------------------------ yhteenveto

function summaryFor(kind, changes, minutes, impacts = EMPTY) {
  const counts = { shift: 0, extend: 0, skip: 0, defer: 0 };
  for (const entry of changes) counts[entry.kind] += 1;
  // Lähdön ja kiinteän alun myöhästyminen ensin: se on vastauksen tärkein
  // tieto, eikä "väljyys riittää" saa koskaan peittää sitä.
  const parts = impacts.map(entry => entry.text);
  if (counts.extend > 0) parts.push(`Nykyinen kohde jatkuu ${durationText(minutes)}.`);
  if (counts.shift > 0) parts.push(`${counts.shift} ${counts.shift === 1 ? 'joustava kohde siirtyy' : 'joustavaa kohdetta siirtyy'} myöhemmäksi.`);
  if (counts.skip > 0) parts.push(`${counts.skip} ${counts.skip === 1 ? 'kohde jää' : 'kohdetta jää'} tältä päivältä väliin.`);
  if (counts.defer > 0) {
    const dates = [...new Set(changes.filter(entry => entry.kind === REPLAN_CHANGE.DEFER).map(entry => entry.to.date))].sort();
    parts.push(`${counts.defer} ${counts.defer === 1 ? 'tehtävä siirtyy' : 'tehtävää siirtyy'} ${dates.length === 1 ? `päivälle ${endLabel(dates[0])}` : 'seuraaville päiville'}.`);
  }
  if (parts.length === 0) {
    parts.push(kind === INTERRUPTION_KIND.RUNNING_LATE || kind === INTERRUPTION_KIND.EXTEND_CURRENT
      ? 'Mitään ei tarvitse siirtää: väljyys riittää.'
      : 'Päivän suunnitelma pysyy ennallaan.');
  }
  // Myöhästyvä lähtö ei "pysy ennallaan": menoa, matkaa ja lepoa ei silti siirretä.
  parts.push(impacts.length > 0
    ? 'Menoja ei siirretä: kiinteät menot, suojattu lepo ja tehdyt asiat pysyvät ennallaan.'
    : 'Kiinteät menot, matkat, suojattu lepo ja tehdyt asiat pysyvät ennallaan.');
  return parts.join(' ');
}

function finalize({ kind, changes, untouched, preserved, warnings, question = null, candidates = EMPTY, summary, impacts = EMPTY }) {
  const sortedChanges = [...changes].sort((a, b) =>
    compareIds(a.from.time ?? '99:99', b.from.time ?? '99:99')
    || compareIds(a.taskId ?? a.routineOccurrenceId, b.taskId ?? b.routineOccurrenceId));
  return Object.freeze({
    kind,
    changes: Object.freeze(sortedChanges),
    untouched: Object.freeze([...untouched].sort(compareIds)),
    preserved: Object.freeze([...preserved].sort(compareIds)),
    warnings: Object.freeze([...new Set(warnings)]),
    question,
    candidates: Object.freeze(candidates.map(item => Object.freeze({
      id: item.id,
      title: item.title,
      taskId: item.kind === 'task' ? item.id : null,
      routineOccurrenceId: item.kind === 'routine' ? item.id : null
    }))),
    summary,
    /** Myöhästyvät lähdöt ja kiinteät alut (ks. "lähtö ja kiinteät alut"). Tieto, ei muutos. */
    impacts: Object.freeze(impacts.map(entry => entry.data)),
    requiresConfirmation: true
  });
}

function emptyResult(kind, summary, question = null) {
  return finalize({ kind, changes: [], untouched: [], preserved: [], warnings: [], question, summary });
}

// ------------------------------------------------------------ API

/**
 * Ehdota päivän muutokset keskeytyksen jälkeen.
 *
 * @param {object} input
 * @param {object} input.plan          buildDayPlan-tulos (timeline, unscheduled, flexibleRoutines, range, dateIso ...)
 * @param {object} input.interruption  parseInterruption-tulos {kind, minutes, targetText, targetId?, toDate?, onDate?}
 *                                     (targetId = aiemman tuloksen candidates[].id; ohitus käyttää sitä tekstin sijaan)
 * @param {number} input.nowMinutes    nykyhetki minuutteina keskiyöstä (seinäkello)
 * @param {string} input.todayIso      tämä päivä
 * @param {Array}  [input.tasks]       kaikki tehtävät (täydentää suunnitelmaa)
 * @param {Array}  [input.events]      tapahtumaesiintymät (kiinteitä)
 * @param {Array}  [input.blocks]      suojatut lohkot (kiinteitä)
 * @param {Array}  [input.days]        loppujen siirtoon: [{date, usableMinutes|freeMinutes|null}]
 * @param {Function} [input.offsetMinutesFn] aikavyöhyke (wallClock.js) kesäajan vaihtoöitä varten
 * @param {boolean} [input.includeManual] salli myös itse ajastettujen tehtävien siirto (oletus false)
 * @returns {{kind, changes, untouched, preserved, warnings, question, candidates, summary, requiresConfirmation:true}}
 */
export function replanDay(input = {}) {
  const args = isObject(input) ? input : {};
  const interruption = isObject(args.interruption) ? args.interruption : null;
  const kind = interruption && INTERRUPTION_KINDS.includes(interruption.kind) ? interruption.kind : null;
  if (!kind) return emptyResult(null, 'Keskeytystä ei tunnistettu. Päivän suunnitelma pysyy ennallaan.');

  const todayIso = isIsoDate(args.todayIso) ? args.todayIso : null;
  const plan = isObject(args.plan) ? args.plan : null;
  const dateIso = plan && isIsoDate(plan.dateIso) ? plan.dateIso : todayIso;
  if (!todayIso || !dateIso) return emptyResult(kind, 'Päivää ei tunnistettu. Päivän suunnitelma pysyy ennallaan.');
  if (dateIso !== todayIso) {
    return emptyResult(kind, 'Keskeytys koskee vain tätä päivää. Muiden päivien suunnitelma pysyy ennallaan.');
  }

  const nowRaw = args.nowMinutes;
  const now = Number.isInteger(nowRaw) && nowRaw >= 0 && nowRaw < MINUTES_PER_DAY ? nowRaw : null;
  const needsNow = kind === INTERRUPTION_KIND.RUNNING_LATE || kind === INTERRUPTION_KIND.EXTEND_CURRENT;
  if (needsNow && now === null) return emptyResult(kind, 'Nykyhetkeä ei tunnistettu. Päivän suunnitelma pysyy ennallaan.');

  const cleanInterruption = {
    kind,
    minutes: validMinutes(interruption.minutes),
    targetText: typeof interruption.targetText === 'string' && interruption.targetText.trim() ? interruption.targetText.trim() : null,
    // Valitun kohteen tunniste (ks. candidates). Ohituksessa se voittaa tekstin.
    targetId: cleanId(interruption.targetId),
    toDate: isIsoDate(interruption.toDate) ? interruption.toDate : null,
    onDate: isIsoDate(interruption.onDate) ? interruption.onDate : null
  };

  const items = collectItems({
    plan: plan || {}, tasks: args.tasks, events: args.events, blocks: args.blocks, dateIso,
    includeManual: args.includeManual === true
  });
  const range = plan && isObject(plan.range) ? plan.range : null;
  const dayEnd = range && Number.isFinite(range.end) && range.end > 0 ? Math.min(range.end, MINUTES_PER_DAY) : MINUTES_PER_DAY;

  const untouched = new Set(items
    .filter(item => item.kind !== 'virtual' && !item.flexible && !item.completed)
    .map(item => item.id));
  const preserved = new Set(items.filter(item => item.completed).map(item => item.id));
  const changes = [];
  const warnings = [];
  const impacts = [];
  const ctx = {
    interruption: cleanInterruption, now, items, dateIso, todayIso, dayEnd, days: args.days,
    // 0015: saako täysien päivien tehtävän siirtää "Myöhemmin" ilman päivää.
    laterAllowed: args.laterAllowed === true,
    offsetMinutesFn: typeof args.offsetMinutesFn === 'function' ? args.offsetMinutesFn : null,
    // Lähtömoottorin suunnitelmat (planDeparture); ilman niitä lähtöä ei arvioida.
    departures: Array.isArray(args.departures) ? args.departures : EMPTY,
    changes, warnings, preserved, impacts
  };

  const handlers = {
    [INTERRUPTION_KIND.RUNNING_LATE]: runningLate,
    [INTERRUPTION_KIND.EXTEND_CURRENT]: extendCurrent,
    [INTERRUPTION_KIND.SKIP_ITEM]: skipItem,
    [INTERRUPTION_KIND.DEFER_REMAINING]: deferRemaining
  };
  const outcome = handlers[kind](ctx) || {};

  // Muuttuva kohde ei ole "säilytetty", ja kiinteä on jo listassa untouched.
  for (const entry of changes) preserved.delete(entry.taskId ?? entry.routineOccurrenceId);
  for (const id of untouched) preserved.delete(id);

  return finalize({
    kind,
    changes,
    untouched,
    preserved,
    warnings,
    question: outcome.question ?? null,
    candidates: outcome.candidates ?? EMPTY,
    impacts,
    summary: outcome.summary ?? (outcome.question && changes.length === 0
      ? `${outcome.question} Päivän suunnitelma pysyy ennallaan, kunnes kerrot.`
      : summaryFor(kind, changes, cleanInterruption.minutes, impacts))
  });
}
