// Tavoitteiden domain.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa.
//
// MIKSI TAVOITTEET OVAT VÄLTTÄMÄTTÖMIÄ
// Ilman tavoitteita Manifestival on tehtävälista. Konseptidokumentin luku 19
// määrittelee tavoitteen ketjun keskikohdaksi:
//
//   tavoite → välitavoite → rutiini → tehtävä → päivä
//
// Tehtävä ilman tavoitetta on työtä. Tehtävä tavoitteeseen kytkettynä on
// edistymistä — ja edistyminen on se, mitä käyttäjä haluaa nähdä.
//
// EDISTYMINEN EI OLE KORISTE
// Manuaalinen prosenttiluku, jota käyttäjä säätää itse, on itsepetosta.
// Siksi oletustapa on TASK_BASED: edistyminen johdetaan liitettyjen
// tehtävien todellisesta tilasta. Manuaalinen on olemassa tavoitteille,
// joita ei voi pilkkoa tehtäviksi ("opi puhumaan espanjaa").

import { normalizeCategory } from './categories.js';
import { normalizePriority, priorityWeight } from './priority.js';
import { isIsoDate, MAX_TITLE_LENGTH, MAX_DESCRIPTION_LENGTH } from './task.js';

/** Tavoitteen elinkaari. */
export const GOAL_STATUS = Object.freeze({
  /** Työn alla. Näkyy oletusnäkymässä. */
  ACTIVE: 'active',
  /** Tauolla. Ei poistettu, mutta ei myöskään vaadi huomiota nyt. */
  PAUSED: 'paused',
  /**
   * Ylläpito.
   *
   * Tavoite on saavutettu tarpeeksi, ja huomio siirtyy tuloksen
   * SÄILYTTÄMISEEN. Eri asia kuin saavutettu: saavutettu on ohi,
   * ylläpito jatkuu.
   *
   * Käytännön ero: ylläpitotavoite ei kilpaile ajasta samalla painolla
   * kuin aktiivinen, mutta sen rutiinit pysyvät voimassa. "Pudotin 10
   * kg" on saavutettu; "pidän painon" on ylläpitoa.
   *
   * PRODUCTION GATE: tuotannon `goals_status_check` ei vielä salli
   * tätä arvoa. Ks. GOAL_MAINTENANCE_MODE src/data/schema.js ja
   * migraatio 0010.
   */
  MAINTENANCE: 'maintenance',
  /** Saavutettu. */
  COMPLETED: 'completed',
  /**
   * Luovutettu.
   *
   * Eri asia kuin arkistoitu: arkistointi on siivousta, luovuttaminen on
   * päätös. Ero on käyttäjälle merkityksellinen, koska luovutettu tavoite
   * kertoo jotain — arkistoitu ei kerro mitään.
   */
  ABANDONED: 'abandoned',
  /** Arkistoitu. Pois näkyvistä, historia säilyy. */
  ARCHIVED: 'archived'
});

export const GOAL_STATUSES = Object.freeze(Object.values(GOAL_STATUS));

/** Tilat, jotka vaativat käyttäjän huomiota. */
export const OPEN_STATUSES = Object.freeze([
  GOAL_STATUS.ACTIVE, GOAL_STATUS.PAUSED, GOAL_STATUS.MAINTENANCE
]);

/**
 * Tilat, joiden työ kilpailee kalenteriajasta.
 *
 * Ylläpito EI ole mukana: sen rutiinit pysyvät, mutta uutta työtä ei
 * suunnitella. Tauko ei myöskään — tauko on päätös olla tekemättä nyt,
 * ja jos aikatauluttaja sijoittaisi tauolla olevan tavoitteen työtä,
 * tauko ei tarkoittaisi mitään.
 */
export const SCHEDULING_STATUSES = Object.freeze([GOAL_STATUS.ACTIVE]);

/**
 * Miten edistyminen lasketaan.
 *
 * Kolme johdettua tapaa ja yksi manuaalinen. Johdettu on aina parempi, kun
 * se on mahdollinen: se pysyy totena ilman että käyttäjä muistaa päivittää.
 * Manuaalinen on olemassa tavoitteille, joita ei voi pilkkoa mielekkäästi
 * ("opi ruotsia") — ja käyttöliittymä merkitsee sen näkyvästi, jottei
 * lukua luulisi lasketuksi.
 */
export const PROGRESS_MODE = Object.freeze({
  /** Käyttäjä asettaa prosentin itse. */
  MANUAL: 'manual',
  /** Johdetaan liitettyjen tehtävien valmiustilasta. */
  TASK_BASED: 'task_based',
  /** Johdetaan liitettyjen projektien edistymisestä. */
  PROJECT_BASED: 'project_based',
  /** Johdetaan liitettyjen rutiinien toteumasta. */
  ROUTINE_BASED: 'routine_based'
});

