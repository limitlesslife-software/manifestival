// Avoimet asiat ja asioinnit: milloin hoitaa, ja mitä voi hoitaa samalla reissulla.
//
// PUHDAS MODUULI. Ei kelloa (tämä päivä annetaan), ei DOM:ia, ei verkkoa,
// ei satunnaisuutta. Sama syöte tuottaa aina saman, jäädytetyn tuloksen.
//
// =====================================================================
// VAIN SUUNNITELLUISTA MENOISTA, EI SIJAINNISTA
// =====================================================================
//
// "Olet jo menossa torstaina lähelle paikkaa Motonet" perustuu vain
// kalenterin menoihin (tapahtumaesiintymät, joilla on paikka tai alue) ja
// tallennettujen paikkojen alueteksteihin. Sijaintia ei lueta, eikä
// kuljettuja reittejä tai koordinaatteja käytetä -- niitä ei ole.
//
// EHDOTUKSIA, EI PÄÄTÖKSIÄ: mikään tässä ei siirrä eikä luo mitään.
//
// Avoin asia (ei kellonaikaa) sijoitetaan
//   1. päivälle, jona olet jo menossa samaan paikkaan tai samalle alueelle
//      (heti menon jälkeen, kun vapaata aikaa on),
//   2. muuten ensimmäiseen vapaaseen väliin,
// aina ennen määräaikaa ja päivän kuorman rajoissa. Tuntematon kesto ei
// ole nolla: varataan aikataulumoottorin oletuskesto ja sanotaan se ääneen.

import { isIsoDate, isTimeOfDay, toMinutes, fromMinutes, durationOf } from './task.js';
import { addDaysIso, weekdayOfIso } from './fiTemporal.js';
import { clockText } from './wallClock.js';
import { shortDateLabel } from './calendar.js';
import { DEFAULT_TASK_MINUTES } from './scheduler.js';

export const NEARBY = Object.freeze({
  /** Meno samassa tallennetussa paikassa. */
  SAME_PLACE: 'same_place',
  /** Meno toisessa paikassa samalla alueella. */
  SAME_AREA: 'same_area'
});

/** Vaihtoehtoja ehdotuksen lisäksi. */
export const MAX_ERRAND_ALTERNATIVES = 3;
/** Menon jälkeen asia hoidetaan "samalla", jos se alkaa tämän ajan sisällä. */
export const MAX_TRIP_GAP_MINUTES = 180;
/** Oletushorisontti, kun viikon loppua ei anneta: tämä päivä + 6. */
export const DEFAULT_HORIZON_DAYS = 7;

const EMPTY = Object.freeze([]);
const WEEKDAY_ESSIVE = Object.freeze(['', 'maanantaina', 'tiistaina', 'keskiviikkona', 'torstaina', 'perjantaina',
  'lauantaina', 'sunnuntaina']);
const NEARBY_RANK = Object.freeze({ [NEARBY.SAME_PLACE]: 2, [NEARBY.SAME_AREA]: 1 });

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

