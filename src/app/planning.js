// Suunnittelun toiminnot: ehdotuksesta tallennukseen.
//
// =====================================================================
// TÄMÄ ON AINOA POLKU EHDOTUKSESTA TALLENNUKSEEN
// =====================================================================
//
// Kaikki kirjoitus kulkee `commitPlan`-funktion kautta, ja se kutsuu
// domainin `toCommittable`-porttia, joka palauttaa nullin kaikesta
// muusta kuin hyväksytystä ehdotuksesta.
//
// Jos joku joskus kirjoittaa toisen polun, `tests/goal-to-action-
// approval.test.mjs` huomaa sen: se tarkistaa, ettei tässä
// tiedostossa ole muuta repositoriokutsua ehdotuksen sisällöstä.
//
// =====================================================================
// OSITTAINEN TALLENNUS ON MAHDOLLINEN — JA SE KERROTAAN
// =====================================================================
//
// Suunnitelma luo useita rivejä useaan tauluun. Supabase ei anna
// selaimelle transaktiota, joten kirjoitukset tapahtuvat peräkkäin ja
// mikä tahansa niistä voi epäonnistua.
//
// Kaksi sääntöä:
//
//   1. PERUUTUS YRITETÄÄN. Jo luodut rivit poistetaan käänteisessä
//      järjestyksessä.
//
//   2. JOS PERUUTUSKIN EPÄONNISTUU, SE SANOTAAN. Käyttöliittymä saa
//      tietää täsmälleen mikä jäi kantaan. Hiljainen puolikas
//      suunnitelma on pahempi kuin näkyvä virhe, koska käyttäjä
//      löytäisi sen vasta viikkoja myöhemmin.
//
// Tila EI muutu COMMITTED-tilaan epäonnistuneessa tallennuksessa.
//
// =====================================================================
// IDEMPOTENSSI
// =====================================================================
//
// Sama avain kahdesti tarkoittaa samaa tallennusta, ei kahta.
// Kaksoisklikkaus ja uudelleenyritys eivät saa tuottaa kahta
// suunnitelmaa. Avain elää istunnon muistissa, koska ehdotuskaan ei
// elä pidempään.

import { newTaskId } from '../lib/rows.js';
import { fmtISO, todayMidnight } from '../lib/datetime.js';
import {
  PLAN_STATUS, normalizePlan, approvePlan, rejectPlan, applyEdit,
  markCommitted, toCommittable, validatePlan, summarizePlan
} from '../domain/plan.js';
import { validatePlanResponse, buildPlanningContext } from '../ai/planSchema.js';
import { normalizeGoal } from '../domain/goal.js';
import { normalizeProject } from '../domain/project.js';
import { normalizeTask } from '../domain/task.js';
import { normalizeRoutine } from '../domain/routine.js';
import { normalizeMilestone } from '../domain/milestone.js';
import { horizonCapacity, horizonEnd } from '../domain/capacity.js';
import {
  goalsRepo, projectsRepo, milestonesRepo, routinesRepo
} from '../data/collectionsRepo.js';
import * as tasksRepo from '../data/tasksRepo.js';
import { currentAccessToken } from './auth.js';
import { apiUrl } from '../platform/index.js';
import { API } from '../data/config.js';
import {
  getState, setPendingPlan, clearPendingPlan,
  addGoalToState, removeGoalFromState,
  addProjectToState, removeProjectFromState,
  addMilestoneToState, removeMilestoneFromState,
  addTaskToState, removeTaskFromState,
  addRoutineToState, removeRoutineFromState
} from './state.js';
import { logError } from '../lib/result.js';
import { currentPlanningFeedback, currentPlanningConstraints } from './alignment.js';

/**
 * Tallennetut avaimet.
 *
 * Istunnon muistissa. Ei localStoragessa: avain viittaa ehdotukseen,
 * joka ei sekään elä sivun latauksen yli, ja pysyvä avain estäisi
 * saman suunnitelman tekemisen uudelleen tarkoituksella.
 */
const committedKeys = new Set();

/** Tyhjennä avaimet. Kutsutaan uloskirjautumisessa. */
export function clearIdempotencyKeys() {
  committedKeys.clear();
}

/** Onko tämä avain jo tallennettu? */
export function isAlreadyCommitted(key) {
  return Boolean(key) && committedKeys.has(key);
}

// =====================================================================
// EHDOTUKSEN PYYTÄMINEN
// =====================================================================

