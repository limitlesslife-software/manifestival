// Laitteen tila tilin poistossa ja uloskirjautumisessa.
//
// KAKSI VÄITETTÄ:
//   1. Rekisteri (src/data/deviceData.js DEVICE_STORAGE) kattaa jokaisen
//      avaimen, jonka src/ kirjoittaa selaintallennukseen, ja tilin
//      poiston siivous poistaa jokaisen poistettavaksi merkityn. Uusi
//      laitteelle tallentava moduuli ilman rekisterimerkintää kaataa
//      testin -- muuten poistetun tilin data jäisi laitteelle hiljaa.
//   2. Kun uloskirjautuminen poiston jälkeen epäonnistuu (supabase-js
//      palauttaa { error } heittämättä, eikä SIGNED_OUT laukea), laite
//      siivotaan silti eikä istunto jää palautettavaksi.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { jsFilesIn, read, readCode } from './helpers/sources.mjs';
import {
  DEVICE_STORAGE, DEVICE_ACTION, purgeDeviceDataForUser, clearAuthSession, saveAuthNote, takeAuthNote
} from '../src/data/deviceData.js';
import { DEVICE_DEFAULTS } from '../src/data/preferences.js';
import { resetQueueStoreForTests } from '../src/data/offlineQueueStore.js';
import { resetTimerStoreForTests } from '../src/data/timerStore.js';
import { setClient } from '../src/data/client.js';
import { setUser, getUser, clearUser } from '../src/data/session.js';
import { resetState, setTasks, getState } from '../src/app/state.js';
import { normalizeTask } from '../src/domain/task.js';
import { signOutAndClean, forceLocalSignOut } from '../src/app/accountDeletion.js';
import { queueAuthNote, showAuthGate } from '../src/app/auth.js';
import { offline } from '../src/app/offline.js';

const DELETED = 'dddddddd-0000-4000-8000-00000000000d';
const OTHER = 'eeeeeeee-0000-4000-8000-00000000000e';
const SESSION_KEY = 'sb-abcdefghijklmnopqrst-auth-token';

const ORIGINAL_LOCATION = globalThis.location;

function installStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  globalThis.localStorage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
    key: index => [...data.keys()][index] ?? null,
    get length() { return data.size; },
    _data: data
  };
  return data;
}

beforeEach(() => {
  resetQueueStoreForTests();
  resetTimerStoreForTests();
  clearUser();
  resetState();
});

afterEach(() => {
  offline.deactivate();
  queueAuthNote(null);
  delete globalThis.localStorage;
  delete globalThis.document;
  if (ORIGINAL_LOCATION === undefined) delete globalThis.location;
  else globalThis.location = ORIGINAL_LOCATION;
  setClient(null);
  clearUser();
  resetState();
});

// ------------------------------------------------------------- rekisteri

