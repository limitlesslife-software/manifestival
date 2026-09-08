// Talouden käyttöliittymä: laskut, toistuvat menot, säästötavoitteet.
//
// MITÄ TÄMÄ VARTIOI
//
// Kolmella talousdomainilla oli kanta, RLS, repositoriot ja koko
// domain-logiikka — mutta ei yhtään näkymää. Sanaa "Talous" ei
// esiintynyt käyttöliittymässä kertaakaan, eikä laskua voinut luoda.
//
// RAHA ON SE, MIKÄ TÄSSÄ VOI MENNÄ PAHIMMIN PIELEEN. Sentti joka
// katoaa pyöristyksessä ei palaa, ja liukuluku joka pääsee kantaan jää
// sinne. Siksi rahatestejä on eniten.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { fakeClient, isGateOpen } from './helpers/gates.mjs';
import { setClient } from '../src/data/client.js';
import { setUser, clearUser } from '../src/data/session.js';
import {
  billsRepo, recurringExpensesRepo, savingsGoalsRepo, clearAllCollections
} from '../src/data/collectionsRepo.js';
import {
  getState, resetState, setBills, setRecurringExpenses, setSavingsGoals,
  findBill, findRecurringExpense, findSavingsGoal, removeRecurringExpenseFromState
} from '../src/app/state.js';
import {
  createBill, editBill, setBillPaid,
  createRecurringExpense, editRecurringExpense,
  createSavingsGoal, editSavingsGoal
} from '../src/app/actions.js';
import {
  BILL_STATUS, CADENCE, normalizeBill, normalizeRecurringExpense,
  normalizeSavingsGoal, summarizeSavingsGoal
} from '../src/domain/finance.js';
import { parseMoneyToMinor, formatMoney, formatMinorAsInput } from '../src/domain/money.js';

const USER_A = { id: 'aaaaaaaa-0000-0000-0000-00000000000a', email: 'a@example.com' };
const USER_B = { id: 'bbbbbbbb-0000-0000-0000-00000000000b', email: 'b@example.com' };

/** Ks. tests/projects-ui.test.mjs — sama perustelu. */
function installClientIfGateOpen() {
  const anyOpen = ['bills', 'recurringExpenses', 'savingsGoals'].some(isGateOpen);
  if (anyOpen) setClient(fakeClient({ data: [], error: null }));
  else setClient(null);
}

beforeEach(() => {
  resetState();
  clearAllCollections();
  clearUser();
  installClientIfGateOpen();
});

// =====================================================================
// TALOUS ON LÖYDETTÄVISSÄ
// =====================================================================

test('KRIITTINEN: Talous on oma välilehtensä ja sisältää kolme osiota', () => {
  const html = read('index.html');

  assert.ok(html.includes('data-screen="screen-finance"'),
    'Talous-välilehteä ei ole alapalkissa');
  assert.ok(html.includes('>Talous<'), 'näkyvää nimeä "Talous" ei ole');
  assert.ok(html.includes('id="screen-finance"'), 'talousnäkymää ei ole');

  const screen = html.slice(html.indexOf('id="screen-finance"'),
                            html.indexOf('id="screen-profile"'));
  for (const id of ['billsListContainer', 'expensesListContainer',
                    'savingsListContainer', 'financeOverview',
                    'billForm', 'expenseForm', 'savingsForm']) {
    assert.ok(screen.includes(`id="${id}"`), `talousnäkymästä puuttuu ${id}`);
  }

  // Suomenkieliset nimet, joilla käyttäjä etsii.
  for (const label of ['Laskut', 'Toistuvat menot', 'Säästötavoitteet']) {
    assert.ok(screen.includes(label), `näkyvä nimi "${label}" puuttuu`);
  }
});

test('KRIITTINEN: talousnäkymä renderöidään ja lomakkeet kytketään', () => {
  const main = read('src/app/main.js');
  assert.ok(main.includes('renderFinance()'), 'taloutta ei renderöidä');
  assert.ok(main.includes('initFinanceForms()'), 'talouslomakkeita ei kytketä');
  for (const close of ['closeBillForm()', 'closeExpenseForm()', 'closeSavingsForm()']) {
    assert.ok(main.includes(close), `${close} puuttuu uloskirjautumisesta`);
  }
});

