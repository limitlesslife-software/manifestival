// Alustakerroksen testit.
//
// Alustakerros on ainoa paikka, joka saa tietää selaimesta ja
// natiivikuoresta. Siksi juuri se on paikka, jossa virhe leviää
// huomaamattomimmin: väärä vastaus "tuetaanko tätä" ei kaada mitään, se vain
// piilottaa ominaisuuden tai lupaa liikoja.
//
// KOLME ERI KYSYMYSTÄ, JOITA EI SAA SEKOITTAA
//   supported    alusta pystyy tähän
//   implemented  Manifestival on toteuttanut tämän
//   permission   käyttäjä on antanut luvan
//   available    kaikki edellä on kunnossa juuri nyt
//
// Nämä testit ajetaan Nodessa, jossa ei ole selainrajapintoja. Alustaa
// simuloidaan asettamalla globaaleja ennen moduulin latausta.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { read, readCode, browserModules, layerOf, importsOf } from './helpers/sources.mjs';

/**
 * Alustamoduulit ladataan kerran.
 *
 * Kyvykkyydet luetaan globaaleista KUTSUHETKELLÄ eikä latausaikana, joten
 * sama instanssi riittää. Välimuistin ohitus kyselymerkkijonolla olisi
 * suorastaan haitallista: se toimisi vain päällimmäiselle moduulille, ja
 * sisemmät importit osoittaisivat silti alkuperäiseen instanssiin.
 */
const platformModules = {
  capabilities: await import('../src/platform/capabilities.js'),
  notifications: await import('../src/platform/notifications.js'),
  index: await import('../src/platform/index.js')
};

async function loadPlatform() {
  return platformModules;
}

const originalCapacitor = globalThis.Capacitor;
const originalNotification = globalThis.Notification;

/** Teeskentele natiivikuorta. */
function fakeNative(platform = 'android') {
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform
  };
}

/** Teeskentele selaimen Notification-rajapintaa annetulla lupatilalla. */
function fakeNotificationApi(permission, { onRequest = null } = {}) {
  function FakeNotification() {}
  FakeNotification.permission = permission;
  FakeNotification.requestPermission = onRequest
    || (async () => permission);
  globalThis.Notification = FakeNotification;
  return FakeNotification;
}

beforeEach(() => {
  delete globalThis.Capacitor;
  delete globalThis.Notification;
  platformModules.capabilities.resetNativePermission();
});

afterEach(() => {
  if (originalCapacitor === undefined) delete globalThis.Capacitor;
  else globalThis.Capacitor = originalCapacitor;
  if (originalNotification === undefined) delete globalThis.Notification;
  else globalThis.Notification = originalNotification;
});

// ------------------------------------------------------- rakenteen eheys

test('platform/index.js ei vie samaa nimeä kahdesti', () => {
  // Kaksoisvienti on syntaksivirhe, mutta se on myös merkki siitä että
  // kaksi mallia elää rinnakkain. Tarkistetaan nimet erikseen.
  const source = read('src/platform/index.js');
  const names = [];

  for (const match of source.matchAll(/^export (?:const|function|async function) (\w+)/gm)) {
    names.push(match[1]);
  }
  for (const block of source.matchAll(/^export \{([^}]*)\}/gm)) {
    for (const name of block[1].split(',')) {
      const clean = name.trim().split(/\s+as\s+/).pop();
      if (clean) names.push(clean);
    }
  }

  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  assert.deepEqual(duplicates, [], 'kaksoisvienti: ' + duplicates.join(', '));
});

