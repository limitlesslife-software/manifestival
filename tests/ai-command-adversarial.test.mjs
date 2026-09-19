// Vihamielinen testisarja AI-komentorajalle.
//
// OLETUS: malli (tai sen vastaus matkalla) on vihamielinen. Jokaisen
// tapauksen pitää päättyä siihen, ettei MITÄÄN suoriteta tai muutu --
// ei "vahingossa sallittu poikkeus", vaan suljettu epäonnistuminen.
//
// Testataan oikeaa putkea (runTypedCommand -> resolveCommand ->
// resolveTarget -> executeProposal), ei pelkkiä apufunktioita, ja jokainen
// tapaus tarkistaa lopputilan, ei vain palautusarvoa.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import { clearLocalUserData } from '../src/app/actions.js';
import { resetState, getState, setTasks } from '../src/app/state.js';
import { setClient } from '../src/data/client.js';
import { fakeClient } from './helpers/gates.mjs';
import { normalizeTask, isIsoDate } from '../src/domain/task.js';
import { resolveCommand, isAllowedIntent } from '../src/ai/intentSchema.js';
import { resolveTarget } from '../src/ai/entityResolver.js';
import { extractJson } from '../src/ai/proposalSchema.js';

import { runTypedCommand } from '../src/app/commandBar.js';
import { executeProposal, PROPOSAL_STATUS } from '../src/app/aiCommands.js';

const USER = { id: 'aaaaaaaa-6666-0000-0000-000000000006', email: 'adv@example.com' };
const OTHER_USER_ID = 'bbbbbbbb-5555-0000-0000-000000000005';
const TODAY = '2026-09-19';

function fetchReturning(text) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'text', text }] })
  });
}

const SEED = () => [
  normalizeTask({ id: 't1', title: 'Hammaslääkäri', date: '2026-09-20', time: '10:00' }),
  normalizeTask({ id: 't2', title: 'Ostoslista', date: '2026-09-21' })
];

/** Aja vihamielinen malliulostulo koko putken läpi ja palauta tulos + tila. */
async function attack(modelText, { confirm = true } = {}) {
  let confirmCalls = 0;
  const result = await runTypedCommand('mikä tahansa', {
    fetchImpl: fetchReturning(modelText),
    confirmFn: async () => { confirmCalls += 1; return confirm; },
    chooseFn: async () => null
  });
  return { result, confirmCalls, state: getState() };
}

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  setUser(USER);
  setClient(fakeClient({ data: [], error: null }));
  setTasks(SEED());
});

function assertUntouched(state) {
  assert.equal(state.tasks.length, 2, 'tehtävien määrä ei saa muuttua');
  assert.equal(state.tasks[0].title, 'Hammaslääkäri');
  assert.equal(state.tasks[0].date, '2026-09-20');
  assert.equal(state.tasks[1].title, 'Ostoslista');
}

// ------------------------------------------------ intentin nimi hyökkäyksenä

for (const evil of [
  '__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf',
  'tasks', 'profiles', 'auth.users', 'DROP TABLE tasks', 'delete_all', 'delete_everything',
  'alert(1)', "eval('process.exit()')", 'javascript:alert(1)', 'pay_bill', 'transfer_money',
  'delete_bill', 'delete_account', 'execute_sql', 'change_owner', '', ' ', 'CREATE_TASK',
  'create_task ', ' create_task'
]) {
  test(`VIHAMIELINEN: intent ${JSON.stringify(evil)} hylätään eikä mikään muutu`, async () => {
    assert.equal(isAllowedIntent(evil), false);
    const { result, confirmCalls, state } = await attack(JSON.stringify({ intent: evil, title: 'x' }));
    assert.equal(result.ok, false);
    assert.equal(confirmCalls, 0, 'hylätystä komennosta ei saa kysyä vahvistusta');
    assertUntouched(state);
  });
}

