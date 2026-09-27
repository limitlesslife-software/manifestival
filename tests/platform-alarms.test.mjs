// Herätysten alustasovitin (src/platform/alarms.js).
//
// ManifestivalAlarm-liitännäistä ei ole työpöydällä, joten se korvataan
// muistissa elävällä kaksoiskappaleella (sama malli kuin
// platform-native.test.mjs). Näin testataan se, mikä desktopilla VOI
// testata: sopimuksen tarkistus ennen laitetta, rehellinen "vain
// Android-sovelluksessa" selaimessa, ei heitä -takuu, tapahtumien
// kaksoiskappaleiden suodatus ja linkkien turvallisuus. Soiko herätys
// oikeasti lukitulla puhelimella, on laitehyväksynnän asia
// (docs/DEVICE-ACCEPTANCE-BACKLOG.md).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { helsinkiOffset } from './helpers/helsinkiOffset.mjs';

const capabilities = await import('../src/platform/capabilities.js');
const alarms = await import('../src/platform/alarms.js');
const index = await import('../src/platform/index.js');
const dailyLife = await import('../src/domain/dailyLife.js');
const alarmPlan = await import('../src/domain/alarmPlan.js');
const navigationLink = await import('../src/domain/navigationLink.js');
const travel = await import('../src/domain/travel.js');

const ORIGINAL_CAPACITOR = globalThis.Capacitor;
const ORIGINAL_SYNTH = globalThis.speechSynthesis;
const ORIGINAL_UTTERANCE = globalThis.SpeechSynthesisUtterance;

/** Muistissa elävä ManifestivalAlarm. */
function fakePlugin({
  status = { ok: true, supported: true, exact: true, fullScreen: true, notifications: true, tts: 'available', soundPicked: false, scheduled: 0, ringing: false, sdk: 35, batteryOptimized: true },
  failOn = null, hangOn = null, scheduleResult = null, events = [], speakResult = { ok: true },
  navigationResult = { ok: true, target: 'maps' }
} = {}) {
  const calls = {
    schedule: [], cancel: [], cancelAll: 0, list: 0, status: 0, speak: [], stopSpeaking: 0,
    openNavigation: [], openExactAlarmSettings: 0, openFullScreenSettings: 0, pickAlarmSound: 0, consumeEvents: 0
  };
  const listeners = [];
  let queue = [...events];
  const guard = name => {
    if (failOn === name) throw new Error('laite kieltäytyi: ' + name);
    if (hangOn === name) return new Promise(() => {});
    return null;
  };
  return {
    calls,
    listeners,
    push(event) { for (const entry of listeners) entry.fn(event); },
    async status() { calls.status++; return guard('status') || status; },
    async schedule(options) {
      calls.schedule.push(options);
      const hang = guard('schedule');
      if (hang) return hang;
      return scheduleResult || { ok: true, scheduled: options.alarms.length, exact: true, inexact: [], dropped: [], rejected: [] };
    },
    async cancel(options) { calls.cancel.push(options); return guard('cancel') || { ok: true, removed: options.ids.length }; },
    async cancelAll() { calls.cancelAll++; return guard('cancelAll') || { ok: true, removed: 2 }; },
    async list() {
      calls.list++;
      return guard('list') || { ok: true, alarms: [
        { id: 'wake:2026-09-28', kind: 'wake', date: '2026-09-28', time: '07:00', title: 'Herätys', atMs: 1790568000000, exact: true, snoozeCount: 0, snoozedUntilMs: null },
        { id: 'huono id', kind: 'wake' }
      ] };
    },
    async consumeEvents() {
      calls.consumeEvents++;
      const hang = guard('consumeEvents');
      if (hang) return hang;
      const out = queue;
      queue = [];
      return { ok: true, events: out };
    },
    async speak(options) { calls.speak.push(options); return guard('speak') || speakResult; },
    async stopSpeaking() { calls.stopSpeaking++; return { ok: true }; },
    async openNavigation(options) { calls.openNavigation.push(options); return guard('openNavigation') || navigationResult; },
    async openExactAlarmSettings() { calls.openExactAlarmSettings++; return { ok: true }; },
    async openFullScreenSettings() { calls.openFullScreenSettings++; return { ok: true, notNeeded: true }; },
    async pickAlarmSound() { calls.pickAlarmSound++; return { ok: true, picked: true, title: 'Aamu' }; },
    async addListener(name, fn) {
      const entry = { name, fn };
      listeners.push(entry);
      return { remove: async () => { listeners.splice(listeners.indexOf(entry), 1); } };
    }
  };
}

