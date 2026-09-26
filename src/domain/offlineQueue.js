// Offline-kirjausjono: rajattu, deterministinen ja rehellinen.
//
// PUHDAS MODUULI. Ei DOM:ia, ei verkkoa, ei kelloa, ei satunnaisuutta, ei
// tallennusta. Kaikki tila on arvo: jokainen funktio palauttaa UUDEN
// jonon eikä muuta annettua. Kellonaika ja tunnisteet annetaan
// parametreina, joten sama syöte tuottaa aina saman tuloksen.
//
// =====================================================================
// MITÄ TÄMÄ ON JA MITÄ SE EI OLE
// =====================================================================
//
// Kun verkko puuttuu, käyttäjän tehtävän lisäys tai muokkaus ei saa
// hävitä. Tämä jono säilyttää sen kunnes se voidaan lähettää.
//
// SE ON TARKOITUKSELLA KAPEA. Vain matalan riskin kirjoitukset:
//
//   tasks.create   tehtävän lisäys (tunniste luodaan asiakkaalla, joten
//                  toisto on turvallinen: sama rivi, ei kaksi)
//   tasks.update   tehtävän muokkaus ja valmis/kesken-merkintä
//
// EI JONOTETA, MISSÄÄN OLOSUHTEISSA (FORBIDDEN_OPERATIONS):
//   poisto, laskun maksu, talouden mutaatiot, AI-komennon suoritus,
//   tilin poisto, tilin asetukset. Niiden viivästetty toisto voisi
//   tehdä peruuttamatonta vahinkoa vanhentuneen päätöksen perusteella.
//
// KONFLIKTIT EIVÄT RATKEA ARVAAMALLA. Muokkaus lähetetään vain kun
// palvelimen rivi on yhä sellainen kuin se oli kun muokkaus tehtiin
// (kolmisuuntainen vertailu kenttä kerrallaan). Muuten operaatio
// merkitään CONFLICTiksi ja käyttäjä päättää. Palvelimen uudempaa
// tilaa ei ylikirjoiteta hiljaa.
//
// SALAISUUKSIA EI JONOON: kenttälista on rajattu tehtävän kenttiin, joten
// tunnisteita, tokeneita tai user_id:tä ei voi päätyä jonoon.

import { normalizeTask } from './task.js';
import { REDACTED_FIELDS } from './dataExport.js';

export const QUEUE_VERSION = 1;

export const OP_STATUS = Object.freeze({
  PENDING: 'pending',
  SYNCING: 'syncing',
  /** Pysyvästi hylätty tai yritykset loppuneet. Näkyy käyttäjälle, ei katoa. */
  FAILED: 'failed',
  /** Palvelimen tila on muuttunut: käyttäjän päätös vaaditaan. */
  CONFLICT: 'conflict'
});

export const OP_STATUSES = Object.freeze(Object.values(OP_STATUS));

/** Sallitut (domain, operaatio) -parit. Tämä lista ON turvamalli. */
export const ALLOWED_OPERATIONS = Object.freeze({
  tasks: Object.freeze(['create', 'update'])
});

/** Operaatiot, joita ei koskaan jonoteta. Dokumentaatio ja testattava invariantti. */
export const FORBIDDEN_OPERATIONS = Object.freeze([
  'delete', 'delete_task', 'delete_routine', 'delete_goal', 'delete_project',
  'mark_bill_paid', 'finance', 'ai_command', 'account_deletion', 'account_settings'
]);

export const MAX_OPERATIONS = 200;
export const MAX_RETRIES = 5;
export const MAX_PAYLOAD_CHARS = 16000;
export const BACKOFF_BASE_MS = 2000;
export const BACKOFF_MAX_MS = 5 * 60 * 1000;

