// Arjen lähtökori sovelluskerroksessa: menojen ja tapakirjausten
// tallennukset, kun verkko puuttuu.
//
// SAMA LUPAUS KUIN TEHTÄVIEN OFFLINE-JONOSSA (src/app/offline.js):
//   - tallennus ei katoa verkkokatkoon: se jää laitteelle käyttäjän omalla
//     avaimella (src/data/dailyLifeOutboxStore.js) ja lähtee, kun yhteys
//     palaa ja sama käyttäjä on kirjautuneena
//   - toisto on idempotentti: tunniste luodaan laitteella, joten sama meno
//     ei synny kahdesti (kannan 23505 = jo perillä)
//   - kahden tallennuksen yhdistäminen: sama meno kahdesti = yksi lähetys
//   - muokkaus ei ylikirjoita toisen laitteen uudempaa muutosta hiljaa
//     (domain/dailyLifeOutbox.js decideOutboxUpdate)
//   - poistoja, taloutta tai tekoälyn komentoja ei koskaan laiteta koriin
//   - lähetys on yksi kerrallaan: verkon palautuminen kesken lähetyksen ei
//     käynnistä rinnakkaista toistoa
//   - istunnon vaihto kesken lähetyksen pysäyttää sen: toisen käyttäjän
//     muutoksia ei lähetetä tämän tokenilla

import { calendarEventsRepo, habitEventsRepo } from '../data/collectionsRepo.js';
import { loadOutboxText, saveOutboxText } from '../data/dailyLifeOutboxStore.js';
import { sessionSnapshot, isSameSession } from '../data/session.js';
import { getState, setCalendarEvents, setHabitEvents } from './state.js';
import { isOnlineNow } from './offline.js';
import {
  emptyOutbox, createOutboxOperation, enqueueOutbox, nextOutboxRunnable, removeOutboxOp, retryOutboxOp,
  failOutboxOp, pauseOutboxOp, forgetOutboxEntity, outboxStats, decideOutboxUpdate, overlayOutbox,
  serializeOutbox, parseOutbox
} from '../domain/dailyLifeOutbox.js';
import { classifyError, ERROR_CLASS } from '../domain/offlineQueue.js';
import { notify, showError } from '../ui/toast.js';
import { logEvent } from '../lib/logger.js';

const REPOS = Object.freeze({ calendarEvents: calendarEventsRepo, habitEvents: habitEventsRepo });
const LABELS = Object.freeze({ calendarEvents: 'Meno', habitEvents: 'Tapakirjaus' });

let activeUserId = null;
let outbox = emptyOutbox(null);
let persistent = true;
let replaying = null;
let queuedNoticeAt = 0;

function save() {
  if (!activeUserId) return;
  const result = saveOutboxText(activeUserId, serializeOutbox(outbox));
  persistent = result.persistent;
}

/** Kirjautuminen: käyttäjän oma kori laitteelta muistiin. */
export function activateDailyLifeOutbox(userId) {
  activeUserId = typeof userId === 'string' && userId ? userId : null;
  const { outbox: loaded } = parseOutbox(activeUserId ? loadOutboxText(activeUserId) : null, { userId: activeUserId });
  outbox = loaded;
}

/**
 * Uloskirjautuminen: kori pois muistista. Laitteelle se jää käyttäjän
 * avaimella (lähetetään, kun sama käyttäjä palaa); tilin poisto poistaa sen.
 */
export function deactivateDailyLifeOutbox() {
  activeUserId = null;
  outbox = emptyOutbox(null);
  replaying = null;
}

export function dailyLifeOutboxStatus() {
  return Object.freeze({ ...outboxStats(outbox), persistent, active: Boolean(activeUserId) });
}

/** Tunnetusti offline ja kanta käytössä: verkkokutsua ei kannata odottaa. */
export function shouldSkipNetwork(table) {
  const repo = REPOS[table];
  return Boolean(activeUserId) && Boolean(repo) && repo.isPersistent() && !isOnlineNow();
}

