// Suunnitelmaehdotus: tavoitteesta tekemiseksi.
//
// =====================================================================
// HYVÄKSYNTÄ ON DOMAIN-SÄÄNTÖ, EI KÄYTTÖLIITTYMÄN TAPA
// =====================================================================
//
// Tämä on koko moduulin tärkein rivi. Jos hyväksyntä olisi vain
// käyttöliittymän vaihe, se katoaisi ensimmäisessä oikopolussa: uusi
// näkymä, testiskripti tai automaatio kutsuisi tallennusta suoraan, ja
// tekoälyn ehdotus päätyisi käyttäjän kalenteriin ilman että kukaan
// päätti niin.
//
// Siksi `toCommittable()` PALAUTTAA NULLIN kaikesta muusta kuin
// hyväksytystä ehdotuksesta. Se on ainoa portti, jonka läpi ehdotettu
// työ pääsee tallennettavaksi — eikä toista tietä ole.
//
// Sama kuvio kuin kuittiluennassa (src/domain/receipts.js). Se todettiin
// toimivaksi, ja sitä ei keksitä tähän uudelleen toisin.
//
// =====================================================================
// KOLME ERI ASIAA, JOITA EI SAA SEKOITTAA
// =====================================================================
//
//   GENERATED   tekoäly on tuottanut ehdotuksen
//   APPROVED    käyttäjä on hyväksynyt sen
//   COMMITTED   tallennus on ONNISTUNUT
//
// Hyväksytty ei ole tallennettu. Jos tallennus epäonnistuu, tila ei saa
// muuttua COMMITTED-tilaan — muuten käyttöliittymä väittäisi
// tallentaneensa jotain, mitä ei tallennettu.
//
// =====================================================================
// TUNNISTEET SYNTYVÄT SOVELLUKSESSA, EI MALLISSA
// =====================================================================
//
// Tekoälyn palauttamaa tunnistetta ei käytetä koskaan. Malli voi keksiä
// olemassa olevan rivin tunnisteen, ja silloin "luonti" ylikirjoittaisi
// käyttäjän oman datan. Ehdotuksen sisäiset viittaukset käyttävät
// PAIKALLISIA avaimia (`ref`), jotka `toCommittable` kääntää oikeiksi
// tunnisteiksi vasta hyväksynnän jälkeen.

import { isIsoDate, MAX_TITLE_LENGTH, MAX_DESCRIPTION_LENGTH } from './task.js';
import { normalizePriority } from './priority.js';
import { normalizeCategory } from './categories.js';
import { MILESTONE_STATUS } from './milestone.js';

/**
 * Ehdotuksen tila.
 *
 * Yksisuuntainen jono kahdella haaralla: hylkäys ja korvaus.
 */
export const PLAN_STATUS = Object.freeze({
  /** Käyttäjä on kirjoittanut tavoitteen, ehdotusta ei vielä ole. */
  DRAFT: 'draft',
  /** Tekoäly on tuottanut ehdotuksen. EI HYVÄKSYTTY. */
  GENERATED: 'generated',
  /** Käyttäjä on katsonut ja muokannut. EI VIELÄ HYVÄKSYTTY. */
  REVIEWED: 'reviewed',
  /** Käyttäjä on hyväksynyt. EI VIELÄ TALLENNETTU. */
  APPROVED: 'approved',
  /** Hylätty. Mitään ei tallenneta. */
  REJECTED: 'rejected',
  /** Tallennettu onnistuneesti. */
  COMMITTED: 'committed',
  /** Korvattu uudemmalla ehdotuksella. */
  SUPERSEDED: 'superseded'
});

export const PLAN_STATUSES = Object.freeze(Object.values(PLAN_STATUS));

/** Ehdotuksen laji. */
export const PLAN_KIND = Object.freeze({
  /** Uusi suunnitelma tavoitteelle. */
  INITIAL: 'initial',
  /** Muutosehdotus olemassa olevaan suunnitelmaan. */
  REPLAN: 'replan'
});