/** Virheluokat, joiden mukaan toisto toimii. */
export const ERROR_CLASS = Object.freeze({
  /** Verkko puuttuu: yritä myöhemmin, älä kuluta yrityksiä. */
  NETWORK: 'network',
  /** Istunto ei kelpaa: odota kirjautumista, älä kuluta yrityksiä. */
  AUTH: 'auth',
  /** Rivi on jo olemassa (aiempi yritys onnistui). */
  DUPLICATE: 'duplicate',
  /**
   * Kannan rakenne ei vastaa sovellusta (taulu tai sarake puuttuu, tai
   * sovellus on itse kieltäytynyt kirjoittamasta sellaiseen). Tieto EI
   * ole viallinen: sama kirjoitus onnistuu, kun kanta on ajan tasalla.
   * Ei hylätä eikä kuluteta yrityksiä -- odotetaan ja tarkistetaan
   * skeema uudelleen.
   */
  SCHEMA: 'schema',
  /**
   * Palvelin on tilapäisesti poissa käytöstä (ylikuorma, aikakatkaisu,
   * yhteys kantaan, skeemavälimuistin lataus). Uusitaan viiveellä.
   */
  UNAVAILABLE: 'unavailable',
  /** Palvelin vastasi ja hylkäsi: uudelleenyritys ei auta. */
  REJECTED: 'rejected',
  UNKNOWN: 'unknown'
});

/** Tehtäväkentät, jotka saavat olla jonossa. Johdetaan normalizeTaskista: ei omaa kopiota. */
const EXCLUDED_FIELDS = Object.freeze(['id', 'createdAt', 'updatedAt']);
export const QUEUE_TASK_FIELDS = Object.freeze(
  Object.keys(normalizeTask({})).filter(key => !EXCLUDED_FIELDS.includes(key)));

const FORBIDDEN_KEYS = new Set(REDACTED_FIELDS.map(name => name.toLowerCase()));

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isScalar(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
    && (typeof value !== 'number' || Number.isFinite(value));
}

/** Suodata kentät sallittuun joukkoon ja vain skalaariarvoihin. */
function cleanFields(source) {
  const out = {};
  if (!isPlainObject(source)) return out;
  for (const key of QUEUE_TASK_FIELDS) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) continue;
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (value === undefined) continue;
    if (isScalar(value)) out[key] = value;
  }
  return out;
}

export function emptyQueue(userId) {
  return { version: QUEUE_VERSION, userId: userId == null ? null : String(userId), seq: 0, ops: [] };
}

/** Kauanko odotetaan ennen seuraavaa yritystä. Eksponentiaalinen, katettu. */
export function backoffMs(retryCount) {
  const n = Math.max(0, Math.min(Number.isInteger(retryCount) ? retryCount : 0, 20));
  return Math.min(BACKOFF_BASE_MS * (2 ** n), BACKOFF_MAX_MS);
}

// ------------------------------------------------------------- operaatio

/**
 * Luo operaatio. Palauttaa { ok:false, reason } jos se ei saa mennä jonoon.
 *
 * @param {object} spec
 * @param {string} spec.id           kutsujan luoma tunniste (idempotenssiavain)
 * @param {string} spec.domain       'tasks'
 * @param {string} spec.operation    'create' | 'update'
 * @param {string} spec.entityId     tehtävän tunniste
 * @param {object} spec.payload      create: koko tehtävä; update: muutetut kentät
 * @param {object} [spec.baseValues] update: kenttien arvot ENNEN muutosta (konfliktintunnistus)
 * @param {number} spec.now          millisekuntia
 */
export function createOperation({ id, domain, operation, entityId, payload, baseValues = {}, now } = {}) {
  if (typeof id !== 'string' || !id || id.length > 100) return { ok: false, reason: 'invalid_id' };
  if (typeof entityId !== 'string' || !entityId || entityId.length > 100) return { ok: false, reason: 'invalid_entity' };

  const allowed = Object.prototype.hasOwnProperty.call(ALLOWED_OPERATIONS, domain) ? ALLOWED_OPERATIONS[domain] : null;
  if (!allowed || !allowed.includes(operation)) return { ok: false, reason: 'operation_not_allowed' };
  if (!Number.isFinite(now)) return { ok: false, reason: 'invalid_time' };

  const cleanPayload = cleanFields(payload);
  if (Object.keys(cleanPayload).length === 0) return { ok: false, reason: 'empty_payload' };
  if (operation === 'create' && !cleanPayload.title) return { ok: false, reason: 'title_required' };
  if (JSON.stringify(cleanPayload).length > MAX_PAYLOAD_CHARS) return { ok: false, reason: 'payload_too_large' };

  return {
    ok: true,
    op: {
      id, seq: null, domain, operation, entityId,
      payload: cleanPayload,
      baseValues: operation === 'update' ? cleanFields(baseValues) : {},
      createdAt: now,
      retryCount: 0,
      status: OP_STATUS.PENDING,
      nextAttemptAt: null,
      lastErrorCode: null,
      conflictFields: [],
      force: false
    }
  };
}