function installShell(plugin) {
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: plugin ? { ManifestivalAlarm: plugin } : {}
  };
}

function entry(overrides = {}) {
  return {
    id: 'wake:2026-09-28', kind: 'wake', date: '2026-09-28', time: '07:00', title: 'Herätys',
    body: 'Oma arkiaamun herätysaikasi 7.00.', speech: null, mode: 'alarm_sound',
    escalation: [{ afterSeconds: 0, step: 'soft' }, { afterSeconds: 60, step: 'loud' }],
    snoozeMinutes: 9, maxSnoozes: 3, routeDestination: null, routeMode: null, ...overrides
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

beforeEach(() => {
  delete globalThis.Capacitor;
  delete globalThis.speechSynthesis;
  delete globalThis.SpeechSynthesisUtterance;
  capabilities.resetAlarmAccessState();
  alarms.resetAlarmsForTests();
});

afterEach(() => {
  if (ORIGINAL_CAPACITOR === undefined) delete globalThis.Capacitor;
  else globalThis.Capacitor = ORIGINAL_CAPACITOR;
  if (ORIGINAL_SYNTH === undefined) delete globalThis.speechSynthesis;
  else globalThis.speechSynthesis = ORIGINAL_SYNTH;
  if (ORIGINAL_UTTERANCE === undefined) delete globalThis.SpeechSynthesisUtterance;
  else globalThis.SpeechSynthesisUtterance = ORIGINAL_UTTERANCE;
  capabilities.resetAlarmAccessState();
  alarms.resetAlarmsForTests();
});

// ------------------------------------------------------------ selain: rehellinen "ei"

test('KRIITTINEN: selaimessa herätystä ei ole eikä sitä teeskennellä', async () => {
  assert.equal(alarms.supportsBackgroundAlarms(), false);
  const status = await alarms.alarmStatus();
  assert.equal(status.supported, false);
  assert.match(status.reason, /toimivat vain Android-sovelluksessa/);

  const result = await alarms.scheduleAlarms([entry()]);
  assert.equal(result.ok, false);
  assert.equal(result.supported, false);
  assert.equal(result.scheduled, 0);
  assert.match(result.reason, /Android-sovelluksessa/);

  const cap = capabilities.capability(capabilities.CAPABILITY.ALARMS);
  assert.equal(cap.supported, false);
  assert.equal(cap.available, false);
  assert.equal(cap.permission, capabilities.PERMISSION.UNSUPPORTED);
  assert.match(cap.reason, /Android-sovelluksessa/);

  // Mitään ei jää kesken: peruutus, tapahtumat ja asetukset vastaavat rehellisesti.
  assert.deepEqual(await alarms.cancelAllAlarms(), { ok: true, supported: false, removed: 0 });
  assert.deepEqual([...(await alarms.consumeEvents()).events], []);
  assert.equal((await alarms.openExactAlarmSettings()).supported, false);
  assert.equal((await alarms.pickAlarmSound()).supported, false);
  const off = alarms.onEvent(() => assert.fail('selaimessa ei tapahtumia'));
  assert.equal(typeof off, 'function');
  off();
});

test('selain: puhe speechSynthesisillä vain sivun ollessa auki, ja se kerrotaan', async () => {
  const spoken = [];
  let cancelled = 0;
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  globalThis.speechSynthesis = {
    speak(utterance) { spoken.push({ text: utterance.text, lang: utterance.lang }); setTimeout(() => utterance.onend(), 0); },
    cancel() { cancelled++; }
  };
  const result = await alarms.speak('  Lähde nyt\nhammaslääkäriin. ');
  assert.equal(result.ok, true);
  assert.equal(result.backend, 'web');
  assert.equal(result.foregroundOnly, true);
  assert.equal(result.note, alarms.SPEECH_FOREGROUND_NOTE);
  assert.match(result.note, /vain, kun sovellus on auki/);
  assert.deepEqual(spoken, [{ text: 'Lähde nyt hammaslääkäriin.', lang: 'fi-FI' }]);
  assert.ok(cancelled >= 1, 'edellinen puhe katkaistaan ennen uutta');
});

test('selain: keskeytetty puhe ratkeaa koodilla "stopped", ei onnistuneena', async () => {
  let pending = null;
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  globalThis.speechSynthesis = {
    speak(utterance) { pending = utterance; },
    cancel() { if (pending) { const u = pending; pending = null; u.onend(); } }
  };
  const speaking = alarms.speak('Pitkä katsaus');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(await alarms.stopSpeaking(), { ok: true });
  const result = await speaking;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'stopped');
});

test('selain ilman puhetta: ok false, ei poikkeusta', async () => {
  const result = await alarms.speak('Hei');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unsupported');
  assert.equal((await alarms.speak('')).code, 'invalid');
  assert.equal((await alarms.speak('x'.repeat(501))).code, 'invalid');
});

// ------------------------------------------------------------ kyvykkyys

test('ALARMS-kyvykkyys: täysi muoto, lupa ei koskaan alussa "granted", status päivittää', async () => {
  assert.ok(capabilities.CAPABILITIES.includes('alarms'));
  const plugin = fakePlugin();
  installShell(plugin);
  let cap = capabilities.capability(capabilities.CAPABILITY.ALARMS);
  assert.deepEqual(Object.keys(cap).sort(),
    ['available', 'implemented', 'label', 'name', 'permission', 'plannedNote', 'reason', 'supported']);
  assert.equal(cap.implemented, true);
  assert.equal(cap.permission, capabilities.PERMISSION.PROMPT, 'ennen tilan lukua ei väitetä mitään');
  assert.equal(cap.available, false);

  const status = await alarms.alarmStatus();
  assert.equal(status.exact, true);
  assert.equal(status.tts, 'available');
  cap = capabilities.capability(capabilities.CAPABILITY.ALARMS);
  assert.equal(cap.permission, capabilities.PERMISSION.GRANTED);
  assert.equal(cap.available, true);
  assert.deepEqual(index.alarms.capability(), cap, 'facade ja rekisteri samaa mieltä');

  // Tarkka herätys peruttu -> ei "kunnossa".
  installShell(fakePlugin({ status: { ok: true, exact: false, notifications: true } }));
  await alarms.alarmStatus();
  assert.equal(capabilities.capability(capabilities.CAPABILITY.ALARMS).permission, capabilities.PERMISSION.DENIED);
});

test('natiivikuori ilman herätysliitännäistä: tuettu mutta ei toteutettu', async () => {
  installShell(null);
  const cap = capabilities.capability(capabilities.CAPABILITY.ALARMS);
  assert.equal(cap.supported, true);
  assert.equal(cap.implemented, false);
  assert.equal(cap.available, false);
  const result = await alarms.scheduleAlarms([entry()]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /tässä Android-sovelluksen versiossa/);
});

// ------------------------------------------------------------ ajastus

test('ajastus lähettää tarkistetun joukon; sama syöte -> sama kuorma; syötettä ei muuteta', async () => {
  const plugin = fakePlugin();
  installShell(plugin);
  const input = deepFreeze([
    entry(),
    entry({ id: 'departure|p1|2026-09-28|leave_now', kind: 'spoken', time: '08:10', title: '  Lähde\tnyt ', speech: 'Lähde nyt, jotta ehdit.', routeDestination: 'Fleminginkatu 1, Helsinki', routeMode: 'transit', escalation: undefined, mode: undefined })
  ]);
  const before = JSON.stringify(input);
  const first = await alarms.scheduleAlarms(input);
  const second = await alarms.scheduleAlarms(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(first.ok, true);
  assert.equal(first.scheduled, 2);
  assert.equal(first.exact, true);
  assert.deepEqual(JSON.stringify(plugin.calls.schedule[0]), JSON.stringify(plugin.calls.schedule[1]));
  const [wake, spoken] = plugin.calls.schedule[0].alarms;
  assert.equal(wake.id, 'wake:2026-09-28');
  assert.equal(spoken.title, 'Lähde nyt');
  assert.equal(spoken.mode, 'alarm_sound', 'puuttuva tapa -> oletus');
  assert.deepEqual([...spoken.escalation], [], 'puuttuva voimistuminen -> liitännäisen oletus');
  assert.equal(spoken.routeDestination, 'Fleminginkatu 1, Helsinki');
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.rejected));
});

