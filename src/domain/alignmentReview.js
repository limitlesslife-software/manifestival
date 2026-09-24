// Viikkokatsaus, seuraavan viikon muutosehdotukset ja palaute
// suunnittelumoottorille.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa, ei tekoälyä.
//
// =====================================================================
// EHDOTUS EI OLE MUUTOS
// =====================================================================
//
// proposeAdjustments() KUVAA mitä voisi muuttaa. Se ei muuta mitään.
// Jokainen ehdotus viedään käyttöliittymässä vahvistusdialogin läpi
// (src/app/alignment.js applyAdjustment), ja vasta vahvistettu ehdotus
// kirjoittaa. Sama periaate kuin suunnitelmaehdotuksessa (plan.js).
//
// =====================================================================
// TILANNEKUVA ON HISTORIAA
// =====================================================================
//
// buildReviewSnapshot() tallentaa sen, minkä käyttäjä näki: kapasiteetti,
// alueiden tavoitteet, suunniteltu ja toteutunut yhteenveto, havainnot ja
// aineiston laatu. Tehtäviä ei kopioida: vain lukuja ja tunnisteita.
// Versio kasvaa jos muoto muuttuu, ja vanha versio luetaan sellaisenaan.

import { SIGNAL, SEVERITY, RULES } from './alignment.js';
import { formatMinutes, importanceLabel, countOf } from './lifeArea.js';
import { priorityWeight } from './priority.js';

export const SNAPSHOT_VERSION = 1;
export const MAX_REFLECTION_LENGTH = 4000;
export const MAX_PROPOSALS = 12;
const MAX_PAUSE_PROPOSALS = 3;

export const ADJUSTMENT = Object.freeze({
  SET_CAPACITY: 'set_capacity',
  POSTPONE_TASKS: 'postpone_tasks',
  CREATE_TASK: 'create_task',
  CHANGE_TARGET: 'change_target',
  PAUSE_GOAL: 'pause_goal'
});
export const ADJUSTMENT_TYPES = Object.freeze(Object.values(ADJUSTMENT));

/** Katsauksen seitsemän kysymystä. Järjestys on katsauksen järjestys. */
export const REVIEW_QUESTIONS = Object.freeze([
  'Mikä oli tällä viikolla tärkeää?',
  'Mitä suunnittelin?',
  'Mitä oikeasti tapahtui?',
  'Missä kuormitus ylittyi?',
  'Mikä jäi huomiotta?',
  'Missä todellisuus poikkesi tavoitteista?',
  'Mitä muutan ensi viikolla?'
]);

// ---------------------------------------------------------- selitykset

function areaName(areasById, id) {
  const area = id ? areasById.get(id) : null;
  return area ? area.name : 'Alue';
}

/**
 * Havainnon selitys suomeksi. Deterministinen: sama havainto tuottaa aina
 * saman lauseen. Sävy on toteava, ei moralisoiva.
 *
 * @returns {{title: string, text: string, why: string}}
 */