function replaceOp(queue, id, fn) {
  let found = false;
  const ops = queue.ops.map(op => {
    if (op.id !== id) return op;
    found = true;
    return fn(op);
  });
  return found ? { ...queue, ops } : queue;
}

/**
 * Lisää operaatio jonoon. Palauttaa { ok, queue, op, coalesced, reason }.
 *
 * Sama tunniste kahdesti on sama operaatio (idempotentti). Täysi jono
 * EI pudota mitään hiljaa: ok:false, ja kutsuja epäonnistuu näkyvästi.
 * Peräkkäiset muokkaukset samaan riviin yhdistetään, jos edellinen ei
 * ole vielä lähtenyt.
 */
export function enqueue(queue, op) {
  if (queue.ops.some(existing => existing.id === op.id)) {
    return { ok: true, queue, op: queue.ops.find(existing => existing.id === op.id), coalesced: true };
  }

  if (op.operation === 'update') {
    const last = [...queue.ops].reverse().find(item => item.domain === op.domain && item.entityId === op.entityId);
    if (last && last.status === OP_STATUS.PENDING && !last.force) {
      if (last.operation === 'create') {
        const merged = { ...last, payload: { ...last.payload, ...op.payload } };
        return { ok: true, queue: replaceOp(queue, last.id, () => merged), op: merged, coalesced: true };
      }
      if (last.operation === 'update') {
        const merged = {
          ...last,
          payload: { ...last.payload, ...op.payload },
          // Vanhin perusarvo voittaa: se on se, minkä päälle ensimmäinen muutos tehtiin.
          baseValues: { ...op.baseValues, ...last.baseValues }
        };
        return { ok: true, queue: replaceOp(queue, last.id, () => merged), op: merged, coalesced: true };
      }
    }
  }

  if (queue.ops.length >= MAX_OPERATIONS) return { ok: false, queue, reason: 'queue_full' };

  const seq = queue.seq + 1;
  const stored = { ...op, seq };
  return { ok: true, queue: { ...queue, seq, ops: [...queue.ops, stored] }, op: stored, coalesced: false };
}

/**
 * Seuraava ajettava operaatio, tai null.
 *
 * Järjestys on lisäysjärjestys (seq). Operaatio ohitetaan, jos sen
 * odotusaika on kesken TAI jos saman rivin aiempi operaatio on
 * epäonnistunut, ristiriidassa tai käynnissä -- myöhempi muutos ei saa
 * ohittaa aiempaa, josta se riippuu.
 */
export function nextRunnable(queue, nowMs) {
  const ordered = [...queue.ops].sort((a, b) => a.seq - b.seq);
  for (const op of ordered) {
    if (op.status !== OP_STATUS.PENDING) continue;
    if (op.nextAttemptAt !== null && Number.isFinite(nowMs) && op.nextAttemptAt > nowMs) continue;

    const blocked = ordered.some(other =>
      other.seq < op.seq && other.entityId === op.entityId && other.domain === op.domain
      && other.status !== OP_STATUS.PENDING);
    if (blocked) continue;
    return op;
  }
  return null;
}

export function markSyncing(queue, id) {
  return replaceOp(queue, id, op => ({ ...op, status: OP_STATUS.SYNCING }));
}

/** Onnistunut: poistetaan jonosta. Vain vahvistetun onnistumisen jälkeen. */
export function markSucceeded(queue, id) {
  return { ...queue, ops: queue.ops.filter(op => op.id !== id) };
}