const STORAGE_API = /\b(?:localStorage|sessionStorage|indexedDB)\b|document\.cookie/;
const KEY_LITERAL = /['"`]((?:__)?manifestival[.:_][^'"`\s]*)['"`]/g;

test('KRIITTINEN: jokainen src/:n selaintallennuksen avainetuliite on rekisterissä', () => {
  const registered = new Set(DEVICE_STORAGE.map(entry => entry.prefix));
  const found = new Map();
  for (const file of jsFilesIn('src')) {
    for (const match of readCode(file).matchAll(KEY_LITERAL)) found.set(match[1], file);
  }
  assert.ok(found.size >= 5, 'avainhaku ei löytänyt tunnettuja avaimia -- haku on rikki');
  const unregistered = [...found].filter(([literal]) => !registered.has(literal))
    .map(([literal, file]) => `${literal} (${file})`);
  assert.deepEqual(unregistered, [],
    'Laitteelle tallennetaan avaimella, jota src/data/deviceData.js ei tunne. Lisää merkintä '
    + 'DEVICE_STORAGE:en ja päätä, poistetaanko se tilin poistossa.');
});

test('KRIITTINEN: jokainen selaintallennusta käyttävä moduuli omistaa rekisterimerkinnän', () => {
  const owners = new Set(DEVICE_STORAGE.map(entry => entry.owner));
  const users = jsFilesIn('src').filter(file => STORAGE_API.test(readCode(file)));
  assert.ok(users.includes('src/data/preferences.js'), 'haku ei löytänyt tunnettua käyttäjää -- haku on rikki');
  const unowned = users.filter(file => !owners.has(file));
  assert.deepEqual(unowned, [],
    'Moduuli käyttää selaintallennusta ilman merkintää src/data/deviceData.js:ssä.');
});

test('rekisterin merkinnät ovat täydellisiä ja omistaja todella käyttää etuliitettään', () => {
  const actions = new Set(Object.values(DEVICE_ACTION));
  const prefixes = new Set();
  for (const entry of DEVICE_STORAGE) {
    assert.ok(Object.isFrozen(entry), entry.prefix);
    assert.match(entry.prefix, /\S/);
    assert.equal(prefixes.has(entry.prefix), false, 'kahdesti: ' + entry.prefix);
    prefixes.add(entry.prefix);
    assert.match(entry.contains, /\S/, entry.prefix + ': mitä avaimessa on');
    assert.ok(actions.has(entry.onSignOut), entry.prefix);
    assert.ok(actions.has(entry.onDelete), entry.prefix);
    assert.notEqual(entry.onDelete, DEVICE_ACTION.KEEP, entry.prefix + ': tilin poisto ei saa jättää dataa laitteelle');
    assert.ok(read(entry.owner).includes(entry.prefix), `${entry.owner} ei käytä etuliitettä ${entry.prefix}`);
  }
});

test('laiteasetuksia luetaan ja kirjoitetaan vain DEVICE_DEFAULTS-avaimilla (muuten tyhjennys ohittaisi ne)', () => {
  const used = new Set();
  for (const file of jsFilesIn('src')) {
    for (const match of readCode(file).matchAll(/(?:get|set)DevicePreference\(\s*['"`](\w+)['"`]/g)) used.add(match[1]);
  }
  assert.ok(used.size >= 2, 'haku ei löytänyt asetuskutsuja -- haku on rikki');
  const undeclared = [...used].filter(key => !Object.prototype.hasOwnProperty.call(DEVICE_DEFAULTS, key));
  assert.deepEqual(undeclared, []);
});

// ------------------------------------------------------- poiston siivous

function seedDevice() {
  const initial = { 'unrelated-key': 'x', [SESSION_KEY]: '{"access_token":"t"}' };
  for (const entry of DEVICE_STORAGE) {
    if (entry.onDelete === DEVICE_ACTION.PURGE) {
      initial[entry.prefix + DELETED] = JSON.stringify({ userId: DELETED, note: 'poistetun tilin data' });
      initial[entry.prefix + OTHER] = JSON.stringify({ userId: OTHER });
    }
  }
  for (const key of Object.keys(DEVICE_DEFAULTS)) initial['manifestival:' + key] = JSON.stringify(DEVICE_DEFAULTS[key]);
  return installStorage(initial);
}

test('KRIITTINEN: tilin poiston siivous poistaa jokaisen poistettavan avaimen, muut säilyvät', () => {
  const data = seedDevice();

  purgeDeviceDataForUser(DELETED);
  clearAuthSession();

  for (const entry of DEVICE_STORAGE) {
    if (entry.onDelete === DEVICE_ACTION.PURGE) {
      assert.equal(data.has(entry.prefix + DELETED), false, entry.prefix + ': poistetun tilin avain jäi');
      assert.equal(data.has(entry.prefix + OTHER), true, entry.prefix + ': toisen käyttäjän avain ei saa kadota');
    }
  }
  const leftovers = [...data.keys()].filter(key => DEVICE_STORAGE.some(entry =>
    entry.onDelete === DEVICE_ACTION.CLEAR && key.startsWith(entry.prefix)));
  assert.deepEqual(leftovers, [], 'tyhjennettävä avain jäi laitteelle');
  assert.equal(data.get('unrelated-key'), 'x', 'vieras avain ei kuulu sovellukselle');
  assert.equal([...data.keys()].some(key => key.includes(DELETED)), false);
});

test('siivous kelvottomalla tunnisteella ei poista toisten dataa eikä heitä', () => {
  const data = seedDevice();
  assert.doesNotThrow(() => purgeDeviceDataForUser(null));
  assert.doesNotThrow(() => purgeDeviceDataForUser('../../x'));
  assert.equal(data.has('manifestival.offlineQueue.v1.' + DELETED), true);
  assert.equal(data.has('manifestival.offlineQueue.v1.' + OTHER), true);
});

