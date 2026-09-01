// Talousdomainin testit.
//
// Raha on se osa-alue, jossa hiljainen virhe maksaa eniten. Siksi
// pyöristystä, myöhästymistä ja toistuvuutta testataan tarkemmin kuin
// muualla — ja siksi testataan myös se, mitä moduuli EI tee.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BILL_STATUS, CADENCE, DEFAULT_CURRENCY, MAX_AMOUNT, DEFAULT_BILL_LEAD_DAYS,
  normalizeBill, validateBill, isOpenBill, isBillOverdue, daysUntilDue,
  normalizeRecurringExpense, validateRecurringExpense,
  monthlyCost, totalMonthlyCost, projectDueDates, projectAllDueDates,
  buildFinancialReminders, summarizeFinances, cadenceLabel
} from '../src/domain/finance.js';

function bill(overrides = {}) {
  return normalizeBill({
    id: 'b1', title: 'Sähkölasku', amount: 84.5,
    dueDate: '2026-03-15', ...overrides
  });
}

function expense(overrides = {}) {
  return normalizeRecurringExpense({
    id: 'e1', title: 'Netti', amount: 29.9,
    cadence: CADENCE.MONTHLY, nextDueDate: '2026-03-01', ...overrides
  });
}

// ------------------------------------------------------------ normalisointi

test('lasku normalisoituu kelvollisiin arvoihin', () => {
  const normalized = bill();
  assert.equal(normalized.status, BILL_STATUS.OPEN);
  assert.equal(normalized.currency, DEFAULT_CURRENCY);
  assert.equal(normalized.amount, 84.5);
});

test('normalizeBill on idempotentti', () => {
  const once = bill({ note: '  muistiinpano  ', amount: '12.345' });
  assert.deepEqual(normalizeBill(once), once);
});

test('normalizeRecurringExpense on idempotentti', () => {
  const once = expense({ amount: '19.999', cadence: 'roskaa' });
  assert.deepEqual(normalizeRecurringExpense(once), once);
});

test('KRIITTINEN: summa pyöristetään sentteihin heti', () => {
  // Rahaa ei säilytetä tarkistamattomana liukulukuna: 0,1 + 0,2 ei ole 0,3
  // binäärisessä liukuluvussa, ja virhe kertautuu summattaessa.
  assert.equal(normalizeBill({ amount: 12.345 }).amount, 12.35);
  assert.equal(normalizeBill({ amount: 12.344 }).amount, 12.34);
  assert.equal(normalizeBill({ amount: '19.999' }).amount, 20);
});

test('kelvoton tai negatiivinen summa hylätään', () => {
  for (const value of [null, undefined, '', 'paljon', NaN, Infinity, -5]) {
    assert.equal(normalizeBill({ amount: value }).amount, null, String(value));
  }
});

test('järjetön summa hylätään kirjoitusvirheenä', () => {
  assert.equal(normalizeBill({ amount: MAX_AMOUNT + 1 }).amount, null);
  assert.equal(normalizeBill({ amount: MAX_AMOUNT }).amount, MAX_AMOUNT);
});

test('kelvoton jakso saa turvallisen oletuksen', () => {
  assert.equal(normalizeRecurringExpense({ cadence: 'joka toinen tiistai' }).cadence,
    CADENCE.MONTHLY);
});

// -------------------------------------------------------------- validointi

test('lasku vaatii nimen, summan ja eräpäivän', () => {
  const { valid, errors } = validateBill(normalizeBill({}));
  assert.equal(valid, false);
  assert.ok(errors.title && errors.amount && errors.dueDate);
});

test('maksetulta laskulta vaaditaan maksupäivä', () => {
  const paid = bill({ status: BILL_STATUS.PAID });
  const { valid, errors } = validateBill(paid);
  assert.equal(valid, false);
  assert.ok(errors.paidDate);

  const withDate = bill({ status: BILL_STATUS.PAID, paidDate: '2026-03-14' });
  assert.equal(validateBill(withDate).valid, true);
});

test('kelvollinen lasku läpäisee validoinnin', () => {
  assert.equal(validateBill(bill()).valid, true);
});

test('toistuva kulu vaatii nimen, summan ja seuraavan eräpäivän', () => {
  const { valid, errors } = validateRecurringExpense(normalizeRecurringExpense({}));
  assert.equal(valid, false);
  assert.ok(errors.title && errors.amount && errors.nextDueDate);
  assert.equal(validateRecurringExpense(expense()).valid, true);
});

