// Tavoitteesta tekemiseksi × Suunta: rajat suunnittelulle ja
// suunnitelman tarkistus ENNEN hyväksyntää.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa, EI TEKOÄLYÄ.
//
// =====================================================================
// 1. RAJAT (buildPlanningConstraints)
// =====================================================================
//
// Suunnittelija saa TIIVIIN, LUKUMUOTOISEN rajaolion. Ei alueiden nimiä,
// ei tehtävien otsikoita, ei havaintojen tekstiä. Palvelin (api/_validatePlan.js)
// päästää läpi vain nimetyt lukukentät; kaikki muu pudotetaan.
//
// Tekoäly suunnittelee rajojen SISÄLLÄ. Se ei voi muuttaa alueiden
// tärkeyttä, tavoitteita eikä kapasiteettia: niistä se näkee vain
// lukumääriä.
//
// =====================================================================
// 2. TARKISTUS (validatePlanAlignment)
// =====================================================================
//
// Tekoälyn tuottama suunnitelma EI OLE POIKKEUS Suunnan säännöistä. Ennen
// kuin käyttäjä hyväksyy sen, samat deterministiset säännöt ajetaan
// viikoille, joille suunnitelma tuo työtä:
//
//   "Suunnitelma mahtuu kapasiteettiin."
//   "Suunnitelma ylittää kapasiteetin 3 h (viikko 5.10.–11.10.)."
//   "Suunnitelman jälkeen viikkoon ei mahdu Perhe-alueen tavoitetta."
//
// Tarkistus ei estä hyväksyntää: se kertoo, ja käyttäjä päättää.

import { analyzeWeek, SIGNAL, isNeglectShortfall } from './alignment.js';
import { weekStartOf, weekDates, capacityForWeek } from './weeklyCapacity.js';
import { normalizeRoutine } from './routine.js';
import { formatMinutes } from './lifeArea.js';
import { TIME_RULES } from './alignmentPolicy.js';

/** Tarkistettavien viikkojen enimmäismäärä (suunnitelman horisontti). */
export const MAX_VALIDATED_WEEKS = 6;
const PLAN_GOAL_ID = 'plan:goal';

function hours(minutes) {
  return Number.isFinite(minutes) ? Math.round((minutes / 60) * 2) / 2 : null;
}

/**
 * Suunnittelun rajat: vain lukuja.
 *
 * @param {object} analysis  analyzeWeek()-tulos viikolle, jolle suunnitellaan
 */
export function buildPlanningConstraints(analysis) {
  if (!analysis) return null;
  const capacity = analysis.capacity || {};
  const energy = analysis.energy || {};
  const important = (analysis.areas || []).filter(area => area.active
    && area.importance >= TIME_RULES.NEGLECT_MIN_IMPORTANCE && area.targetMinutes > 0);
  // Vain todetut vajeet: alue, jonka suunnitelmasta osa on ilman kestoa
  // (`neglect.plan_unknown`), ei ole vajaa — sen aikaa ei tiedetä.
  const neglected = new Set((analysis.signals || []).filter(isNeglectShortfall).map(signal => signal.areaId));
  const shortfall = important
    .filter(area => neglected.has(area.id))
    .reduce((sum, area) => sum + Math.max(0, area.targetMinutes - (area.plannedMinutes || 0)), 0);
  const remainingHours = capacity.declared ? Math.max(0, hours(capacity.remainingMinutes)) : null;
  // Suojattu aika ei voi olla enempää kuin viikossa on jäljellä: muuten
  // rajat olisivat keskenään ristiriitaiset.
  const protectedHours = remainingHours === null ? hours(shortfall) : Math.min(hours(shortfall), remainingHours);

  return {
    capacityHours: capacity.declared ? hours(capacity.availableMinutes) : null,
    committedHours: hours(analysis.planned ? analysis.planned.knownMinutes : null),
    remainingHours,
    unestimatedCount: analysis.planned ? analysis.planned.unknownCount : null,
    heavyBudgetHours: Number.isInteger(energy.budgetMinutes) ? hours(energy.budgetMinutes) : null,
    heavyRemainingHours: Number.isInteger(energy.budgetMinutes) ? Math.max(0, hours(energy.remainingMinutes)) : null,
    neglectedImportantAreaCount: important.filter(area => neglected.has(area.id)).length,
    /** Tärkeiden alueiden vaje: aika jota suunnitelma EI saisi viedä (enintään jäljellä oleva). */
    protectedHours
  };
}

function virtualTasks(planTasks = [], goalId) {
  return (planTasks || []).filter(task => task && task.date).map((task, index) => ({
    id: `plan:task:${task.ref || index}`,
    title: task.title || '',
    date: task.date,
    durationMinutes: Number.isInteger(task.durationMinutes) ? task.durationMinutes : null,
    category: task.category || 'muu',
    priority: task.priority || 'normaali',
    goalId,
    completed: false
  }));
}

function virtualRoutines(planRoutines = [], goalId, startDate) {
  return (planRoutines || []).map((routine, index) => normalizeRoutine({
    id: `plan:routine:${routine.ref || index}`,
    title: routine.title || 'Rutiini',
    recurrence: { type: routine.recurrenceType || 'weekly', weekdays: routine.weekdays || [1] },
    durationMinutes: routine.durationMinutes || 30,
    category: routine.category || 'muu',
    priority: routine.priority || 'normaali',
    active: true,
    goalId,
    startDate
  }));
}

function shortLabel(weekStart) {
  const dates = weekDates(weekStart);
  const fmt = iso => { const [, m, d] = iso.split('-').map(Number); return `${d}.${m}.`; };
  return dates.length ? `${fmt(dates[0])}–${fmt(dates[6])}` : weekStart;
}