test('KRIITTINEN: service worker esilataa talousnäkymän', () => {
  assert.ok(read('sw.js').includes("'/src/app/views/finance.js'"),
    'finance.js puuttuu SHELL-listalta');
});

test('KRIITTINEN: navigointi tuntee talousnäkymän', () => {
  assert.ok(read('src/app/navigation.js').includes("'screen-finance'"),
    'navigation.js ei tunne talousnäkymää');
});

// =====================================================================
// RAHA — TÄMÄ ON SE TÄRKEIN
// =====================================================================

test('KRIITTINEN: summa tallentuu sentteinä, ei liukulukuna', async () => {
  setUser(USER_A);
  await createBill({
    name: 'Sähkö', amountMinor: parseMoneyToMinor('12,34'), dueDate: '2026-10-01'
  });

  const bill = getState().bills[0];
  assert.equal(bill.amountMinor, 1234, '12,34 ei tallentunut senttilukuna 1234');
  assert.equal(Number.isInteger(bill.amountMinor), true, 'summa ei ole kokonaisluku');
});

test('KRIITTINEN: pilkku ja piste tarkoittavat samaa', () => {
  // Suomalainen kirjoittaa pilkun, numeronäppäimistö tuottaa pisteen.
  assert.equal(parseMoneyToMinor('12,34'), 1234);
  assert.equal(parseMoneyToMinor('12.34'), 1234);
  assert.equal(parseMoneyToMinor('12,34'), parseMoneyToMinor('12.34'));
});

test('KRIITTINEN: rahan reunatapaukset', () => {
  const cases = [
    ['0', 0], ['0,00', 0], ['0,01', 1], ['1', 100], ['1,00', 100],
    ['1,5', 150], ['12,34', 1234], ['950', 95000], ['1 234,56', 123456],
    ['1234.5', 123450]
  ];
  for (const [input, expected] of cases) {
    assert.equal(parseMoneyToMinor(input), expected,
      `"${input}" ei jäsentynyt arvoksi ${expected}`);
  }

  // Kelvoton EI pyöristy hiljaa joksikin muuksi — se on null, ja
  // validointi kertoo siitä käyttäjälle.
  for (const invalid of ['-5', 'abc', '12,345', '', '1,2,3', '12€', null, undefined]) {
    assert.equal(parseMoneyToMinor(invalid), null,
      `kelvoton syöte "${String(invalid)}" hyväksyttiin`);
  }
});

test('KRIITTINEN: muotoilu ja jäsennys ovat käänteisiä', () => {
  // Edestakainen kierros ei saa muuttaa lukua: kentästä kantaan ja
  // takaisin kenttään.
  for (const minor of [0, 1, 99, 100, 1234, 95000, 123456]) {
    const asInput = formatMinorAsInput(minor);
    assert.equal(parseMoneyToMinor(asInput), minor,
      `${minor} -> "${asInput}" -> ei palannut samaksi`);
  }
});

test('KRIITTINEN: summa ei ole koskaan liukuluku missään kerroksessa', () => {
  const bill = normalizeBill({ id: 'b', name: 'X', amountMinor: 1234, dueDate: '2026-10-01' });
  const row = billsRepo.mapping.toRow(bill);
  assert.equal(Number.isInteger(row.amount_minor), true);

  const expense = normalizeRecurringExpense({
    id: 'e', name: 'X', amountMinor: 95000, nextDueDate: '2026-10-01'
  });
  assert.equal(Number.isInteger(recurringExpensesRepo.mapping.toRow(expense).amount_minor), true);

  const goal = normalizeSavingsGoal({ id: 's', name: 'X', targetMinor: 300000, currentMinor: 1 });
  const goalRow = savingsGoalsRepo.mapping.toRow(goal);
  assert.equal(Number.isInteger(goalRow.target_minor), true);
  assert.equal(Number.isInteger(goalRow.current_minor), true);
});

test('valuutta näkyy muotoillussa summassa', () => {
  assert.ok(formatMoney(1234, 'EUR').includes('12'));
  assert.ok(formatMoney(1234, 'SEK').length > 0);
});

// =====================================================================
// LASKUT
// =====================================================================

