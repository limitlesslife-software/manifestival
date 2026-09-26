// Käynnistyksen skeematarkistus: VAIN LUKEVA, aikarajattu, välimuistitettu.
//
// MITÄ TÄMÄ TEKEE
//
// Kirjautumisen jälkeen ja ennen ensimmäistä latausta kysytään kannalta,
// ovatko ne taulut ja sarakkeet olemassa, joihin tämä käännös aikoo
// kirjoittaa (src/data/schema.js, SCHEMA_REQUIREMENTS). Yksi GET per taulu:
//
//   from(taulu).select('sarake1,sarake2,...').limit(0)
//
// Rivejä ei palaudu (limit 0), mitään ei kirjoiteta, eikä käyttäjän
// tietoa kulje verkossa. head:true EI kelpaa: HEAD-vastauksessa ei ole
// runkoa, jolloin PostgRESTin virhekoodi katoaisi. Tila luetaan
// vastauksesta, ei virheoliosta (supabase-js pitää sen vastauksessa).
//
// TURVALLISET OLETUKSET
//
//   - Offline: ei yhtään pyyntöä. Käytetään välimuistia tai käännösaikaisia
//     portteja. Käynnistys ei koskaan odota verkkoa.
//   - Verkkovirhe, 5xx, aikakatkaisu tai istuntovirhe = "ei tiedetä":
//     mitään ei lasketa. Väärä hälytys ei saa sulkea toimivaa ominaisuutta.
//   - Tuore välimuisti samalle vaatimusjoukolle ja palvelimelle: käytetään
//     heti ja tarkistetaan taustalla.
//   - Tarkistus voi vain LASKEA portteja (ks. schemaRuntime.js).
//
// Lokiin menee vain lukumääriä ja migraatiotunnisteita, ei taulujen tai
// sarakkeiden nimiä eikä virheviestejä.

import { getClient } from './client.js';
import { SUPABASE_URL } from './config.js';
import { COMPILE_GATES, openRequirements, recomputeSchemaCapabilities } from './schema.js';
import {
  recordProbeResults, schemaSnapshot, isVerified, isFailure, computeCapabilities,
  PROBE_RESULT, SCHEMA_STATUS
} from './schemaRuntime.js';
import { logEvent } from '../lib/logger.js';

export const SCHEMA_PROBE_TIMEOUT_MS = 4000;
/** Välimuisti on tuore vuorokauden; sen jälkeen tarkistus odotetaan (aikarajalla). */
export const SCHEMA_CACHE_FRESH_MS = 24 * 60 * 60 * 1000;
/** Taustatarkistukselle annetaan enemmän aikaa: kukaan ei odota sitä. */
const BACKGROUND_TIMEOUT_MS = 15000;
const CACHE_PREFIX = 'manifestival.schemaCompat.v1.';
/** Välimuistiin vain varmat tulokset. Kielto (42501) ei jää talteen. */
const CACHEABLE = new Set([PROBE_RESULT.OK, PROBE_RESULT.MISSING_TABLE, PROBE_RESULT.MISSING_COLUMN]);

/**
 * Tarkistusvastauksen luokitus. Vain puuttuva taulu, puuttuva sarake ja
 * kielletty ovat varmoja; kaikki muu on "ei tiedetä".
 *
 * Päätös tehdään PostgRESTin KOODISTA, ei HTTP-tilasta: pelkkä 404 voi
 * tulla välityspalvelimelta eikä todista taulun puuttumista. Siksi
 * koodition vastaus on aina "ei tiedetä", olipa tila mikä tahansa.
 *
 * @param {object|null} error PostgREST-virhe ({code, message})
 */
export function classifyProbeError(error) {
  if (!error) return PROBE_RESULT.OK;
  const code = String(error.code || '');
  if (code === 'PGRST205' || code === '42P01') return PROBE_RESULT.MISSING_TABLE;
  if (code === '42703' || code === 'PGRST204') return PROBE_RESULT.MISSING_COLUMN;
  if (code === '42501') return PROBE_RESULT.FORBIDDEN;
  // PGRST301/303 ja 401 (istunto), PGRST000-003 ja 5xx (palvelin),
  // verkko ja keskeytys: ei tiedetä.
  return PROBE_RESULT.UNKNOWN;
}

/**
 * Aja tarkistus annetuille vaatimuksille. EI kirjoita tilaan.
 *
 * Yksi pyyntö per taulu (sarakkeet yhdistettynä). Jos yhdistetty pyyntö
 * kertoo puuttuvasta sarakkeesta, sama taulu tarkistetaan vaatimus
 * kerrallaan, jotta tiedetään MIKÄ joukko puuttuu.
 *
 * @returns {Promise<{results: Record<string,string>, requests: number, timedOut: boolean}>}
 */
