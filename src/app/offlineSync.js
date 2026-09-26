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
//   - HUOLTOTILA (canSync): kun kannan ydin puuttuu, jonoa ei toisteta
//     eikä uusia muutoksia jonoteta -- jono säilyy koskemattomana
//   - SKEEMAVIRHE ei ole hylkäys: operaatio jää odottamaan ja skeema
//     tarkistetaan uudelleen; tilapäinen palvelinvirhe uusitaan viiveellä
//   - OSITTAIN KIRJOITETTU MUUTOS: jos kanta ei vielä tue osaa kentistä
//     (ajon aikana laskettu portti), kirjoitettavat lähtevät ja loput jäävät
//     jonoon odottamaan (SCHEMA_PENDING_CODE). Sama koskee lisäystä: rivi
//     syntyy ilman niitä, ja ne jäävät odottamaan muokkauksena. Pudotettua
//     kenttää ei koskaan raportoida onnistuneeksi.
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
import { logEvent } from '../lib/logger.js';

/** Operaation virhekoodi: osa kentistä odottaa, että kanta tukee niitä. */
export const SCHEMA_PENDING_CODE = 'schema_pending';
/** Käyttäjälle (tilarivi): miksi muutos yhä odottaa. */
export const SCHEMA_PENDING_NOTE = 'Osa muutoksesta odottaa palvelun päivitystä';
/**
 * Kuinka pian odottavaa osaa yritetään uudelleen. Yrityksiä ei kuluteta
 * (vika ei ole muutoksessa), eikä jono jumitu: muut operaatiot jatkavat.
 */
export const SCHEMA_PENDING_RETRY_MS = 60000;

const has = (object, key) => Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);

/**
 * Rajaa operaatio kenttiin, jotka eivät vielä tallentuneet, ja jätä se
 * odottamaan. Muut kentät ovat jo kannassa, joten niitä ei lähetetä uudelleen.
 *
 * LISÄYS muuttuu muokkaukseksi: rivi on jo kannassa, ja jäljelle jäävät
 * vain kentät, jotka saivat kannan oletusarvon. Niiden perusarvo on se
 * oletus (`insertedBase`), ei muutoksen oma arvo: myöhempi muokkaus
 * yhdistyy tähän ilman väärää konfliktia, ja muualla tehty muutos
 * tunnistetaan konfliktiksi.
 */
function keepWaitingFields(queue, id, fields, nowMs, insertedBase = null) {
  return {
    ...queue,
    ops: queue.ops.map(op => {
      if (op.id !== id) return op;
      const base = op.operation === 'create' ? insertedBase : op.baseValues;
      const payload = {};
      const baseValues = {};
      for (const field of fields) {
        if (has(op.payload, field)) payload[field] = op.payload[field];
        if (has(base, field)) baseValues[field] = base[field];
      }
      return {
        ...op, operation: 'update', payload, baseValues, status: OP_STATUS.PENDING,
        lastErrorCode: SCHEMA_PENDING_CODE,
        nextAttemptAt: Number.isFinite(nowMs) ? nowMs + SCHEMA_PENDING_RETRY_MS : null
      };
    })
  };
}

/** Uusi muokkaus yhdistyi odottavaan: yritetään heti, ei vasta odotuksen jälkeen. */
function wakeWaiting(queue, id) {
  return {
    ...queue,
    ops: queue.ops.map(op => (op.id === id && op.lastErrorCode === SCHEMA_PENDING_CODE
      ? { ...op, nextAttemptAt: null, lastErrorCode: null } : op))
  };
}