/** Verkko/istunto: takaisin odottamaan ilman että yrityksiä kulutetaan. */
export function markPaused(queue, id, code) {
  return replaceOp(queue, id, op => ({ ...op, status: OP_STATUS.PENDING, lastErrorCode: code || null }));
}

/** Tuntematon virhe: kuluta yritys ja aseta odotus; liian monen jälkeen FAILED. */
export function markRetry(queue, id, { code, nowMs } = {}) {
  return replaceOp(queue, id, op => {
    const retryCount = op.retryCount + 1;
    if (retryCount >= MAX_RETRIES) {
      return { ...op, retryCount, status: OP_STATUS.FAILED, nextAttemptAt: null, lastErrorCode: code || 'retries_exhausted' };
    }
    return {
      ...op, retryCount, status: OP_STATUS.PENDING, lastErrorCode: code || null,
      nextAttemptAt: Number.isFinite(nowMs) ? nowMs + backoffMs(retryCount) : null
    };
  });
}

export function markFailed(queue, id, code) {
  return replaceOp(queue, id, op => ({ ...op, status: OP_STATUS.FAILED, nextAttemptAt: null, lastErrorCode: code || 'rejected' }));
}

export function markConflict(queue, id, { fields = [], reason = 'conflict' } = {}) {
  return replaceOp(queue, id, op => ({
    ...op, status: OP_STATUS.CONFLICT, nextAttemptAt: null, lastErrorCode: reason,
    conflictFields: fields.filter(field => QUEUE_TASK_FIELDS.includes(field))
  }));
}

/** Käyttäjän valinta: yritä epäonnistunutta uudelleen. */
export function retryOperation(queue, id) {
  return replaceOp(queue, id, op => op.status === OP_STATUS.FAILED
    ? { ...op, status: OP_STATUS.PENDING, retryCount: 0, nextAttemptAt: null, lastErrorCode: null }
    : op);
}

/** Käyttäjän valinta: käytä minun muutostani palvelimen tilan yli. */
export function resolveKeepMine(queue, id) {
  return replaceOp(queue, id, op => op.status === OP_STATUS.CONFLICT
    ? { ...op, status: OP_STATUS.PENDING, force: true, retryCount: 0, nextAttemptAt: null, conflictFields: [], lastErrorCode: null }
    : op);
}

/** Käyttäjän valinta: hylkää oma muutos. Poistaa operaation. */
export function discardOperation(queue, id) {
  return markSucceeded(queue, id);
}

/** Käynnistyksessä: kesken jääneet (SYNCING) palautetaan odottamaan. Toisto on idempotentti. */
export function recoverInterrupted(queue) {
  return {
    ...queue,
    ops: queue.ops.map(op => op.status === OP_STATUS.SYNCING ? { ...op, status: OP_STATUS.PENDING } : op)
  };
}

export function queueStats(queue) {
  const stats = { total: queue.ops.length, pending: 0, syncing: 0, failed: 0, conflict: 0, needsReview: 0 };
  for (const op of queue.ops) stats[op.status] += 1;
  stats.needsReview = stats.failed + stats.conflict;
  return stats;
}

// ------------------------------------------------------- virheluokitus

const NETWORK_PATTERN = /failed to fetch|network|load failed|fetch failed|timed? ?out|timeout|abort|econn|enotfound|eai_again|offline/i;
const AUTH_PATTERN = /jwt|not authenticated|invalid (token|claim)|token (is )?expired|session (missing|expired)|refresh token/i;

/**
 * Skeemavirheet: taulu tai sarake puuttuu (PostgREST ja PostgreSQL), sekä
 * sovelluksen oma kieltäytyminen kirjoittaa ominaisuuteen, jota kanta ei
 * vielä tue (src/data/schema.js, ERROR_CODE.PERSISTENCE_UNAVAILABLE).
 * 23514 (CHECK) EI ole tässä: se on myös tavallinen validointivirhe.
 */