test('KRIITTINEN: laskun luonti, muokkaus ja validointi', async () => {
  setUser(USER_A);

  const bad = await createBill({ name: '', amountMinor: null, dueDate: null });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.name && bad.errors.amountMinor && bad.errors.dueDate);
  assert.equal(getState().bills.length, 0, 'kelvoton lasku päätyi tilaan');

  const good = await createBill({ name: 'Sähkö', amountMinor: 4550, dueDate: '2026-10-01' });
  assert.equal(good.ok, true);
  assert.equal(getState().bills.length, 1);

  const id = getState().bills[0].id;
  assert.equal((await editBill(id, { amountMinor: 5000 })).ok, true);
  assert.equal(findBill(id).amountMinor, 5000);
});

test('KRIITTINEN: maksetuksi merkintä asettaa myös maksupäivän', async () => {
  // Kanta vaatii tämän (`bills_paid_date_check`): maksettu lasku ilman
  // maksupäivää olisi tieto joka ei kerro milloin.
  setUser(USER_A);
  await createBill({ name: 'Sähkö', amountMinor: 4550, dueDate: '2026-10-01' });
  const id = getState().bills[0].id;

  await setBillPaid(id, true);
  assert.equal(findBill(id).status, BILL_STATUS.PAID);
  assert.ok(findBill(id).paidDate, 'maksupäivä jäi tyhjäksi');

  await setBillPaid(id, false);
  assert.equal(findBill(id).status, BILL_STATUS.OPEN);
  assert.equal(findBill(id).paidDate, null, 'maksupäivä jäi voimaan');
});

test('KRIITTINEN: laskun liitos toistuvaan menoon katkeaa menon poistuessa', () => {
  // Lasku on historiaa: se on jo erääntynyt ja mahdollisesti maksettu,
  // eikä säännön poistaminen tee sitä tapahtumattomaksi. Kannassa sama
  // sääntö on `on delete set null (recurring_expense_id)`.
  setRecurringExpenses([{
    id: 'e-1', name: 'Vuokra', amountMinor: 95000, nextDueDate: '2026-10-01'
  }]);
  setBills([{
    id: 'b-1', name: 'Vuokra loka', amountMinor: 95000,
    dueDate: '2026-10-01', recurringExpenseId: 'e-1'
  }]);

  removeRecurringExpenseFromState('e-1');

  assert.equal(getState().recurringExpenses.length, 0, 'meno ei poistunut');
  assert.equal(getState().bills.length, 1, 'lasku poistettiin menon mukana');
  assert.equal(getState().bills[0].recurringExpenseId, null, 'liitos jäi orvoksi');
});

test('KRIITTINEN: epäonnistunut laskun tallennus perutaan tilasta', async () => {
  setUser(USER_A);
  const original = billsRepo.insert;
  billsRepo.insert = async () => ({ ok: false, error: { message: 'RLS' } });

  try {
    const result = await createBill({ name: 'Ei tallennu', amountMinor: 100, dueDate: '2026-10-01' });
    assert.equal(result.ok, false);
    assert.equal(getState().bills.length, 0, 'peruuttamaton lasku jäi tilaan');
  } finally {
    billsRepo.insert = original;
  }
});

// =====================================================================
// TOISTUVAT MENOT
// =====================================================================

test('KRIITTINEN: toistuvan menon luonti, jakso ja käytöstä poisto', async () => {
  setUser(USER_A);

  const bad = await createRecurringExpense({ name: '', amountMinor: null });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.name && bad.errors.amountMinor && bad.errors.nextDueDate);

  const good = await createRecurringExpense({
    name: 'Vuokra', amountMinor: 95000,
    cadence: CADENCE.MONTHLY, nextDueDate: '2026-10-01', dayOfMonth: 1
  });
  assert.equal(good.ok, true);

  const id = getState().recurringExpenses[0].id;
  assert.equal(findRecurringExpense(id).active, true, 'uusi meno ei ole käytössä');

  await editRecurringExpense(id, { active: false });
  assert.equal(findRecurringExpense(id).active, false, 'käytöstä poisto ei tallentunut');
});

test('KRIITTINEN: epäonnistunut menon muokkaus palauttaa edellisen arvon', async () => {
  setUser(USER_A);
  await createRecurringExpense({
    name: 'Vuokra', amountMinor: 95000, nextDueDate: '2026-10-01'
  });
  const id = getState().recurringExpenses[0].id;

  const original = recurringExpensesRepo.update;
  recurringExpensesRepo.update = async () => ({ ok: false, error: { message: 'verkko' } });

  try {
    await editRecurringExpense(id, { amountMinor: 100000 });
    assert.equal(findRecurringExpense(id).amountMinor, 95000,
      'tila jäi näyttämään summaa jota ei tallennettu');
  } finally {
    recurringExpensesRepo.update = original;
  }
});

