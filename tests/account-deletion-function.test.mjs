// delete-account Edge Function: käyttäytymistestit paikallisella valeasiakkaalla.
//
// EI OIKEAA SUPABASEA, EI OIKEAA POISTOA. Valeasiakas toteuttaa vain ne
// kutsut, joita handler käyttää (auth.getUser, auth.admin.deleteUser,
// from().select().eq()), ja mallintaa FK-kaskadin: käyttäjän poisto
// poistaa hänen rivinsä kaikista tauluista.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  handleRequest, resolveAdminKey, CONFIRMATION_PHRASE, RECENT_LOGIN_WINDOW_MS
} from '../supabase/functions/delete-account/handler.js';
import { ACCOUNT_DATA_MAP } from '../supabase/functions/_shared/accountInventory.js';

const NOW = Date.parse('2026-09-19T12:00:00Z');
const ADMIN_KEY = 'sb_secret_TESTKEY_should_never_leak_0123456789';
const ALICE = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'alice@example.com',
  last_sign_in_at: new Date(NOW - 60 * 1000).toISOString()
};
const BOB = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'bob@example.com',
  last_sign_in_at: new Date(NOW - 60 * 1000).toISOString()
};
const TOKENS = { 'alice.token.value': ALICE, 'bobby.token.value': BOB };

/** Valekanta + valeasiakas. `world` on muokattava, jotta testit näkevät lopputilan. */
function makeWorld({ users = { ...TOKENS }, rows = null, deleteError = null, failCountFor = [],
  cascade = true, leaveResidualFor = [], throwOn = null } = {}) {
  const world = { users, deleted: [], deleteCalls: 0, clientCalls: 0, keysUsed: [], rows: rows || {} };
  if (!rows) {
    for (const entry of Object.values(ACCOUNT_DATA_MAP)) {
      world.rows[entry.table] = [
        { [entry.ownerColumn]: ALICE.id, secretPayload: 'ALICE-PRIVATE-ROW' },
        { [entry.ownerColumn]: ALICE.id, secretPayload: 'ALICE-PRIVATE-ROW-2' },
        { [entry.ownerColumn]: BOB.id, secretPayload: 'BOB-PRIVATE-ROW' }
      ];
    }
  }

  world.createClient = (url, key) => {
    world.clientCalls += 1;
    world.keysUsed.push(key);
    return {
      auth: {
        getUser: async token => {
          if (throwOn === 'getUser') throw new Error('boom ' + ADMIN_KEY + ' alice@example.com');
          const user = world.users[token];
          return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'invalid JWT' } };
        },
        admin: {
          deleteUser: async id => {
            world.deleteCalls += 1;
            if (deleteError) return { error: deleteError };
            world.deleted.push(id);
            for (const token of Object.keys(world.users)) {
              if (world.users[token].id === id) delete world.users[token];
            }
            if (cascade) {
              for (const [table, list] of Object.entries(world.rows)) {
                const entry = Object.values(ACCOUNT_DATA_MAP).find(item => item.table === table);
                if (leaveResidualFor.includes(table)) continue;
                world.rows[table] = list.filter(row => row[entry.ownerColumn] !== id);
              }
            }
            return { error: null };
          }
        }
      },
      from: table => ({
        select: () => ({
          eq: async (column, value) => {
            if (failCountFor.includes(table)) return { count: null, error: { message: 'relation exploded' } };
            const count = (world.rows[table] || []).filter(row => row[column] === value).length;
            return { count, error: null };
          }
        })
      })
    };
  };
  return world;
}

function makeDeps(world, extra = {}) {
  const logs = [];
  return {
    logs,
    deps: {
      env: {
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SECRET_KEYS: JSON.stringify({ default: ADMIN_KEY }),
        DELETE_ACCOUNT_ALLOWED_ORIGINS: 'https://app.example.com',
        ...extra.env
      },
      createClient: world.createClient,
      log: line => logs.push(line),
      now: () => NOW,
      randomId: () => 'op-test-0001'
    }
  };
}

