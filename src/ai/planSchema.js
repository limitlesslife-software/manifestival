// Suunnittelijan vastauksen validointi.
//
// =====================================================================
// TEKOÄLYN TUOTOS ON ULKOINEN SYÖTE
// =====================================================================
//
// Sitä käsitellään samalla epäluulolla kuin selaimeen kirjoitettua
// lomaketta tai verkosta ladattua tiedostoa. Malli voi palauttaa
// HTML:ää, olemassa olevia tunnisteita, mahdottomia päiviä ja tuhat
// tehtävää — eikä mikään niistä saa päätyä sovellukseen sellaisenaan.
//
// FAIL CLOSED. Kelvoton vastaus hylätään kokonaan eikä osittain.
// Puolittain ymmärretty suunnitelma olisi pahin vaihtoehto: se
// näyttäisi suunnitelmalta.
//
// =====================================================================
// KOLME ASIAA, JOITA MALLI EI SAA PÄÄTTÄÄ
// =====================================================================
//
//   1. TUNNISTEET. Mallin ehdottama `id` voisi olla käyttäjän
//      olemassa olevan rivin tunniste, ja "luonti" ylikirjoittaisi sen.
//      Vastauksesta luetaan vain `ref`-avaimia, jotka elävät
//      ehdotuksen sisällä eivätkä osoita mihinkään olemassa olevaan.
//
//   2. KELLONAJAT. Aika tulee aikatauluttajalta ja käyttäjän
//      hyväksynnästä. Malli, joka saisi kiinnittää kellonaikoja,
//      täyttäisi kalenterin ohi käyttäjän oman suunnitelman.
//
//   3. TILAT. Ehdotettu välitavoite on aina avoin, ehdotettu tehtävä
//      aina kesken. Malli ei saa merkitä mitään tehdyksi.
//
// Nämä eivät ole kehotteen suosituksia vaan tämän moduulin poistoja:
// vaikka malli palauttaisi ne, ne eivät kulje läpi.

import { normalizePlan, LIMITS } from '../domain/plan.js';

/** Vastauksen enimmäiskoko merkkeinä. Suojaa jäsennystä ja muistia. */
export const MAX_RESPONSE_LENGTH = 60000;

/**
 * Kentät, jotka luetaan mallin vastauksesta.
 *
 * NIMENOMAINEN LISTA, EI POISLUKULISTA. Tuntematon kenttä pudotetaan
 * hiljaa; poislukulista päästäisi läpi jokaisen kentän, jota kukaan ei
 * osannut kieltää etukäteen.
 */
export const ALLOWED_FIELDS = Object.freeze({
  goal: Object.freeze(['title', 'description', 'targetDate', 'category', 'priority',
    'metric', 'unit', 'baselineValue', 'targetValue', 'confidence']),
  milestone: Object.freeze(['ref', 'title', 'description', 'targetDate']),
  project: Object.freeze(['ref', 'name', 'description', 'milestoneRef', 'deadline',
    'priority', 'category']),
  task: Object.freeze(['ref', 'title', 'description', 'projectRef', 'milestoneRef',
    'date', 'durationMinutes', 'priority', 'category', 'dependsOnRefs']),
  routine: Object.freeze(['ref', 'title', 'description', 'recurrenceType', 'weekdays',
    'durationMinutes', 'priority', 'category'])
});

/**
 * Kentät, joiden esiintyminen vastauksessa on ITSESSÄÄN merkki
 * siitä, että malli yritti tehdä päätöksen joka ei kuulu sille.
 *
 * Näitä ei vain pudoteta vaan ne KIRJATAAN, jotta kehotteen
 * ajautuminen huomataan.
 */
export const REJECTED_FIELDS = Object.freeze([
  'id', 'userId', 'user_id', 'time', 'endTime', 'completed', 'status',
  'schedulingState', 'createdAt', 'updatedAt'
]);

/**
 * Poimi JSON mallin vastauksesta.
 *
 * Malli voi ympäröidä vastauksen tekstillä tai koodilohkolla, vaikka
 * kehote kieltää sen. Poiminta on sallivampi kuin kehote — mutta
 * jäsennys ei ole: löydetyn on oltava kelvollista JSONia.
 */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_RESPONSE_LENGTH) return null;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Suodata olio sallittuihin kenttiin. Palauttaa myös hylätyt nimet. */
function pick(source, allowed, rejected) {
  const out = {};
  if (!source || typeof source !== 'object') return out;

  for (const key of Object.keys(source)) {
    if (allowed.includes(key)) {
      out[key] = source[key];
    } else if (REJECTED_FIELDS.includes(key)) {
      rejected.add(key);
    }
  }
  return out;
}

function pickList(values, allowed, rejected, limit) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, limit).map(value => pick(value, allowed, rejected));
}

/**
 * Validoi ja normalisoi suunnittelijan vastaus.
 *
 * @param {string|object} raw
 * @param {object} context
 * @param {string} [context.goalId]  olemassa oleva tavoite (replan)
 * @param {string} [context.idempotencyKey]
 * @returns {{ok: boolean, plan?: object, reason?: string, rejectedFields?: Array}}
 */