export function explainSignal(signal, areas = []) {
  const byId = new Map((areas || []).map(area => [area.id, area]));
  const m = signal.metrics || {};
  const name = areaName(byId, signal.areaId);

  switch (signal.kind) {
    case SIGNAL.OVERLOAD:
      if (signal.rule === 'overload.possible_with_unestimated') {
        return {
          title: 'Kuormitus voi ylittyä',
          text: `Arvioitu työ vie ${formatMinutes(m.plannedMinutes)} kapasiteetistasi `
            + `${formatMinutes(m.availableMinutes)}, ja lisäksi ${countOf(m.unknownCount, 'asia', 'asiaa')} on arvioimatta.`,
          why: `Tunnettu työ on vähintään ${Math.round(RULES.OVERLOAD_POSSIBLE_RATIO * 100)} % `
            + 'kapasiteetista ja osa työstä on ilman kestoarviota.'
        };
      }
      return {
        title: 'Kuormitus ylittää kapasiteetin',
        text: `Suunniteltu työ ${formatMinutes(m.plannedMinutes)} on ${formatMinutes(m.overageMinutes)} yli `
          + `viikon kapasiteetin ${formatMinutes(m.availableMinutes)}`
          + (m.percentOfCapacity !== null ? ` (${m.percentOfCapacity} % kapasiteetista).` : '.')
          + (m.unknownCount > 0 ? ` Lisäksi ${countOf(m.unknownCount, 'asia', 'asiaa')} on arvioimatta.` : ''),
        why: 'Arvioitujen kestojen summa on suurempi kuin itse asettamasi viikon kapasiteetti. '
          + `Vahva, kun ylitys on vähintään ${Math.round((RULES.OVERLOAD_STRONG_RATIO - 1) * 100)} %.`
      };

    case SIGNAL.NEGLECT:
      if (signal.basis === 'actual') {
        return {
          title: `${name} jäämässä huomiotta`,
          text: `${name} on saanut ${formatMinutes(m.actualMinutes)}, vaikka tähän mennessä `
            + `tavoitteesi mukaan olisi kertynyt noin ${formatMinutes(m.expectedByNowMinutes)} `
            + `(viikon tavoite ${formatMinutes(m.targetMinutes)}).`,
          why: `Alue on sinulle ${importanceLabel(byId.get(signal.areaId)?.importance).toLowerCase() || 'tärkeä'}, `
            + `ja kirjattu aika on alle ${Math.round(RULES.NEGLECT_RATIO * 100)} % siitä, mitä `
            + `${m.weekProgressPercent} % kuluneesta viikosta vastaa.`
        };
      }
      return {
        title: `${name}: suunnitelmassa vähän aikaa`,
        text: `Tämän viikon suunnitelmassa ${name} saa ${formatMinutes(m.plannedMinutes)}, `
          + `tavoitteesi on ${formatMinutes(m.targetMinutes)}.`
          + (m.unknownCount > 0 ? ` (${countOf(m.unknownCount, 'asia', 'asiaa')} ilman kestoa.)` : ''),
        why: `Tärkeä alue, jolle suunniteltu aika on alle ${Math.round(RULES.NEGLECT_RATIO * 100)} % `
          + 'viikkotavoitteesta. Suunnitelma on vielä muutettavissa.'
      };

    case SIGNAL.MISALIGNMENT:
      return {
        title: m.direction === 'over' ? `${name} vie enemmän kuin halusit` : `${name} saa vähemmän kuin halusit`,
        text: `${name} sai ${m.actualPercent} % ${signal.basis === 'actual' ? 'ajastasi' : 'suunnitellusta ajastasi'}, `
          + `vaikka tavoite oli ${m.desiredPercent} %.`
          + (m.incomplete ? ' Aineisto on vajaa, joten tämä on suuntaa-antava.' : ''),
        why: `Osuus poikkeaa toivomastasi jakaumasta vähintään ${RULES.MISALIGNMENT_POINTS} prosenttiyksikköä. `
          + 'Toivottu jakauma lasketaan alueiden viikkotavoitteista.'
      };

    case SIGNAL.TARGET_TENSION:
      return {
        title: 'Tavoitteet eivät mahdu viikkoon',
        text: `Alueiden aikatavoitteet ovat yhteensä ${formatMinutes(m.targetsMinutes)}, `
          + `kapasiteettisi ${formatMinutes(m.availableMinutes)}.`,
        why: 'Tärkeys ja kapasiteetti ovat eri asioita: kaikki voi olla tärkeää, mutta viikkoon mahtuu '
          + 'rajallisesti. Kumpaakaan ei muuteta puolestasi.'
      };

    default:
      return { title: 'Havainto', text: '', why: '' };
  }
}

// ---------------------------------------------------------- tilannekuva

/**
 * Tiivis, versioitu tilannekuva viikosta. Ei tehtävien otsikoita, ei
 * muistiinpanoja: vain luvut, alueiden nimet ja tunnisteet.
 */
export function buildReviewSnapshot(analysis) {
  return {
    version: SNAPSHOT_VERSION,
    weekStart: analysis.weekStart,
    capacity: {
      availableMinutes: analysis.capacity.availableMinutes,
      energyLevel: analysis.capacity.energyLevel
    },
    areas: analysis.areas.map(area => ({
      id: area.id, name: area.name, importance: area.importance, active: area.active,
      targetMinutes: area.targetMinutes, desiredPercent: area.desiredPercent,
      plannedMinutes: area.plannedMinutes, plannedUnknown: area.plannedUnknown,
      actualMinutes: area.actualMinutes, actualPercent: area.actualPercent
    })),
    planned: { ...analysis.planned },
    actual: { ...analysis.actual },
    unassigned: { ...analysis.unassigned },
    signals: analysis.signals.map(signal => ({
      kind: signal.kind, severity: signal.severity, areaId: signal.areaId,
      basis: signal.basis, rule: signal.rule, metrics: { ...signal.metrics }
    })),
    dataQuality: { ...analysis.dataQuality, reasons: [...analysis.dataQuality.reasons] }
  };
}