test('VIHAMIELINEN: intent ei-merkkijonona (olio, taulukko, luku, null) hylätään', () => {
  for (const intent of [{}, [], 7, null, true, { toString: () => 'create_task' }, ['create_task']]) {
    assert.equal(resolveCommand({ intent, title: 'x' }, { today: TODAY }).ok, false);
  }
});

test('VIHAMIELINEN: kenttä actionType/action/type ei voi valita komentoa', async () => {
  const { result, state } = await attack(
    '{"actionType":"delete_task","action":"delete_task","type":"delete_task","targetName":"Hammaslääkäri"}');
  assert.equal(result.ok, false);
  assertUntouched(state);
});

test('VIHAMIELINEN: executeProposal ei käytä prototyyppiperintöä handlers-kartassa', async () => {
  let called = false;
  const handlers = Object.create({ constructor: () => { called = true; return { ok: true }; } });
  for (const intent of ['constructor', 'toString', '__proto__']) {
    const result = await executeProposal(
      { status: PROPOSAL_STATUS.READY, command: { intent, payload: {} }, target: null },
      handlers);
    assert.equal(result.ok, false, intent);
  }
  assert.equal(called, false);
});

// ------------------------------------- prototyyppisaastutus ja rakenteet

test('VIHAMIELINEN: JSON.parse:n oma __proto__-avain hylätään eikä saastuta Objectia', async () => {
  const before = Object.prototype.polluted;
  const { result, state } = await attack(
    '{"intent":"create_task","title":"x","__proto__":{"polluted":"yes","isAdmin":true}}');
  assert.equal(result.ok, false);
  assert.equal(Object.prototype.polluted, before);
  assert.equal({}.polluted, undefined);
  assert.equal({}.isAdmin, undefined);
  assertUntouched(state);
});

test('VIHAMIELINEN: sisäkkäinen payload __proto__/constructor-avaimilla hylätään', async () => {
  for (const body of [
    '{"intent":"create_task","payload":{"title":"x","__proto__":{"polluted":1}}}',
    '{"intent":"create_task","payload":{"title":"x","constructor":{"prototype":{"polluted":1}}}}',
    '{"intent":"update_task","targetName":"Hammaslääkäri","changes":{"__proto__":{"x":1}}}'
  ]) {
    const { result, state } = await attack(body);
    assert.equal(result.ok, false, body);
    assert.equal({}.polluted, undefined);
    assertUntouched(state);
  }
});

test('VIHAMIELINEN: olio- ja taulukkoarvot skalaarikentissä eivät päädy tallennukseen', async () => {
  for (const body of [
    '{"intent":"create_task","title":{"$ne":null}}',
    '{"intent":"create_task","title":["a","b"],"date":["2026-09-19"]}',
    '{"intent":"create_task","title":"x","category":{"a":1}}',
    '{"intent":"create_task","title":"x","note":[{"a":1}]}'
  ]) {
    const { state } = await attack(body);
    // Luonti joko hylätään tai putoaa turvallisiin oletuksiin -- mutta
    // mikään olio/taulukko ei saa päätyä tehtävän kenttään.
    for (const task of state.tasks) {
      assert.equal(typeof task.title, 'string');
      assert.equal(typeof task.date === 'string' || task.date === null, true);
    }
  }
});

// -------------------------------------------- massa-avaus ja piilotetut komennot

test('VIHAMIELINEN: kenttien massa-asetus (id, userId, user_id, completed) ei läpäise luontia', async () => {
  const { result, state } = await attack(JSON.stringify({
    intent: 'create_task', title: 'Uusi', id: 'valittu-id', userId: OTHER_USER_ID,
    user_id: OTHER_USER_ID, completed: true, createdAt: '2000-01-01', isAdmin: true, role: 'admin'
  }));
  assert.equal(result.ok, true);
  const created = state.tasks.find(t => t.title === 'Uusi');
  assert.ok(created);
  assert.notEqual(created.id, 'valittu-id', 'malli ei saa valita rivin tunnistetta');
  assert.notEqual(created.completed, true, 'malli ei saa esiasettaa valmiiksi');
  assert.equal(created.userId, undefined);
  assert.equal(created.user_id, undefined);
  assert.equal(created.isAdmin, undefined);
  assert.equal(created.role, undefined);
});