// ------------------------------------------------------------ myöhästyminen

test('myöhästyminen on johdettu eikä tallennettu', () => {
  const open = bill({ dueDate: '2026-03-15' });

  assert.equal(isBillOverdue(open, '2026-03-14'), false);
  assert.equal(isBillOverdue(open, '2026-03-15'), false, 'eräpäivänä ei vielä myöhässä');
  assert.equal(isBillOverdue(open, '2026-03-16'), true);
});

test('maksettu lasku ei ole koskaan myöhässä', () => {
  const paid = bill({ dueDate: '2026-01-01', status: BILL_STATUS.PAID, paidDate: '2026-01-05' });
  assert.equal(isBillOverdue(paid, '2026-06-01'), false);
  assert.equal(isOpenBill(paid), false);
});

test('peruttu lasku ei ole avoin eikä myöhässä', () => {
  const cancelled = bill({ status: BILL_STATUS.CANCELLED, dueDate: '2020-01-01' });
  assert.equal(isOpenBill(cancelled), false);
  assert.equal(isBillOverdue(cancelled, '2026-01-01'), false);
});

test('päivät eräpäivään lasketaan molempiin suuntiin', () => {
  const target = bill({ dueDate: '2026-03-15' });
  assert.equal(daysUntilDue(target, '2026-03-15'), 0);
  assert.equal(daysUntilDue(target, '2026-03-10'), 5);
  assert.equal(daysUntilDue(target, '2026-03-20'), -5);
});

// --------------------------------------------------------- kuukausikustannus

test('kuukausikustannus muunnetaan jaksosta', () => {
  assert.equal(monthlyCost(expense({ amount: 30, cadence: CADENCE.MONTHLY })), 30);
  assert.equal(monthlyCost(expense({ amount: 120, cadence: CADENCE.YEARLY })), 10);
  assert.equal(monthlyCost(expense({ amount: 30, cadence: CADENCE.QUARTERLY })), 10);
  // 52 viikkoa vuodessa jaettuna kahdellatoista.
  assert.equal(monthlyCost(expense({ amount: 12, cadence: CADENCE.WEEKLY })), 52);
});

test('kuukausikustannus pyöristetään sentteihin', () => {
  const cost = monthlyCost(expense({ amount: 100, cadence: CADENCE.QUARTERLY }));
  assert.equal(cost, 33.33);
  assert.equal(Math.round(cost * 100) / 100, cost, 'ei liukulukuroskaa');
});

test('summa ei laske pois kytkettyjä kuluja mukaan', () => {
  const total = totalMonthlyCost([
    expense({ id: 'a', amount: 30, cadence: CADENCE.MONTHLY }),
    expense({ id: 'b', amount: 60, cadence: CADENCE.MONTHLY, active: false })
  ]);
  assert.equal(total, 30);
});

test('summa tyhjästä listasta on nolla eikä NaN', () => {
  assert.equal(totalMonthlyCost([]), 0);
  assert.equal(totalMonthlyCost(), 0);
});

test('summaton kulu ei riko yhteenlaskua', () => {
  const total = totalMonthlyCost([
    expense({ id: 'a', amount: 10 }),
    normalizeRecurringExpense({ id: 'b', title: 'Tuntematon' })
  ]);
  assert.equal(total, 10);
  assert.equal(Number.isNaN(total), false);
});

// -------------------------------------------------------------- ennuste

test('toistuva kulu ennustetaan välille päiväjärjestyksessä', () => {
  const projected = projectDueDates({
    expense: expense({ cadence: CADENCE.MONTHLY, nextDueDate: '2026-03-01' }),
    from: '2026-03-01', to: '2026-06-01'
  });

  assert.ok(projected.length >= 3);
  let previous = '';
  for (const item of projected) {
    assert.ok(item.date >= '2026-03-01' && item.date <= '2026-06-01', item.date);
    assert.ok(item.date >= previous, 'ei päiväjärjestyksessä');
    previous = item.date;
  }
});

test('menneet erääntymiset eivät kuulu ennusteeseen', () => {
  // Ne ovat historiaa, eivät suunnitelmaa. Kelaus alkaa välin alusta.
  const projected = projectDueDates({
    expense: expense({ nextDueDate: '2020-01-01', cadence: CADENCE.MONTHLY }),
    from: '2026-03-01', to: '2026-04-30'
  });

  assert.ok(projected.length > 0, 'vanha lähtöpäivä ei saa estää ennustetta');
  for (const item of projected) {
    assert.ok(item.date >= '2026-03-01', item.date);
  }
});