test('isNativeShell on määritelty täsmälleen kerran', () => {
  // Kaksi toteutusta erkanisi väistämättä, ja natiivipolku alkaisi käyttäytyä
  // eri tavoin sen mukaan kumman kautta se kutsutaan.
  const definitions = [];
  for (const file of browserModules()) {
    const source = readCode(file);
    const count = (source.match(/function isNativeShell\s*\(/g) || []).length;
    for (let index = 0; index < count; index++) definitions.push(file);
  }
  assert.deepEqual(definitions, ['src/platform/capabilities.js'],
    'isNativeShell määritelty: ' + definitions.join(', '));
});

test('natiivivaatimuksen teksti on vain yhdessä paikassa', () => {
  const literal = "'Vaatii natiivisovelluksen (ks. docs/ANDROID-STRATEGY.md)'";
  const owners = browserModules().filter(file => readCode(file).includes(literal));
  assert.deepEqual(owners, ['src/platform/capabilities.js'],
    'sama teksti kahdessa paikassa erkanee: ' + owners.join(', '));
});

test('platform-kerros ei importoi domainia, dataa eikä ui:ta', () => {
  for (const file of browserModules().filter(f => layerOf(f) === 'platform')) {
    for (const dependency of importsOf(file)) {
      assert.ok(['lib', 'platform'].includes(layerOf(dependency)),
        `${file} importoi ${dependency}`);
    }
  }
});

test('domain ei importoi platformia', () => {
  // Jos domain tuntisi alustan, se lakkaisi olemasta testattavissa ilman
  // selainta — ja koko kerrosjaon perustelu katoaisi.
  for (const file of browserModules().filter(f => layerOf(f) === 'domain')) {
    for (const dependency of importsOf(file)) {
      assert.notEqual(layerOf(dependency), 'platform', `${file} -> ${dependency}`);
    }
  }
  for (const file of browserModules().filter(f => layerOf(f) === 'domain')) {
    assert.equal(readCode(file).includes('Capacitor'), false,
      `${file} mainitsee Capacitorin — domainin pitää pysyä alustariippumattomana`);
  }
});

// -------------------------------------- supported / implemented / permission

test('jokainen kyvykkyys palauttaa täyden ja yhtenäisen muodon', async () => {
  const { capabilities } = await loadPlatform();
  const expected = ['name', 'label', 'supported', 'implemented',
    'permission', 'available', 'reason', 'plannedNote'];

  for (const name of capabilities.CAPABILITIES) {
    const state = capabilities.capability(name);
    assert.deepEqual(Object.keys(state).sort(), [...expected].sort(),
      `${name}: kentät poikkeavat`);
    assert.equal(typeof state.supported, 'boolean');
    assert.equal(typeof state.implemented, 'boolean');
    assert.equal(typeof state.available, 'boolean');
  }
});

test('tuntematon kyvykkyys ei kaada vaan kertoo olevansa tuntematon', async () => {
  const { capabilities } = await loadPlatform();
  const state = capabilities.capability('teleportation');
  assert.equal(state.supported, false);
  assert.equal(state.available, false);
  assert.equal(state.permission, capabilities.PERMISSION.UNSUPPORTED);
});

test('REGRESSIO: sovittimet eivät sekoita supported- ja implemented-tiloja', async () => {
  // AIEMPI BUGI: location.capability() palautti `supported: state.implemented`.
  // Natiivikuoressa rekisteri sanoi supported=true mutta sovitin false, joten
  // Android-käyttäjälle olisi kerrottu ettei laite tue sijaintia. Puute ei
  // ollut laitteessa vaan sovelluksessa.
  fakeNative();
  const { index, capabilities } = await loadPlatform();

  const pairs = [
    [index.location, capabilities.CAPABILITY.LOCATION],
    [index.background, capabilities.CAPABILITY.BACKGROUND],
    [index.speech, capabilities.CAPABILITY.SPEECH],
    [index.notifications, capabilities.CAPABILITY.NOTIFICATIONS]
  ];

  for (const [adapter, name] of pairs) {
    const fromAdapter = adapter.capability();
    const fromRegistry = capabilities.capability(name);
    assert.deepEqual(fromAdapter, fromRegistry,
      `${name}: sovitin ja rekisteri eri mieltä`);
  }

  // Natiivikuori TUKEE sijaintia, mutta sovellus ei ole sitä toteuttanut.
  const locationState = index.location.capability();
  assert.equal(locationState.supported, true, 'natiivialusta tukee sijaintia');
  assert.equal(locationState.implemented, false, 'sovellus ei ole toteuttanut sitä');
  assert.equal(locationState.available, false, 'siksi se ei ole käytettävissä');
  assert.ok(locationState.plannedNote, 'suunnitelma pitää kertoa käyttäjälle');
});

test('toteuttamaton kyvykkyys ei ole koskaan käytettävissä', async () => {
  fakeNative();
  const { capabilities } = await loadPlatform();
  for (const name of capabilities.CAPABILITIES) {
    const state = capabilities.capability(name);
    if (state.implemented) continue;
    assert.equal(state.available, false, `${name}: toteuttamaton mutta "käytettävissä"`);
  }
});

test('selaimessa ilmoitukset ovat tuettuja vasta kun rajapinta on olemassa', async () => {
  let platform = await loadPlatform();
  assert.equal(platform.capabilities.capability('notifications').supported, false,
    'ilman Notification-rajapintaa ei tueta');

  fakeNotificationApi('granted');
  platform = await loadPlatform();
  const state = platform.capabilities.capability('notifications');
  assert.equal(state.supported, true);
  assert.equal(state.implemented, true);
  assert.equal(state.permission, platform.capabilities.PERMISSION.GRANTED);
  assert.equal(state.available, true);
});

test('lupatilat kartoittuvat yhtenäisiksi arvoiksi', async () => {
  const cases = [
    ['granted', 'granted'],
    ['denied', 'denied'],
    ['default', 'prompt']
  ];
  for (const [browserValue, expected] of cases) {
    fakeNotificationApi(browserValue);
    const { capabilities } = await loadPlatform();
    assert.equal(capabilities.permissionOf('notifications'), expected,
      `selaimen "${browserValue}" pitäisi kartoittua arvoon "${expected}"`);
  }
});

test('estetty lupa tarkoittaa ettei ilmoitus ole käytettävissä', async () => {
  fakeNotificationApi('denied');
  const { capabilities, notifications } = await loadPlatform();
  const state = capabilities.capability('notifications');

  assert.equal(state.supported, true, 'selain tukee — käyttäjä vain kielsi');
  assert.equal(state.available, false);
  assert.equal(notifications.describeSupport().level, 'blocked');
});

test('natiivikuoressa ilmoitukset ovat tuettuja mutta eivät vielä toteutettuja', async () => {
  fakeNative();
  const { capabilities } = await loadPlatform();
  const state = capabilities.capability('notifications');
  assert.equal(state.supported, true);
  assert.equal(state.implemented, false, 'natiivisovitin on vielä PLANNED');
  assert.equal(state.available, false);
});

// ------------------------------------------------------------- luvan pyyntö

test('KRIITTINEN: kyvykkyyskysely ei koskaan pyydä lupaa', async () => {
  // Käynnistyksessä ilmestyvä lupakysely on paras tapa saada kieltävä
  // vastaus pysyvästi. Siksi tämä on invariantti, ei tyylikysymys.
  let requested = 0;
  fakeNotificationApi('default', {
    onRequest: async () => { requested++; return 'granted'; }
  });

  const { capabilities, notifications, index } = await loadPlatform();

  capabilities.capability('notifications');
  capabilities.allCapabilities();
  capabilities.isAvailable('notifications');
  capabilities.isSupported('notifications');
  capabilities.permissionOf('notifications');
  notifications.support();
  notifications.permission();
  notifications.describeSupport();
  index.capabilities();

  assert.equal(requested, 0, 'kyvykkyyskysely pyysi lupaa');
});

test('lupa pyydetään vain nimenomaisella kutsulla', async () => {
  let requested = 0;
  fakeNotificationApi('default', {
    onRequest: async () => { requested++; return 'granted'; }
  });

  const { notifications } = await loadPlatform();
  const result = await notifications.requestPermission();

  assert.equal(requested, 1);
  assert.equal(result.ok, true);
  assert.equal(result.permission, 'granted');
});

test('kielteinen lupavastaus kerrotaan rehellisesti', async () => {
  fakeNotificationApi('default', { onRequest: async () => 'denied' });
  const { notifications } = await loadPlatform();
  const result = await notifications.requestPermission();

  assert.equal(result.ok, false);
  assert.equal(result.permission, 'denied');
  assert.match(result.reason, /estetty/i);
});

test('lupapyyntö tukemattomalla alustalla ei kaada', async () => {
  const { notifications } = await loadPlatform();
  const result = await notifications.requestPermission();
  assert.equal(result.ok, false);
  assert.equal(result.permission, 'unsupported');
});

test('lupapyynnön heittämä poikkeus ei vuoda kutsujalle', async () => {
  fakeNotificationApi('default', {
    onRequest: async () => { throw new Error('selain kieltäytyi'); }
  });
  const { notifications } = await loadPlatform();
  const result = await notifications.requestPermission();
  assert.equal(result.ok, false);
  assert.equal(result.permission, 'prompt');
});

// -------------------------------------------------------- ilmoitusten näyttö

test('ilmoitusta ei yritetä näyttää ilman lupaa', async () => {
  let constructed = 0;
  fakeNotificationApi('denied');
  globalThis.Notification = class {
    constructor() { constructed++; }
    static permission = 'denied';
    static async requestPermission() { return 'denied'; }
  };

  const { notifications } = await loadPlatform();
  const result = await notifications.showNow({ id: 'x', title: 'T', body: 'B' });

  assert.equal(result.ok, false);
  assert.equal(constructed, 0, 'ilmoitus luotiin vaikka lupaa ei ollut');
});

test('luvan kanssa ilmoitus näytetään ja tunniste välitetään tagina', async () => {
  const created = [];
  class FakeNotification {
    constructor(title, options) { created.push({ title, options }); }
    static permission = 'granted';
    static async requestPermission() { return 'granted'; }
  }
  globalThis.Notification = FakeNotification;

  const { notifications } = await loadPlatform();
  const result = await notifications.showNow({
    id: 'task_reminder:t1:2026-01-05', title: 'Hammaslääkäri', body: 'Alkaa klo 15:00',
    channel: 'sound'
  });

  assert.equal(result.ok, true);
  assert.equal(created.length, 1);
  assert.equal(created[0].title, 'Hammaslääkäri');
  // Tag estää saman muistutuksen kahdentumisen näytöllä.
  assert.equal(created[0].options.tag, 'task_reminder:t1:2026-01-05');
  assert.equal(created[0].options.silent, false);
});

test('hiljainen kanava välittyy ilmoitukselle', async () => {
  const created = [];
  globalThis.Notification = class {
    constructor(title, options) { created.push(options); }
    static permission = 'granted';
    static async requestPermission() { return 'granted'; }
  };

  const { notifications } = await loadPlatform();
  await notifications.showNow({ id: 'x', title: 'T', body: 'B', channel: 'silent' });
  assert.equal(created[0].silent, true);
});

test('konstruktorin heittämä virhe ei kaada kutsujaa', async () => {
  globalThis.Notification = class {
    constructor() { throw new Error('kiintiö täynnä'); }
    static permission = 'granted';
    static async requestPermission() { return 'granted'; }
  };

  const { notifications } = await loadPlatform();
  const result = await notifications.showNow({ id: 'x', title: 'T', body: 'B' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /ei voitu näyttää/i);
});

// ------------------------------------------------------------- ajastus

test('ajastus kertoo rehellisesti ettei sitä ole toteutettu', async () => {
  // Vaihtoehto — setTimeout, joka toimii vain avoimessa välilehdessä —
  // olisi lupaus, jota ei voi pitää. Rehellinen epäonnistuminen on parempi.
  fakeNotificationApi('granted');
  const { notifications } = await loadPlatform();

  const result = await notifications.schedule([{ id: 'a' }, { id: 'b' }]);
  assert.equal(result.ok, false);
  assert.equal(result.planned, true);
  assert.equal(result.scheduled, 0);
  assert.equal(result.requested, 2);
  assert.ok(result.reason);
});

test('ajastus ei kaadu ilman argumenttia', async () => {
  const { notifications } = await loadPlatform();
  const result = await notifications.schedule();
  assert.equal(result.requested, 0);
});

// --------------------------------------------------------------- apiUrl

test('apiUrl käyttää suhteellista polkua webissä', async () => {
  const { index } = await loadPlatform();
  assert.equal(index.apiUrl('/api/parse'), '/api/parse');
});

test('REGRESSIO: apiUrl osoittaa tuotantoon natiivikuoressa', async () => {
  // Natiivikuoressa sivu ladataan laitteen tiedostojärjestelmästä, joten
  // suhteellinen polku osuisi kuoreen eikä koskaan palvelimeen.
  fakeNative();
  const { index } = await loadPlatform();
  assert.equal(index.apiUrl('/api/parse'), index.PRODUCTION_ORIGIN + '/api/parse');
  assert.match(index.PRODUCTION_ORIGIN, /^https:\/\//);
});

// ------------------------------------------------------------ yhteenveto

test('capabilities() kokoaa kaikki kyvykkyydet käyttöliittymälle', async () => {
  fakeNotificationApi('granted');
  const { index, capabilities } = await loadPlatform();
  const summary = index.capabilities();

  assert.equal(summary.platform, 'web');
  assert.equal(summary.native, false);
  for (const name of capabilities.CAPABILITIES) {
    assert.ok(summary.registry[name], `${name} puuttuu yhteenvedosta`);
  }
  for (const key of ['notifications', 'location', 'speech', 'background']) {
    assert.equal(typeof summary[key].supported, 'boolean', `${key}.supported puuttuu`);
    assert.equal(typeof summary[key].available, 'boolean', `${key}.available puuttuu`);
  }
});

test('natiivikuori tunnistetaan ja nimetään', async () => {
  fakeNative('android');
  const { index } = await loadPlatform();
  const summary = index.capabilities();
  assert.equal(summary.native, true);
  assert.equal(summary.platform, 'android');
  assert.equal(index.speech.supportsBackgroundCapture(), true);
});

test('taustakuuntelu ei ole mahdollista selaimessa', async () => {
  const { index } = await loadPlatform();
  assert.equal(index.speech.supportsBackgroundCapture(), false);
});

test('toteuttamattomat toiminnot palauttavat epäonnistumisen eivätkä heitä', async () => {
  const { index } = await loadPlatform();
  for (const call of [
    () => index.location.current(),
    () => index.location.watchArrival(),
    () => index.background.register()
  ]) {
    const result = await call();
    assert.equal(result.ok, false);
    assert.ok(result.reason, 'syy pitää kertoa');
  }
});

// ------------------------------------------------------------- verkko

test('verkkoyhteys ei vaadi lupaa ja seuraa navigator.onLine-tilaa', async () => {
  const original = globalThis.navigator;
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: false }, configurable: true, writable: true
    });
    let { capabilities } = await loadPlatform();
    let state = capabilities.capability('network');
    assert.equal(state.permission, capabilities.PERMISSION.NOT_REQUIRED);
    assert.equal(state.available, false, 'offline-tilassa verkko ei ole käytettävissä');

    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true }, configurable: true, writable: true
    });
    ({ capabilities } = await loadPlatform());
    state = capabilities.capability('network');
    assert.equal(state.available, true);
  } finally {
    if (original === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, 'navigator', {
      value: original, configurable: true, writable: true
    });
  }
});