/**
 * Pyydä suunnitelmaehdotus vapaasta tekstistä.
 *
 * TÄMÄ EI TALLENNA MITÄÄN. Palautettu ehdotus menee tilaan
 * tarkistettavaksi, ja vasta `commitPlan` kirjoittaa.
 *
 * SAMA POLKU TEKSTILLE JA PUHEELLE. Puhe muuttuu tekstiksi
 * `src/app/voice.js`:ssä ja tulee tänne samana merkkijonona — erillistä
 * puhesuunnittelijaa ei ole eikä tule, koska kaksi polkua erkanisi.
 *
 * @param {object} input
 * @param {string} input.goalText
 * @param {string} [input.goalId]  olemassa oleva tavoite (uudelleensuunnittelu)
 * @param {Function} [input.fetchImpl] testejä varten
 * @returns {Promise<{ok:boolean, plan?:object, error?:string}>}
 */
export async function requestPlan({ goalText, goalId = null, fetchImpl } = {}) {
  const text = String(goalText ?? '').trim();
  if (!text) return { ok: false, error: 'Kerro mitä haluat saavuttaa.' };

  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { ok: false, error: 'Verkkokutsu ei ole käytettävissä.' };

  const state = getState();
  const todayIso = fmtISO(todayMidnight());

  // KONTEKSTI ON LUKUJA, EI SISÄLTÖÄ.
  //
  // Käyttäjän tehtävälista, muistiinpanot ja hyvinvointimerkinnät eivät
  // lähde ulos. Ks. `buildPlanningContext`.
  const capacity = horizonCapacity({
    tasks: state.tasks,
    profile: state.profile,
    fromIso: todayIso,
    toIso: horizonEnd(todayIso, 28),
    routines: state.routines,
    exceptions: state.routineExceptions
  });

  // SUUNNAN PALAUTE. Jos käyttäjä on itse sanonut ehtivänsä viikossa
  // vähemmän kuin kalenteri näyttää (tai viikko ylittyi), suunnitelma ei
  // saa olettaa enempää. Raja vain laskee vapaata aikaa, ei nosta. Mallille
  // lähtee edelleen vain luku, ei alueiden nimiä eikä havaintoja.
  const feedback = currentPlanningFeedback();

  const context = buildPlanningContext({
    goals: state.goals,
    capacity,
    todayIso,
    existingGoal: goalId ? state.goals.find(goal => goal.id === goalId) : null,
    alignmentCapHours: feedback ? feedback.capHours : null,
    alignmentConstraints: currentPlanningConstraints()
  });

  try {
    const token = await currentAccessToken();
    if (!token) return { ok: false, error: 'Kirjaudu sisään ennen suunnittelua.' };

    const response = await doFetch(apiUrl(API.plan), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        goalText: text,
        today: todayIso,
        mode: goalId ? 'replan' : 'initial',
        context: {
          activeGoalCount: context.activeGoalCount,
          nearestDeadlineDays: context.nearestDeadlineDays,
          weeklyFreeHours: context.weeklyFreeHours
        }
      })
    });

    if (!response.ok) {
      const status = response.status;
      const message = status === 401 || status === 403
        ? 'Kirjaudu uudelleen ja yritä sitten uudestaan.'
        : status === 429
          ? 'Liian monta pyyntöä peräkkäin. Odota hetki.'
          : 'Suunnittelu ei onnistunut. Voit luoda tavoitteen käsin.';
      return { ok: false, error: message };
    }

    const data = await response.json();
    const responseText = textFrom(data);
    if (!responseText) return { ok: false, error: 'Suunnitelmaa ei saatu.' };

    // FAIL CLOSED. Kelvoton vastaus hylätään kokonaan eikä osittain.
    const parsed = validatePlanResponse(responseText, {
      goalId,
      idempotencyKey: newTaskId()
    });

    if (!parsed.ok) return { ok: false, error: parsed.reason || 'Suunnitelmaa ei saatu.' };

    setPendingPlan(parsed.plan);
    return { ok: true, plan: parsed.plan, rejectedFields: parsed.rejectedFields };
  } catch (cause) {
    logError(cause);
    return { ok: false, error: 'Suunnittelu ei onnistunut.' };
  }
}

