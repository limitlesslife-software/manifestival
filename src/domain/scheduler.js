// Aikataulumoottori.
//
// TÄMÄ MODUULI ON PUHDAS. Se ei kirjoita DOM:iin, ei kutsu Supabasea, ei tee
// verkkokutsuja eikä lue globaalia tilaa. Kaikki syötteet tulevat parametreina
// ja sama syöte tuottaa aina saman tuloksen. Nykyhetki annetaan parametrina,
// jotta testit ovat toistettavia.
//
// Aiemmin tämä logiikka luki suoraan globaalia `state`-oliota index.html:n
// sisällä, joten sitä ei voinut testata lainkaan.
//
// Moottori vastaa kahteen kysymykseen:
//   1. Milloin päivä alkaa ja päättyy? (herätys, aamutoimet, nukkumaanmeno)
//   2. Mihin aikatauluttamattomat tehtävät mahtuvat? (ehdotukset)

import { fmtISO, parseISO, addDays, subtractMinutes, addMinutes, sortByTime, loadClass } from '../lib/datetime.js';
import {
  toMinutes, fromMinutes, durationOf, isMovableByScheduler, compareForDay,
  isOverdue, deadlineUrgency, schedulingUrgencyWeight, urgencyLabel, URGENCY
} from './task.js';
import { priorityWeight, priorityLabel } from './priority.js';
import { expandRoutines, ROUTINE_SCHEDULING } from './routine.js';

export const DEFAULT_PROFILE = Object.freeze({
  age: null,
  weightKg: null,
  heightCm: null,
  sleepTargetHours: 8,
  defaultWakeTime: '07:00',
  commuteMinutes: 30,
  routineMinutes: 60
});

/** Lyhin vapaa väli, jota kannattaa ehdottaa. Alle tämän ei ole hyötyä. */
export const MIN_USEFUL_SLOT_MINUTES = 15;

/** Oletuskesto tehtävälle, jonka kestoa ei tiedetä. */
export const DEFAULT_TASK_MINUTES = 30;

function profileOf(profile) {
  return { ...DEFAULT_PROFILE, ...(profile || {}) };
}

function tasksOn(tasks, dateIso) {
  return tasks.filter(t => t.date === dateIso);
}

/**
 * Päivän ensimmäinen aikataulutettu työtehtävä. Tämä on ankkuri, josta
 * herätysaika lasketaan taaksepäin.
 */
export function findWorkAnchor(tasks, dateIso) {
  return tasksOn(tasks, dateIso)
    .filter(t => t.category === 'tyo' && t.time)
    .sort(sortByTime)[0] || null;
}

/**
 * Päivän herätysaika.
 *
 * Järjestys:
 *   1. Käyttäjän itse merkitsemä herätys (isWake) voittaa aina.
 *   2. Muuten: ensimmäinen työtehtävä − työmatka − aamutoimet.
 *   3. Muuten: profiilin oletusheräämisaika.
 *
 * @returns {{time: string, auto: boolean, basedOn?: object}}
 */
export function computeWakeTime({ tasks, profile, dateIso }) {
  const p = profileOf(profile);
  const manual = tasksOn(tasks, dateIso).find(t => t.isWake && t.time);
  if (manual) return { time: manual.time, auto: false };

  const work = findWorkAnchor(tasks, dateIso);
  if (work) {
    return {
      time: subtractMinutes(work.time, p.commuteMinutes + p.routineMinutes),
      auto: true,
      basedOn: work
    };
  }
  return { time: p.defaultWakeTime || '07:00', auto: true };
}

/**
 * Illan nukkumaanmenoaika: HUOMISEN herätysajasta vähennetään unitavoite.
 *
 * Tämä on tuotteen ydinajatus: uni ei ole "se mikä jää yli", vaan sille
 * varataan aika kalenterista (konseptidokumentti, luku 13).
 */
export function computeBedtime({ tasks, profile, dateIso }) {
  const p = profileOf(profile);
  const tomorrow = fmtISO(addDays(parseISO(dateIso), 1));
  const wake = computeWakeTime({ tasks, profile: p, dateIso: tomorrow });
  const targetMinutes = (p.sleepTargetHours || 8) * 60;
  return {
    bedtime: subtractMinutes(wake.time, targetMinutes),
    wakeTime: wake.time,
    wakeAuto: wake.auto
  };
}

