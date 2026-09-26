// Tilin poisto: palvelinpuolen päätepiste (Supabase Edge Function).
//
// TÄMÄ ON AINOA PAIKKA, JOSSA KOROTETTU (service-role/secret) OIKEUS ELÄÄ.
// Se ei ole selaimessa, ei Vercelin api/-hakemistossa eikä missään
// repositoriossa: Supabase injektoi sen funktion ympäristöön ajohetkellä.
// Selain lähettää vain käyttäjän omat istuntotunnisteen (Bearer JWT).
//
// TÄMÄ TIEDOSTO ON PUHDAS JS RIIPPUVUUKSILLA INJEKTOITUNA (createClient,
// env, log) jotta se voidaan testata Nodessa ilman Denoa tai oikeaa
// Supabasea. Deno-liima on index.ts.
//
// TURVAMALLI
//   1. Kutsuja tunnistetaan Bearer JWT:stä PALVELIMELLA (auth.getUser).
//      Käyttäjän tunniste tulee TÄSTÄ, ei koskaan pyynnön rungosta.
//   2. Rungossa saa olla vain sallitut kentät. Mikä tahansa muu
//      (userId, user_id, id, ...) hylätään -- ei hiljaa ohiteta.
//   3. Poisto vaatii (a) oman sähköpostin ja kiinteän vahvistuslauseen
//      täsmälleen, (b) tuoreen kirjautumisen.
//   4. Poisto on YKSI auth.admin.deleteUser-kutsu: jokaisen käyttäjätaulun
//      omistajasarake kaskadoituu tilin mukana atomisessa transaktiossa
//      (todistettu tests/account-deletion-inventory.test.mjs).
//   5. Virheet serialisoidaan vakiokoodeiksi. Supabasen virheviestiä,
//      avaimia, tokeneita tai sähköpostia ei koskaan palauteta eikä lokiteta.

import { ACCOUNT_DATA_MAP } from '../_shared/accountInventory.js';

/** Kiinteä vahvistuslause, jonka käyttäjä kirjoittaa täsmälleen. */
export const CONFIRMATION_PHRASE = 'POISTA TILINI';

/** Kuinka tuore kirjautuminen poistoon vaaditaan. */
export const RECENT_LOGIN_WINDOW_MS = 15 * 60 * 1000;

export const MODES = Object.freeze({ DRY_RUN: 'dry_run', DELETE: 'delete' });

const MAX_BODY_BYTES = 2048;
const MAX_JWT_LENGTH = 4096;
const ALLOWED_FIELDS = Object.freeze(['mode', 'confirmEmail', 'confirmPhrase']);
const JWT_SHAPE = /^[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}$/;

/** Vakiovirheet: koodi -> [HTTP-tila, käyttäjälle näytettävä viesti]. */
const ERRORS = Object.freeze({
  method_not_allowed: [405, 'Vain POST sallitaan.'],
  auth_required: [401, 'Kirjaudu sisään.'],
  auth_invalid: [401, 'Kirjautuminen ei ole voimassa. Kirjaudu uudelleen.'],
  payload_too_large: [413, 'Pyyntö on liian suuri.'],
  bad_request: [400, 'Pyyntö on virheellinen.'],
  unexpected_field: [400, 'Pyyntö sisältää kiellettyjä kenttiä.'],
  invalid_mode: [400, 'Tuntematon toiminto.'],
  confirmation_required: [400, 'Vahvistus puuttuu.'],
  confirmation_mismatch: [400, 'Vahvistus ei täsmää.'],
  recent_login_required: [403, 'Kirjaudu uudelleen sisään ennen tilin poistoa.'],
  auth_delete_failed: [500, 'Tilin poisto epäonnistui. Mitään ei ole varmistettu poistetuksi.'],
  misconfigured: [500, 'Palvelu ei ole käytettävissä.'],
  internal: [500, 'Palveluvirhe.']
});

function newOperationId(deps) {
  return typeof deps.randomId === 'function' ? deps.randomId() : crypto.randomUUID();
}

/** Lokiin vain tapahtuman nimi, operaatiotunniste ja virhekoodi. */
function logEvent(deps, event, fields) {
  const write = typeof deps.log === 'function' ? deps.log : line => console.log(line);
  try {
    write(JSON.stringify({ event, ...fields }));
  } catch { /* loki ei saa kaataa pyyntöä */ }
}

/** Sallitut originit ympäristöstä. Tyhjä lista = ei yhtään (suljettu). */
function corsHeaders(request, env) {
  const headers = { Vary: 'Origin' };
  const origin = request.headers.get('Origin');
  const allowed = String(env.DELETE_ACCOUNT_ALLOWED_ORIGINS || '')
    .split(',').map(item => item.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'authorization, apikey, content-type, x-client-info';
    headers['Access-Control-Max-Age'] = '600';
  }
  return headers;
}

function json(status, body, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...cors
    }
  });
}

function failure(code, operationId, cors) {
  const [status, message] = ERRORS[code] || ERRORS.internal;
  return json(status, { ok: false, operationId, error: { code, message } }, cors);
}