// =====================================================================
// SÄÄSTÖTAVOITTEET
// =====================================================================

test('KRIITTINEN: säästötavoitteen edistyminen kaikissa reunatapauksissa', () => {
  // current, target, prosentti, saavutettu
  //
  // NOLLATAVOITE ON "SAAVUTETTU" (0 >= 0), ja se on oikein sikäli kuin
  // tilaa voi olla olemassa — mutta sitä ei voi olla: validointi
  // hylkää nollatavoitteen, joten sellaista riviä ei synny
  // käyttöliittymän kautta. Olennaista on, ettei prosentti ole NaN
  // eikä Infinity edes silloin.
  const cases = [
    [0, 0, 0, true],
    [0, 100000, 0, false],
    [50000, 100000, 50, false],
    [100000, 100000, 100, true],
    [150000, 100000, 100, true]
  ];

  for (const [current, target, percent, reached] of cases) {
    const summary = summarizeSavingsGoal(normalizeSavingsGoal({
      id: 's', name: 'X', currentMinor: current, targetMinor: target
    }));

    assert.equal(summary.percent, percent,
      `${current}/${target} antoi ${summary.percent} %, odotettiin ${percent}`);
    assert.equal(Number.isFinite(summary.percent), true, 'prosentti ei ole luku');
    assert.equal(summary.reached, reached);
    assert.ok(summary.remainingMinor >= 0, 'puuttuva summa on negatiivinen');
  }
});

test('KRIITTINEN: nollatavoite ei tuota jakolaskua nollalla', () => {
  const summary = summarizeSavingsGoal(normalizeSavingsGoal({
    id: 's', name: 'X', currentMinor: 5000, targetMinor: 0
  }));
  assert.equal(summary.percent, 0);
  assert.equal(Number.isNaN(summary.percent), false, 'prosentti on NaN');
  assert.equal(summary.percent === Infinity, false, 'prosentti on Infinity');
});

test('KRIITTINEN: säästötavoitteen luonti vaatii tavoitesumman', async () => {
  setUser(USER_A);

  const bad = await createSavingsGoal({ name: 'Puskuri', targetMinor: null });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.targetMinor);

  const zero = await createSavingsGoal({ name: 'Puskuri', targetMinor: 0 });
  assert.equal(zero.ok, false, 'nollatavoite hyväksyttiin');

  const good = await createSavingsGoal({
    name: 'Puskuri', targetMinor: 300000, currentMinor: 25000, targetDate: '2027-01-01'
  });
  assert.equal(good.ok, true);
  assert.equal(getState().savingsGoals[0].currentMinor, 25000);

  const id = getState().savingsGoals[0].id;
  await editSavingsGoal(id, { currentMinor: 50000 });
  assert.equal(findSavingsGoal(id).currentMinor, 50000);
});

// =====================================================================
// PÄIVÄT
// =====================================================================

test('KRIITTINEN: päivät säilyvät päivinä eivätkä siirry aikavyöhykkeellä', () => {
  // Kannan sarakkeet ovat `date`, eivät `timestamptz`. Jos arvo
  // kulkisi UTC-aikaleiman kautta, suomalainen 1.10. voisi tallentua
  // 30.9:ksi.
  const bill = normalizeBill({
    id: 'b', name: 'X', amountMinor: 100,
    dueDate: '2026-10-01', paidDate: '2026-09-30'
  });
  assert.equal(bill.dueDate, '2026-10-01');
  assert.equal(bill.paidDate, '2026-09-30');

  const row = billsRepo.mapping.toRow(bill);
  assert.equal(row.due_date, '2026-10-01', 'eräpäivä muuttui rivimuunnoksessa');
  assert.equal(row.paid_date, '2026-09-30');

  const expense = normalizeRecurringExpense({
    id: 'e', name: 'X', amountMinor: 100, nextDueDate: '2027-01-01'
  });
  assert.equal(recurringExpensesRepo.mapping.toRow(expense).next_due_date, '2027-01-01');

  const goal = normalizeSavingsGoal({
    id: 's', name: 'X', targetMinor: 100, targetDate: '2027-06-30'
  });
  assert.equal(savingsGoalsRepo.mapping.toRow(goal).target_date, '2027-06-30');
});