const SCHEMA_CODES = new Set(['PGRST204', 'PGRST205', '42703', '42P01', 'persistence_unavailable']);

/**
 * Tilapäiset palvelinvirheet. PGRST000-003: kanta ei vastaa tai
 * skeemavälimuistia ladataan. 08: yhteysvirhe. 53: resurssit loppu.
 * 57014/57P01-03: aikakatkaisu tai palvelimen sammutus. 40001/40P01:
 * sarjallistus tai lukkiutuma. 55P03: lukko ei vapautunut.
 */
const UNAVAILABLE_CODES = new Set(['PGRST000', 'PGRST001', 'PGRST002', 'PGRST003',
  '57014', '57P01', '57P02', '57P03', '40001', '40P01', '55P03']);
const UNAVAILABLE_STATUSES = new Set([408, 425, 429]);

/**
 * Luokittele repositorion palauttama virhe.
 *
 * JÄRJESTYS ON SÄÄNTÖ: kaksoiskappale ja istunto ensin, sitten skeema ja
 * tilapäinen häiriö, ja vasta sitten yleinen "palvelin hylkäsi". Aiemmin
 * jokainen PGRST- tai SQLSTATE-koodi oli hylkäys, jolloin hetkellinen 503
 * (PGRST002) tai kannasta puuttuva sarake (PGRST204) pudotti aikakirjauksen
 * pysyvästi ja merkitsi jonotetun tehtävämuutoksen epäonnistuneeksi.
 *
 * @param {unknown} error AppError (`.cause`) tai suora Supabase-virhe
 * @param {{offline?: boolean}} [context]
 */
export function classifyError(error, { offline = false } = {}) {
  const cause = (error && error.cause) || error || {};
  const code = String(cause.code ?? '');
  const status = Number(cause.status ?? 0);
  const message = String(cause.message ?? '');

  if (code === '23505') return ERROR_CLASS.DUPLICATE;
  if (status === 401 || code === 'PGRST301' || code === 'PGRST303' || AUTH_PATTERN.test(message)) return ERROR_CLASS.AUTH;

  if (SCHEMA_CODES.has(code)) return ERROR_CLASS.SCHEMA;
  if (UNAVAILABLE_CODES.has(code) || /^(08|53)[0-9A-Z]{3}$/.test(code)) return ERROR_CLASS.UNAVAILABLE;
  // Tila ilman tunnettua koodia: 5xx ja ruuhkarajat ovat palvelimen häiriö,
  // eivät hylkäys. Jos laite tietää olevansa offline, kyse on verkosta.
  if (status >= 500 || UNAVAILABLE_STATUSES.has(status)) {
    return offline ? ERROR_CLASS.NETWORK : ERROR_CLASS.UNAVAILABLE;
  }

  // Palvelin vastasi jollain SQLSTATE- tai PostgREST-koodilla: hylkäys, ei verkkovirhe.
  if (/^PGRST\d+$/.test(code) || /^[0-9A-Z]{5}$/.test(code) || (status >= 400 && status < 500)) {
    return ERROR_CLASS.REJECTED;
  }

  if (offline || NETWORK_PATTERN.test(message) || (code === '' && !(status >= 400))) {
    return ERROR_CLASS.NETWORK;
  }
  return ERROR_CLASS.UNKNOWN;
}

// ------------------------------------------------- konfliktin ratkaisu

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
 * Päätä, saako muokkauksen lähettää palvelimen nykytilaa vasten.
 *
 * Kolmisuuntainen vertailu kentittäin (perusarvo = mitä käyttäjä näki,
 * palvelin = mitä siellä on nyt, muutos = mitä käyttäjä halusi):
 *
 *   palvelin == muutos           jo tehty (idempotentti onnistuminen)
 *   palvelin == perusarvo        muuttumaton -> lähetä
 *   muuten                       joku muutti tätä -> KONFLIKTI
 *
 * `force` (käyttäjä valitsi "käytä omaani") ohittaa konfliktin.
 *
 * @returns {{action:'apply', patch:object}|{action:'already_applied'}|{action:'conflict', fields:string[]}|{action:'missing'}}
 */
