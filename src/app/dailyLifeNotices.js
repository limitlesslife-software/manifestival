// Arjen huomautukset ilmoituskeskukseen: illan ennakko, viikonlopun
// rytmi ja maanantaivalmius sekä myöhästelyn oppiminen.
//
// KAIKKI OVAT EHDOTUKSIA. Mikään tästä ei muuta unitavoitetta, herätystä
// eikä muistutusten aikaa. Käyttäjä hyväksyy muutoksen itse (Profiili →
// Arki / Paikat). Sanamuoto on rauhallinen, ei lääketieteellisiä väitteitä.
//
// EI TOISTOA. Jokaisella huomautuksella on avain, joka muuttuu vain kun
// asia muuttuu (huomisen päivä, viikko, ehdotettu minuuttimäärä). Sama
// avain ei synny kahdesti: tila, addNoticeToState ja kannan
// notices_key_unique estävät sen.
//
// YKSI VOIMASSA OLEVA NEUVO. Illan ennakolla on yksi avain huomista kohti
// (evening|<huominen>): kun huominen muuttuu, sama merkintä kertoo uuden
// neuvon, ja kun neuvoa ei enää ole, lukematon merkintä poistuu. Uusi
// myöhästelyehdotus korvaa lukemattoman vanhan. Muuten ristiriitaiset
// ohjeet ("3 h aiemmin" ja "2 h aiemmin") kasautuisivat rinnakkain.
// Luettu tai käsitelty merkintä jää historiaan.
//
// Lajit ovat olemassa olevia (0011:n notices_kind_check): illan ennakko on
// muistutus, rytmi- ja myöhästelyehdotukset ovat muutosehdotuksia.

import {
  getState, addNoticeToState, replaceNoticeInState, removeNoticeFromState, currentLifeSettings
} from './state.js';
import { noticesRepo } from '../data/collectionsRepo.js';
import { newTaskId } from '../lib/rows.js';
import {
  normalizeNotice, validateNotice, NOTICE_KIND, NOTICE_LEVEL, NOTICE_STATUS
} from '../domain/notificationCenter.js';
import { eveningBefore, driftReport, mondayReadiness } from '../domain/sleepRhythm.js';
import { latenessSuggestion } from '../domain/commuteLearning.js';
import { isoWeekday } from '../domain/wallClock.js';
import { deviceOffsetMinutes } from './deviceTime.js';
import { clockOf, shiftIso, sleepScheduleOn, sleepPlanOn } from './dailyLifeModel.js';
import { logEvent } from '../lib/logger.js';

/** Illan ennakko näytetään aikaisintaan tähän aikaan (minuutteja keskiyöstä). */
export const EVENING_NOTICE_FROM_MINUTES = 17 * 60;

function notice({ key, kind, level = NOTICE_LEVEL.INFO, title, reason, targetId, todayIso }) {
  return normalizeNotice({
    id: newTaskId(), key, kind, level, title, reason,
    targetType: targetId ? 'settings' : null, targetId: targetId || null, createdDate: todayIso
  });
}

/** Kiinteän herätyksen varoituksen jatko: mitä käyttäjä voi tehdä (hän päättää itse). */
export const FIXED_ALARM_HINT = 'Voit aikaistaa herätystä asetuksista (Profiili → Arki) tai valita aamulla, mitä jätät pois tai lyhennät.';

/**
 * Illan ennakon tilanne: huominen päivä ja sen merkintä (tai null, kun
 * huominen ei vaadi aiempaa herätystä eikä kiinteä herätys jää aamulle
 * liian myöhäiseksi). null koko tuloksena, kun ei vielä ole ilta: silloin
 * ei myöskään poisteta mitään.
 *
 * Huominen ja sen vertailukohta tulevat samasta laskennasta kuin laitteen
 * herätys ja iltamuistutukset (dailyLifeModel.sleepPlanOn). Kiinteällä
 * herätyksellä uni lasketaan kiinteästä ajasta, joten "iltarutiini 10 min
 * aiemmin" ei synny; jos aamu vaatisi kiinteää aiemman herätyksen, siitä
 * kerrotaan (alarmNote), ja napautus avaa herätyksen asetukset.
 */
function eveningAdvice({ state, now }) {
  const { todayIso, nowMinutes } = clockOf(now);
  if (nowMinutes < EVENING_NOTICE_FROM_MINUTES) return null;
  const tomorrow = shiftIso(todayIso, 1);
  const plan = sleepPlanOn(tomorrow, { state, now });
  const advice = eveningBefore({ tomorrowSchedule: plan.schedule, usualSchedule: plan.usual, cause: 'commitment' });
  const note = plan.alarmNote ? `${plan.alarmNote} ${FIXED_ALARM_HINT}` : null;
  let current = null;
  if (advice || note) {
    current = notice({
      // Vakaa avain huomista kohti: neuvon muuttuessa sama merkintä päivittyy.
      key: `evening|${tomorrow}`, kind: NOTICE_KIND.REMINDER,
      title: advice ? 'Huominen alkaa aiemmin' : 'Huomisen herätys on kiinteä',
      reason: [advice && advice.message, note].filter(Boolean).join(' '),
      targetId: note ? 'daily' : null,
      todayIso
    });
  }
  return { tomorrow, notice: current };
}

/** Illan ennakko: huominen vaatii aiemman herätyksen -> iltarutiini aiemmin. */
export function eveningBeforeNotice({ state = getState(), now = new Date() } = {}) {
  const current = eveningAdvice({ state, now });
  return current ? current.notice : null;
}

