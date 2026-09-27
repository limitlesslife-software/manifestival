// Arjen lähtökori: menojen ja tapakirjausten tallennukset, jotka odottavat
// verkkoa.
//
// PUHDAS MODUULI. Ei DOM:ia, ei verkkoa, ei kelloa, ei satunnaisuutta, ei
// tallennusta. Jokainen funktio palauttaa UUDEN korin eikä muuta annettua.
// Kellonaika ja tunnisteet annetaan parametreina.
//
// =====================================================================
// MIKSI OMA KORI EIKÄ TEHTÄVIEN JONO
// =====================================================================
//
// Tehtävien offline-jono (offlineQueue.js) on rakennettu tehtävän kenttien
// ympärille (kenttälista, kolmisuuntainen vertailu tehtävää vasten, overlay
// normalizeTaskilla). Sen yleistäminen muuttaisi jo käytössä olevaa ja
// testattua polkua. Tämä kori antaa SAMAT TAKUUT kahdelle arjen
// kirjoitukselle ja on muuten erillinen:
//
//   calendarEvents.create   menon lisäys (tunniste luodaan laitteella:
//                           toisto on turvallinen, sama rivi, ei kaksi)
//   calendarEvents.update   menon muokkaus
//   habitEvents.create      tapakirjaus (käyttö, siirto, ohitus)
//
// EI KOSKAAN: poistot, talous, tekoälyn komennot, asetukset, paikat
// (FORBIDDEN_OUTBOX_OPERATIONS). Niiden viivästetty toisto voisi tehdä
// vahinkoa vanhentuneen päätöksen perusteella.
//
// TAKUUT
//   - rajattu: enintään MAX_OUTBOX_OPS operaatiota, täysi kori ei pudota
//     mitään hiljaa (ok:false, kutsuja epäonnistuu näkyvästi)
//   - saman rivin peräkkäiset tallennukset yhdistyvät: kaksi tallennusta
//     samasta menosta on yksi operaatio uusimmalla sisällöllä
//   - käyttäjäraja: kori kuuluu yhdelle käyttäjälle (parseOutbox)
//   - konfliktia ei ratkaista arvaamalla: muokkaus lähetetään vain, jos
//     palvelimen rivi on yhä sellainen kuin se oli muokatessa (decideOutboxUpdate)
//   - ei salaisuuksia: vain entiteetin omat kentät (ei user_id, ei tokeneita)

import { normalizeCalendarEvent } from './calendarEvent.js';
import { normalizeHabitEvent } from './habit.js';

export const OUTBOX_VERSION = 1;

export const OUTBOX_STATUS = Object.freeze({
  PENDING: 'pending',
  /** Yritykset loppuivat tai palvelin hylkäsi: näkyy käyttäjälle, ei katoa. */
  FAILED: 'failed'
});

export const OUTBOX_STATUSES = Object.freeze(Object.values(OUTBOX_STATUS));

/** Sallitut (taulu, operaatio) -parit. Tämä lista ON turvamalli. */
export const OUTBOX_ALLOWED = Object.freeze({
  calendarEvents: Object.freeze(['create', 'update']),
  habitEvents: Object.freeze(['create'])
});

/** Operaatiot, joita ei koskaan koriin laiteta. Dokumentaatio ja testattava invariantti. */
export const FORBIDDEN_OUTBOX_OPERATIONS = Object.freeze([
  'delete', 'remove', 'finance', 'ai_command', 'account_deletion', 'account_settings', 'life_settings', 'places'
]);

export const MAX_OUTBOX_OPS = 200;
export const MAX_OUTBOX_RETRIES = 5;
export const MAX_OUTBOX_PAYLOAD_CHARS = 16000;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

const NORMALIZERS = Object.freeze({
  calendarEvents: normalizeCalendarEvent,
  habitEvents: normalizeHabitEvent
});

/** Kentät, jotka eivät kuulu koriin: palvelin omistaa aikaleimat. */
const EXCLUDED_FIELDS = new Set(['createdAt', 'updatedAt']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAllowed(table, operation) {
  return Object.prototype.hasOwnProperty.call(OUTBOX_ALLOWED, table) && OUTBOX_ALLOWED[table].includes(operation);
}

/** Entiteetti normalisoituna, vain omat kentät ja vain skalaarit tai skalaaritaulukot. */
export function outboxPayload(table, entity) {
  const normalize = NORMALIZERS[table];
  if (!normalize || !isPlainObject(entity)) return null;
  const normalized = normalize(entity);
  const out = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (EXCLUDED_FIELDS.has(key)) continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      if (typeof value === 'number' && !Number.isFinite(value)) continue;
      out[key] = value;
    } else if (Array.isArray(value) && value.every(item => ['string', 'number'].includes(typeof item))) {
      out[key] = [...value];
    }
  }
  return typeof out.id === 'string' && ID_PATTERN.test(out.id) ? out : null;
}

