// Arjen käyttöjärjestelmän tallennustoiminnot (migraatio 0014, aalto K).
//
// SAMA KAAVA KUIN src/app/actions.js:SSÄ: normalisoi -> tarkista -> tila
// heti -> kanta -> epäonnistuessa tila takaisin ja ymmärrettävä virhe.
// Näkymä ei koskaan jää valehtelemaan onnistumisesta.
//
// ISTUNTO VOI VAIHTUA ODOTUKSEN AIKANA. Jokainen toiminto ottaa istunnon
// tilannekuvan ennen kannan kutsua. Jos käyttäjä kirjautui ulos (tai
// vaihtoi tiliä) kesken, vastausta ei enää sovelleta tilaan eikä
// peruutusta tehdä: uloskirjautuminen on jo tyhjentänyt tilan, ja
// peruutus kirjoittaisi edellisen käyttäjän rivin seuraavan tilaan.
//
// TEKOÄLY EI KUTSU NÄITÄ ILMAN KÄYTTÄJÄN HYVÄKSYNTÄÄ. Poistot ja
// oppimisen nollaus kysyvät aina vahvistuksen. Offline-jonotusta ei tehdä
// tässä moduulissa: epäonnistunut tallennus perutaan näkyvästi.

import {
  savedPlacesRepo, placeAliasesRepo, calendarEventsRepo, commuteObservationsRepo, lifeSettingsRepo,
  sleepLogsRepo, habitPlansRepo, habitEventsRepo, exerciseSessionsRepo, wellbeingCheckinsRepo
} from '../data/collectionsRepo.js';
import { sessionSnapshot, isSameSession } from '../data/session.js';
import { newTaskId } from '../lib/rows.js';
import {
  getState, findGoal,
  addSavedPlaceToState, replaceSavedPlaceInState, removeSavedPlaceFromState, restoreSavedPlaceInState,
  findSavedPlace, upsertPlaceAliasInState, removePlaceAliasFromState, findPlaceAlias,
  addCalendarEventToState, replaceCalendarEventInState, removeCalendarEventFromState, findCalendarEvent,
  addCommuteObservationToState, removeCommuteObservationFromState,
  upsertLifeSettingsInState, setLifeSettings,
  upsertSleepLogInState, removeSleepLogFromState,
  addHabitPlanToState, replaceHabitPlanInState, removeHabitPlanFromState, restoreHabitPlanInState,
  findHabitPlan, addHabitEventToState, removeHabitEventFromState,
  addExerciseSessionToState, replaceExerciseSessionInState, removeExerciseSessionFromState,
  findExerciseSession, upsertWellbeingCheckinInState, removeWellbeingCheckinFromState
} from './state.js';
import { normalizeSavedPlace, validateSavedPlace, normalizePlaceAlias, validatePlaceAlias, normalizeAliasText }
  from '../domain/savedPlace.js';
import { normalizeCalendarEvent, validateCalendarEvent, withSkipDate } from '../domain/calendarEvent.js';
import { normalizeCommuteObservation, validateCommuteObservation } from '../domain/commuteObservation.js';
import { mergeLifeSettings, validateLifeSettings } from '../domain/lifeSettings.js';
import { normalizeSleepLog, validateSleepLog } from '../domain/sleepLog.js';
import { normalizeHabitPlan, validateHabitPlan, normalizeHabitEvent, validateHabitEvent } from '../domain/habit.js';
import { normalizeExerciseSession, validateExerciseSession } from '../domain/exerciseSession.js';
import { normalizeWellbeingCheckin, validateWellbeingCheckin } from '../domain/wellbeingCheckin.js';
import { MAX_OBSERVATIONS_PER_PLACE } from '../domain/dailyLife.js';
import { showError, notify } from '../ui/toast.js';
import { confirmAction } from '../ui/confirm.js';

/** Kerran istunnossa ja taulua kohti: "säilyy vain tämän istunnon ajan". */
const volatileWarningsShown = new Set();

function warnIfVolatile(repo, label) {
  if (!repo || repo.isPersistent() || volatileWarningsShown.has(repo.table)) return;
  volatileWarningsShown.add(repo.table);
  notify(`${label} säilyvät toistaiseksi vain tämän istunnon ajan.`, 7000);
}

