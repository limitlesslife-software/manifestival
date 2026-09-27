// Kalenterin menojen lähtöjen seuranta sovelluksen ollessa auki.
//
// Sama periaate kuin matkasuunnitelmien lähtökierroksella
// (assistantActions.runDepartureSweep): lähtö-, lähde nyt- ja myöhässä-
// vaiheesta tehdään ilmoituskeskukseen yksi merkintä per vaihe, ja
// kolminkertainen kaksoiskappaleiden esto (avain tilassa, addNoticeToState,
// kannan notices_key_unique) tekee kierroksesta turvallisen ajaa usein.
//
// UUDELLEENLASKENTA ILMAN MYRSKYÄ. Lähtöaika voi muuttua (liikennetieto,
// muokattu meno). Muutos nostetaan esiin vain, kun lähtöpalvelu sen
// aiheutti ja muutos ylittää rajan (departure.recalcDecision: aikaisemmaksi
// vähintään 5 min, myöhemmäksi 10 min). Viimeksi kerrottu lähtö pidetään
// muistissa esiintymää kohti — ei levyllä: seuraava avaus laskee alusta.
//
// TAUSTALLA (sovellus suljettu) lähtömuistutukset tulevat natiivista
// herätys-/puheliitännäisestä, ei tästä kierroksesta.

import { getState, addNoticeToState } from './state.js';
import { noticesRepo } from '../data/collectionsRepo.js';
import { newTaskId } from '../lib/rows.js';
import { normalizeNotice, validateNotice, NOTICE_KIND, NOTICE_LEVEL } from '../domain/notificationCenter.js';
import { recalcDecision, DEPARTURE_PHASE } from '../domain/departure.js';
import { departuresOn, clockOf } from './dailyLifeModel.js';
import { logEvent } from '../lib/logger.js';

/** Viimeksi kerrottu lähtö esiintymää kohti: { leave, source }. Vain muistissa. */
const lastAnnounced = new Map();

/** Myöhässä-merkintää ei enää tehdä, kun menon alusta on kulunut näin kauan. */
export const LATE_NOTICE_MAX_MINUTES = 30;

/** Uloskirjautuminen ja käyttäjän vaihto: edellisen käyttäjän lähdöt pois. */
export function resetDepartureWatch() {
  lastAnnounced.clear();
}

const DUE_PHASES = new Set([DEPARTURE_PHASE.LEAVE_IN_5, DEPARTURE_PHASE.LEAVE_NOW, DEPARTURE_PHASE.LATE]);

function dueNotice({ occurrence, departure }, todayIso) {
  const late = departure.phase === DEPARTURE_PHASE.LATE;
  return normalizeNotice({
    id: newTaskId(),
    key: `departure|${occurrence.id}|${todayIso}|${late ? 'late' : 'due'}`,
    kind: NOTICE_KIND.LEAVE_NOW,
    level: late ? NOTICE_LEVEL.URGENT : NOTICE_LEVEL.WARNING,
    title: occurrence.title || 'Lähtöaika',
    reason: departure.explanation,
    targetType: 'calendar_event',
    targetId: occurrence.eventId,
    createdDate: todayIso
  });
}

function changeNotice({ occurrence }, decision, todayIso) {
  return normalizeNotice({
    id: newTaskId(),
    key: `departure-change|${occurrence.id}|${decision.leave.time}`,
    kind: NOTICE_KIND.LEAVE_NOW,
    level: decision.direction === 'earlier' ? NOTICE_LEVEL.WARNING : NOTICE_LEVEL.INFO,
    title: occurrence.title || 'Lähtöaika muuttui',
    reason: decision.message,
    targetType: 'calendar_event',
    targetId: occurrence.eventId,
    createdDate: todayIso
  });
}

/**
 * Yksi kierros: tämän päivän menojen lähtövaiheet ja merkittävät muutokset.
 * Ei koskaan heitä; tallennusvirhe ei estä sovelluksen käyttöä.
 *
 * @returns {Promise<{created:number}>}
 */
export async function runEventDepartureSweep({ now = new Date(), state = getState(), providerResults = null } = {}) {
  const { todayIso } = clockOf(now);
  const created = [];
  let departures = [];
  try {
    departures = departuresOn(todayIso, { state, now, providerResults });
  } catch (error) {
    logEvent('departure.watch_failed', { code: 'compute' });
    return { created: 0 };
  }

  for (const item of departures) {
    const { occurrence, departure } = item;
    if (!departure || !departure.known) continue;

    // 1. Muutos edelliseen kerrottuun lähtöön (hystereesi).
    const previous = lastAnnounced.get(occurrence.id);
    const next = { ...departure.leave, source: departure.source };
    if (!previous) {
      lastAnnounced.set(occurrence.id, next);
    } else {
      const decision = recalcDecision({ previousLeave: previous, nextLeave: next, source: departure.source });
      if (decision.changed) lastAnnounced.set(occurrence.id, next);
      if (decision.surface && decision.leave) {
        const notice = changeNotice(item, decision, todayIso);
        if (validateNotice(notice).valid && addNoticeToState(notice)) {
          created.push(notice);
          logEvent('departure.changed', { direction: decision.direction });
        }
      }
    }

    // 2. Lähtövaihe: 5 min, nyt, myöhässä (ei enää puolen tunnin jälkeen).
    if (!DUE_PHASES.has(departure.phase)) continue;
    if (departure.phase === DEPARTURE_PHASE.LATE && departure.minutesLate !== null
      && departure.minutesLate > LATE_NOTICE_MAX_MINUTES + (departure.parts.early || 0)) continue;
    const notice = dueNotice(item, todayIso);
    if (!validateNotice(notice).valid) continue;
    if (!addNoticeToState(notice)) continue;
    created.push(notice);
    logEvent('departure.notice', { state: departure.phase });
  }

  await Promise.all(created.map(notice => noticesRepo.insert(notice).catch(() => null)));
  return { created: created.length };
}