export const PLAN_KINDS = Object.freeze(Object.values(PLAN_KIND));

/** Yhden ehdotuksen ylärajat. Suunnitelma ei saa räjähtää käsiin. */
export const LIMITS = Object.freeze({
  milestones: 20,
  projects: 10,
  tasks: 100,
  routines: 10,
  assumptions: 10,
  questions: 5
});

function cleanText(value, maxLength) {
  if (value == null) return null;
  const trimmed = String(value).trim().slice(0, maxLength);
  return trimmed === '' ? null : trimmed;
}

function positiveInt(value, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return null;
  return max ? Math.min(n, max) : n;
}

/**
 * Paikallinen viittausavain.
 *
 * EI TUNNISTE. `ref` elää vain ehdotuksen sisällä ja kertoo, mikä
 * tehtävä kuuluu mihin projektiin ennen kuin kummallakaan on
 * tunnistetta. `toCommittable` kääntää nämä oikeiksi tunnisteiksi.
 *
 * Malli saa ehdottaa ref-arvoja, koska ne eivät osoita mihinkään
 * olemassa olevaan — ne ovat merkityksettömiä ehdotuksen ulkopuolella.
 */
function cleanRef(value) {
  if (value == null) return null;
  const text = String(value).trim().slice(0, 40);
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : null;
}

// =====================================================================
// EHDOTUKSEN OSAT
// =====================================================================

export function normalizePlannedMilestone(input = {}) {
  const title = String(input.title ?? '').trim().slice(0, MAX_TITLE_LENGTH);
  if (!title) return null;

  return {
    ref: cleanRef(input.ref),
    title,
    description: cleanText(input.description, MAX_DESCRIPTION_LENGTH),
    targetDate: isIsoDate(input.targetDate) ? input.targetDate : null,
    /** Ehdotettu välitavoite on aina avoin. Ehdotus ei saavuta mitään. */
    status: MILESTONE_STATUS.OPEN,
    /** Käyttäjä on poistanut tämän ehdotuksesta. */
    excluded: input.excluded === true
  };
}

export function normalizePlannedProject(input = {}) {
  const name = String(input.name ?? input.title ?? '').trim().slice(0, MAX_TITLE_LENGTH);
  if (!name) return null;

  return {
    ref: cleanRef(input.ref),
    name,
    description: cleanText(input.description, MAX_DESCRIPTION_LENGTH),
    milestoneRef: cleanRef(input.milestoneRef),
    deadline: isIsoDate(input.deadline) ? input.deadline : null,
    priority: normalizePriority(input.priority),
    category: normalizeCategory(input.category),
    excluded: input.excluded === true
  };
}

/**
 * Ehdotettu tehtävä.
 *
 * KESTON SEMANTIIKKA ON SAMA KUIN TEHTÄVÄDOMAINISSA: jos alku- ja
 * loppuaika ovat molemmat, kesto tulee välistä. Muuten arvio kelpaa.
 * Tässä ehdotuksessa aikoja ei anneta lainkaan — aikatauluttaja
 * sijoittaa ne myöhemmin — joten vain arvio on käytössä.
 *
 * Se on tietoinen rajaus: suunnittelija ei saa kiinnittää kellonaikoja,
 * koska se on aikatauluttajan työ ja koska kiinnitetty aika ohittaisi
 * käyttäjän kalenterin.
 */
export function normalizePlannedTask(input = {}) {
  const title = String(input.title ?? '').trim().slice(0, MAX_TITLE_LENGTH);
  if (!title) return null;

  return {
    ref: cleanRef(input.ref),
    title,
    description: cleanText(input.description, MAX_DESCRIPTION_LENGTH),
    projectRef: cleanRef(input.projectRef),
    milestoneRef: cleanRef(input.milestoneRef),

    /** Määräpäivä, ei kellonaika. */
    date: isIsoDate(input.date) ? input.date : null,

    /** Kestoarvio minuutteina. Yläraja on vuorokausi. */
    durationMinutes: positiveInt(input.durationMinutes, 1440),

    priority: normalizePriority(input.priority),
    category: normalizeCategory(input.category),

    /** Paikalliset viittaukset edeltäviin tehtäviin. */
    dependsOnRefs: Array.isArray(input.dependsOnRefs)
      ? input.dependsOnRefs.map(cleanRef).filter(Boolean).slice(0, 10)
      : [],

    excluded: input.excluded === true
  };
}