export const PROGRESS_MODES = Object.freeze(Object.values(PROGRESS_MODE));

const STATUS_LABELS = Object.freeze({
  [GOAL_STATUS.ACTIVE]: 'Työn alla',
  [GOAL_STATUS.PAUSED]: 'Tauolla',
  [GOAL_STATUS.MAINTENANCE]: 'Ylläpidossa',
  [GOAL_STATUS.COMPLETED]: 'Saavutettu',
  [GOAL_STATUS.ABANDONED]: 'Luovutettu',
  [GOAL_STATUS.ARCHIVED]: 'Arkistoitu'
});

export function goalStatusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS[GOAL_STATUS.ACTIVE];
}

export function isOpenGoal(goal) {
  return OPEN_STATUSES.includes(goal.status);
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Normalisoi mielivaltainen olio tavoitteeksi.
 * Ei koskaan heitä poikkeusta.
 */
export function normalizeGoal(input = {}) {
  const status = GOAL_STATUSES.includes(input.status) ? input.status : GOAL_STATUS.ACTIVE;
  const progressMode = PROGRESS_MODES.includes(input.progressMode)
    ? input.progressMode
    : PROGRESS_MODE.TASK_BASED;

  return {
    id: input.id != null ? String(input.id) : null,
    title: String(input.title ?? '').trim().slice(0, MAX_TITLE_LENGTH),
    description: input.description
      ? String(input.description).trim().slice(0, MAX_DESCRIPTION_LENGTH)
      : null,
    category: normalizeCategory(input.category),
    priority: normalizePriority(input.priority),
    status,
    targetDate: isIsoDate(input.targetDate) ? input.targetDate : null,
    progressMode,
    /** Käytetään vain MANUAL-tilassa. */
    manualProgress: clampPercent(input.manualProgress),
    /** Ylätavoite. Yksi taso riittää tässä vaiheessa. */
    parentGoalId: input.parentGoalId != null ? String(input.parentGoalId) : null,
    projectId: input.projectId != null ? String(input.projectId) : null,

    // --------------------------------------------------------------
    // MITATTAVA KOHDE (migraatio 0010, EI AJETTU)
    //
    // Kolme lukua eikä yhtä: suunta johdetaan lähtö- ja tavoitearvosta,
    // eikä sitä kysytä erikseen. Ks. src/domain/goalTarget.js.
    //
    // Portin ollessa kiinni nämä elävät istunnon muistissa.
    // Ks. GOAL_PLANNING_FIELDS src/data/schema.js.
    // --------------------------------------------------------------
    metric: cleanGoalText(input.metric, 60),
    unit: cleanGoalText(input.unit, 20),
    baselineValue: goalNumber(input.baselineValue),
    currentValue: goalNumber(input.currentValue),
    targetValue: goalNumber(input.targetValue),
    measuredOn: isIsoDate(input.measuredOn) ? input.measuredOn : null,

    /**
     * Kytkentä säästötavoitteeseen.
     *
     * RAHATAVOITE LASKETAAN TALOUDESSA, EI TÄÄLLÄ. Kytketty tavoite ei
     * saa kantaa omaa mittariaan: kaksi lukua samasta asiasta erkanisi
     * heti kun toista päivitetään. Ks. src/domain/goalTarget.js.
     */
    savingsGoalId: input.savingsGoalId != null ? String(input.savingsGoalId) : null,

    /**
     * Elämänalue (migraatio 0012, EI AJETTU). Enintään yksi.
     *
     * null = "Ei elämänaluetta". Vanha tavoite on kelvollinen ilman
     * aluetta; mitään ei täytetä automaattisesti. Portin ollessa kiinni
     * arvo elää istunnon muistissa. Ks. GOAL_LIFE_AREA_FIELD
     * src/data/schema.js.
     */
    lifeAreaId: input.lifeAreaId != null && input.lifeAreaId !== '' ? String(input.lifeAreaId) : null,

    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

/** Trimmattu teksti tai null. Tyhjä merkkijono ei ole arvo. */
function cleanGoalText(value, maxLength) {
  if (value == null) return null;
  const trimmed = String(value).trim().slice(0, maxLength);
  return trimmed === '' ? null : trimmed;
}

/** Luku tai null. Mittari ei ole rahaa eikä sitä pidetä sentteinä. */
function goalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Validoi tavoite. */
export function validateGoal(goal) {
  const errors = {};

  const title = String(goal.title ?? '').trim();
  if (!title) errors.title = 'Anna tavoitteelle nimi.';
  else if (title.length > MAX_TITLE_LENGTH) errors.title = 'Nimi on liian pitkä.';

  if (!GOAL_STATUSES.includes(goal.status)) errors.status = 'Tuntematon tila.';
  if (!PROGRESS_MODES.includes(goal.progressMode)) errors.progressMode = 'Tuntematon edistymistapa.';

  if (goal.targetDate != null && !isIsoDate(goal.targetDate)) {
    errors.targetDate = 'Tavoitepäivä ei kelpaa.';
  }

  if (goal.parentGoalId && goal.parentGoalId === goal.id) {
    errors.parentGoalId = 'Tavoite ei voi olla oma ylätavoitteensa.';
  }

  if (goal.progressMode === PROGRESS_MODE.MANUAL) {
    const n = Number(goal.manualProgress);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      errors.manualProgress = 'Edistymisen pitää olla 0–100.';
    }
  }

  // KAKSI LUKUA SAMASTA ASIASTA ERKANEE.
  //
  // Säästötavoitteeseen kytketty tavoite saa lukunsa Taloudesta. Oma
  // mittari sen rinnalla tarkoittaisi kahta totuutta, joista toinen
  // vanhenee ensimmäisessä päivityksessä.
  if (goal.savingsGoalId && goal.targetValue !== null) {
    errors.targetValue = 'Säästötavoitteeseen kytketty tavoite saa lukunsa Taloudesta. '
      + 'Poista oma mittari tai kytkentä.';
  }

  // Mittari ilman nimeä on luku ilman merkitystä.
  if (goal.targetValue !== null && !goal.metric) {
    errors.metric = 'Kerro mitä mitataan.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/** Tavoitteeseen liitetyt tehtävät. */
export function tasksForGoal(tasks, goalId) {
  if (!goalId || !Array.isArray(tasks)) return [];
  return tasks.filter(task => task.goalId === goalId);
}

/**
 * Laske tavoitteen edistyminen.
 *
 * PUHDAS FUNKTIO. Sama syöte tuottaa aina saman tuloksen.
 *
 * TASK_BASED: valmiit / kaikki liitetyt tehtävät.
 * MANUAL: käyttäjän asettama luku.
 *
 * Saavutettu tavoite on aina 100 % riippumatta tehtävistä — käyttäjän
 * nimenomainen päätös voittaa lasketun arvon. Tämä on sama periaate kuin
 * aikataulutuksessa: ihmisen päätös on ylin.
 *
 * @returns {{percent:number, completed:number, total:number, mode:string, derived:boolean}}
 */
export function computeGoalProgress(goal, tasks = [], context = {}) {
  if (goal.status === GOAL_STATUS.COMPLETED) {
    const linked = tasksForGoal(tasks, goal.id);
    return {
      percent: 100,
      completed: linked.filter(t => t.completed).length,
      total: linked.length,
      mode: goal.progressMode,
      derived: false
    };
  }

  if (goal.progressMode === PROGRESS_MODE.MANUAL) {
    return {
      percent: clampPercent(goal.manualProgress),
      completed: 0,
      total: 0,
      mode: PROGRESS_MODE.MANUAL,
      derived: false
    };
  }

  if (goal.progressMode === PROGRESS_MODE.PROJECT_BASED) {
    return projectBasedProgress(goal, context.projects || [], tasks);
  }

  if (goal.progressMode === PROGRESS_MODE.ROUTINE_BASED) {
    return routineBasedProgress(goal, context.routines || []);
  }

  const linked = tasksForGoal(tasks, goal.id);
  const total = linked.length;
  const completed = linked.filter(task => task.completed).length;

  return {
    // Tavoite ilman tehtäviä on 0 %, ei 100 %. Tyhjä joukko ei ole
    // saavutus — tämä on se raja, jossa naiivi toteutus valehtelee.
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
    completed,
    total,
    mode: PROGRESS_MODE.TASK_BASED,
    derived: true
  };
}

/** Tavoitteeseen liitetyt projektit. */
export function projectsForGoal(projects, goalId) {
  if (!goalId || !Array.isArray(projects)) return [];
  return projects.filter(project => project && project.goalId === goalId);
}

/** Tavoitteeseen liitetyt rutiinit. */
export function routinesForGoal(routines, goalId) {
  if (!goalId || !Array.isArray(routines)) return [];
  return routines.filter(routine => routine && routine.goalId === goalId);
}

/**
 * Edistyminen liitettyjen projektien tehtävistä.
 *
 * Lasketaan TEHTÄVISTÄ eikä projektien prosenttien keskiarvosta: kymmenen
 * tehtävän projekti ei ole yhtä painava kuin yhden tehtävän projekti, ja
 * keskiarvo antaisi niille saman painon.
 */
function projectBasedProgress(goal, projects, tasks) {
  const linked = projectsForGoal(projects, goal.id);
  const ids = new Set(linked.map(project => project.id));

  const linkedTasks = (tasks || []).filter(task => task && ids.has(task.projectId));
  const total = linkedTasks.length;
  const completed = linkedTasks.filter(task => task.completed).length;

  return {
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
    completed,
    total,
    mode: PROGRESS_MODE.PROJECT_BASED,
    derived: true,
    projectCount: linked.length
  };
}

/**
 * Edistyminen liitetyistä rutiineista.
 *
 * Rutiinilla ei ole "valmis"-tilaa — se on sääntö, ei tehtävä. Siksi
 * edistyminen on osuus rutiineista, jotka ovat KÄYTÖSSÄ. Se vastaa
 * kysymykseen "pidänkö kiinni siitä mitä lupasin", joka on ainoa
 * mielekäs tulkinta rutiinipohjaiselle tavoitteelle.
 */
function routineBasedProgress(goal, routines) {
  const linked = routinesForGoal(routines, goal.id);
  const total = linked.length;
  const active = linked.filter(routine => routine.active).length;

  return {
    percent: total === 0 ? 0 : Math.round((active / total) * 100),
    completed: active,
    total,
    mode: PROGRESS_MODE.ROUTINE_BASED,
    derived: true
  };
}

/**
 * Onko tavoite myöhässä tavoitepäivästään?
 * Nykyhetki annetaan parametrina, jotta funktio pysyy puhtaana.
 */
export function isGoalOverdue(goal, todayIso) {
  if (!goal.targetDate || !isIsoDate(todayIso)) return false;
  if (goal.status === GOAL_STATUS.COMPLETED || goal.status === GOAL_STATUS.ARCHIVED) return false;
  return goal.targetDate < todayIso;
}

/** Päiviä tavoitepäivään. Negatiivinen = myöhässä. Null jos ei päivää. */
export function daysUntilTarget(goal, todayIso) {
  if (!goal.targetDate || !isIsoDate(todayIso)) return null;
  const target = Date.parse(goal.targetDate + 'T00:00:00Z');
  const today = Date.parse(todayIso + 'T00:00:00Z');
  return Math.round((target - today) / 86400000);
}

/**
 * Järjestys tavoitenäkymään.
 * 1. avoimet ennen suljettuja
 * 2. myöhässä olevat ensin
 * 3. prioriteetti
 * 4. lähin tavoitepäivä
 * 5. nimi — takaa determinismin
 */
export function compareGoals(a, b, todayIso) {
  const aOpen = isOpenGoal(a);
  const bOpen = isOpenGoal(b);
  if (aOpen !== bOpen) return aOpen ? -1 : 1;

  const aLate = isGoalOverdue(a, todayIso);
  const bLate = isGoalOverdue(b, todayIso);
  if (aLate !== bLate) return aLate ? -1 : 1;

  const byPriority = priorityWeight(a.priority) - priorityWeight(b.priority);
  if (byPriority !== 0) return byPriority;

  if (a.targetDate && b.targetDate && a.targetDate !== b.targetDate) {
    return a.targetDate < b.targetDate ? -1 : 1;
  }
  if (a.targetDate && !b.targetDate) return -1;
  if (!a.targetDate && b.targetDate) return 1;

  return String(a.title ?? '').localeCompare(String(b.title ?? ''), 'fi');
}

/**
 * Tavoitteiden yhteenveto näkymää varten.
 * Kokoaa kaiken kerralla, jottei näkymä laske samaa asiaa uudelleen.
 */
export function summarizeGoals(goals, tasks, todayIso) {
  const list = (goals || []).map(goal => {
    const progress = computeGoalProgress(goal, tasks);
    const linked = tasksForGoal(tasks, goal.id);
    return {
      goal,
      progress,
      overdue: isGoalOverdue(goal, todayIso),
      daysLeft: daysUntilTarget(goal, todayIso),
      openTasks: linked.filter(t => !t.completed),
      completedTasks: linked.filter(t => t.completed)
    };
  });

  list.sort((a, b) => compareGoals(a.goal, b.goal, todayIso));

  return {
    all: list,
    active: list.filter(entry => entry.goal.status === GOAL_STATUS.ACTIVE),
    paused: list.filter(entry => entry.goal.status === GOAL_STATUS.PAUSED),
    completed: list.filter(entry => entry.goal.status === GOAL_STATUS.COMPLETED),
    archived: list.filter(entry => entry.goal.status === GOAL_STATUS.ARCHIVED),
    overdueCount: list.filter(entry => entry.overdue).length
  };
}
