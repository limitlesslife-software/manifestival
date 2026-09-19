// Offline-jonon ajaja: lisäys, tallennus ja toisto.
//
// TÄMÄ ON AINOA PAIKKA, JOSSA JONO KOSKEE VERKKOON. Domain
// (src/domain/offlineQueue.js) päättää mitä saa jonottaa ja mitä toisto
// tarkoittaa; tämä moduuli tekee kutsut ja pitää kirjaa.
//
// TAKUUT
//   - YKSI TOISTOAJAJA: rinnakkainen replay() ei aloita toista kierrosta,
//     vaan pyytää yhden lisäkierroksen (sama malli kuin
//     reconnect.js:n refresh)
//   - JÄRJESTYS: lisäysjärjestys (seq), saman rivin muutos ei ohita
//     aiempaa epäonnistunutta
//   - POISTO VASTA VAHVISTETUSTA ONNISTUMISESTA: operaatio poistuu jonosta
//     vasta kun palvelin on vahvistanut sen (tai rivi on jo sellainen)
//   - KONFLIKTI EI RATKEA ARVAAMALLA (ks. decideUpdate)
//   - ISTUNTORAJA: toisto keskeytyy heti, jos istunto vaihtuu kesken;
//     yhden käyttäjän jonoa ei koskaan lähetetä toisen tilillä
//   - EI SILENT LOSS: epäonnistunut ja ristiriitainen operaatio pysyy
//     jonossa ja näkyy käyttäjälle
//
// FIXED HANDLER MAP: (domain.operation) -> funktio on käsin kirjoitettu
// taulukko. Jonossa oleva merkkijono ei valitse koodia.

import {
  emptyQueue, createOperation, enqueue, nextRunnable, markSyncing, markSucceeded,
  markPaused, markRetry, markFailed, markConflict, retryOperation, resolveKeepMine,
  discardOperation, queueStats, classifyError, decideUpdate, serializeQueue, parseQueue,
  overlayPending, pendingEntityIds, QUEUE_TASK_FIELDS, ERROR_CLASS, OP_STATUS, MAX_OPERATIONS
} from '../domain/offlineQueue.js';
import { normalizeTask, validateTask } from '../domain/task.js';

function sameValue(a, b) {
  if (a === b) return true;
  const empty = value => value === null || value === undefined || value === '';
  return empty(a) && empty(b);
}

/**
 * @param {object} deps
 * @param {object} deps.repo      { insertTask, getTask, patchTask }
 * @param {object} deps.store     { load(userId), save(userId, text), purge(userId) }
 * @param {object} deps.session   { userId(), snapshot(), isSame(snapshot) }
 * @param {() => number} deps.now
 * @param {() => boolean} deps.isOnline
 * @param {() => string} deps.newId
 * @param {(status:object) => void} [deps.onChange]  jonon tila muuttui
 * @param {() => void} [deps.onSynced]               jokin operaatio onnistui/ratkesi -> lataa uudelleen
 */
