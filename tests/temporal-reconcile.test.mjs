// Mallin päivä ja kellonaika vs. käyttäjän lause: korjaus vain yksiselitteisessä tapauksessa.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { fakeClient } from './helpers/gates.mjs';
import { resetState, getState, setTasks } from '../src/app/state.js';
import { clearLocalUserData } from '../src/app/actions.js';
import { normalizeTask } from '../src/domain/task.js';
import { resetExecutionLedger, buildChangeRows } from '../src/app/aiCommands.js';
import { runTypedCommand } from '../src/app/commandBar.js';
import { reconcileTemporal, TEMPORAL_FIELDS } from '../src/ai/temporalReconcile.js';
import { addDaysIso, weekdayOfIso } from '../src/domain/fiTemporal.js';
import { fmtISO, todayMidnight } from '../src/lib/datetime.js';

const MON = '2026-03-02';
const USER = { id: 'aaaaaaaa-2222-4222-8222-000000000002', email: 't@example.com' };

const modelSays = json => async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(json) }] }) });

beforeEach(() => {
  clearUser(); clearLocalUserData(); resetState(); resetExecutionLedger();
  setUser(USER);
  setClient(fakeClient({ data: [], error: null }));
});

// ------------------------------------------------------------ puhdas vaihe

test('malli erehtyy päivässä: "huomenna" korjataan huomiseksi', () => {
  const { raw, corrections } = reconcileTemporal({ intent: 'create_task', title: 'Soita', date: '2026-03-05' }, 'Muistuta huomenna soittamaan', MON);
  assert.equal(raw.date, '2026-03-03');
  assert.deepEqual(corrections, ['date']);
});

test('malli unohtaa päivän: jäsennin täyttää sen (muuten tehtävä syntyisi tälle päivälle)', () => {
  const { raw } = reconcileTemporal({ intent: 'create_task', title: 'Soita' }, 'lisää tehtävä soita huomenna', MON);
  assert.equal(raw.date, '2026-03-03');
});

test('KRIITTINEN: "puoli yhdeksältä" korjataan 08:30:ksi vaikka malli sanoisi 09:30', () => {
  const { raw, corrections } = reconcileTemporal({ intent: 'create_task', title: 'X', date: '2026-03-06', time: '09:30' },
    'Muistuta perjantaina puoli yhdeksältä hakemaan paketti', MON);
  assert.equal(raw.time, '08:30');
  assert.deepEqual(corrections, ['time']);
});

test('KRIITTINEN: "puoli yksi yöllä" ei korjaa mallin oikeaa 00:30:tä keskipäiväksi', () => {
  const input = { intent: 'create_task', title: 'Soita äidille', date: '2026-03-03', time: '00:30' };
  const { raw, corrections } = reconcileTemporal(input, 'soita äidille huomenna puoli yksi yöllä', MON);
  assert.equal(raw.time, '00:30');
  assert.deepEqual(corrections, []);
  // Mallin väärä keskipäivä korjataan keskiyöksi.
  const wrong = reconcileTemporal({ ...input, time: '12:30' }, 'soita äidille huomenna puoli yksi yöllä', MON);
  assert.equal(wrong.raw.time, '00:30');
  assert.deepEqual(wrong.corrections, ['time']);
});

test('oikea vastaus ei muutu eikä tuota korjauksia', () => {
  const input = { intent: 'create_task', title: 'X', date: '2026-03-03', time: '08:00' };
  const { raw, corrections } = reconcileTemporal(input, 'huomenna klo 8', MON);
  assert.equal(raw, input, 'sama olio palautetaan');
  assert.deepEqual(corrections, []);
});

test('KRIITTINEN: epäselvä ilmaisu jättää mallin vastauksen ennalleen', () => {
  for (const [text, today] of [
    ['maanantaina', MON], ['viikonloppuna', MON], ['klo 3', MON], ['puoli kolme', MON],
    ['huomenna ja ylihuomenna', MON], ['31.2.', MON], ['ensi viikolla', MON]
  ]) {
    const input = { intent: 'create_task', title: 'X', date: '2026-04-01', time: '11:11' };
    const { raw, corrections } = reconcileTemporal(input, text, today);
    assert.equal(raw.date, '2026-04-01', text);
    assert.equal(raw.time, '11:11', text);
    assert.deepEqual(corrections, [], text);
  }
});

test('siirto: kohde on "-lle/-ksi"-päivä, lähde ("huomiselta") ohitetaan', () => {
  const { raw } = reconcileTemporal({ intent: 'reschedule_task', targetName: 'Auton pesu', date: '2026-03-03' },
    'Siirrä auton pesu huomiselta sunnuntaille', MON);
  assert.equal(raw.date, '2026-03-08');
});