/**
 * Tarkista suunnitelma Suunnan säännöillä.
 *
 * @param {object} args
 * @param {Array}  args.planTasks     suunnitelman tehtävät (date, durationMinutes, category)
 * @param {Array}  [args.planRoutines]
 * @param {string|null} [args.areaId] suunnitelman elämänalue (tavoitteen tai kategorian kautta)
 * @param {object} args.base          nykyinen aineisto: areas, goals, projects, tasks, routines,
 *                                    exceptions, timeEntries, capacities, itemSettings, todayIso
 * @returns {{weeks: Array, undatedMinutes: number, undatedCount: number, messages: Array<{level, text}>}}
 */
export function validatePlanAlignment({ planTasks = [], planRoutines = [], areaId = null, base }) {
  const todayIso = base.todayIso;
  const goals = [...(base.goals || []), { id: PLAN_GOAL_ID, title: '', status: 'active', lifeAreaId: areaId, priority: 'normaali' }];
  const extraTasks = virtualTasks(planTasks, PLAN_GOAL_ID);
  const extraRoutines = virtualRoutines(planRoutines, PLAN_GOAL_ID, todayIso);
  const undated = (planTasks || []).filter(task => task && !task.date);
  const undatedMinutes = undated.reduce((sum, task) => sum + (Number.isInteger(task.durationMinutes) ? task.durationMinutes : 0), 0);

  const weekSet = new Set(extraTasks.map(task => weekStartOf(task.date)).filter(Boolean));
  if (extraRoutines.length > 0 && todayIso) weekSet.add(weekStartOf(todayIso));
  const weekStarts = [...weekSet].sort().slice(0, MAX_VALIDATED_WEEKS);
  const areasById = new Map((base.areas || []).map(area => [area.id, area]));

  const weeks = weekStarts.map(weekStart => {
    const common = {
      weekStart, todayIso, areas: base.areas, projects: base.projects,
      exceptions: base.exceptions, timeEntries: base.timeEntries,
      capacity: capacityForWeek(base.capacities || [], weekStart), itemSettings: base.itemSettings
    };
    const without = analyzeWeek({ ...common, goals: base.goals, tasks: base.tasks, routines: base.routines });
    const withPlan = analyzeWeek({
      ...common, goals, tasks: [...(base.tasks || []), ...extraTasks],
      routines: [...(base.routines || []), ...extraRoutines]
    });
    const added = withPlan.planned.knownMinutes - without.planned.knownMinutes;
    const capacity = withPlan.capacity.declared ? withPlan.capacity.availableMinutes : null;
    const overage = capacity === null ? null : Math.max(0, withPlan.planned.knownMinutes - capacity);
    const addedOverage = capacity === null ? null : Math.max(0, overage - Math.max(0, without.planned.knownMinutes - capacity));

    // Tärkeä alue, jonka tavoite ei suunnitelman jälkeen mahdu viikkoon.
    const crowded = [];
    if (capacity !== null) {
      const room = Math.max(0, capacity - withPlan.planned.knownMinutes);
      for (const signal of withPlan.signals.filter(isNeglectShortfall)) {
        const area = areasById.get(signal.areaId);
        if (!area || area.id === areaId) continue;
        const row = withPlan.areas.find(r => r.id === area.id);
        const missing = Math.max(0, (area.targetMinutesPerWeek || 0) - (row ? row.plannedMinutes : 0));
        if (missing > room) crowded.push({ areaId: area.id, name: area.name, missingMinutes: missing });
      }
    }

    return {
      weekStart, addedMinutes: added, plannedMinutes: withPlan.planned.knownMinutes,
      capacityMinutes: capacity, overageMinutes: overage, addedOverageMinutes: addedOverage,
      fits: capacity === null ? null : overage === 0,
      energyOverload: withPlan.signals.some(s => s.kind === SIGNAL.ENERGY_OVERLOAD && s.severity !== 'info'),
      crowdedAreas: crowded
    };
  });

  const messages = [];
  if (weeks.length === 0 && undated.length === 0) {
    messages.push({ level: 'info', text: 'Suunnitelma ei tuo päivättyä työtä, joten viikkoihin ei ole verrattavaa.' });
  }
  const assessable = weeks.filter(week => week.fits !== null);
  if (assessable.length > 0 && assessable.every(week => week.fits)) {
    messages.push({ level: 'ok', text: 'Suunnitelma mahtuu kapasiteettiin.' });
  }
  for (const week of weeks) {
    if (week.fits === null) {
      messages.push({ level: 'info', text: `Viikolle ${shortLabel(week.weekStart)} ei ole kapasiteettia, joten mahtumista ei voi arvioida.` });
    } else if (!week.fits) {
      messages.push({ level: 'attention', text: `Suunnitelma ylittää kapasiteetin ${formatMinutes(week.overageMinutes)} (viikko ${shortLabel(week.weekStart)}).` });
    }
    for (const area of week.crowdedAreas) {
      messages.push({ level: 'attention',
        text: `Suunnitelman jälkeen viikolle ${shortLabel(week.weekStart)} ei mahdu tärkeän alueen ${area.name} tavoitetta (puuttuu ${formatMinutes(area.missingMinutes)}).` });
    }
    if (week.energyOverload) {
      messages.push({ level: 'attention', text: `Viikon ${shortLabel(week.weekStart)} kuormittava osuus ylittää oman rajasi.` });
    }
  }
  if (undated.length > 0) {
    messages.push({ level: 'info',
      text: `${undated.length} tehtävää (${formatMinutes(undatedMinutes)}) on ilman päivää; niiden viikkoa ei vielä tiedetä.` });
  }
  return { weeks, undatedMinutes, undatedCount: undated.length, messages };
}
