// Diagnostiikka uusille virroille: tunnisteet ja koodit, ei sisältöä.
//
// Puhe, komennot, tilin poisto, sijainti, lähtö ja offline-jono kirjaavat
// vain MITÄ tapahtui ja miten se päättyi. Litterointi, tokenit,
// koordinaatit, sähköposti ja tehtävän sisältö eivät koskaan päädy lokiin.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read, readCode } from './helpers/sources.mjs';
import { logEvent, LOG_LEVEL, REDACTED } from '../src/lib/logger.js';
import { runTypedCommand } from '../src/app/commandBar.js';
import { previewAccountDeletion, executeAccountDeletion } from '../src/data/accountDeletionClient.js';
import { setUser, clearUser } from '../src/data/session.js';
import { resetState } from '../src/app/state.js';
import { clearLocalUserData } from '../src/app/actions.js';
import { setClient } from '../src/data/client.js';
import { fakeClient } from './helpers/gates.mjs';

/** Kaappaa konsolin ulostulon ajaksi. */
async function capture(fn) {
  const lines = [];
  const originals = {};
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[method] = console[method];
    console[method] = (...args) => lines.push(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  }
  try { await fn(); } finally { Object.assign(console, originals); }
  return lines.join('\n');
}

test('logEvent: koodit ja luvut kirjataan, pitkät merkkijonot ja oliot eivät', async () => {
  const out = await capture(() => logEvent('offline.replay', {
    synced: 2, reason: 'network', ok: true, missing: null, transcript: 'Muistuta minua huomenna soittamaan äidille',
    long: 'x'.repeat(200), nested: { a: 1 }, list: [1, 2], fn: () => 1, nan: NaN
  }));
  assert.match(out, /offline\.replay/);
  assert.match(out, /"synced":2/);
  assert.match(out, /"reason":"network"/);
  assert.equal(out.includes('äidille'), false, 'litterointi (arkaluontoinen avain) ei vuoda');
  assert.match(out, new RegExp(REDACTED.replace(/[[\]]/g, '\$&')));
  assert.match(out, /\[pitkä\]/);
  assert.equal(out.includes('xxxxxxxx'), false);
  assert.equal(out.includes('nested'), false, 'oliot pudotetaan');
  assert.equal(out.includes('"list"'), false);
});

test('logEvent: koordinaatit, tokenit ja sähköposti korvataan avaimen perusteella', async () => {
  const out = await capture(() => logEvent('location.attempt', {
    latitude: 60.1699, longitude: 24.9384, lat: 1, lng: 2, coords: 'x', token: 'abc', accessToken: 'def',
    email: 'a@b.fi', password: 'pw', title: 'Salainen otsikko', note: 'salainen', ok: true
  }));
  for (const secret of ['60.1699', '24.9384', 'abc', 'def', 'a@b.fi', 'pw', 'Salainen', 'salainen']) {
    assert.equal(out.includes(secret), false, secret);
  }
  assert.match(out, /"ok":true/);
});

test('logEvent: virheellinen tapahtuman nimi hylätään (nimi on tunniste, ei vapaa teksti)', async () => {
  for (const bad of ['', 'Iso.Kirjain', 'sisältää välilyönnin', 'Muistuta minua huomenna', 5, null, undefined, 'a..b', '.a', 'a-b']) {
    assert.equal(await capture(() => logEvent(bad, { ok: true })), '', String(bad));
  }
});

test('KRIITTINEN: komentoputken lokit sisältävät tunnisteet ja koodit, eivät lausetta', async () => {
  clearUser(); clearLocalUserData(); resetState();
  setUser({ id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'x@example.com' });
  setClient(fakeClient({ data: [], error: null }));

  const sentence = 'Siirrä äidin syntymäpäivälahja perjantaille salainenlause';
  const out = await capture(() => runTypedCommand(sentence, {
    source: 'voice',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{"intent":"create_task","title":"Salainen otsikko","date":"2026-09-20"}' }] }) }),
    confirmFn: async () => true,
    chooseFn: async () => null
  }));

  assert.match(out, /command\.classified/);
  assert.match(out, /"source":"voice"/);
  assert.match(out, /"chars":\d+/);
  assert.match(out, /command\.proposal/);
  assert.match(out, /command\.executed/);
  assert.match(out, /"intent":"create_task"/);
  for (const secret of ['salainenlause', 'syntymäpäivälahja', 'Salainen otsikko', 'x@example.com']) {
    assert.equal(out.includes(secret), false, secret);
  }
});

test('KRIITTINEN: tilin poiston kutsu kirjaa tilan ja koodin, ei tokenia, sähköpostia eikä vastausta', async () => {
  const out = await capture(async () => {
    await executeAccountDeletion({
      accessToken: 'TOKEN-SECRET-123', confirmEmail: 'oma@osoite.fi', confirmPhrase: 'POISTA TILINI', enabled: true,
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: { code: 'auth_delete_failed', message: 'SISÄINEN' } }) })
    });
    await previewAccountDeletion({ accessToken: 'TOKEN-SECRET-123', enabled: false });
  });
  assert.match(out, /account_deletion\.call/);
  assert.match(out, /"mode":"delete"/);
  assert.match(out, /accountDeletion\.auth_delete_failed/);
  assert.match(out, /accountDeletion\.unavailable/);
  for (const secret of ['TOKEN-SECRET-123', 'oma@osoite.fi', 'SISÄINEN', 'POISTA TILINI']) {
    assert.equal(out.includes(secret), false, secret);
  }
});

test('KRIITTINEN: lähdekoodissa yksikään logEvent-kutsu ei anna raakatekstiä, koordinaattia tai tokenia', () => {
  const files = ['src/app/voice.js', 'src/app/commandBar.js', 'src/app/offlineSync.js', 'src/data/accountDeletionClient.js',
    'src/app/views/profile.js', 'src/app/assistantActions.js'];
  const banned = /\b(transcript|clean|trimmed|text|inputText|title|email|token|accessToken|latitude|longitude|position|coords|payload|note)\b/;
  let calls = 0;
  for (const file of files) {
    const source = readCode(file);
    let from = 0;
    for (;;) {
      const at = source.indexOf("logEvent('", from);
      if (at === -1) break;
      from = at + 10;
      // Ensimmäinen olioliteraali kutsussa: sulut lasketaan tasapainoon.
      const open = source.indexOf('{', at);
      let depth = 0;
      let close = open;
      for (; close < source.length; close += 1) {
        if (source[close] === '{') depth += 1;
        else if (source[close] === '}' && --depth === 0) break;
      }
      const args = source.slice(open, close + 1).replace(/chars:\s*\w+\.length/g, 'chars: N');
      calls += 1;
      assert.equal(banned.test(args), false, file + ': ' + source.slice(at, close + 1).slice(0, 140));
    }
  }
  assert.ok(calls >= 10, `logEvent-kutsuja löytyi ${calls}`);
});

test('sijaintimoduuli ei kirjaa mitään (ei logEvent-kutsuja)', () => {
  assert.equal(/logEvent|logWarn|console\./.test(readCode('src/platform/geolocation.js')), false);
});

test('LOG_LEVEL on käytössä: virheellinen taso ei kaada', async () => {
  const out = await capture(() => logEvent('command.executed', { ok: false }, LOG_LEVEL.WARN));
  assert.match(out, /command\.executed/);
  await capture(() => logEvent('command.executed', { ok: false }, 'outo'));
});
