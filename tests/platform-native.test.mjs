// Natiivi-ilmoitussovittimen testit.
//
// Sovitin puhuu Capacitorin Local Notifications -liitännäiselle. Liitännäistä
// ei ole työpöydällä, eikä fyysistä laitetta käytetä — joten se korvataan
// muistissa elävällä kaksoiskappaleella, joka tallentaa saamansa kutsut.
//
// Näin testataan juuri se, mitä desktopilla VOI testata: muunnos domainin
// aikomuksesta laitteen ymmärtämäksi ilmoitukseksi, lupatilan käsittely ja
// virhetilanteiden rehellisyys. Sitä, näkyykö ilmoitus oikeasti ruudulla,
// ei voi tästä ympäristöstä todentaa — ja sitä ei siksi väitetäkään.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { ROOT } from './helpers/sources.mjs';

const ORIGINAL_CAPACITOR = globalThis.Capacitor;

/** Muistissa elävä kaksoiskappale Local Notifications -liitännäisestä. */
function fakePlugin({ display = 'granted', failOn = null, warning = null } = {}) {
  const calls = { schedule: [], cancel: [], createChannel: [], request: 0, check: 0 };
  let pending = [];

  const maybeFail = name => {
    if (failOn === name) throw new Error('laite kieltäytyi: ' + name);
  };

  return {
    calls,
    get pending() { return pending; },
    async checkPermissions() { calls.check++; maybeFail('check'); return { display }; },
    async requestPermissions() { calls.request++; maybeFail('request'); return { display }; },
    async createChannel(options) { calls.createChannel.push(options); maybeFail('channel'); },
    async schedule(options) {
      calls.schedule.push(options);
      maybeFail('schedule');
      pending = [...pending, ...options.notifications.map(n => ({ id: n.id }))];
      // Liitännäinen 8.3+: varoitus, kun tarkka hälytys vaihtui epätarkaksi.
      return warning ? { notifications: [], warning } : { notifications: [] };
    },
    async getPending() { maybeFail('getPending'); return { notifications: pending }; },
    async cancel(options) {
      calls.cancel.push(options);
      maybeFail('cancel');
      const removed = new Set(options.notifications.map(n => n.id));
      pending = pending.filter(item => !removed.has(item.id));
    }
  };
}

/** Asenna natiivikuori annetulla liitännäisellä (tai ilman). */
function installShell(pluginDouble) {
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: pluginDouble ? { LocalNotifications: pluginDouble } : {}
  };
}

/**
 * Alustamoduulit.
 *
 * EI välimuistin ohitusta kyselymerkkijonolla. Se toimisi vain päällimmäiselle
 * moduulille: nativeNotifications.js importtaa './capabilities.js' ILMAN
 * ohitusta, joten testi ja tuotantokoodi päätyisivät KAHTEEN ERI
 * capabilities-instanssiin ja eri lupavälimuistiin. Juuri se piilotti
 * lupavuodon testien välillä.
 *
 * Sen sijaan moduulit ladataan kerran ja jaettu tila nollataan joka testissä,
 * kuten sovelluksessakin: yksi instanssi, nimenomainen nollaus.
 */
const capabilities = await import('../src/platform/capabilities.js');
const native = await import('../src/platform/nativeNotifications.js');
const notifications = await import('../src/platform/notifications.js');

async function loadNative() {
  return { capabilities, native, notifications };
}

beforeEach(() => {
  delete globalThis.Capacitor;
  capabilities.resetNativePermission();
});
afterEach(() => {
  if (ORIGINAL_CAPACITOR === undefined) delete globalThis.Capacitor;
  else globalThis.Capacitor = ORIGINAL_CAPACITOR;
  capabilities.resetNativePermission();
});

// -------------------------------------------------------- saatavuus

test('liitännäistä ei löydy selaimesta', async () => {
  const { native } = await loadNative();
  assert.equal(native.isAvailable(), false);
  assert.equal(native.plugin(), null);
});