export function normalizeAlignmentReview(input = {}) {
  const reflection = input.reflection == null
    ? null
    : String(input.reflection).trim().slice(0, MAX_REFLECTION_LENGTH) || null;
  const version = Number(input.snapshotVersion);
  return {
    id: input.id != null ? String(input.id) : null,
    weekStart: typeof input.weekStart === 'string' ? input.weekStart : null,
    snapshotVersion: Number.isInteger(version) && version >= 1 ? version : SNAPSHOT_VERSION,
    snapshot: input.snapshot && typeof input.snapshot === 'object' && !Array.isArray(input.snapshot)
      ? input.snapshot : {},
    reflection,
    adjustments: Array.isArray(input.adjustments) ? input.adjustments : [],
    completedAt: input.completedAt ?? null,
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

export function validateAlignmentReview(review) {
  const errors = {};
  if (!review || !review.weekStart) errors.weekStart = 'Viikko puuttuu.';
  if (!review || !review.snapshot || review.snapshot.version === undefined) {
    errors.snapshot = 'Tilannekuva puuttuu.';
  }
  if (review && review.reflection && review.reflection.length > MAX_REFLECTION_LENGTH) {
    errors.reflection = `Pohdinta voi olla enintään ${MAX_REFLECTION_LENGTH} merkkiä.`;
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

// ------------------------------------------------------------ ehdotukset

function roundToQuarter(minutes) {
  return Math.max(0, Math.round(minutes / 15) * 15);
}

/** Havainnot lajeittain. Tiedoksi-tason havainto ehdottaa muutosta vain pyydettäessä. */
function signalsOf(analysis, kind, { includeInfo = false } = {}) {
  return analysis.signals.filter(signal =>
    signal.kind === kind && (includeInfo || signal.severity !== SEVERITY.INFO));
}

/**
 * Seuraavan viikon muutosehdotukset havaintojen perusteella.
 *
 * @param {object} analysis   tämän viikon analyzeWeek()-tulos
 * @param {object} context
 * @param {Array}  context.areas
 * @param {Array}  context.goals
 * @param {Array}  context.tasks
 * @param {object|null} [context.nextWeekAnalysis]  seuraavan viikon analyysi
 * @param {object|null} [context.nextCapacity]      seuraavan viikon kapasiteetti
 * @returns {Array<object>} ehdotukset; mitään ei ole muutettu
 */
export function proposeAdjustments(analysis, {
  areas = [], goals = [], tasks = [], nextWeekAnalysis = null, nextCapacity = null
} = {}) {
  const proposals = new Map();
  const add = proposal => { if (!proposals.has(proposal.id)) proposals.set(proposal.id, proposal); };
  const areasById = new Map(areas.map(area => [area.id, area]));
  const next = analysis.nextWeekStart;
  const targetsTotal = areas
    .filter(area => area.active && area.targetMinutesPerWeek > 0)
    .reduce((sum, area) => sum + area.targetMinutesPerWeek, 0);

  // 1. Kapasiteetti ensi viikolle, jos sitä ei ole asetettu.
  if (!nextCapacity) {
    add({
      id: `${ADJUSTMENT.SET_CAPACITY}:${next}`,
      type: ADJUSTMENT.SET_CAPACITY,
      reason: null,
      label: 'Aseta ensi viikon kapasiteetti',
      detail: analysis.capacity.declared
        ? `Tämän viikon arvio oli ${formatMinutes(analysis.capacity.availableMinutes)}.`
        : 'Ilman kapasiteettia kuormitusta ei voi arvioida.',
      payload: { weekStart: next, availableMinutes: analysis.capacity.availableMinutes }
    });
  }

  const overloaded = analysis.signals.some(signal =>
    signal.kind === SIGNAL.OVERLOAD && signal.severity !== SEVERITY.INFO);

  // 2. Ensi viikon kuorman keventäminen: siirrä vähiten tärkeitä viikolla
  //    eteenpäin. Tehtävällä on aina päivä (validateTask), joten
  //    "ilman päivää" ei ole vaihtoehto: tehtävä siirtyy, se ei katoa.
  const cap = nextCapacity ? nextCapacity.availableMinutes : analysis.capacity.availableMinutes;
  if (nextWeekAnalysis && Number.isInteger(cap) && nextWeekAnalysis.planned.knownMinutes > cap) {
    const excess = nextWeekAnalysis.planned.knownMinutes - cap;
    const tasksById = new Map(tasks.map(task => [task.id, task]));
    const candidates = nextWeekAnalysis.items
      .filter(item => item.kind === 'task' && !item.completed && item.minutes !== null)
      .map(item => ({ item, task: tasksById.get(item.id), area: areasById.get(item.areaId) }))
      .filter(entry => entry.task && !entry.task.completed)
      .sort((a, b) =>
        // Liittämätön ensin, sitten vähiten tärkeä alue, sitten matalin prioriteetti.
        (a.area ? a.area.importance : 0) - (b.area ? b.area.importance : 0)
        || priorityWeight(b.task.priority) - priorityWeight(a.task.priority)
        || (b.item.date || '').localeCompare(a.item.date || '')
        || a.item.id.localeCompare(b.item.id));
    const chosen = [];
    let freed = 0;
    for (const entry of candidates) {
      if (freed >= excess) break;
      chosen.push(entry.item.id);
      freed += entry.item.minutes;
    }
    if (chosen.length > 0) {
      add({
        id: `${ADJUSTMENT.POSTPONE_TASKS}:${next}`,
        type: ADJUSTMENT.POSTPONE_TASKS,
        reason: { kind: SIGNAL.OVERLOAD },
        label: `Kevennä ensi viikkoa: siirrä ${countOf(chosen.length, 'tehtävä', 'tehtävää')} viikolla eteenpäin`,
        detail: `Ensi viikon suunnitelma ylittää kapasiteetin ${formatMinutes(excess)}. `
          + 'Tehtävät säilyvät; ne siirtyvät samalle viikonpäivälle viikkoa myöhemmin.',
        payload: { taskIds: chosen, freedMinutes: freed, days: 7 }
      });
    }
  }

  // 3. Kuormituksessa: keskeytä vähiten tärkeiden alueiden tavoitteita.
  if (overloaded) {
    const pausable = goals
      .filter(goal => goal && goal.status === 'active' && goal.lifeAreaId)
      .map(goal => ({ goal, area: areasById.get(goal.lifeAreaId) }))
      .filter(entry => entry.area && entry.area.importance <= 2)
      .sort((a, b) => a.area.importance - b.area.importance
        || priorityWeight(b.goal.priority) - priorityWeight(a.goal.priority)
        || a.goal.id.localeCompare(b.goal.id))
      .slice(0, MAX_PAUSE_PROPOSALS);
    for (const { goal, area } of pausable) {
      add({
        id: `${ADJUSTMENT.PAUSE_GOAL}:${goal.id}`,
        type: ADJUSTMENT.PAUSE_GOAL,
        reason: { kind: SIGNAL.OVERLOAD, areaId: area.id },
        label: `Keskeytä tavoite "${goal.title}"`,
        detail: `Alue ${area.name} on sinulle ${importanceLabel(area.importance).toLowerCase()}. `
          + 'Keskeytetty tavoite ei katoa; sen voi jatkaa milloin tahansa.',
        payload: { goalId: goal.id }
      });
    }
  }

  // 4. Huomiotta jäävä alue: varaa aikaa TAI muuta tavoitetta.
  // Suunnitelmaan perustuva huomiotta jääminen on tiedoksi-tasoa, mutta
  // juuri silloin ajan varaaminen on vielä helppoa: siksi mukaan.
  for (const signal of signalsOf(analysis, SIGNAL.NEGLECT, { includeInfo: true })) {
    const area = areasById.get(signal.areaId);
    if (!area) continue;
    const goal = goals
      .filter(entry => entry && entry.lifeAreaId === area.id && entry.status === 'active')
      .sort((a, b) => priorityWeight(a.priority) - priorityWeight(b.priority) || a.id.localeCompare(b.id))[0];
    const block = Math.min(60, area.targetMinutesPerWeek || 60);
    add({
      id: `${ADJUSTMENT.CREATE_TASK}:${area.id}`,
      type: ADJUSTMENT.CREATE_TASK,
      reason: { kind: SIGNAL.NEGLECT, areaId: area.id },
      label: `Varaa aikaa: ${area.name}`,
      detail: `Uusi ${formatMinutes(block)} varaus ensi viikolle`
        + (goal ? ` tavoitteeseen "${goal.title}".` : '.'),
      payload: {
        title: `Aikaa: ${area.name}`, date: next, durationMinutes: block,
        goalId: goal ? goal.id : null, category: area.categoryKey || null, areaId: area.id
      }
    });

    const observed = signal.basis === 'actual'
      ? roundToQuarter((signal.metrics.actualMinutes || 0) / Math.max(analysis.progress.fraction, 1 / 7))
      : roundToQuarter(signal.metrics.plannedMinutes || 0);
    if (observed < area.targetMinutesPerWeek) {
      add({
        id: `${ADJUSTMENT.CHANGE_TARGET}:${area.id}`,
        type: ADJUSTMENT.CHANGE_TARGET,
        reason: { kind: SIGNAL.NEGLECT, areaId: area.id },
        label: `Tai muuta alueen ${area.name} tavoitetta`,
        detail: `Nykyinen tavoite ${formatMinutes(area.targetMinutesPerWeek)}; tämän viikon tahdilla `
          + `${formatMinutes(observed)}. Valitse itse, kumpi kuvaa haluamaasi.`,
        payload: { areaId: area.id, from: area.targetMinutesPerWeek, to: observed }
      });
    }
  }

  // 5. Jakauman poikkeama: päivitä tavoite TAI jätä ennalleen. Vain
  //    ehdotus tavoitteen muuttamisesta; ajan siirto tapahtuu kohdissa 2 ja 4.
  for (const signal of signalsOf(analysis, SIGNAL.MISALIGNMENT)) {
    const area = areasById.get(signal.areaId);
    if (!area || !area.active || !Number.isInteger(area.targetMinutesPerWeek)) continue;
    // Tavoite, jolla toivottu osuus vastaisi toteutunutta, kun muiden
    // alueiden tavoitteet pysyvät ennallaan: osuus x tavoitteiden summa.
    const share = (signal.metrics.basisMinutes || 0) / Math.max(signal.metrics.assignedMinutes || 1, 1);
    const suggested = roundToQuarter(share * targetsTotal);
    if (suggested === area.targetMinutesPerWeek) continue;
    add({
      id: `${ADJUSTMENT.CHANGE_TARGET}:${area.id}`,
      type: ADJUSTMENT.CHANGE_TARGET,
      reason: { kind: SIGNAL.MISALIGNMENT, areaId: area.id },
      label: `Tarkista alueen ${area.name} tavoite`,
      detail: `Toteutunut osuus ${signal.metrics.actualPercent} %, tavoite ${signal.metrics.desiredPercent} %. `
        + 'Jos todellisuus kuvaa haluamaasi paremmin, päivitä tavoite; muuten jätä ennalleen.',
      payload: { areaId: area.id, from: area.targetMinutesPerWeek, to: suggested }
    });
  }

  return [...proposals.values()].slice(0, MAX_PROPOSALS);
}

// ------------------------------------------------ palaute suunnittelulle

/**
 * Suunnan palaute Tavoitteesta tekemiseksi -moottorille.
 *
 * Vain luvut ja tunnisteet; ei muuta mitään. `capHours` rajaa suunnittelun
 * olettaman viikon vapaan ajan (planSchema.buildPlanningContext), kun
 * käyttäjä on itse sanonut ehtivänsä vähemmän — tai kun viikko ylittyi.
 */
export function planningFeedback(analysis, { nextCapacity = null } = {}) {
  if (!analysis) return null;
  const overload = analysis.signals.find(signal => signal.kind === SIGNAL.OVERLOAD
    && signal.severity !== SEVERITY.INFO);
  const declared = nextCapacity && Number.isInteger(nextCapacity.availableMinutes)
    ? nextCapacity.availableMinutes
    : analysis.capacity.availableMinutes;
  return {
    overloaded: Boolean(overload),
    capHours: Number.isInteger(declared) ? Math.floor(declared / 60) : null,
    reduceByMinutes: overload ? overload.metrics.overageMinutes : 0,
    prioritizeAreaIds: analysis.signals
      .filter(signal => signal.kind === SIGNAL.NEGLECT).map(signal => signal.areaId),
    deprioritizeAreaIds: analysis.signals
      .filter(signal => signal.kind === SIGNAL.MISALIGNMENT && signal.metrics.direction === 'over')
      .map(signal => signal.areaId)
  };
}