/** Uloskirjautuminen: varoitukset näytetään seuraavalle käyttäjälle uudelleen. */
export function resetDailyLifeActions() {
  volatileWarningsShown.clear();
}

const DISCARDED = Object.freeze({ ok: false, discarded: true });

/**
 * Kirjoita kantaan ja peru epäonnistuessa. `undo` ajetaan vain, jos
 * istunto on yhä sama; muuten tila on jo tyhjennetty eikä sitä kosketa.
 */
async function persist(write, undo, startedIn) {
  const result = await write();
  if (!isSameSession(startedIn)) return DISCARDED;
  if (!result || !result.ok) {
    undo();
    showError(result && result.error);
    return { ok: false, error: result && result.error };
  }
  return { ok: true, value: result.value };
}

// ------------------------------------------------------------ menot

/**
 * Luo tai päivitä meno. Olemassa oleva tunniste -> päivitys, muuten uusi.
 * @returns {Promise<{ok:boolean, event?:object, errors?:object}>}
 */
export async function saveCalendarEvent(input = {}) {
  const previous = input && input.id ? findCalendarEvent(input.id) : null;
  const event = normalizeCalendarEvent({
    ...(previous || {}), ...input, id: previous ? previous.id : newTaskId()
  });
  // Poistettuun paikkaan tai tavoitteeseen ei liitetä: kannan yhdistelmä-
  // vierasavain kaataisi tallennuksen (23503).
  const safe = withOwnLinks(event, previous, { place: true });
  const { valid, errors } = validateCalendarEvent(safe);
  if (!valid) return { ok: false, errors };

  const startedIn = sessionSnapshot();
  if (previous) replaceCalendarEventInState(safe.id, safe);
  else addCalendarEventToState(safe);
  warnIfVolatile(calendarEventsRepo, 'Menot');

  const result = await persist(
    () => (previous ? calendarEventsRepo.update(safe) : calendarEventsRepo.insert(safe)),
    () => (previous ? replaceCalendarEventInState(safe.id, previous) : removeCalendarEventFromState(safe.id)),
    startedIn);
  return result.ok ? { ok: true, event: safe } : result;
}

/**
 * Liitos vain käyttäjän omaan, tunnettuun riviin.
 *
 * Kannan vierasavaimet ovat yhdistelmiä (user_id, place_id / goal_id):
 * tuntematon tai jo poistettu kohde kaataisi tallennuksen koodilla 23503.
 * Liitos pudotetaan siksi ENNEN kirjoitusta, kun kohdetta ei ole tilassa.
 *
 * POIKKEUS: ennallaan pysyvä liitos säilyy, jos kohteiden viimeisin lataus
 * ei onnistunut. Tyhjä lista ei silloin tarkoita, ettei kohdetta ole, eikä
 * otsikon muutos saa katkaista kannassa olevaa liitosta (lähtö ja
 * muistutukset katoaisivat pysyvästi). Sama periaate kuin tehtävillä
 * (src/app/actions.js withOwnLinks). Kun lataus onnistui ja kohde puuttuu,
 * se on oikeasti poistettu (esim. toisella laitteella), ja liitos pudotetaan.
 */
function ownLink(value, previousValue, find, domain) {
  if (value == null || value === '') return null;
  if (find(value)) return value;
  const status = getState().dataLoadStatus[domain];
  const loaded = Boolean(status && status.ok === true);
  return value === previousValue && !loaded ? value : null;
}

/** Menon paikka ja tavoite, liikuntakerran tavoite: ks. ownLink. */
function withOwnLinks(entity, previous, { place = false } = {}) {
  const goalId = ownLink(entity.goalId, previous && previous.goalId, findGoal, 'goals');
  const placeId = place
    ? ownLink(entity.placeId, previous && previous.placeId, findSavedPlace, 'savedPlaces')
    : entity.placeId;
  if (goalId === entity.goalId && placeId === entity.placeId) return entity;
  return place ? { ...entity, goalId, placeId } : { ...entity, goalId };
}

