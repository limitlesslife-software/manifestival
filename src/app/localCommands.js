// Paikalliset komennot ennen tekoälyä: menon luonti ja päivän keskeytys.
//
// "Lisää parturi ensi tiistaille klo 16" ja "olen 10 min myöhässä" ovat
// lyhyitä, vakiintuneita lauseita. Ne tunnistetaan laitteella ilman
// kielimallia (src/domain/eventParse.js, src/domain/interruptions.js), joten
// ne toimivat myös huonolla yhteydellä ja ilman tekoälyä. Kaikki muu kulkee
// entiseen tapaan tekoälyn putken läpi (src/app/commandBar.js).
//
// SAMAT TURVATAKUUT KUIN TEKOÄLYN KOMENNOILLA
//   - EI HILJAISTA ARVAUSTA: epäselvästä päivästä, kellonajasta, kestosta
//     tai paikasta kysytään (valintadialogi), puuttuvasta kerrotaan
//   - AINA TARKISTUS: käyttäjä näkee ehdotuksen ja hyväksyy sen ennen
//     tallennusta (sama vahvistusdialogi kuin tekoälyn ehdotuksilla)
//   - TUHOAVA LAUSE EI KOSKAAN TULE TÄNNE: jäsentimet palauttavat null
//     poistolle ja perumiselle, ja se kulkee oman vahvistetun polkunsa
//   - Paikan uusi nimitys opitaan vasta, kun käyttäjä on hyväksynyt menon
//     sen paikan kanssa (confirmPlaceAlias)
//   - Päivän muutokset tehdään olemassa olevilla tehtävä- ja
//     rutiinitoiminnoilla; epäonnistuminen peruu jo tehdyt siirrot

import { getState, findTask } from './state.js';
import { saveCalendarEvent, confirmPlaceAlias } from './dailyLifeActions.js';
import { editTask, skipRoutineOccurrence } from './actions.js';
import { calendarDayPlan } from './calendarPlan.js';
import { clockOf, shiftIso } from './dailyLifeModel.js';
import { deviceOffsetMinutes } from './deviceTime.js';
import { parseCreateEvent, EVENT_FIELD } from '../domain/eventParse.js';
import { parseInterruption, INTERRUPTION_KIND } from '../domain/interruptions.js';
import { replanDay, REPLAN_CHANGE } from '../domain/dayReplan.js';
import { resolvePlaceText, foldPlaceText } from '../domain/places.js';
import { shortDateLabel } from '../domain/calendar.js';
import { clockText, durationText } from '../domain/wallClock.js';
import { isTimeOfDay, toMinutes, fromMinutes } from '../domain/task.js';
import { notify, success, showError } from '../ui/toast.js';
import { logEvent } from '../lib/logger.js';

const NO_PHASE = () => {};

/** Myöhästymisen ja venymisen määrä, kun lause ei kertonut sitä. */
export const LATE_MINUTE_CHOICES = Object.freeze([5, 10, 15, 30, 60]);

function dayLabel(iso, todayIso) {
  if (iso === todayIso) return `Tänään (${shortDateLabel(iso)})`;
  if (iso === shiftIso(todayIso, 1)) return `Huomenna (${shortDateLabel(iso)})`;
  return shortDateLabel(iso);
}

function timeLabel(time) {
  return `klo ${clockText(time)}`;
}

function endFrom(time, minutes) {
  if (!isTimeOfDay(time) || !Number.isInteger(minutes) || minutes <= 0) return null;
  return fromMinutes((toMinutes(time) + minutes) % 1440);
}

function placeName(state, id) {
  const place = (state.savedPlaces || []).find(item => item.id === id);
  return place ? place.name : null;
}

// =====================================================================
// MENON LUONTI
// =====================================================================

/** Kysy yksi tarkennus. null = käyttäjä perui. */
async function ask(ui, candidates, question) {
  ui.phase('target_selection');
  const chosen = await ui.chooseFn(candidates, question);
  return chosen && chosen.id !== undefined ? chosen : null;
}