/** Viikonloppu: rytmin siirtymä ja maanantaivalmius (vain la–su). */
export function weekendRhythmNotices({ state = getState(), now = new Date() } = {}) {
  const { todayIso } = clockOf(now);
  const weekday = isoWeekday(todayIso);
  if (weekday !== 6 && weekday !== 7) return [];
  const settings = currentLifeSettings(state);
  const profile = state.profile || {};
  const out = [];

  const drift = driftReport({ logs: state.sleepLogs || [], profile, settings, todayIso, offsetMinutesFn: deviceOffsetMinutes });
  if (drift && drift.drifting && drift.message) {
    const saturday = weekday === 6 ? todayIso : shiftIso(todayIso, -1);
    out.push(notice({
      key: `rhythm|${saturday}`, kind: NOTICE_KIND.REPLAN, title: 'Viikonlopun rytmi',
      reason: drift.message, targetId: 'daily', todayIso
    }));
  }

  const monday = shiftIso(todayIso, weekday === 6 ? 2 : 1);
  const mondaySchedule = sleepScheduleOn(monday, { state, now });
  const recentWeekendWake = drift && drift.weekend && drift.weekend.meanWake ? drift.weekend.meanWake : null;
  if (mondaySchedule && recentWeekendWake) {
    const readiness = mondayReadiness({
      todayIso, mondayWake: mondaySchedule.wakeTime, recentWeekendWake, settings, profile,
      offsetMinutesFn: deviceOffsetMinutes
    });
    if (readiness && readiness.message) {
      out.push(notice({
        key: `monday|${monday}`, kind: NOTICE_KIND.REPLAN, title: 'Paluu arkirytmiin',
        reason: readiness.message, targetId: 'daily', todayIso
      }));
    }
  }
  return out;
}

/** Myöhästelyn oppiminen: ehdota lähtömuistutuksen aikaistusta (ei koskaan tee sitä itse). */
export function latenessNotice({ state = getState(), now = new Date() } = {}) {
  const { todayIso } = clockOf(now);
  const settings = currentLifeSettings(state);
  const suggestion = latenessSuggestion(state.commuteObservations || [], {
    currentOffsetMinutes: settings.reminderOffsetMinutes
  });
  if (!suggestion) return null;
  return notice({
    key: `lateness|${suggestion.suggestedOffsetMinutes}`, kind: NOTICE_KIND.REPLAN,
    title: 'Lähtömuistutus aiemmin?', reason: suggestion.message, targetId: 'places', todayIso
  });
}

/** Kuuluuko merkintä asiaan `base` (avain on base tai alkaa base|). */
function inScope(key, base) {
  return typeof key === 'string' && (key === base || key.startsWith(`${base}|`));
}

/**
 * Yksi voimassa oleva merkintä asiaa `base` kohti.
 *
 * - Lukematon merkintä, jota `current` ei enää vastaa (neuvo muuttui
 *   toiseksi avaimeksi tai katosi), poistuu: se ei enää pidä paikkaansa.
 * - Saman avaimen merkintä saa uuden perustelun, jos neuvo muuttui.
 * - Luettu tai käsitelty merkintä jää historiaan sellaisenaan.
 */
function reconcileCurrent(base, current, changes) {
  for (const existing of getState().notices) {
    if (!inScope(existing.key, base) || existing.status !== NOTICE_STATUS.UNREAD) continue;
    if (current && existing.key === current.key) continue;
    removeNoticeFromState(existing.id);
    changes.removed.push(existing.id);
  }
  if (!current || !validateNotice(current).valid) return;
  const same = getState().notices.find(existing => existing.key === current.key);
  if (!same) {
    if (addNoticeToState(current)) changes.created.push(current);
  } else if (same.reason !== current.reason || same.title !== current.title || same.targetId !== current.targetId) {
    // Otsikko ja kohde kulkevat neuvon mukana (illan ennakko: "alkaa
    // aiemmin" <-> kiinteän herätyksen varoitus asetuksiin).
    const updated = normalizeNotice({
      ...same, title: current.title, reason: current.reason, targetType: current.targetType, targetId: current.targetId
    });
    replaceNoticeInState(same.id, updated);
    changes.updated.push(updated);
  }
}

/**
 * Yksi kierros. Ei koskaan heitä: laskennan virhe ei estä sovelluksen käyttöä.
 * @returns {Promise<{created:number}>}
 */
export async function runDailyLifeNotices({ state = getState(), now = new Date() } = {}) {
  const changes = { created: [], updated: [], removed: [] };

  try {
    const evening = eveningAdvice({ state, now });
    if (evening) reconcileCurrent(`evening|${evening.tomorrow}`, evening.notice, changes);
  } catch {
    logEvent('daily_life.notice_failed', { code: 'evening' });
  }
  try {
    reconcileCurrent('lateness', latenessNotice({ state, now }), changes);
  } catch {
    logEvent('daily_life.notice_failed', { code: 'lateness' });
  }

  let rhythm = [];
  try {
    rhythm = weekendRhythmNotices({ state, now });
  } catch {
    logEvent('daily_life.notice_failed', { code: 'rhythm' });
  }
  for (const candidate of rhythm) {
    if (!validateNotice(candidate).valid) continue;
    if (!addNoticeToState(candidate)) continue;
    changes.created.push(candidate);
  }

  await Promise.all([
    ...changes.created.map(n => noticesRepo.insert(n).catch(() => null)),
    ...changes.updated.map(n => noticesRepo.update(n).catch(() => null)),
    ...changes.removed.map(id => noticesRepo.remove(id).catch(() => null))
  ]);
  return { created: changes.created.length };
}