function compareText(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function pushTo(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Aikaisin meno, joka ehtii ennen määräaikaa. Lista on päiväjärjestyksessä, joten ensimmäinen ratkaisee. */
function earliestWithin(list, deadline) {
  const first = list && list.length > 0 ? list[0] : null;
  return first && (deadline === null || first.date <= deadline) ? first : null;
}

function fold(value) {
  return typeof value === 'string'
    ? value.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('fi')
    : '';
}

function cleanLabel(value) {
  return typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ') : null;
}

function validDuration(value) {
  return Number.isInteger(value) && value >= 1 && value <= 1440 ? value : null;
}

/** 'tänään', 'huomenna' tai 'torstaina 1.10.' */
function dayPhrase(dateIso, todayIso) {
  if (dateIso === todayIso) return 'tänään';
  if (dateIso === addDaysIso(todayIso, 1)) return 'huomenna';
  const [, month, day] = dateIso.split('-').map(Number);
  return `${WEEKDAY_ESSIVE[weekdayOfIso(dateIso)]} ${day}.${month}.`;
}

function clockOf(minutes) {
  return clockText(fromMinutes(minutes));
}

// ------------------------------------------------------------ paikat

function indexPlaces(places) {
  const byId = new Map();
  const byName = new Map();
  const byArea = new Map();
  for (const place of Array.isArray(places) ? places : EMPTY) {
    safe(() => {
      if (!isObject(place) || typeof place.id !== 'string' || !place.id || byId.has(place.id)) return;
      const name = cleanLabel(place.name);
      const areaLabel = cleanLabel(place.area);
      const entry = { id: place.id, name, nameKey: fold(name), area: fold(areaLabel), areaLabel };
      byId.set(place.id, entry);
      if (entry.nameKey) pushTo(byName, entry.nameKey, entry);
      if (entry.area && !byArea.has(entry.area)) byArea.set(entry.area, areaLabel);
    }, null);
  }
  return { byId, byName, byArea };
}

/**
 * Asian paikka: tallennettu paikka tunnisteella tai täsmälleen nimellä,
 * muuten alue, jos teksti on jonkin paikan alue. Arvausta ei tehdä.
 */
function errandPlaceOf(task, index) {
  const placeId = typeof task.placeId === 'string' ? task.placeId : null;
  if (placeId && index.byId.has(placeId)) {
    const place = index.byId.get(placeId);
    return { placeId, name: place.name, area: place.area || null, areaLabel: place.areaLabel };
  }
  const text = fold(task.placeText);
  if (!text) return null;
  const named = index.byName.get(text) || EMPTY;
  if (named.length === 1) {
    const [place] = named;
    return { placeId: place.id, name: place.name, area: place.area || null, areaLabel: place.areaLabel };
  }
  if (index.byArea.has(text)) return { placeId: null, name: null, area: text, areaLabel: index.byArea.get(text) };
  return null;
}

function tripOf(trip, index) {
  if (!isObject(trip)) return null;
  return safe(() => {
    if (!isIsoDate(trip.date) || trip.id == null || String(trip.id) === '') return null;
    const placeId = typeof trip.placeId === 'string' ? trip.placeId : null;
    const place = placeId ? index.byId.get(placeId) || null : null;
    const areaLabel = cleanLabel(trip.area) || (place ? place.areaLabel : null);
    const timed = trip.allDay !== true && isTimeOfDay(trip.time);
    const start = timed ? toMinutes(trip.time) : null;
    return {
      id: String(trip.id),
      date: trip.date,
      title: cleanLabel(trip.title) || 'Meno',
      placeId,
      placeName: place ? place.name : cleanLabel(trip.locationText),
      area: fold(areaLabel) || null,
      areaLabel,
      start,
      end: timed ? start + (durationOf(trip) ?? DEFAULT_TASK_MINUTES) : null
    };
  }, null);
}

function nearbyKind(errand, trip) {
  if (!errand) return null;
  if (errand.placeId && trip.placeId === errand.placeId) return NEARBY.SAME_PLACE;
  if (errand.area && trip.area === errand.area) return NEARBY.SAME_AREA;
  return null;
}

function compareTrips(a, b) {
  return compareText(a.date, b.date)
    || (a.start ?? -1) - (b.start ?? -1)
    || compareText(a.id, b.id);
}

function tripClock(trip) {
  return trip.start === null ? '' : ` klo ${clockOf(trip.start)}`;
}

function nearbySentence(kind, errand, trip, when) {
  if (kind === NEARBY.SAME_PLACE) {
    return `Olet jo menossa ${when} paikkaan ${errand.name} (${trip.title}${tripClock(trip)}).`;
  }
  if (errand.name) {
    return `Olet jo menossa ${when} lähelle paikkaa ${errand.name}: ${trip.title}${tripClock(trip)} on samalla alueella (${trip.areaLabel || errand.areaLabel}).`;
  }
  return `Olet jo menossa ${when} alueelle ${errand.areaLabel} (${trip.title}${tripClock(trip)}).`;
}

// ------------------------------------------------------------ päivät

function slotsOf(day) {
  const slots = [];
  for (const raw of Array.isArray(day.freeSlots) ? day.freeSlots : EMPTY) {
    safe(() => {
      if (!isObject(raw)) return;
      let start = Number.isInteger(raw.start) ? raw.start : (isTimeOfDay(raw.startTime) ? toMinutes(raw.startTime) : null);
      let end = Number.isInteger(raw.end) ? raw.end : (isTimeOfDay(raw.endTime) ? toMinutes(raw.endTime) : null);
      if (start === null || end === null) return;
      start = Math.max(0, start);
      end = Math.min(1440, end === 0 && start > 0 ? 1440 : end);
      if (end > start) slots.push({ start, end });
    }, null);
  }
  return slots.sort((a, b) => a.start - b.start || a.end - b.end);
}

function dayOf(day) {
  if (!isObject(day)) return null;
  return safe(() => {
    if (!isIsoDate(day.date)) return null;
    let capacity = null;
    for (const key of ['usableMinutes', 'freeMinutes', 'capacityMinutes']) {
      if (typeof day[key] === 'number' && Number.isFinite(day[key])) {
        capacity = Math.max(0, day[key]);
        break;
      }
    }
    const lifeAreaIds = new Set((Array.isArray(day.lifeAreaIds) ? day.lifeAreaIds : EMPTY).filter(id => typeof id === 'string'));
    return { date: day.date, slots: slotsOf(day), capacity, lifeAreaIds };
  }, null);
}

/** Tänään mennyttä aikaa ei ehdoteta: välit alkavat aikaisintaan nyt (viiteen minuuttiin pyöristettynä). */
function cutSlots(slots, cutoff) {
  if (cutoff === null) return slots;
  return slots
    .map(slot => ({ start: Math.max(slot.start, cutoff), end: slot.end }))
    .filter(slot => slot.end > slot.start);
}

function firstFit(slots, need, notBefore = 0, maxStart = Infinity) {
  for (const slot of slots) {
    const start = Math.max(slot.start, notBefore);
    if (start > maxStart) return null;
    if (start + need <= slot.end) return start;
  }
  return null;
}

// ------------------------------------------------------------ API

/**
 * Ehdota aikaa avoimelle asialle (ei kellonaikaa).
 *
 * @param {object} input
 * @param {object} input.task      {id?, title, durationMinutes|null, deadline|null, placeId|null, placeText|null, lifeAreaId|null}
 * @param {Array}  input.days      [{date, freeSlots:[{start,end}|{startTime,endTime}], usableMinutes|null, lifeAreaIds?}]
 * @param {Array}  [input.trips]   tapahtumaesiintymät, joilla on placeId tai area
 * @param {Array}  [input.places]  tallennetut paikat {id, name, area}
 * @param {string} input.todayIso
 * @param {string} [input.weekEndIso]  viimeinen harkittava päivä (oletus tämä päivä + 6)
 * @param {number} [input.nowMinutes]  tänään mennyttä aikaa ei ehdoteta
 * @returns {{proposal: object|null, alternatives: object[], reason: string}}
 */
export function proposeOpenEndedSlot(input = {}) {
  const args = isObject(input) ? input : {};
  const todayIso = isIsoDate(args.todayIso) ? args.todayIso : null;
  const task = isObject(args.task) ? args.task : null;
  if (!todayIso || !task) {
    return Object.freeze({ proposal: null, alternatives: EMPTY, reason: 'Asiaa tai päivää ei tunnistettu.' });
  }

  const weekEnd = isIsoDate(args.weekEndIso) && args.weekEndIso >= todayIso
    ? args.weekEndIso : addDaysIso(todayIso, DEFAULT_HORIZON_DAYS - 1);
  const deadline = isIsoDate(task.deadline) ? task.deadline : null;
  const overdue = deadline !== null && deadline < todayIso;
  const windowEnd = deadline && !overdue && deadline < weekEnd ? deadline : weekEnd;
  const duration = validDuration(task.durationMinutes);
  const need = duration ?? DEFAULT_TASK_MINUTES;
  const lifeAreaId = typeof task.lifeAreaId === 'string' ? task.lifeAreaId : null;

  const index = indexPlaces(args.places);
  const errand = errandPlaceOf(task, index);

  const tripsByDate = new Map();
  if (errand) {
    for (const raw of Array.isArray(args.trips) ? args.trips : EMPTY) {
      const trip = tripOf(raw, index);
      if (!trip || trip.date < todayIso || trip.date > windowEnd) continue;
      const kind = nearbyKind(errand, trip);
      if (!kind) continue;
      const list = tripsByDate.get(trip.date) || [];
      list.push({ trip, kind });
      tripsByDate.set(trip.date, list);
    }
    for (const list of tripsByDate.values()) {
      list.sort((a, b) => NEARBY_RANK[b.kind] - NEARBY_RANK[a.kind] || compareTrips(a.trip, b.trip));
    }
  }

  const now = Number.isInteger(args.nowMinutes) && args.nowMinutes >= 0 && args.nowMinutes <= 1440
    ? Math.min(1440, Math.ceil(args.nowMinutes / 5) * 5) : null;
  const seenDates = new Set();
  const candidates = [];
  for (const raw of Array.isArray(args.days) ? args.days : EMPTY) {
    const day = dayOf(raw);
    if (!day || day.date < todayIso || day.date > windowEnd || seenDates.has(day.date)) continue;
    seenDates.add(day.date);
    if (day.capacity !== null && day.capacity < need) continue;
    const slots = cutSlots(day.slots, day.date === todayIso ? now : null);
    let chosen = null;
    for (const { trip, kind } of tripsByDate.get(day.date) || EMPTY) {
      const start = trip.end === null
        ? firstFit(slots, need)
        : firstFit(slots, need, trip.end, trip.end + MAX_TRIP_GAP_MINUTES);
      if (start !== null) {
        chosen = { date: day.date, start, kind, trip };
        break;
      }
    }
    if (!chosen) {
      const start = firstFit(slots, need);
      if (start !== null) chosen = { date: day.date, start, kind: null, trip: null };
    }
    if (chosen) chosen.lifeArea = lifeAreaId !== null && day.lifeAreaIds.has(lifeAreaId);
    if (chosen) candidates.push(chosen);
  }

  candidates.sort((a, b) => {
    // Myöhässä olevalle aikaisin päivä on tärkein; muuten yhdistetty reissu.
    if (overdue) {
      const byDate = compareText(a.date, b.date);
      if (byDate !== 0) return byDate;
    }
    return (NEARBY_RANK[b.kind] || 0) - (NEARBY_RANK[a.kind] || 0)
      || Number(b.lifeArea) - Number(a.lifeArea)
      || compareText(a.date, b.date)
      || a.start - b.start
      || compareText(a.trip ? a.trip.id : '', b.trip ? b.trip.id : '');
  });

  const describeCandidate = candidate => {
    const when = dayPhrase(candidate.date, todayIso);
    const parts = [];
    if (candidate.kind) {
      parts.push(nearbySentence(candidate.kind, errand, candidate.trip, when));
      parts.push(`Asian voi hoitaa samalla klo ${clockOf(candidate.start)}.`);
    } else {
      parts.push(`Vapaata aikaa ${when} klo ${clockOf(candidate.start)}–${clockOf(candidate.start + need)}.`);
    }
    if (candidate.lifeArea) parts.push('Päivä on varattu tälle elämänalueelle.');
    if (deadline && !overdue) parts.push(`Ehtii ennen määräaikaa ${shortDateLabel(deadline)}`);
    if (overdue) parts.push('Määräaika on jo mennyt, joten ehdotus on ensimmäinen sopiva aika.');
    if (duration === null) parts.push(`Kestoa ei ole annettu, joten varataan ${DEFAULT_TASK_MINUTES} min.`);
    return Object.freeze({
      date: candidate.date,
      time: fromMinutes(candidate.start),
      endTime: fromMinutes(candidate.start + need),
      durationMinutes: need,
      nearby: candidate.kind,
      tripId: candidate.trip ? candidate.trip.id : null,
      placeId: errand ? errand.placeId : null,
      reason: parts.join(' ')
    });
  };

  if (candidates.length === 0) {
    const until = deadline && !overdue && deadline <= weekEnd ? 'ennen määräaikaa' : 'tarkasteltavina päivinä';
    return Object.freeze({
      proposal: null,
      alternatives: EMPTY,
      reason: `Vapaata aikaa ei löytynyt ${until}. Kevennä jotain päivää tai siirrä määräaikaa.`
    });
  }

  const [best, ...rest] = candidates;
  const alternatives = [];
  const usedDates = new Set([best.date]);
  for (const candidate of rest) {
    if (alternatives.length >= MAX_ERRAND_ALTERNATIVES) break;
    if (usedDates.has(candidate.date)) continue;
    usedDates.add(candidate.date);
    alternatives.push(describeCandidate(candidate));
  }
  const proposal = describeCandidate(best);
  return Object.freeze({ proposal, alternatives: Object.freeze(alternatives), reason: proposal.reason });
}

/**
 * Asiat, jotka voi hoitaa jo suunnitellun menon yhteydessä.
 *
 * Jokainen avoin asia (ei kellonaikaa, ei tehty, paikka tai alue tiedossa)
 * liitetään parhaaseen menoon: sama paikka ennen samaa aluetta, sitten
 * aikaisin. Meno ei saa olla määräajan jälkeen. Tulos on ryhmitelty menoittain.
 *
 * @param {object} input
 * @param {Array}  input.tasks
 * @param {Array}  input.trips   tapahtumaesiintymät (paikka tai alue)
 * @param {Array}  [input.places]
 * @param {string} input.todayIso
 * @param {string} [input.weekEndIso]
 * @returns {ReadonlyArray<{tripId, date, time, tripTitle, placeId, area, nearby, taskIds, text}>}
 */
export function groupErrands(input = {}) {
  const args = isObject(input) ? input : {};
  const todayIso = isIsoDate(args.todayIso) ? args.todayIso : null;
  if (!todayIso) return EMPTY;
  const weekEnd = isIsoDate(args.weekEndIso) && args.weekEndIso >= todayIso
    ? args.weekEndIso : addDaysIso(todayIso, DEFAULT_HORIZON_DAYS - 1);

  const index = indexPlaces(args.places);
  const byPlace = new Map();
  const byArea = new Map();
  const seenTrips = new Set();
  for (const raw of Array.isArray(args.trips) ? args.trips : EMPTY) {
    const trip = tripOf(raw, index);
    if (!trip || trip.date < todayIso || trip.date > weekEnd || seenTrips.has(trip.id)) continue;
    seenTrips.add(trip.id);
    if (trip.placeId) pushTo(byPlace, trip.placeId, trip);
    if (trip.area) pushTo(byArea, trip.area, trip);
  }
  for (const list of byPlace.values()) list.sort(compareTrips);
  for (const list of byArea.values()) list.sort(compareTrips);

  const groups = new Map();
  const seenTasks = new Set();
  for (const task of Array.isArray(args.tasks) ? args.tasks : EMPTY) {
    safe(() => {
      if (!isObject(task) || task.completed === true || isTimeOfDay(task.time)) return;
      const id = task.id != null && String(task.id) !== '' ? String(task.id) : null;
      if (!id || seenTasks.has(id)) return;
      seenTasks.add(id);
      const errand = errandPlaceOf(task, index);
      if (!errand) return;
      const deadline = isIsoDate(task.deadline) && task.deadline >= todayIso ? task.deadline : null;
      const samePlace = errand.placeId ? earliestWithin(byPlace.get(errand.placeId), deadline) : null;
      const sameArea = !samePlace && errand.area
        ? earliestWithin(byArea.get(errand.area), deadline)
        : null;
      const trip = samePlace || sameArea;
      if (!trip) return;
      const kind = samePlace ? NEARBY.SAME_PLACE : NEARBY.SAME_AREA;
      const group = groups.get(trip.id) || { trip, entries: [] };
      group.entries.push({
        taskId: id,
        title: cleanLabel(task.title) || 'Asia',
        kind,
        errand
      });
      groups.set(trip.id, group);
    }, null);
  }

  const out = [];
  for (const { trip, entries } of groups.values()) {
    entries.sort((a, b) => a.title.localeCompare(b.title, 'fi') || compareText(a.taskId, b.taskId));
    const when = dayPhrase(trip.date, todayIso);
    const names = [...new Set(entries.map(entry => entry.errand.name).filter(Boolean))];
    const allSamePlace = entries.every(entry => entry.kind === NEARBY.SAME_PLACE);
    const titles = entries.map(entry => entry.title).join(', ');
    let text;
    if (names.length === 1 && entries.every(entry => entry.errand.name === names[0])) {
      text = `${nearbySentence(allSamePlace ? NEARBY.SAME_PLACE : NEARBY.SAME_AREA, entries[0].errand, trip, when)} Voit hoitaa samalla: ${titles}.`;
    } else {
      const area = trip.areaLabel || entries.find(entry => entry.errand.areaLabel)?.errand.areaLabel || trip.placeName || trip.title;
      text = `Olet jo menossa ${when} alueelle ${area} (${trip.title}${tripClock(trip)}). Samalla ehtii: ${titles}.`;
    }
    out.push(Object.freeze({
      tripId: trip.id,
      date: trip.date,
      time: trip.start === null ? null : fromMinutes(trip.start),
      tripTitle: trip.title,
      placeId: trip.placeId,
      area: trip.areaLabel,
      nearby: allSamePlace ? NEARBY.SAME_PLACE : NEARBY.SAME_AREA,
      taskIds: Object.freeze(entries.map(entry => entry.taskId)),
      text
    }));
  }
  out.sort((a, b) => compareText(a.date, b.date)
    || (a.time === null ? -1 : 0) - (b.time === null ? -1 : 0)
    || compareText(a.time ?? '', b.time ?? '')
    || compareText(a.tripId, b.tripId));
  return Object.freeze(out);
}