test('VIHAMIELINEN: kaksi komentoa yhdessä vastauksessa -- ei kumpaakaan', async () => {
  for (const body of [
    '[{"intent":"delete_task","targetName":"Hammaslääkäri"},{"intent":"delete_task","targetName":"Ostoslista"}]',
    '{"intent":"delete_task","targetName":"Hammaslääkäri"}\n{"intent":"delete_task","targetName":"Ostoslista"}',
    '{"intent":"create_task","title":"a","intents":["delete_task","delete_task"]}'
  ]) {
    const { confirmCalls, state } = await attack(body);
    assert.ok(confirmCalls <= 1, 'enintään yksi vahvistus, ei useaa piilotettua komentoa');
    assert.equal(state.tasks.filter(t => t.title === 'Hammaslääkäri').length, 1,
      'toinen piilotetuista poistoista ei saa suorittua: ' + body);
    assert.equal(state.tasks.filter(t => t.title === 'Ostoslista').length, 1);
  }
});

test('VIHAMIELINEN: extractJson hylkää yläpään taulukon ja kahden olion ketjun', () => {
  assert.equal(extractJson('[{"intent":"a"},{"intent":"b"}]'), null);
  assert.equal(extractJson('{"intent":"a"}{"intent":"b"}'), null);
});

// -------------------------------------------------- koot ja luvut

test('VIHAMIELINEN: valtava otsikko typistetään rajaan eikä kaada mitään', async () => {
  const { result, state } = await attack(
    JSON.stringify({ intent: 'create_task', title: 'A'.repeat(500000) }));
  assert.equal(result.ok, true);
  const created = state.tasks.find(t => t.title.startsWith('AAAA'));
  assert.ok(created.title.length <= 200, 'otsikon pituus rajattu, oli ' + created.title.length);
});

test('VIHAMIELINEN: valtava muistiinpano ja kuvaus typistetään', () => {
  const resolved = resolveCommand({
    intent: 'create_task', title: 'x', note: 'N'.repeat(1e6)
  }, { today: TODAY });
  assert.equal(resolved.ok, true);
  assert.ok(resolved.command.payload.note.length <= 300);
});

test('VIHAMIELINEN: mahdottomat kalenteripäivät hylätään (2026-02-31, 2026-04-31, 2027-02-29)', () => {
  for (const bad of ['2026-02-31', '2026-04-31', '2027-02-29', '2026-06-31', '2026-09-31', '2026-13-01', '2026-00-10', '2026-01-00', '2026-1-1', '26-01-01']) {
    assert.equal(isIsoDate(bad), false, bad);
  }
  for (const good of ['2026-02-28', '2028-02-29', '2026-12-31', '2026-01-01', '2100-02-28']) {
    assert.equal(isIsoDate(good), true, good);
  }
  assert.equal(isIsoDate('2100-02-29'), false, '2100 ei ole karkausvuosi');
  assert.equal(isIsoDate('2000-02-29'), true, '2000 on karkausvuosi');
});

test('VIHAMIELINEN: mahdoton päivä ei päädy tehtävään (putoaa oletukseen, ei tallennu sellaisenaan)', async () => {
  const { state } = await attack('{"intent":"create_task","title":"Mahdoton","date":"2026-02-31"}');
  const created = state.tasks.find(t => t.title === 'Mahdoton');
  if (created) assert.notEqual(created.date, '2026-02-31');
});