function textFrom(data) {
  if (!data || !Array.isArray(data.content)) return '';
  return data.content
    .filter(part => part && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('')
    .trim();
}

// =====================================================================
// EHDOTUKSEN MUOKKAUS
// =====================================================================

/**
 * Muokkaa ehdotusta.
 *
 * MUOKKAUS PALAUTTAA TILAN KATSOTUKSI. Hyväksytyn ehdotuksen
 * muokkaaminen ei saa säilyttää hyväksyntää — muuten käyttäjä voisi
 * hyväksyä yhden suunnitelman ja tallentaa toisen.
 */
export function editPendingPlan(changes) {
  const plan = getState().pendingPlan;
  if (!plan) return { ok: false };

  const edited = applyEdit(plan, changes);
  if (!edited) return { ok: false };

  setPendingPlan(edited);
  return { ok: true, plan: edited };
}

/**
 * Ota kohta pois suunnitelmasta tai palauta se.
 *
 * POISSULJETTU EI OLE POISTETTU. Käyttäjä voi palauttaa sen, ja
 * yhteenveto kertoo montako kohtaa on jätetty pois.
 */
export function togglePlanItem(kind, ref) {
  const plan = getState().pendingPlan;
  if (!plan) return { ok: false };

  const key = { milestone: 'milestones', project: 'projects', task: 'tasks',
    routine: 'routines' }[kind];
  if (!key) return { ok: false };

  return editPendingPlan({
    [key]: plan[key].map(item =>
      item.ref === ref ? { ...item, excluded: item.excluded !== true } : item)
  });
}

/** Hylkää ehdotus. Mitään ei tallenneta. */
export function rejectPendingPlan() {
  const plan = getState().pendingPlan;
  if (plan) rejectPlan(plan);
  clearPendingPlan();
  return { ok: true };
}

// =====================================================================
// HYVÄKSYNTÄ JA TALLENNUS
// =====================================================================

/**
 * Hyväksy ja tallenna ehdotus.
 *
 * ===============================================================
 * TÄMÄ ON AINOA FUNKTIO, JOKA KIRJOITTAA EHDOTUKSEN SISÄLTÖÄ.
 * ===============================================================
 *
 * Järjestys on pakotettu riippuvuuksilla:
 *
 *   1. tavoite      — kaikki muu viittaa siihen
 *   2. välitavoitteet — projektit ja tehtävät viittaavat niihin
 *   3. projektit
 *   4. tehtävät
 *   5. rutiinit
 *
 * Käänteinen järjestys peruutuksessa, samasta syystä.
 */
export async function commitPlan() {
  const plan = getState().pendingPlan;
  if (!plan) return { ok: false, error: 'Ei hyväksyttävää suunnitelmaa.' };

  const check = validatePlan(plan);
  if (!check.valid) return { ok: false, errors: check.errors };

  // IDEMPOTENSSI ENNEN MITÄÄN MUUTA.
  //
  // Kaksoisklikkaus ei saa tuottaa kahta suunnitelmaa. Tarkistus on
  // tässä eikä käyttöliittymässä, koska käyttöliittymä on se kerros
  // joka voidaan ohittaa.
  if (isAlreadyCommitted(plan.idempotencyKey)) {
    return { ok: true, duplicate: true, goalId: plan.goalId };
  }

  const approved = plan.status === PLAN_STATUS.APPROVED
    ? plan
    : approvePlan(plan, new Date().toISOString());

  if (!approved) return { ok: false, error: 'Suunnitelmaa ei voitu hyväksyä.' };

  // HYVÄKSYNTÄPORTTI. Palauttaa nullin muusta kuin hyväksytystä.
  const committable = toCommittable(approved, {
    makeId: newTaskId,
    goalId: approved.goalId
  });

  if (!committable) return { ok: false, error: 'Suunnitelmaa ei voitu valmistella.' };

  /** Peruutusaskeleet käänteisessä järjestyksessä. */
  const undo = [];
  const failures = [];

  const step = async (label, write, rollback) => {
    const result = await write();
    if (!result || result.ok === false) {
      failures.push({ label, error: result?.error ?? null });
      return false;
    }
    undo.unshift({ label, rollback });
    return true;
  };

  try {
    // 1. TAVOITE
    if (committable.goal) {
      const goal = normalizeGoal({
        ...committable.goal,
        ...(committable.target ? {
          metric: committable.target.metric,
          unit: committable.target.unit,
          baselineValue: committable.target.baselineValue,
          currentValue: committable.target.currentValue,
          targetValue: committable.target.targetValue
        } : {})
      });

      addGoalToState(goal);
      const ok = await step('tavoite',
        () => goalsRepo.insert(goal),
        async () => {
          removeGoalFromState(goal.id);
          await goalsRepo.remove(goal.id);
        });

      if (!ok) {
        removeGoalFromState(goal.id);
        return failure(failures, undo, 'Tavoitteen tallennus epäonnistui.');
      }
    }

    // 2. VÄLITAVOITTEET
    for (const raw of committable.milestones) {
      const milestone = normalizeMilestone(raw);
      addMilestoneToState(milestone);

      const ok = await step(`välitavoite: ${milestone.title}`,
        () => milestonesRepo.insert(milestone),
        async () => {
          removeMilestoneFromState(milestone.id);
          await milestonesRepo.remove(milestone.id);
        });

      if (!ok) {
        removeMilestoneFromState(milestone.id);
        return failure(failures, undo, 'Välitavoitteen tallennus epäonnistui.');
      }
    }

    // 3. PROJEKTIT
    for (const raw of committable.projects) {
      const project = normalizeProject(raw);
      addProjectToState(project);

      const ok = await step(`projekti: ${project.name}`,
        () => projectsRepo.insert(project),
        async () => {
          removeProjectFromState(project.id);
          await projectsRepo.remove(project.id);
        });

      if (!ok) {
        removeProjectFromState(project.id);
        return failure(failures, undo, 'Projektin tallennus epäonnistui.');
      }
    }

    // 4. TEHTÄVÄT
    for (const raw of committable.tasks) {
      const task = normalizeTask(raw);
      addTaskToState(task);

      const ok = await step(`tehtävä: ${task.title}`,
        () => tasksRepo.insertTask(task),
        async () => {
          removeTaskFromState(task.id);
          await tasksRepo.deleteTask(task.id);
        });

      if (!ok) {
        removeTaskFromState(task.id);
        return failure(failures, undo, 'Tehtävän tallennus epäonnistui.');
      }
    }

    // 5. RUTIINIT
    for (const raw of committable.routines) {
      const routine = normalizeRoutine(raw);
      addRoutineToState(routine);

      const ok = await step(`rutiini: ${routine.title}`,
        () => routinesRepo.insert(routine),
        async () => {
          removeRoutineFromState(routine.id);
          await routinesRepo.remove(routine.id);
        });

      if (!ok) {
        removeRoutineFromState(routine.id);
        return failure(failures, undo, 'Rutiinin tallennus epäonnistui.');
      }
    }
  } catch (cause) {
    logError(cause);
    return failure(failures, undo, 'Suunnitelman tallennus keskeytyi.');
  }

  // TILA MUUTTUU COMMITTED-TILAAN VASTA TÄSSÄ.
  //
  // Sekunttiakaan aiemmin ja käyttöliittymä väittäisi tallentaneensa
  // jotain, mitä ei tallennettu.
  if (plan.idempotencyKey) committedKeys.add(plan.idempotencyKey);
  markCommitted(approved, new Date().toISOString(), committable.goalId);
  clearPendingPlan();

  return {
    ok: true,
    goalId: committable.goalId,
    created: {
      goal: committable.goal ? 1 : 0,
      milestones: committable.milestones.length,
      projects: committable.projects.length,
      tasks: committable.tasks.length,
      routines: committable.routines.length
    }
  };
}

/**
 * Peruuta jo tehdyt kirjoitukset.
 *
 * JOS PERUUTUS EPÄONNISTUU, SE KERROTAAN. Käyttöliittymä saa listan
 * siitä mikä jäi kantaan. Hiljainen puolikas suunnitelma on pahempi
 * kuin näkyvä virhe.
 */
async function failure(failures, undo, message) {
  const orphans = [];

  for (const entry of undo) {
    try {
      await entry.rollback();
    } catch {
      orphans.push(entry.label);
    }
  }

  return {
    ok: false,
    error: message,
    failures,
    /** Rivit, joita ei saatu poistettua. Tyhjä = peruutus onnistui. */
    orphans,
    partial: orphans.length > 0
  };
}

/** Yhteenveto kesken olevasta ehdotuksesta. */
export function pendingPlanSummary() {
  return summarizePlan(getState().pendingPlan);
}

/** Ehdotus tyhjästä. Käytetään kun käyttäjä haluaa suunnitella käsin. */
export function blankPlan(goalTitle) {
  return normalizePlan({
    status: PLAN_STATUS.DRAFT,
    goal: { title: goalTitle || '', confidence: 'high' },
    idempotencyKey: newTaskId()
  });
}
