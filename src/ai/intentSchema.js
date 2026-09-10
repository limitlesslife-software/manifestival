// AI-komentojen intent-skeema ja turvamalli (V2).
//
// PERUSPERIAATE: AI EHDOTTAA, SOVELLUS PÄÄTTÄÄ, KÄYTTÄJÄ VAHVISTAA.
//
// Malli ei koskaan suorita mitään. Se tuottaa ehdotuksen, joka käy läpi:
//
//   1. allowlist         tunnetaanko tämä intentti lainkaan?
//   2. tyyppitarkistus   ovatko kentät yksinkertaisia arvoja?
//   3. skeemavalidointi  ovatko arvot kelvollisia tälle komennolle?
//   4. riskiarvio        vaatiiko tämä käyttäjän vahvistuksen?
//   5. kohteen tunnistus (src/ai/entityResolver.js, oma moduulinsa)
//   6. sovelluskomento   vasta tässä vaiheessa syntyy jotain suoritettavaa
//
// MITÄ AI EI VOI TEHDÄ — EI MISSÄÄN OLOSUHTEISSA
//   - vaihtaa omistajuutta     (user_id ei ole yhdessäkään skeemassa)
//   - suorittaa SQL:ää         (komennot ovat nimettyjä, eivät kyselyitä)
//   - kutsua repositoriota     (resolveCommand palauttaa arvon, ei kutsu)
//   - poistaa epäselvää kohdetta
//   - ohittaa korkean riskin vahvistusta
//
// ---------------------------------------------------------------------
// MUUTOS V1:STÄ: POISTOKOMENNOT OVAT NYT OLEMASSA
// ---------------------------------------------------------------------
//
// V1:ssä poistoa ei ollut allowlistillä lainkaan. Se oli yksinkertaisin
// mahdollinen suoja, mutta tarkoitti myös ettei "poista se peruttu palaveri"
// toiminut lainkaan.
//
// V2 sallii poiston ja korvaa puuttuvan suojan kolmella tiukemmalla:
//
//   1. HIGH-riski, joka vaatii AINA eksplisiittisen vahvistuksen
//      (`requiresExplicitConfirmation`). Sitä ei voi kytkeä pois asetuksista.
//   2. `requiresExactTarget` — poisto ei koskaan etene epäselvällä kohteella.
//      Kaksi samannimistä tehtävää pysäyttää komennon, ei arvauta sitä.
//   3. Vahvistusnäkymä kertoo mitä poistetaan ja mihin se vaikuttaa.
//
// Tämä on tietoinen turvarajan löysennys, joka on korvattu tarkemmalla
// suojalla. Ks. docs/AI-SAFETY.md.

import { CATEGORY_KEYS, normalizeCategory } from '../domain/categories.js';
import { PRIORITY_KEYS, normalizePriority } from '../domain/priority.js';
import { isIsoDate, isTimeOfDay, MAX_TITLE_LENGTH } from '../domain/task.js';
import { RECURRENCE_TYPES, normalizeWeekdays, RECURRENCE } from '../domain/routine.js';
import { GOAL_STATUSES, PROGRESS_MODES } from '../domain/goal.js';
import { PROJECT_STATUSES } from '../domain/project.js';

/** Sallitut intentit. Tämä lista ON turvamalli. */
export const INTENT = Object.freeze({
  // tehtävät
  CREATE_TASK: 'create_task',
  UPDATE_TASK: 'update_task',
  DELETE_TASK: 'delete_task',
  COMPLETE_TASK: 'complete_task',
  UNCOMPLETE_TASK: 'uncomplete_task',
  SCHEDULE_TASK: 'schedule_task',
  RESCHEDULE_TASK: 'reschedule_task',

  // rutiinit
  CREATE_ROUTINE: 'create_routine',
  UPDATE_ROUTINE: 'update_routine',
  DELETE_ROUTINE: 'delete_routine',

  // tavoitteet
  CREATE_GOAL: 'create_goal',
  UPDATE_GOAL: 'update_goal',
  DELETE_GOAL: 'delete_goal',

  // projektit
  CREATE_PROJECT: 'create_project',
  UPDATE_PROJECT: 'update_project',
  DELETE_PROJECT: 'delete_project',

  // talous
  CREATE_BILL: 'create_bill',
  UPDATE_BILL: 'update_bill',
  MARK_BILL_PAID: 'mark_bill_paid',

  // asetukset
  SET_NOTIFICATION_PREFERENCE: 'set_notification_preference',

  // vain luku
  SHOW_DAY_PLAN: 'show_day_plan',
  SHOW_WEEK_PLAN: 'show_week_plan'
});

