// Talousdomainin testit.
//
// Raha on se osa-alue, jossa hiljainen virhe maksaa eniten ja huomataan
// viimeisenä. Summat ovat SENTTEJÄ kokonaislukuina — ks. domain/money.js
// ja sen testit, joissa perustelu on osoitettu.
//
// Toistuvuudessa painopiste on kalenterin reunoissa: 28/29/30/31,
// helmikuu, karkausvuosi ja vuodenvaihde. Ne ovat ne kohdat, joissa
// naiivi "lisää 30 päivää" menee rikki.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BILL_STATUS, BILL_URGENCY, CADENCE, DEFAULT_CURRENCY, DEFAULT_BILL_LEAD_DAYS,
  MAX_OCCURRENCES,
  normalizeBill, validateBill, isOpenBill, isBillOverdue, daysUntilDue, billUrgency,
  normalizeRecurringExpense, validateRecurringExpense,
  monthlyCostMinor, monthlyCostByCurrency, monthlyDueDate,
  projectDueDates, projectAllDueDates,
  normalizeSavingsGoal, validateSavingsGoal, summarizeSavingsGoal,
  buildFinancialReminders, summarizeFinances, cadenceLabel
} from '../src/domain/finance.js';

function bill(overrides = {}) {
  return normalizeBill({
    id: 'b1', name: 'Sähkölasku', amountMinor: 8450,
    dueDate: '2026-03-15', ...overrides
  });
}

function expense(overrides = {}) {
  return normalizeRecurringExpense({
    id: 'e1', name: 'Netti', amountMinor: 2990,
    cadence: CADENCE.MONTHLY, nextDueDate: '2026-03-02', ...overrides
  });
}

// ------------------------------------------------------------ normalisointi

test('lasku normalisoituu kelvollisiin arvoihin', () => {
  const normalized = bill();
  assert.equal(normalized.status, BILL_STATUS.OPEN);
  assert.equal(normalized.currency, DEFAULT_CURRENCY);
  assert.equal(normalized.amountMinor, 8450);
  assert.equal(Number.isInteger(normalized.amountMinor), true);
});

test('normalizeBill on idempotentti', () => {
  const once = bill({ note: '  muistiinpano  ', currency: 'eur' });
  assert.deepEqual(normalizeBill(once), once);
});

test('normalizeRecurringExpense on idempotentti', () => {
  const once = expense({ cadence: 'roskaa', dayOfMonth: '2' });
  assert.deepEqual(normalizeRecurringExpense(once), once);
});

test('normalizeSavingsGoal on idempotentti', () => {
  const once = normalizeSavingsGoal({
    id: 's1', name: 'Hätävara', targetMinor: 600000, currentMinor: 370000
  });
  assert.deepEqual(normalizeSavingsGoal(once), once);
});

test('KRIITTINEN: puuttuva summa on tuntematon eikä nolla', () => {
  // Nolla olisi vaarallisin tulkinta: 0 euron lasku näyttäisi kirjatulta
  // ja maksetulta.
  for (const value of [null, undefined, '', 'paljon', NaN, Infinity, -5]) {
    assert.equal(normalizeBill({ amountMinor: value }).amountMinor, null, String(value));
  }
});

test('summa säilyy kokonaislukuna', () => {
  assert.equal(normalizeBill({ amountMinor: 12995 }).amountMinor, 12995);
  assert.equal(normalizeBill({ amountMinor: '12995' }).amountMinor, 12995);
});

test('kelvoton jakso saa turvallisen oletuksen', () => {
  assert.equal(normalizeRecurringExpense({ cadence: 'joka toinen tiistai' }).cadence,
    CADENCE.MONTHLY);
});

test('kuukauden päivä rajataan alueelle 1-31', () => {
  assert.equal(normalizeRecurringExpense({ dayOfMonth: 2 }).dayOfMonth, 2);
  assert.equal(normalizeRecurringExpense({ dayOfMonth: 31 }).dayOfMonth, 31);
  assert.equal(normalizeRecurringExpense({ dayOfMonth: 0 }).dayOfMonth, null);
  assert.equal(normalizeRecurringExpense({ dayOfMonth: 32 }).dayOfMonth, null);
  assert.equal(normalizeRecurringExpense({ dayOfMonth: 'roskaa' }).dayOfMonth, null);
});

