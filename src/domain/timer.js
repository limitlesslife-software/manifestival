// Ajanseuranta: ajastin, jonka kesto johdetaan AIKALEIMOISTA.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa. Kellonaika annetaan aina
// parametrina (`nowMs`), ei lueta.
//
// =====================================================================
// AIKALEIMAT OVAT TOTUUS, EI LASKURI
// =====================================================================
//
// Ajastin tallentaa vain alkuhetken, tauon alkuhetken ja taukojen
// summan. Kulunut aika LASKETAAN aina uudelleen:
//
//   kulunut = (tauon alku TAI nyt) − alku − taukojen summa
//
// Siksi näytön päivitysväli (setInterval), sovelluksen tausta-aika,
// uudelleenlataus tai lukittu näyttö eivät vaikuta tulokseen: mitään ei
// tarvitse ajaa taustalla, jotta aika pysyy oikeana. Natiivia
// taustasuoritusta ei ole eikä sitä väitetä.
//
// =====================================================================
// KESKIYÖ, KESÄAIKA JA AIKAVYÖHYKE
// =====================================================================
//
// Kesto on millisekunteja kahden absoluuttisen aikaleiman välillä, joten
// kesäajan vaihdos tai aikavyöhykkeen muutos ei muuta kestoa. Kirjauksen
// PÄIVÄ taas on paikallinen päivä: keskiyön ylittävä ajastus jaetaan
// päiville paikallisen keskiyön kohdalta (pysäytyshetken aikavyöhykkeessä),
// jotta sunnuntain ja maanantain aika menee oikeille viikoille. Tauot
// jaetaan päiville suhteessa niiden osuuteen (taukojen ajankohtaa ei
// tallenneta, vain summa).
//
// =====================================================================
// SUOJAUKSET
// =====================================================================
//
//   - kaksi ajastinta: startTimer kieltäytyy, jos ajastin on jo käynnissä
//   - tulevaisuuden alku: hylätään (sallittu kellojen ero MAX_FUTURE_SKEW_MS)
//   - negatiivinen kesto: kello siirtyi taaksepäin -> 0 ja `clockSkew`
//   - nollakesto: alle puolen minuutin ajastus ei tuota kirjausta
//   - unohtunut ajastin: yli REVIEW_AFTER_MINUTES pyydetään tarkistamaan
//   - kaksoispysäytys: kirjauksilla on deterministinen operaatiotunniste
//   - osittain epäonnistunut pysäytys: pysäytyssuunnitelma (stopAtMs,
//     overrideMinutes) tallentuu laitteelle, joten uusinta tuottaa samat osat

import { TIMER_RULES } from './alignmentPolicy.js';
import { OPERATION, TIME_SOURCE, MAX_ENTRY_MINUTES } from './timeEntry.js';
import { isIsoDate } from './task.js';

export const TIMER_TARGET = Object.freeze({
  NONE: 'none', LIFE_AREA: 'life_area', GOAL: 'goal', TASK: 'task', PROJECT: 'project', ROUTINE: 'routine'
});
export const TIMER_TARGETS = Object.freeze(Object.values(TIMER_TARGET));
export const MAX_TIMER_NOTE_LENGTH = 500;
const MAX_PAUSED_SECONDS = 7 * 24 * 3600;

const TARGET_FIELD = Object.freeze({
  life_area: 'lifeAreaId', goal: 'goalId', task: 'taskId', project: 'projectId', routine: 'routineId'
});

function optionalId(value) {
  return value === null || value === undefined || value === '' ? null : String(value);
}

function isoOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function msOf(iso) {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** Enintään näin monta jo kirjattua osaa muistetaan suunnitelmassa. */
const MAX_PLAN_PARTS = 64;

/**
 * Pysäytyssuunnitelma: VAIN laitteella (kannassa ei ole sarakkeita, eikä
 * runningTimersRepo.toRow lähetä näitä). Kun pysäytyshetki ja korjattu
 * kesto on tallessa ennen ensimmäistä kirjausta, uusinta laskee täsmälleen
 * samat osat ja operaatiotunnisteet — myös uudelleenlatauksen jälkeen —
 * ja kirjaa vain puuttuvat osat (`loggedOperationIds`).
 */
function stopPlanFields(input) {
  if (input.stopAtMs === null || input.stopAtMs === undefined || input.stopAtMs === '') return {};
  const at = Number(input.stopAtMs);
  if (!Number.isFinite(at)) return {};
  const override = Number.isInteger(input.overrideMinutes) && input.overrideMinutes >= 0 ? input.overrideMinutes : null;
  const logged = Array.isArray(input.loggedOperationIds)
    ? [...new Set(input.loggedOperationIds.filter(id => typeof id === 'string' && id))].slice(0, MAX_PLAN_PARTS)
    : [];
  return { stopAtMs: at, overrideMinutes: override, loggedOperationIds: logged };
}

/** Onko ajastimen pysäytys jo päätetty (kirjaus kesken tai uusittavana)? */
export function hasStopPlan(timer) {
  return Boolean(timer) && Number.isFinite(timer.stopAtMs);
}

export function normalizeTimer(input = {}) {
  const paused = Number(input.pausedSeconds);
  const note = input.note == null ? null : String(input.note).trim().slice(0, MAX_TIMER_NOTE_LENGTH) || null;
  let targetKind = TIMER_TARGETS.includes(input.targetKind) ? input.targetKind : TIMER_TARGET.NONE;
  // Kohde on poistettu (kanta nollasi sarakkeen, laji jäi): ajastin
  // säilyy näkyvänä ja pysäytettävänä "yleisenä" eikä juutu piiloon.
  const field = TARGET_FIELD[targetKind];
  if (field && optionalId(input[field]) === null) targetKind = TIMER_TARGET.NONE;
  return {
    id: input.id != null ? String(input.id) : null,
    targetKind,
    lifeAreaId: optionalId(input.lifeAreaId),
    goalId: optionalId(input.goalId),
    taskId: optionalId(input.taskId),
    projectId: optionalId(input.projectId),
    routineId: optionalId(input.routineId),
    occurrenceDate: isIsoDate(input.occurrenceDate) ? input.occurrenceDate : null,
    startedAt: isoOrNull(input.startedAt),
    pausedAt: isoOrNull(input.pausedAt),
    pausedSeconds: Number.isFinite(paused) && paused > 0 ? Math.min(Math.round(paused), MAX_PAUSED_SECONDS) : 0,
    note,
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null,
    ...stopPlanFields(input)
  };
}

export function validateTimer(timer) {
  const errors = {};
  if (!timer || !timer.id) errors.id = 'Ajastimen tunniste puuttuu.';
  if (!timer || !timer.startedAt) errors.startedAt = 'Aloitusaika puuttuu.';
  if (timer && timer.pausedAt && timer.startedAt && msOf(timer.pausedAt) < msOf(timer.startedAt)) {
    errors.pausedAt = 'Tauko ei voi alkaa ennen ajastinta.';
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Kohde ajastimelle. `target` = { kind, id, lifeAreaId?, occurrenceDate? }.
 * Tuntematon laji on "yleinen" (ei kohdetta).
 */
export function timerTargetFields(target = {}) {
  const kind = TIMER_TARGETS.includes(target.kind) ? target.kind : TIMER_TARGET.NONE;
  const fields = {
    targetKind: kind, lifeAreaId: null, goalId: null, taskId: null, projectId: null,
    routineId: null, occurrenceDate: null
  };
  const field = TARGET_FIELD[kind];
  if (field) fields[field] = optionalId(target.id);
  if (kind === TIMER_TARGET.ROUTINE && isIsoDate(target.occurrenceDate)) {
    fields.occurrenceDate = target.occurrenceDate;
  }
  // "Yleinen" ajastus voi silti kuulua alueeseen (valittu erikseen).
  if (kind === TIMER_TARGET.NONE && target.lifeAreaId) {
    fields.lifeAreaId = optionalId(target.lifeAreaId);
  }
  return fields;
}

/**
 * Käynnistä ajastin. Kieltäytyy, jos toinen on jo käynnissä: kaksi
 * rinnakkaista ajastinta laskisi saman ajan kahteen kertaan.
 *
 * @returns {{ok: true, timer} | {ok: false, code: string, message: string}}
 */
export function startTimer({ id, target = {}, nowMs, existing = null, startedAtMs = null, note = null }) {
  if (existing && existing.startedAt) {
    return { ok: false, code: 'timer.already_running', message: 'Ajastin on jo käynnissä. Pysäytä se ensin.' };
  }
  if (!Number.isFinite(nowMs)) {
    return { ok: false, code: 'timer.no_clock', message: 'Aikaa ei voitu lukea.' };
  }
  const start = Number.isFinite(startedAtMs) ? startedAtMs : nowMs;
  if (start > nowMs + TIMER_RULES.MAX_FUTURE_SKEW_MS) {
    return { ok: false, code: 'timer.future_start', message: 'Ajastin ei voi alkaa tulevaisuudessa.' };
  }
  const kind = TIMER_TARGETS.includes(target.kind) ? target.kind : TIMER_TARGET.NONE;
  if (TARGET_FIELD[kind] && !optionalId(target.id)) {
    return { ok: false, code: 'timer.invalid', message: 'Ajastettava kohde puuttuu.' };
  }
  const timer = normalizeTimer({ id, ...timerTargetFields(target), startedAt: start, note });
  const { valid, errors } = validateTimer(timer);
  if (!valid) {
    return { ok: false, code: 'timer.invalid', message: Object.values(errors)[0] };
  }
  return { ok: true, timer };
}

/** Tauko. Jo tauolla oleva ajastin palautetaan sellaisenaan (idempotentti). */
export function pauseTimer(timer, nowMs) {
  if (!timer || timer.pausedAt) return timer;
  const start = msOf(timer.startedAt);
  const at = Number.isFinite(start) ? Math.max(nowMs, start) : nowMs;
  return { ...timer, pausedAt: new Date(at).toISOString() };
}

/** Jatka. Käynnissä oleva ajastin palautetaan sellaisenaan (idempotentti). */
export function resumeTimer(timer, nowMs) {
  if (!timer || !timer.pausedAt) return timer;
  const pausedMs = msOf(timer.pausedAt);
  const extra = Number.isFinite(pausedMs) ? Math.max(0, (nowMs - pausedMs) / 1000) : 0;
  const total = Math.round(timer.pausedSeconds + extra);
  if (total <= MAX_PAUSED_SECONDS) return { ...timer, pausedAt: null, pausedSeconds: total };
  // Taukoja yli kannan rajan (7 vrk): alku siirtyy ylityksen verran
  // eteenpäin, jolloin kulunut aika pysyy täsmälleen samana eikä pitkä
  // tauko muutu työajaksi.
  const shift = total - MAX_PAUSED_SECONDS;
  return {
    ...timer,
    startedAt: new Date(msOf(timer.startedAt) + shift * 1000).toISOString(),
    pausedAt: null,
    pausedSeconds: MAX_PAUSED_SECONDS
  };
}

/**
 * Ajastimen tila hetkellä `nowMs`. Kaikki johdetaan aikaleimoista.
 *
 * @returns {{state: 'running'|'paused'|'none', elapsedSeconds: number, clockSkew: boolean}}
 */
export function timerStatus(timer, nowMs) {
  if (!timer || !timer.startedAt) return { state: 'none', elapsedSeconds: 0, clockSkew: false };
  const start = msOf(timer.startedAt);
  const endMs = timer.pausedAt ? msOf(timer.pausedAt) : nowMs;
  const raw = (endMs - start) / 1000 - timer.pausedSeconds;
  return {
    state: timer.pausedAt ? 'paused' : 'running',
    elapsedSeconds: Math.max(0, Math.floor(raw)),
    // Kello on siirtynyt taaksepäin aloituksen jälkeen: kestoa ei
    // näytetä negatiivisena eikä kirjata.
    clockSkew: raw < 0
  };
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/** "0:05", "1:05" (h:mm) — tekstimuotoinen tila ruudunlukijalle ja näytölle. */
export function formatElapsed(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${hours}:${pad(minutes)}`;
}

/** Paikallinen päivä ja seuraava paikallinen keskiyö (järjestelmän aikavyöhyke). */
export const LOCAL_CALENDAR = Object.freeze({
  dateOf(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },
  nextMidnight(ms) {
    const d = new Date(ms);
    // Paikallinen keskiyö rakennetaan kalenterista, ei lisäämällä 24 h:
    // kesäajan vaihdospäivä on 23 tai 25 tuntia pitkä.
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  }
});

/**
 * Jaa aktiivinen aika minuutteina niin, että summa on täsmälleen
 * `totalMinutes` (suurimman jakojäännöksen menetelmä, deterministinen).
 */
function apportion(weights, totalMinutes) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const exact = weights.map(w => (w / sum) * totalMinutes);
  const floors = exact.map(Math.floor);
  let rest = totalMinutes - floors.reduce((a, b) => a + b, 0);
  const order = exact.map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (const { index } of order) {
    if (rest <= 0) break;
    floors[index] += 1;
    rest -= 1;
  }
  return floors;
}

/**
 * Pysäytä ajastin: laske kirjaukset. EI kirjoita mitään.
 *
 * @param {object} timer
 * @param {number} nowMs
 * @param {object} [options]
 * @param {number} [options.overrideMinutes] käyttäjän korjaama kokonaiskesto
 * @param {object} [options.calendar] paikallinen kalenteri (testeissä vaihdettava)
 * @returns {{
 *   ok: boolean, entries: Array, totalMinutes: number, tooShort: boolean,
 *   needsReview: boolean, clockSkew: boolean, operationId: string
 * }}
 */
export function stopTimer(timer, nowMs, { overrideMinutes = null, calendar = LOCAL_CALENDAR } = {}) {
  const operationId = timer && timer.id ? OPERATION.timer(timer.id) : null;
  const empty = { ok: false, entries: [], totalMinutes: 0, tooShort: false, needsReview: false, clockSkew: false, operationId };
  if (!timer || !timer.startedAt || !timer.id) return empty;

  const status = timerStatus(timer, nowMs);
  const startMs = msOf(timer.startedAt);
  const wallEndMs = timer.pausedAt ? msOf(timer.pausedAt) : nowMs;

  let activeSeconds = status.elapsedSeconds;
  let spanEndMs = Math.max(startMs, wallEndMs);
  let pausedSeconds = timer.pausedSeconds;
  const override = Number.isInteger(overrideMinutes) && overrideMinutes >= 0 ? overrideMinutes : null;
  if (override !== null) {
    // Käyttäjän korjaama kesto: ajastus oletetaan yhtäjaksoiseksi alusta.
    activeSeconds = override * 60;
    spanEndMs = startMs + activeSeconds * 1000;
    pausedSeconds = 0;
  }

  const totalMinutes = Math.round(activeSeconds / 60);
  if (totalMinutes < TIMER_RULES.MIN_LOGGED_MINUTES) {
    return { ...empty, ok: true, tooShort: true, clockSkew: status.clockSkew };
  }

  // Päiväsegmentit paikallisen keskiyön kohdalta.
  const segments = [];
  let cursor = startMs;
  while (cursor < spanEndMs) {
    const boundary = Math.min(calendar.nextMidnight(cursor), spanEndMs);
    segments.push({ date: calendar.dateOf(cursor), fromMs: cursor, toMs: boundary });
    cursor = boundary;
  }
  if (segments.length === 0) segments.push({ date: calendar.dateOf(startMs), fromMs: startMs, toMs: startMs });

  const wallSeconds = Math.max(1, (spanEndMs - startMs) / 1000);
  const weights = segments.map(segment => {
    const seconds = (segment.toMs - segment.fromMs) / 1000;
    // Tauot jaetaan suhteessa päivän osuuteen kokonaisajasta.
    return Math.max(0, seconds - pausedSeconds * (seconds / wallSeconds));
  });
  const minutes = apportion(weights.every(w => w === 0) ? weights.map(() => 1) : weights, totalMinutes);

  // Kesäajan päättymispäivä on 25 h: yli 24 h päivä pilkotaan kahteen
  // kirjaukseen, koska yksi kirjaus on enintään MAX_ENTRY_MINUTES.
  const parts = [];
  segments.forEach((segment, index) => {
    let left = minutes[index];
    while (left > 0) {
      const chunk = Math.min(left, MAX_ENTRY_MINUTES);
      parts.push({ segment, minutes: chunk });
      left -= chunk;
    }
  });

  const entries = parts.map((part, index) => ({
    entryDate: part.segment.date,
    minutes: part.minutes,
    source: TIME_SOURCE.TIMER,
    operationId: index === 0 ? operationId : `${operationId}.${index}`,
    startedAt: new Date(part.segment.fromMs).toISOString(),
    endedAt: new Date(part.segment.toMs).toISOString(),
    lifeAreaId: timer.lifeAreaId,
    goalId: timer.goalId,
    taskId: timer.taskId,
    projectId: timer.projectId,
    routineId: timer.routineId,
    occurrenceDate: timer.routineId ? (timer.occurrenceDate || part.segment.date) : null,
    note: timer.note
  }));

  return {
    ok: true,
    entries,
    totalMinutes,
    tooShort: false,
    needsReview: override === null && totalMinutes > TIMER_RULES.REVIEW_AFTER_MINUTES,
    clockSkew: status.clockSkew,
    operationId
  };
}
