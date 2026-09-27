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
// Lajit ovat olemassa olevia (0011:n notices_kind_check): illan ennakko on
// muistutus, rytmi- ja myöhästelyehdotukset ovat muutosehdotuksia.

import { getState, addNoticeToState, currentLifeSettings } from './state.js';
import { noticesRepo } from '../data/collectionsRepo.js';
import { newTaskId } from '../lib/rows.js';
import { normalizeNotice, validateNotice, NOTICE_KIND, NOTICE_LEVEL } from '../domain/notificationCenter.js';
import { eveningBefore, driftReport, mondayReadiness, sleepScheduleFor } from '../domain/sleepRhythm.js';
import { latenessSuggestion } from '../domain/commuteLearning.js';
import { isoWeekday } from '../domain/wallClock.js';
import { deviceOffsetMinutes } from './deviceTime.js';
import { clockOf, shiftIso, sleepScheduleOn } from './dailyLifeModel.js';
import { logEvent } from '../lib/logger.js';

/** Illan ennakko näytetään aikaisintaan tähän aikaan (minuutteja keskiyöstä). */
export const EVENING_NOTICE_FROM_MINUTES = 17 * 60;

function notice({ key, kind, level = NOTICE_LEVEL.INFO, title, reason, targetId, todayIso }) {
  return normalizeNotice({
    id: newTaskId(), key, kind, level, title, reason,
    targetType: targetId ? 'settings' : null, targetId: targetId || null, createdDate: todayIso
  });
}

/** Illan ennakko: huominen vaatii aiemman herätyksen -> iltarutiini aiemmin. */
export function eveningBeforeNotice({ state = getState(), now = new Date() } = {}) {
  const { todayIso, nowMinutes } = clockOf(now);
  if (nowMinutes < EVENING_NOTICE_FROM_MINUTES) return null;
  const tomorrow = shiftIso(todayIso, 1);
  const settings = currentLifeSettings(state);
  const tomorrowSchedule = sleepScheduleOn(tomorrow, { state, now });
  const usualSchedule = sleepScheduleFor({
    dateIso: tomorrow, profile: state.profile || {}, settings, requiredWake: null, offsetMinutesFn: deviceOffsetMinutes
  });
  const advice = eveningBefore({ tomorrowSchedule, usualSchedule, settings, cause: 'commitment' });
  if (!advice) return null;
  return notice({
    key: `evening|${tomorrow}|${advice.windDownStart}`, kind: NOTICE_KIND.REMINDER,
    title: 'Huominen alkaa aiemmin', reason: advice.message, todayIso
  });
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

/**
 * Yksi kierros. Ei koskaan heitä: laskennan virhe ei estä sovelluksen käyttöä.
 * @returns {Promise<{created:number}>}
 */
export async function runDailyLifeNotices({ state = getState(), now = new Date() } = {}) {
  const candidates = [];
  for (const [code, build] of [['evening', eveningBeforeNotice], ['lateness', latenessNotice]]) {
    try {
      const n = build({ state, now });
      if (n) candidates.push(n);
    } catch {
      logEvent('daily_life.notice_failed', { code });
    }
  }
  try {
    candidates.push(...weekendRhythmNotices({ state, now }));
  } catch {
    logEvent('daily_life.notice_failed', { code: 'rhythm' });
  }

  const created = [];
  for (const candidate of candidates) {
    if (!validateNotice(candidate).valid) continue;
    if (!addNoticeToState(candidate)) continue;
    created.push(candidate);
  }
  await Promise.all(created.map(n => noticesRepo.insert(n).catch(() => null)));
  return { created: created.length };
}