test('VIHAMIELINEN: NaN/Infinity-tyyppiset luvut eivät läpäise', () => {
  const infinite = JSON.parse('{"intent":"reschedule_task","targetName":"x","shiftMinutes":1e999}');
  assert.equal(infinite.shiftMinutes, Infinity, 'JSON-literaali 1e999 on Infinity -- testin lähtöoletus');
  assert.equal(resolveCommand(infinite, { today: TODAY }).ok, false);

  for (const bad of ['NaN', 'Infinity', '-Infinity', '1e999', 'abc', {}, [], true]) {
    const r = resolveCommand({ intent: 'reschedule_task', targetName: 'x', shiftMinutes: bad }, { today: TODAY });
    assert.equal(r.ok, false, 'shiftMinutes ' + JSON.stringify(bad));
  }

  const dur = resolveCommand({ intent: 'create_task', title: 'x', durationMinutes: JSON.parse('1e999') }, { today: TODAY });
  assert.equal(dur.ok, true);
  assert.equal(dur.command.payload.durationMinutes, null, 'ääretön kesto pudotetaan');

  const bill = resolveCommand({
    intent: 'create_bill', name: 'Lasku', amount: JSON.parse('1e999'), dueDate: '2026-10-01'
  }, { today: TODAY });
  assert.equal(bill.ok, false, 'ääretön summa hylätään');
  const negative = resolveCommand({
    intent: 'create_bill', name: 'Lasku', amount: -50, dueDate: '2026-10-01'
  }, { today: TODAY });
  assert.equal(negative.ok, false, 'negatiivinen summa hylätään');
});

// ------------------------------------------- kohteet: jokerit, tyhjät, vieraat

for (const wildcard of ['*', '%', '.*', '%%', '_', '.', '?', '', '   ', '\t\n', '[a-z]+', '^', '$', '(.*)', '\\']) {
  test(`VIHAMIELINEN: jokerikohde ${JSON.stringify(wildcard)} ei osu mihinkään`, async () => {
    const result = resolveTarget({ entities: SEED(), name: wildcard, entityType: 'task' });
    assert.notEqual(result.status, 'exact', 'joker ei saa ratkaista täsmälliseksi kohteeksi');

    const { result: run, confirmCalls, state } = await attack(
      JSON.stringify({ intent: 'delete_task', targetName: wildcard }));
    assert.equal(run.ok, false);
    assert.equal(confirmCalls, 0);
    assertUntouched(state);
  });
}

test('VIHAMIELINEN: yhden merkin nimihaku ei ratkea täsmälliseksi osittaisosumalla', () => {
  const entities = [normalizeTask({ id: 'only', title: 'Kahvi', date: '2026-09-20' })];
  for (const one of ['k', 'a', 'i', 'K']) {
    const result = resolveTarget({ entities, name: one, entityType: 'task' });
    assert.notEqual(result.status, 'exact', `"${one}" ei saa ratkaista kohteeksi osajonona`);
  }
  assert.equal(resolveTarget({ entities, name: 'Kahvi', entityType: 'task' }).status, 'exact');
  assert.equal(resolveTarget({ entities, name: 'kahvi', entityType: 'task' }).status, 'exact');
});

test('VIHAMIELINEN: toisen käyttäjän UUID kohteena ei löydä mitään eikä suorita', async () => {
  const { result, confirmCalls, state } = await attack(JSON.stringify({
    intent: 'delete_task', taskId: OTHER_USER_ID, targetId: OTHER_USER_ID
  }));
  assert.equal(result.ok, false);
  assert.equal(confirmCalls, 0);
  assertUntouched(state);
});

test('VIHAMIELINEN: SQL-katkelma nimenä ei osu eikä suorita mitään', async () => {
  for (const sql of ["'; DROP TABLE tasks;--", "' OR '1'='1", '1; DELETE FROM tasks', 'UNION SELECT * FROM auth.users']) {
    const { result, confirmCalls, state } = await attack(
      JSON.stringify({ intent: 'delete_task', targetName: sql }));
    assert.equal(result.ok, false, sql);
    assert.equal(confirmCalls, 0);
    assertUntouched(state);
  }
});