test('KRIITTINEN: sama tunniste kahdesti -> yksi herätys (ensimmäinen voittaa)', async () => {
  const plugin = fakePlugin();
  installShell(plugin);
  const result = await alarms.scheduleAlarms([entry(), entry({ time: '06:00' })]);
  assert.equal(plugin.calls.schedule[0].alarms.length, 1);
  assert.equal(plugin.calls.schedule[0].alarms[0].time, '07:00');
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].errors.id, /Sama tunniste/);
});

test('tarkistus: päivät, ajat, tunnisteet, pituudet ja voimistumisen rajat', () => {
  const invalid = (overrides, field) => {
    const result = alarms.validateAlarmEntry(entry(overrides));
    assert.equal(result.valid, false, JSON.stringify(overrides));
    assert.ok(result.errors[field], `${field}: ${JSON.stringify(result.errors)}`);
    assert.equal(result.entry, null);
  };
  assert.equal(alarms.validateAlarmEntry(entry()).valid, true);
  invalid({ date: '2026-02-30' }, 'date');
  invalid({ date: '2027-02-29' }, 'date');
  assert.equal(alarms.validateAlarmEntry(entry({ date: '2028-02-29' })).valid, true);
  invalid({ date: '28.9.2026' }, 'date');
  invalid({ time: '24:00' }, 'time');
  invalid({ time: '7:00' }, 'time');
  invalid({ time: '07:60' }, 'time');
  invalid({ id: 'wake 2026' }, 'id');
  invalid({ id: '' }, 'id');
  invalid({ id: 'x'.repeat(121) }, 'id');
  invalid({ kind: 'nap' }, 'kind');
  invalid({ title: '   ' }, 'title');
  invalid({ title: 'x'.repeat(201) }, 'title');
  invalid({ body: 'x'.repeat(501) }, 'body');
  invalid({ speech: 'x'.repeat(501) }, 'speech');
  invalid({ speech: 42 }, 'speech');
  invalid({ mode: 'disco' }, 'mode');
  invalid({ escalation: [1, 2, 3, 4, 5].map(n => ({ afterSeconds: n, step: 'soft' })) }, 'escalation');
  invalid({ escalation: [{ afterSeconds: 60, step: 'loud' }, { afterSeconds: 30, step: 'soft' }] }, 'escalation');
  invalid({ escalation: [{ afterSeconds: 600, step: 'loud' }] }, 'escalation');
  invalid({ escalation: [{ afterSeconds: 1.5, step: 'loud' }] }, 'escalation');
  invalid({ escalation: [{ afterSeconds: 0, step: 'scream' }] }, 'escalation');
  invalid({ escalation: 'soft' }, 'escalation');
  invalid({ snoozeMinutes: 0 }, 'snoozeMinutes');
  invalid({ snoozeMinutes: 31 }, 'snoozeMinutes');
  invalid({ maxSnoozes: 4 }, 'maxSnoozes');
  invalid({ routeDestination: 'https://evil.example/x' }, 'routeDestination');
  invalid({ routeDestination: 'geo:60.17,24.94' }, 'routeDestination');
  invalid({ routeDestination: 'javascript:alert(1)' }, 'routeDestination');
  invalid({ routeMode: 'teleport' }, 'routeMode');
  // Virheilmoitukset ovat suomea.
  const errors = alarms.validateAlarmEntry(entry({ time: '25:00' })).errors;
  assert.equal(errors.time, 'Kellonaika on virheellinen.');
});

