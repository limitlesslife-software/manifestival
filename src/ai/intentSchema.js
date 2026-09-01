// AI-komentojen intent-skeema ja turvamalli.
//
// PERUSPERIAATE: AI EHDOTTAA, SOVELLUS PÄÄTTÄÄ, KÄYTTÄJÄ VAHVISTAA.
//
// Malli ei koskaan suorita mitään. Se tuottaa ehdotuksen, joka käy läpi:
//
//   1. allowlist        tunnetaanko tämä intentti lainkaan?
//   2. skeemavalidointi ovatko kentät oikean tyyppisiä ja sallittuja?
//   3. riskiarvio       vaatiiko tämä käyttäjän vahvistuksen?
//   4. sovelluskomento  vasta tässä vaiheessa syntyy jotain suoritettavaa
//
// MITÄ AI EI VOI TEHDÄ — EI MISSÄÄN OLOSUHTEISSA
//   - poistaa dataa            (poisto ei ole allowlistissä lainkaan)
//   - vaihtaa omistajuutta     (user_id ei ole yhdessäkään skeemassa)
//   - suorittaa SQL:ää         (komennot ovat nimettyjä, eivät kyselyitä)
//   - kutsua repositoriota     (dispatcher palauttaa komennon, ei kutsu mitään)
//   - tehdä korkean riskin toimintoa ilman vahvistusta
//
// Tuntematon intentti hylätään. Se ei ole virhe vaan normaali lopputulos:
// käyttäjä sai vastauksen, jota sovellus ei osaa toteuttaa.

import { CATEGORY_KEYS, normalizeCategory } from '../domain/categories.js';
import { PRIORITY_KEYS, normalizePriority } from '../domain/priority.js';
import { isIsoDate, isTimeOfDay, MAX_TITLE_LENGTH } from '../domain/task.js';
import { RECURRENCE_TYPES, normalizeWeekdays, RECURRENCE } from '../domain/routine.js';

/** Sallitut intentit. Tämä lista ON turvamalli. */
export const INTENT = Object.freeze({
  CREATE_TASK: 'create_task',
  UPDATE_TASK: 'update_task',
  COMPLETE_TASK: 'complete_task',
  CREATE_ROUTINE: 'create_routine',
  CREATE_GOAL: 'create_goal',
  SHOW_DAY: 'show_day',
  SHOW_WEEK: 'show_week'
});

export const INTENTS = Object.freeze(Object.values(INTENT));

/**
 * Intentit, joita EI ole eikä tule ilman erillistä suunnittelua.
 * Lista on olemassa dokumentaationa ja testattavana invarianttina.
 */
export const FORBIDDEN_INTENTS = Object.freeze([
  'delete_task', 'delete_routine', 'delete_goal', 'delete_all',
  'change_owner', 'transfer_data', 'execute_sql', 'run_query',
  'update_settings', 'disable_security', 'grant_access'
]);

/** Riskitasot. Määräävät vahvistuksen tarpeen. */
export const RISK = Object.freeze({
  /** Ei muuta mitään. */
  READ_ONLY: 'read_only',
  /** Luo uutta. Peruttavissa. */
  LOW: 'low',
  /** Muuttaa olemassa olevaa. */
  MEDIUM: 'medium',
  /** Ei käytössä — varattu tuleville toiminnoille. */
  HIGH: 'high'
});

export const MAX_NOTE_LENGTH = 300;

function cleanString(value, maxLength) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return null;
  return trimmed.slice(0, maxLength);
}

function cleanMinutes(value, max = 1440) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.round(n), max);
}

/**
 * Hylkää arvot, jotka eivät ole yksinkertaisia tietotyyppejä.
 * Estää olioiden, funktioiden ja prototyyppien ujuttamisen payloadiin.
 */
function isPrimitive(value) {
  return value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean';
}

// --------------------------------------------------- kenttävalidoinnit