export const INTENTS = Object.freeze(Object.values(INTENT));

/**
 * Riskitasot ja kielletyt toimenpiteet asuvat DOMAINISSA.
 *
 * Ne olivat aiemmin täällä, koska tekoäly oli ensimmäinen joka niitä
 * tarvitsi. Universaali kirjaus tarvitsee ne myös, eikä domain saa
 * riippua AI-kerroksesta — riippuvuussuunta on domain <- ai.
 *
 * Uudelleenvienti pitää olemassa olevat kutsupaikat ennallaan: yksi
 * lähde, ei kahta luetteloa jotka erkanevat.
 */
// HUOM. `export ... from` EI luo paikallista sidosta, ja tämä tiedosto
// käyttää `RISK`-vakiota itse alempana. Siksi tuonti ja vienti ovat
// erikseen.
import { RISK, RISK_LEVELS, FORBIDDEN_INTENTS } from '../domain/risk.js';

export { RISK, RISK_LEVELS, FORBIDDEN_INTENTS };

export const MAX_NOTE_LENGTH = 300;

/** Kohdetyypit, joita komennot voivat koskea. */
export const TARGET = Object.freeze({
  TASK: 'task',
  ROUTINE: 'routine',
  GOAL: 'goal',
  PROJECT: 'project',
  BILL: 'bill',
  SETTINGS: 'settings',
  VIEW: 'view'
});

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
 * Rahasumma sentteinä.
 *
 * AI puhuu euroista ("129,95"), sovellus säilyttää sentit. Muunnos tehdään
 * heti rajalla, jottei liukuluku pääse kulkemaan syvemmälle.
 * Ks. src/domain/money.js.
 */
