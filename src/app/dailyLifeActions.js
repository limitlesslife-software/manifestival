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
  sleepLogsRepo, habitPlansRepo, habitEventsRepo, exerciseSessionsRepo, wellbeingCheckinsRepo,
  changedColumns
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
import { mergeLifeSettings, validateLifeSettings, normalizeLifeSettings } from '../domain/lifeSettings.js';
import { normalizeSleepLog, validateSleepLog } from '../domain/sleepLog.js';
import { normalizeHabitPlan, validateHabitPlan, normalizeHabitEvent, validateHabitEvent } from '../domain/habit.js';
import { normalizeExerciseSession, validateExerciseSession } from '../domain/exerciseSession.js';
import { normalizeWellbeingCheckin, validateWellbeingCheckin } from '../domain/wellbeingCheckin.js';
import { MAX_OBSERVATIONS_PER_PLACE } from '../domain/dailyLife.js';
import { showError, notify } from '../ui/toast.js';
import { confirmAction } from '../ui/confirm.js';
// Lähtökori (rooli W): menon tallennus ja tapakirjaus odottavat verkkoa
// laitteella eivätkä peru näkyvästi. Ks. src/app/dailyLifeOutbox.js.
import { shouldSkipNetwork, enqueueAfterFailure, forgetDailyLifeEntity } from './dailyLifeOutbox.js';

/** Kerran istunnossa ja taulua kohti: "säilyy vain tämän istunnon ajan". */
const volatileWarningsShown = new Set();

function warnIfVolatile(repo, label) {
  if (!repo || repo.isPersistent() || volatileWarningsShown.has(repo.table)) return;
  volatileWarningsShown.add(repo.table);
  notify(`${label} säilyvät toistaiseksi vain tämän istunnon ajan.`, 7000);
}

/**
 * Uloskirjautuminen: varoitukset näytetään seuraavalle käyttäjälle
 * uudelleen, eikä edellisen käyttäjän kirjoituksia toisteta hänen tilaansa.
 */
export function resetDailyLifeActions() {
  volatileWarningsShown.clear();
  recentWrites.length = 0;
  latestStart.clear();
}

const DISCARDED = Object.freeze({ ok: false, discarded: true });

// ------------------------------------------ latauksen ja tallennuksen limitys
//
// loadUserData() lukee jokaisen kokoelman latauksen ALUSSA (muistipolulla
// synkronisesti) ja korvaa tilan listalla vasta, kun kaikki parikymmentä
// hakua ovat valmiit. Lataus käynnistyy sovelluksen palatessa etualalle ja
// verkon palautuessa. Sillä välin valmistunut tallennus katosi: uusi meno
// tai unikirjaus hävisi (ei lähtöilmoitusta), poistettu meno palasi
// haamuna, ja seuraava saman yön tai asetusrivin tallennus loi toisen rivin
// (muistissa tupla, kannassa 23505). Asetusten seuraava tallennus yhdisti
// muutoksensa palautuneeseen vanhaan riviin: herätysmuutos katosi pysyvästi.
//
// Siksi jokainen onnistunut kirjoitus kirjataan järjestysnumerolla
// toimintona, joka toistaa sen vaikutuksen tilaan (idempotentisti). Lataus
// ottaa merkin ennen hakuja ja toistaa sen jälkeen valmistuneet
// (keepDailyLifeWritesSince). Kirjoitus, joka oli yhä kesken latauksen
// korvatessa tilan, toistetaan heti valmistuttuaan -- paitsi jos samaan
// riviin on sillä välin aloitettu uudempi kirjoitus: sen tila on uudempi.
// Sama periaate kuin Suunnan tallennuksilla (src/app/alignment.js
// keepWritesSince).

let writeSeq = 0;
let startSeq = 0;
let loadsApplied = 0;
const recentWrites = [];
const MAX_RECENT_WRITES = 200;
/** Rivin avain -> viimeksi aloitetun kirjoituksen numero. */
const latestStart = new Map();

/** Kirjoituksen alku (ennen verkkoa). `key` yksilöi rivin, esim. 'calendarEvents:id'. */
function beginWrite(key) {
  startSeq += 1;
  latestStart.set(key, startSeq);
  return { key, token: startSeq, loads: loadsApplied };
}

