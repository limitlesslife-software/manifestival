// Ristiriitojen tunnistus.
//
// =====================================================================
// MAHDOTONTA SUUNNITELMAA EI SAA PIILOTTAA OPTIMISTISEN SANAMUODON TAAKSE
// =====================================================================
//
// Suunnittelija, joka sanoo "tiukka mutta tehtävissä" tilanteessa jossa
// työtä on 18 tuntia ja aikaa 10, ei ole kohtelias vaan epärehellinen.
// Käyttäjä tekee päätöksiä sen lauseen varassa.
//
// Siksi vakavuus on kolmiportainen ja sen raja on määritelty:
//
//   INFO      huomionarvoista, ei estä mitään
//   WARNING   suunnitelma toteutuu vain jos kaikki menee hyvin
//   BLOCKING  suunnitelma ei voi toteutua sellaisenaan
//
// BLOCKING ei estä käyttäjää hyväksymästä suunnitelmaa. Se estää
// järjestelmää väittämästä, että suunnitelma on kunnossa. Päätös on
// käyttäjän; totuus ei ole.

import { isIsoDate, isTimeOfDay, toMinutes, fromMinutes, durationOf, overlaps } from './task.js';
import { fmtISO, parseISO, addDays } from '../lib/datetime.js';
import {
  DEFAULT_TASK_MINUTES, BLOCK_KIND, PRESENCE_BLOCK_KINDS, REST_BLOCK_KINDS, blockKindOf,
  indexCalendarBlocks
} from './scheduler.js';
import { outOfOrderMilestones } from './milestone.js';
import { feasibility, dailyRequirement } from './capacity.js';

/** Ristiriidan vakavuus. */
export const SEVERITY = Object.freeze({
  INFO: 'info',
  WARNING: 'warning',
  BLOCKING: 'blocking'
});

/** Vakavuuden järjestys, vakavin ensin. */
const SEVERITY_ORDER = Object.freeze({
  [SEVERITY.BLOCKING]: 0,
  [SEVERITY.WARNING]: 1,
  [SEVERITY.INFO]: 2
});

/** Ristiriidan laji. Koodi on sopimus, teksti ei. */
export const CONFLICT = Object.freeze({
  /** Kaksi kiinteää sitoumusta samaan aikaan. */
  OVERLAP: 'overlap',
  /** Määräaika on menneisyydessä. */
  DEADLINE_PAST: 'deadline_past',
  /** Työtä on enemmän kuin aikaa. */
  INSUFFICIENT_CAPACITY: 'insufficient_capacity',
  /** Aika riittää vain juuri ja juuri. */
  TIGHT_CAPACITY: 'tight_capacity',
  /** Välitavoitteiden päivät ovat väärässä järjestyksessä. */
  MILESTONE_ORDER: 'milestone_order',
  /** Välitavoite on tavoitteen määräpäivän jälkeen. */
  MILESTONE_AFTER_GOAL: 'milestone_after_goal',
  /** Riippuvuus on ajoitettu ennen edeltäjäänsä. */
  DEPENDENCY_ORDER: 'dependency_order',
  /** Useampi tavoite kilpailee samasta ajasta. */
  PORTFOLIO_OVERCOMMIT: 'portfolio_overcommit',
  /** Päivä on ahdettu täyteen. */
  DAY_OVERLOADED: 'day_overloaded',
  /** Kestoarvio puuttuu monelta tehtävältä. */
  WEAK_ESTIMATES: 'weak_estimates',
  /** Kiinteä merkintä osuu lähtöön, matkaan tai perilläolon varmuusaikaan. */
  TRAVEL_OVERLAP: 'travel_overlap',
  /** Kiinteä merkintä osuu suojattuun uneen tai rauhoittumiseen. */
  REST_OVERLAP: 'rest_overlap',
  /** Tapahtumalla on paikka, mutta matka-aikaa ei tiedetä. */
  TRAVEL_UNKNOWN: 'travel_unknown'
});