/**
 * Poimii tehtäväkentät raakadatasta.
 *
 * Palauttaa `provided`-joukon, joka kertoo mitkä kentät tulivat OIKEASTI
 * syötteestä kelvollisina. Ero on kriittinen muutoskomennoissa:
 * `normalizeCategory(undefined)` palauttaa 'muu', joten ilman tätä erottelua
 * "siirrä hammaslääkäri kolmeen" ylikirjoittaisi hiljaa myös kategorian ja
 * prioriteetin oletusarvoilla. Se olisi tietohäviö, jota käyttäjä ei pyytänyt.
 */
function taskFields(raw, context, { requireTitle = true } = {}) {
  const rejected = [];
  const provided = new Set();

  const title = cleanString(raw.title, MAX_TITLE_LENGTH);
  if (requireTitle && !title) return { error: 'Otsikko puuttuu', rejected, provided };
  if (title) provided.add('title');

  let date = cleanString(raw.date, 10);
  if (date && !isIsoDate(date)) { rejected.push('date'); date = null; }
  else if (date) provided.add('date');
  if (requireTitle && !date) date = context.today;

  let time = cleanString(raw.time, 5);
  if (time && !isTimeOfDay(time)) { rejected.push('time'); time = null; }
  else if (time) provided.add('time');

  let endTime = cleanString(raw.endTime, 5);
  if (endTime && !isTimeOfDay(endTime)) { rejected.push('endTime'); endTime = null; }
  if (endTime && !time) { rejected.push('endTime'); endTime = null; }
  if (endTime && time && endTime === time) { rejected.push('endTime'); endTime = null; }
  if (endTime) provided.add('endTime');

  let deadline = cleanString(raw.deadline, 10);
  if (deadline && !isIsoDate(deadline)) { rejected.push('deadline'); deadline = null; }
  else if (deadline) provided.add('deadline');

  const durationMinutes = cleanMinutes(raw.durationMinutes);
  if (raw.durationMinutes != null && durationMinutes === null) rejected.push('durationMinutes');
  else if (durationMinutes !== null) provided.add('durationMinutes');

  if (raw.category != null && !CATEGORY_KEYS.includes(raw.category)) rejected.push('category');
  else if (raw.category != null) provided.add('category');

  if (raw.priority != null && !PRIORITY_KEYS.includes(raw.priority)) rejected.push('priority');
  else if (raw.priority != null) provided.add('priority');

  const note = cleanString(raw.note, MAX_NOTE_LENGTH);
  if (note) provided.add('note');

  return {
    rejected,
    provided,
    payload: {
      title,
      date,
      time,
      endTime,
      deadline,
      durationMinutes,
      category: normalizeCategory(raw.category),
      priority: normalizePriority(raw.priority),
      note
    }
  };
}

// ------------------------------------------------------ komentorekisteri

/**
 * Sallittujen komentojen rekisteri.
 *
 * Jokainen komento kertoo riskinsä ja sen, vaatiiko se vahvistuksen.
 * Rekisterissä olemattomia komentoja ei voi suorittaa millään tavalla.
 */