test('clearAuthSession poistaa vain istuntoavaimet eikä heitä ilman tallennusta', () => {
  const data = installStorage({
    [SESSION_KEY]: '{}', [SESSION_KEY + '-code-verifier']: 'v', 'supabase.auth.token': '{}',
    'sb-x': 'ei istunto', ['manifestival.timer.v1.' + OTHER]: '{}'
  });
  assert.equal(clearAuthSession(), 3);
  assert.deepEqual([...data.keys()].sort(), ['manifestival.timer.v1.' + OTHER, 'sb-x']);

  delete globalThis.localStorage;
  assert.equal(clearAuthSession(), 0);
});

test('KRIITTINEN: tilin poisto ajaa laitteen siivouksen onnistumisen jälkeen ja ennen uloskirjautumista', () => {
  const ui = readCode('src/app/accountDeletion.js');
  const succeededAt = ui.indexOf('FLOW_EVENT.SUCCEEDED');
  const purgeAt = ui.indexOf('purgeDeviceDataForUser(');
  const signOutAt = ui.indexOf('await signOutAndClean()');
  assert.ok(purgeAt > -1, 'poisto ei siivoa laitteen tallennusta');
  assert.ok(succeededAt < purgeAt && purgeAt < signOutAt);
  assert.ok(ui.indexOf('offline.purge(') < purgeAt, 'jonon muistikopio ennen tallennusta');
});

// ---------------------------------------- epäonnistunut uloskirjautuminen

function seedSignedIn() {
  setUser({ id: DELETED, email: 'poistettu@example.com' });
  setTasks([normalizeTask({ id: 't1', title: 'Poistetun tilin tehtävä', date: '2026-09-26' })]);
  return installStorage({
    [SESSION_KEY]: '{"access_token":"t"}',
    'manifestival:lastScreen': '"screen-week"',
    'manifestival:automationLevel': '3',
    'unrelated-key': 'x'
  });
}

function trackReload() {
  const calls = { reload: 0 };
  globalThis.location = { reload: () => { calls.reload += 1; } };
  return calls;
}

for (const [label, signOut] of [
  ['palauttaa virheen heittämättä (verkkovirhe)', async () => ({ error: { status: 0, name: 'AuthRetryableFetchError' } })],
  ['heittää', async () => { throw new Error('verkko poikki'); }]
]) {
  test(`KRIITTINEN: uloskirjautuminen poiston jälkeen ${label} -> laite siivotaan silti`, async () => {
    const data = seedSignedIn();
    const calls = trackReload();
    let signOutCalls = 0;
    setClient({ auth: { signOut: async options => { signOutCalls += 1; assert.deepEqual(options, { scope: 'local' }); return signOut(); } } });

    await signOutAndClean();

    assert.equal(signOutCalls, 1);
    assert.equal(getUser(), null, 'poistetun tilin käyttäjä jäi muistiin');
    assert.deepEqual(getState().tasks, [], 'poistetun tilin tehtävät jäivät näkyviin');
    assert.equal(data.has(SESSION_KEY), false, 'istunto jäi laitteelle: uudelleenlataus palauttaisi poistetun tilin');
    assert.equal(data.has('manifestival:lastScreen'), false);
    assert.equal(data.has('manifestival:automationLevel'), false);
    assert.equal(data.get('unrelated-key'), 'x');
    assert.equal(calls.reload, 1, 'sivu ladataan uudelleen puhtaana');
  });
}

test('onnistunut uloskirjautuminen ei tee pakkosiivousta (SIGNED_OUT hoitaa sen)', async () => {
  const data = seedSignedIn();
  const calls = trackReload();
  setClient({ auth: { signOut: async () => ({ error: null }) } });

  await signOutAndClean();

  assert.equal(calls.reload, 0);
  assert.equal(data.has(SESSION_KEY), true, 'supabase-js poistaa istunnon itse onnistuessaan');
  assert.equal(getUser().id, DELETED, 'siivous kulkee SIGNED_OUT-polkua, ei tätä');
});

test('forceLocalSignOut toimii myös ilman selaintallennusta ja ilman käyttäjää', () => {
  assert.doesNotThrow(() => forceLocalSignOut());
  assert.equal(getUser(), null);
});