async function clarify(parsed, ui, { state, todayIso }) {
  const draft = {
    title: parsed.title,
    date: parsed.date,
    time: parsed.time,
    endTime: parsed.endTime,
    durationMinutes: parsed.durationMinutes,
    allDay: parsed.allDay === true,
    placeId: parsed.placeId,
    placeText: parsed.placeText,
    placeChosen: false
  };

  for (const ambiguity of parsed.ambiguities) {
    if (!Array.isArray(ambiguity.options) || ambiguity.options.length === 0) {
      return { needsInput: ambiguity.question };
    }
    let candidates;
    switch (ambiguity.field) {
      case EVENT_FIELD.DATE:
        candidates = ambiguity.options.map(iso => ({ id: iso, label: dayLabel(iso, todayIso) }));
        break;
      case EVENT_FIELD.TIME:
        candidates = ambiguity.options.map(time => ({ id: time, label: timeLabel(time) }));
        break;
      case EVENT_FIELD.DURATION:
        candidates = ambiguity.options.map(minutes => ({ id: String(minutes), label: durationText(minutes), minutes }));
        break;
      case EVENT_FIELD.PLACE:
        candidates = ambiguity.options.map(id => ({ id, label: placeName(state, id) || 'Tallennettu paikka' }));
        break;
      default:
        return { needsInput: ambiguity.question };
    }
    const chosen = await ask(ui, candidates, ambiguity.question);
    if (!chosen) return { cancelled: true };
    if (ambiguity.field === EVENT_FIELD.DATE) draft.date = chosen.id;
    else if (ambiguity.field === EVENT_FIELD.TIME) draft.time = chosen.id;
    else if (ambiguity.field === EVENT_FIELD.DURATION) draft.durationMinutes = chosen.minutes;
    else if (ambiguity.field === EVENT_FIELD.PLACE) {
      draft.placeId = chosen.id;
      draft.placeChosen = true;
    }
  }

  if (!draft.date) {
    const tomorrow = shiftIso(todayIso, 1);
    const chosen = await ask(ui, [
      { id: todayIso, label: dayLabel(todayIso, todayIso) },
      { id: tomorrow, label: dayLabel(tomorrow, todayIso) }
    ], 'Minä päivänä meno on? Jos jokin muu päivä, kerro se lauseessa uudelleen.');
    if (!chosen) return { cancelled: true };
    draft.date = chosen.id;
  }
  if (!draft.time && !draft.allDay) {
    const chosen = await ask(ui, [{ id: 'allDay', label: 'Koko päivän meno' }],
      'Mihin aikaan meno alkaa? Jos sillä on kellonaika, kerro se lauseessa uudelleen.');
    if (!chosen) return { needsInput: 'Kerro menon kellonaika, esimerkiksi "klo 16".' };
    draft.allDay = true;
  }
  if (draft.allDay) {
    draft.time = null;
    draft.endTime = null;
  } else if (!draft.endTime && Number.isInteger(draft.durationMinutes)) {
    draft.endTime = endFrom(draft.time, draft.durationMinutes);
  }
  return { draft };
}

function eventPreview(draft, state, todayIso) {
  const place = draft.placeId ? placeName(state, draft.placeId) : null;
  const when = draft.allDay
    ? `${dayLabel(draft.date, todayIso)}, koko päivä`
    : `${dayLabel(draft.date, todayIso)} ${timeLabel(draft.time)}${draft.endTime ? `–${clockText(draft.endTime)}` : ''}`;
  const changes = [
    { label: 'Meno', before: '—', after: draft.title },
    { label: 'Aika', before: '—', after: when }
  ];
  if (place) changes.push({ label: 'Paikka', before: '—', after: place });
  else if (draft.placeText) changes.push({ label: 'Paikka', before: '—', after: `${draft.placeText} (ei tallennettu paikka)` });
  return {
    local: true,
    kind: 'create_event',
    requiresConfirmation: true,
    preview: {
      targetTypeLabel: 'Kalenteri',
      action: 'Lisätäänkö meno kalenteriin?',
      targetLabel: draft.title,
      description: 'Tarkista meno ennen tallennusta.',
      changes,
      destructive: false
    }
  };
}