export function validatePlanResponse(raw, context = {}) {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: 'Vastausta ei tullut.' };
  }

  const data = typeof raw === 'string' ? extractJson(raw) : raw;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'Vastaus ei ollut kelvollista JSONia.' };
  }

  const rejected = new Set();

  const goal = pick(data.goal, ALLOWED_FIELDS.goal, rejected);
  if (!goal.title || String(goal.title).trim() === '') {
    return { ok: false, reason: 'Vastauksesta puuttuu tavoitteen nimi.' };
  }

  const shaped = {
    status: 'generated',
    kind: context.goalId ? 'replan' : 'initial',
    goalId: context.goalId ?? null,
    idempotencyKey: context.idempotencyKey ?? null,
    goal,
    milestones: pickList(data.milestones, ALLOWED_FIELDS.milestone, rejected,
      LIMITS.milestones),
    projects: pickList(data.projects, ALLOWED_FIELDS.project, rejected, LIMITS.projects),
    tasks: pickList(data.tasks, ALLOWED_FIELDS.task, rejected, LIMITS.tasks),
    routines: pickList(data.routines, ALLOWED_FIELDS.routine, rejected, LIMITS.routines),
    assumptions: Array.isArray(data.assumptions) ? data.assumptions : [],
    questions: Array.isArray(data.questions) ? data.questions : []
  };

  const plan = normalizePlan(shaped);

  // TYHJÄ SUUNNITELMA EI OLE SUUNNITELMA.
  //
  // Malli, joka palauttaa pelkän tavoitteen ilman yhtään askelta, ei
  // ole vastannut kysymykseen. Rehellisempi vastaus on kertoa ettei
  // suunnittelu onnistunut kuin näyttää tyhjä hyväksyntänäkymä.
  const content = plan.milestones.length + plan.projects.length
    + plan.tasks.length + plan.routines.length;

  if (content === 0) {
    return {
      ok: false,
      reason: 'Suunnitelmaan ei saatu yhtään askelta.',
      rejectedFields: [...rejected]
    };
  }

  return { ok: true, plan, rejectedFields: [...rejected] };
}

/**
 * Rakennettavan kontekstin rajaus.
 *
 * MALLILLE LÄHETETÄÄN VAIN SE, MITÄ SUUNNITTELUUN TARVITAAN. Koko
 * tehtävälista, muistiinpanot ja hyvinvointimerkinnät ovat käyttäjän
 * henkilökohtaisinta tietoa, eikä niitä lähetetä ulos vain siksi että
 * ne sattuvat olemaan muistissa.
 *
 * Mukaan menee LUKUJA, ei sisältöä:
 *   - montako aktiivista tavoitetta on
 *   - paljonko vapaata aikaa viikossa on
 *   - mitkä määräpäivät ovat lähellä
 *
 * Yhdenkään tehtävän otsikkoa ei lähetetä, ellei se ole osa sitä
 * tavoitetta jota suunnitellaan.
 */
export function buildPlanningContext({
  goals = [],
  capacity = null,
  todayIso = null,
  existingGoal = null,
  alignmentCapHours = null,
  alignmentConstraints = null
} = {}) {
  const active = goals.filter(goal => goal && goal.status === 'active');

  const computedHours = capacity && capacity.dayCount > 0
    ? Math.round((capacity.totalUsableMinutes / capacity.dayCount) * 7 / 60)
    : null;

  return {
    today: todayIso,
    /** Montako tavoitetta kilpailee ajasta. Ei nimiä. */
    activeGoalCount: active.length,
    /** Lähestyvät määräpäivät päivinä, ei tavoitteiden niminä. */
    nearestDeadlineDays: nearestDeadline(active, todayIso),
    /**
     * Vapaa aika viikossa tunteina. Karkea luku riittää.
     *
     * Suunnan palaute (src/domain/alignmentReview.js planningFeedback)
     * voi RAJATA tätä käyttäjän oman viikkokapasiteetin mukaan: jos
     * käyttäjä on sanonut ehtivänsä vähemmän kuin kalenteri näyttää,
     * suunnitelma ei saa olettaa enempää. Raja vain laskee, ei koskaan
     * nosta.
     */
    weeklyFreeHours: Number.isFinite(alignmentCapHours) && alignmentCapHours >= 0
      ? (computedHours === null ? alignmentCapHours : Math.min(computedHours, alignmentCapHours))
      : computedHours,
    /**
     * Suunnan rajat (src/domain/planAlignment.js). Pelkkiä lukuja:
     * palvelin päästää läpi vain nimetyt kentät (api/_validatePlan.js).
     */
    remainingWeeklyHours: alignmentConstraints ? alignmentConstraints.remainingHours : null,
    unestimatedCount: alignmentConstraints ? alignmentConstraints.unestimatedCount : null,
    heavyRemainingHours: alignmentConstraints ? alignmentConstraints.heavyRemainingHours : null,
    protectedHours: alignmentConstraints ? alignmentConstraints.protectedHours : null,
    neglectedImportantAreaCount: alignmentConstraints ? alignmentConstraints.neglectedImportantAreaCount : null,
    /** Kun kyse on olemassa olevan tavoitteen uudelleensuunnittelusta. */
    existingGoalTitle: existingGoal ? existingGoal.title : null,
    existingTargetDate: existingGoal ? existingGoal.targetDate : null
  };
}

function nearestDeadline(goals, todayIso) {
  if (!todayIso) return null;

  const dates = goals
    .map(goal => goal.targetDate)
    .filter(date => typeof date === 'string' && date >= todayIso)
    .sort();

  if (dates.length === 0) return null;

  const days = Math.round(
    (Date.parse(dates[0] + 'T00:00:00Z') - Date.parse(todayIso + 'T00:00:00Z')) / 86400000);
  return Number.isFinite(days) ? days : null;
}