export const COMMANDS = Object.freeze({
  [INTENT.CREATE_TASK]: {
    intent: INTENT.CREATE_TASK,
    risk: RISK.LOW,
    requiresConfirmation: true,
    label: 'Luo tehtävä',
    validate(raw, context) {
      const result = taskFields(raw, context);
      if (result.error) return { ok: false, reason: result.error };
      return { ok: true, payload: result.payload, rejected: result.rejected };
    },
    describe: payload => `Luo tehtävä: ${payload.title}`
  },

  [INTENT.UPDATE_TASK]: {
    intent: INTENT.UPDATE_TASK,
    risk: RISK.MEDIUM,
    requiresConfirmation: true,
    label: 'Muuta tehtävää',
    validate(raw, context) {
      const targetId = cleanString(raw.taskId, 120);
      const targetTitle = cleanString(raw.targetTitle ?? raw.title, MAX_TITLE_LENGTH);
      if (!targetId && !targetTitle) {
        return { ok: false, reason: 'Kohdetehtävää ei voi tunnistaa' };
      }

      const result = taskFields(raw, context, { requireTitle: false });

      // VAIN nimenomaisesti annetut kentät muuttuvat. Muihin ei kosketa.
      const changes = {};
      for (const key of result.provided) {
        if (key === 'title') continue; // `title` tunnistaa kohteen, ei muuta sitä
        changes[key] = result.payload[key];
      }

      // Uusi otsikko annetaan omassa kentässään, jotta kohteen tunnistus ja
      // uudelleennimeäminen eivät sekoitu keskenään.
      const newTitle = cleanString(raw.newTitle, MAX_TITLE_LENGTH);
      if (newTitle) changes.title = newTitle;

      if (Object.keys(changes).length === 0) {
        return { ok: false, reason: 'Muutosta ei tunnistettu' };
      }
      return { ok: true, payload: { targetId, targetTitle, changes }, rejected: result.rejected };
    },
    describe: payload => `Muuta tehtävää: ${payload.targetTitle || payload.targetId}`
  },

  [INTENT.COMPLETE_TASK]: {
    intent: INTENT.COMPLETE_TASK,
    risk: RISK.MEDIUM,
    requiresConfirmation: true,
    label: 'Merkitse tehdyksi',
    validate(raw) {
      const targetId = cleanString(raw.taskId, 120);
      const targetTitle = cleanString(raw.targetTitle ?? raw.title, MAX_TITLE_LENGTH);
      if (!targetId && !targetTitle) {
        return { ok: false, reason: 'Kohdetehtävää ei voi tunnistaa' };
      }
      return { ok: true, payload: { targetId, targetTitle, completed: true }, rejected: [] };
    },
    describe: payload => `Merkitse tehdyksi: ${payload.targetTitle || payload.targetId}`
  },

  [INTENT.CREATE_ROUTINE]: {
    intent: INTENT.CREATE_ROUTINE,
    risk: RISK.LOW,
    requiresConfirmation: true,
    label: 'Luo rutiini',
    validate(raw) {
      const rejected = [];
      const title = cleanString(raw.title, MAX_TITLE_LENGTH);
      if (!title) return { ok: false, reason: 'Otsikko puuttuu' };

      let type = raw.recurrence;
      if (!RECURRENCE_TYPES.includes(type)) {
        if (type != null) rejected.push('recurrence');
        type = RECURRENCE.DAILY;
      }

      const weekdays = normalizeWeekdays(raw.weekdays);
      if (type === RECURRENCE.CUSTOM_WEEKDAYS && weekdays.length === 0) {
        return { ok: false, reason: 'Viikonpäivät puuttuvat' };
      }

      let preferredTime = cleanString(raw.time, 5);
      if (preferredTime && !isTimeOfDay(preferredTime)) {
        rejected.push('time');
        preferredTime = null;
      }

      if (raw.category != null && !CATEGORY_KEYS.includes(raw.category)) rejected.push('category');

      return {
        ok: true,
        rejected,
        payload: {
          title,
          recurrence: type,
          weekdays,
          preferredTime,
          durationMinutes: cleanMinutes(raw.durationMinutes) ?? 30,
          category: normalizeCategory(raw.category),
          priority: normalizePriority(raw.priority)
        }
      };
    },
    describe: payload => `Luo rutiini: ${payload.title}`
  },

  [INTENT.CREATE_GOAL]: {
    intent: INTENT.CREATE_GOAL,
    risk: RISK.LOW,
    requiresConfirmation: true,
    label: 'Luo tavoite',
    validate(raw) {
      const rejected = [];
      const title = cleanString(raw.title, MAX_TITLE_LENGTH);
      if (!title) return { ok: false, reason: 'Otsikko puuttuu' };

      let targetDate = cleanString(raw.targetDate ?? raw.date, 10);
      if (targetDate && !isIsoDate(targetDate)) { rejected.push('targetDate'); targetDate = null; }

      if (raw.category != null && !CATEGORY_KEYS.includes(raw.category)) rejected.push('category');

      return {
        ok: true,
        rejected,
        payload: {
          title,
          targetDate,
          category: normalizeCategory(raw.category),
          priority: normalizePriority(raw.priority),
          description: cleanString(raw.description, 2000)
        }
      };
    },
    describe: payload => `Luo tavoite: ${payload.title}`
  },

  [INTENT.SHOW_DAY]: {
    intent: INTENT.SHOW_DAY,
    risk: RISK.READ_ONLY,
    requiresConfirmation: false,
    label: 'Näytä päivä',
    validate(raw, context) {
      let date = cleanString(raw.date, 10);
      if (date && !isIsoDate(date)) date = null;
      return { ok: true, payload: { date: date || context.today }, rejected: [] };
    },
    describe: payload => `Näytä päivä ${payload.date}`
  },

  [INTENT.SHOW_WEEK]: {
    intent: INTENT.SHOW_WEEK,
    risk: RISK.READ_ONLY,
    requiresConfirmation: false,
    label: 'Näytä viikko',
    validate(raw, context) {
      let date = cleanString(raw.date, 10);
      if (date && !isIsoDate(date)) date = null;
      return { ok: true, payload: { date: date || context.today }, rejected: [] };
    },
    describe: payload => `Näytä viikko ${payload.date}`
  }
});