export function emptyOutbox(userId) {
  return { version: OUTBOX_VERSION, userId: userId == null ? null : String(userId), seq: 0, ops: [] };
}

export function outboxBackoffMs(retryCount) {
  const n = Math.max(0, Math.min(Number.isInteger(retryCount) ? retryCount : 0, 20));
  return Math.min(BACKOFF_BASE_MS * (2 ** n), BACKOFF_MAX_MS);
}

/**
 * Luo operaatio. { ok:false, reason } jos se ei saa mennä koriin.
 *
 * @param {object} spec
 * @param {string} spec.id        kutsujan luoma tunniste
 * @param {string} spec.table     'calendarEvents' | 'habitEvents'
 * @param {string} spec.operation 'create' | 'update'
 * @param {object} spec.entity    koko entiteetti (tunniste luotu laitteella)
 * @param {object} [spec.base]    update: entiteetti ennen muutosta (konfliktintunnistus)
 * @param {number} spec.now       millisekuntia
 */
export function createOutboxOperation({ id, table, operation, entity, base = null, now } = {}) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return { ok: false, reason: 'invalid_id' };
  if (!isAllowed(table, operation)) return { ok: false, reason: 'operation_not_allowed' };
  if (!Number.isFinite(now)) return { ok: false, reason: 'invalid_time' };
  const payload = outboxPayload(table, entity);
  if (!payload) return { ok: false, reason: 'invalid_entity' };
  const basePayload = operation === 'update' && base ? outboxPayload(table, base) : null;
  if (JSON.stringify({ payload, basePayload }).length > MAX_OUTBOX_PAYLOAD_CHARS) {
    return { ok: false, reason: 'payload_too_large' };
  }
  return {
    ok: true,
    op: {
      id, seq: null, table, operation, entityId: payload.id,
      payload, base: basePayload,
      createdAt: now, retryCount: 0, status: OUTBOX_STATUS.PENDING, nextAttemptAt: null, lastErrorCode: null
    }
  };
}

function replaceOp(outbox, id, fn) {
  let found = false;
  const ops = outbox.ops.map(op => {
    if (op.id !== id) return op;
    found = true;
    return fn(op);
  });
  return found ? { ...outbox, ops } : outbox;
}

/**
 * Lisää operaatio koriin. { ok, outbox, op, coalesced, reason }.
 *
 * Saman rivin odottava operaatio yhdistetään: luonti + muokkaus = luonti
 * uusimmalla sisällöllä, muokkaus + muokkaus = muokkaus uusimmalla
 * sisällöllä ja vanhimmalla perusarvolla (sen päälle ensimmäinen muutos
 * tehtiin). Sama tunniste kahdesti on sama operaatio (idempotentti).
 */
export function enqueueOutbox(outbox, op) {
  if (outbox.ops.some(existing => existing.id === op.id)) {
    return { ok: true, outbox, op: outbox.ops.find(existing => existing.id === op.id), coalesced: true };
  }
  const last = [...outbox.ops].reverse()
    .find(item => item.table === op.table && item.entityId === op.entityId);
  if (last && last.status === OUTBOX_STATUS.PENDING && op.table === 'calendarEvents') {
    const merged = {
      ...last,
      payload: op.payload,
      base: last.operation === 'update' ? (last.base || op.base) : null,
      retryCount: 0,
      nextAttemptAt: null
    };
    return { ok: true, outbox: replaceOp(outbox, last.id, () => merged), op: merged, coalesced: true };
  }
  if (last && op.operation === 'create' && op.table === 'habitEvents') {
    // Sama kirjaus uudelleen: tunniste on sama, joten rivi on sama.
    return { ok: true, outbox, op: last, coalesced: true };
  }
  if (outbox.ops.length >= MAX_OUTBOX_OPS) return { ok: false, outbox, reason: 'outbox_full' };
  const seq = outbox.seq + 1;
  const stored = { ...op, seq };
  return { ok: true, outbox: { ...outbox, seq, ops: [...outbox.ops, stored] }, op: stored, coalesced: false };
}

