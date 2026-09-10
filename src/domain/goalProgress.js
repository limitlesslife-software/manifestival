// Tavoitteen edistyminen: nimetyt strategiat, ei keskiarvoja.
//
// =====================================================================
// YHTEENSOPIMATTOMIA MITTAREITA EI KESKIARVOISTETA
// =====================================================================
//
// "60 % tehtävistä tehty, 2/5 välitavoitetta saavutettu, paino 82/75" ei
// ole 47 %. Niiden keskiarvo on luku, jolla ei ole merkitystä — eikä
// merkityksetön luku muutu merkitykselliseksi siitä, että se näytetään
// prosenttina.
//
// Siksi strategia on VALINTA, joka näkyy vastauksessa. Käyttöliittymä
// kertoo, mistä luku on laskettu, ja käyttäjä voi olla eri mieltä
// strategiasta ilman että hänen tarvitsee epäillä laskutoimitusta.
//
// HYBRID on ainoa yhdistelmä, ja sekin PAINOTETTU JA NIMETTY: painot
// ovat näkyvissä, eivät piilotettuja oletuksia.
//
// =====================================================================
// TUNTEMATON EI OLE NOLLA
// =====================================================================
//
// Tavoite, jolla ei ole tehtäviä, välitavoitteita eikä mittaria, ei ole
// 0 % valmis. Sen edistymistä ei tiedetä. Nolla väittäisi, ettei mitään
// ole tapahtunut — ja se on eri asia kuin "ei tiedetä".
//
// `known: false` kulkee koko ketjun läpi käyttöliittymään asti.

import { GOAL_STATUS, PROGRESS_MODE, tasksForGoal, projectsForGoal, routinesForGoal }
  from './goal.js';
import { milestoneProgress, milestonesForGoal } from './milestone.js';
import { metricProgress, hasTarget, progressFromSavings } from './goalTarget.js';

/**
 * Edistymisen strategia.
 *
 * Nämä laajentavat `PROGRESS_MODE`-joukkoa, eivät korvaa sitä:
 * olemassa olevat neljä tilaa ovat kannassa (`goals_progress_mode_check`)
 * ja tuotannossa käytössä. Uudet strategiat elävät toistaiseksi vain
 * johdettuina — ks. docs/GOAL-TO-ACTION.md, migraatio 0010.
 */
export const PROGRESS_STRATEGY = Object.freeze({
  /** Käyttäjän oma prosentti. */
  MANUAL: 'manual',
  /** Valmiit tehtävät / kaikki tehtävät. */
  TASK_BASED: 'task_based',
  /** Liitettyjen projektien tehtävistä. */
  PROJECT_BASED: 'project_based',
  /** Liitettyjen rutiinien toteumasta. */
  ROUTINE_BASED: 'routine_based',
  /** Saavutetut välitavoitteet / lasketut välitavoitteet. */
  MILESTONE_BASED: 'milestone_based',
  /** Mitattu arvo suhteessa lähtö- ja tavoitearvoon. */
  METRIC_BASED: 'metric_based',
  /** Nimetty painotettu yhdistelmä. */
  HYBRID: 'hybrid'
});

export const PROGRESS_STRATEGIES = Object.freeze(Object.values(PROGRESS_STRATEGY));

const STRATEGY_LABELS = Object.freeze({
  [PROGRESS_STRATEGY.MANUAL]: 'Käsin merkitty',
  [PROGRESS_STRATEGY.TASK_BASED]: 'Tehtävistä',
  [PROGRESS_STRATEGY.PROJECT_BASED]: 'Projekteista',
  [PROGRESS_STRATEGY.ROUTINE_BASED]: 'Rutiineista',
  [PROGRESS_STRATEGY.MILESTONE_BASED]: 'Välitavoitteista',
  [PROGRESS_STRATEGY.METRIC_BASED]: 'Mittarista',
  [PROGRESS_STRATEGY.HYBRID]: 'Yhdistelmästä'
});