// -------------------------------------------------------------- validointi

test('lasku vaatii nimen, summan ja eräpäivän', () => {
  const { valid, errors } = validateBill(normalizeBill({}));
  assert.equal(valid, false);
  assert.ok(errors.name && errors.amountMinor && errors.dueDate);
});

test('maksetulta laskulta vaaditaan maksupäivä', () => {
  const paid = bill({ status: BILL_STATUS.PAID });
  assert.equal(validateBill(paid).valid, false);

  const withDate = bill({ status: BILL_STATUS.PAID, paidDate: '2026-03-14' });
  assert.equal(validateBill(withDate).valid, true);
});

test('kelvollinen lasku, kulu ja säästötavoite läpäisevät validoinnin', () => {
  assert.equal(validateBill(bill()).valid, true);
  assert.equal(validateRecurringExpense(expense()).valid, true);
  assert.equal(validateSavingsGoal(normalizeSavingsGoal({
    name: 'Hätävara', targetMinor: 600000
  })).valid, true);
});

test('säästötavoite ilman tavoitesummaa hylätään', () => {
  const { valid, errors } = validateSavingsGoal(normalizeSavingsGoal({ name: 'X' }));
  assert.equal(valid, false);
  assert.ok(errors.targetMinor);
});

// ------------------------------------------------------------ myöhästyminen

test('myöhästyminen on johdettu eikä tallennettu', () => {
  const open = bill({ dueDate: '2026-03-15' });
  assert.equal(isBillOverdue(open, '2026-03-14'), false);
  assert.equal(isBillOverdue(open, '2026-03-15'), false, 'eräpäivänä ei vielä myöhässä');
  assert.equal(isBillOverdue(open, '2026-03-16'), true);
});

test('maksettu tai peruttu lasku ei ole avoin eikä myöhässä', () => {
  const paid = bill({ dueDate: '2026-01-01', status: BILL_STATUS.PAID, paidDate: '2026-01-05' });
  const cancelled = bill({ status: BILL_STATUS.CANCELLED, dueDate: '2020-01-01' });

  for (const target of [paid, cancelled]) {
    assert.equal(isOpenBill(target), false);
    assert.equal(isBillOverdue(target, '2026-06-01'), false);
  }
});

test('päivät eräpäivään lasketaan molempiin suuntiin', () => {
  const target = bill({ dueDate: '2026-03-15' });
  assert.equal(daysUntilDue(target, '2026-03-15'), 0);
  assert.equal(daysUntilDue(target, '2026-03-10'), 5);
  assert.equal(daysUntilDue(target, '2026-03-20'), -5);
});

test('kiireellisyys johdetaan eräpäivästä', () => {
  const target = bill({ dueDate: '2026-03-15' });
  assert.equal(billUrgency(target, '2026-03-01'), BILL_URGENCY.UPCOMING);
  assert.equal(billUrgency(target, '2026-03-13'), BILL_URGENCY.DUE);
  assert.equal(billUrgency(target, '2026-03-15'), BILL_URGENCY.DUE);
  assert.equal(billUrgency(target, '2026-03-16'), BILL_URGENCY.OVERDUE);

  assert.equal(billUrgency(bill({ status: BILL_STATUS.PAID, paidDate: '2026-03-01' }),
    '2026-03-20'), BILL_URGENCY.PAID);
  assert.equal(billUrgency(bill({ status: BILL_STATUS.CANCELLED }), '2026-03-20'),
    BILL_URGENCY.CANCELLED);
});

// --------------------------------------------------------- kuukausikustannus