function announceQueued() {
  const at = Date.now();
  if (at - queuedNoticeAt < 60000) return;
  queuedNoticeAt = at;
  notify('Ei yhteyttä: tallennus jäi laitteelle ja lähetetään, kun yhteys palaa.', 5000);
}

/**
 * Epäonnistunut tallennus koriin, jos syy on verkko tai istunto. Palauttaa
 * true, jos tallennus jäi odottamaan (kutsuja EI peru tilaa).
 *
 * @param {{table:string, operation:string, entity:object, base?:object}} spec
 * @param {object} result repositorion tulos ({ok:false, error, skipped?})
 */
export function enqueueAfterFailure(spec, result) {
  if (!activeUserId || !spec) return false;
  const repo = REPOS[spec.table];
  if (!repo || !repo.isPersistent()) return false;
  const kind = result && result.skipped ? ERROR_CLASS.NETWORK : classifyError(result && result.error, { offline: !isOnlineNow() });
  if (kind !== ERROR_CLASS.NETWORK && kind !== ERROR_CLASS.AUTH) return false;
  const created = createOutboxOperation({
    // Tunniste korin omasta juoksevasta numerosta: yhdistetty tallennus
    // säilyttää aiemman operaation tunnisteen, uusi saa seuraavan numeron.
    id: `op${outbox.seq + 1}`, table: spec.table, operation: spec.operation, entity: spec.entity, base: spec.base || null,
    now: Date.now()
  });
  if (!created.ok) return false;
  const queued = enqueueOutbox(outbox, created.op);
  if (!queued.ok) return false;
  outbox = queued.outbox;
  save();
  logEvent('daily_life.outbox_queued', { table: spec.table, coalesced: queued.coalesced });
  announceQueued();
  return true;
}

/** Rivi poistettiin: sen odottavat tallennukset eivät saa herättää sitä henkiin. */
export function forgetDailyLifeEntity(table, entityId) {
  if (!activeUserId || typeof entityId !== 'string') return;
  const next = forgetOutboxEntity(outbox, table, entityId);
  if (next.ops.length === outbox.ops.length) return;
  outbox = next;
  save();
}

/**
 * Odottavat tallennukset ladatun tilan päälle: lähettämätön meno ei katoa
 * näkyvistä, kun tiedot ladataan uudelleen (main.js latauksen jälkeen).
 */
export function overlayDailyLifeOutbox() {
  if (!activeUserId || outbox.ops.length === 0) return;
  const state = getState();
  if (outbox.ops.some(op => op.table === 'calendarEvents')) {
    setCalendarEvents(overlayOutbox(state.calendarEvents, outbox, 'calendarEvents'));
  }
  if (outbox.ops.some(op => op.table === 'habitEvents')) {
    setHabitEvents(overlayOutbox(state.habitEvents, outbox, 'habitEvents'));
  }
}

async function serverRow(table, id, cache) {
  if (!cache.has(table)) {
    const listed = await REPOS[table].list();
    cache.set(table, listed.ok ? listed.value : null);
  }
  const rows = cache.get(table);
  if (rows === null) return { ok: false };
  return { ok: true, row: rows.find(row => row && row.id === id) || null };
}

/** Yksi operaatio palvelimelle. Palauttaa {outcome, code?}. */
async function execute(op, cache) {
  const repo = REPOS[op.table];
  if (op.operation === 'create') {
    const inserted = await repo.insert(op.payload);
    if (inserted.ok) return { outcome: 'done' };
    const kind = classifyError(inserted.error, { offline: !isOnlineNow() });
    if (kind !== ERROR_CLASS.DUPLICATE) return { outcome: 'error', error: inserted.error, kind };
    // Aiempi yritys ehti perille. Menon uusin sisältö (yhdistetty muokkaus)
    // viedään silti: rivi on tämän laitteen oma luonti.
    if (op.table !== 'calendarEvents') return { outcome: 'done' };
    const updated = await repo.update(op.payload);
    if (updated.ok) return { outcome: 'done' };
    return { outcome: 'error', error: updated.error, kind: classifyError(updated.error, { offline: !isOnlineNow() }) };
  }
  // Muokkaus: palvelimen nykytila ensin (ei hiljaista ylikirjoitusta).
  const found = await serverRow(op.table, op.entityId, cache);
  if (!found.ok) return { outcome: 'error', error: null, kind: isOnlineNow() ? ERROR_CLASS.UNAVAILABLE : ERROR_CLASS.NETWORK };
  const decision = decideOutboxUpdate({ server: found.row, op });
  if (decision.action === 'already_applied') return { outcome: 'done' };
  if (decision.action === 'missing') return { outcome: 'dropped', code: 'missing' };
  if (decision.action === 'conflict') return { outcome: 'dropped', code: 'conflict' };
  const updated = await repo.update(decision.merged);
  if (updated.ok) return { outcome: 'done' };
  return { outcome: 'error', error: updated.error, kind: classifyError(updated.error, { offline: !isOnlineNow() }) };
}