export function progressStrategyLabel(strategy) {
  return STRATEGY_LABELS[strategy] || 'Tuntematon';
}

/**
 * HYBRIDIN PAINOT.
 *
 * Nämä ovat NÄKYVISSÄ eivätkä piilotettuja. Painojen summa on 1, ja
 * puuttuvat osat normalisoidaan pois — jäljelle jäävien osuudet
 * skaalataan niin, että ne summautuvat yhteen.
 *
 * Välitavoite painaa eniten, koska se on lähimpänä sitä mitä
 * "edistyminen" tarkoittaa: ohitettu tarkistuspiste on todistettavasti
 * ohitettu. Tehtävä kertoo touhusta, mittari lopputuloksesta.
 */
export const HYBRID_WEIGHTS = Object.freeze({
  milestone: 0.5,
  metric: 0.3,
  task: 0.2
});

function unknown(strategy) {
  return Object.freeze({
    known: false,
    percent: null,
    strategy,
    derived: true,
    parts: Object.freeze([]),
    reason: 'Edistymistä ei voi laskea käytettävissä olevasta tiedosta.'
  });
}

function result({ percent, strategy, derived = true, parts = [], reason = null, extra = {} }) {
  return Object.freeze({
    known: true,
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    strategy,
    derived,
    parts: Object.freeze(parts),
    reason,
    ...extra
  });
}

/**
 * Mikä strategia tälle tavoitteelle sopii?
 *
 * VALITAAN VAIN JOS KÄYTTÄJÄ EI OLE VALINNUT. Käyttäjän oma valinta on
 * aina vahvempi kuin päättely — myös silloin kun päättely osaisi
 * paremmin.
 *
 * Järjestys on tarkoituksellinen: mittari ennen välitavoitteita ennen
 * tehtäviä. Mitattava tavoite on se, jossa lopputulos on suoraan
 * havaittavissa, eikä sitä pidä korvata välillisellä mittarilla.
 */
export function inferStrategy(goal, context = {}) {
  if (!goal) return PROGRESS_STRATEGY.TASK_BASED;

  if (goal.progressMode === PROGRESS_MODE.MANUAL) return PROGRESS_STRATEGY.MANUAL;

  if (hasTarget(context.target) || goal.savingsGoalId) {
    return PROGRESS_STRATEGY.METRIC_BASED;
  }

  const milestones = milestonesForGoal(context.milestones || [], goal.id);
  if (milestones.length > 0) return PROGRESS_STRATEGY.MILESTONE_BASED;

  if (goal.progressMode === PROGRESS_MODE.PROJECT_BASED) {
    return PROGRESS_STRATEGY.PROJECT_BASED;
  }
  if (goal.progressMode === PROGRESS_MODE.ROUTINE_BASED) {
    return PROGRESS_STRATEGY.ROUTINE_BASED;
  }

  return PROGRESS_STRATEGY.TASK_BASED;
}

/**
 * Laske edistyminen nimetyllä strategialla.
 *
 * @param {object} goal
 * @param {object} context
 * @param {Array}  [context.tasks]
 * @param {Array}  [context.projects]
 * @param {Array}  [context.routines]
 * @param {Array}  [context.milestones]
 * @param {object} [context.target]          goalTarget-olio
 * @param {object} [context.savingsSummary]  Talouden summarizeSavingsGoal
 * @param {string} [strategy]                pakota strategia
 */