test('kuukausikustannus muunnetaan jaksosta sentteinä', () => {
  assert.equal(monthlyCostMinor(expense({ amountMinor: 3000, cadence: CADENCE.MONTHLY })), 3000);
  assert.equal(monthlyCostMinor(expense({ amountMinor: 12000, cadence: CADENCE.YEARLY })), 1000);
  assert.equal(monthlyCostMinor(expense({ amountMinor: 3000, cadence: CADENCE.QUARTERLY })), 1000);
  assert.equal(monthlyCostMinor(expense({ amountMinor: 1200, cadence: CADENCE.WEEKLY })), 5200);
});

test('kuukausikustannus on aina kokonaisluku', () => {
  const cost = monthlyCostMinor(expense({ amountMinor: 10000, cadence: CADENCE.QUARTERLY }));
  assert.equal(Number.isInteger(cost), true);
  assert.equal(cost, 3333);
});

test('KRIITTINEN: eri valuutat pysyvät erillään kuukausikustannuksessa', () => {
  const totals = monthlyCostByCurrency([
    expense({ id: 'a', amountMinor: 3000, currency: 'EUR' }),
    expense({ id: 'b', amountMinor: 2000, currency: 'USD' })
  ]);
  assert.deepEqual(totals, { EUR: 3000, USD: 2000 });
});

test('pois kytketty kulu ei ole kuukausikustannuksessa', () => {
  const totals = monthlyCostByCurrency([
    expense({ id: 'a', amountMinor: 3000 }),
    expense({ id: 'b', amountMinor: 6000, active: false })
  ]);
  assert.deepEqual(totals, { EUR: 3000 });
});

test('summaton kulu ei riko yhteenlaskua', () => {
  const totals = monthlyCostByCurrency([
    expense({ id: 'a', amountMinor: 1000 }),
    normalizeRecurringExpense({ id: 'b', name: 'Tuntematon' })
  ]);
  assert.deepEqual(totals, { EUR: 1000 });
});

// -------------------------------------------------- kuukauden päivä ja reunat

test('KRIITTINEN: 31. päivä ei vierity seuraavaan kuukauteen', () => {
  // Date vierittäisi 31.2. maaliskuun 3. päiväksi. Lasku erääntyy
  // helmikuussa, ei maaliskuussa — siksi päivä rajataan kuukauden
  // viimeiseen sen sijaan että se vieritettäisiin.
  assert.equal(monthlyDueDate(2026, 1, 31), '2026-02-28', 'helmikuu 2026');
  assert.equal(monthlyDueDate(2026, 3, 31), '2026-04-30', 'huhtikuussa 30 päivää');
  assert.equal(monthlyDueDate(2026, 0, 31), '2026-01-31', 'tammikuussa 31');
});

test('KRIITTINEN: karkausvuoden helmikuu saa 29. päivän', () => {
  assert.equal(monthlyDueDate(2028, 1, 31), '2028-02-29');
  assert.equal(monthlyDueDate(2028, 1, 29), '2028-02-29');
  assert.equal(monthlyDueDate(2026, 1, 29), '2026-02-28', 'ei karkausvuosi');
});

test('kuukauden päivä rajataan myös alarajalla', () => {
  assert.equal(monthlyDueDate(2026, 2, 0), '2026-03-01');
  assert.equal(monthlyDueDate(2026, 2, -5), '2026-03-01');
});

test('KRIITTINEN: kuukausitoisto käyttää kalenteria eikä 30 päivää', () => {
  // "Vuokra 2. päivä" pysyy toisena päivänä joka kuukausi. Naiivi
  // "+30 päivää" ajautuisi vuoden aikana kuukauden verran sivuun.
  const projected = projectDueDates({
    expense: expense({ nextDueDate: '2026-01-02', dayOfMonth: 2, cadence: CADENCE.MONTHLY }),
    from: '2026-01-01', to: '2026-06-30'
  });

  assert.deepEqual(projected.map(p => p.date), [
    '2026-01-02', '2026-02-02', '2026-03-02',
    '2026-04-02', '2026-05-02', '2026-06-02'
  ]);
});