// =====================================================================
// TURVA, ISTUNTO JA PASSIIVINEN LATAUS
// =====================================================================

test('KRIITTINEN: yksikään talouskirjoitus ei lähetä omistajuutta', () => {
  const rows = [
    billsRepo.mapping.toRow(normalizeBill({
      id: 'b', name: 'X', amountMinor: 1, dueDate: '2026-10-01' })),
    recurringExpensesRepo.mapping.toRow(normalizeRecurringExpense({
      id: 'e', name: 'X', amountMinor: 1, nextDueDate: '2026-10-01' })),
    savingsGoalsRepo.mapping.toRow(normalizeSavingsGoal({
      id: 's', name: 'X', targetMinor: 1 }))
  ];

  for (const row of rows) {
    for (const forbidden of ['user_id', 'created_at', 'updated_at']) {
      assert.equal(Object.prototype.hasOwnProperty.call(row, forbidden), false,
        `talouskirjoitus lähettää kentän ${forbidden}`);
    }
  }
});

test('KRIITTINEN: talouden luku ei kirjoita mitään', async () => {
  setUser(USER_A);
  const client = fakeClient({ data: [], error: null });
  setClient(client);

  await billsRepo.list();
  await recurringExpensesRepo.list();
  await savingsGoalsRepo.list();

  assert.equal(client.calls.some(call => call.operation !== 'select'), false,
    'talouden luku kirjoitti kantaan');
});

test('KRIITTINEN: tilinvaihto ei vuoda talousdataa seuraavalle', async () => {
  setUser(USER_A);
  await createBill({ name: 'A:n lasku', amountMinor: 1000, dueDate: '2026-10-01' });
  await createSavingsGoal({ name: 'A:n puskuri', targetMinor: 100000 });
  assert.ok(getState().bills.length + getState().savingsGoals.length > 0);

  clearAllCollections();
  resetState();
  clearUser();
  setUser(USER_B);

  assert.deepEqual(getState().bills, [], 'B näkisi A:n laskut');
  assert.deepEqual(getState().savingsGoals, [], 'B näkisi A:n säästötavoitteet');
  assert.deepEqual((await billsRepo.memory.list()).value, [],
    'muistivarastoon jäi A:n laskuja');
});

test('KRIITTINEN: lomakkeiden sulkeminen tyhjentää kentät', () => {
  const view = read('src/app/views/finance.js');
  for (const [fn, filler] of [
    ['closeBillForm', 'fillBillForm(null)'],
    ['closeExpenseForm', 'fillExpenseForm(null)'],
    ['closeSavingsForm', 'fillSavingsForm(null)']
  ]) {
    const block = view.slice(view.indexOf(`export function ${fn}`));
    const body = block.slice(0, block.indexOf('}') + 1);
    assert.ok(body.includes(filler), `${fn} ei tyhjennä kenttiä`);
  }
});

test('KRIITTINEN: käyttäjän teksti escapetaan talousnäkymässä', () => {
  const view = read('src/app/views/finance.js');
  const renderStart = view.indexOf('function renderBills');
  const renderEnd = view.indexOf('// -------------------------------------------------------- lomakeapurit');
  const renders = view.slice(renderStart, renderEnd);

  for (const field of ['bill.name', 'bill.id', 'expense.name', 'expense.id',
                       'goal.name', 'goal.id']) {
    const pattern = new RegExp('\\$\\{[^}]*' + field.replace('.', '\\.') + '[^}]*\\}', 'g');
    for (const match of renders.matchAll(pattern)) {
      assert.ok(match[0].includes('escapeHtml'),
        `${field} renderöidään escapettamatta: ${match[0]}`);
    }
  }
});

test('talousnäkymä ei keksi lukuja eikä ota yhteyttä ulos', () => {
  // Ei pankkiyhteyksiä, ei tilisaldoja, ei sijoituksia, ei ennusteita.
  const view = read('src/app/views/finance.js');
  assert.equal(/\bfetch\(/.test(view), false, 'talousnäkymä tekee verkkopyynnön');
  assert.equal(/Math\.random/.test(view), false, 'talousnäkymä arpoo lukuja');
  assert.equal(view.includes('crypto.randomUUID'), false,
    'näkymä luo tunnisteita — se kuuluu sovelluskerrokselle');
});