/** Onko intentti sallittu. */
export function isAllowedIntent(intent) {
  return typeof intent === 'string' && Object.prototype.hasOwnProperty.call(COMMANDS, intent);
}

/**
 * Muunna AI:n tuottama raakaehdotus turvalliseksi sovelluskomennoksi.
 *
 * EI SUORITA MITÄÄN. Palauttaa kuvauksen siitä, mitä voitaisiin tehdä.
 *
 * @param {unknown} raw       AI:n tuottama objekti
 * @param {object}  context   { today: 'YYYY-MM-DD' }
 * @returns {{ok:true, command:object}|{ok:false, reason:string, intent?:string}}
 */
export function resolveCommand(raw, context = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'Vastaus ei ollut objekti' };
  }

  const intent = raw.intent;

  if (!isAllowedIntent(intent)) {
    // Tuntematon TAI nimenomaisesti kielletty — molemmat hylätään samalla
    // tavalla. Ero näkyy vain lokissa, ei käyttäjälle.
    return {
      ok: false,
      reason: 'Tuntematon komento',
      intent: typeof intent === 'string' ? intent : null,
      forbidden: FORBIDDEN_INTENTS.includes(intent)
    };
  }

  const payloadInput = (raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload))
    ? raw.payload
    : raw;

  // Torju monimutkaiset rakenteet: sallitaan vain yksinkertaiset arvot ja
  // viikonpäivätaulukko. Näin AI ei voi ujuttaa olioita tai prototyyppejä.
  for (const [key, value] of Object.entries(payloadInput)) {
    if (key === 'intent' || key === 'payload') continue;
    if (Array.isArray(value)) {
      if (!value.every(isPrimitive)) {
        return { ok: false, reason: 'Kelvoton kenttä: ' + key };
      }
      continue;
    }
    if (!isPrimitive(value)) {
      return { ok: false, reason: 'Kelvoton kenttä: ' + key };
    }
  }

  const definition = COMMANDS[intent];
  const result = definition.validate(payloadInput, { today: context.today || null });

  if (!result.ok) {
    return { ok: false, reason: result.reason, intent };
  }

  return {
    ok: true,
    command: {
      intent,
      risk: definition.risk,
      requiresConfirmation: definition.requiresConfirmation,
      label: definition.label,
      payload: result.payload,
      rejectedFields: result.rejected || [],
      description: definition.describe(result.payload)
    }
  };
}

/**
 * Vaatiiko komento käyttäjän vahvistuksen ennen suorittamista?
 * Vain lukevat komennot voivat ohittaa vahvistuksen.
 */
export function needsConfirmation(command) {
  if (!command) return true;
  if (command.risk === RISK.READ_ONLY) return false;
  return command.requiresConfirmation !== false;
}