export async function probeSchema({ client, requirements, timeoutMs = SCHEMA_PROBE_TIMEOUT_MS } = {}) {
  const results = {};
  for (const requirement of requirements) results[requirement.id] = PROBE_RESULT.UNKNOWN;
  let requests = 0;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;

  const byTable = new Map();
  for (const requirement of requirements) {
    if (!byTable.has(requirement.table)) byTable.set(requirement.table, []);
    byTable.get(requirement.table).push(requirement);
  }

  async function select(table, columns) {
    requests += 1;
    try {
      let query = client.from(table).select(columns.join(',')).limit(0);
      if (controller && typeof query.abortSignal === 'function') query = query.abortSignal(controller.signal);
      const response = await query;
      return classifyProbeError(response && response.error);
    } catch {
      return PROBE_RESULT.UNKNOWN;
    }
  }

  const work = Promise.all([...byTable].map(async ([table, group]) => {
    const columns = [...new Set(group.flatMap(requirement => requirement.columns))];
    const combined = await select(table, columns);
    if (combined !== PROBE_RESULT.MISSING_COLUMN || group.length === 1) {
      for (const requirement of group) results[requirement.id] = combined;
      return;
    }
    await Promise.all(group.map(async requirement => {
      results[requirement.id] = await select(table, requirement.columns);
    }));
  }));

  let timer = null;
  const expired = new Promise(resolve => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs));
  });
  const outcome = await Promise.race([work.then(() => 'done', () => 'done'), expired]);
  clearTimeout(timer);
  if (outcome === 'timeout' && controller) {
    try { controller.abort(); } catch { /* ignore */ }
  }
  // Kopio: aikarajan jälkeen valmistuvat vastaukset eivät enää muuta tulosta.
  return { results: { ...results }, requests, timedOut: outcome === 'timeout' };
}

// ------------------------------------------------------------ välimuisti

function defaultStorage() {
  try {
    return typeof globalThis !== 'undefined' && globalThis.localStorage ? globalThis.localStorage : null;
  } catch {
    return null;
  }
}

function defaultIsOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function supabaseHost() {
  try { return new URL(SUPABASE_URL).host; } catch { return ''; }
}

/** FNV-1a 32 bit: lyhyt, deterministinen tunniste vaatimusjoukolle. */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Välimuistin avain: palvelin + TÄMÄN käännöksen vaatimukset. Eri käännös
 * (eri portit) tai eri palvelin ei koskaan lue toisen tulosta.
 */
export function schemaCacheKey(requirements, host = supabaseHost()) {
  const manifest = requirements.map(requirement =>
    `${requirement.id}:${requirement.table}:${requirement.columns.join(',')}`).join(';');
  return CACHE_PREFIX + hash(host + '|' + manifest);
}

function readCache(storage, key) {
  if (!storage) return null;
  try {
    const raw = JSON.parse(storage.getItem(key) || 'null');
    if (!raw || raw.v !== 1 || typeof raw.results !== 'object' || !Number.isFinite(raw.checkedAt)) return null;
    const results = {};
    for (const [id, result] of Object.entries(raw.results)) {
      if (CACHEABLE.has(result)) results[id] = result;
    }
    return { checkedAt: raw.checkedAt, results, status: String(raw.status || '') };
  } catch {
    return null;
  }
}

function writeCache(storage, key, previous, results, checkedAt, status) {
  if (!storage) return;
  const merged = { ...(previous ? previous.results : {}) };
  for (const [id, result] of Object.entries(results)) {
    if (CACHEABLE.has(result)) merged[id] = result;
  }
  try {
    storage.setItem(key, JSON.stringify({ v: 1, checkedAt, status, results: merged }));
  } catch { /* kiintiö tai yksityinen tila: tarkistetaan ensi kerralla uudelleen */ }
}

// -------------------------------------------------------- orkestrointi

function apply(results, from) {
  const definite = recordProbeResults(results, { from });
  recomputeSchemaCapabilities();
  return definite;
}

function count(results, predicate) {
  return Object.values(results).filter(predicate).length;
}

function logProbe(outcome, requirements, results, extra = {}) {
  const missing = requirements.filter(requirement => isFailure(results[requirement.id]));
  logEvent('schema.probe', {
    outcome,
    status: schemaSnapshot().status,
    checked: requirements.length,
    missing: missing.length,
    unknown: count(results, result => result === PROBE_RESULT.UNKNOWN),
    first: missing.length ? missing.map(requirement => requirement.migration).sort()[0] : null,
    ...extra
  });
}

let inFlight = null;
let revalidating = null;

async function probeAndApply(context, timeoutMs, outcome) {
  const { client, requirements, storage, key, cached, now, compile } = context;
  let probed;
  try {
    probed = await probeSchema({ client: client || getClient(), requirements, timeoutMs });
  } catch {
    probed = { results: {}, requests: 0, timedOut: false };
  }
  const definite = apply(probed.results, 'probe');
  if (definite > 0) {
    const status = computeCapabilities({
      requirements, compile, results: probed.results, verified: true
    }).status;
    writeCache(storage, key, cached, probed.results, now(), status);
  } else if (cached) {
    // Ei yhtään varmaa vastausta: vanhakin tieto on parempi kuin ei mitään
    // (se voi vain laskea portteja).
    apply(cached.results, 'cache');
  }
  logProbe(outcome, requirements, probed.results, { requests: probed.requests, timedOut: probed.timedOut });
  return probed;
}