test('liitännäistä ei löydy natiivikuoresta johon sitä ei ole rekisteröity', async () => {
  installShell(null);
  const { native, capabilities } = await loadNative();

  assert.equal(native.isAvailable(), false);

  // Alusta TUKEE ilmoituksia, mutta tässä kuoressa niitä ei ole toteutettu.
  const state = capabilities.capability('notifications');
  assert.equal(state.supported, true);
  assert.equal(state.implemented, false);
  assert.equal(state.available, false);
});

test('rekisteröity liitännäinen tekee ilmoituksista toteutetun', async () => {
  installShell(fakePlugin());
  const { native, capabilities } = await loadNative();

  assert.equal(native.isAvailable(), true);
  const state = capabilities.capability('notifications');
  assert.equal(state.supported, true);
  assert.equal(state.implemented, true);
});

// ------------------------------------------------------------- lupa

test('lupatila ei ole koskaan myönnetty ennen kuin se on luettu laitteelta', async () => {
  // Väärä oletus "lupa on" saisi sovelluksen luulemaan lähettävänsä
  // ilmoituksia, joita kukaan ei näe.
  installShell(fakePlugin({ display: 'granted' }));
  const { native } = await loadNative();
  assert.equal(native.cachedPermission(), 'prompt');
});

test('refreshPermission lukee tilan mutta ei pyydä lupaa', async () => {
  const plugin = fakePlugin({ display: 'granted' });
  installShell(plugin);
  const { native } = await loadNative();

  const state = await native.refreshPermission();

  assert.equal(state, 'granted');
  assert.equal(plugin.calls.check, 1);
  assert.equal(plugin.calls.request, 0, 'lupaa ei saa pyytää tilaa luettaessa');
});

test('lupa pyydetään vain nimenomaisesta kutsusta', async () => {
  const plugin = fakePlugin({ display: 'granted' });
  installShell(plugin);
  const { native } = await loadNative();

  const result = await native.requestPermission();

  assert.equal(plugin.calls.request, 1);
  assert.equal(result.ok, true);
  assert.equal(result.permission, 'granted');
  assert.equal(native.cachedPermission(), 'granted');
});

test('kielletty lupa kerrotaan rehellisesti', async () => {
  installShell(fakePlugin({ display: 'denied' }));
  const { native } = await loadNative();

  const result = await native.requestPermission();
  assert.equal(result.ok, false);
  assert.equal(result.permission, 'denied');
  assert.match(result.reason, /estetty/i);
});

test('lupakyselyn virhe ei vuoda kutsujalle', async () => {
  installShell(fakePlugin({ failOn: 'request' }));
  const { native } = await loadNative();
  const result = await native.requestPermission();
  assert.equal(result.ok, false);
});

test('natiivin ja rekisterin lupatila on aina sama', async () => {
  // Kaksi erillistä välimuistia erkanisi väistämättä, joten välimuistia on
  // vain yksi. Tämä testi lukitsee sen.
  installShell(fakePlugin({ display: 'granted' }));
  const { native, capabilities } = await loadNative();

  await native.refreshPermission();
  assert.equal(native.cachedPermission(), capabilities.permissionOf('notifications'));
  assert.equal(capabilities.capability('notifications').available, true);

  native.resetPermissionCache();
  assert.equal(native.cachedPermission(), capabilities.permissionOf('notifications'));
  assert.equal(capabilities.capability('notifications').available, false);
});

// ------------------------------------------------- tunnisteen muunnos

test('KRIITTINEN: sama tunniste tuottaa aina saman numeron', async () => {
  // Jos muunnos ei olisi deterministinen, jokainen uudelleenajastus loisi
  // rinnakkaisen kopion sen sijaan että korvaisi aiemman — ja käyttäjä saisi
  // saman muistutuksen yhä uudelleen.
  const { native } = await loadNative();
  const id = 'task_reminder:abc-123:2026-01-05';
  assert.equal(native.numericId(id), native.numericId(id));
});