/** Kirjoitus päättyi; onnistuneen vaikutus (`reapply`) kirjataan toistettavaksi. */
function endWrite(started, startedIn, reapply = null) {
  const newest = latestStart.get(started.key) === started.token;
  if (newest) latestStart.delete(started.key);
  if (!reapply) return;
  writeSeq += 1;
  recentWrites.push({ seq: writeSeq, session: startedIn, reapply });
  if (recentWrites.length > MAX_RECENT_WRITES) recentWrites.splice(0, recentWrites.length - MAX_RECENT_WRITES);
  // Lataus korvasi tilan tämän odottaessa: vaikutus takaisin heti.
  if (newest && loadsApplied !== started.loads) reapply();
}

/** Kutsu ENNEN latauksen hakuja: merkki keepDailyLifeWritesSince()-kutsulle. */
export function dailyLifeWriteMark() {
  return writeSeq;
}

/**
 * Kutsu HETI kun lataus on korvannut tilan (samassa batchissa): toistaa
 * merkin jälkeen valmistuneet tämän istunnon kirjoitukset järjestyksessä.
 */
export function keepDailyLifeWritesSince(mark) {
  loadsApplied += 1;
  for (const write of recentWrites) {
    if (write.seq > mark && isSameSession(write.session)) write.reapply();
  }
}

/**
 * Kirjoita kantaan ja peru epäonnistuessa. `undo` ajetaan vain, jos
 * istunto on yhä sama; muuten tila on jo tyhjennetty eikä sitä kosketa.
 * `reapply` toistaa onnistuneen kirjoituksen vaikutuksen latauksen jälkeen.
 */
async function persist(write, undo, startedIn, { key = null, reapply = null, outboxOp = null } = {}) {
  const started = beginWrite(key);
  // Tiedossa oleva offline-tila: lähtökoriin kelpaava tallennus ei odota
  // verkkokutsun aikakatkaisua (sama kuin tehtävien createTask).
  const skipped = outboxOp && shouldSkipNetwork(outboxOp.table);
  const result = skipped ? { ok: false, error: null, skipped: true } : await write();
  if (!isSameSession(startedIn)) return DISCARDED;
  if (!result || !result.ok) {
    // Verkko tai istunto: tallennus jää laitteelle eikä tilaa peruta. Kesken
    // ollut lataus ei saa pyyhkiä sitä: vaikutus toistetaan kuten onnistuneen.
    if (outboxOp && enqueueAfterFailure(outboxOp, result)) {
      endWrite(started, startedIn, reapply);
      return { ok: true, queued: true };
    }
    endWrite(started, startedIn);
    undo();
    showError(result && result.error);
    return { ok: false, error: result && result.error };
  }
  endWrite(started, startedIn, reapply);
  return { ok: true, value: result.value };
}

// Rivi tilaan tunnisteen mukaan: korvaa olemassa olevan, muuten lisää.
// Toistettavissa: lataus on voinut jo tuoda rivin (tai viedä sen).
function putCalendarEvent(event) {
  if (findCalendarEvent(event.id)) replaceCalendarEventInState(event.id, event);
  else addCalendarEventToState(event);
}

function putSavedPlace(place) {
  if (findSavedPlace(place.id)) replaceSavedPlaceInState(place.id, place);
  else addSavedPlaceToState(place);
}

function putCommuteObservation(observation) {
  removeCommuteObservationFromState(observation.id);
  addCommuteObservationToState(observation);
}

function putHabitPlan(plan) {
  if (findHabitPlan(plan.id)) replaceHabitPlanInState(plan.id, plan);
  else addHabitPlanToState(plan);
}

function putHabitEvent(event) {
  removeHabitEventFromState(event.id);
  addHabitEventToState(event);
}

function putExerciseSession(session) {
  if (findExerciseSession(session.id)) replaceExerciseSessionInState(session.id, session);
  else addExerciseSessionToState(session);
}

/** Paikan poisto tilaan kuten kanta, myös jos paikka puuttui jo ladatusta listasta. */
function forgetPlaceInState(id) {
  if (removeSavedPlaceFromState(id)) return;
  const state = getState();
  for (const alias of state.placeAliases.filter(a => a.placeId === id)) removePlaceAliasFromState(alias.id);
  for (const observation of state.commuteObservations.filter(o => o.placeId === id)) {
    removeCommuteObservationFromState(observation.id);
  }
  for (const event of state.calendarEvents.filter(e => e.placeId === id)) {
    replaceCalendarEventInState(event.id, { ...event, placeId: null });
  }
}