function titleOf(op) {
  return op.table === 'calendarEvents' && op.payload && op.payload.title ? `"${op.payload.title}"` : '';
}

async function replayLoop() {
  const session = sessionSnapshot();
  const userId = activeUserId;
  const cache = new Map();
  let sent = 0;
  for (let guard = 0; guard < 500; guard += 1) {
    if (!userId || activeUserId !== userId || !isSameSession(session)) break;
    if (!isOnlineNow()) break;
    const op = nextOutboxRunnable(outbox, Date.now());
    if (!op) break;
    let result;
    try {
      result = await execute(op, cache);
    } catch (error) {
      result = { outcome: 'error', error, kind: ERROR_CLASS.UNKNOWN };
    }
    // Uloskirjautuminen tai tilinvaihto lähetyksen aikana: tulosta ei
    // kirjata toisen käyttäjän koriin.
    if (activeUserId !== userId || !isSameSession(session)) break;
    if (result.outcome === 'done') {
      outbox = removeOutboxOp(outbox, op.id);
      sent += 1;
    } else if (result.outcome === 'dropped') {
      outbox = removeOutboxOp(outbox, op.id);
      showError(result.code === 'missing'
        ? `${LABELS[op.table]} ${titleOf(op)} oli poistettu toisella laitteella, joten laitteelle jäänyt muutos jätettiin pois.`
        : `${LABELS[op.table]} ${titleOf(op)} oli muutettu toisella laitteella. Laitteelle jäänyt muutos jätettiin pois: tarkista meno.`);
      logEvent('daily_life.outbox_dropped', { table: op.table, code: result.code });
    } else if (result.kind === ERROR_CLASS.NETWORK || result.kind === ERROR_CLASS.AUTH || result.kind === ERROR_CLASS.SCHEMA) {
      outbox = pauseOutboxOp(outbox, op.id, result.kind);
      save();
      break;
    } else if (result.kind === ERROR_CLASS.REJECTED) {
      outbox = failOutboxOp(outbox, op.id, 'rejected');
      showError(`${LABELS[op.table]} ${titleOf(op)} ei tallentunut palvelimelle. Tallennus on yhä laitteella.`);
    } else {
      outbox = retryOutboxOp(outbox, op.id, { code: result.kind, nowMs: Date.now() });
    }
    save();
  }
  if (sent > 0) logEvent('daily_life.outbox_sent', { count: sent });
  return { sent, ...outboxStats(outbox) };
}

/**
 * Lähetä odottavat tallennukset. Yksi lähetys kerrallaan: rinnakkainen
 * kutsu (verkon palautuminen kesken lähetyksen) saa saman lupauksen.
 * Ei koskaan heitä.
 */
export function replayDailyLifeOutbox() {
  if (replaying) return replaying;
  if (!activeUserId || outbox.ops.length === 0) return Promise.resolve({ sent: 0, ...outboxStats(outbox) });
  const run = replayLoop().catch(error => {
    logEvent('daily_life.outbox_failed', { code: error && error.code ? String(error.code) : 'unknown' });
    return { sent: 0, ...outboxStats(outbox) };
  }).finally(() => {
    if (replaying === run) replaying = null;
  });
  replaying = run;
  return run;
}