/**
 * Korotetun avaimen valinta ympäristöstä.
 *
 * Supabase injektoi hostattuihin funktioihin SUPABASE_SECRET_KEYS (JSON:
 * uusi avainjärjestelmä) ja legacy-muuttujan SUPABASE_SERVICE_ROLE_KEY.
 * Uusi ensin. JSON-sanakirjan avainnimi vahvistetaan käyttöönotossa:
 * käytetään `default`-avainta tai muuten ensimmäistä merkkijonoa.
 */
export function resolveAdminKey(env) {
  const raw = env && env.SUPABASE_SECRET_KEYS;
  if (raw) {
    try {
      const dictionary = JSON.parse(raw);
      if (dictionary && typeof dictionary === 'object') {
        if (typeof dictionary.default === 'string' && dictionary.default) return dictionary.default;
        const first = Object.values(dictionary).find(value => typeof value === 'string' && value);
        if (first) return first;
      }
    } catch { /* putoaa legacy-avaimeen */ }
  }
  return (env && env.SUPABASE_SERVICE_ROLE_KEY) || null;
}

function bearerToken(request) {
  const header = request.headers.get('Authorization');
  if (!header) return { error: 'auth_required' };
  const match = /^Bearer ([^\s]+)$/i.exec(header.trim());
  if (!match) return { error: 'auth_invalid' };
  const token = match[1];
  if (token.length > MAX_JWT_LENGTH || !JWT_SHAPE.test(token)) return { error: 'auth_invalid' };
  return { token };
}

/** Lue ja validoi runko. Palauttaa { body } tai { error }. */
async function readBody(request) {
  let text;
  try {
    text = await request.text();
  } catch {
    return { error: 'bad_request' };
  }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return { error: 'payload_too_large' };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'bad_request' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'bad_request' };

  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_FIELDS.includes(key)) return { error: 'unexpected_field' };
  }
  if (parsed.mode !== MODES.DRY_RUN && parsed.mode !== MODES.DELETE) return { error: 'invalid_mode' };
  for (const key of ['confirmEmail', 'confirmPhrase']) {
    if (parsed[key] !== undefined && (typeof parsed[key] !== 'string' || parsed[key].length > 320)) {
      return { error: 'bad_request' };
    }
  }
  return { body: parsed };
}

/**
 * PostgREST-virhekoodit, jotka tarkoittavat "taulua ei ole", eivät
 * "laskenta epäonnistui": PGRST205 (PostgREST 12+) ja 42P01 (vanhempi).
 */
const MISSING_RELATION_CODES = Object.freeze(['PGRST205', '42P01']);

/**
 * Puuttuuko taulu kokonaan?
 *
 * TUOTANTO ETENEE AALLOITTAIN: ennen aaltoa J osa inventaarion tauluista
 * (migraatiot 0009-0013) on vielä luomatta. Puuttuva taulu ei voi sisältää
 * rivejä, ja jos se luodaan myöhemmin, FK-kaskadi poistaa rivit kannassa
 * riippumatta siitä, mitä tämä tarkistus näkee. Se ei siis ole
 * "varmistamaton" -- mutta se kerrotaan erikseen (`absent`), ei piiloteta
 * nollaksi.
 *
 * Kaksi muotoa, koska laskenta on HEAD-pyyntö:
 *   - virheolio koodilla PGRST205 / 42P01
 *   - HEAD-vastauksen 404 ilman runkoa, jonka postgrest-js muuttaa muotoon
 *     { error: null, count: null, status: 204 } (sen oma kiertotie). Määrä
 *     puuttuu, joten sitä EI lueta nollaksi.
 */
function isMissingRelation(response) {
  const { count, error, status } = response || {};
  if (error) return MISSING_RELATION_CODES.includes(error.code);
  return count == null && (status === 404 || status === 204);
}

function countedDomain(domain, rowCount) {
  return { domain, rowCount, action: 'delete', blockedReason: null, present: true };
}

function absentDomain(domain) {
  return { domain, rowCount: 0, action: 'delete', blockedReason: null, present: false };
}

function failedDomain(domain) {
  return { domain, rowCount: null, action: 'delete', blockedReason: 'count_failed', present: null };
}

/** Rivimäärät jokaiselle inventaarion kokoelmalle. Ei koskaan rivien sisältöä. */
async function countDomains(admin, userId) {
  const domains = await Promise.all(Object.entries(ACCOUNT_DATA_MAP).map(async ([domain, entry]) => {
    try {
      const response = await admin
        .from(entry.table)
        .select('*', { count: 'exact', head: true })
        .eq(entry.ownerColumn, userId);
      if (isMissingRelation(response)) return absentDomain(domain);
      const { count, error } = response || {};
      // Puuttuva määrä ilman virhettä ei ole nolla: sitä ei ole laskettu.
      if (error || !Number.isInteger(count) || count < 0) return failedDomain(domain);
      return countedDomain(domain, count);
    } catch {
      return failedDomain(domain);
    }
  }));

  // "Taulua ei ole" on uskottava vain, jos sama kierros näki ainakin yhden
  // taulun. Jos mikään ei näy, vika on yhteydessä (väärä osoite, REST pois
  // päältä) eikä skeemassa -- sitä ei saa lukea "ei mitään poistettavaa".
  if (!domains.some(entry => entry.present === true)) {
    return domains.map(entry => (entry.present === false ? failedDomain(entry.domain) : entry));
  }
  return domains;
}