test('siirto suhteellisella ajalla: kellonaikaa ei kosketa, vaikka lauseessa olisi kello', () => {
  const input = { intent: 'reschedule_task', targetName: 'Palaveri', shiftMinutes: 120 };
  const { raw, corrections } = reconcileTemporal(input, 'siirrä palaveri kahdella tunnilla eteenpäin klo 8', MON);
  assert.equal(raw.time, undefined);
  assert.deepEqual(corrections, []);
});

test('näyttökomento: "ensi viikko" -> ensi viikon maanantai', () => {
  const { raw } = reconcileTemporal({ intent: 'show_week_plan', date: '2026-03-02' }, 'Näytä ensi viikko', MON);
  assert.equal(raw.date, '2026-03-09');
  assert.equal(reconcileTemporal({ intent: 'show_week_plan' }, 'näytä ensi viikko', MON).raw.time, undefined, 'näyttökomento ei saa kellonaikaa');
});

test('payload omassa kentässään: korjaus menee payloadiin, juuri ei saastu', () => {
  const input = { intent: 'create_task', payload: { title: 'X', date: '2026-04-01' } };
  const { raw } = reconcileTemporal(input, 'huomenna', MON);
  assert.equal(raw.payload.date, '2026-03-03');
  assert.equal(raw.date, undefined);
  assert.equal(input.payload.date, '2026-04-01', 'alkuperäistä ei mutatoitu');
});

test('KRIITTINEN: vain nimetyt intentit ja kentät: poisto, talous ja tehtävän merkintä eivät kosketa', () => {
  assert.deepEqual(Object.keys(TEMPORAL_FIELDS).sort(),
    ['create_task', 'reschedule_task', 'schedule_task', 'show_day_plan', 'show_week_plan']);
  for (const intent of ['delete_task', 'complete_task', 'mark_bill_paid', 'create_bill', 'update_bill', 'delete_routine',
    'set_notification_preference', 'create_routine', 'update_task', 'unknown', '__proto__', 'constructor']) {
    const input = { intent, targetName: 'X', date: '2026-04-01', time: '11:11', dueDate: '2026-04-01' };
    const { raw, corrections } = reconcileTemporal(input, 'huomenna klo 8', MON);
    assert.equal(raw, input, intent);
    assert.deepEqual(corrections, [], intent);
  }
});

test('rikkinäinen raakavastaus ei kaada: null, taulukko, merkkijono, ilman intenttiä', () => {
  for (const bad of [null, undefined, [], 'create_task', 5, {}, { intent: 5 }, { intent: null }]) {
    const { raw, corrections } = reconcileTemporal(bad, 'huomenna', MON);
    assert.equal(raw, bad);
    assert.deepEqual(corrections, []);
  }
});

test('KRIITTINEN: jäsennin ei koskaan lisää tietoa, jota käyttäjä ei sanonut', () => {
  const { raw, corrections } = reconcileTemporal({ intent: 'create_task', title: 'Osta maitoa' }, 'Osta maitoa', MON);
  assert.equal(raw.date, undefined);
  assert.equal(raw.time, undefined);
  assert.deepEqual(corrections, []);
});

test('sama syöte, sama tulos (deterministinen)', () => {
  const run = () => JSON.stringify(reconcileTemporal({ intent: 'create_task', title: 'X', date: '2026-04-01' }, 'perjantaina klo 8', MON));
  const first = run();
  for (let i = 0; i < 200; i += 1) assert.equal(run(), first);
});

// -------------------------------------------------- koko putki (oikea päivä)

const TODAY = fmtISO(todayMidnight());
const TOMORROW = addDaysIso(TODAY, 1);
const WRONG = addDaysIso(TODAY, 5);

test('putki: väärä päivä korjataan ja vahvistus näyttää korjatun päivän', async () => {
  let preview = null;
  const result = await runTypedCommand('Muistuta minua huomenna klo 8 soittamaan Matille', {
    fetchImpl: modelSays({ intent: 'create_task', title: 'Soita Matille', date: WRONG, time: '09:00' }),
    confirmFn: async proposal => { preview = proposal.preview; return true; },
    chooseFn: async () => null
  });
  assert.equal(result.ok, true);
  const [task] = getState().tasks;
  assert.deepEqual([task.date, task.time], [TOMORROW, '08:00']);
  const date = preview.changes.find(row => row.field === 'date');
  assert.equal(date.after, TOMORROW, 'vahvistuksessa näkyy lopullinen päivä');
  assert.equal(preview.changes.find(row => row.field === 'time').after, '08:00');
});