/** Seuraava ajettava operaatio lisäysjärjestyksessä, tai null. */
export function nextOutboxRunnable(outbox, nowMs) {
  const ordered = [...outbox.ops].sort((a, b) => a.seq - b.seq);
  for (const op of ordered) {
    if (op.status !== OUTBOX_STATUS.PENDING) continue;
    if (op.nextAttemptAt !== null && Number.isFinite(nowMs) && op.nextAttemptAt > nowMs) continue;
    return op;
  }
  return null;
}

/** Onnistunut (tai tarpeeton): pois korista. */
export function removeOutboxOp(outbox, id) {
  return { ...outbox, ops: outbox.ops.filter(op => op.id !== id) };
}

/** Kuluta yritys ja aseta odotus; liian monen jälkeen FAILED (säilyy, näkyy). */
export function retryOutboxOp(outbox, id, { code, nowMs } = {}) {
  return replaceOp(outbox, id, op => {
    const retryCount = op.retryCount + 1;
    if (retryCount >= MAX_OUTBOX_RETRIES) {
      return { ...op, retryCount, status: OUTBOX_STATUS.FAILED, nextAttemptAt: null, lastErrorCode: code || 'retries_exhausted' };
    }
    return {
      ...op, retryCount, lastErrorCode: code || null,
      nextAttemptAt: Number.isFinite(nowMs) ? nowMs + outboxBackoffMs(retryCount) : null
    };
  });
}

/** Palvelin hylkäsi pysyvästi. Säilyy korissa FAILED-tilassa: käyttäjän työtä ei hävitetä hiljaa. */
export function failOutboxOp(outbox, id, code) {
  return replaceOp(outbox, id, op => ({ ...op, status: OUTBOX_STATUS.FAILED, nextAttemptAt: null, lastErrorCode: code || 'rejected' }));
}

/** Verkko katkesi kesken: odottamaan ilman että yrityksiä kulutetaan. */
export function pauseOutboxOp(outbox, id, code) {
  return replaceOp(outbox, id, op => ({ ...op, lastErrorCode: code || null }));
}

/** Pudota rivin odottavat operaatiot (rivi poistettiin: sitä ei saa herättää henkiin). */
export function forgetOutboxEntity(outbox, table, entityId) {
  return { ...outbox, ops: outbox.ops.filter(op => !(op.table === table && op.entityId === entityId)) };
}

export function outboxStats(outbox) {
  const stats = { pending: 0, failed: 0, total: outbox.ops.length };
  for (const op of outbox.ops) {
    if (op.status === OUTBOX_STATUS.FAILED) stats.failed += 1;
    else stats.pending += 1;
  }
  return stats;
}

function sameValue(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = Array.isArray(a) ? a : [];
    const y = Array.isArray(b) ? b : [];
    return x.length === y.length && x.every((value, i) => String(value) === String(y[i]));
  }
  const empty = value => value === null || value === undefined || value === '';
  return empty(a) && empty(b);
}

/**
 * Saako menon muokkauksen lähettää palvelimen nykytilaa vasten?
 *
 *   palvelimella ei riviä             'missing' (poistettu muualla: ei herätetä)
 *   muutetut kentät = palvelin         'already_applied'
 *   palvelin = perusarvo muutetuissa   'apply' (palvelimen muut kentät säilyvät)
 *   muuten                             'conflict' (joku muutti samaa kenttää)
 *
 * @returns {{action:string, fields?:string[], merged?:object}}
 */
export function decideOutboxUpdate({ server, op }) {
  if (!server) return { action: 'missing' };
  const payload = op.payload || {};
  const base = op.base || null;
  const serverPayload = outboxPayload(op.table, server) || {};
  const fields = Object.keys(payload).filter(key => key !== 'id' && (!base || !sameValue(payload[key], base[key])));
  if (fields.every(key => sameValue(serverPayload[key], payload[key]))) return { action: 'already_applied', fields };
  if (!base) return { action: 'apply', fields, merged: { ...serverPayload, ...payload } };
  const conflicts = fields.filter(key => !sameValue(serverPayload[key], base[key]) && !sameValue(serverPayload[key], payload[key]));
  if (conflicts.length > 0) return { action: 'conflict', fields: conflicts };
  const merged = { ...serverPayload };
  for (const key of fields) merged[key] = payload[key];
  return { action: 'apply', fields, merged };
}