function req({ method = 'POST', token = 'alice.token.value', body, headers = {}, rawBody } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (token !== null && h.Authorization === undefined) h.Authorization = `Bearer ${token}`;
  return new Request('https://example.supabase.co/functions/v1/delete-account', {
    method,
    headers: h,
    body: method === 'GET' || method === 'OPTIONS' ? undefined : (rawBody ?? JSON.stringify(body))
  });
}

async function call(world, request, extra) {
  const { deps, logs } = makeDeps(world, extra);
  const response = await handleRequest(request, deps);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 204 */ }
  return { response, text, body, logs };
}

const CONFIRM = { mode: 'delete', confirmEmail: 'alice@example.com', confirmPhrase: CONFIRMATION_PHRASE };

function assertNoLeak(text, extraSecrets = []) {
  for (const secret of [ADMIN_KEY, 'alice.token.value', 'bobby.token.value', ...extraSecrets]) {
    assert.equal(text.includes(secret), false, 'vuoto: ' + secret);
  }
}

// ---------------------------------------------------------- todennus

test('KRIITTINEN: ilman Authorization-otsikkoa 401 eikä yhtään asiakasta luoda', async () => {
  const world = makeWorld();
  const { response, body } = await call(world, req({ token: null, body: { mode: 'dry_run' } }));
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'auth_required');
  assert.equal(world.clientCalls, 0);
  assert.equal(world.deleteCalls, 0);
});

for (const [label, header] of [
  ['Basic-skeema', 'Basic YWxpY2U6cHc='],
  ['tyhjä Bearer', 'Bearer '],
  ['pelkkä Bearer', 'Bearer'],
  ['ei JWT-muotoa', 'Bearer not-a-jwt'],
  ['välilyöntejä', 'Bearer a.b.c d'],
  ['liian pitkä', 'Bearer ' + 'a'.repeat(5000) + '.bbbb.cccc'],
  ['rivinvaihto', 'Bearer aaaa.bbbb.cccc\nX-Injected: 1'.replace('\n', ' ')],
  ['kaksi tokenia', 'Bearer aaaa.bbbb.cccc dddd.eeee.ffff']
]) {
  test(`KRIITTINEN: virheellinen auth (${label}) hylätään ennen asiakkaan luontia`, async () => {
    const world = makeWorld();
    const { response, body } = await call(world, req({ token: null, headers: { Authorization: header }, body: { mode: 'dry_run' } }));
    assert.equal(response.status, 401);
    assert.match(body.error.code, /^auth_(required|invalid)$/);
    assert.equal(world.clientCalls, 0);
    assert.equal(world.deleteCalls, 0);
  });
}

test('KRIITTINEN: kelvollisen muotoinen mutta väärä JWT hylätään eikä mitään poisteta', async () => {
  const world = makeWorld();
  const { response, body } = await call(world, req({ token: 'forged.token.value', body: CONFIRM }));
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'auth_invalid');
  assert.equal(world.deleteCalls, 0);
});

test('KRIITTINEN: pelkkä GET/PUT/DELETE ei tee mitään (405)', async () => {
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    const world = makeWorld();
    const request = new Request('https://x.supabase.co/f', {
      method, headers: { Authorization: 'Bearer alice.token.value' },
      body: method === 'GET' ? undefined : '{}'
    });
    const { response, body } = await call(world, request);
    assert.equal(response.status, 405, method);
    assert.equal(body.error.code, 'method_not_allowed');
    assert.equal(world.deleteCalls, 0);
  }
});

// ---------------------------------------------- toisen käyttäjän tunniste

for (const field of ['userId', 'user_id', 'id', 'uid', 'targetUserId', 'sub', 'email']) {
  test(`KRIITTINEN: asiakkaan antama toinen käyttäjätunniste (${field}) hylätään`, async () => {
    const world = makeWorld();
    const { response, body } = await call(world, req({ body: { ...CONFIRM, [field]: BOB.id } }));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'unexpected_field');
    assert.equal(world.deleteCalls, 0, 'mitään ei saa poistaa');
    assert.equal(world.rows.tasks.filter(row => row.user_id === BOB.id).length, 1);
  });
}