/** Poista meno (koko sarja). Kysyy vahvistuksen. */
export async function deleteCalendarEvent(id, { confirm = confirmAction } = {}) {
  const previous = findCalendarEvent(id);
  if (!previous) return { ok: false };
  const recurring = Array.isArray(previous.recurrenceWeekdays) && previous.recurrenceWeekdays.length > 0;
  const confirmed = await confirm({
    title: 'Poistetaanko meno?',
    message: recurring
      ? `"${previous.title}" toistuu. Poisto poistaa kaikki sen kerrat. Yksittäisen kerran voi ohittaa.`
      : `"${previous.title}" poistetaan kalenterista.`,
    confirmLabel: 'Poista', destructive: true
  });
  if (!confirmed) return { ok: false, cancelled: true };

  const startedIn = sessionSnapshot();
  removeCalendarEventFromState(id);
  return persist(() => calendarEventsRepo.remove(id), () => addCalendarEventToState(previous), startedIn);
}

/** Ohita toistuvan menon yksi kerta (idempotentti). */
export async function skipEventOccurrence(eventId, dateIso) {
  const previous = findCalendarEvent(eventId);
  if (!previous) return { ok: false };
  const next = normalizeCalendarEvent(withSkipDate(previous, dateIso));
  if (JSON.stringify(next.skipDates) === JSON.stringify(previous.skipDates)) return { ok: true, event: previous };
  const { valid, errors } = validateCalendarEvent(next);
  if (!valid) return { ok: false, errors };

  const startedIn = sessionSnapshot();
  replaceCalendarEventInState(eventId, next);
  const result = await persist(() => calendarEventsRepo.update(next),
    () => replaceCalendarEventInState(eventId, previous), startedIn);
  return result.ok ? { ok: true, event: next } : result;
}

// ------------------------------------------------------------ paikat

/** Luo tai päivitä tallennettu paikka. Nimi on uniikki käyttäjää kohti. */
export async function savePlace(input = {}) {
  const previous = input && input.id ? findSavedPlace(input.id) : null;
  const place = normalizeSavedPlace({ ...(previous || {}), ...input, id: previous ? previous.id : newTaskId() });
  const existing = getState().savedPlaces.filter(p => p.id !== place.id);
  const { valid, errors } = validateSavedPlace(place, { existing });
  if (!valid) return { ok: false, errors };

  const startedIn = sessionSnapshot();
  if (previous) replaceSavedPlaceInState(place.id, place);
  else addSavedPlaceToState(place);
  warnIfVolatile(savedPlacesRepo, 'Paikat');

  const result = await persist(
    () => (previous ? savedPlacesRepo.update(place) : savedPlacesRepo.insert(place)),
    () => (previous ? replaceSavedPlaceInState(place.id, previous) : removeSavedPlaceFromState(place.id)),
    startedIn);
  return result.ok ? { ok: true, place } : result;
}

/**
 * Poista paikka. Kanta poistaa sen lisänimet ja matkahavainnot (cascade) ja
 * irrottaa menot paikasta (set null); tila tekee saman ja palauttaa kaiken
 * epäonnistuessa.
 */
export async function deletePlace(id, { confirm = confirmAction } = {}) {
  const place = findSavedPlace(id);
  if (!place) return { ok: false };
  const confirmed = await confirm({
    title: 'Poistetaanko paikka?',
    message: `"${place.name}" poistetaan. Sen opitut nimitykset ja matkahavainnot poistuvat. Menot säilyvät ilman paikkaa.`,
    confirmLabel: 'Poista', destructive: true
  });
  if (!confirmed) return { ok: false, cancelled: true };

  const startedIn = sessionSnapshot();
  const removed = removeSavedPlaceFromState(id);
  return persist(() => savedPlacesRepo.remove(id), () => restoreSavedPlaceInState(removed), startedIn);
}

/**
 * Käyttäjä vahvisti, että `aliasText` tarkoittaa paikkaa `placeId`.
 * Sama pari kasvattaa vahvistusten määrää; uutta riviä ei synny.
 */
export async function confirmPlaceAlias(aliasText, placeId, { nowIso = new Date().toISOString() } = {}) {
  const alias = normalizeAliasText(aliasText);
  if (!alias || !findSavedPlace(placeId)) return { ok: false };
  const existing = getState().placeAliases.find(a => a.alias === alias && a.placeId === placeId) || null;
  const next = normalizePlaceAlias(existing
    ? { ...existing, confirmations: existing.confirmations + 1, lastConfirmedAt: nowIso }
    : { id: newTaskId(), placeId, alias, confirmations: 1, lastConfirmedAt: nowIso });
  const { valid, errors } = validatePlaceAlias(next);
  if (!valid) return { ok: false, errors };

  const startedIn = sessionSnapshot();
  upsertPlaceAliasInState(next);
  const result = await persist(
    () => (existing ? placeAliasesRepo.update(next) : placeAliasesRepo.insert(next)),
    () => (existing ? upsertPlaceAliasInState(existing) : removePlaceAliasFromState(next.id)),
    startedIn);
  return result.ok ? { ok: true, alias: next } : result;
}