test('eri tunnisteet eivät törmää käytännön mittakaavassa', async () => {
  const { native } = await loadNative();
  const seen = new Map();
  // Lähtömuistutus ja lähtöketjun kolme vaihetta mukana: ne ajastetaan
  // samaan aikaan kuin tehtävät, ja törmäys korvaisi toisen ilmoituksen.
  const types = ['task_reminder', 'routine_reminder', 'deadline_warning', 'departure_reminder',
    'departure_prepare', 'departure_leave_in_5', 'departure_leave_now'];

  for (const type of types) {
    for (let task = 0; task < 400; task++) {
      for (let day = 1; day <= 28; day++) {
        const id = `${type}:task-${task}:2026-02-${String(day).padStart(2, '0')}`;
        const numeric = native.numericId(id);
        assert.equal(seen.has(numeric), false,
          `törmäys: ${id} ja ${seen.get(numeric)}`);
        seen.set(numeric, id);
      }
    }
  }
  assert.equal(seen.size, types.length * 400 * 28);
});

test('numeerinen tunniste on positiivinen 31-bittinen luku', async () => {
  const { native } = await loadNative();
  for (const id of ['', 'a', 'x'.repeat(300), 'täysin ääkkösiä öäå']) {
    const numeric = native.numericId(id);
    assert.ok(Number.isInteger(numeric), `${id}: ei kokonaisluku`);
    assert.ok(numeric > 0, `${id}: ei positiivinen`);
    assert.ok(numeric <= 0x7fffffff, `${id}: yli 31 bittiä`);
  }
});

// ------------------------------------------------------ ajan muunnos

test('aikomus muuttuu paikalliseksi seinäkelloajaksi', async () => {
  const { native } = await loadNative();
  const at = native.intentAt({ date: '2026-03-15', time: '07:30' });

  assert.ok(at instanceof Date);
  assert.equal(at.getFullYear(), 2026);
  assert.equal(at.getMonth(), 2);
  assert.equal(at.getDate(), 15);
  assert.equal(at.getHours(), 7, 'klo 07:30 tarkoittaa paikallista aikaa');
  assert.equal(at.getMinutes(), 30);
});

test('kelvoton aika ei tuota Date-oliota', async () => {
  const { native } = await loadNative();
  for (const intent of [
    null, {}, { date: '2026-03-15' }, { time: '07:30' },
    { date: 'huomenna', time: '07:30' }, { date: '2026-03-15', time: '25:00' },
    { date: '2026-03-15', time: '7:30' }
  ]) {
    assert.equal(native.intentAt(intent), null, JSON.stringify(intent));
  }
});

// --------------------------------------------------------- ajastus

test('ajastus vaatii luvan', async () => {
  installShell(fakePlugin({ display: 'granted' }));
  const { native } = await loadNative();

  const result = await native.schedule(
    [{ id: 'a', date: '2026-03-15', time: '08:00', title: 'T', body: 'B' }],
    new Date(2026, 2, 15, 7, 0));

  assert.equal(result.ok, false);
  assert.match(result.reason, /lupa/i);
});

test('ajastus välittää aikomukset laitteelle kanavan kanssa', async () => {
  const plugin = fakePlugin({ display: 'granted' });
  installShell(plugin);
  const { native } = await loadNative();
  await native.refreshPermission();

  const result = await native.schedule([
    { id: 'task_reminder:t1:2026-03-15', date: '2026-03-15', time: '08:00',
      title: 'Hammaslääkäri', body: 'Alkaa klo 08:15', type: 'task_reminder', level: 2 }
  ], new Date(2026, 2, 15, 7, 0));

  assert.equal(result.ok, true);
  assert.equal(result.scheduled, 1);
  // TARKOITUKSELLINEN MUUTOS (tasokanavat): aiemmin luotiin yksi kanava.
  // Androidissa ääni ja keskeyttävyys ovat kanavan ominaisuuksia, joten
  // tasot 1–4 tarvitsevat omat kanavansa. Tason 2 kanava on edelleen
  // CHANNEL_ID, jottei jo asennettujen laitteiden kanava vaihdu.
  assert.equal(plugin.calls.createChannel.length, 4, 'jokaiselle tasolle luodaan kanava');
  assert.deepEqual(plugin.calls.createChannel.map(channel => channel.id),
    ['manifestival-info', native.CHANNEL_ID, 'manifestival-action', 'manifestival-critical']);

  const sent = plugin.calls.schedule[0].notifications[0];
  assert.equal(sent.title, 'Hammaslääkäri');
  assert.equal(sent.id, native.numericId('task_reminder:t1:2026-03-15'));
  assert.equal(sent.channelId, native.CHANNEL_ID);
  assert.equal(sent.schedule.at.getHours(), 8);
  assert.equal(sent.extra.intentId, 'task_reminder:t1:2026-03-15');
});