export function computeProgress(goal, context = {}, strategy = null) {
  if (!goal) return unknown(PROGRESS_STRATEGY.TASK_BASED);

  const chosen = strategy || inferStrategy(goal, context);

  // SAAVUTETTU TAVOITE ON SATA PROSENTTIA riippumatta strategiasta.
  //
  // Käyttäjä on todennut sen saavutetuksi. Laskettu 80 % olisi
  // järjestelmän eri mieltä oleminen tosiasiasta, jonka vain käyttäjä
  // voi tietää.
  if (goal.status === GOAL_STATUS.COMPLETED) {
    return result({
      percent: 100,
      strategy: chosen,
      derived: false,
      reason: 'Tavoite on merkitty saavutetuksi.'
    });
  }

  switch (chosen) {
    case PROGRESS_STRATEGY.MANUAL:
      return manualProgress(goal);
    case PROGRESS_STRATEGY.METRIC_BASED:
      return metricStrategy(goal, context);
    case PROGRESS_STRATEGY.MILESTONE_BASED:
      return milestoneStrategy(goal, context);
    case PROGRESS_STRATEGY.PROJECT_BASED:
      return projectStrategy(goal, context);
    case PROGRESS_STRATEGY.ROUTINE_BASED:
      return routineStrategy(goal, context);
    case PROGRESS_STRATEGY.HYBRID:
      return hybridStrategy(goal, context);
    default:
      return taskStrategy(goal, context);
  }
}

// ------------------------------------------------------------ strategiat

function manualProgress(goal) {
  const value = Number(goal.manualProgress);
  if (!Number.isFinite(value)) return unknown(PROGRESS_STRATEGY.MANUAL);

  return result({
    percent: value,
    strategy: PROGRESS_STRATEGY.MANUAL,
    derived: false,
    reason: 'Käyttäjän itse merkitsemä. Ei laskettu.'
  });
}

function taskStrategy(goal, context) {
  const linked = tasksForGoal(context.tasks || [], goal.id);

  // TYHJÄ JOUKKO ON TUNTEMATON, EI NOLLA.
  //
  // Tämä eroaa `goal.js`:n `computeGoalProgress`-funktiosta, joka
  // palauttaa nollan. Ero on tarkoituksellinen: vanha funktio palvelee
  // listanäkymää, jossa palkki on aina piirrettävä, ja siellä nolla on
  // sovittu esitystapa. Tämä palvelee tavoitenäkymää, jossa
  // "tuntematon" voidaan sanoa ääneen.
  if (linked.length === 0) return unknown(PROGRESS_STRATEGY.TASK_BASED);

  const completed = linked.filter(task => task.completed).length;
  return result({
    percent: (completed / linked.length) * 100,
    strategy: PROGRESS_STRATEGY.TASK_BASED,
    reason: `${completed}/${linked.length} tehtävää valmiina.`,
    extra: { completed, total: linked.length }
  });
}

function milestoneStrategy(goal, context) {
  const progress = milestoneProgress(context.milestones || [], goal.id);
  if (!progress.known) return unknown(PROGRESS_STRATEGY.MILESTONE_BASED);

  return result({
    percent: progress.percent,
    strategy: PROGRESS_STRATEGY.MILESTONE_BASED,
    reason: `${progress.reached}/${progress.total} välitavoitetta saavutettu.`
      + (progress.skipped > 0 ? ` ${progress.skipped} ohitettu, ei laskettu mukaan.` : ''),
    extra: { reached: progress.reached, total: progress.total, skipped: progress.skipped }
  });
}

/**
 * Mittaristrategia.
 *
 * RAHATAVOITE LASKETAAN TALOUDESSA, EI TÄÄLLÄ. Jos tavoite on kytketty
 * säästötavoitteeseen, käytetään Talouden omaa yhteenvetoa —
 * `progressFromSavings` on pelkkä muunnos samaan muotoon.
 *
 * Kahta toteutusta samasta kaavasta ei ole: se on koko kytkennän
 * perustelu.
 */