/** Poista yksi opittu nimitys. */
export async function deletePlaceAlias(id) {
  const previous = findPlaceAlias(id);
  if (!previous) return { ok: false };
  const startedIn = sessionSnapshot();
  removePlaceAliasFromState(id);
  return persist(() => placeAliasesRepo.remove(id), () => upsertPlaceAliasInState(previous), startedIn);
}

/**
 * Nollaa paikan oppiminen: sen nimitykset ja matkahavainnot poistetaan.
 * Paikka itse ja käyttäjän oma matka-arvio säilyvät.
 */
export async function resetPlaceLearning(placeId, { confirm = confirmAction } = {}) {
  const place = findSavedPlace(placeId);
  if (!place) return { ok: false };
  const state = getState();
  const aliases = state.placeAliases.filter(a => a.placeId === placeId);
  const observations = state.commuteObservations.filter(o => o.placeId === placeId);
  if (aliases.length === 0 && observations.length === 0 && !place.useLearned) return { ok: true, removed: 0 };
  const confirmed = await confirm({
    title: 'Nollataanko oppiminen?',
    message: `Paikan "${place.name}" opitut nimitykset (${aliases.length}) ja matkahavainnot (${observations.length}) poistetaan. Oma arviosi matka-ajasta säilyy.`,
    confirmLabel: 'Nollaa', destructive: true
  });
  if (!confirmed) return { ok: false, cancelled: true };

  const startedIn = sessionSnapshot();
  for (const alias of aliases) removePlaceAliasFromState(alias.id);
  for (const observation of observations) removeCommuteObservationFromState(observation.id);
  let failed = 0;
  for (const alias of aliases) {
    const result = await placeAliasesRepo.remove(alias.id);
    if (!isSameSession(startedIn)) return DISCARDED;
    if (!result.ok) { failed += 1; upsertPlaceAliasInState(alias); }
  }
  for (const observation of observations) {
    const result = await commuteObservationsRepo.remove(observation.id);
    if (!isSameSession(startedIn)) return DISCARDED;
    if (!result.ok) { failed += 1; addCommuteObservationToState(observation); }
  }
  if (place.useLearned) {
    const off = await savePlace({ ...place, useLearned: false });
    if (!off.ok) failed += 1;
  }
  if (failed > 0) {
    showError('Oppimista ei voitu nollata kokonaan. Yritä uudelleen, kun yhteys toimii.');
    return { ok: false, failed };
  }
  return { ok: true, removed: aliases.length + observations.length };
}

// ------------------------------------------------------------ matkahavainnot

/**
 * Kirjaa käyttäjän kuittaama toteutunut matka. Rajattu historia: paikan
 * vanhimmat havainnot poistetaan, kun raja ylittyy (ei seurantaa).
 */
export async function recordCommuteObservation(input = {}) {
  const observation = normalizeCommuteObservation({ ...input, id: newTaskId() });
  if (!findSavedPlace(observation.placeId)) return { ok: false, errors: { placeId: 'Paikkaa ei löydy.' } };
  const { valid, errors } = validateCommuteObservation(observation);
  if (!valid) return { ok: false, errors };

  const startedIn = sessionSnapshot();
  addCommuteObservationToState(observation);
  warnIfVolatile(commuteObservationsRepo, 'Matkahavainnot');
  const result = await persist(() => commuteObservationsRepo.insert(observation),
    () => removeCommuteObservationFromState(observation.id), startedIn);
  if (!result.ok) return result;

  await pruneObservations(observation.placeId, startedIn);
  return { ok: true, observation };
}