test('KRIITTINEN: poisto kohdistuu vain tokenin käyttäjään, toisen rivit säilyvät', async () => {
  const world = makeWorld();
  const { response, body } = await call(world, req({ body: CONFIRM }));
  assert.equal(response.status, 200);
  assert.equal(body.deleted, true);
  assert.deepEqual(world.deleted, [ALICE.id], 'deleteUser kutsuttiin täsmälleen tokenin käyttäjällä');
  assert.equal(world.rows.tasks.some(row => row.user_id === ALICE.id), false);
  assert.equal(world.rows.tasks.filter(row => row.user_id === BOB.id).length, 1);
  assert.equal(world.rows.profile.filter(row => row.id === BOB.id).length, 1);
});

test('Bobin token poistaa vain Bobin -- Alicen vahvistus ei siirry', async () => {
  const world = makeWorld();
  const { response } = await call(world, req({
    token: 'bobby.token.value', body: { ...CONFIRM, confirmEmail: 'alice@example.com' }
  }));
  assert.equal(response.status, 400, 'Alicen sähköposti ei kelpaa Bobin poistoon');
  assert.equal(world.deleteCalls, 0);
});

// -------------------------------------------------------- vahvistus

test('KRIITTINEN: puuttuva vahvistus -> confirmation_required, ei poistoa', async () => {
  for (const body of [{ mode: 'delete' }, { mode: 'delete', confirmPhrase: CONFIRMATION_PHRASE }, { mode: 'delete', confirmEmail: ALICE.email }]) {
    const world = makeWorld();
    const { response, body: out } = await call(world, req({ body }));
    assert.equal(response.status, 400);
    assert.equal(out.error.code, 'confirmation_required');
    assert.equal(world.deleteCalls, 0);
  }
});

test('KRIITTINEN: väärä vahvistus -> confirmation_mismatch, ei poistoa', async () => {
  for (const body of [
    { ...CONFIRM, confirmPhrase: 'poista tilini' },
    { ...CONFIRM, confirmPhrase: 'POISTA' },
    { ...CONFIRM, confirmPhrase: '' },
    { ...CONFIRM, confirmEmail: 'mallory@example.com' },
    { ...CONFIRM, confirmEmail: '' }
  ]) {
    const world = makeWorld();
    const { response, body: out } = await call(world, req({ body }));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(out.error.code, 'confirmation_mismatch');
    assert.equal(world.deleteCalls, 0);
  }
});

test('sähköposti vertaillaan kirjainkoosta ja välilyönneistä riippumatta', async () => {
  const world = makeWorld();
  const { response } = await call(world, req({
    body: { ...CONFIRM, confirmEmail: '  ALICE@Example.COM ', confirmPhrase: `  ${CONFIRMATION_PHRASE} ` }
  }));
  assert.equal(response.status, 200);
});

test('käyttäjä ilman sähköpostia vahvistaa pelkällä lauseella', async () => {
  const phone = { id: '33333333-3333-4333-8333-333333333333', email: null, last_sign_in_at: new Date(NOW - 1000).toISOString() };
  const world = makeWorld({ users: { 'phone.token.value': phone } });
  const { response } = await call(world, req({ token: 'phone.token.value', body: { mode: 'delete', confirmPhrase: CONFIRMATION_PHRASE } }));
  assert.equal(response.status, 200);
});

test('KRIITTINEN: tuore kirjautuminen vaaditaan poistoon, ei kuiva-ajoon', async () => {
  const stale = { ...ALICE, last_sign_in_at: new Date(NOW - RECENT_LOGIN_WINDOW_MS - 1000).toISOString() };
  const world = makeWorld({ users: { 'alice.token.value': stale } });

  const dry = await call(world, req({ body: { mode: 'dry_run' } }));
  assert.equal(dry.response.status, 200);
  assert.equal(dry.body.recentLoginRequired, true);

  const del = await call(world, req({ body: CONFIRM }));
  assert.equal(del.response.status, 403);
  assert.equal(del.body.error.code, 'recent_login_required');
  assert.equal(world.deleteCalls, 0);
});