function sameValue(a, b) {
  if (a === b) return true;
  // Taulukot (dependsOn) arvoina: kaksi erillistä tyhjää taulukkoa ovat
  // sama arvo. Identiteettivertailulla jokainen muokkaus olisi näyttänyt
  // muuttavan riippuvuuksia, ja toisto olisi päätynyt konfliktiin.
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = Array.isArray(a) ? a : (a == null ? [] : null);
    const y = Array.isArray(b) ? b : (b == null ? [] : null);
    return Boolean(x && y) && x.length === y.length
      && x.every((value, i) => String(value) === String(y[i]));
  }
  const empty = value => value === null || value === undefined || value === '';
  return empty(a) && empty(b);
}

/**
 * @param {object} deps
 * @param {object} deps.repo      { insertTask, getTask, patchTask, unwritableInsert? }
 * @param {object} deps.store     { load(userId), save(userId, text), purge(userId) }
 * @param {object} deps.session   { userId(), snapshot(), isSame(snapshot) }
 * @param {() => number} deps.now
 * @param {() => boolean} deps.isOnline
 * @param {() => string} deps.newId
 * @param {(status:object) => void} [deps.onChange]  jonon tila muuttui
 * @param {() => void} [deps.onSynced]               jokin operaatio onnistui/ratkesi -> lataa uudelleen
 * @param {() => boolean} [deps.canSync]             false = huoltotila: ei toistoa eikä jonotusta
 * @param {() => void} [deps.onSchemaError]          kanta vastasi skeemavirheellä -> tarkista uudelleen
 */