/** Suunnitelman poisto tilaan kuten kanta (kirjaukset mukana). */
function forgetHabitPlanInState(id) {
  if (removeHabitPlanFromState(id)) return;
  for (const event of getState().habitEvents.filter(e => e.planId === id)) removeHabitEventFromState(event.id);
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
    startedIn, {
      key: `calendarEvents:${safe.id}`, reapply: () => putCalendarEvent(safe),
      outboxOp: { table: 'calendarEvents', operation: previous ? 'update' : 'create', entity: safe, base: previous }
    });
  return result.ok ? { ok: true, event: safe, queued: result.queued === true } : result;
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
  // Peruutus korvaa eikä lisää: välissä valmistunut lataus on voinut jo
  // tuoda menon takaisin (kanta piti sen), ja lisäys olisi monistanut sen.
  const result = await persist(() => calendarEventsRepo.remove(id), () => putCalendarEvent(previous), startedIn,
    { key: `calendarEvents:${id}`, reapply: () => removeCalendarEventFromState(id) });
  // Poistettu meno ei saa palata lähtökorin toistossa.
  if (result.ok) forgetDailyLifeEntity('calendarEvents', id);
  return result;
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
    () => replaceCalendarEventInState(eventId, previous), startedIn,
    { key: `calendarEvents:${eventId}`, reapply: () => putCalendarEvent(next) });
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
    startedIn, { key: `savedPlaces:${place.id}`, reapply: () => putSavedPlace(place) });
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
  return persist(() => savedPlacesRepo.remove(id), () => restoreSavedPlaceInState(removed), startedIn,
    { key: `savedPlaces:${id}`, reapply: () => forgetPlaceInState(id) });
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
    startedIn, { key: `placeAliases:${next.id}`, reapply: () => upsertPlaceAliasInState(next) });
  return result.ok ? { ok: true, alias: next } : result;
}

/** Poista yksi opittu nimitys. */
export async function deletePlaceAlias(id) {
  const previous = findPlaceAlias(id);
  if (!previous) return { ok: false };
  const startedIn = sessionSnapshot();
  removePlaceAliasFromState(id);
  return persist(() => placeAliasesRepo.remove(id), () => upsertPlaceAliasInState(previous), startedIn,
    { key: `placeAliases:${id}`, reapply: () => removePlaceAliasFromState(id) });
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
  // Kaikki kirjoitukset alkavat nyt, samalla kun tila muuttui: jonon
  // loppupään poisto on muuten "aloitettu" vasta latauksen jälkeen, eikä
  // latauksen takaisin tuomaa riviä poistettaisi tilasta.
  const aliasWrites = aliases.map(alias => ({ alias, started: beginWrite(`placeAliases:${alias.id}`) }));
  const observationWrites = observations.map(observation =>
    ({ observation, started: beginWrite(`commuteObservations:${observation.id}`) }));
  let failed = 0;
  for (const { alias, started } of aliasWrites) {
    const result = await placeAliasesRepo.remove(alias.id);
    if (!isSameSession(startedIn)) return DISCARDED;
    if (!result.ok) { failed += 1; endWrite(started, startedIn); upsertPlaceAliasInState(alias); }
    else endWrite(started, startedIn, () => removePlaceAliasFromState(alias.id));
  }
  for (const { observation, started } of observationWrites) {
    const result = await commuteObservationsRepo.remove(observation.id);
    if (!isSameSession(startedIn)) return DISCARDED;
    if (!result.ok) { failed += 1; endWrite(started, startedIn); putCommuteObservation(observation); }
    else endWrite(started, startedIn, () => removeCommuteObservationFromState(observation.id));
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
    () => removeCommuteObservationFromState(observation.id), startedIn,
    { key: `commuteObservations:${observation.id}`, reapply: () => putCommuteObservation(observation) });
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
    const started = beginWrite(`commuteObservations:${old.id}`);
    const result = await commuteObservationsRepo.remove(old.id);
    if (!isSameSession(startedIn)) return;
    // Karsinta ei ole käyttäjän toimi: epäonnistunut poisto palautetaan
    // hiljaa ja yritetään seuraavalla kirjauksella uudelleen.
    if (!result.ok) { endWrite(started, startedIn); putCommuteObservation(old); }
    else endWrite(started, startedIn, () => removeCommuteObservationFromState(old.id));
  }
}

// ------------------------------------------------------------ asetukset

/** Rivin kentät, jotka eivät ole käyttäjän asetuksia. */
const SETTINGS_META = Object.freeze(['id', 'createdAt', 'updatedAt']);
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Päivitä arjen asetukset (yksi rivi käyttäjää kohti; luodaan tarvittaessa).
 *
 * RIVIÄ KIRJOITTAA MONTA LOMAKETTA JA LAITETTA. Siksi:
 *   - kantaan lähtevät vain tämän kutsun muuttamat sarakkeet (update
 *     changedFrom): vanhentunut laite ei kumoa toisen laitteen herätystä
 *     vaihtaessaan ohjaustyyliä
 *   - epäonnistuminen palauttaa vain omat kenttänsä, ja vain jos uudempi
 *     tallennus ei ole ehtinyt muuttaa niitä: koko rivin tilannekuva pyyhki
 *     rinnakkain onnistuneen tallennuksen tilasta, vaikka se oli kannassa
 */