test('KRIITTINEN: mennyttä aikaa ei ajasteta', async () => {
  // Laite näyttäisi menneeseen ajastetun ilmoituksen heti. Ilman tätä
  // suodatusta sovelluksen avaaminen illalla tuottaisi ilmoitusryöpyn koko
  // päivän muistutuksista kerralla.
  const plugin = fakePlugin({ display: 'granted' });
  installShell(plugin);
  const { native } = await loadNative();
  await native.refreshPermission();

  const now = new Date(2026, 2, 15, 20, 0);
  const result = await native.schedule([
    { id: 'a', date: '2026-03-15', time: '08:00', title: 'Mennyt', body: '' },
    { id: 'b', date: '2026-03-15', time: '12:00', title: 'Mennyt', body: '' },
    { id: 'c', date: '2026-03-15', time: '21:00', title: 'Tuleva', body: '' }
  ], now);

  assert.equal(result.scheduled, 1);
  assert.equal(result.requested, 3);
  assert.equal(plugin.calls.schedule[0].notifications[0].title, 'Tuleva');
});

test('pelkät menneet aikomukset eivät ole virhe', async () => {
  const plugin = fakePlugin({ display: 'granted' });
  installShell(plugin);
  const { native } = await loadNative();
  await native.refreshPermission();

  const result = await native.schedule(
    [{ id: 'a', date: '2026-03-15', time: '08:00', title: 'T', body: '' }],
    new Date(2026, 2, 15, 20, 0));

  assert.equal(result.ok, true);
  assert.equal(result.scheduled, 0);
  assert.equal(plugin.calls.schedule.length, 0, 'tyhjää listaa ei lähetetä');
});

test('kriittinen muistutus sallitaan myös lepotilassa', async () => {
  const plugin = fakePlugin({ display: 'granted' });
  installShell(plugin);
  const { native } = await loadNative();
  await native.refreshPermission();

  await native.schedule([
    { id: 'a', date: '2026-03-15', time: '09:00', title: 'Tavallinen', body: '', level: 2 },
    { id: 'b', date: '2026-03-15', time: '10:00', title: 'Kriittinen', body: '', level: 4 }
  ], new Date(2026, 2, 15, 7, 0));

  const sent = plugin.calls.schedule[0].notifications;
  assert.equal(sent[0].schedule.allowWhileIdle, false);
  assert.equal(sent[1].schedule.allowWhileIdle, true);
});

// ------------------------------------------------- tasokanavat ja tarkkuus

async function scheduled(intents, options, pluginOptions = {}) {
  const plugin = fakePlugin({ display: 'granted', ...pluginOptions });
  installShell(plugin);
  const { native } = await loadNative();
  await native.refreshPermission();
  const result = await native.schedule(intents, new Date(2026, 2, 15, 7, 0), options);
  return { plugin, native, result, sent: plugin.calls.schedule[0]?.notifications ?? [] };
}

const at = (id, extra = {}) => ({ id, date: '2026-03-15', time: '09:00', title: 'T', body: '', ...extra });

test('taso valitsee Android-kanavan; tason 2 kanava on edelleen CHANNEL_ID', async () => {
  const { sent, native } = await scheduled([
    at('info', { level: 1, time: '09:01' }),
    at('muistutus', { level: 2, time: '09:02' }),
    at('toiminta', { level: 3, time: '09:03' }),
    at('kriittinen', { level: 4, time: '09:04' }),
    at('tasoton', { time: '09:05' })
  ]);
  assert.deepEqual(sent.map(n => n.channelId), [
    'manifestival-info', native.CHANNEL_ID, 'manifestival-action', 'manifestival-critical', native.CHANNEL_ID
  ], 'tuntematon taso käyttää muistutuskanavaa kuten ennen tasokanavia');
  assert.equal(native.CHANNEL_IDS[2], native.CHANNEL_ID);
});