/** Vanhimmat pois, kunnes paikalla on enintään MAX_OBSERVATIONS_PER_PLACE havaintoa. */
async function pruneObservations(placeId, startedIn) {
  const own = getState().commuteObservations
    .filter(o => o.placeId === placeId)
    .sort((a, b) => (a.observedOn || '').localeCompare(b.observedOn || '')
      || String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
      || String(a.id).localeCompare(String(b.id)));
  const excess = own.slice(0, Math.max(0, own.length - MAX_OBSERVATIONS_PER_PLACE));
  for (const old of excess) {
    removeCommuteObservationFromState(old.id);
    const result = await commuteObservationsRepo.remove(old.id);
    if (!isSameSession(startedIn)) return;
    // Karsinta ei ole käyttäjän toimi: epäonnistunut poisto palautetaan
    // hiljaa ja yritetään seuraavalla kirjauksella uudelleen.
    if (!result.ok) addCommuteObservationToState(old);
  }
}

// ------------------------------------------------------------ asetukset

/** Päivitä arjen asetukset (yksi rivi käyttäjää kohti; luodaan tarvittaessa). */
export async function saveLifeSettings(changes = {}) {
  const rows = getState().lifeSettings || [];
  const current = rows[0] || null;
  const next = mergeLifeSettings(current || { id: newTaskId() }, changes);
  const { valid, errors } = validateLifeSettings(next);
  if (!valid) return { ok: false, errors };

  const startedIn = sessionSnapshot();
  upsertLifeSettingsInState(next);
  warnIfVolatile(lifeSettingsRepo, 'Arjen asetukset');
  const result = await persist(
    () => (current ? lifeSettingsRepo.update(next) : lifeSettingsRepo.insert(next)),
    () => setLifeSettings(current ? [current] : []),
    startedIn);
  return result.ok ? { ok: true, settings: next } : result;
}

// ------------------------------------------------------------ uni

/** Tallenna unikirjaus heräämispäivälle (yksi rivi päivää kohti). */
export async function saveSleepLog(input = {}) {
  const existing = getState().sleepLogs.find(l => l.wakeDate === input.wakeDate) || null;
  const log = normalizeSleepLog({ ...(existing || {}), ...input, id: existing ? existing.id : newTaskId() });
  const { valid, errors } = validateSleepLog(log);
  if (!valid) return { ok: false, errors };

  const startedIn = sessionSnapshot();
  upsertSleepLogInState(log);
  warnIfVolatile(sleepLogsRepo, 'Unikirjaukset');
  const result = await persist(
    () => (existing ? sleepLogsRepo.update(log) : sleepLogsRepo.insert(log)),
    () => (existing ? upsertSleepLogInState(existing) : removeSleepLogFromState(log.id)),
    startedIn);
  return result.ok ? { ok: true, log } : result;
}

// ------------------------------------------------------------ tavat

/** Luo tai päivitä tapojen muutoksen suunnitelma. */
export async function saveHabitPlan(input = {}) {
  const previous = input && input.id ? findHabitPlan(input.id) : null;
  const plan = normalizeHabitPlan({ ...(previous || {}), ...input, id: previous ? previous.id : newTaskId() });
  const { valid, errors } = validateHabitPlan(plan);
  if (!valid) return { ok: false, errors };

  const startedIn = sessionSnapshot();
  if (previous) replaceHabitPlanInState(plan.id, plan);
  else addHabitPlanToState(plan);
  warnIfVolatile(habitPlansRepo, 'Tapojen suunnitelmat');
  const result = await persist(
    () => (previous ? habitPlansRepo.update(plan) : habitPlansRepo.insert(plan)),
    () => (previous ? replaceHabitPlanInState(plan.id, previous) : removeHabitPlanFromState(plan.id)),
    startedIn);
  return result.ok ? { ok: true, plan } : result;
}

/** Poista suunnitelma ja sen kirjaukset (kanta: cascade). */
export async function deleteHabitPlan(id, { confirm = confirmAction } = {}) {
  const plan = findHabitPlan(id);
  if (!plan) return { ok: false };
  const confirmed = await confirm({
    title: 'Poistetaanko suunnitelma?',
    message: `"${plan.name}" ja sen kirjaukset poistetaan.`,
    confirmLabel: 'Poista', destructive: true
  });
  if (!confirmed) return { ok: false, cancelled: true };

  const startedIn = sessionSnapshot();
  const removed = removeHabitPlanFromState(id);
  return persist(() => habitPlansRepo.remove(id), () => restoreHabitPlanInState(removed), startedIn);
}