test('vihamielinen syöte: heittävä getter, roska ja liian iso joukko eivät kaada', async () => {
  const plugin = fakePlugin();
  installShell(plugin);
  const hostile = { get id() { throw new Error('bang'); } };
  for (const garbage of [undefined, null, 0, 'x', [], [null], [hostile], { alarms: [] }]) {
    const result = await alarms.scheduleAlarms(garbage);
    assert.equal(typeof result.ok, 'boolean');
  }
  const broken = [entry()];
  Object.defineProperty(broken, 0, { get() { throw new Error('bang'); } });
  const brokenResult = await alarms.scheduleAlarms(broken);
  assert.equal(brokenResult.ok, false);
  assert.equal(brokenResult.code, 'invalid');

  const many = Array.from({ length: 60 }, (_, i) => entry({ id: `wake:${i}`, time: '07:00' }));
  const capped = await alarms.scheduleAlarms(many);
  assert.equal(plugin.calls.schedule.at(-1).alarms.length, alarms.ALARM_LIMITS.maxAlarms);
  assert.equal(capped.rejected.filter(r => /Liian monta/.test(r.errors.entry || '')).length, 10);
  assert.equal(await alarms.scheduleAlarms([entry()], null).then(r => r.ok), true, 'null-asetukset eivät heitä');
  assert.equal((await alarms.speak('Hei', null)).backend, 'native');
  assert.equal((await alarms.openNavigation(null)).code, 'invalid');
});