/**
 * Onko käyttäjällä oma merkintä, joka alkaa välillä [start, end)?
 * Käytetään siihen, ettei automaattinen ehdotus koskaan päällekkäisty
 * käyttäjän oman suunnitelman kanssa.
 */
export function hasManualCoverage(tasks, dateIso, start, end) {
  return tasksOn(tasks, dateIso).some(t => t.time && t.time >= start && t.time < end);
}

/**
 * Automaattiset ehdotusmerkinnät päivälle: herätys, aamutoimet ja uni.
 * Näitä EI tallenneta tietokantaan — ne lasketaan aina uudelleen, joten ne
 * pysyvät ajan tasalla, kun suunnitelma muuttuu.
 */
export function buildVirtualItems({ tasks, profile, dateIso }) {
  const p = profileOf(profile);
  const items = [];

  const wake = computeWakeTime({ tasks, profile: p, dateIso });
  if (wake.auto) {
    items.push({
      id: 'virtual-wake',
      date: dateIso,
      time: wake.time,
      endTime: null,
      title: 'Herätys',
      category: 'hyvinvointi',
      completed: false,
      isWake: true,
      virtual: true,
      note: wake.basedOn
        ? `automaattinen ehdotus · ${p.commuteMinutes} min matka + ${p.routineMinutes} min aamutoimet`
        : 'automaattinen ehdotus (oletusaika)'
    });
  }

  const routineEnd = addMinutes(wake.time, p.routineMinutes);
  if (!hasManualCoverage(tasks, dateIso, wake.time, routineEnd)) {
    items.push({
      id: 'virtual-routine',
      date: dateIso,
      time: wake.time,
      endTime: routineEnd,
      title: 'Aamutoimet',
      category: 'hyvinvointi',
      completed: false,
      isWake: false,
      virtual: true,
      note: 'automaattinen ehdotus'
    });
  }

  const bt = computeBedtime({ tasks, profile: p, dateIso });
  items.push({
    id: 'virtual-sleep',
    date: dateIso,
    time: bt.bedtime,
    endTime: bt.wakeTime,
    title: 'Uni',
    category: 'hyvinvointi',
    completed: false,
    isWake: false,
    virtual: true,
    note: 'automaattinen ehdotus'
  });

  return items;
}

/**
 * Valveillaoloikkuna minuutteina: [herätys, nukkumaanmeno).
 * Jos nukkumaanmeno on herätystä aiemmin (mennään keskiyön yli), ikkuna
 * päättyy vuorokauden vaihteeseen.
 */
export function awakeWindow({ tasks, profile, dateIso }) {
  const wake = computeWakeTime({ tasks, profile, dateIso });
  const bt = computeBedtime({ tasks, profile, dateIso });
  const start = toMinutes(wake.time);
  const bedMinutes = toMinutes(bt.bedtime);
  const end = bedMinutes > start ? bedMinutes : 1440;
  return { start, end, wakeTime: wake.time, bedtime: bt.bedtime };
}

/**
 * Varatut aikavälit minuutteina. Ajattomat tehtävät eivät varaa mitään.
 * Palautus on järjestetty ja yhdistetty (päällekkäiset välit sulautetaan).
 */