/**
 * Kuinka täyteen kapasiteetti saa mennä ennen varoitusta.
 *
 * 0,85 tarkoittaa: kun suunniteltu työ vie yli 85 % käytettävissä
 * olevasta ajasta, suunnitelma toteutuu vain jos mikään ei mene
 * pieleen. Se on varoituksen arvoinen tieto, ei este.
 */
export const TIGHT_RATIO = 0.85;

/** Montako tehtävää päivässä on merkki ahtaudesta. */
export const CROWDED_TASKS_PER_DAY = 8;

/** Kuinka suuri osa kestoarvioista saa olla arvattuja ilman huomautusta. */
export const WEAK_ESTIMATE_RATIO = 0.5;

function conflict(code, severity, message, extra = {}) {
  return Object.freeze({ code, severity, message, ...extra });
}

/**
 * Järjestä ristiriidat vakavimmasta lievimpään.
 *
 * Deterministinen: saman vakavuuden sisällä koodin ja viestin mukaan.
 * Käyttöliittymä näyttää nämä listana, eikä lista saa hyppiä
 * renderöintien välillä.
 */
export function sortConflicts(conflicts = []) {
  return [...conflicts].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const byCode = String(a.code).localeCompare(String(b.code));
    if (byCode !== 0) return byCode;
    return String(a.message).localeCompare(String(b.message), 'fi');
  });
}

/** Onko joukossa estävä ristiriita? */
export function hasBlocking(conflicts = []) {
  return conflicts.some(c => c && c.severity === SEVERITY.BLOCKING);
}

/** Vakavin vakavuus joukossa, tai null. */
export function worstSeverity(conflicts = []) {
  if (!conflicts.length) return null;
  return sortConflicts(conflicts)[0].severity;
}

// =====================================================================
// PÄÄLLEKKÄISYYS
// =====================================================================

/**
 * Kaksi kiinteää sitoumusta samaan aikaan.
 *
 * VAIN KIINTEÄT lasketaan. Joustava työ, joka osuu päällekkäin, on
 * sijoitusvirhe jonka aikatauluttaja korjaa — kiinteä päällekkäisyys
 * on käyttäjän oma ristiriita, jota kukaan muu ei voi ratkaista.
 */
export function detectOverlaps(tasks = []) {
  const timed = tasks
    .filter(task => task && task.time && !task.completed
      && task.schedulingState !== 'auto')
    .sort((a, b) => String(a.date).localeCompare(String(b.date))
      || String(a.time).localeCompare(String(b.time)));

  const found = [];

  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      if (timed[i].date !== timed[j].date) break;
      if (!overlaps(timed[i], timed[j])) continue;

      found.push(conflict(
        CONFLICT.OVERLAP,
        SEVERITY.BLOCKING,
        `"${timed[i].title}" ja "${timed[j].title}" ovat samaan aikaan `
        + `${timed[i].date} klo ${timed[i].time}.`,
        { taskIds: [timed[i].id, timed[j].id], dateIso: timed[i].date }
      ));
    }
  }

  return found;
}

// =====================================================================
// KALENTERI: TAPAHTUMAT JA SUOJATUT LOHKOT
// =====================================================================
//
// Tapahtumat tulevat esiintyminä (calendar.js expandEventOccurrences) ja
// lohkot päiväkohtaisina paloina (calendarBlocks.js deriveBlocks). Kaikki
// ajat ovat seinäkelloaikaa.
//
// VAKAVUUS:
//   BLOCKING  kiinteä merkintä osuu lähtöön, matkaan, pysäköintiin tai
//             perilläolon varmuusaikaan: et voi olla kahdessa paikassa.
//   WARNING   kiinteä merkintä osuu suojattuun uneen tai rauhoittumiseen:
//             päätös on käyttäjän, mutta järjestelmä sanoo sen ääneen.
//   INFO      tapahtumalla on paikka, mutta matka-aikaa ei tiedetä, joten
//             lähtöä ei ole varattu. Tuntematon ei ole nolla.
//
// Automaattisesti sijoitettu (AUTO) tehtävä EI ole ristiriita: se on
// sijoitusvirhe, jonka aikatauluttaja korjaa (replan.js CONFLICT ->
// proposeSchedule reflow).