async function runLocalEvent(parsed, ui, { state, todayIso }) {
  if (!parsed.title) {
    notify('Kerro myös, mikä meno on, esimerkiksi "Lisää parturi huomenna klo 16".');
    return { ok: false, status: 'needs_input', local: true, kind: 'create_event' };
  }
  const clarified = await clarify(parsed, ui, { state, todayIso });
  if (clarified.cancelled) return { ok: false, status: 'cancelled', reason: 'Peruttu.', local: true, kind: 'create_event' };
  if (clarified.needsInput) {
    notify(clarified.needsInput);
    return { ok: false, status: 'needs_input', reason: clarified.needsInput, local: true, kind: 'create_event' };
  }
  const draft = clarified.draft;

  ui.phase('confirmation');
  const accepted = await ui.confirmFn(eventPreview(draft, state, todayIso));
  if (!accepted) return { ok: false, status: 'cancelled', reason: 'Peruttu.', local: true, kind: 'create_event' };

  ui.phase('executing');
  const saved = await saveCalendarEvent({
    title: draft.title,
    date: draft.date,
    startTime: draft.allDay ? null : draft.time,
    endTime: draft.allDay ? null : draft.endTime,
    durationMinutes: draft.allDay ? null : draft.durationMinutes,
    allDay: draft.allDay,
    placeId: draft.placeId || null,
    locationText: draft.placeId ? null : (draft.placeText || null)
  });
  logEvent('command.local', { kind: 'create_event', ok: Boolean(saved.ok) });
  if (!saved.ok) {
    if (saved.errors) showError(Object.values(saved.errors)[0] || 'Menoa ei voitu tallentaa.');
    return { ok: false, status: 'error', reason: 'Menoa ei voitu tallentaa.', local: true, kind: 'create_event' };
  }

  // Uusi nimitys paikalle opitaan vasta hyväksynnän jälkeen: käyttäjä
  // valitsi paikan epäselvälle sanalle, tai jo opittu nimitys vahvistui.
  // Paikan oma nimi (tai sen taivutus) ei ole uusi nimitys.
  const status = parsed.placeMatch ? parsed.placeMatch.status : null;
  if (draft.placeId && draft.placeText && (draft.placeChosen || status === 'learned')) {
    const name = placeName(getState(), draft.placeId);
    if (!name || foldPlaceText(name) !== foldPlaceText(draft.placeText)) {
      await confirmPlaceAlias(draft.placeText, draft.placeId);
    }
  }
  success(saved.queued ? 'Meno tallennettiin laitteelle ja lähetetään, kun yhteys palaa.' : 'Meno lisätty kalenteriin.');
  return { ok: true, status: 'executed', local: true, kind: 'create_event', event: saved.event };
}

// =====================================================================
// PÄIVÄN KESKEYTYS
// =====================================================================

/** Muutos, joka tehdään olemassa olevilla toiminnoilla; muut ovat vain tietoa. */
function applicable(change) {
  if (change.taskId) {
    const task = findTask(change.taskId);
    if (!task) return false;
    // Aikatauluttamaton tehtävä sijoittuu päivään itsestään: kellonaikaa ei kirjoiteta.
    if (change.kind === REPLAN_CHANGE.SHIFT && !task.time) return false;
    return true;
  }
  return change.kind === REPLAN_CHANGE.SKIP && Boolean(change.routineId);
}

function taskEditFor(change, task) {
  switch (change.kind) {
    case REPLAN_CHANGE.SHIFT:
      return {
        date: change.to.date, time: change.to.time,
        endTime: task.endTime ? change.to.endTime : task.endTime,
        // Siirto ei tee joustavasta tehtävästä kiinteää.
        schedulingState: task.schedulingState
      };
    case REPLAN_CHANGE.EXTEND: {
      if (task.endTime) return { endTime: change.to.endTime };
      const from = toMinutes(change.to.time);
      const to = toMinutes(change.to.endTime);
      const minutes = from !== null && to !== null ? ((to - from + 1440) % 1440) || null : null;
      return minutes ? { durationMinutes: minutes } : null;
    }
    case REPLAN_CHANGE.SKIP:
      return { time: null };
    case REPLAN_CHANGE.DEFER:
      return { date: change.to.date, time: null };
    default:
      return null;
  }
}

function changeRow(change) {
  const from = change.from && change.from.time ? clockText(change.from.time) : '—';
  let to;
  if (change.kind === REPLAN_CHANGE.SKIP) to = 'jää väliin';
  else if (change.kind === REPLAN_CHANGE.DEFER) to = shortDateLabel(change.to.date);
  else to = change.to && change.to.time ? `${clockText(change.to.time)}${change.to.endTime ? `–${clockText(change.to.endTime)}` : ''}` : '—';
  return { label: change.title || 'Kohde', before: from, after: to };
}

/** Päivän muutosehdotus keskeytyksestä (ei muuta mitään). */
export function previewInterruption(interruption, { state = getState(), now = new Date() } = {}) {
  const { todayIso, nowMinutes } = clockOf(now);
  const { plan, inputs } = calendarDayPlan(state, todayIso, { todayIso, nowMinutes, offsetMinutesFn: deviceOffsetMinutes });
  return replanDay({
    plan, interruption, nowMinutes, todayIso,
    tasks: state.tasks || [], events: inputs.occurrences, blocks: inputs.blocks,
    offsetMinutesFn: deviceOffsetMinutes
  });
}

/**
 * Toteuta hyväksytyt muutokset. Jos yksikin tehtävän muutos epäonnistuu,
 * jo tehdyt perutaan: puolittain muutettu päivä on pahempi kuin muuttamaton.
 */