export function normalizePlannedRoutine(input = {}) {
  const title = String(input.title ?? '').trim().slice(0, MAX_TITLE_LENGTH);
  if (!title) return null;

  const weekdays = Array.isArray(input.weekdays)
    ? [...new Set(input.weekdays.map(d => Math.trunc(Number(d)))
      .filter(d => Number.isInteger(d) && d >= 1 && d <= 7))].sort()
    : [];

  const type = ['daily', 'weekly'].includes(input.recurrenceType)
    ? input.recurrenceType : 'weekly';

  return {
    ref: cleanRef(input.ref),
    title,
    description: cleanText(input.description, MAX_DESCRIPTION_LENGTH),
    recurrenceType: type,
    /** Viikkorutiini ilman päiviä ei toistu koskaan. Oletus: maanantai. */
    weekdays: type === 'weekly' && weekdays.length === 0 ? [1] : weekdays,
    durationMinutes: positiveInt(input.durationMinutes, 1440) ?? 30,
    priority: normalizePriority(input.priority),
    category: normalizeCategory(input.category),
    excluded: input.excluded === true
  };
}

// =====================================================================
// EHDOTUS
// =====================================================================

/**
 * Normalisoi suunnitelmaehdotus.
 *
 * TÄMÄ ON TEKOÄLYN TUOTTAMAA TIETOA, ja se normalisoidaan yhtä tiukasti
 * kuin mikä tahansa ulkoinen syöte. Kelvoton osa pudotetaan; se ei
 * muutu arvaukseksi.
 */
export function normalizePlan(input = {}) {
  const status = PLAN_STATUSES.includes(input.status) ? input.status : PLAN_STATUS.DRAFT;
  const kind = PLAN_KINDS.includes(input.kind) ? input.kind : PLAN_KIND.INITIAL;

  const list = (values, normalize, limit) => (Array.isArray(values) ? values : [])
    .slice(0, limit)
    .map(normalize)
    .filter(Boolean);

  return {
    id: input.id != null ? String(input.id) : null,
    status,
    kind,

    /** Tavoite, jolle suunnitelma kuuluu. Null ennen kuin tavoite luodaan. */
    goalId: input.goalId != null ? String(input.goalId) : null,

    /**
     * TULKITTU tavoite.
     *
     * Vapaan tekstin tulkinta on ehdotus siinä missä muukin: käyttäjä
     * näkee mitä järjestelmä ymmärsi ja voi korjata sen.
     */
    goal: normalizeInterpretedGoal(input.goal),

    milestones: list(input.milestones, normalizePlannedMilestone, LIMITS.milestones),
    projects: list(input.projects, normalizePlannedProject, LIMITS.projects),
    tasks: list(input.tasks, normalizePlannedTask, LIMITS.tasks),
    routines: list(input.routines, normalizePlannedRoutine, LIMITS.routines),

    /**
     * OLETUKSET, JOTKA JÄRJESTELMÄ TEKI.
     *
     * Nämä ovat se, mitä malli päätteli ilman että käyttäjä sanoi sitä.
     * Ne on näytettävä: oletus jota ei näytetä on oletus jota ei voi
     * korjata.
     */
    assumptions: (Array.isArray(input.assumptions) ? input.assumptions : [])
      .slice(0, LIMITS.assumptions)
      .map(text => cleanText(text, 300))
      .filter(Boolean),

    /** Kysymykset, joihin järjestelmä ei osannut vastata. */
    questions: (Array.isArray(input.questions) ? input.questions : [])
      .slice(0, LIMITS.questions)
      .map(text => cleanText(text, 300))
      .filter(Boolean),

    /**
     * Idempotenssiavain.
     *
     * Sama avain kahdesti tarkoittaa samaa tallennusta, ei kahta. Estää
     * kaksoisklikkauksen ja uudelleenyrityksen tuottaman kaksoiskappaleen.
     */
    idempotencyKey: input.idempotencyKey != null ? String(input.idempotencyKey) : null,

    /** Mihin ehdotukseen tämä perustuu, jos on kyse korvaajasta. */
    supersedesId: input.supersedesId != null ? String(input.supersedesId) : null,

    createdAt: input.createdAt ?? null,
    approvedAt: input.approvedAt ?? null,
    committedAt: input.committedAt ?? null
  };
}