/** Kirjaa käyttö, lykkäys tai väliin jättäminen. Neutraali: ei arvostelua. */
export async function logHabitEvent({ planId, action, occurredAt = null, note = null, nowIso } = {}) {
  if (!findHabitPlan(planId)) return { ok: false, errors: { planId: 'Suunnitelmaa ei löydy.' } };
  const event = normalizeHabitEvent({
    id: newTaskId(), planId, action, note,
    occurredAt: occurredAt || nowIso || new Date().toISOString()
  });
  const { valid, errors } = validateHabitEvent(event);
  if (!valid) return { ok: false, errors };

  const startedIn = sessionSnapshot();
  addHabitEventToState(event);
  warnIfVolatile(habitEventsRepo, 'Tapakirjaukset');
  const result = await persist(() => habitEventsRepo.insert(event),
    () => removeHabitEventFromState(event.id), startedIn);
  return result.ok ? { ok: true, event } : result;
}

/** Poista yksi tapakirjaus (esim. vahingossa napautettu). */
export async function deleteHabitEvent(id) {
  const previous = getState().habitEvents.find(e => e.id === id) || null;
  if (!previous) return { ok: false };
  const startedIn = sessionSnapshot();
  removeHabitEventFromState(id);
  return persist(() => habitEventsRepo.remove(id), () => addHabitEventToState(previous), startedIn);
}

// ------------------------------------------------------------ liikunta

/** Luo tai päivitä liikuntakerta. */
export async function saveExerciseSession(input = {}) {
  const previous = input && input.id ? findExerciseSession(input.id) : null;
  // Lomakkeen luonnos voi kantaa poistetun tavoitteen tunnistetta (valinta
  // näyttää "Ei tavoitetta"): kanta hylkäisi sen (23503) joka yrityksellä.
  const session = withOwnLinks(
    normalizeExerciseSession({ ...(previous || {}), ...input, id: previous ? previous.id : newTaskId() }), previous);
  const { valid, errors } = validateExerciseSession(session);
  if (!valid) return { ok: false, errors };

  const startedIn = sessionSnapshot();
  if (previous) replaceExerciseSessionInState(session.id, session);
  else addExerciseSessionToState(session);
  warnIfVolatile(exerciseSessionsRepo, 'Liikuntakerrat');
  const result = await persist(
    () => (previous ? exerciseSessionsRepo.update(session) : exerciseSessionsRepo.insert(session)),
    () => (previous ? replaceExerciseSessionInState(session.id, previous) : removeExerciseSessionFromState(session.id)),
    startedIn);
  return result.ok ? { ok: true, session } : result;
}

/** Poista liikuntakerta. */
export async function deleteExerciseSession(id, { confirm = confirmAction } = {}) {
  const previous = findExerciseSession(id);
  if (!previous) return { ok: false };
  const confirmed = await confirm({
    title: 'Poistetaanko liikuntakerta?', message: `"${previous.kind}" ${previous.date} poistetaan.`,
    confirmLabel: 'Poista', destructive: true
  });
  if (!confirmed) return { ok: false, cancelled: true };
  const startedIn = sessionSnapshot();
  removeExerciseSessionFromState(id);
  return persist(() => exerciseSessionsRepo.remove(id), () => addExerciseSessionToState(previous), startedIn);
}

// ------------------------------------------------------------ vointi

/** Motivaatio ja hallinnan tunne päivälle (yksi rivi päivää kohti). Tyhjä ei ole nolla. */
export async function saveWellbeingCheckin(input = {}) {
  const existing = getState().wellbeingCheckins.find(c => c.date === input.date) || null;
  const checkin = normalizeWellbeingCheckin({ ...(existing || {}), ...input, id: existing ? existing.id : newTaskId() });
  const { valid, errors } = validateWellbeingCheckin(checkin);
  if (!valid) return { ok: false, errors };

  const startedIn = sessionSnapshot();
  upsertWellbeingCheckinInState(checkin);
  warnIfVolatile(wellbeingCheckinsRepo, 'Voinnin kirjaukset');
  const result = await persist(
    () => (existing ? wellbeingCheckinsRepo.update(checkin) : wellbeingCheckinsRepo.insert(checkin)),
    () => (existing ? upsertWellbeingCheckinInState(existing) : removeWellbeingCheckinFromState(checkin.id)),
    startedIn);
  return result.ok ? { ok: true, checkin } : result;
}