test('liitännäinen heittää tai ei vastaa: tulos on ok false, ei poikkeusta, ei jumia', async () => {
  installShell(fakePlugin({ failOn: 'schedule' }));
  const failed = await alarms.scheduleAlarms([entry()]);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'failed');
  assert.match(failed.reason, /ei saatu ajastettua/);

  installShell(fakePlugin({ hangOn: 'schedule' }));
  const started = Date.now();
  const hung = await alarms.scheduleAlarms([entry()], { timeoutMs: 20 });
  assert.equal(hung.ok, false);
  assert.equal(hung.code, 'timeout');
  assert.ok(Date.now() - started < 2000);

  installShell(fakePlugin({ failOn: 'status' }));
  const status = await alarms.alarmStatus();
  assert.equal(status.exact, false);
  assert.equal(capabilities.capability(capabilities.CAPABILITY.ALARMS).permission, capabilities.PERMISSION.PROMPT,
    'epäonnistunut luku ei muuta tilaa kumpaankaan suuntaan');
});

test('epätarkka ajastus kerrotaan (ei väitetä tarkkaa herätystä)', async () => {
  installShell(fakePlugin({ scheduleResult: { ok: true, scheduled: 1, exact: false, inexact: ['wake:2026-09-28'], dropped: [{ id: 'old', code: 'past' }], rejected: [{ id: 'x', code: 'invalid' }] } }));
  const result = await alarms.scheduleAlarms([entry()]);
  assert.equal(result.exact, false);
  assert.deepEqual([...result.inexact], ['wake:2026-09-28']);
  assert.deepEqual(result.dropped.map(d => ({ ...d })), [{ id: 'old', code: 'past' }]);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].errors.entry, /Laite hylkäsi/);
});

test('peruutus: vain kelvolliset tunnisteet; kaikki pois tyhjentää myös tapahtumamuistin', async () => {
  const plugin = fakePlugin({ events: [{ seq: 1, type: 'acknowledged', id: 'wake:a', kind: 'wake', atMs: 10 }] });
  installShell(plugin);
  const cancelled = await alarms.cancelAlarms(['wake:a', 'huono id', 5, null]);
  assert.deepEqual(plugin.calls.cancel[0], { ids: ['wake:a'] });
  assert.equal(cancelled.removed, 1);
  assert.equal((await alarms.cancelAllAlarms()).removed, 2);
  assert.equal(plugin.calls.cancelAll, 1);
  const list = await alarms.listAlarms();
  assert.deepEqual(list.alarms.map(a => a.id), ['wake:2026-09-28'], 'virheellinen rivi suodatetaan');
});

// ------------------------------------------------------------ tapahtumat

test('tapahtumat: tuntemattomat pois, järjestys seq, sama tapahtuma vain kerran (suora + jono)', async () => {
  const plugin = fakePlugin({ events: [
    { seq: 3, type: 'snoozed', id: 'wake:a', kind: 'wake', atMs: 1000, untilMs: 1000 + 9 * 60000 },
    { seq: 2, type: 'delivered', id: 'wake:a', kind: 'wake', atMs: 900 },
    { seq: 4, type: 'teleported', id: 'wake:a', atMs: 1100 },
    { seq: 5, type: 'snoozed', id: 'wake:a', atMs: 1200 },
    { seq: 6, type: 'departed', id: 'departure|p1|2026-09-28|leave_now', kind: 'spoken', atMs: 1300, title: 'EI SAA NÄKYÄ' }
  ] });
  installShell(plugin);
  const live = [];
  const off = alarms.onEvent(event => live.push(event));
  await new Promise(resolve => setTimeout(resolve, 0));
  plugin.push({ seq: 2, type: 'delivered', id: 'wake:a', kind: 'wake', atMs: 900 });
  plugin.push({ seq: 2, type: 'delivered', id: 'wake:a', kind: 'wake', atMs: 900 });
  assert.equal(live.length, 1);

  const { events } = await alarms.consumeEvents();
  assert.deepEqual(events.map(e => [e.seq, e.type]), [[3, 'snoozed'], [6, 'departed']],
    'seq 2 nähtiin jo suorana; tuntematon laji ja torkku ilman päättymistä hylätään');
  assert.equal(events[0].untilMs, 1000 + 9 * 60000);
  assert.equal('title' in events[1], false, 'tapahtumassa ei ole otsikkoa');
  assert.ok(Object.isFrozen(events[0]));
  assert.deepEqual([...(await alarms.consumeEvents()).events], [], 'jono tyhjeni');

  off();
  await new Promise(resolve => setTimeout(resolve, 0));
  plugin.push({ seq: 9, type: 'acknowledged', id: 'wake:a', kind: 'wake', atMs: 2000 });
  assert.equal(live.length, 1, 'lopetuksen jälkeen ei tapahtumia');
});