test('kanavien tärkeys kasvaa tason mukana, eikä tietokanava pidä ääntä', async () => {
  const { native } = await loadNative();
  const importance = native.CHANNELS.map(channel => channel.importance);
  assert.deepEqual(importance, [...importance].sort((a, b) => a - b), 'tärkeys ei saa laskea tason noustessa');
  assert.ok(native.CHANNELS[0].importance <= 2, 'tieto on hiljainen (Android IMPORTANCE_LOW tai alle)');
  assert.equal(native.CHANNELS[1].importance, 4, 'olemassa olevan kanavan tärkeys ei muutu');
  assert.equal(native.CHANNELS[3].importance, 5);
  assert.equal(new Set(native.CHANNELS.map(channel => channel.id)).size, 4);
  assert.ok(Object.isFrozen(native.CHANNELS) && native.CHANNELS.every(Object.isFrozen));
});

test('käyttäjän valitsema hiljainen toimitustapa ohjaa hiljaiselle kanavalle tasosta riippumatta', async () => {
  const { sent } = await scheduled([at('lahto', { level: 4, delivery: 'silent' })]);
  assert.equal(sent[0].channelId, 'manifestival-info');
  assert.equal(sent[0].schedule.allowWhileIdle, true, 'hiljainen kriittinen saa silti herättää ajastimen');
});

test('KRIITTINEN: tarkkaa hälytystä ei pyydetä ilman nimenomaista lupaa (ei asetusnäkymää ilman elettä)', async () => {
  // Liitännäinen avaa "Hälytykset ja muistutukset" -asetukset, jos
  // isExactNotification on true eikä lupaa ole. Oletus on siksi false.
  const { sent, result } = await scheduled([at('a', { level: 4 })]);
  assert.equal(sent[0].isExactNotification, false, 'kenttä on annettava eksplisiittisesti: liitännäisen oletus on true');
  assert.equal(result.exact, false);

  for (const value of [1, 'true', 'yes', {}, null, undefined]) {
    const run = await scheduled([at('b')], { exactAllowed: value });
    assert.equal(run.sent[0].isExactNotification, false, 'vain arvo true sallii: ' + String(value));
  }
  const nothing = await scheduled([at('c')], null);
  assert.equal(nothing.sent[0].isExactNotification, false);
});

test('exactAllowed: true pyytää tarkan hälytyksen ja kertoo, jos laite vaihtoi epätarkaksi', async () => {
  const granted = await scheduled([at('a')], { exactAllowed: true });
  assert.equal(granted.sent[0].isExactNotification, true);
  assert.equal(granted.result.exact, true);
  assert.equal(granted.result.inexactFallback, false);

  const fallback = await scheduled([at('b')], { exactAllowed: true }, { warning: { code: 'SCHEDULED_INEXACT' } });
  assert.equal(fallback.result.ok, true);
  assert.equal(fallback.result.exact, false, 'epätarkaksi vaihtunut ei ole tarkka');
  assert.equal(fallback.result.inexactFallback, true);
});

test('showNow ei koskaan pyydä tarkkaa hälytystä', async () => {
  const plugin = fakePlugin({ display: 'granted' });
  installShell(plugin);
  const { native } = await loadNative();
  await native.refreshPermission();
  await native.showNow({ id: 'x', title: 'T', body: '', level: 3 }, new Date(2026, 2, 15, 7, 0));
  const sent = plugin.calls.schedule[0].notifications[0];
  assert.equal(sent.isExactNotification, false);
  assert.equal(sent.channelId, 'manifestival-action');
});

test('lähtöketju saa herättää laitteen lepotilasta, tavallinen muistutus ei', async () => {
  const { sent } = await scheduled([
    at('p', { type: 'departure_prepare', level: 2, time: '09:01' }),
    at('s', { type: 'departure_leave_in_5', level: 3, time: '09:02' }),
    at('n', { type: 'departure_leave_now', level: 4, time: '09:03' }),
    at('m', { type: 'meal', level: 2, time: '09:04' }),
    at('h', { type: 'habit', level: 2, time: '09:05' })
  ]);
  assert.deepEqual(sent.map(n => n.schedule.allowWhileIdle), [true, true, true, false, false]);
});