test('putki: epäselvä lause jättää mallin päivän, ja vahvistus näyttää sen', async () => {
  let preview = null;
  await runTypedCommand('Lisää tehtävä siivous viikonloppuna', {
    fetchImpl: modelSays({ intent: 'create_task', title: 'Siivous', date: WRONG }),
    confirmFn: async proposal => { preview = proposal.preview; return true; },
    chooseFn: async () => null
  });
  assert.equal(getState().tasks[0].date, WRONG, 'ei arvattu viikonloppua');
  assert.equal(preview.changes.find(row => row.field === 'date').after, WRONG);
});

test('putki: siirto korjataan ja vahvistus näyttää nykyisen -> uuden päivän', async () => {
  const sundayOffset = (7 - weekdayOfIso(TODAY)) || 7;
  const target = addDaysIso(TODAY, sundayOffset);
  setTasks([normalizeTask({ id: 'p1', title: 'Auton pesu', date: TOMORROW })]);
  let preview = null;
  const result = await runTypedCommand('Siirrä auton pesu huomiselta sunnuntaille', {
    fetchImpl: modelSays({ intent: 'reschedule_task', targetName: 'Auton pesu', date: WRONG }),
    confirmFn: async proposal => { preview = proposal.preview; return true; },
    chooseFn: async () => null
  });
  // Jos tänään on sunnuntai, "sunnuntaille" on epäselvä eikä mallin päivää korjata.
  const expected = weekdayOfIso(TODAY) === 7 ? WRONG : target;
  assert.equal(result.ok, true);
  assert.equal(getState().tasks[0].date, expected);
  const row = preview.changes.find(entry => entry.field === 'date');
  assert.equal(row.before, TOMORROW);
  assert.equal(row.after, expected);
});

// ------------------------------------------------- esikatselurivit luonnille

test('luonnin esikatselu näyttää asetetut kentät (ei vain otsikkoa)', () => {
  const rows = buildChangeRows({
    intent: 'create_task',
    payload: { title: 'X', date: '2026-03-03', time: '08:00', endTime: null, durationMinutes: 45, category: 'tyo', priority: 'korkea', note: null }
  }, null);
  assert.deepEqual(rows.map(row => [row.field, row.after]), [
    ['date', '2026-03-03'], ['time', '08:00'], ['durationMinutes', '45'], ['category', rows[3].after], ['priority', rows[4].after]
  ]);
  assert.notEqual(rows[3].after, 'tyo', 'kategoria näytetään luettavana nimenä');
  assert.notEqual(rows[4].after, 'korkea');
  assert.ok(rows.every(row => row.before === '—'), 'luonnissa ei ole nykyistä arvoa');
});

test('rutiinin, tavoitteen, projektin ja laskun luonti näyttävät kenttänsä luettavasti', () => {
  const routine = buildChangeRows({ intent: 'create_routine', payload: { title: 'X', recurrence: 'custom_weekdays', weekdays: [1, 3, 5], preferredTime: '07:00', durationMinutes: 30 } }, null);
  assert.deepEqual(routine.find(row => row.field === 'recurrence').after, 'valittuina viikonpäivinä');
  assert.equal(routine.find(row => row.field === 'weekdays').after, 'ma, ke, pe');
  assert.equal(routine.find(row => row.field === 'preferredTime').after, '07:00');

  assert.equal(buildChangeRows({ intent: 'create_goal', payload: { title: 'G', targetDate: '2026-11-30' } }, null)[0].after, '2026-11-30');
  assert.equal(buildChangeRows({ intent: 'create_project', payload: { name: 'P', deadline: '2026-03-31' } }, null)[0].after, '2026-03-31');
  const bill = buildChangeRows({ intent: 'create_bill', payload: { name: 'B', amountMinor: 8990, dueDate: '2026-03-31' } }, null);
  assert.match(bill.find(row => row.field === 'amountMinor').after, /89[,.]90/);
  assert.equal(bill.find(row => row.field === 'dueDate').after, '2026-03-31');
});

test('luonti ilman valinnaisia kenttiä tuottaa vain ne mitä on', () => {
  assert.deepEqual(buildChangeRows({ intent: 'create_task', payload: { title: 'X', date: null, time: null } }, null), []);
  assert.deepEqual(buildChangeRows({ intent: 'create_routine', payload: { title: 'X', weekdays: [] } }, null), []);
});