export function decideUpdate({ serverTask, baseValues = {}, changes = {}, force = false }) {
  if (!serverTask) return { action: 'missing' };

  const patch = {};
  const conflicts = [];
  for (const field of Object.keys(changes)) {
    const server = serverTask[field];
    if (sameValue(server, changes[field])) continue;
    if (force || sameValue(server, baseValues[field])) patch[field] = changes[field];
    else conflicts.push(field);
  }

  if (conflicts.length > 0) return { action: 'conflict', fields: conflicts };
  if (Object.keys(patch).length === 0) return { action: 'already_applied' };
  return { action: 'apply', patch };
}

// ------------------------------------------------ näkymän päällekirjoitus

/**
 * Lisää odottavat muutokset palvelimelta ladatun listan päälle.
 *
 * Ilman tätä verkon palautumisen lataus korvaisi paikallisen tilan
 * palvelimen listalla, ja vielä lähettämätön tehtävä katoaisi näkyvistä
 * (vaikka se on tallessa jonossa). Näin käyttäjä näkee oman työnsä
 * kunnes se on oikeasti synkronoitu.
 */
export function overlayPending(tasks, queue, normalize = normalizeTask) {
  const result = Array.isArray(tasks) ? [...tasks] : [];
  const ordered = [...queue.ops].sort((a, b) => a.seq - b.seq);

  for (const op of ordered) {
    if (op.domain !== 'tasks') continue;
    const index = result.findIndex(task => String(task.id) === op.entityId);

    if (op.operation === 'create' && index === -1) {
      result.push(normalize({ ...op.payload, id: op.entityId }));
    } else if (op.operation === 'update' && index !== -1) {
      result[index] = normalize({ ...result[index], ...op.payload, id: op.entityId });
    }
  }
  return result;
}

/** Tunnisteet, joilla on lähettämätön muutos. Käyttöliittymä merkitsee ne odottaviksi. */
export function pendingEntityIds(queue) {
  return new Set(queue.ops.filter(op => op.domain === 'tasks').map(op => op.entityId));
}

// --------------------------------------------------------- sarjallistus

/** Sarjallista tallennusta varten. Sisältää vain kuvatut kentät. */
export function serializeQueue(queue) {
  return JSON.stringify({
    version: QUEUE_VERSION,
    userId: queue.userId,
    seq: queue.seq,
    ops: queue.ops.map(op => ({
      id: op.id, seq: op.seq, domain: op.domain, operation: op.operation, entityId: op.entityId,
      payload: op.payload, baseValues: op.baseValues, createdAt: op.createdAt,
      retryCount: op.retryCount, status: op.status, nextAttemptAt: op.nextAttemptAt,
      lastErrorCode: op.lastErrorCode, conflictFields: op.conflictFields, force: op.force
    }))
  });
}

function validStoredOp(raw) {
  if (!isPlainObject(raw)) return null;
  const created = createOperation({
    id: raw.id, domain: raw.domain, operation: raw.operation, entityId: raw.entityId,
    payload: raw.payload, baseValues: raw.baseValues,
    now: Number.isFinite(raw.createdAt) ? raw.createdAt : NaN
  });
  if (!created.ok) return null;
  if (!OP_STATUSES.includes(raw.status)) return null;
  if (!Number.isInteger(raw.seq) || raw.seq < 1) return null;

  return {
    ...created.op,
    seq: raw.seq,
    status: raw.status,
    retryCount: Number.isInteger(raw.retryCount) ? Math.max(0, Math.min(raw.retryCount, MAX_RETRIES)) : 0,
    nextAttemptAt: Number.isFinite(raw.nextAttemptAt) ? raw.nextAttemptAt : null,
    lastErrorCode: typeof raw.lastErrorCode === 'string' ? raw.lastErrorCode.slice(0, 60) : null,
    conflictFields: Array.isArray(raw.conflictFields)
      ? raw.conflictFields.filter(field => QUEUE_TASK_FIELDS.includes(field)) : [],
    force: raw.force === true
  };
}