test('lisätiedoissa kulkevat kuittausavain ja puhuttava lause, ei muuta', async () => {
  const { sent } = await scheduled([
    at('departure_leave_now:e1:2026-03-15', { type: 'departure_leave_now', level: 4,
      ackKey: 'departure_leave_now:e1:2026-03-15', speech: 'Nyt on lähdön aika.' }),
    at('plain', { time: '09:30' })
  ]);
  assert.deepEqual(sent[0].extra, {
    intentId: 'departure_leave_now:e1:2026-03-15', type: 'departure_leave_now',
    ackKey: 'departure_leave_now:e1:2026-03-15', speech: 'Nyt on lähdön aika.'
  });
  assert.deepEqual(Object.keys(sent[1].extra).sort(), ['intentId', 'type']);
});

test('ankkuroitu aikomus ajastetaan ankkurista todellisina minuutteina', async () => {
  // Seinäkelloaika (time) on näyttöä varten; hetki lasketaan ankkurista.
  const { native } = await loadNative();
  const anchored = {
    id: 'a', date: '2026-03-15', time: '08:10', title: 'T', body: '',
    anchor: { date: '2026-03-15', time: '08:50', offsetMinutes: -40 }
  };
  const instant = native.instantOf(anchored);
  assert.equal(instant.getTime(), native.intentAt({ date: '2026-03-15', time: '08:50' }).getTime() - 40 * 60000);
  assert.equal(instant.getHours(), 8);
  assert.equal(instant.getMinutes(), 10);

  // Kelvoton ankkuri: palataan seinäkelloaikaan, ei arvata.
  for (const anchor of [null, {}, { date: 'x', time: '08:50', offsetMinutes: -40 },
    { date: '2026-03-15', time: '08:50', offsetMinutes: 1.5 },
    { date: '2026-03-15', time: '08:50', offsetMinutes: 99999 }]) {
    assert.equal(native.instantOf({ ...anchored, anchor }).getTime(),
      native.intentAt(anchored).getTime(), JSON.stringify(anchor));
  }
  assert.equal(native.instantOf(null), null);
});