/**
 * Tulkittu tavoite.
 *
 * `confidence` on mallin oma arvio siitä, kuinka varma tulkinta on.
 * Se EI ole tarkkuus vaan varmuus — ja se näytetään käyttäjälle
 * sellaisena.
 */
export function normalizeInterpretedGoal(input = {}) {
  const source = input || {};
  const confidence = ['high', 'medium', 'low'].includes(source.confidence)
    ? source.confidence : 'low';

  return {
    title: String(source.title ?? '').trim().slice(0, MAX_TITLE_LENGTH),
    description: cleanText(source.description, MAX_DESCRIPTION_LENGTH),
    targetDate: isIsoDate(source.targetDate) ? source.targetDate : null,
    category: normalizeCategory(source.category),
    priority: normalizePriority(source.priority),

    /** Mitattava kohde, jos tavoite on mitattava. */
    metric: cleanText(source.metric, 60),
    unit: cleanText(source.unit, 20),
    baselineValue: numberOrNull(source.baselineValue),
    targetValue: numberOrNull(source.targetValue),

    confidence
  };
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Onko ehdotuksessa tarpeeksi, jotta se voidaan hyväksyä?
 *
 * TYHJÄÄ SUUNNITELMAA EI VOI HYVÄKSYÄ. Hyväksyntä, joka ei luo mitään,
 * on ele ilman sisältöä — ja se antaisi käyttäjälle vaikutelman, että
 * jotain tapahtui.
 */
export function validatePlan(plan) {
  const errors = {};

  if (!plan) return { valid: false, errors: { plan: 'Suunnitelmaa ei ole.' } };

  if (!plan.goal || !plan.goal.title) {
    errors.goal = 'Tavoitteella pitää olla nimi.';
  }

  if (countIncluded(plan) === 0) {
    errors.content = 'Suunnitelmassa ei ole yhtään sisällytettyä kohtaa.';
  }

  // Viittaus, joka ei osoita mihinkään, olisi rikkinäinen rakenne
  // hyväksynnän jälkeen. Se on helpompi hylätä nyt kuin korjata sitten.
  for (const broken of danglingRefs(plan)) {
    errors.refs = `Viittaus "${broken}" ei osoita mihinkään ehdotuksessa.`;
    break;
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/** Montako kohtaa käyttäjä on jättänyt sisään? */
export function countIncluded(plan) {
  if (!plan) return 0;
  return included(plan.milestones).length
    + included(plan.projects).length
    + included(plan.tasks).length
    + included(plan.routines).length;
}

/** Sisällytetyt kohdat. Poissuljettu ei ole poistettu — se on jätetty pois. */
export function included(items = []) {
  return items.filter(item => item && item.excluded !== true);
}

/** Viittaukset, jotka eivät osoita mihinkään sisällytettyyn kohtaan. */
export function danglingRefs(plan) {
  if (!plan) return [];

  const milestoneRefs = new Set(included(plan.milestones).map(m => m.ref).filter(Boolean));
  const projectRefs = new Set(included(plan.projects).map(p => p.ref).filter(Boolean));
  const taskRefs = new Set(included(plan.tasks).map(t => t.ref).filter(Boolean));

  const broken = [];

  for (const project of included(plan.projects)) {
    if (project.milestoneRef && !milestoneRefs.has(project.milestoneRef)) {
      broken.push(project.milestoneRef);
    }
  }

  for (const task of included(plan.tasks)) {
    if (task.projectRef && !projectRefs.has(task.projectRef)) broken.push(task.projectRef);
    if (task.milestoneRef && !milestoneRefs.has(task.milestoneRef)) {
      broken.push(task.milestoneRef);
    }
    for (const dependency of task.dependsOnRefs || []) {
      if (!taskRefs.has(dependency)) broken.push(dependency);
    }
  }

  return [...new Set(broken)];
}

// =====================================================================
// TILASIIRTYMÄT
// =====================================================================

/**
 * Sallitut siirtymät.
 *
 * Kartta on nimenomainen eikä johdettu. Jokainen nuoli on päätös, ja
 * päätös näkyy tässä yhtenä rivinä — ei ehtolauseiden verkostona,
 * jonka läpi voi vahingossa kulkea väärään suuntaan.
 */
const TRANSITIONS = Object.freeze({
  [PLAN_STATUS.DRAFT]: [PLAN_STATUS.GENERATED, PLAN_STATUS.REJECTED],
  [PLAN_STATUS.GENERATED]: [PLAN_STATUS.REVIEWED, PLAN_STATUS.APPROVED,
    PLAN_STATUS.REJECTED, PLAN_STATUS.SUPERSEDED],
  [PLAN_STATUS.REVIEWED]: [PLAN_STATUS.APPROVED, PLAN_STATUS.REJECTED,
    PLAN_STATUS.SUPERSEDED],
  [PLAN_STATUS.APPROVED]: [PLAN_STATUS.COMMITTED, PLAN_STATUS.REJECTED],
  // Päätetilat. Hylätystä ei palata, tallennettua ei tallenneta uudelleen.
  [PLAN_STATUS.REJECTED]: [],
  [PLAN_STATUS.COMMITTED]: [],
  [PLAN_STATUS.SUPERSEDED]: []
});

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

/**
 * Vaihda tila.
 *
 * Palauttaa `null` kiellettyyn siirtymään. Ei heitä: kutsupaikka
 * päättää, onko kielto virhe vai odotettu.
 */
export function transition(plan, to, extra = {}) {
  if (!plan || !canTransition(plan.status, to)) return null;
  return normalizePlan({ ...plan, ...extra, status: to });
}

/**
 * Merkitse katsotuksi.
 *
 * KÄYTTÄJÄN MUOKKAUS PALAUTTAA TILAN KATSOTUKSI. Hyväksytyn ehdotuksen
 * muokkaaminen ei saa säilyttää hyväksyntää — muuten käyttäjä voisi
 * hyväksyä yhden suunnitelman ja tallentaa toisen.
 *
 * Sama sääntö kuin kuittiluennan `applyCorrection`-funktiossa.
 */
export function applyEdit(plan, changes = {}) {
  if (!plan) return null;
  if (plan.status === PLAN_STATUS.COMMITTED
    || plan.status === PLAN_STATUS.REJECTED
    || plan.status === PLAN_STATUS.SUPERSEDED) {
    return null;
  }
  return normalizePlan({ ...plan, ...changes, status: PLAN_STATUS.REVIEWED });
}

/**
 * Hyväksy.
 *
 * Hyväksyntä EDELLYTTÄÄ kelvollista sisältöä. Puutteellista ehdotusta ei
 * voi hyväksyä — muuten hyväksyntä ei tarkoittaisi mitään.
 */
export function approvePlan(plan, approvedAt = null) {
  if (!plan) return null;
  if (!canTransition(plan.status, PLAN_STATUS.APPROVED)) return null;
  if (!validatePlan(plan).valid) return null;
  return normalizePlan({ ...plan, status: PLAN_STATUS.APPROVED, approvedAt });
}

/** Hylkää. Mitään ei tallenneta. */
export function rejectPlan(plan) {
  return transition(plan, PLAN_STATUS.REJECTED);
}

/**
 * Merkitse tallennetuksi.
 *
 * KUTSUTAAN VASTA KUN TALLENNUS ON ONNISTUNUT. Tämä on se raja, jossa
 * "hyväksytty" muuttuu "tallennetuksi" — eikä se saa liikkua sekuntiakaan
 * ennen kuin kanta on vahvistanut kirjoituksen.
 */
export function markCommitted(plan, committedAt = null, goalId = null) {
  if (!plan || !canTransition(plan.status, PLAN_STATUS.COMMITTED)) return null;
  return normalizePlan({
    ...plan,
    status: PLAN_STATUS.COMMITTED,
    committedAt,
    goalId: goalId ?? plan.goalId
  });
}

/** Korvaa uudemmalla ehdotuksella. */
export function supersedePlan(plan) {
  return transition(plan, PLAN_STATUS.SUPERSEDED);
}

// =====================================================================
// TALLENNETTAVAKSI
// =====================================================================

/**
 * Muunna hyväksytty ehdotus tallennettaviksi riveiksi.
 *
 * ==============================================================
 * TÄMÄ ON HYVÄKSYNTÄPORTTI. PALAUTTAA NULLIN MUUSTA KUIN
 * HYVÄKSYTYSTÄ EHDOTUKSESTA.
 * ==============================================================
 *
 * Ei ole toista tietä ehdotuksesta tallennukseen. Jos joku joskus
 * kirjoittaa sellaisen, tämän tiedoston testit eivät huomaa sitä —
 * mutta `tests/goal-to-action-approval.test.mjs` huomaa, koska se
 * tarkistaa ettei toimintokerroksessa ole muuta polkua.
 *
 * TUNNISTEET TULEVAT KUTSUJALTA. `makeId` on funktio, jonka
 * sovelluskerros antaa — domain ei tuota tunnisteita eikä lue kelloa
 * (`tests/architecture.test.mjs` valvoo sitä).
 *
 * @param {object} plan
 * @param {object} options
 * @param {Function} options.makeId  () => string
 * @param {string}  [options.goalId] olemassa oleva tavoite (replan)
 * @returns {object|null}
 */
export function toCommittable(plan, { makeId, goalId = null } = {}) {
  if (!plan) return null;
  if (plan.status !== PLAN_STATUS.APPROVED) return null;
  if (typeof makeId !== 'function') return null;
  if (!validatePlan(plan).valid) return null;

  const resolvedGoalId = goalId || plan.goalId || makeId();

  // Paikallinen viittaus -> oikea tunniste. Malli ei koskaan näe
  // näitä, eikä sen ehdottamaa tunnistetta käytetä missään.
  const milestoneIds = new Map();
  const projectIds = new Map();
  const taskIds = new Map();

  const milestones = included(plan.milestones).map((milestone, index) => {
    const id = makeId();
    if (milestone.ref) milestoneIds.set(milestone.ref, id);
    return {
      id,
      goalId: resolvedGoalId,
      title: milestone.title,
      description: milestone.description,
      targetDate: milestone.targetDate,
      status: MILESTONE_STATUS.OPEN,
      orderIndex: index,
      rule: 'manual'
    };
  });

  const projects = included(plan.projects).map(project => {
    const id = makeId();
    if (project.ref) projectIds.set(project.ref, id);
    return {
      id,
      name: project.name,
      description: project.description,
      goalId: resolvedGoalId,
      milestoneId: project.milestoneRef
        ? milestoneIds.get(project.milestoneRef) ?? null : null,
      deadline: project.deadline,
      priority: project.priority,
      category: project.category,
      status: 'active'
    };
  });

  // Tehtävät kahdessa vaiheessa: ensin tunnisteet, sitten riippuvuudet.
  // Riippuvuus voi osoittaa myöhempään tehtävään, eikä sitä voi ratkaista
  // ennen kuin kaikilla on tunniste.
  const includedTasks = included(plan.tasks);
  for (const task of includedTasks) {
    const id = makeId();
    if (task.ref) taskIds.set(task.ref, id);
    task.__id = id;
  }

  const tasks = includedTasks.map(task => ({
    id: task.__id,
    title: task.title,
    description: task.description,
    date: task.date,
    durationMinutes: task.durationMinutes,
    priority: task.priority,
    category: task.category,
    goalId: resolvedGoalId,
    projectId: task.projectRef ? projectIds.get(task.projectRef) ?? null : null,
    milestoneId: task.milestoneRef ? milestoneIds.get(task.milestoneRef) ?? null : null,
    dependsOn: (task.dependsOnRefs || [])
      .map(ref => taskIds.get(ref))
      .filter(Boolean),

    // EHDOTETTU TEHTÄVÄ EI OLE AJASTETTU.
    //
    // Aika tulee aikatauluttajalta ja käyttäjän hyväksynnästä, ei
    // suunnittelijalta. Ilman tätä hyväksytty suunnitelma täyttäisi
    // kalenterin kellonajoilla, joita kukaan ei valinnut.
    time: null,
    endTime: null,
    schedulingState: 'unscheduled',
    completed: false
  }));

  for (const task of includedTasks) delete task.__id;

  const routines = included(plan.routines).map(routine => ({
    id: makeId(),
    title: routine.title,
    description: routine.description,
    goalId: resolvedGoalId,
    recurrence: { type: routine.recurrenceType, weekdays: routine.weekdays },
    durationMinutes: routine.durationMinutes,
    priority: routine.priority,
    category: routine.category,
    scheduling: 'flexible',
    active: true
  }));

  return {
    goalId: resolvedGoalId,
    /** Uusi tavoite luodaan vain jos sitä ei ollut. */
    goal: goalId || plan.goalId ? null : {
      id: resolvedGoalId,
      title: plan.goal.title,
      description: plan.goal.description,
      targetDate: plan.goal.targetDate,
      category: plan.goal.category,
      priority: plan.goal.priority,
      status: 'active',
      progressMode: milestones.length > 0 ? 'task_based' : 'task_based'
    },
    /** Mitattava kohde, jos tulkinta löysi sellaisen. */
    target: plan.goal.targetValue !== null ? {
      metric: plan.goal.metric,
      unit: plan.goal.unit,
      baselineValue: plan.goal.baselineValue,
      currentValue: plan.goal.baselineValue,
      targetValue: plan.goal.targetValue
    } : null,
    milestones,
    projects,
    tasks,
    routines,
    idempotencyKey: plan.idempotencyKey
  };
}

/**
 * Yhteenveto ehdotuksesta käyttöliittymälle.
 *
 * Luvut lasketaan SISÄLLYTETYISTÄ kohdista: käyttäjä on saattanut jättää
 * puolet pois, ja yhteenvedon on kerrottava mitä hyväksyntä oikeasti
 * tekisi — ei mitä malli ehdotti.
 */
export function summarizePlan(plan) {
  if (!plan) return null;

  const tasks = included(plan.tasks);
  const totalMinutes = tasks.reduce((sum, task) => sum + (task.durationMinutes || 0), 0);
  const withoutEstimate = tasks.filter(task => task.durationMinutes === null).length;

  return {
    status: plan.status,
    milestones: included(plan.milestones).length,
    projects: included(plan.projects).length,
    tasks: tasks.length,
    routines: included(plan.routines).length,
    excluded: (plan.milestones.length + plan.projects.length
      + plan.tasks.length + plan.routines.length) - countIncluded(plan),
    estimatedMinutes: totalMinutes,
    tasksWithoutEstimate: withoutEstimate,
    assumptions: plan.assumptions.length,
    questions: plan.questions.length
  };
}