export async function saveLifeSettings(changes = {}) {
  const rows = getState().lifeSettings || [];
  const current = rows[0] || null;
  const next = mergeLifeSettings(current || { id: newTaskId() }, changes);
  const { valid, errors } = validateLifeSettings(next);
  if (!valid) return { ok: false, errors };

  const startedIn = sessionSnapshot();
  const fields = Object.keys(changedColumns(current && normalizeLifeSettings(current), next, SETTINGS_META));
  upsertLifeSettingsInState(next);
  warnIfVolatile(lifeSettingsRepo, 'Arjen asetukset');
  const result = await persist(
    () => (current ? lifeSettingsRepo.update(next, { changedFrom: current }) : lifeSettingsRepo.insert(next)),
    () => revertLifeSettings(current, next, fields),
    startedIn, { key: 'lifeSettings', reapply: () => reapplyLifeSettings(next, fields) });
  return result.ok ? { ok: true, settings: next } : result;
}

/**
 * Onnistunut tallennus latauksen jälkeen: omat kentät ladatun rivin päälle
 * (muut kentät voivat olla toisen laitteen uudempia). Ilman riviä -- lataus
 * luki ennen luontia -- tallennettu rivi sellaisenaan.
 */
function reapplyLifeSettings(next, fields) {
  const row = (getState().lifeSettings || [])[0] || null;
  if (!row || row.id !== next.id) {
    upsertLifeSettingsInState(next);
    return;
  }
  const merged = { ...row };
  for (const field of fields) merged[field] = next[field];
  upsertLifeSettingsInState(merged);
}

/** Epäonnistuneen tallennuksen peruutus kentittäin (ks. saveLifeSettings). */
function revertLifeSettings(current, next, fields) {
  const row = (getState().lifeSettings || [])[0] || null;
  // Rivi on jo toinen (lataus tai uloskirjautuminen): ei kosketa.
  if (!row || row.id !== next.id) return;
  // Luonti epäonnistui: riviä ei ole kannassa.
  if (!current) {
    setLifeSettings([]);
    return;
  }
  const reverted = { ...row };
  for (const field of fields) {
    // Uudempi tallennus muutti saman kentän: sen arvo jää voimaan.
    if (sameValue(row[field], next[field])) reverted[field] = current[field];
  }
  upsertLifeSettingsInState(reverted);
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
    startedIn, { key: `sleepLogs:${log.id}`, reapply: () => upsertSleepLogInState(log) });
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
    startedIn, { key: `habitPlans:${plan.id}`, reapply: () => putHabitPlan(plan) });
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
  return persist(() => habitPlansRepo.remove(id), () => restoreHabitPlanInState(removed), startedIn,
    { key: `habitPlans:${id}`, reapply: () => forgetHabitPlanInState(id) });
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
    () => removeHabitEventFromState(event.id), startedIn,
    {
      key: `habitEvents:${event.id}`, reapply: () => putHabitEvent(event),
      outboxOp: { table: 'habitEvents', operation: 'create', entity: event }
    });
  return result.ok ? { ok: true, event, queued: result.queued === true } : result;
}

/** Poista yksi tapakirjaus (esim. vahingossa napautettu). */
export async function deleteHabitEvent(id) {
  const previous = getState().habitEvents.find(e => e.id === id) || null;
  if (!previous) return { ok: false };
  const startedIn = sessionSnapshot();
  removeHabitEventFromState(id);
  const result = await persist(() => habitEventsRepo.remove(id), () => putHabitEvent(previous), startedIn,
    { key: `habitEvents:${id}`, reapply: () => removeHabitEventFromState(id) });
  if (result.ok) forgetDailyLifeEntity('habitEvents', id);
  return result;
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
    startedIn, { key: `exerciseSessions:${session.id}`, reapply: () => putExerciseSession(session) });
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
  return persist(() => exerciseSessionsRepo.remove(id), () => putExerciseSession(previous), startedIn,
    { key: `exerciseSessions:${id}`, reapply: () => removeExerciseSessionFromState(id) });
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
    startedIn, { key: `wellbeingCheckins:${checkin.id}`, reapply: () => upsertWellbeingCheckinInState(checkin) });
  return result.ok ? { ok: true, checkin } : result;
}