test('KESÄAIKA (Helsinki): olematon kellonaika aikaistuu ja ankkuri pitää todellisen keston', () => {
  // Aikavyöhyke luetaan prosessin käynnistyessä, joten tarkistus ajetaan
  // lapsiprosessissa kiinteällä vyöhykkeellä (kuten tests/dst.test.mjs).
  const code = `
    import { intentAt, instantOf } from './src/platform/nativeNotifications.js';
    const iso = d => d ? d.toISOString() : null;
    console.log(JSON.stringify({
      gap: iso(intentAt({ date: '2026-03-29', time: '03:30' })),
      beforeGap: iso(intentAt({ date: '2026-03-29', time: '02:30' })),
      afterGap: iso(intentAt({ date: '2026-03-29', time: '04:30' })),
      overlap: iso(intentAt({ date: '2026-10-25', time: '03:30' })),
      // Saapumistavoite 04.30 kesäaikaa, lähtö 120 min ennen: 01.30 talviaikaa.
      springLeave: iso(instantOf({ date: '2026-03-29', time: '02:30',
        anchor: { date: '2026-03-29', time: '04:30', offsetMinutes: -120 } })),
      // Syksyllä 25 tunnin yö: saapuminen 04.10 talviaikaa, valmistautuminen 80 min ennen.
      fallPrepare: iso(instantOf({ date: '2026-10-25', time: '02:50',
        anchor: { date: '2026-10-25', time: '04:10', offsetMinutes: -80 } }))
    }));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT, env: { ...process.env, TZ: 'Europe/Helsinki' }, encoding: 'utf8'
  });
  const result = JSON.parse(output.trim().split('\n').pop());

  assert.equal(result.beforeGap, '2026-03-29T00:30:00.000Z', 'normaali talviaika');
  assert.equal(result.afterGap, '2026-03-29T01:30:00.000Z', 'normaali kesäaika');
  assert.equal(result.gap, '2026-03-29T00:30:00.000Z',
    'olematon 03.30 ei saa siirtyä tuntia myöhemmäksi (04.30) vaan aikaistuu');
  assert.equal(result.overlap, '2026-10-25T00:30:00.000Z', 'kahdesti esiintyvä 03.30: aikaisempi hetki');
  assert.equal(result.springLeave, '2026-03-28T23:30:00.000Z',
    'kaksi todellista tuntia ennen 04.30 kesäaikaa on 01.30 talviaikaa');
  assert.equal(result.fallPrepare, '2026-10-25T00:50:00.000Z',
    '80 todellista minuuttia ennen 04.10 talviaikaa');
});

test('uudelleenajastus tuottaa saman tunnisteen eikä kopiota', async () => {
  const plugin = fakePlugin({ display: 'granted' });
  installShell(plugin);
  const { native } = await loadNative();
  await native.refreshPermission();

  const intents = [{ id: 'task_reminder:t1:2026-03-15', date: '2026-03-15',
    time: '09:00', title: 'T', body: '' }];
  const now = new Date(2026, 2, 15, 7, 0);

  await native.schedule(intents, now);
  await native.schedule(intents, now);

  assert.equal(plugin.calls.schedule[0].notifications[0].id,
    plugin.calls.schedule[1].notifications[0].id);
});

test('laitteen virhe ajastuksessa palautetaan rehellisesti', async () => {
  const plugin = fakePlugin({ display: 'granted', failOn: 'schedule' });
  installShell(plugin);
  const { native } = await loadNative();
  await native.refreshPermission();

  const result = await native.schedule(
    [{ id: 'a', date: '2026-03-15', time: '09:00', title: 'T', body: '' }],
    new Date(2026, 2, 15, 7, 0));

  assert.equal(result.ok, false);
  assert.equal(result.scheduled, 0);
});

// --------------------------------------------------------- peruutus

test('peruutus poistaa kaikki odottavat ilmoitukset', async () => {
  const plugin = fakePlugin({ display: 'granted' });
  installShell(plugin);
  const { native } = await loadNative();
  await native.refreshPermission();

  await native.schedule([
    { id: 'a', date: '2026-03-15', time: '09:00', title: 'A', body: '' },
    { id: 'b', date: '2026-03-15', time: '10:00', title: 'B', body: '' }
  ], new Date(2026, 2, 15, 7, 0));

  assert.equal(await native.pendingCount(), 2);

  const result = await native.cancelAll();
  assert.equal(result.ok, true);
  assert.equal(result.cancelled, 2);
  assert.equal(await native.pendingCount(), 0);
});

test('peruutus ilman odottavia ei ole virhe', async () => {
  installShell(fakePlugin({ display: 'granted' }));
  const { native } = await loadNative();
  const result = await native.cancelAll();
  assert.equal(result.ok, true);
  assert.equal(result.cancelled, 0);
});

// ------------------------------------------- sovittimen kautta kulkeva reitti

test('platform-sovitin ohjaa ajastuksen natiiville kun se on saatavilla', async () => {
  const plugin = fakePlugin({ display: 'granted' });
  installShell(plugin);
  const { native, notifications } = await loadNative();
  await native.refreshPermission();

  const result = await notifications.schedule([
    { id: 'a', date: '2099-03-15', time: '09:00', title: 'T', body: '' }
  ]);

  assert.equal(result.ok, true, 'natiivikuoressa ajastus onnistuu');
  assert.equal(plugin.calls.schedule.length, 1);
});

test('selaimessa ajastus kertoo yhä olevansa mahdoton', async () => {
  const { notifications } = await loadNative();
  const result = await notifications.schedule([{ id: 'a' }]);
  assert.equal(result.ok, false);
  assert.equal(result.planned, true);
  assert.match(result.reason, /Android/);
});

test('natiivikuoressa tuen kuvaus lupaa ajastuksen, selaimessa ei', async () => {
  const plugin = fakePlugin({ display: 'granted' });
  installShell(plugin);
  const { native, notifications } = await loadNative();
  await native.refreshPermission();

  assert.equal(notifications.describeSupport().level, 'scheduled');
});

test('refreshPermission on turvallinen kutsua selaimessa', async () => {
  const { notifications } = await loadNative();
  const state = await notifications.refreshPermission();
  assert.equal(state, 'unsupported');
});
