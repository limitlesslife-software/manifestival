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

import { getState } from './state.js';
import { saveCalendarEvent, confirmPlaceAlias } from './dailyLifeActions.js';
import { clockOf, shiftIso } from './dailyLifeModel.js';
import { deviceOffsetMinutes } from './deviceTime.js';
import { parseCreateEvent, EVENT_FIELD } from '../domain/eventParse.js';
import { parseInterruption, INTERRUPTION_KIND } from '../domain/interruptions.js';
import { REPLAN_CHANGE } from '../domain/dayReplan.js';
import { previewDayReplan, splitReplanChanges, applyReplanChanges } from './dayReplanActions.js';
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
//
// Esikatselu ja toteutus ovat src/app/dayReplanActions.js:ssä, samat kuin
// Tänään-näkymän keskeytyskortissa.

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
  return previewDayReplan(interruption, { state, now });
}

/**
 * Toteuta hyväksytyt muutokset. Jos yksikin tehtävän muutos epäonnistuu,
 * jo tehdyt perutaan: puolittain muutettu päivä on pahempi kuin muuttamaton.
 */
export async function applyInterruptionChanges(changes) {
  const { applicable } = splitReplanChanges(changes);
  const outcome = await applyReplanChanges(applicable);
  if (!outcome.ok) showError('Päivän muutosta ei voitu tallentaa. Muutokset peruttiin.');
  return outcome;
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
    // Valinta kulkee tunnisteena (sama kuin Tänään-kortin valintapainikkeissa):
    // nimellä kaksi samaan sanaan osuvaa kohdetta kysyisi saman kysymyksen uudelleen.
    interruption = { ...interruption, targetId: chosen.id };
    result = previewInterruption(interruption, { state: getState(), now });
  }

  const changes = splitReplanChanges(result.changes).applicable;
  if (changes.length === 0) {
    // Varoitukset (kiinteä kohde, johon keskeytys osuu) näkyvät myös, kun
    // muutettavaa ei ole: sama tieto kuin Tänään-kortin ehdotuksessa.
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    notify(result.question || [result.summary, ...warnings].join(' '));
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