test('pois kytketty kulu ei tuota yhtään erääntymistä', () => {
  const projected = projectDueDates({
    expense: expense({ active: false }),
    from: '2026-01-01', to: '2026-12-31'
  });
  assert.deepEqual(projected, []);
});

test('ennuste on deterministinen', () => {
  const args = {
    expense: expense({ cadence: CADENCE.WEEKLY, nextDueDate: '2026-03-02' }),
    from: '2026-03-01', to: '2026-05-01'
  };
  assert.deepEqual(projectDueDates(args), projectDueDates(args));
});

test('ennuste ei kasva rajatta pitkälläkään välillä', () => {
  const projected = projectDueDates({
    expense: expense({ cadence: CADENCE.WEEKLY, nextDueDate: '2026-01-01' }),
    from: '2026-01-01', to: '2126-01-01'
  });
  assert.ok(projected.length <= 200, `${projected.length} riviä on liikaa`);
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
      expense({ id: 'a', title: 'Netti', nextDueDate: '2026-03-05', cadence: CADENCE.MONTHLY }),
      expense({ id: 'b', title: 'Vakuutus', nextDueDate: '2026-03-02', cadence: CADENCE.MONTHLY })
    ],
    from: '2026-03-01', to: '2026-04-30'
  });

  let previous = '';
  for (const item of combined) {
    assert.ok(item.date >= previous, 'yhdistetty lista ei ole järjestyksessä');
    previous = item.date;
  }
  assert.equal(combined[0].title, 'Vakuutus', 'aikaisempi eräpäivä ensin');
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

  const ids = reminders.map(r => r.billId);
  assert.equal(ids.includes('kaukana'), false, 'kaukainen lasku ei vielä muistuta');
  assert.deepEqual(ids, ['myohassa', 'tanaan', 'pian'], 'eräpäiväjärjestys');
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
    bills: [bill({ dueDate: '2026-03-01' })],
    todayIso: '2026-03-15'
  });
  assert.equal(reminder.overdue, true);
  assert.equal(reminder.urgency, 'overdue');
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

test('yhteenveto kuvaa mitä on', () => {
  const summary = summarizeFinances({
    bills: [
      bill({ id: 'a', amount: 100, dueDate: '2026-03-01' }),
      bill({ id: 'b', amount: 50, dueDate: '2026-04-01' }),
      bill({ id: 'c', amount: 999, dueDate: '2026-01-01', status: BILL_STATUS.PAID, paidDate: '2026-01-01' })
    ],
    expenses: [expense({ amount: 30, cadence: CADENCE.MONTHLY })],
    todayIso: '2026-03-15'
  });

  assert.equal(summary.openCount, 2, 'maksettu ei ole avoin');
  assert.equal(summary.openAmount, 150);
  assert.equal(summary.overdueCount, 1);
  assert.equal(summary.overdueAmount, 100);
  assert.equal(summary.monthlyRecurring, 30);
  assert.equal(summary.activeExpenses, 1);
});

test('tyhjä yhteenveto on nollia eikä NaN', () => {
  const summary = summarizeFinances({ todayIso: '2026-03-15' });
  for (const value of Object.values(summary)) {
    assert.equal(Number.isNaN(value), false);
    assert.equal(value, 0);
  }
});

test('jaksolla on luettava nimi', () => {
  assert.equal(cadenceLabel(CADENCE.MONTHLY), 'Kuukausittain');
  assert.equal(cadenceLabel('tuntematon'), 'tuntematon');
});

// ---------------------------------------------- mitä tämä moduuli EI tee

test('SÄÄNTÖ: talousdomain ei anna neuvoja eikä ennusta tuottoja', () => {
  // Sijoitusneuvonta on säänneltyä toimintaa. Sovellus kuvaa mitä on, ei
  // ennusta mitä tulee. Tämä testi lukitsee rajauksen koodin tasolla.
  const exported = Object.keys(
    Object.fromEntries(Object.entries(
      { buildFinancialReminders, summarizeFinances, projectDueDates })));

  const forbidden = ['recommend', 'advice', 'suositt', 'forecastReturn',
    'predictPrice', 'shouldBuy', 'shouldSell'];

  for (const name of exported) {
    for (const word of forbidden) {
      assert.equal(name.toLowerCase().includes(word.toLowerCase()), false,
        `${name} viittaa neuvontaan`);
    }
  }
});