/** Kokoelmat, joiden taulua ei tässä kannassa ole (aalto J:tä edeltävä tuotanto). */
function absentDomains(domains) {
  return domains.filter(entry => entry.present === false).map(entry => entry.domain);
}

function isRecentLogin(user, now) {
  const at = Date.parse(user && user.last_sign_in_at);
  return Number.isFinite(at) && now - at >= 0 && now - at <= RECENT_LOGIN_WINDOW_MS;
}

function confirmationError(user, body) {
  if (typeof body.confirmPhrase !== 'string') return 'confirmation_required';
  if (user.email && typeof body.confirmEmail !== 'string') return 'confirmation_required';

  if (body.confirmPhrase.trim() !== CONFIRMATION_PHRASE) return 'confirmation_mismatch';
  if (user.email
    && body.confirmEmail.trim().toLowerCase() !== String(user.email).trim().toLowerCase()) {
    return 'confirmation_mismatch';
  }
  return null;
}

/** Onko deleteUser-virhe "käyttäjää ei ole" (jo poistettu)? */
function isAlreadyDeleted(error) {
  if (!error) return false;
  return error.status === 404 || error.code === 'user_not_found';
}

/**
 * Käsittele yksi pyyntö.
 *
 * @param {Request} request
 * @param {{env:object, createClient:Function, log?:Function, now?:()=>number, randomId?:()=>string}} deps
 * @returns {Promise<Response>}
 */
export async function handleRequest(request, deps) {
  const env = deps.env || {};
  const cors = corsHeaders(request, env);
  const operationId = newOperationId(deps);

  const reject = code => {
    logEvent(deps, 'delete_account.rejected', { operationId, code });
    return failure(code, operationId, cors);
  };

  try {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return reject('method_not_allowed');

    const auth = bearerToken(request);
    if (auth.error) return reject(auth.error);

    const parsed = await readBody(request);
    if (parsed.error) return reject(parsed.error);
    const body = parsed.body;

    const adminKey = resolveAdminKey(env);
    if (!env.SUPABASE_URL || !adminKey) return reject('misconfigured');

    const admin = deps.createClient(env.SUPABASE_URL, adminKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    // KÄYTTÄJÄ JOHDETAAN TOKENISTA. Tämän jälkeen `user.id` on ainoa
    // tunniste jota käytetään -- rungossa ei ole (eikä saa olla) sellaista.
    const { data, error: authError } = await admin.auth.getUser(auth.token);
    const user = data && data.user;
    if (authError || !user || !user.id) return reject('auth_invalid');

    if (body.mode === MODES.DRY_RUN) {
      const domains = await countDomains(admin, user.id);
      const totalRows = domains.reduce((sum, entry) => sum + (entry.rowCount || 0), 0);
      const absent = absentDomains(domains);
      logEvent(deps, 'delete_account.dry_run', { operationId, domains: domains.length, absent: absent.length });
      return json(200, {
        ok: true,
        operationId,
        mode: MODES.DRY_RUN,
        domains,
        totalRows,
        absent,
        authAccount: { action: 'delete', blockedReason: null },
        storage: { categories: [] },
        confirmationPhrase: CONFIRMATION_PHRASE,
        recentLoginRequired: !isRecentLogin(user, (deps.now || Date.now)())
      }, cors);
    }

    const confirmation = confirmationError(user, body);
    if (confirmation) return reject(confirmation);
    if (!isRecentLogin(user, (deps.now || Date.now)())) return reject('recent_login_required');

    const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
    const alreadyDeleted = isAlreadyDeleted(deleteError);
    if (deleteError && !alreadyDeleted) return reject('auth_delete_failed');

    // Jälkitarkistus: FK-kaskadin jälkeen yhtään riviä ei pitäisi olla.
    // Puuttuva taulu (absent) ei ole jäännös eikä varmistamaton: siinä ei
    // voi olla rivejä. Täydellisyys ratkeaa vain jäännöksistä ja
    // varmistamattomista, ja puuttuvat kerrotaan silti erikseen.
    const after = await countDomains(admin, user.id);
    const residual = after.filter(entry => entry.rowCount > 0).map(entry => entry.domain);
    const unverified = after.filter(entry => entry.rowCount === null).map(entry => entry.domain);
    const absent = absentDomains(after);
    const complete = residual.length === 0 && unverified.length === 0;

    logEvent(deps, 'delete_account.deleted', {
      operationId, complete, alreadyDeleted,
      residual: residual.length, unverified: unverified.length, absent: absent.length
    });
    return json(200, {
      ok: true,
      operationId,
      mode: MODES.DELETE,
      deleted: true,
      alreadyDeleted,
      complete,
      residual,
      unverified,
      absent
    }, cors);
  } catch {
    return reject('internal');
  }
}