function cleanAmountMinor(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
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

/**
 * Kohteen tunnistetiedot muutos- ja poistokomennoille.
 *
 * `targetTitle` TUNNISTAA kohteen, `newTitle` nimeää sen uudelleen. Yhdessä
 * kentässä ne sekoittuisivat, ja "merkitse kaupassa käynti tehdyksi" voisi
 * nimetä tehtävän uudelleen.
 */
function targetFields(raw, { idField = 'taskId' } = {}) {
  const targetId = cleanString(raw[idField] ?? raw.id, 120);
  const targetName = cleanString(
    raw.targetTitle ?? raw.targetName ?? raw.title ?? raw.name, MAX_TITLE_LENGTH);
  return { targetId, targetName };
}

/** Vain nimenomaisesti annetut kentät päätyvät muutoksiksi. */
function changesFrom(result, { renameField = 'newTitle', raw = {} } = {}) {
  const changes = {};
  for (const key of result.provided) {
    if (key === 'title') continue; // tunnistaa kohteen, ei muuta sitä
    changes[key] = result.payload[key];
  }
  const renamed = cleanString(raw[renameField], MAX_TITLE_LENGTH);
  if (renamed) changes.title = renamed;
  return changes;
}

// ------------------------------------------------------ komentorekisteri

/**
 * Sallittujen komentojen rekisteri.
 *
 * Jokainen komento kertoo riskinsä ja sen, vaatiiko se vahvistuksen.
 * Rekisterissä olemattomia komentoja ei voi suorittaa millään tavalla.
 */
export const COMMANDS = Object.freeze({
  // ------------------------------------------------------------- tehtävät

  [INTENT.CREATE_TASK]: {
    intent: INTENT.CREATE_TASK,
    risk: RISK.MEDIUM,
    targetType: TARGET.TASK,
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
    targetType: TARGET.TASK,
    label: 'Muuta tehtävää',
    validate(raw, context) {
      const { targetId, targetName } = targetFields(raw);
      if (!targetId && !targetName) {
        return { ok: false, reason: 'Kohdetehtävää ei voi tunnistaa' };
      }
      const result = taskFields(raw, context, { requireTitle: false });
      const changes = changesFrom(result, { raw });

      if (Object.keys(changes).length === 0) {
        return { ok: false, reason: 'Muutosta ei tunnistettu' };
      }
      return { ok: true, payload: { targetId, targetName, changes }, rejected: result.rejected };
    },
    describe: payload => `Muuta tehtävää: ${payload.targetName || payload.targetId}`
  },

  [INTENT.DELETE_TASK]: {
    intent: INTENT.DELETE_TASK,
    risk: RISK.HIGH,
    targetType: TARGET.TASK,
    requiresExactTarget: true,
    label: 'Poista tehtävä',
    validate(raw) {
      const { targetId, targetName } = targetFields(raw);
      if (!targetId && !targetName) {
        return { ok: false, reason: 'Poistettavaa tehtävää ei voi tunnistaa' };
      }
      return { ok: true, payload: { targetId, targetName }, rejected: [] };
    },
    describe: payload => `Poista tehtävä: ${payload.targetName || payload.targetId}`
  },

  [INTENT.COMPLETE_TASK]: {
    intent: INTENT.COMPLETE_TASK,
    risk: RISK.MEDIUM,
    targetType: TARGET.TASK,
    label: 'Merkitse tehdyksi',
    validate(raw) {
      const { targetId, targetName } = targetFields(raw);
      if (!targetId && !targetName) {
        return { ok: false, reason: 'Kohdetehtävää ei voi tunnistaa' };
      }
      return { ok: true, payload: { targetId, targetName, completed: true }, rejected: [] };
    },
    describe: payload => `Merkitse tehdyksi: ${payload.targetName || payload.targetId}`
  },

  [INTENT.UNCOMPLETE_TASK]: {
    intent: INTENT.UNCOMPLETE_TASK,
    risk: RISK.MEDIUM,
    targetType: TARGET.TASK,
    label: 'Palauta keskeneräiseksi',
    validate(raw) {
      const { targetId, targetName } = targetFields(raw);
      if (!targetId && !targetName) {
        return { ok: false, reason: 'Kohdetehtävää ei voi tunnistaa' };
      }
      return { ok: true, payload: { targetId, targetName, completed: false }, rejected: [] };
    },
    describe: payload => `Palauta keskeneräiseksi: ${payload.targetName || payload.targetId}`
  },

  [INTENT.SCHEDULE_TASK]: {
    intent: INTENT.SCHEDULE_TASK,
    risk: RISK.MEDIUM,
    targetType: TARGET.TASK,
    label: 'Aikatauluta tehtävä',
    validate(raw, context) {
      const { targetId, targetName } = targetFields(raw);
      if (!targetId && !targetName) {
        return { ok: false, reason: 'Kohdetehtävää ei voi tunnistaa' };
      }

      const rejected = [];
      let time = cleanString(raw.time, 5);
      if (time && !isTimeOfDay(time)) { rejected.push('time'); time = null; }

      let date = cleanString(raw.date, 10);
      if (date && !isIsoDate(date)) { rejected.push('date'); date = null; }

      if (!time && !date) return { ok: false, reason: 'Aikaa ei tunnistettu' };

      const changes = {};
      if (date) changes.date = date;
      if (time) changes.time = time;

      return {
        ok: true,
        payload: { targetId, targetName, changes, today: context.today },
        rejected
      };
    },
    describe: payload => {
      const parts = [payload.changes.date, payload.changes.time].filter(Boolean);
      return `Aikatauluta ${payload.targetName || payload.targetId}: ${parts.join(' klo ')}`;
    }
  },

  [INTENT.RESCHEDULE_TASK]: {
    intent: INTENT.RESCHEDULE_TASK,
    risk: RISK.MEDIUM,
    targetType: TARGET.TASK,
    label: 'Siirrä tehtävää',
    validate(raw, context) {
      const { targetId, targetName } = targetFields(raw);
      if (!targetId && !targetName) {
        return { ok: false, reason: 'Kohdetehtävää ei voi tunnistaa' };
      }

      const rejected = [];
      let date = cleanString(raw.date, 10);
      if (date && !isIsoDate(date)) { rejected.push('date'); date = null; }

      let time = cleanString(raw.time, 5);
      if (time && !isTimeOfDay(time)) { rejected.push('time'); time = null; }

      // Suhteellinen siirto: "siirrä kahdella tunnilla". Raja on vuorokausi:
      // suurempi siirto on todennäköisemmin väärinymmärrys kuin tarkoitus.
      const raw_shift = raw.shiftMinutes;
      let shiftMinutes = null;
      if (raw_shift != null) {
        const n = Number(raw_shift);
        if (Number.isFinite(n) && n !== 0 && Math.abs(n) <= 1440) shiftMinutes = Math.round(n);
        else rejected.push('shiftMinutes');
      }

      if (!date && !time && shiftMinutes === null) {
        return { ok: false, reason: 'Uutta aikaa ei tunnistettu' };
      }

      return {
        ok: true,
        payload: { targetId, targetName, date, time, shiftMinutes, today: context.today },
        rejected
      };
    },
    describe: payload => {
      const who = payload.targetName || payload.targetId;
      if (payload.shiftMinutes != null) {
        const minutes = Math.abs(payload.shiftMinutes);
        const amount = minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
        const direction = payload.shiftMinutes > 0 ? 'eteenpäin' : 'taaksepäin';
        return `Siirrä ${who} ${amount} ${direction}`;
      }
      const parts = [payload.date, payload.time].filter(Boolean);
      return `Siirrä ${who}: ${parts.join(' klo ')}`;
    }
  },

  // ------------------------------------------------------------- rutiinit

  [INTENT.CREATE_ROUTINE]: {
    intent: INTENT.CREATE_ROUTINE,
    risk: RISK.MEDIUM,
    targetType: TARGET.ROUTINE,
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

  [INTENT.UPDATE_ROUTINE]: {
    intent: INTENT.UPDATE_ROUTINE,
    risk: RISK.MEDIUM,
    targetType: TARGET.ROUTINE,
    label: 'Muuta rutiinia',
    validate(raw) {
      const { targetId, targetName } = targetFields(raw, { idField: 'routineId' });
      if (!targetId && !targetName) {
        return { ok: false, reason: 'Kohderutiinia ei voi tunnistaa' };
      }

      const rejected = [];
      const changes = {};

      const renamed = cleanString(raw.newTitle, MAX_TITLE_LENGTH);
      if (renamed) changes.title = renamed;

      let time = cleanString(raw.time, 5);
      if (time && !isTimeOfDay(time)) { rejected.push('time'); time = null; }
      if (time) changes.preferredTime = time;

      if (raw.recurrence != null) {
        if (RECURRENCE_TYPES.includes(raw.recurrence)) changes.recurrence = raw.recurrence;
        else rejected.push('recurrence');
      }

      const weekdays = normalizeWeekdays(raw.weekdays);
      if (weekdays.length > 0) changes.weekdays = weekdays;

      const duration = cleanMinutes(raw.durationMinutes);
      if (duration !== null) changes.durationMinutes = duration;

      if (typeof raw.active === 'boolean') changes.active = raw.active;

      if (Object.keys(changes).length === 0) {
        return { ok: false, reason: 'Muutosta ei tunnistettu' };
      }
      return { ok: true, payload: { targetId, targetName, changes }, rejected };
    },
    describe: payload => `Muuta rutiinia: ${payload.targetName || payload.targetId}`
  },

  [INTENT.DELETE_ROUTINE]: {
    intent: INTENT.DELETE_ROUTINE,
    risk: RISK.HIGH,
    targetType: TARGET.ROUTINE,
    requiresExactTarget: true,
    label: 'Poista rutiini',
    validate(raw) {
      const { targetId, targetName } = targetFields(raw, { idField: 'routineId' });
      if (!targetId && !targetName) {
        return { ok: false, reason: 'Poistettavaa rutiinia ei voi tunnistaa' };
      }
      return { ok: true, payload: { targetId, targetName }, rejected: [] };
    },
    describe: payload => `Poista rutiini: ${payload.targetName || payload.targetId}`
  },

  // ----------------------------------------------------------- tavoitteet

  [INTENT.CREATE_GOAL]: {
    intent: INTENT.CREATE_GOAL,
    risk: RISK.MEDIUM,
    targetType: TARGET.GOAL,
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

  [INTENT.UPDATE_GOAL]: {
    intent: INTENT.UPDATE_GOAL,
    risk: RISK.MEDIUM,
    targetType: TARGET.GOAL,
    label: 'Muuta tavoitetta',
    validate(raw) {
      const { targetId, targetName } = targetFields(raw, { idField: 'goalId' });
      if (!targetId && !targetName) {
        return { ok: false, reason: 'Kohdetavoitetta ei voi tunnistaa' };
      }

      const rejected = [];
      const changes = {};

      const renamed = cleanString(raw.newTitle, MAX_TITLE_LENGTH);
      if (renamed) changes.title = renamed;

      let targetDate = cleanString(raw.targetDate, 10);
      if (targetDate && !isIsoDate(targetDate)) { rejected.push('targetDate'); targetDate = null; }
      if (targetDate) changes.targetDate = targetDate;

      if (raw.status != null) {
        if (GOAL_STATUSES.includes(raw.status)) changes.status = raw.status;
        else rejected.push('status');
      }

      if (raw.progressMode != null) {
        if (PROGRESS_MODES.includes(raw.progressMode)) changes.progressMode = raw.progressMode;
        else rejected.push('progressMode');
      }

      if (raw.manualProgress != null) {
        const value = Number(raw.manualProgress);
        if (Number.isFinite(value) && value >= 0 && value <= 100) {
          changes.manualProgress = Math.round(value);
        } else rejected.push('manualProgress');
      }

      if (Object.keys(changes).length === 0) {
        return { ok: false, reason: 'Muutosta ei tunnistettu' };
      }
      return { ok: true, payload: { targetId, targetName, changes }, rejected };
    },
    describe: payload => `Muuta tavoitetta: ${payload.targetName || payload.targetId}`
  },

  [INTENT.DELETE_GOAL]: {
    intent: INTENT.DELETE_GOAL,
    risk: RISK.HIGH,
    targetType: TARGET.GOAL,
    requiresExactTarget: true,
    label: 'Poista tavoite',
    validate(raw) {
      const { targetId, targetName } = targetFields(raw, { idField: 'goalId' });
      if (!targetId && !targetName) {
        return { ok: false, reason: 'Poistettavaa tavoitetta ei voi tunnistaa' };
      }
      return { ok: true, payload: { targetId, targetName }, rejected: [] };
    },
    describe: payload => `Poista tavoite: ${payload.targetName || payload.targetId}`
  },

  // ------------------------------------------------------------ projektit

  [INTENT.CREATE_PROJECT]: {
    intent: INTENT.CREATE_PROJECT,
    risk: RISK.MEDIUM,
    targetType: TARGET.PROJECT,
    label: 'Luo projekti',
    validate(raw) {
      const rejected = [];
      const name = cleanString(raw.name ?? raw.title, MAX_TITLE_LENGTH);
      if (!name) return { ok: false, reason: 'Nimi puuttuu' };

      let deadline = cleanString(raw.deadline ?? raw.targetDate ?? raw.date, 10);
      if (deadline && !isIsoDate(deadline)) { rejected.push('deadline'); deadline = null; }

      if (raw.category != null && !CATEGORY_KEYS.includes(raw.category)) rejected.push('category');

      return {
        ok: true,
        rejected,
        payload: {
          name,
          deadline,
          category: normalizeCategory(raw.category),
          priority: normalizePriority(raw.priority),
          description: cleanString(raw.description, 2000)
        }
      };
    },
    describe: payload => `Luo projekti: ${payload.name}`
  },

  [INTENT.UPDATE_PROJECT]: {
    intent: INTENT.UPDATE_PROJECT,
    risk: RISK.MEDIUM,
    targetType: TARGET.PROJECT,
    label: 'Muuta projektia',
    validate(raw) {
      const { targetId, targetName } = targetFields(raw, { idField: 'projectId' });
      if (!targetId && !targetName) {
        return { ok: false, reason: 'Kohdeprojektia ei voi tunnistaa' };
      }

      const rejected = [];
      const changes = {};

      const renamed = cleanString(raw.newName ?? raw.newTitle, MAX_TITLE_LENGTH);
      if (renamed) changes.name = renamed;

      let deadline = cleanString(raw.deadline, 10);
      if (deadline && !isIsoDate(deadline)) { rejected.push('deadline'); deadline = null; }
      if (deadline) changes.deadline = deadline;

      if (raw.status != null) {
        if (PROJECT_STATUSES.includes(raw.status)) changes.status = raw.status;
        else rejected.push('status');
      }

      if (Object.keys(changes).length === 0) {
        return { ok: false, reason: 'Muutosta ei tunnistettu' };
      }
      return { ok: true, payload: { targetId, targetName, changes }, rejected };
    },
    describe: payload => `Muuta projektia: ${payload.targetName || payload.targetId}`
  },

  [INTENT.DELETE_PROJECT]: {
    intent: INTENT.DELETE_PROJECT,
    risk: RISK.HIGH,
    targetType: TARGET.PROJECT,
    requiresExactTarget: true,
    label: 'Poista projekti',
    validate(raw) {
      const { targetId, targetName } = targetFields(raw, { idField: 'projectId' });
      if (!targetId && !targetName) {
        return { ok: false, reason: 'Poistettavaa projektia ei voi tunnistaa' };
      }
      return { ok: true, payload: { targetId, targetName }, rejected: [] };
    },
    describe: payload => `Poista projekti: ${payload.targetName || payload.targetId}`
  },

  // --------------------------------------------------------------- talous

  [INTENT.CREATE_BILL]: {
    intent: INTENT.CREATE_BILL,
    risk: RISK.MEDIUM,
    targetType: TARGET.BILL,
    label: 'Luo lasku',
    validate(raw) {
      const rejected = [];
      const name = cleanString(raw.name ?? raw.title, MAX_TITLE_LENGTH);
      if (!name) return { ok: false, reason: 'Laskun nimi puuttuu' };

      const amountMinor = cleanAmountMinor(raw.amount);
      if (raw.amount != null && amountMinor === null) rejected.push('amount');

      let dueDate = cleanString(raw.dueDate ?? raw.date ?? raw.deadline, 10);
      if (dueDate && !isIsoDate(dueDate)) { rejected.push('dueDate'); dueDate = null; }
      if (!dueDate) return { ok: false, reason: 'Eräpäivä puuttuu' };

      return {
        ok: true,
        rejected,
        payload: {
          name,
          amountMinor,
          currency: (cleanString(raw.currency, 3) || 'EUR').toUpperCase(),
          dueDate,
          note: cleanString(raw.note, MAX_NOTE_LENGTH)
        }
      };
    },
    describe: payload => `Luo lasku: ${payload.name}`
  },

  [INTENT.UPDATE_BILL]: {
    intent: INTENT.UPDATE_BILL,
    risk: RISK.MEDIUM,
    targetType: TARGET.BILL,
    label: 'Muuta laskua',
    validate(raw) {
      const { targetId, targetName } = targetFields(raw, { idField: 'billId' });
      if (!targetId && !targetName) {
        return { ok: false, reason: 'Kohdelaskua ei voi tunnistaa' };
      }

      const rejected = [];
      const changes = {};

      const renamed = cleanString(raw.newName ?? raw.newTitle, MAX_TITLE_LENGTH);
      if (renamed) changes.name = renamed;

      const amountMinor = cleanAmountMinor(raw.amount);
      if (raw.amount != null && amountMinor === null) rejected.push('amount');
      else if (amountMinor !== null) changes.amountMinor = amountMinor;

      let dueDate = cleanString(raw.dueDate, 10);
      if (dueDate && !isIsoDate(dueDate)) { rejected.push('dueDate'); dueDate = null; }
      if (dueDate) changes.dueDate = dueDate;

      if (Object.keys(changes).length === 0) {
        return { ok: false, reason: 'Muutosta ei tunnistettu' };
      }
      return { ok: true, payload: { targetId, targetName, changes }, rejected };
    },
    describe: payload => `Muuta laskua: ${payload.targetName || payload.targetId}`
  },

  [INTENT.MARK_BILL_PAID]: {
    intent: INTENT.MARK_BILL_PAID,
    risk: RISK.MEDIUM,
    targetType: TARGET.BILL,
    label: 'Merkitse maksetuksi',
    validate(raw, context) {
      const { targetId, targetName } = targetFields(raw, { idField: 'billId' });
      if (!targetId && !targetName) {
        return { ok: false, reason: 'Kohdelaskua ei voi tunnistaa' };
      }

      const rejected = [];
      let paidDate = cleanString(raw.paidDate ?? raw.date, 10);
      if (paidDate && !isIsoDate(paidDate)) { rejected.push('paidDate'); paidDate = null; }

      return {
        ok: true,
        rejected,
        payload: { targetId, targetName, paidDate: paidDate || context.today }
      };
    },
    describe: payload => `Merkitse maksetuksi: ${payload.targetName || payload.targetId}`
  },

  // ------------------------------------------------------------ asetukset

  [INTENT.SET_NOTIFICATION_PREFERENCE]: {
    intent: INTENT.SET_NOTIFICATION_PREFERENCE,
    risk: RISK.MEDIUM,
    targetType: TARGET.SETTINGS,
    label: 'Muuta muistutusasetuksia',
    validate(raw) {
      const rejected = [];
      const changes = {};

      if (typeof raw.enabled === 'boolean') changes.enabled = raw.enabled;

      for (const field of ['taskLeadMinutes', 'routineLeadMinutes']) {
        if (raw[field] == null) continue;
        const value = Number(raw[field]);
        if (Number.isFinite(value) && value >= 0 && value <= 240) changes[field] = Math.round(value);
        else rejected.push(field);
      }

      if (raw.maxPerDay != null) {
        const value = Number(raw.maxPerDay);
        if (Number.isFinite(value) && value >= 1 && value <= 50) changes.maxPerDay = Math.round(value);
        else rejected.push('maxPerDay');
      }

      for (const field of ['quietHoursFrom', 'quietHoursTo']) {
        const value = cleanString(raw[field], 5);
        if (value == null) continue;
        if (isTimeOfDay(value)) changes[field] = value;
        else rejected.push(field);
      }

      if (Object.keys(changes).length === 0) {
        return { ok: false, reason: 'Muutosta ei tunnistettu' };
      }
      return { ok: true, payload: { changes }, rejected };
    },
    describe: () => 'Muuta muistutusasetuksia'
  },

  // ------------------------------------------------------------ vain luku

  [INTENT.SHOW_DAY_PLAN]: {
    intent: INTENT.SHOW_DAY_PLAN,
    risk: RISK.LOW,
    targetType: TARGET.VIEW,
    label: 'Näytä päivä',
    validate(raw, context) {
      let date = cleanString(raw.date, 10);
      if (date && !isIsoDate(date)) date = null;
      return { ok: true, payload: { date: date || context.today }, rejected: [] };
    },
    describe: payload => `Näytä päivä ${payload.date}`
  },

  [INTENT.SHOW_WEEK_PLAN]: {
    intent: INTENT.SHOW_WEEK_PLAN,
    risk: RISK.LOW,
    targetType: TARGET.VIEW,
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

/** Onko komento peruuttamaton? */
export function isDestructive(command) {
  return Boolean(command) && command.risk === RISK.HIGH;
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
  // primitiivitaulukot. Näin AI ei voi ujuttaa olioita tai prototyyppejä.
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
      targetType: definition.targetType,
      requiresConfirmation: definition.risk !== RISK.LOW,
      requiresExplicitConfirmation: definition.risk === RISK.HIGH,
      requiresExactTarget: definition.requiresExactTarget === true,
      label: definition.label,
      payload: result.payload,
      rejectedFields: result.rejected || [],
      description: definition.describe(result.payload)
    }
  };
}

/**
 * Vaatiiko komento käyttäjän vahvistuksen ennen suorittamista?
 *
 * Vain lukevat komennot voivat ohittaa vahvistuksen. HIGH-riskin komennon
 * vahvistusta ei voi ohittaa millään asetuksella — se on turvamallin ydin,
 * ei mukavuusasetus.
 */
export function needsConfirmation(command) {
  if (!command) return true;
  return command.risk !== RISK.LOW;
}