test('puuttuva tai tulevaisuuden last_sign_in_at ei täytä tuoreusvaatimusta', async () => {
  for (const value of [undefined, null, 'ei-päivä', new Date(NOW + 3600 * 1000).toISOString()]) {
    const user = { ...ALICE, last_sign_in_at: value };
    const world = makeWorld({ users: { 'alice.token.value': user } });
    const { response } = await call(world, req({ body: CONFIRM }));
    assert.equal(response.status, 403, String(value));
    assert.equal(world.deleteCalls, 0);
  }
});

// ------------------------------------------------------------ kuiva-ajo

test('kuiva-ajo palauttaa jokaisen inventaarion kokoelman rivimäärän, ei poista mitään', async () => {
  const world = makeWorld();
  const { response, body } = await call(world, req({ body: { mode: 'dry_run' } }));

  assert.equal(response.status, 200);
  assert.equal(body.mode, 'dry_run');
  assert.deepEqual(body.domains.map(entry => entry.domain).sort(), Object.keys(ACCOUNT_DATA_MAP).sort());
  for (const entry of body.domains) {
    assert.equal(entry.rowCount, 2, entry.domain + ' (vain Alicen rivit, ei Bobin)');
    assert.equal(entry.action, 'delete');
    assert.equal(entry.blockedReason, null);
  }
  assert.equal(body.totalRows, 2 * Object.keys(ACCOUNT_DATA_MAP).length);
  assert.equal(body.confirmationPhrase, CONFIRMATION_PHRASE);
  assert.deepEqual(body.storage.categories, []);
  assert.equal(world.deleteCalls, 0);
  assert.equal(world.rows.tasks.length, 3, 'yhtään riviä ei poistettu');
});

test('KRIITTINEN: kuiva-ajo ei paljasta rivien sisältöä eikä taulunimiä', async () => {
  const world = makeWorld();
  const { text } = await call(world, req({ body: { mode: 'dry_run' } }));
  assert.equal(text.includes('PRIVATE-ROW'), false);
  assert.equal(text.includes('secretPayload'), false);
  assert.equal(text.includes('ai_action_audit'), false, 'taulunimiä ei palauteta, vain kokoelmanimet');
  assertNoLeak(text, [ALICE.email, ALICE.id]);
});

test('osittainen kirjanpitovirhe kuiva-ajossa: yksi kokoelma estetty, muut normaalit', async () => {
  const world = makeWorld({ failCountFor: ['bills'] });
  const { response, body, text } = await call(world, req({ body: { mode: 'dry_run' } }));
  assert.equal(response.status, 200);
  const bills = body.domains.find(entry => entry.domain === 'bills');
  assert.equal(bills.rowCount, null);
  assert.equal(bills.blockedReason, 'count_failed');
  assert.equal(body.domains.filter(entry => entry.blockedReason === null).length, Object.keys(ACCOUNT_DATA_MAP).length - 1);
  assert.equal(text.includes('exploded'), false, 'Supabasen virheviestiä ei välitetä');
});

// ------------------------------------------------------------- poisto

test('onnistunut poisto: complete, ei jäännöksiä, ei vuotoja vastauksessa eikä lokissa', async () => {
  const world = makeWorld();
  const { response, body, text, logs } = await call(world, req({ body: CONFIRM }));

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.deleted, true);
  assert.equal(body.complete, true);
  assert.deepEqual(body.residual, []);
  assert.deepEqual(body.unverified, []);
  assert.equal(world.deleteCalls, 1);

  assertNoLeak(text, [ALICE.email, ALICE.id]);
  assertNoLeak(logs.join('\n'), [ALICE.email, ALICE.id, 'PRIVATE-ROW']);
  assert.ok(logs.some(line => line.includes('delete_account.deleted')));
});

test('KRIITTINEN: osittainen jäännös poiston jälkeen raportoidaan, ei väitetä täydeksi', async () => {
  const world = makeWorld({ leaveResidualFor: ['reminders'] });
  const { response, body } = await call(world, req({ body: CONFIRM }));
  assert.equal(response.status, 200);
  assert.equal(body.deleted, true);
  assert.equal(body.complete, false);
  assert.deepEqual(body.residual, ['reminders']);
});