/**
 * Varmista, että käännöksen portit vastaavat kantaa. EI koskaan heitä.
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs] odotuksen yläraja (oletus 4 s)
 * @param {boolean} [options.force] ohita tuore välimuisti (uudelleentarkistus)
 * @param {boolean} [options.onlyIfUnverified] älä tee mitään, jos kanta on jo
 *   vastannut tarkistukseen tässä istunnossa (välimuisti ei riitä)
 * @param {boolean} [options.background] tuoreen välimuistin taustatarkistus (oletus true)
 * @param {object} [options.client] Supabase-asiakas (oletus getClient())
 * @param {() => boolean} [options.isOnline]
 * @param {Storage|null} [options.storage]
 * @param {() => number} [options.now]
 * @param {string} [options.host]
 * @returns {Promise<object>} schemaSnapshot() + { outcome }
 */
export function ensureSchemaCompatibility(options = {}) {
  if (inFlight) return inFlight;
  inFlight = run(options)
    .catch(() => ({ ...schemaSnapshot(), outcome: 'error' }))
    .finally(() => { inFlight = null; });
  return inFlight;
}

async function run({
  timeoutMs = SCHEMA_PROBE_TIMEOUT_MS, force = false, onlyIfUnverified = false, background = true,
  client = null, isOnline = defaultIsOnline, storage = defaultStorage(), now = () => Date.now(),
  host = supabaseHost()
} = {}) {
  // "Tarkistettu" = kanta on vastannut tässä istunnossa. Offline-käynnistyksen
  // välimuisti ei riitä: verkon palattua tarkistetaan kerran oikeasti.
  if (onlyIfUnverified && isVerified() && schemaSnapshot().source === 'probe') {
    return { ...schemaSnapshot(), outcome: 'skipped' };
  }

  const compile = COMPILE_GATES;
  const requirements = openRequirements(compile);
  const key = schemaCacheKey(requirements, host);
  const cached = readCache(storage, key);
  const context = { client, requirements, storage, key, cached, now, compile };

  if (!isOnline()) {
    if (cached) apply(cached.results, 'cache');
    logProbe('offline', requirements, cached ? cached.results : {});
    return { ...schemaSnapshot(), outcome: 'offline' };
  }

  const fresh = cached && now() - cached.checkedAt >= 0 && now() - cached.checkedAt < SCHEMA_CACHE_FRESH_MS;
  if (!force && fresh && cached.status !== SCHEMA_STATUS.MAINTENANCE) {
    apply(cached.results, 'cache');
    if (background && !revalidating) {
      revalidating = probeAndApply(context, BACKGROUND_TIMEOUT_MS, 'revalidate')
        .catch(() => null)
        .finally(() => { revalidating = null; });
    }
    return { ...schemaSnapshot(), outcome: 'cache' };
  }

  await probeAndApply(context, timeoutMs, force ? 'reprobe' : 'probe');
  return { ...schemaSnapshot(), outcome: 'probe' };
}

/** Testejä ja diagnostiikkaa varten: käynnissä oleva taustatarkistus tai null. */
export function schemaRevalidation() {
  return revalidating;
}

// ------------------------------------------------ uudelleentarkistus

export const SCHEMA_REPROBE_MIN_INTERVAL_MS = 30000;
let lastReprobeAt = -Infinity;
let reprobeTimer = null;

/**
 * Ajasta uusi tarkistus (kanta vastasi skeemavirheellä). Rajoitettu:
 * enintään yksi odottava ja vähintään 30 s väli, joten toistuva virhe ei
 * tuota pyyntövyöryä.
 *
 * @returns {Promise<object>|null} valmistuva tarkistus, tai null jos yksi jo odottaa
 */
export function scheduleSchemaReprobe({
  delayMs = 1000, minIntervalMs = SCHEMA_REPROBE_MIN_INTERVAL_MS, now = () => Date.now(), ...options
} = {}) {
  if (reprobeTimer) return null;
  const wait = Math.max(delayMs, lastReprobeAt + minIntervalMs - now(), 0);
  return new Promise(resolve => {
    reprobeTimer = setTimeout(() => {
      reprobeTimer = null;
      lastReprobeAt = now();
      ensureSchemaCompatibility({ ...options, force: true, background: false }).then(resolve);
    }, wait);
    if (reprobeTimer && typeof reprobeTimer.unref === 'function') reprobeTimer.unref();
  });
}

/** Testejä varten. */
export function resetSchemaProbeForTests() {
  if (reprobeTimer) clearTimeout(reprobeTimer);
  reprobeTimer = null;
  lastReprobeAt = -Infinity;
  inFlight = null;
  revalidating = null;
}