test('KRIITTINEN: kuukausitoisto 31. päivänä ei ajaudu sivuun', () => {
  // Helmikuu rajaa päivän 28:aan, mutta seuraava kuukausi palaa 31:een —
  // ankkuri on dayOfMonth, ei edellinen toteutunut päivä.
  const projected = projectDueDates({
    expense: expense({ nextDueDate: '2026-01-31', dayOfMonth: 31, cadence: CADENCE.MONTHLY }),
    from: '2026-01-01', to: '2026-05-31'
  });

  assert.deepEqual(projected.map(p => p.date), [
    '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'
  ]);
});

test('vuodenvaihde ei katkaise toistoa', () => {
  const projected = projectDueDates({
    expense: expense({ nextDueDate: '2026-11-15', dayOfMonth: 15, cadence: CADENCE.MONTHLY }),
    from: '2026-11-01', to: '2027-02-28'
  });

  assert.deepEqual(projected.map(p => p.date), [
    '2026-11-15', '2026-12-15', '2027-01-15', '2027-02-15'
  ]);
});

test('vuosijakso osuu samaan päivään seuraavana vuonna', () => {
  const projected = projectDueDates({
    expense: expense({ nextDueDate: '2026-06-01', dayOfMonth: 1, cadence: CADENCE.YEARLY }),
    from: '2026-01-01', to: '2029-12-31'
  });
  assert.deepEqual(projected.map(p => p.date),
    ['2026-06-01', '2027-06-01', '2028-06-01', '2029-06-01']);
});