export function createOfflineSync(deps) {
  const {
    repo, store, session, now, isOnline, newId,
    onChange = () => {}, onSynced = () => {},
    canSync = () => true, onSchemaError = () => {}
  } = deps;

  let queue = emptyQueue(null);
  let owner = null;
  let persistent = true;
  let replaying = false;
  let rerunRequested = false;
  /** Käynnissä olevan ajon lupaus (replay({ waitForCurrent: true })). */
  let currentRun = null;

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

  /**
   * Poista käyttäjän jono kokonaan (tilin poisto).
   *
   * Poistetun käyttäjän jonoa ei jätetä muistiin: omistaja nollataan, jotta
   * myöhempi deactivate() (uloskirjautuminen) ei tallenna tyhjää jonoa
   * takaisin poistetun tilin avaimelle. Muuten laitteelle jäisi tilin
   * tunniste, vaikka poisto lupaa tyhjentää jonon.
   */
  function purge(userId) {
    const target = userId == null ? owner : String(userId);
    if (target != null) store.purge(target);
    if (target === owner) {
      owner = null;
      queue = emptyQueue(null);
      rerunRequested = false;
    }
    emit();
  }

  // --------------------------------------------------------- lisäys

  function addOperation(spec) {
    if (owner == null || owner !== session.userId()) return { ok: false, reason: 'no_session' };
    // Huoltotila: muutosta ei jonoteta. Kutsuja peruu näkyvän muutoksen ja
    // kertoo syyn; jonoon kertyvä työ ei saa odottaa kantaa, jota ei ole.
    if (!canSync()) return { ok: false, reason: 'maintenance' };

    const created = createOperation({ id: newId(), now: now(), ...spec });
    if (!created.ok) return { ok: false, reason: created.reason };

    const result = enqueue(queue, created.op);
    if (!result.ok) return { ok: false, reason: result.reason };
    commit(result.coalesced ? wakeWaiting(result.queue, result.op.id) : result.queue);
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
    // Tilapäinen palvelinvirhe (503, aikakatkaisu, kanta ei vastaa):
    // uusitaan viiveellä. EI hylkäys -- aiemmin tämä merkitsi muutoksen
    // epäonnistuneeksi.
    if (kind === ERROR_CLASS.UNAVAILABLE) return { kind: 'retry', code: 'unavailable' };
    // Kanta ei vastaa sovellusta: odotetaan ja tarkistetaan skeema.
    if (kind === ERROR_CLASS.SCHEMA) return { kind: 'schema', code: 'schema' };
    // Hylkäys, myös 23503 (viitattu tavoite tai projekti on poistettu):
    // toisto ei auta, joten muutos näkyy käyttäjälle epäonnistuneena.
    if (kind === ERROR_CLASS.REJECTED) return { kind: 'rejected', code: 'rejected' };
    if (kind === ERROR_CLASS.DUPLICATE) return { kind: 'duplicate' };
    return { kind: 'retry', code: 'unknown' };
  }

  /**
   * Lisäyksen pois jättämät kentät: { fields, stored } (ks. tasksRepo.
   * unwritableInsert). Korvike ilman laskentaa ei jätä mitään pois.
   */
  function leftOutOnInsert(task) {
    if (typeof repo.unwritableInsert !== 'function') return { fields: [], stored: {} };
    try {
      const result = repo.unwritableInsert(task);
      return {
        fields: Array.isArray(result && result.fields) ? result.fields : [],
        stored: (result && result.stored) || {}
      };
    } catch {
      return { fields: [], stored: {} };
    }
  }

  /** Rivi on kannassa: onnistui kokonaan, vai odottaako osa kentistä? */
  function insertedOutcome(op, leftOut) {
    const waiting = leftOut.fields.filter(field => has(op.payload, field));
    if (waiting.length === 0) return { kind: 'success' };
    const insertedBase = {};
    for (const field of waiting) insertedBase[field] = has(leftOut.stored, field) ? leftOut.stored[field] : null;
    return { kind: 'partial', fields: waiting, wrote: true, insertedBase, code: SCHEMA_PENDING_CODE };
  }

  async function executeTaskCreate(op) {
    const task = normalizeTask({ ...op.payload, id: op.entityId });
    if (!validateTask(task).valid) return { kind: 'rejected', code: 'invalid_task' };

    // Kanta ei vielä tue kaikkia kenttiä (ajon aikana laskettu portti):
    // lisäys jättää ne pois. Aiemmin lisäys merkittiin onnistuneeksi ja
    // esimerkiksi lisäykseen yhdistetty välitavoitteen muutos katosi
    // hiljaa. Lasketaan SAMALLA sarakejoukolla kuin lisäyksen payload:
    // insertTask rakentaa sen synkronisesti ennen ensimmäistä odotusta.
    const leftOut = leftOutOnInsert(task);
    const inserted = await repo.insertTask(task);
    if (inserted.ok) return insertedOutcome(op, leftOut);

    const outcome = outcomeFor(inserted.error);
    if (outcome.kind !== 'duplicate') return outcome;

    // 23505: rivi on jo olemassa. Aiempi yritys onnistui -- MUTTA vain jos
    // rivi on TÄMÄN käyttäjän. Tarkistus estää törmäyksen väärän rivin kanssa.
    // Aiempi yritys on voinut jättää samat kentät pois: ne odottavat samoin
    // (jo kannassa oleva arvo todetaan myöhemmin "jo tehdyksi").
    const existing = await repo.getTask(op.entityId);
    if (!existing.ok) return outcomeFor(existing.error);
    return existing.value ? insertedOutcome(op, leftOut) : { kind: 'rejected', code: 'id_collision' };
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
    // Kanta ei vielä tue kaikkia muuttuneita kenttiä (ajon aikana laskettu
    // portti): ne eivät tallentuneet, vaikka kirjoitus "onnistui". Aiemmin
    // tyhjä erotus palasi onnistumisena ja muutos katosi jonosta hiljaa.
    const waiting = Array.isArray(patched.value.unwritable)
      ? patched.value.unwritable.filter(field => has(decision.patch, field)) : [];
    if (waiting.length > 0) return { kind: 'partial', fields: waiting, wrote: !patched.value.noop, code: SCHEMA_PENDING_CODE };
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
   * @param {{waitForCurrent?: boolean}} [options] waitForCurrent: jos ajo on
   *   jo käynnissä, odota se (ja sen lisäkierros) loppuun eikä palaa heti
   *   'busy'-tuloksella — "lähetä ensin, lataa sitten" pitää silloinkin
   * @returns {Promise<{ran:boolean, reason?:string, synced:number, conflicts:number, failed:number}>}
   */
  async function replay({ waitForCurrent = false } = {}) {
    const result = { ran: false, synced: 0, conflicts: 0, failed: 0 };
    if (owner == null || owner !== session.userId()) return { ...result, reason: 'no_session' };
    if (replaying) {
      rerunRequested = true;
      if (waitForCurrent && currentRun) return currentRun;
      return { ...result, reason: 'busy' };
    }
    if (!isOnline()) return { ...result, reason: 'offline' };
    if (!canSync()) return { ...result, reason: 'schema' };

    replaying = true;
    let finishRun = () => {};
    currentRun = new Promise(resolve => { finishRun = resolve; });
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
          if (!canSync()) { result.reason = 'schema'; break; }

          const op = nextRunnable(queue, now());
          if (!op) break;

          commit(markSyncing(queue, op.id), { silent: true });
          const outcome = await execute(op);
          // Vain tunniste, operaatio ja lopputulos -- ei tehtävän sisältöä.
          logEvent('offline.op', {
            opId: op.id, operation: op.domain + '.' + op.operation, outcome: outcome.kind, code: outcome.code || null
          });

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
          } else if (outcome.kind === 'partial') {
            // Kirjoitettavat kentät ovat kannassa; loput odottavat jonossa
            // omalla viiveellään, eivätkä pysäytä muiden toistoa.
            commit(keepWaitingFields(queue, op.id, outcome.fields, now(), outcome.insertedBase));
            if (outcome.wrote) result.synced += 1;
          } else if (outcome.kind === 'network' || outcome.kind === 'auth') {
            commit(markPaused(queue, op.id, outcome.kind));
            result.reason = outcome.kind;
            return result;
          } else if (outcome.kind === 'schema') {
            // Ei kuluteta yrityksiä eikä hylätä: sama muutos onnistuu, kun
            // skeema on tarkistettu (portti laskettu tai kanta päivitetty).
            commit(markPaused(queue, op.id, 'schema'));
            try { onSchemaError(); } catch { /* tarkistus ei kaada toistoa */ }
            result.reason = 'schema';
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
      logEvent('offline.replay', {
        synced: result.synced, conflicts: result.conflicts, failed: result.failed, reason: result.reason || null
      });
      emit();
      if (result.synced > 0 || result.conflicts > 0) {
        try { onSynced(); } catch { /* lataus ei saa kaataa toistoa */ }
      }
      currentRun = null;
      finishRun(result);
    }
    return result;
  }

  /**
   * Kanta tukee taas laskettua porttia (src/app/schemaStatus.js): odottavat
   * osat (SCHEMA_PENDING_CODE) yritetään seuraavassa toistossa heti eikä
   * vasta odotusajan jälkeen. Kutsu ENNEN palautuksen toistoa. Virhekoodi
   * jää, kunnes kenttä on oikeasti tallentunut; jos portti on yhä laskettu,
   * toisto asettaa odotuksen uudelleen. Palauttaa herätettyjen määrän.
   */
  function wakeSchemaPending() {
    let woken = 0;
    const ops = queue.ops.map(op => {
      if (op.status !== OP_STATUS.PENDING || op.lastErrorCode !== SCHEMA_PENDING_CODE
        || op.nextAttemptAt === null) return op;
      woken += 1;
      return { ...op, nextAttemptAt: null };
    });
    if (woken > 0) commit({ ...queue, ops });
    return woken;
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
    replay, resolve, list, status, wakeSchemaPending,
    /** Lisää odottavat muutokset ladatun listan päälle. */
    overlay: tasks => overlayPending(tasks, queue),
    pendingIds: () => pendingEntityIds(queue),
    isActive: () => owner !== null,
    isReplaying: () => replaying
  };
}