const PRESENCE_PHRASES = Object.freeze({
  [BLOCK_KIND.PREPARATION]: target => `valmistaudut lähtemään${target ? ` tapahtumaan "${target}"` : ''}`,
  [BLOCK_KIND.TRAVEL]: target => `olet matkalla${target ? ` tapahtumaan "${target}"` : ''}`,
  [BLOCK_KIND.OVERHEAD]: target => `pysäköit ja kävelet perille${target ? ` (tapahtuma "${target}")` : ''}`,
  [BLOCK_KIND.ARRIVAL_BUFFER]: target => `odotat perillä${target ? ` tapahtuman "${target}" alkua` : ''}`
});

function nextIso(dateIso) {
  return fmtISO(addDays(parseISO(dateIso), 1));
}

/** Tunnisteiden ja päivien vertailu merkki merkiltä: sama tulos joka ympäristössä. */
function compareText(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function safely(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Käyttäjän itse ajastama, keskeneräinen tehtävä, jonka ajat ovat kelvollisia. */
function isFixedTask(task) {
  return safely(() => Boolean(task && typeof task === 'object'
    && !task.completed && !task.isWake
    && task.schedulingState !== 'auto'
    && isIsoDate(task.date) && isTimeOfDay(task.time)
    && (!task.endTime || isTimeOfDay(task.endTime))), false);
}

/**
 * Kohteen palat päivittäin: { date, start, end, point }.
 *
 * Keskiyön yli jatkuva väli pilkotaan kahdeksi. Tuntematon kesto on
 * PISTE alkuhetkessä: sitä ei venytetä oletuskestoksi, koska keksitty
 * kesto keksisi myös ristiriidan.
 */
function piecesOf(item) {
  const start = toMinutes(item.time);
  const duration = durationOf(item);
  if (duration === null) {
    return [{ date: item.date, start, end: start, point: true }];
  }
  const end = start + Math.min(duration, 1440);
  if (end <= 1440) return [{ date: item.date, start, end, point: false }];
  return [
    { date: item.date, start, end: 1440, point: false },
    { date: nextIso(item.date), start: 0, end: end - 1440, point: false }
  ];
}

function blockRange(block) {
  const start = toMinutes(block.time);
  return { start, end: Math.min(start + (durationOf(block) ?? 0), 1440) };
}

function hitsBlock(piece, range) {
  if (piece.point) return range.start <= piece.start && piece.start < range.end;
  return piece.start < range.end && range.start < piece.end;
}

function hasPlace(occurrence) {
  const place = occurrence.placeId;
  const text = occurrence.locationText;
  return (place != null && String(place).trim() !== '')
    || (typeof text === 'string' && text.trim() !== '');
}

function isTimedOccurrence(item) {
  return safely(() => Boolean(item && typeof item === 'object'
    && (item.isEvent === true || item.source === 'event')
    && item.id != null && isIsoDate(item.date)
    && item.allDay !== true && item.continuation !== true
    && isTimeOfDay(item.time) && (!item.endTime || isTimeOfDay(item.endTime))), false);
}

/**
 * Vertailtava kohde. Otsikko ja tunnisteet luetaan KERRAN ja
 * turvallisesti: roskaotsikko ei saa kaataa koko ristiriitalistaa.
 */
function subjectOf(kind, item) {
  return safely(() => {
    const title = String(item.title ?? '').trim() || 'Nimetön';
    return {
      key: `${kind}:${String(item.id)}`,
      kind,
      item,
      id: item.id,
      eventId: kind === 'event' ? (item.eventId ?? null) : null,
      title,
      label: `"${title}" (${item.date} klo ${item.time})`,
      pieces: piecesOf(item)
    };
  }, null);
}

/** Kiinteät kohteet (MANUAL-tehtävät ja tapahtumat) vertailua varten. */
function fixedSubjects({ tasks, events, fromIso }) {
  const subjects = [];
  const seen = new Set();
  const after = item => !fromIso || item.date >= fromIso;
  const add = (kind, item) => {
    const subject = subjectOf(kind, item);
    if (!subject || seen.has(subject.key)) return;
    seen.add(subject.key);
    subjects.push(subject);
  };

  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (isFixedTask(task) && after(task)) add('task', task);
  }
  for (const occurrence of Array.isArray(events) ? events : []) {
    if (isTimedOccurrence(occurrence) && after(occurrence)) add('event', occurrence);
  }

  return subjects;
}

function subjectExtras(subject) {
  return subject.kind === 'task'
    ? { taskIds: [subject.id] }
    : { eventIds: [subject.eventId], occurrenceIds: [subject.id] };
}

/**
 * Kiinteä merkintä suojatun lohkon päällä.
 *
 * @param {object} input
 * @param {Array}  input.tasks
 * @param {Array}  [input.events]   tapahtumaesiintymät
 * @param {Array}  [input.blocks]   lohkojen palat
 * @param {string} [input.fromIso]  vain tästä päivästä eteenpäin (menneestä ei huomauteta)
 */
export function detectBlockConflicts({ tasks = [], events = [], blocks = [], fromIso = null } = {}) {
  const blockList = Array.isArray(blocks) ? blocks : [];
  const blockIndex = indexCalendarBlocks(blockList);
  const since = isIsoDate(fromIso) ? fromIso : null;
  const subjects = fixedSubjects({ tasks, events, fromIso: since });
  const found = [];

  // 1. Päällekkäisyys lohkon kanssa. Yksi ristiriita per (kohde, lohkon
  //    lähde, luokka): matka ja valmistautuminen samaan tapahtumaan ovat
  //    käyttäjälle yksi asia, ei neljä riviä.
  if (blockIndex.size > 0) {
    for (const subject of subjects) {
      // Yksi rikkinäinen lohko ei saa kaataa koko listaa: kohde ohitetaan.
      found.push(...safely(() => blockConflictsOf(subject, blockIndex), []));
    }
  }

  // 2. Tuntematon matka-aika: paikka on, lähtöä ei ole varattu.
  const reserved = new Set();
  for (const block of blockList) {
    const kind = safely(() => blockKindOf(block), null);
    if (!PRESENCE_BLOCK_KINDS.includes(kind)) continue;
    const source = safely(() => block.occurrenceId ?? block.sourceId, null);
    if (source != null) reserved.add(String(source));
  }

  for (const subject of subjects) {
    if (subject.kind !== 'event') continue;
    if (!safely(() => hasPlace(subject.item), false)) continue;
    if (reserved.has(String(subject.id))) continue;
    found.push(conflict(
      CONFLICT.TRAVEL_UNKNOWN,
      SEVERITY.INFO,
      `Matka-aikaa tapahtumaan ${subject.label} ei tiedetä, joten lähtöä ei ole `
      + 'varattu kalenteriin. Kirjaa tavallinen matka-aika, niin lähtöaika lasketaan.',
      { ...subjectExtras(subject), dateIso: subject.pieces[0].date }
    ));
  }

  return sortConflicts(found);
}

/** Yhden kohteen lohkoristiriidat, ryhmiteltynä (lohkon lähde, luokka). */
function blockConflictsOf(subject, blockIndex) {
  const groups = new Map();
  for (const piece of subject.pieces) {
    for (const block of blockIndex.on(piece.date)) {
      // Tapahtuman oma lähtö päättyy sen alkuun: se ei ole ristiriita.
      if (subject.kind === 'event'
        && (block.occurrenceId === subject.id || block.sourceId === subject.id)) continue;
      const range = blockRange(block);
      if (!hitsBlock(piece, range)) continue;

      const kind = blockKindOf(block);
      const severityClass = PRESENCE_BLOCK_KINDS.includes(kind) ? 'presence'
        : REST_BLOCK_KINDS.includes(kind) ? 'rest' : null;
      if (!severityClass) continue;

      const groupKey = `${String(block.sourceId ?? block.id)}|${severityClass}`;
      const group = groups.get(groupKey) || { severityClass, hits: [] };
      group.hits.push({ block, kind, range, date: piece.date });
      groups.set(groupKey, group);
    }
  }
  return [...groups.values()].map(group => blockConflict(subject, group));
}

function blockConflict(subject, group) {
  const hits = [...group.hits].sort((a, b) =>
    compareText(a.date, b.date) || a.range.start - b.range.start
    || compareText(a.block.id, b.block.id));

  // Unesta kerrotaan ennen rauhoittumista: se on painavampi tieto.
  const lead = group.severityClass === 'rest'
    ? (hits.find(hit => hit.kind === BLOCK_KIND.SLEEP) || hits[0])
    : hits[0];

  const span = `klo ${fromMinutes(lead.range.start)}–${fromMinutes(lead.range.end)}`;
  const extras = {
    ...subjectExtras(subject),
    dateIso: lead.date,
    blockKind: lead.kind,
    sourceId: lead.block.sourceId ?? null,
    blockIds: [...new Set(hits.map(hit => String(hit.block.id)))].sort(compareText)
  };

  if (group.severityClass === 'presence') {
    const target = lead.block.sourceTitle ? String(lead.block.sourceTitle) : '';
    return conflict(
      CONFLICT.TRAVEL_OVERLAP,
      SEVERITY.BLOCKING,
      `${subject.label} osuu aikaan ${span}, jolloin ${PRESENCE_PHRASES[lead.kind](target)}. `
      + 'Et voi olla kahdessa paikassa yhtä aikaa.',
      extras
    );
  }

  const what = lead.kind === BLOCK_KIND.SLEEP
    ? `suojattuun uneen (${span})`
    : `rauhoittumisaikaan ennen nukkumaanmenoa (${span})`;
  return conflict(
    CONFLICT.REST_OVERLAP,
    SEVERITY.WARNING,
    `${subject.label} osuu ${what}. Päätös on sinun, mutta lepoaika lyhenee.`,
    extras
  );
}

/**
 * Tapahtuma samaan aikaan toisen tapahtuman tai käyttäjän itse
 * ajastaman tehtävän kanssa.
 *
 * Kaksi kiinteää tehtävää keskenään on jo detectOverlaps-funktion asia;
 * tämä raportoi vain parit, joissa ainakin toinen on tapahtuma.
 * Pyyhkäisy alkuajan mukaan: O(n log n + päällekkäisyydet), ei n².
 */
export function detectEventOverlaps({ tasks = [], events = [], fromIso = null } = {}) {
  const since = isIsoDate(fromIso) ? fromIso : null;
  const subjects = fixedSubjects({ tasks, events, fromIso: since });
  if (!subjects.some(subject => subject.kind === 'event')) return [];

  const byDate = new Map();
  for (const subject of subjects) {
    for (const piece of subject.pieces) {
      const list = byDate.get(piece.date) || [];
      list.push({ ...piece, subject });
      byDate.set(piece.date, list);
    }
  }

  const found = [];
  const reported = new Set();

  for (const [date, pieces] of [...byDate.entries()].sort((a, b) => compareText(a[0], b[0]))) {
    pieces.sort((a, b) => a.start - b.start || a.end - b.end
      || compareText(a.subject.key, b.subject.key));

    for (let i = 0; i < pieces.length; i++) {
      const a = pieces[i];
      for (let j = i + 1; j < pieces.length; j++) {
        const b = pieces[j];
        if (a.point ? b.start !== a.start : b.start >= a.end) break;
        if (a.subject === b.subject) continue;
        if (a.subject.kind === 'task' && b.subject.kind === 'task') continue;
        if (b.point && !a.point && !(a.start <= b.start && b.start < a.end)) continue;

        const [first, second] = [a.subject, b.subject].sort((x, y) => compareText(x.key, y.key));
        const pairKey = `${first.key}|${second.key}`;
        if (reported.has(pairKey)) continue;
        reported.add(pairKey);

        const taskIds = [first, second].filter(s => s.kind === 'task').map(s => s.id);
        const events = [first, second].filter(s => s.kind === 'event');
        found.push(conflict(
          CONFLICT.OVERLAP,
          SEVERITY.BLOCKING,
          `"${a.subject.title}" ja "${b.subject.title}" `
          + `ovat samaan aikaan ${date} klo ${fromMinutes(Math.max(a.start, b.start))}.`,
          {
            taskIds,
            eventIds: events.map(s => s.eventId),
            occurrenceIds: events.map(s => s.id),
            dateIso: date
          }
        ));
      }
    }
  }

  return sortConflicts(found);
}

// =====================================================================
// MÄÄRÄAIKA JA KAPASITEETTI
// =====================================================================

/**
 * Riittääkö aika tavoitteen työhön?
 *
 * @param {object} input
 * @param {object} input.goal
 * @param {object} input.remaining  remainingWork(...)
 * @param {object} input.capacity   horizonCapacity(...) tai null
 * @param {string} input.todayIso
 */
export function detectCapacityConflicts({ goal, remaining, capacity, todayIso } = {}) {
  const found = [];
  if (!goal) return found;

  const name = goal.title || 'Tavoite';

  if (goal.targetDate && isIsoDate(todayIso) && goal.targetDate < todayIso) {
    found.push(conflict(
      CONFLICT.DEADLINE_PAST,
      SEVERITY.BLOCKING,
      `Tavoitteen "${name}" määräpäivä ${goal.targetDate} on mennyt.`,
      { goalId: goal.id }
    ));
    // Menneelle määräpäivälle ei lasketa kapasiteettia: kysymys "ehtiikö"
    // ei ole enää voimassa, ja siihen vastaaminen olisi harhaanjohtavaa.
    return found;
  }

  if (!remaining || !capacity) return found;

  const fit = feasibility({ remaining, capacity });
  if (fit.feasible === null) return found;

  if (!fit.feasible) {
    const perDay = dailyRequirement(fit.requiredMinutes, capacity.dayCount);
    found.push(conflict(
      CONFLICT.INSUFFICIENT_CAPACITY,
      SEVERITY.BLOCKING,
      `Tavoite "${name}" ei mahdu: jäljellä on noin ${hours(fit.requiredMinutes)} työtä `
      + `ja määräpäivään mennessä suunniteltavaa aikaa ${hours(fit.availableMinutes)}.`
      + (perDay ? ` Se olisi ${perDay} min joka päivä.` : ''),
      {
        goalId: goal.id,
        requiredMinutes: fit.requiredMinutes,
        availableMinutes: fit.availableMinutes,
        ratio: fit.ratio
      }
    ));
  } else if (fit.ratio >= TIGHT_RATIO) {
    found.push(conflict(
      CONFLICT.TIGHT_CAPACITY,
      SEVERITY.WARNING,
      `Tavoite "${name}" on tiukka: työ vie noin ${Math.round(fit.ratio * 100)} % `
      + 'käytettävissä olevasta ajasta. Suunnitelma toteutuu vain jos mikään ei mene pieleen.',
      { goalId: goal.id, ratio: fit.ratio }
    ));
  }

  // Heikko arviopohja ei ole ristiriita vaan epävarmuus. Se kerrotaan,
  // koska yllä olevat luvut nojaavat siihen.
  if (remaining.taskCount > 0 && remaining.estimateRatio > WEAK_ESTIMATE_RATIO) {
    found.push(conflict(
      CONFLICT.WEAK_ESTIMATES,
      SEVERITY.INFO,
      `${remaining.estimatedCount}/${remaining.taskCount} tehtävältä puuttuu kestoarvio, `
      + 'joten yllä olevat aika-arviot ovat karkeita.',
      { goalId: goal.id }
    ));
  }

  return found;
}

function hours(minutes) {
  const n = Number(minutes) || 0;
  if (n < 60) return `${n} min`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

// =====================================================================
// VÄLITAVOITTEET JA RIIPPUVUUDET
// =====================================================================

/** Välitavoitteiden järjestys ja suhde tavoitteen määräpäivään. */
export function detectMilestoneConflicts({ goal, milestones = [] } = {}) {
  const found = [];
  if (!goal) return found;

  for (const { after, before } of outOfOrderMilestones(milestones, goal.id)) {
    found.push(conflict(
      CONFLICT.MILESTONE_ORDER,
      SEVERITY.BLOCKING,
      `Välitavoite "${after.title}" (${after.targetDate}) on jonossa myöhemmin `
      + `kuin "${before.title}" (${before.targetDate}), mutta sen päivä on aikaisempi.`,
      { goalId: goal.id, milestoneIds: [before.id, after.id] }
    ));
  }

  if (goal.targetDate) {
    const late = milestones.filter(m =>
      m && m.goalId === goal.id
      && m.status === 'open'
      && m.targetDate
      && m.targetDate > goal.targetDate);

    for (const milestone of late) {
      found.push(conflict(
        CONFLICT.MILESTONE_AFTER_GOAL,
        SEVERITY.WARNING,
        `Välitavoite "${milestone.title}" (${milestone.targetDate}) on tavoitteen `
        + `määräpäivän ${goal.targetDate} jälkeen.`,
        { goalId: goal.id, milestoneIds: [milestone.id] }
      ));
    }
  }

  return found;
}

/**
 * Riippuvuudet: edeltäjä ei saa olla seuraajansa jälkeen.
 *
 * Riippuvuus luetaan tehtävän `dependsOn`-listasta. Se on
 * SOVELLUSTASON käsite eikä kannassa: nykyinen skeema ei tunne
 * riippuvuuksia, ja niiden lisääminen on migraatiokysymys. Ks.
 * docs/GOAL-TO-ACTION.md.
 *
 * Puuttuva edeltäjä ohitetaan hiljaa: se on eri vika, ja siitä
 * huomauttaminen tässä sekoittaisi kaksi asiaa.
 */
export function detectDependencyConflicts(tasks = []) {
  const byId = new Map(tasks.filter(Boolean).map(task => [task.id, task]));
  const found = [];

  for (const task of tasks) {
    if (!task || !Array.isArray(task.dependsOn) || task.dependsOn.length === 0) continue;
    if (!task.date) continue;

    for (const dependencyId of task.dependsOn) {
      const dependency = byId.get(String(dependencyId));
      if (!dependency || !dependency.date) continue;
      if (dependency.completed) continue;

      if (dependency.date > task.date) {
        found.push(conflict(
          CONFLICT.DEPENDENCY_ORDER,
          SEVERITY.BLOCKING,
          `"${task.title}" (${task.date}) on ajoitettu ennen kuin "${dependency.title}" `
          + `(${dependency.date}) on tehty.`,
          { taskIds: [dependency.id, task.id] }
        ));
      }
    }
  }

  return found;
}

// =====================================================================
// PORTFOLIO
// =====================================================================

/**
 * Kilpailevatko useat tavoitteet samasta ajasta?
 *
 * TÄMÄ ON SE VIKA, JONKA TAVOITEKOHTAINEN TARKISTUS EI LÖYDÄ.
 *
 * Jokainen tavoite voi olla erikseen täysin mahdollinen ja kaikki
 * yhdessä silti mahdottomia. Aikatauluttaja, joka optimoi tavoitteet
 * yksi kerrallaan, tuottaa juuri sellaisen suunnitelman — ja se
 * näyttää oikealta jokaisesta tavoitenäkymästä katsottuna.
 *
 * @param {Array<{goal:object, remaining:object}>} entries
 * @param {object} capacity  koko horisontin kapasiteetti
 */
export function detectPortfolioConflicts(entries = [], capacity = null) {
  if (!capacity || entries.length < 2) return [];

  const totalRequired = entries.reduce(
    (total, entry) => total + (entry.remaining?.minutes || 0), 0);

  const available = capacity.totalUsableMinutes;
  if (available <= 0 || totalRequired <= available) return [];

  const names = entries
    .map(entry => entry.goal?.title)
    .filter(Boolean)
    .slice(0, 3)
    .join(', ');

  return [conflict(
    CONFLICT.PORTFOLIO_OVERCOMMIT,
    SEVERITY.BLOCKING,
    `${entries.length} tavoitetta vaativat yhteensä noin ${hours(totalRequired)}, `
    + `mutta suunniteltavaa aikaa on ${hours(available)}. `
    + `Erikseen jokainen voi olla mahdollinen — yhdessä ne eivät ole. (${names})`,
    {
      goalIds: entries.map(entry => entry.goal?.id).filter(Boolean),
      requiredMinutes: totalRequired,
      availableMinutes: available
    }
  )];
}

/** Yksittäisen päivän ahtaus. */
export function detectDayOverload(capacityDays = []) {
  const found = [];

  for (const day of capacityDays) {
    if (!day) continue;
    // Tapahtumat ovat sitoumuksia kuten kiinteät tehtävät. Vanha
    // kapasiteettiolio ilman `events`-lukua lasketaan kuten ennen.
    const planned = day.counts.fixed + day.counts.flexible + day.counts.routines
      + (Number.isFinite(day.counts.events) ? day.counts.events : 0);

    if (day.usableMinutes === 0 && planned >= CROWDED_TASKS_PER_DAY) {
      found.push(conflict(
        CONFLICT.DAY_OVERLOADED,
        SEVERITY.WARNING,
        `${day.dateIso}: ${planned} asiaa eikä vapaata aikaa jäljellä.`,
        { dateIso: day.dateIso }
      ));
    }
  }

  return found;
}

// =====================================================================
// KOKOAVA
// =====================================================================

/**
 * Kaikki ristiriidat yhdessä, vakavimmasta lievimpään.
 *
 * Tämä on se funktio, jota käyttöliittymä kutsuu. Osien erillisyys on
 * testejä ja uudelleenkäyttöä varten — kutsujan ei tarvitse tietää
 * montako tarkistusta on olemassa.
 */
export function detectAllConflicts({
  goal = null,
  goals = [],
  milestones = [],
  tasks = [],
  remaining = null,
  capacity = null,
  portfolioEntries = [],
  todayIso = null,
  events = [],
  blocks = []
} = {}) {
  const found = [
    ...detectOverlaps(tasks),
    ...detectDependencyConflicts(tasks),
    ...detectDayOverload(capacity?.days || [])
  ];

  // Kalenteri (valinnainen). Menneestä ei huomauteta: sitä ei voi enää muuttaa.
  const hasEvents = Array.isArray(events) && events.length > 0;
  const hasBlocks = Array.isArray(blocks) && blocks.length > 0;
  if (hasEvents || hasBlocks) {
    found.push(...detectBlockConflicts({ tasks, events, blocks, fromIso: todayIso }));
  }
  if (hasEvents) {
    found.push(...detectEventOverlaps({ tasks, events, fromIso: todayIso }));
  }

  if (goal) {
    found.push(...detectCapacityConflicts({ goal, remaining, capacity, todayIso }));
    found.push(...detectMilestoneConflicts({ goal, milestones }));
  }

  if (portfolioEntries.length > 1) {
    found.push(...detectPortfolioConflicts(portfolioEntries, capacity));
  }

  void goals;
  return sortConflicts(found);
}