export function createOfflineSync(deps) {
  const {
    repo, store, session, now, isOnline, newId,
    onChange = () => {}, onSynced = () => {}
  } = deps;

  let queue = emptyQueue(null);
  let owner = null;
  let persistent = true;
  let replaying = false;
  let rerunRequested = false;

  function status() {
    return {
      ...queueStats(queue),
      persistent,
      replaying,
      online: isOnline()
    };
  }

  function emit() {
    try { onChange(status()); } catch { /* näkymän virhe ei saa kaataa jonoa */ }
  }

  function persist() {
    if (owner == null) return;
    const result = store.save(owner, serializeQueue(queue));
    persistent = Boolean(result && result.persistent);
  }

  function commit(next, { silent = false } = {}) {
    queue = next;
    persist();
    if (!silent) emit();
  }

  // ------------------------------------------------------- elinkaari

  /** Lataa käyttäjän jono tallennuksesta. Kutsu kirjautumisen jälkeen. */
  function activate(userId) {
    const next = userId == null ? null : String(userId);
    // Vaihto toiseen käyttäjään: edellisen jono tallennetaan omalle avaimelleen
    // ennen kuin muistista poistuu -- se ei saa hävitä eikä sekoittua.
    if (owner != null && owner !== next) persist();
    owner = next;
    if (owner == null) { queue = emptyQueue(null); emit(); return status(); }

    const parsed = parseQueue(store.load(owner), { userId: owner });
    queue = parsed.queue;
    persistent = true;
    // Kelvottomat operaatiot pudotettiin: tallennetaan siivottu jono.
    if (parsed.dropped > 0 || parsed.reason) persist();
    emit();
    return { ...status(), dropped: parsed.dropped };
  }

  /** Vapauta muisti (uloskirjautuminen, tilinvaihto). Tallennus jää. */
  function deactivate() {
    if (owner != null) persist();
    owner = null;
    queue = emptyQueue(null);
    rerunRequested = false;
    emit();
  }

  /** Poista käyttäjän jono kokonaan (tilin poisto). */
  function purge(userId) {
    const target = userId == null ? owner : String(userId);
    if (target != null) store.purge(target);
    if (target === owner) queue = emptyQueue(owner);
    emit();
  }

  // --------------------------------------------------------- lisäys

  function addOperation(spec) {
    if (owner == null || owner !== session.userId()) return { ok: false, reason: 'no_session' };

    const created = createOperation({ id: newId(), now: now(), ...spec });
    if (!created.ok) return { ok: false, reason: created.reason };

    const result = enqueue(queue, created.op);
    if (!result.ok) return { ok: false, reason: result.reason };
    commit(result.queue);
    return { ok: true, queued: true, coalesced: result.coalesced, opId: result.op.id };
  }

  /** Jonota tehtävän lisäys. `task` on jo normalisoitu ja validoitu. */
  function enqueueTaskCreate(task) {
    return addOperation({
      domain: 'tasks', operation: 'create', entityId: String(task.id), payload: task
    });
  }

  /** Jonota tehtävän muokkaus: vain muuttuneet kentät, perusarvoineen. */
  function enqueueTaskUpdate({ id, previous, updated }) {
    const payload = {};
    const baseValues = {};
    for (const field of QUEUE_TASK_FIELDS) {
      if (!sameValue(previous[field], updated[field])) {
        payload[field] = updated[field];
        baseValues[field] = previous[field];
      }
    }
    if (Object.keys(payload).length === 0) return { ok: true, queued: false, reason: 'no_change' };
    return addOperation({ domain: 'tasks', operation: 'update', entityId: String(id), payload, baseValues });
  }

  // ---------------------------------------------------------- suoritus

  const offline = () => !isOnline();

  /** Yhteinen virheenkäsittely: palauttaa tuloksen, jonka silmukka ymmärtää. */
  function outcomeFor(error) {
    const kind = classifyError(error, { offline: offline() });
    if (kind === ERROR_CLASS.NETWORK) return { kind: 'network' };
    if (kind === ERROR_CLASS.AUTH) return { kind: 'auth' };
    if (kind === ERROR_CLASS.REJECTED) return { kind: 'rejected', code: 'rejected' };
    if (kind === ERROR_CLASS.DUPLICATE) return { kind: 'duplicate' };
    return { kind: 'retry', code: 'unknown' };
  }

  async function executeTaskCreate(op) {
    const task = normalizeTask({ ...op.payload, id: op.entityId });
    if (!validateTask(task).valid) return { kind: 'rejected', code: 'invalid_task' };

    const inserted = await repo.insertTask(task);
    if (inserted.ok) return { kind: 'success' };

    const outcome = outcomeFor(inserted.error);
    if (outcome.kind !== 'duplicate') return outcome;

    // 23505: rivi on jo olemassa. Aiempi yritys onnistui -- MUTTA vain jos
    // rivi on TÄMÄN käyttäjän. Tarkistus estää törmäyksen väärän rivin kanssa.
    const existing = await repo.getTask(op.entityId);
    if (!existing.ok) return outcomeFor(existing.error);
    return existing.value ? { kind: 'success' } : { kind: 'rejected', code: 'id_collision' };
  }

  async function executeTaskUpdate(op) {
    const fetched = await repo.getTask(op.entityId);
    if (!fetched.ok) return outcomeFor(fetched.error);

    const decision = decideUpdate({
      serverTask: fetched.value, baseValues: op.baseValues, changes: op.payload, force: op.force
    });
    if (decision.action === 'missing') return { kind: 'conflict', fields: [], reason: 'deleted_on_server' };
    if (decision.action === 'conflict') return { kind: 'conflict', fields: decision.fields, reason: 'changed_on_server' };
    if (decision.action === 'already_applied') return { kind: 'success' };

    const patched = await repo.patchTask(op.entityId, decision.patch, fetched.value);
    if (!patched.ok) return outcomeFor(patched.error);
    // Ehdollinen kirjoitus ei osunut: rivi muuttui lukemisen jälkeen. Yritä uudelleen
    // (seuraava kierros lukee uuden tilan ja päättää konfliktista).
    if (!patched.value.applied) return { kind: 'retry', code: 'changed_during_sync' };
    return { kind: 'success' };
  }

  /** Kiinteä käsittelijäkartta. Jonon merkkijono ei valitse koodia. */
  const HANDLERS = Object.freeze({
    'tasks.create': executeTaskCreate,
    'tasks.update': executeTaskUpdate
  });

  async function execute(op) {
    const key = `${op.domain}.${op.operation}`;
    const handler = Object.prototype.hasOwnProperty.call(HANDLERS, key) ? HANDLERS[key] : null;
    if (!handler) return { kind: 'rejected', code: 'unsupported_operation' };
    try {
      return await handler(op);
    } catch {
      return { kind: 'retry', code: 'exception' };
    }
  }

  // ------------------------------------------------------------ toisto

  /**
   * Aja jono. Yksi ajaja kerrallaan.
   *
   * @returns {Promise<{ran:boolean, reason?:string, synced:number, conflicts:number, failed:number}>}
   */
  async function replay() {
    const result = { ran: false, synced: 0, conflicts: 0, failed: 0 };
    if (owner == null || owner !== session.userId()) return { ...result, reason: 'no_session' };
    if (replaying) { rerunRequested = true; return { ...result, reason: 'busy' }; }
    if (!isOnline()) return { ...result, reason: 'offline' };

    replaying = true;
    result.ran = true;
    const snapshot = session.snapshot();
    const startedFor = owner;
    emit();

    try {
      let guard = MAX_OPERATIONS * 2;
      let pass = true;
      while (pass) {
        pass = false;
        rerunRequested = false;

        while (guard-- > 0) {
          // Istunto vaihtui: pysähdy heti, älä koske uuden käyttäjän jonoon.
          if (owner !== startedFor || !session.isSame(snapshot)) { result.reason = 'session_changed'; return result; }
          if (!isOnline()) { result.reason = 'offline'; break; }

          const op = nextRunnable(queue, now());
          if (!op) break;

          commit(markSyncing(queue, op.id), { silent: true });
          const outcome = await execute(op);

          if (owner !== startedFor || !session.isSame(snapshot)) {
            // Toisto ehti alkaa vanhalle käyttäjälle: palauta operaatio
            // odottamaan ja tallenna vanhan käyttäjän jonoon.
            store.save(startedFor, serializeQueue(markPaused(queue, op.id, 'session_changed')));
            result.reason = 'session_changed';
            return result;
          }

          if (outcome.kind === 'success' || outcome.kind === 'duplicate') {
            commit(markSucceeded(queue, op.id));
            result.synced += 1;
          } else if (outcome.kind === 'network' || outcome.kind === 'auth') {
            commit(markPaused(queue, op.id, outcome.kind));
            result.reason = outcome.kind;
            return result;
          } else if (outcome.kind === 'conflict') {
            commit(markConflict(queue, op.id, { fields: outcome.fields, reason: outcome.reason }));
            result.conflicts += 1;
          } else if (outcome.kind === 'rejected') {
            commit(markFailed(queue, op.id, outcome.code));
            result.failed += 1;
          } else {
            commit(markRetry(queue, op.id, { code: outcome.code, nowMs: now() }));
          }
        }

        // Yksi lisäkierros, jos toisto pyydettiin kesken ajon.
        if (rerunRequested) pass = true;
      }
    } finally {
      replaying = false;
      emit();
      if (result.synced > 0 || result.conflicts > 0) {
        try { onSynced(); } catch { /* lataus ei saa kaataa toistoa */ }
      }
    }
    return result;
  }

  // ----------------------------------------------- käyttäjän päätökset

  /**
   * @param {string} opId
   * @param {'retry'|'mine'|'discard'} choice
   */
  function resolve(opId, choice) {
    const op = queue.ops.find(item => item.id === opId);
    if (!op) return { ok: false, reason: 'not_found' };

    if (choice === 'retry' && op.status === OP_STATUS.FAILED) commit(retryOperation(queue, opId));
    else if (choice === 'mine' && op.status === OP_STATUS.CONFLICT) commit(resolveKeepMine(queue, opId));
    else if (choice === 'discard' && (op.status === OP_STATUS.CONFLICT || op.status === OP_STATUS.FAILED)) {
      commit(discardOperation(queue, opId));
      try { onSynced(); } catch { /* ignore */ }
    } else return { ok: false, reason: 'invalid_choice' };

    return { ok: true };
  }

  /** Näkymälle: turvallinen kuvaus operaatioista (ei koko payloadia). */
  function list() {
    return queue.ops.map(op => ({
      id: op.id,
      operation: `${op.domain}.${op.operation}`,
      entityId: op.entityId,
      title: typeof op.payload.title === 'string' ? op.payload.title : null,
      status: op.status,
      retryCount: op.retryCount,
      lastErrorCode: op.lastErrorCode,
      conflictFields: [...op.conflictFields]
    }));
  }

  return {
    activate, deactivate, purge, enqueueTaskCreate, enqueueTaskUpdate,
    replay, resolve, list, status,
    /** Lisää odottavat muutokset ladatun listan päälle. */
    overlay: tasks => overlayPending(tasks, queue),
    pendingIds: () => pendingEntityIds(queue),
    isActive: () => owner !== null,
    isReplaying: () => replaying
  };
}