// ------------------------------- päätetila näkyy myös varapolun latauksen jälkeen

const NOTE_KEY = 'manifestival.authNote.v1';
const UNVERIFIED_NOTE = 'Tilisi on poistettu, mutta poiston jälkitarkistus jäi kesken. '
  + 'Ota yhteyttä tukeen, jos tietoja jäi näkyviin.';

/** Kirjautumisportin tynkä-DOM: vain ne tunnisteet, joita auth.js koskee. */
function installAuthGateDom() {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, {
        id, value: '', textContent: '', style: {},
        classList: {
          add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
          toggle: (c, on) => (on ? classes.add(c) : classes.delete(c))
        },
        setAttribute() {}
      });
    }
    return nodes.get(id);
  };
  globalThis.document = { getElementById: node };
  return node;
}

let reloads = 0;
/** Uudelleenlataus: auth.js alusta, jolloin muistissa jonottanut viesti on poissa. */
function reloadedAuth() {
  reloads += 1;
  return import(`../src/app/auth.js?uudelleenlataus=${reloads}`);
}

for (const [label, signOut] of [
  ['palauttaa virheen', async () => ({ error: { status: 0, name: 'AuthRetryableFetchError' } })],
  ['heittää', async () => { throw new Error('verkko poikki'); }]
]) {
  test(`KRIITTINEN: uloskirjautuminen poiston jälkeen ${label} -> kirjautumisportti kertoo poistosta latauksen jälkeen`, async () => {
    const data = seedSignedIn();
    const calls = trackReload();
    setClient({ auth: { signOut } });
    queueAuthNote(UNVERIFIED_NOTE);

    await signOutAndClean();
    assert.equal(calls.reload, 1, 'esiehto: varapolku lataa sivun uudelleen');

    const auth = await reloadedAuth();
    const dom = installAuthGateDom();
    auth.showAuthGate();
    assert.equal(dom('authNote').textContent, UNVERIFIED_NOTE,
      'uudelleenlataus hävitti viestin: käyttäjä ei näe, että tili poistettiin eikä että jälkitarkistus jäi kesken');
    assert.equal(dom('authNote').style.display, 'block');
    assert.equal(dom('authGate').classList.contains('open'), true);
    assert.equal(data.has(NOTE_KEY), false, 'viesti on kertaluonteinen');

    // Seuraava portti (uloskirjautuminen myöhemmin) ei näytä vanhaa viestiä.
    auth.showAuthGate();
    assert.equal(dom('authNote').textContent, '');
  });
}

test('onnistunut uloskirjautuminen ei tallenna viestiä laitteelle (SIGNED_OUT näyttää sen muistista)', async () => {
  const data = seedSignedIn();
  trackReload();
  setClient({ auth: { signOut: async () => ({ error: null }) } });
  queueAuthNote(UNVERIFIED_NOTE);

  await signOutAndClean();
  assert.equal(data.has(NOTE_KEY), false);

  const dom = installAuthGateDom();
  showAuthGate();
  assert.equal(dom('authNote').textContent, UNVERIFIED_NOTE);
});

test('kirjautumisportti poistaa tallennetun viestin aina, myös kun muistissa on uudempi', () => {
  const data = installStorage({ [NOTE_KEY]: 'Vanha viesti' });
  const dom = installAuthGateDom();
  queueAuthNote('Uusi viesti');
  showAuthGate();
  assert.equal(dom('authNote').textContent, 'Uusi viesti');
  assert.equal(data.has(NOTE_KEY), false);
});

test('portin viestin tallennus ei heitä eikä hyväksy kelvotonta arvoa', () => {
  assert.equal(saveAuthNote('x'), false, 'ilman tallennusta ei väitetä tallennetuksi');
  assert.equal(takeAuthNote(), null);

  const data = installStorage();
  assert.equal(saveAuthNote(''), false);
  assert.equal(saveAuthNote(null), false);
  assert.equal(saveAuthNote('x'.repeat(501)), false);
  assert.equal(data.size, 0);

  data.set(NOTE_KEY, 'y'.repeat(501));
  assert.equal(takeAuthNote(), null, 'liian pitkä arvo ei ole sovelluksen oma viesti');
  assert.equal(data.has(NOTE_KEY), false, 'kelvoton arvo poistetaan');

  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(saveAuthNote('z'), false);
});