/**
 * Lue jono tallennuksesta.
 *
 * KÄYTTÄJÄRAJA: tallennettu jono kuuluu yhdelle käyttäjälle. Jos
 * tallennuksen userId ei täsmää odotettuun, palautetaan TYHJÄ jono
 * eikä toisen käyttäjän työtä koskaan lähetetä tämän tilillä.
 *
 * Rikkinäinen tai peukaloitu sisältö ei kaada: kelvottomat operaatiot
 * pudotetaan ja niiden määrä palautetaan, muu jono säilyy.
 *
 * @returns {{queue:object, dropped:number, reason:string|null}}
 */
export function parseQueue(text, { userId } = {}) {
  const fresh = emptyQueue(userId);
  if (typeof text !== 'string' || !text) return { queue: fresh, dropped: 0, reason: null };

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { queue: fresh, dropped: 0, reason: 'unreadable' };
  }
  if (!isPlainObject(raw) || raw.version !== QUEUE_VERSION || !Array.isArray(raw.ops)) {
    return { queue: fresh, dropped: 0, reason: 'unsupported_version' };
  }
  if (userId == null || raw.userId !== String(userId)) {
    return { queue: fresh, dropped: raw.ops.length, reason: 'wrong_user' };
  }

  const seen = new Set();
  const ops = [];
  let dropped = 0;
  for (const item of raw.ops.slice(0, MAX_OPERATIONS * 2)) {
    const op = validStoredOp(item);
    if (!op || seen.has(op.id)) { dropped += 1; continue; }
    seen.add(op.id);
    ops.push(op);
  }
  ops.sort((a, b) => a.seq - b.seq);
  if (ops.length > MAX_OPERATIONS) {
    dropped += ops.length - MAX_OPERATIONS;
    ops.length = MAX_OPERATIONS;
  }

  const seq = Math.max(Number.isInteger(raw.seq) ? raw.seq : 0, ...ops.map(op => op.seq), 0);
  return { queue: recoverInterrupted({ version: QUEUE_VERSION, userId: fresh.userId, seq, ops }), dropped, reason: null };
}

// ---------------------------------------------------------- tilaviesti

/**
 * Käyttäjälle näytettävä yhden rivin tila. Tyhjä merkkijono = ei näytettävää.
 *
 * REHELLISYYS: odottava muutos EI ole palvelimen vahvistama, ja viesti
 * sanoo sen ("odottaa synkronointia"). Viestit eivät toistu joka
 * yrityksellä: sama tila tuottaa saman rivin, joten käyttöliittymä
 * päivittyy vain kun tila oikeasti muuttuu.
 *
 * @param {{pending:number, syncing:number, failed:number, conflict:number, persistent?:boolean}} stats
 * @param {{online:boolean, replaying?:boolean}} context
 * @returns {{text:string, tone:'none'|'info'|'warn'|'error', needsReview:boolean}}
 */
export function describeQueueStatus(stats, { online = true, replaying = false } = {}) {
  const waiting = stats.pending + stats.syncing;
  const review = stats.failed + stats.conflict;
  const plural = n => (n === 1 ? '1 muutos' : `${n} muutosta`);
  const note = stats.persistent === false ? ' (ei säily sivun latauksen yli)' : '';

  if (review > 0) {
    const parts = [];
    if (stats.conflict > 0) parts.push(`Vaatii tarkistuksen (${stats.conflict})`);
    if (stats.failed > 0) parts.push(`Synkronointi epäonnistui (${stats.failed})`);
    return { text: parts.join(' · ') + note, tone: stats.failed > 0 ? 'error' : 'warn', needsReview: true };
  }
  if (waiting === 0) return { text: '', tone: 'none', needsReview: false };
  if (replaying || stats.syncing > 0) return { text: 'Synkronoidaan…', tone: 'info', needsReview: false };
  if (!online) return { text: `Offline · ${plural(waiting)} odottaa synkronointia${note}`, tone: 'warn', needsReview: false };
  return { text: `${plural(waiting)} odottaa synkronointia${note}`, tone: 'info', needsReview: false };
}