export async function applyInterruptionChanges(changes) {
  const undo = [];
  let applied = 0;
  for (const change of changes) {
    if (change.taskId) {
      const task = findTask(change.taskId);
      const edit = task ? taskEditFor(change, task) : null;
      if (!edit) continue;
      const previous = { date: task.date, time: task.time, endTime: task.endTime,
        durationMinutes: task.durationMinutes, schedulingState: task.schedulingState };
      const result = await editTask(change.taskId, edit);
      if (!result || !result.ok) {
        for (const entry of undo) await editTask(entry.taskId, entry.previous);
        showError('Päivän muutosta ei voitu tallentaa. Muutokset peruttiin.');
        return { ok: false, applied: 0 };
      }
      undo.unshift({ taskId: change.taskId, previous });
      applied += 1;
    } else if (change.kind === REPLAN_CHANGE.SKIP && change.routineId) {
      const done = await skipRoutineOccurrence(change.routineId, change.from.date);
      if (done) applied += 1;
    }
  }
  return { ok: true, applied };
}

async function runLocalInterruption(parsed, ui, { state, now }) {
  let interruption = { ...parsed };
  const needsMinutes = interruption.kind === INTERRUPTION_KIND.RUNNING_LATE
    || interruption.kind === INTERRUPTION_KIND.EXTEND_CURRENT;
  if (needsMinutes && !Number.isInteger(interruption.minutes)) {
    const chosen = await ask(ui, LATE_MINUTE_CHOICES.map(minutes => ({ id: String(minutes), label: durationText(minutes), minutes })),
      interruption.kind === INTERRUPTION_KIND.RUNNING_LATE ? 'Kuinka paljon olet myöhässä?' : 'Kuinka paljon lisää aikaa tarvitset?');
    if (!chosen) return { ok: false, status: 'cancelled', reason: 'Peruttu.', local: true, kind: 'interruption' };
    interruption = { ...interruption, minutes: chosen.minutes };
  }

  let result = previewInterruption(interruption, { state, now });
  if (result.question && result.candidates.length > 0) {
    const chosen = await ask(ui, result.candidates.map(item => ({ id: item.id, label: item.title })), result.question);
    if (!chosen) return { ok: false, status: 'cancelled', reason: 'Peruttu.', local: true, kind: 'interruption' };
    interruption = { ...interruption, targetText: chosen.label };
    result = previewInterruption(interruption, { state: getState(), now });
  }

  const changes = result.changes.filter(applicable);
  if (changes.length === 0) {
    notify(result.question || result.summary);
    return { ok: true, status: 'no_change', reason: result.summary, local: true, kind: 'interruption' };
  }

  ui.phase('confirmation');
  const accepted = await ui.confirmFn({
    local: true,
    kind: 'interruption',
    requiresConfirmation: true,
    preview: {
      targetTypeLabel: 'Päivän suunnitelma',
      action: 'Muutetaanko päivää näin?',
      targetLabel: result.summary,
      description: result.summary,
      changes: changes.map(changeRow),
      destructive: false
    }
  });
  if (!accepted) return { ok: false, status: 'cancelled', reason: 'Peruttu.', local: true, kind: 'interruption' };

  ui.phase('executing');
  const applied = await applyInterruptionChanges(changes);
  logEvent('command.local', { kind: 'interruption', ok: applied.ok, count: applied.applied });
  if (!applied.ok) return { ok: false, status: 'error', reason: 'Muutosta ei voitu tallentaa.', local: true, kind: 'interruption' };
  success(applied.applied === 1 ? 'Päivän suunnitelma päivitetty (1 muutos).' : `Päivän suunnitelma päivitetty (${applied.applied} muutosta).`);
  return { ok: true, status: 'executed', local: true, kind: 'interruption', applied: applied.applied };
}

// =====================================================================
// SISÄÄNKÄYNTI
// =====================================================================

/**
 * Tunnista ja suorita paikallinen komento. null = ei paikallinen komento
 * (kutsuja jatkaa tekoälyn putkeen). Ei koskaan heitä.
 *
 * @param {string} text
 * @param {object} ui { confirmFn, chooseFn, phase }
 * @param {{now?:Date, state?:object}} [options]
 */
export async function runLocalCommand(text, ui, { now = new Date(), state = getState() } = {}) {
  const { todayIso } = clockOf(now);
  const context = { state, todayIso, now };
  const handlers = { ...ui, phase: ui && typeof ui.phase === 'function' ? ui.phase : NO_PHASE };
  let event = null;
  let interruption = null;
  try {
    event = parseCreateEvent(text, {
      todayIso, places: state.savedPlaces || [], aliases: state.placeAliases || [],
      resolvePlace: resolvePlaceText, offsetMinutesFn: deviceOffsetMinutes
    });
    if (!event) interruption = parseInterruption(text, { todayIso });
  } catch {
    return null;
  }
  if (event) return runLocalEvent(event, handlers, context);
  if (interruption) return runLocalInterruption(interruption, handlers, context);
  return null;
}