/**
 * Laitteen tapahtumajonon malli kuten AlarmStore.java: recordEvent lisää
 * JOKAISEN tapahtuman jonoon ja välittää sen myös elävänä; consumeEvents
 * tyhjentää jonon, ackEvents poistaa kuitatut.
 */
function queueingPlugin() {
  const queue = [];
  const plugin = fakePlugin();
  plugin.calls.ackEvents = [];
  plugin.consumeEvents = async () => ({ ok: true, events: queue.splice(0) });
  plugin.ackEvents = async ({ seqs }) => {
    plugin.calls.ackEvents.push([...seqs]);
    const before = queue.length;
    for (let index = queue.length - 1; index >= 0; index--) if (seqs.includes(queue[index].seq)) queue.splice(index, 1);
    return { ok: true, removed: before - queue.length };
  };
  plugin.record = event => {
    queue.push(event);
    plugin.push(event);
  };
  return plugin;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('REGRESSIO: elävänä käsitelty tapahtuma ei tule consumeEventsistä uudelleen seuraavassa istunnossa', async () => {
  // native-events-redelivered-after-restart: seenSeq on muistissa, joten
  // WebView'n uudelleenlatauksen tai kylmäkäynnistyksen jälkeen jonossa yhä
  // ollut "Lähdin" käsiteltiin toiseen kertaan.
  const plugin = queueingPlugin();
  installShell(plugin);
  const departed = { seq: 7, type: 'departed', id: 'departure|p1|2026-09-28|leave_now', kind: 'spoken', atMs: 1000 };

  // Istunto 1: sovellus auki, kuuntelija käsittelee tapahtuman.
  const live = [];
  const off = alarms.onEvent(event => live.push([event.seq, event.type]));
  await tick();
  plugin.record(departed);
  plugin.push(departed); // sama tapahtuma kahdesti: yksi käsittely
  await tick();
  assert.deepEqual(live, [[7, 'departed']]);
  assert.deepEqual(plugin.calls.ackEvents[0], [7], 'käsitelty tapahtuma kuitataan laitteelle');
  off();

  // Istunto 2: muistissa oleva suodatus on tyhjä (uusi moduulin instanssi).
  alarms.resetAlarmsForTests();
  assert.deepEqual([...(await alarms.consumeEvents()).events], [], 'sama "Lähdin" tuli toiseen kertaan');
});

test('tapahtuma, jonka käsittely kaatui, jää laitteen jonoon seuraavaa käynnistystä varten', async () => {
  const plugin = queueingPlugin();
  installShell(plugin);
  const off = alarms.onEvent(() => { throw new Error('sovelluksen käsittelijä kaatui'); });
  await tick();
  plugin.record({ seq: 8, type: 'acknowledged', id: 'wake:2026-09-28', kind: 'wake', atMs: 2000 });
  await tick();
  assert.deepEqual(plugin.calls.ackEvents, [], 'kaatunutta käsittelyä ei kuitata');
  off();
  alarms.resetAlarmsForTests();
  assert.deepEqual((await alarms.consumeEvents()).events.map(e => [e.seq, e.type]), [[8, 'acknowledged']]);
});

test('tapahtumien lajit vastaavat kuittauslokin käsitteitä', () => {
  // src/domain/notificationAck.js ACK_EVENT: delivered, acknowledged, snoozed, dismissed (+ opened).
  for (const type of ['delivered', 'acknowledged', 'snoozed', 'dismissed']) {
    assert.ok(alarms.ALARM_EVENTS.includes(type), type);
  }
  assert.equal(alarms.normalizeAlarmEvent({ seq: 1, type: 'acknowledged', id: 'wake:a', atMs: NaN }), null);
  assert.equal(alarms.normalizeAlarmEvent({ seq: 0, type: 'acknowledged', id: 'wake:a', atMs: 1 }), null);
  assert.equal(alarms.normalizeAlarmEvent(null), null);
});

// ------------------------------------------------------------ puhe ja reitti natiivissa

test('natiivipuhe: siistitty teksti ja kelvollinen kieli liitännäiselle', async () => {
  const plugin = fakePlugin({ speakResult: { ok: false, code: 'language-unavailable' } });
  installShell(plugin);
  const result = await alarms.speak('Hyvää​ huomenta.\n', { lang: 'x; rm -rf' });
  assert.deepEqual(plugin.calls.speak[0], { text: 'Hyvää huomenta.', lang: 'fi-FI' });
  assert.equal(result.ok, false);
  assert.equal(result.backend, 'native');
  assert.equal(result.code, 'language-unavailable');
  assert.deepEqual(await alarms.stopSpeaking(), { ok: true });
  assert.equal(plugin.calls.stopSpeaking, 1);
});

test('KRIITTINEN: reitti natiivissa: vain teksti ja kulkutapa, ei koskaan linkkiä', async () => {
  const plugin = fakePlugin();
  installShell(plugin);
  const ok = await alarms.openNavigation({ destination: ' Fleminginkatu 1\n Helsinki ', mode: 'walking' });
  assert.equal(ok.ok, true);
  assert.equal(ok.target, 'maps');
  assert.deepEqual(plugin.calls.openNavigation[0], { destination: 'Fleminginkatu 1 Helsinki', mode: 'walking' });
  for (const attack of ['https://evil.example', 'intent://x#Intent;end', 'javascript:alert(1)', 'www.evil.example', '<b>x</b>', '']) {
    const result = await alarms.openNavigation({ destination: attack });
    assert.equal(result.ok, false, attack);
    assert.equal(result.code, 'invalid');
  }
  assert.equal(plugin.calls.openNavigation.length, 1, 'hylättyä kohdetta ei välitetä laitteelle');
  const weird = await alarms.openNavigation({ destination: 'Koti', mode: 'constructor' });
  assert.deepEqual(plugin.calls.openNavigation[1], { destination: 'Koti', mode: 'driving' });
  assert.equal(weird.ok, true);
});

test('selaimen reittilinkki on sama kuin domainin ja läpäisee sen sallintalistan', async () => {
  const corpus = ['Fleminginkatu 1, Helsinki', 'Katu 1 & 2#osa?x=y', 'Tampere–Pirkkala', 'Äänekoski', 'Hotel: Kamp', '😀 Kahvila'];
  for (const mode of travel.TRAVEL_MODES) {
    for (const text of corpus) {
      const url = alarms.navigationUrl(text, mode);
      assert.equal(url, navigationLink.googleMapsUrl({ address: text, mode }), `${text} / ${mode}`);
      assert.equal(navigationLink.isAllowedNavigationUrl(url), true, url);
    }
  }
  for (const attack of ['https://evil.example/x', 'javascript:alert(1)', 'data:text/html,x', '‮​', 'geo:1,2']) {
    assert.equal(alarms.navigationUrl(attack), null, attack);
  }
  assert.equal(alarms.navigationUrl('Koti', '__proto__'), navigationLink.googleMapsUrl({ address: 'Koti' }));
  const web = await alarms.openNavigation({ destination: 'Fleminginkatu 1', mode: 'transit' });
  assert.equal(web.backend, 'web');
  assert.equal(web.opened, false, 'selaimessa kutsuja avaa linkin itse');
  assert.equal(web.url, navigationLink.googleMapsUrl({ address: 'Fleminginkatu 1', mode: 'transit' }));
});

// ------------------------------------------------------------ sopimus domainin kanssa

test('arvolistat ja rajat ovat samat kuin domainissa (dailyLife.js, alarmPlan.js, travel.js)', () => {
  assert.deepEqual([...alarms.NATIVE_ALARM_MODES], [...dailyLife.ALARM_MODES]);
  assert.deepEqual([...alarms.NATIVE_ESCALATION_STEPS], [...dailyLife.ESCALATION_STEPS]);
  assert.deepEqual([...alarms.NATIVE_TRAVEL_MODES], [...travel.TRAVEL_MODES]);
  assert.equal(alarms.ALARM_LIMITS.maxEscalationSteps, alarmPlan.MAX_ESCALATION_STEPS);
  assert.equal(alarms.ALARM_LIMITS.maxRingSeconds, alarmPlan.MAX_RING_SECONDS);
  assert.equal(alarms.ALARM_LIMITS.maxSnoozeMinutes, dailyLife.MAX_SNOOZE_MINUTES);
  assert.equal(alarms.ALARM_LIMITS.maxSnoozes, dailyLife.MAX_SNOOZES);
  assert.equal(alarms.ALARM_LIMITS.defaultSnoozeMinutes, alarmPlan.DEFAULT_SNOOZE_MINUTES);
  assert.ok(alarms.ALARM_LIMITS.maxTitleLength >= dailyLife.MAX_EVENT_TITLE_LENGTH);
});

test('domainin herätyssuunnitelma kelpaa sellaisenaan liitännäisen sopimukseen (myös kesäajan siirtymässä)', () => {
  const profile = { sleepTargetHours: 8, defaultWakeTime: '07:00', commuteMinutes: 30, routineMinutes: 60 };
  const settings = {
    alarm: {
      enabled: true, mode: 'combination', snoozeMinutes: 10, maxSnoozes: 2,
      escalation: [{ afterSeconds: 0, step: 'soft' }, { afterSeconds: 30, step: 'speech' }, { afterSeconds: 120, step: 'loud' }]
    },
    speechEnabled: true, morningBriefEnabled: true
  };
  for (const fromIso of ['2026-09-28', '2026-03-27', '2026-10-23']) {
    const planned = alarmPlan.desiredAlarms({ fromIso, days: 3, profile, settings, offsetMinutesFn: helsinkiOffset });
    assert.ok(planned.length >= 1, fromIso);
    for (const alarm of planned) {
      const result = alarms.validateAlarmEntry({
        id: alarm.id, kind: 'wake', date: alarm.date, time: alarm.time, title: alarm.label,
        body: alarm.reason, speech: alarm.briefText, mode: alarm.mode, escalation: alarm.escalation,
        snoozeMinutes: alarm.snoozeMinutes, maxSnoozes: alarm.maxSnoozes, routeDestination: null, routeMode: null
      });
      assert.equal(result.valid, true, `${alarm.id}: ${JSON.stringify(result.errors)}`);
    }
  }
});

// ------------------------------------------------------------ facade ja kerrokset

test('facade: alarms on jäädytetty ja kytketty moduuliin; asetukset ja äänivalitsin vain kutsusta', async () => {
  assert.ok(Object.isFrozen(index.alarms));
  for (const name of ['capability', 'supportsBackgroundAlarms', 'status', 'validate', 'schedule', 'cancel', 'cancelAll',
    'list', 'openExactAlarmSettings', 'openFullScreenSettings', 'pickAlarmSound', 'speak', 'stopSpeaking',
    'openNavigation', 'navigationUrl', 'consumeEvents', 'onEvent']) {
    assert.equal(typeof index.alarms[name], 'function', name);
  }
  const plugin = fakePlugin();
  installShell(plugin);
  // Tilan luku ja ajastus eivät avaa asetuksia eivätkä äänivalitsinta.
  await index.alarms.status();
  await index.alarms.schedule([entry()]);
  assert.equal(plugin.calls.openExactAlarmSettings, 0);
  assert.equal(plugin.calls.openFullScreenSettings, 0);
  assert.equal(plugin.calls.pickAlarmSound, 0);
  assert.equal((await index.alarms.openFullScreenSettings()).notNeeded, true);
  assert.deepEqual({ ...(await index.alarms.pickAlarmSound()) }, { ok: true, supported: true, picked: true, title: 'Aamu', code: null });
  assert.equal(index.capabilities().alarms.implemented, true);
});

test('alarms.js ei tuo domainia, ei tallenna selaimeen eikä avaa ikkunoita', () => {
  const source = read('src/platform/alarms.js');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(imports, ['./capabilities.js']);
  for (const forbidden of ['localStorage', 'sessionStorage', 'indexedDB', 'window.open', 'location.href', 'fetch(', 'console.', 'setInterval']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