test('neljännesvuosi etenee kolmen kuukauden välein', () => {
  const projected = projectDueDates({
    expense: expense({ nextDueDate: '2026-01-15', dayOfMonth: 15, cadence: CADENCE.QUARTERLY }),
    from: '2026-01-01', to: '2026-12-31'
  });
  assert.deepEqual(projected.map(p => p.date),
    ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15']);
});

test('viikkojakso etenee seitsemän päivän välein', () => {
  const projected = projectDueDates({
    expense: expense({ nextDueDate: '2026-03-02', cadence: CADENCE.WEEKLY }),
    from: '2026-03-01', to: '2026-03-31'
  });
  assert.deepEqual(projected.map(p => p.date),
    ['2026-03-02', '2026-03-09', '2026-03-16', '2026-03-23', '2026-03-30']);
});

// -------------------------------------------------------------- ennuste

test('menneet erääntymiset eivät kuulu ennusteeseen', () => {
  const projected = projectDueDates({
    expense: expense({ nextDueDate: '2020-01-02', dayOfMonth: 2 }),
    from: '2026-03-01', to: '2026-04-30'
  });
  assert.ok(projected.length > 0, 'vanha lähtöpäivä ei saa estää ennustetta');
  for (const item of projected) assert.ok(item.date >= '2026-03-01', item.date);
});

test('pois kytketty kulu ei tuota yhtään erääntymistä', () => {
  assert.deepEqual(projectDueDates({
    expense: expense({ active: false }), from: '2026-01-01', to: '2026-12-31'
  }), []);
});

test('ennuste on deterministinen', () => {
  const args = {
    expense: expense({ cadence: CADENCE.WEEKLY, nextDueDate: '2026-03-02' }),
    from: '2026-03-01', to: '2026-05-01'
  };
  assert.deepEqual(projectDueDates(args), projectDueDates(args));
});

test('KRIITTINEN: ennuste ei materialisoidu rajattomasti', () => {
  const projected = projectDueDates({
    expense: expense({ cadence: CADENCE.WEEKLY, nextDueDate: '2026-01-01' }),
    from: '2026-01-01', to: '2126-01-01'
  });
  assert.ok(projected.length <= MAX_OCCURRENCES, `${projected.length} riviä on liikaa`);
});

test('kelvoton väli ei tuota ennustetta', () => {
  const base = expense();
  assert.deepEqual(projectDueDates({ expense: base, from: 'eilen', to: '2026-05-01' }), []);
  assert.deepEqual(projectDueDates({ expense: base, from: '2026-05-01', to: '2026-03-01' }), []);
  assert.deepEqual(projectDueDates({ expense: null, from: '2026-03-01', to: '2026-05-01' }), []);
});

test('usean kulun ennuste yhdistyy päiväjärjestykseen', () => {
  const combined = projectAllDueDates({
    expenses: [
      expense({ id: 'a', name: 'Netti', nextDueDate: '2026-03-05', dayOfMonth: 5 }),
      expense({ id: 'b', name: 'Vakuutus', nextDueDate: '2026-03-02', dayOfMonth: 2 })
    ],
    from: '2026-03-01', to: '2026-04-30'
  });

  let previous = '';
  for (const item of combined) {
    assert.ok(item.date >= previous, 'yhdistetty lista ei ole järjestyksessä');
    previous = item.date;
  }
  assert.equal(combined[0].name, 'Vakuutus', 'aikaisempi eräpäivä ensin');
});

// ------------------------------------------------------- säästötavoitteet

test('säästötavoitteen edistyminen on johdettu', () => {
  const summary = summarizeSavingsGoal(normalizeSavingsGoal({
    name: 'Hätävara', targetMinor: 600000, currentMinor: 370000
  }));

  assert.equal(summary.percent, 62);
  assert.equal(summary.remainingMinor, 230000);
  assert.equal(summary.reached, false);
});

test('saavutettu tavoite ei tuota yli sataa prosenttia eikä negatiivista jäännöstä', () => {
  const summary = summarizeSavingsGoal(normalizeSavingsGoal({
    name: 'Hätävara', targetMinor: 600000, currentMinor: 700000
  }));
  assert.equal(summary.percent, 100);
  assert.equal(summary.remainingMinor, 0);
  assert.equal(summary.reached, true);
});

test('säästötavoitteessa ei ole tuotto-oletusta', () => {
  // Jos moduuli laskisi korkoa, se ennustaisi — ja ennustaminen on
  // nimenomaan rajattu pois.
  const goal = normalizeSavingsGoal({ name: 'X', targetMinor: 100000 });
  assert.equal('interestRate' in goal, false);
  assert.equal('projectedValue' in goal, false);
  assert.equal('expectedReturn' in goal, false);
});

// ---------------------------------------------------------- muistutukset

test('muistutus syntyy vain lähestyvistä ja myöhässä olevista', () => {
  const reminders = buildFinancialReminders({
    bills: [
      bill({ id: 'kaukana', dueDate: '2026-04-30' }),
      bill({ id: 'pian', dueDate: '2026-03-16' }),
      bill({ id: 'tanaan', dueDate: '2026-03-15' }),
      bill({ id: 'myohassa', dueDate: '2026-03-01' })
    ],
    todayIso: '2026-03-15',
    leadDays: DEFAULT_BILL_LEAD_DAYS
  });

  assert.deepEqual(reminders.map(r => r.billId), ['myohassa', 'tanaan', 'pian']);
});

test('KRIITTINEN: maksetusta laskusta ei koskaan muistuteta', () => {
  const reminders = buildFinancialReminders({
    bills: [
      bill({ id: 'maksettu', dueDate: '2026-03-01', status: BILL_STATUS.PAID, paidDate: '2026-03-01' }),
      bill({ id: 'peruttu', dueDate: '2026-03-01', status: BILL_STATUS.CANCELLED }),
      bill({ id: 'avoin', dueDate: '2026-03-01' })
    ],
    todayIso: '2026-03-15'
  });
  assert.deepEqual(reminders.map(r => r.billId), ['avoin']);
});

test('myöhässä oleva lasku merkitään kiireellisimmäksi', () => {
  const [reminder] = buildFinancialReminders({
    bills: [bill({ dueDate: '2026-03-01' })], todayIso: '2026-03-15'
  });
  assert.equal(reminder.overdue, true);
  assert.equal(reminder.urgency, BILL_URGENCY.OVERDUE);
  assert.equal(reminder.daysUntil, -14);
});

test('muistutukset ovat deterministisiä', () => {
  const args = {
    bills: [bill({ id: 'a', dueDate: '2026-03-16' }), bill({ id: 'b', dueDate: '2026-03-16' })],
    todayIso: '2026-03-15'
  };
  assert.deepEqual(buildFinancialReminders(args), buildFinancialReminders(args));
});

test('kelvoton päivä ei tuota muistutuksia', () => {
  assert.deepEqual(buildFinancialReminders({ bills: [bill()], todayIso: 'tänään' }), []);
  assert.deepEqual(buildFinancialReminders({}), []);
});

// ------------------------------------------------------------ yhteenveto

test('yhteenveto kuvaa mitä on, valuutoittain', () => {
  const summary = summarizeFinances({
    bills: [
      bill({ id: 'a', amountMinor: 10000, dueDate: '2026-03-01' }),
      bill({ id: 'b', amountMinor: 5000, dueDate: '2026-04-01' }),
      bill({ id: 'c', amountMinor: 99900, dueDate: '2026-01-01',
        status: BILL_STATUS.PAID, paidDate: '2026-01-01' })
    ],
    expenses: [expense({ amountMinor: 3000, cadence: CADENCE.MONTHLY })],
    savingsGoals: [normalizeSavingsGoal({ name: 'Hätävara', targetMinor: 600000, currentMinor: 300000 })],
    todayIso: '2026-03-15'
  });

  assert.equal(summary.openCount, 2, 'maksettu ei ole avoin');
  assert.deepEqual(summary.openTotals, { EUR: 15000 });
  assert.equal(summary.overdueCount, 1);
  assert.deepEqual(summary.overdueTotals, { EUR: 10000 });
  assert.equal(summary.paidCount, 1);
  assert.deepEqual(summary.monthlyRecurringTotals, { EUR: 3000 });
  assert.equal(summary.activeExpenses, 1);
  assert.equal(summary.savingsGoals[0].percent, 50);
});

test('KRIITTINEN: yhteenveto ei summaa eri valuuttoja yhteen', () => {
  const summary = summarizeFinances({
    bills: [
      bill({ id: 'a', amountMinor: 10000, currency: 'EUR', dueDate: '2026-04-01' }),
      bill({ id: 'b', amountMinor: 10000, currency: 'USD', dueDate: '2026-04-01' })
    ],
    todayIso: '2026-03-15'
  });

  assert.deepEqual(summary.openTotals, { EUR: 10000, USD: 10000 });
  assert.equal(Object.keys(summary.openTotals).length, 2);
});

test('tyhjä yhteenveto ei ole NaN', () => {
  const summary = summarizeFinances({ todayIso: '2026-03-15' });
  assert.equal(summary.openCount, 0);
  assert.deepEqual(summary.openTotals, {});
  assert.deepEqual(summary.monthlyRecurringTotals, {});
  assert.deepEqual(summary.savingsGoals, []);
});

test('jaksolla on luettava nimi', () => {
  assert.equal(cadenceLabel(CADENCE.MONTHLY), 'Kuukausittain');
  assert.equal(cadenceLabel('tuntematon'), 'tuntematon');
});

// ---------------------------------------------- mitä tämä moduuli EI tee

test('SÄÄNTÖ: talousdomain ei anna neuvoja eikä ennusta tuottoja', () => {
  // Sijoitusneuvonta on säänneltyä toimintaa. Sovellus kuvaa mitä on, ei
  // ennusta mitä tulee.
  const api = {
    buildFinancialReminders, summarizeFinances, projectDueDates,
    summarizeSavingsGoal, monthlyCostMinor
  };
  const forbidden = ['recommend', 'advice', 'suositt', 'forecast',
    'predict', 'shouldbuy', 'shouldsell', 'interest', 'yield'];

  for (const name of Object.keys(api)) {
    for (const word of forbidden) {
      assert.equal(name.toLowerCase().includes(word), false, `${name} viittaa neuvontaan`);
    }
  }
});