function metricStrategy(goal, context) {
  if (goal.savingsGoalId && context.savingsSummary) {
    const fromSavings = progressFromSavings(context.savingsSummary);
    if (!fromSavings.known) return unknown(PROGRESS_STRATEGY.METRIC_BASED);

    return result({
      percent: fromSavings.percent,
      strategy: PROGRESS_STRATEGY.METRIC_BASED,
      reason: 'Laskettu säästötavoitteen kertymästä (Talous).',
      extra: { source: 'savings', reached: fromSavings.reached }
    });
  }

  const progress = metricProgress(context.target);
  if (!progress.known) return unknown(PROGRESS_STRATEGY.METRIC_BASED);

  const target = context.target;
  const unit = target.unit ? ` ${target.unit}` : '';

  return result({
    percent: progress.percent,
    strategy: PROGRESS_STRATEGY.METRIC_BASED,
    reason: progress.regressed
      ? `Mittari on liikkunut lähtöarvosta väärään suuntaan `
        + `(${target.baselineValue}${unit} → ${target.currentValue}${unit}).`
      : `${target.currentValue}${unit} / ${target.targetValue}${unit} `
        + `(lähtö ${target.baselineValue}${unit}).`,
    extra: {
      source: 'metric',
      direction: progress.direction,
      regressed: progress.regressed,
      remaining: progress.remaining
    }
  });
}

function projectStrategy(goal, context) {
  const projects = projectsForGoal(context.projects || [], goal.id);
  if (projects.length === 0) return unknown(PROGRESS_STRATEGY.PROJECT_BASED);

  const ids = new Set(projects.map(project => project.id));
  const linked = (context.tasks || []).filter(task => task && ids.has(task.projectId));

  // Lasketaan TEHTÄVISTÄ eikä projektien prosenttien keskiarvosta:
  // kymmenen tehtävän projekti ei ole yhtä painava kuin yhden.
  if (linked.length === 0) return unknown(PROGRESS_STRATEGY.PROJECT_BASED);

  const completed = linked.filter(task => task.completed).length;
  return result({
    percent: (completed / linked.length) * 100,
    strategy: PROGRESS_STRATEGY.PROJECT_BASED,
    reason: `${completed}/${linked.length} tehtävää ${projects.length} projektissa.`,
    extra: { completed, total: linked.length, projectCount: projects.length }
  });
}

function routineStrategy(goal, context) {
  const routines = routinesForGoal(context.routines || [], goal.id);
  if (routines.length === 0) return unknown(PROGRESS_STRATEGY.ROUTINE_BASED);

  const active = routines.filter(routine => routine.active !== false).length;
  return result({
    percent: (active / routines.length) * 100,
    strategy: PROGRESS_STRATEGY.ROUTINE_BASED,
    reason: `${active}/${routines.length} rutiinia käytössä.`,
    extra: { active, total: routines.length }
  });
}

/**
 * Painotettu yhdistelmä.
 *
 * PUUTTUVA OSA EI OLE NOLLA VAAN POISSA. Painot normalisoidaan
 * jäljelle jäävien kesken, jottei puuttuva mittari painaisi
 * edistymistä alas.
 *
 * Jos yhtään osaa ei ole, vastaus on tuntematon — ei nolla.
 */
function hybridStrategy(goal, context) {
  const candidates = [
    { key: 'milestone', weight: HYBRID_WEIGHTS.milestone,
      value: milestoneStrategy(goal, context) },
    { key: 'metric', weight: HYBRID_WEIGHTS.metric,
      value: metricStrategy(goal, context) },
    { key: 'task', weight: HYBRID_WEIGHTS.task,
      value: taskStrategy(goal, context) }
  ].filter(part => part.value.known);

  if (candidates.length === 0) return unknown(PROGRESS_STRATEGY.HYBRID);

  const totalWeight = candidates.reduce((sum, part) => sum + part.weight, 0);
  const percent = candidates
    .reduce((sum, part) => sum + part.value.percent * part.weight, 0) / totalWeight;

  const parts = candidates.map(part => ({
    key: part.key,
    percent: part.value.percent,
    // Normalisoitu paino, jotta käyttöliittymä voi näyttää sen
    // sellaisena kuin sitä oikeasti käytettiin.
    weight: Math.round((part.weight / totalWeight) * 100) / 100,
    reason: part.value.reason
  }));

  return result({
    percent,
    strategy: PROGRESS_STRATEGY.HYBRID,
    parts,
    reason: 'Painotettu yhdistelmä: '
      + parts.map(p => `${progressStrategyLabel(p.key + '_based')} ${p.percent} % `
        + `(paino ${p.weight})`).join(', ') + '.'
  });
}