test('jälkitarkistuksen laskentavirhe merkitään varmistamattomaksi, ei täydeksi', async () => {
  const world = makeWorld({ failCountFor: ['goals'] });
  const { body } = await call(world, req({ body: CONFIRM }));
  assert.equal(body.deleted, true);
  assert.equal(body.complete, false);
  assert.deepEqual(body.unverified, ['goals']);
});

test('KRIITTINEN: auth-poiston epäonnistuminen -> 500, ei väitettyä onnistumista, viesti siivottu', async () => {
  const world = makeWorld({ deleteError: { message: 'FATAL internal db detail sb_secret_LEAK', status: 500, code: 'unexpected_failure' } });
  const { response, body, text, logs } = await call(world, req({ body: CONFIRM }));

  assert.equal(response.status, 500);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'auth_delete_failed');
  assert.equal(body.deleted, undefined);
  assert.equal(text.includes('FATAL'), false);
  assert.equal(text.includes('sb_secret'), false);
  assert.equal(logs.join('\n').includes('FATAL'), false);
  assert.equal(world.rows.tasks.filter(row => row.user_id === ALICE.id).length, 2, 'rivit koskemattomia');
});

test('KRIITTINEN: toistettu poistopyyntö samalla tokenilla ei poista uudelleen', async () => {
  const world = makeWorld();
  const first = await call(world, req({ body: CONFIRM }));
  assert.equal(first.response.status, 200);

  const second = await call(world, req({ body: CONFIRM }));
  assert.equal(second.response.status, 401, 'käyttäjää ei enää ole -> token ei kelpaa');
  assert.equal(second.body.error.code, 'auth_invalid');
  assert.equal(world.deleteCalls, 1, 'deleteUser kutsuttiin vain kerran');
});

test('kilpa-ajo: käyttäjä ehti poistua ennen deleteUseria -> idempotentti onnistuminen', async () => {
  const world = makeWorld({ deleteError: { status: 404, code: 'user_not_found', message: 'User not found' } });
  const { response, body } = await call(world, req({ body: CONFIRM }));
  assert.equal(response.status, 200);
  assert.equal(body.deleted, true);
  assert.equal(body.alreadyDeleted, true);
});

test('tyhjät taulut / puuttuvat resurssit eivät kaada poistoa', async () => {
  const empty = {};
  for (const entry of Object.values(ACCOUNT_DATA_MAP)) empty[entry.table] = [];
  const world = makeWorld({ rows: empty });
  const { response, body } = await call(world, req({ body: CONFIRM }));
  assert.equal(response.status, 200);
  assert.equal(body.complete, true);
});

// ------------------------------------------- virheet ja syötteen validointi

test('KRIITTINEN: odottamaton poikkeus serialisoidaan vakiovirheeksi ilman salaisuuksia', async () => {
  const world = makeWorld({ throwOn: 'getUser' });
  const { response, body, text, logs } = await call(world, req({ body: CONFIRM }));
  assert.equal(response.status, 500);
  assert.equal(body.error.code, 'internal');
  assertNoLeak(text, ['boom', ALICE.email]);
  assertNoLeak(logs.join('\n'), ['boom', ALICE.email]);
});

test('puuttuva ympäristö -> misconfigured, asiakasta ei luoda', async () => {
  for (const env of [{ SUPABASE_URL: '' }, { SUPABASE_SECRET_KEYS: '' }]) {
    const world = makeWorld();
    const { response, body } = await call(world, req({ body: CONFIRM }), { env });
    assert.equal(response.status, 500);
    assert.equal(body.error.code, 'misconfigured');
    assert.equal(world.clientCalls, 0);
  }
});