/**
 * Odottavat operaatiot ladattujen rivien päälle, jotta lähettämätön meno
 * tai kirjaus ei katoa näkyvistä uudelleenlatauksessa.
 */
export function overlayOutbox(rows, outbox, table) {
  const normalize = NORMALIZERS[table];
  const result = Array.isArray(rows) ? [...rows] : [];
  if (!normalize) return result;
  for (const op of [...outbox.ops].sort((a, b) => a.seq - b.seq)) {
    if (op.table !== table) continue;
    const index = result.findIndex(row => row && String(row.id) === op.entityId);
    if (index === -1) result.push(normalize({ ...op.payload }));
    else result[index] = normalize({ ...result[index], ...op.payload });
  }
  return result;
}

// --------------------------------------------------------- sarjallistus

export function serializeOutbox(outbox) {
  return JSON.stringify({
    version: OUTBOX_VERSION,
    userId: outbox.userId,
    seq: outbox.seq,
    ops: outbox.ops.map(op => ({
      id: op.id, seq: op.seq, table: op.table, operation: op.operation, entityId: op.entityId,
      payload: op.payload, base: op.base, createdAt: op.createdAt, retryCount: op.retryCount,
      status: op.status, nextAttemptAt: op.nextAttemptAt, lastErrorCode: op.lastErrorCode
    }))
  });
}

function validStoredOp(raw) {
  if (!isPlainObject(raw)) return null;
  const created = createOutboxOperation({
    id: raw.id, table: raw.table, operation: raw.operation, entity: raw.payload, base: raw.base,
    now: Number.isFinite(raw.createdAt) ? raw.createdAt : NaN
  });
  if (!created.ok || created.op.entityId !== raw.entityId) return null;
  if (!OUTBOX_STATUSES.includes(raw.status)) return null;
  if (!Number.isInteger(raw.seq) || raw.seq < 1) return null;
  return {
    ...created.op,
    seq: raw.seq,
    status: raw.status,
    retryCount: Number.isInteger(raw.retryCount) ? Math.max(0, Math.min(raw.retryCount, MAX_OUTBOX_RETRIES)) : 0,
    nextAttemptAt: Number.isFinite(raw.nextAttemptAt) ? raw.nextAttemptAt : null,
    lastErrorCode: typeof raw.lastErrorCode === 'string' ? raw.lastErrorCode.slice(0, 60) : null
  };
}

/**
 * Lue kori tallennuksesta. KÄYTTÄJÄRAJA: toisen käyttäjän kori on tyhjä
 * kori. Rikkinäinen sisältö ei kaada; kelvottomat operaatiot pudotetaan.
 *
 * @returns {{outbox:object, dropped:number, reason:string|null}}
 */
export function parseOutbox(text, { userId } = {}) {
  const fresh = emptyOutbox(userId);
  if (typeof text !== 'string' || !text) return { outbox: fresh, dropped: 0, reason: null };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { outbox: fresh, dropped: 0, reason: 'unreadable' };
  }
  if (!isPlainObject(raw) || raw.version !== OUTBOX_VERSION || !Array.isArray(raw.ops)) {
    return { outbox: fresh, dropped: 0, reason: 'unsupported_version' };
  }
  if (userId == null || raw.userId !== String(userId)) {
    return { outbox: fresh, dropped: raw.ops.length, reason: 'wrong_user' };
  }
  const seen = new Set();
  const ops = [];
  let dropped = 0;
  for (const item of raw.ops.slice(0, MAX_OUTBOX_OPS * 2)) {
    const op = validStoredOp(item);
    if (!op || seen.has(op.id)) { dropped += 1; continue; }
    seen.add(op.id);
    ops.push(op);
  }
  ops.sort((a, b) => a.seq - b.seq);
  if (ops.length > MAX_OUTBOX_OPS) {
    dropped += ops.length - MAX_OUTBOX_OPS;
    ops.length = MAX_OUTBOX_OPS;
  }
  const seq = Math.max(Number.isInteger(raw.seq) ? raw.seq : 0, ...ops.map(op => op.seq), 0);
  return { outbox: { version: OUTBOX_VERSION, userId: fresh.userId, seq, ops }, dropped, reason: null };
}