export function occupiedRanges(items) {
  const ranges = items
    .filter(it => it.time)
    .map(it => {
      const start = toMinutes(it.time);
      const length = durationOf(it) ?? DEFAULT_TASK_MINUTES;
      return { start, end: Math.min(start + length, 1440) };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/**
 * Vapaat aikavälit valveillaoloikkunassa.
 * @returns {Array<{start:number,end:number,minutes:number,startTime:string,endTime:string}>}
 */
export function findFreeSlots({ items, range, minMinutes = MIN_USEFUL_SLOT_MINUTES }) {
  const occupied = occupiedRanges(items);
  const slots = [];
  let cursor = range.start;

  for (const busy of occupied) {
    if (busy.end <= range.start) continue;   // kokonaan ikkunan alapuolella
    if (busy.start >= range.end) break;      // loput ovat ikkunan yläpuolella

    const gap = Math.min(busy.start, range.end) - cursor;
    if (gap >= minMinutes) slots.push({ start: cursor, end: cursor + gap });

    cursor = Math.max(cursor, Math.min(busy.end, range.end));
  }

  if (range.end - cursor >= minMinutes) {
    slots.push({ start: cursor, end: range.end });
  }

  return slots.map(s => ({
    start: s.start,
    end: s.end,
    minutes: s.end - s.start,
    startTime: fromMinutes(s.start),
    endTime: fromMinutes(s.end)
  }));
}

/**
 * Päivän koko suunnitelma yhtenä oliona. Tämä on päivänäkymän ainoa syöte.
 *
 * @param {object}   args
 * @param {Array}    args.tasks    Kaikki käyttäjän tehtävät
 * @param {object}   args.profile  Käyttäjän profiili
 * @param {string}   args.dateIso  Päivä, jota katsotaan
 * @param {number}   [args.nowMinutes]  Nykyhetki minuutteina. null = ei "nyt"-tilaa.
 */
export function buildDayPlan({
  tasks,
  profile,
  dateIso,
  nowMinutes = null,
  routines = [],
  exceptions = [],
  todayIso = null
} = {}) {
  const p = profileOf(profile);
  const dayTasks = tasksOn(tasks, dateIso);

  const scheduled = dayTasks.filter(t => t.time && !t.completed).sort(compareForDay);
  const unscheduled = dayTasks.filter(t => !t.time && !t.completed).sort(compareForDay);
  const completed = dayTasks.filter(t => t.completed).sort(compareForDay);

  // Rutiiniesiintymät lasketaan aina uudelleen — niitä ei tallenneta.
  const occurrences = expandRoutines({ routines, from: dateIso, to: dateIso, exceptions });
  const fixedRoutines = occurrences.filter(o => o.time);
  const flexibleRoutines = occurrences.filter(o => !o.time);

  const virtualItems = buildVirtualItems({ tasks, profile: p, dateIso });

  // Aikajanalla näkyvät: käyttäjän ajastetut, kuitatut ajastetut,
  // kiinteät rutiinit ja automaattiset ehdotukset.
  const timeline = [
    ...scheduled,
    ...completed.filter(t => t.time),
    ...fixedRoutines,
    ...virtualItems
  ].sort(sortByTime);

  const range = awakeWindow({ tasks, profile: p, dateIso });

  // Vapaita välejä laskettaessa uni jätetään pois (se on ikkunan ulkopuolella),
  // mutta kiinteät rutiinit varaavat aikaa kuten mikä tahansa merkintä.
  const freeSlots = findFreeSlots({
    items: timeline.filter(it => it.id !== 'virtual-sleep'),
    range
  });

  const reference = todayIso || dateIso;
  const overdue = (tasks || []).filter(t => isOverdue(t, reference));

  return {
    dateIso,
    timeline,
    scheduled,
    unscheduled,
    completed,
    routineOccurrences: occurrences,
    fixedRoutines,
    flexibleRoutines,
    overdue,
    freeSlots,
    range,
    load: {
      count: dayTasks.length,
      level: loadClass(dayTasks.length),
      completed: completed.length,
      routines: occurrences.length
    },
    nowMinutes
  };
}

/**
 * Ehdota aikoja aikatauluttamattomille tehtäville.
 *
 * TAKUUT:
 *  - Deterministinen: sama syöte tuottaa aina saman tuloksen.
 *  - Ei koskaan siirrä käyttäjän itse ajastamaa tehtävää
 *    (isMovableByScheduler palauttaa false manuaalisille).
 *  - Ei koskaan sijoita päällekkäin jo varatun ajan kanssa.
 *  - Ei ehdota mitään, jos tilaa ei ole — tehtävä jää listaan `unplaced`.
 *
 * Järjestys: tärkeimmät ensin, tasatilanteessa nimen mukaan.
 *
 * @returns {{proposals: Array, unplaced: Array}}
 */
export function proposeSchedule({
  tasks,
  profile,
  dateIso,
  routines = [],
  exceptions = [],
  todayIso = null
} = {}) {
  const p = profileOf(profile);
  const plan = buildDayPlan({ tasks, profile: p, dateIso, routines, exceptions, todayIso });
  const reference = todayIso || dateIso;

  // Ehdokkaat kahdesta lähteestä. Rutiinit ennen tehtäviä: ne ovat käyttäjän
  // itse asettamia toistuvia sitoumuksia, joten ne saavat ensin parhaat välit.
  const candidates = [
    ...plan.flexibleRoutines.map(occurrence => ({
      kind: 'routine',
      rank: 0,
      id: occurrence.id,
      routineId: occurrence.routineId,
      title: occurrence.title,
      priority: occurrence.priority,
      urgency: URGENCY.NONE,
      needed: occurrence.durationMinutes || DEFAULT_TASK_MINUTES,
      source: occurrence
    })),
    ...plan.unscheduled.filter(isMovableByScheduler).map(task => ({
      kind: 'task',
      rank: 1,
      id: task.id,
      taskId: task.id,
      title: task.title,
      priority: task.priority,
      urgency: deadlineUrgency(task, reference),
      needed: durationOf(task) ?? DEFAULT_TASK_MINUTES,
      source: task
    }))
  ];

  // Järjestys — tämä on schedulerin koko priorisointisääntö yhdessä paikassa:
  //   1. rutiinit ennen tehtäviä
  //   2. kiireellisyys (määräaika)
  //   3. prioriteetti
  //   4. nimi — takaa determinismin
  candidates.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const byUrgency = schedulingUrgencyWeight(a.urgency) - schedulingUrgencyWeight(b.urgency);
    if (byUrgency !== 0) return byUrgency;
    const byPriority = priorityWeight(a.priority) - priorityWeight(b.priority);
    if (byPriority !== 0) return byPriority;
    return String(a.title ?? '').localeCompare(String(b.title ?? ''), 'fi');
  });

  // Kopioidaan vapaat välit, jotta niitä voidaan kuluttaa sijoituksen edetessä.
  const slots = plan.freeSlots.map(s => ({ ...s }));
  const proposals = [];
  const unplaced = [];

  for (const candidate of candidates) {
    const needed = candidate.needed;
    const slotIndex = slots.findIndex(s => s.minutes >= needed);

    if (slotIndex === -1) {
      unplaced.push(candidate.source);
      continue;
    }

    const slot = slots[slotIndex];
    const startTime = fromMinutes(slot.start);
    const endTime = fromMinutes(slot.start + needed);

    proposals.push({
      kind: candidate.kind,
      taskId: candidate.kind === 'task' ? candidate.taskId : null,
      routineId: candidate.kind === 'routine' ? candidate.routineId : null,
      occurrenceId: candidate.kind === 'routine' ? candidate.id : null,
      title: candidate.title,
      time: startTime,
      endTime,
      durationMinutes: needed,
      urgency: candidate.urgency,
      priority: candidate.priority,
      reason: buildReason(candidate, slot)
    });

    slot.start += needed;
    slot.minutes -= needed;
    slot.startTime = fromMinutes(slot.start);
    if (slot.minutes < MIN_USEFUL_SLOT_MINUTES) slots.splice(slotIndex, 1);
  }

  return { proposals, unplaced };
}

/**
 * Rakentaa käyttäjälle näytettävän perustelun.
 *
 * Ehdotus ilman perustelua on käsky. Käyttäjän pitää nähdä MIKSI juuri tämä
 * aika ehdotetaan, jotta hän voi olla eri mieltä (konseptidokumentti, luku 22).
 */
function buildReason(candidate, slot) {
  const parts = [];

  if (candidate.kind === 'routine') parts.push('Toistuva rutiini');

  const urgency = urgencyLabel(candidate.urgency);
  if (urgency) parts.push(`Määräaika: ${urgency.toLowerCase()}`);

  if (candidate.priority === 'korkea') parts.push(priorityLabel('korkea'));

  parts.push(`Vapaa ${slot.minutes} min väli klo ${slot.startTime}`);
  return parts.join(' · ');
}