test('VIHAMIELINEN: SQL-katkelma otsikkona tallentuu tekstinä, ei muuta mitään muuta', async () => {
  const sql = "Robert'); DROP TABLE tasks;--";
  const { result, state } = await attack(JSON.stringify({ intent: 'create_task', title: sql }));
  assert.equal(result.ok, true);
  assert.equal(state.tasks.length, 3);
  assert.equal(state.tasks.find(t => t.title === sql).title, sql);
});

test('VIHAMIELINEN: URL ja skripti otsikkona ovat pelkkää tekstiä', async () => {
  const { state } = await attack(JSON.stringify({
    intent: 'create_task', title: 'https://evil.example/x?steal=1', note: 'javascript:alert(1)'
  }));
  const created = state.tasks.find(t => t.title.startsWith('https://'));
  assert.ok(created);
  assert.equal(typeof created.title, 'string');
});

test('VIHAMIELINEN: kohde ei löydy -> ei suoritusta, ei tyhjää valitsinta', async () => {
  let chooseCalled = false;
  const result = await runTypedCommand('poista olematon', {
    fetchImpl: fetchReturning('{"intent":"delete_task","targetName":"Olematon"}'),
    confirmFn: async () => true,
    chooseFn: async () => { chooseCalled = true; return null; }
  });
  assert.equal(result.ok, false);
  assert.equal(chooseCalled, false);
  assertUntouched(getState());
});

test('VIHAMIELINEN: massapoisto- ja kaikki-sanat eivät ole komentoja', async () => {
  for (const body of [
    '{"intent":"delete_task","targetName":"kaikki"}',
    '{"intent":"delete_task","all":true}',
    '{"intent":"delete_task","targetName":"*","all":true}',
    '{"intent":"delete_tasks","targetName":"Hammaslääkäri"}',
    '{"intent":"delete_task","targetName":"Hammaslääkäri","limit":9999,"scope":"all"}'
  ]) {
    const { confirmCalls, state } = await attack(body, { confirm: false });
    assert.ok(state.tasks.length === 2, body);
    assert.ok(confirmCalls <= 1, body);
  }
});

// ---------------------------------------- talouden mutaatiot ilman tukea

test('VIHAMIELINEN: tukemattomat talouskomennot hylätään', () => {
  for (const intent of ['delete_bill', 'pay_bill', 'transfer', 'create_expense', 'update_investment',
    'delete_transaction', 'set_budget', 'export_data', 'delete_account']) {
    assert.equal(resolveCommand({ intent, name: 'x', amount: 1 }, { today: TODAY }).ok, false, intent);
  }
});

// ------------------------------------------ ehdotus vs suoritus (vanhentunut)

test('VIHAMIELINEN: kohde vaihtuu vahvistuksen aikana toiseksi samannimiseksi -- tunniste ratkaisee', async () => {
  const result = await runTypedCommand('merkitse hammaslääkäri tehdyksi', {
    fetchImpl: fetchReturning('{"intent":"complete_task","targetName":"Hammaslääkäri"}'),
    confirmFn: async () => {
      // Alkuperäinen (t1) poistuu ja tilalle tulee uusi rivi samalla nimellä
      // mutta eri tunnisteella. Vanhentuneen ehdotuksen ei saa osua uuteen.
      setTasks([
        normalizeTask({ id: 'uusi', title: 'Hammaslääkäri', date: '2026-10-10' }),
        normalizeTask({ id: 't2', title: 'Ostoslista', date: '2026-09-21' })
      ]);
      return true;
    },
    chooseFn: async () => null
  });
  assert.equal(result.ok, false, 'vanhentunut ehdotus ei saa osua uuteen riviin');
  assert.equal(getState().tasks.find(t => t.id === 'uusi').completed, false);
});