test('virheellinen runko: ei-JSON, taulukko, liian suuri, väärä tila, väärät tyypit', async () => {
  const cases = [
    [{ rawBody: 'ei json' }, 400, 'bad_request'],
    [{ rawBody: '[]' }, 400, 'bad_request'],
    [{ rawBody: 'null' }, 400, 'bad_request'],
    [{ rawBody: '"delete"' }, 400, 'bad_request'],
    [{ rawBody: JSON.stringify({ mode: 'delete', confirmPhrase: 'x'.repeat(5000) }) }, 413, 'payload_too_large'],
    [{ body: { mode: 'drop_everything' } }, 400, 'invalid_mode'],
    [{ body: {} }, 400, 'invalid_mode'],
    [{ body: { mode: ['delete'] } }, 400, 'invalid_mode'],
    [{ body: { mode: 'delete', confirmEmail: { a: 1 }, confirmPhrase: CONFIRMATION_PHRASE } }, 400, 'bad_request'],
    [{ body: { mode: 'delete', confirmPhrase: 42 } }, 400, 'bad_request'],
    [{ rawBody: '{"mode":"dry_run","__proto__":{"x":1}}' }, 400, 'unexpected_field']
  ];
  for (const [args, status, code] of cases) {
    const world = makeWorld();
    const { response, body } = await call(world, req(args));
    assert.equal(response.status, status, JSON.stringify(args).slice(0, 80));
    assert.equal(body.error.code, code);
    assert.equal(world.deleteCalls, 0);
  }
  assert.equal({}.x, undefined);
});

test('vastauksissa on no-store ja nosniff, ja jokaisessa on operationId', async () => {
  const world = makeWorld();
  for (const request of [req({ body: { mode: 'dry_run' } }), req({ token: null, body: {} })]) {
    const { response, body } = await call(world, request);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(body.operationId, 'op-test-0001');
  }
});

// ----------------------------------------------------------------- CORS

test('CORS: sallittu origin saa otsikot, tuntematon ei, ja oletus on suljettu', async () => {
  const world = makeWorld();
  const preflight = origin => new Request('https://x.supabase.co/f', {
    method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' }
  });

  const allowed = await call(world, preflight('https://app.example.com'));
  assert.equal(allowed.response.status, 204);
  assert.equal(allowed.response.headers.get('Access-Control-Allow-Origin'), 'https://app.example.com');
  assert.match(allowed.response.headers.get('Access-Control-Allow-Headers'), /authorization/);

  const denied = await call(world, preflight('https://evil.example.com'));
  assert.equal(denied.response.headers.get('Access-Control-Allow-Origin'), null);

  const closed = await call(world, preflight('https://app.example.com'), { env: { DELETE_ACCOUNT_ALLOWED_ORIGINS: '' } });
  assert.equal(closed.response.headers.get('Access-Control-Allow-Origin'), null, 'tyhjä lista = suljettu');

  assert.equal(world.deleteCalls, 0);
});

test('CORS ei ole jokerimerkki myöskään virhevastauksissa', async () => {
  const world = makeWorld();
  const { response } = await call(world, req({
    token: null, body: {}, headers: { Origin: 'https://evil.example.com' }
  }));
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

// --------------------------------------------------------- avaimen valinta

test('resolveAdminKey: uusi SECRET_KEYS ensin, sitten legacy, muuten null', () => {
  assert.equal(resolveAdminKey({ SUPABASE_SECRET_KEYS: '{"default":"K1","other":"K2"}', SUPABASE_SERVICE_ROLE_KEY: 'LEGACY' }), 'K1');
  assert.equal(resolveAdminKey({ SUPABASE_SECRET_KEYS: '{"a":"K2"}' }), 'K2');
  assert.equal(resolveAdminKey({ SUPABASE_SECRET_KEYS: 'ei json', SUPABASE_SERVICE_ROLE_KEY: 'LEGACY' }), 'LEGACY');
  assert.equal(resolveAdminKey({ SUPABASE_SECRET_KEYS: '{"a":5}', SUPABASE_SERVICE_ROLE_KEY: 'LEGACY' }), 'LEGACY');
  assert.equal(resolveAdminKey({ SUPABASE_SERVICE_ROLE_KEY: 'LEGACY' }), 'LEGACY');
  assert.equal(resolveAdminKey({}), null);
  assert.equal(resolveAdminKey(undefined), null);
});

test('handler käyttää korotettua avainta vain asiakkaan luontiin, ei koskaan vastaukseen', async () => {
  const world = makeWorld();
  const { text, logs } = await call(world, req({ body: { mode: 'dry_run' } }));
  assert.deepEqual(world.keysUsed, [ADMIN_KEY]);
  assert.equal(text.includes(ADMIN_KEY), false);
  assert.equal(logs.join('\n').includes(ADMIN_KEY), false);
});
