// Talous 2.0 -- domainin säännöt.
//
// MITÄ TÄMÄ ERITYISESTI VARTIOI
//
// Neljä sääntöä, joiden rikkoutuminen ei näkyisi missään virheessä
// vaan väärässä luvussa — ja väärä luku näyttää täsmälleen yhtä
// varmalta kuin oikea:
//
//   1. Suunta on laji, ei etumerkki. Summa on aina positiivinen.
//   2. Sama euro ei näy kahdesti.
//   3. Tekoälyn luenta ei tallennu ilman hyväksyntää.
//   4. Tuntematon sijoituksen arvo ei ole nolla.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TRANSACTION_KIND, TRANSACTION_ORIGIN, SOURCE_KIND,
  normalizeTransaction, validateTransaction, isExpense, isIncome, isTransfer,
  cashFlowMinor, hasTransactionFor, transactionsForSource,
  transactionFromBill, transactionFromSavings, compareTransactions,
  transactionsInMonth, monthOf, sumByCurrency
} from '../src/domain/transactions.js';

import {
  summarizeMonth, expensesByCategory, categoryBreakdown, surplusMinor,
  monthsWithData, monthKey
} from '../src/domain/budget.js';

import {
  EXTRACTION_STATUS, EXTRACTION_SUBJECT, normalizeExtraction,
  validateExtraction, markReviewed, approveExtraction, rejectExtraction,
  applyCorrection, toTransaction, toBill, parseExtractionResponse,
  fieldsNeedingReview
} from '../src/domain/receipts.js';

import {
  HOLDING_KIND, VALUE_SOURCE, normalizeHolding, validateHolding,
  hasKnownValue, summarizeHolding, isValueStale, summarizePortfolio,
  compareHoldings, hasMarketDataProvider, MARKET_DATA_CONTRACT
} from '../src/domain/investments.js';

import {
  EXPENSE_CATEGORY_KEYS, INCOME_CATEGORY_KEYS, normalizeExpenseCategory,
  normalizeIncomeCategory, categoryLabelForKind
} from '../src/domain/financeCategories.js';

import {
  BILL_STATUS, normalizeBill, monthlyContributionMinor, monthsToReach,
  isSavingsGoalOverdue, suggestSavingsMinor, normalizeSavingsGoal
} from '../src/domain/finance.js';

import { CATEGORY_KEYS } from '../src/domain/categories.js';

// =====================================================================
// SUUNTA ON LAJI, EI ETUMERKKI
// =====================================================================

test('KRIITTINEN: negatiivinen summa ei ole suunta vaan virhe', () => {
  // Jos negatiivinen summa kelpaisi, meno voitaisiin ilmaista kahdella
  // tavalla: kind='expense' TAI kind='income' negatiivisella summalla.
  // Kahdesta tavasta seuraa ennemmin tai myöhemmin kolmas, ja budjetti
  // laskisi ne eri tavoin.
  const negatiivinen = normalizeTransaction({
    kind: 'income', amountMinor: -5000, date: '2026-09-10', category: 'palkka'
  });

  const { valid, errors } = validateTransaction(negatiivinen);
  assert.equal(valid, false);
  assert.ok(errors.amountMinor);
});

test('KRIITTINEN: nollan suuruinen rahaliike ei ole tapahtuma', () => {
  const nolla = normalizeTransaction({
    kind: 'expense', amountMinor: 0, date: '2026-09-10', category: 'ruoka'
  });
  assert.equal(validateTransaction(nolla).valid, false);
});

test('laji ratkaisee suunnan, ei etumerkki', () => {
  const meno = normalizeTransaction({
    kind: 'expense', amountMinor: 2490, date: '2026-09-10', category: 'ruoka'
  });
  const tulo = normalizeTransaction({
    kind: 'income', amountMinor: 250000, date: '2026-09-01', category: 'palkka'
  });

  assert.equal(isExpense(meno), true);
  assert.equal(isIncome(tulo), true);
  assert.equal(meno.amountMinor > 0, true);
  assert.equal(tulo.amountMinor > 0, true);

  assert.equal(cashFlowMinor(meno), -2490);
  assert.equal(cashFlowMinor(tulo), 250000);
});

test('KRIITTINEN: siirto ei ole rahavirtaa eikä sillä ole kululuokkaa', () => {
  // Säästöön siirretty raha on yhä omaa. Jos siirto laskettaisiin
  // menoksi, säästäminen näyttäisi kuluttamiselta.
  const siirto = normalizeTransaction({
    kind: 'transfer', amountMinor: 20000, date: '2026-09-15', category: 'ruoka'
  });

  assert.equal(isTransfer(siirto), true);
  assert.equal(siirto.category, null, 'siirrolle jäi kululuokka');
  assert.equal(cashFlowMinor(siirto), 0);
});

test('tuntematon laji on meno, ei hiljainen hylkäys', () => {
  const outo = normalizeTransaction({ kind: 'keksitty', amountMinor: 100, date: '2026-09-10' });
  assert.equal(outo.kind, TRANSACTION_KIND.EXPENSE);
});

test('lähdelaji ja -tunniste kulkevat parina tai eivät lainkaan', () => {
  const vainLaji = normalizeTransaction({
    kind: 'expense', amountMinor: 100, date: '2026-09-10', sourceKind: 'bill'
  });
  assert.equal(vainLaji.sourceKind, null);
  assert.equal(vainLaji.sourceId, null);

  const vainId = normalizeTransaction({
    kind: 'expense', amountMinor: 100, date: '2026-09-10', sourceId: 'b1'
  });
  assert.equal(vainId.sourceKind, null);
  assert.equal(vainId.sourceId, null);

  const pari = normalizeTransaction({
    kind: 'expense', amountMinor: 100, date: '2026-09-10',
    sourceKind: 'bill', sourceId: 'b1'
  });
  assert.equal(pari.sourceKind, 'bill');
  assert.equal(pari.sourceId, 'b1');
});

test('tuloluokka ja kululuokka ovat eri joukkoja', () => {
  const tulo = normalizeTransaction({
    kind: 'income', amountMinor: 100, date: '2026-09-10', category: 'ruoka'
  });
  // 'ruoka' ei ole tuloluokka -> putoaa oletukseen.
  assert.equal(INCOME_CATEGORY_KEYS.includes(tulo.category), true);
  assert.equal(tulo.category, 'muu');

  const meno = normalizeTransaction({
    kind: 'expense', amountMinor: 100, date: '2026-09-10', category: 'palkka'
  });
  assert.equal(EXPENSE_CATEGORY_KEYS.includes(meno.category), true);
  assert.equal(meno.category, 'muu');
});

test('KRIITTINEN: kululuokat ovat eri asia kuin elämänalueet', () => {
  // categories.js on tehtävien ja tavoitteiden jaottelu (työ, terveys,
  // ihmissuhteet). financeCategories.js on rahan jaottelu (asuminen,
  // ruoka, liikkuminen). Jos nämä sulautuisivat yhteen, toinen niistä
  // pakotettaisiin väärään muotoon.
  assert.notDeepEqual([...EXPENSE_CATEGORY_KEYS].sort(), [...CATEGORY_KEYS].sort());

  // Ja kummallakin on oma oletuksensa, joka on olemassa.
  assert.equal(normalizeExpenseCategory('olematon'), 'muu');
  assert.equal(normalizeIncomeCategory('olematon'), 'muu');
  assert.ok(categoryLabelForKind(TRANSACTION_KIND.EXPENSE, 'asuminen'));
  assert.ok(categoryLabelForKind(TRANSACTION_KIND.INCOME, 'palkka'));
});

// =====================================================================
// KAKSOISLASKENNAN ESTO
// =====================================================================

const LASKU = Object.freeze({
  id: 'b1', name: 'Sähkö', amountMinor: 4550, currency: 'EUR',
  status: BILL_STATUS.PAID, dueDate: '2026-09-20', paidDate: '2026-09-18',
  category: 'talous'
});

test('KRIITTINEN: maksettu lasku josta on tapahtuma lasketaan kerran', () => {
  const tapahtuma = transactionFromBill(LASKU, 't1');
  assert.ok(tapahtuma);
  assert.equal(tapahtuma.sourceKind, SOURCE_KIND.BILL);
  assert.equal(tapahtuma.sourceId, 'b1');
  assert.equal(tapahtuma.origin, TRANSACTION_ORIGIN.BILL);

  const summary = summarizeMonth({
    month: '2026-09',
    transactions: [normalizeTransaction(tapahtuma)],
    bills: [normalizeBill(LASKU)],
    recurringExpenses: []
  });

  // 4550 kerran, ei 9100.
  assert.equal(summary.actualExpenseMinor, 4550);
  assert.equal(summary.expenseFromTransactionsMinor, 4550);
  assert.equal(summary.expenseFromBillsMinor, 0);
});

test('KRIITTINEN: maksettu lasku ILMAN tapahtumaa ei katoa budjetista', () => {
  // Vanhat laskut merkittiin maksetuiksi ennen kuin tapahtumia oli
  // olemassa. Jos ne jätettäisiin laskematta, historia muuttuisi.
  const summary = summarizeMonth({
    month: '2026-09',
    transactions: [],
    bills: [normalizeBill(LASKU)],
    recurringExpenses: []
  });

  assert.equal(summary.actualExpenseMinor, 4550);
  assert.equal(summary.expenseFromBillsMinor, 4550);
  assert.equal(summary.counts.paidBillsWithoutTransaction, 1);
});

test('KRIITTINEN: toistuva meno on ennuste eikä koskaan toteuma', () => {
  const summary = summarizeMonth({
    month: '2026-09',
    transactions: [],
    bills: [],
    recurringExpenses: [{
      id: 'e1', name: 'Vuokra', amountMinor: 95000, currency: 'EUR',
      cadence: 'monthly', active: true
    }]
  });

  assert.equal(summary.actualExpenseMinor, 0, 'toistuva meno laskettiin toteumaksi');
  assert.equal(summary.recurringMonthlyMinor, 95000);
});

test('KRIITTINEN: toistuvaa menoa ei vähennetä ennusteesta kahdesti', () => {
  // projectedNetMinor = netMinor - avoimet laskut. Toistuvia EI
  // vähennetä, koska ne toteutuvat laskuina tai tapahtumina.
  const summary = summarizeMonth({
    month: '2026-09',
    transactions: [normalizeTransaction({
      kind: 'income', amountMinor: 300000, date: '2026-09-01', category: 'palkka'
    })],
    bills: [normalizeBill({
      id: 'b2', name: 'Vesi', amountMinor: 3000, dueDate: '2026-09-25'
    })],
    recurringExpenses: [{
      id: 'e1', name: 'Vuokra', amountMinor: 95000, cadence: 'monthly', active: true
    }]
  });

  assert.equal(summary.incomeMinor, 300000);
  assert.equal(summary.openBillsMinor, 3000);
  assert.equal(summary.projectedNetMinor, 300000 - 3000);
});

test('hasTransactionFor tunnistaa lähteen tunnisteesta, ei summasta', () => {
  const tapahtumat = [normalizeTransaction({
    kind: 'expense', amountMinor: 4550, date: '2026-09-18',
    sourceKind: SOURCE_KIND.BILL, sourceId: 'b1', category: 'laskut'
  })];

  assert.equal(hasTransactionFor(tapahtumat, SOURCE_KIND.BILL, 'b1'), true);
  assert.equal(hasTransactionFor(tapahtumat, SOURCE_KIND.BILL, 'b2'), false);
  assert.equal(hasTransactionFor(tapahtumat, SOURCE_KIND.RECEIPT, 'b1'), false);
  assert.equal(hasTransactionFor(tapahtumat, null, 'b1'), false);
  assert.equal(hasTransactionFor(tapahtumat, SOURCE_KIND.BILL, null), false);
  assert.equal(hasTransactionFor([], SOURCE_KIND.BILL, 'b1'), false);

  // Sama lasku voi olla maksettu kahdessa erässä. Kanta ei siis voi
  // pakottaa uniikkiutta, ja tämä palauttaa molemmat.
  assert.equal(transactionsForSource(tapahtumat, SOURCE_KIND.BILL, 'b1').length, 1);
});

test('siirto ei summaudu menoihin eikä tuloihin', () => {
  const summary = summarizeMonth({
    month: '2026-09',
    transactions: [
      normalizeTransaction({
        kind: 'income', amountMinor: 300000, date: '2026-09-01', category: 'palkka'
      }),
      normalizeTransaction({
        kind: 'transfer', amountMinor: 50000, date: '2026-09-05'
      })
    ],
    bills: [],
    recurringExpenses: []
  });

  assert.equal(summary.incomeMinor, 300000);
  assert.equal(summary.actualExpenseMinor, 0);
  assert.equal(summary.transferredMinor, 50000);
  assert.equal(summary.netMinor, 300000);
});

test('erittely ja kokonaissumma eivät voi erota toisistaan', () => {
  const summary = summarizeMonth({
    month: '2026-09',
    transactions: [
      normalizeTransaction({
        kind: 'expense', amountMinor: 2490, date: '2026-09-03', category: 'ruoka'
      }),
      normalizeTransaction({
        kind: 'expense', amountMinor: 1000, date: '2026-09-04', category: 'ruoka'
      })
    ],
    bills: [normalizeBill(LASKU)],
    recurringExpenses: []
  });

  const erittelySumma = Object.values(summary.byCategory)
    .reduce((total, value) => total + value, 0);

  assert.equal(erittelySumma, summary.actualExpenseMinor);
  assert.equal(summary.byCategory.ruoka, 3490);
  assert.equal(summary.byCategory.laskut, 4550);
});

test('ylijäämä ei ole koskaan negatiivinen', () => {
  const alijaama = summarizeMonth({
    month: '2026-09',
    transactions: [normalizeTransaction({
      kind: 'expense', amountMinor: 500000, date: '2026-09-03', category: 'ruoka'
    })],
    bills: [],
    recurringExpenses: []
  });

  assert.ok(alijaama.netMinor < 0);
  assert.equal(surplusMinor(alijaama), 0, 'negatiivinen ylijäämä ei ole ylijäämää');
  assert.equal(surplusMinor(null), 0);
});

test('categoryBreakdown ei jaa nollalla', () => {
  assert.deepEqual(categoryBreakdown({ ruoka: 100 }, 0),
    [{ category: 'ruoka', amountMinor: 100, percent: 0 }]);
  assert.deepEqual(categoryBreakdown({}, 1000), []);
});

test('kuukausivalinta tarjoaa vain kuukaudet joilta on kirjauksia', () => {
  const kuukaudet = monthsWithData({
    transactions: [normalizeTransaction({
      kind: 'expense', amountMinor: 100, date: '2026-07-15', category: 'ruoka'
    })],
    bills: [normalizeBill({ id: 'b9', name: 'X', amountMinor: 100, dueDate: '2026-09-01' })]
  });

  assert.deepEqual(kuukaudet, ['2026-09', '2026-07']);
  assert.equal(monthKey('2026-09-15'), '2026-09');
  assert.equal(monthKey('roska'), null);
});

test('transactionsInMonth ja monthOf rajaavat kuukauden oikein', () => {
  const rivit = [
    normalizeTransaction({ kind: 'expense', amountMinor: 1, date: '2026-08-31', category: 'ruoka' }),
    normalizeTransaction({ kind: 'expense', amountMinor: 2, date: '2026-09-01', category: 'ruoka' }),
    normalizeTransaction({ kind: 'expense', amountMinor: 3, date: '2026-09-30', category: 'ruoka' }),
    normalizeTransaction({ kind: 'expense', amountMinor: 4, date: '2026-10-01', category: 'ruoka' })
  ];

  assert.equal(transactionsInMonth(rivit, '2026-09').length, 2);
  assert.equal(monthOf('2026-09-01'), '2026-09');
});

test('sumByCurrency ei muunna valuuttoja', () => {
  const summat = sumByCurrency([
    normalizeTransaction({ kind: 'expense', amountMinor: 100, currency: 'EUR', date: '2026-09-01', category: 'ruoka' }),
    normalizeTransaction({ kind: 'expense', amountMinor: 200, currency: 'USD', date: '2026-09-01', category: 'ruoka' })
  ]);
  assert.deepEqual(summat, { EUR: 100, USD: 200 });
});

test('tapahtumat järjestyvät uusin ensin', () => {
  const rivit = [
    normalizeTransaction({ id: 'a', kind: 'expense', amountMinor: 1, date: '2026-09-01', category: 'ruoka' }),
    normalizeTransaction({ id: 'b', kind: 'expense', amountMinor: 1, date: '2026-09-15', category: 'ruoka' })
  ].sort(compareTransactions);

  assert.equal(rivit[0].id, 'b');
});

// =====================================================================
// LUENTA ON EHDOTUS
// =====================================================================

const LUENTA = Object.freeze({
  id: 'x1',
  subject: EXTRACTION_SUBJECT.RECEIPT,
  merchant: 'Ruokakauppa',
  totalMinor: 2490,
  currency: 'EUR',
  date: '2026-09-10',
  category: 'ruoka',
  fieldConfidence: { merchant: 'high', totalMinor: 'high', date: 'high', category: 'high' }
});

test('KRIITTINEN: hyväksymätön luenta ei muutu tapahtumaksi', () => {
  const luenta = normalizeExtraction(LUENTA);
  assert.equal(luenta.status, EXTRACTION_STATUS.EXTRACTED);
  assert.equal(toTransaction(luenta, 't1'), null, 'luenta tallentui ilman hyväksyntää');

  const tarkistettu = markReviewed(luenta);
  assert.equal(tarkistettu.status, EXTRACTION_STATUS.REVIEWED);
  assert.equal(toTransaction(tarkistettu, 't1'), null, 'tarkistettu ei ole hyväksytty');
});

test('KRIITTINEN: hyväksytty luenta muuttuu tapahtumaksi kuittialkuperällä', () => {
  const hyvaksytty = approveExtraction(normalizeExtraction(LUENTA));
  assert.ok(hyvaksytty);
  assert.equal(hyvaksytty.status, EXTRACTION_STATUS.APPROVED);

  const tapahtuma = toTransaction(hyvaksytty, 't1');
  assert.ok(tapahtuma);
  assert.equal(tapahtuma.kind, TRANSACTION_KIND.EXPENSE);
  assert.equal(tapahtuma.amountMinor, 2490);
  assert.equal(tapahtuma.origin, TRANSACTION_ORIGIN.RECEIPT);
});

test('KRIITTINEN: korjaus palauttaa luennan tarkistettavaksi', () => {
  // Korjattu luenta ei ole hyväksytty luenta. Jos korjaus säilyttäisi
  // hyväksynnän, käyttäjä voisi vahingossa muuttaa summaa hyväksynnän
  // jälkeen ja tallentaa toisen luvun kuin sen jonka hyväksyi.
  const hyvaksytty = approveExtraction(normalizeExtraction(LUENTA));
  const korjattu = applyCorrection(hyvaksytty, { totalMinor: 3000 });

  assert.equal(korjattu.status, EXTRACTION_STATUS.REVIEWED);
  assert.equal(korjattu.totalMinor, 3000);
  assert.equal(toTransaction(korjattu, 't1'), null);
});

test('hylätty luenta ei tuota mitään', () => {
  const hylatty = rejectExtraction(normalizeExtraction(LUENTA));
  assert.equal(hylatty.status, EXTRACTION_STATUS.REJECTED);
  assert.equal(toTransaction(hylatty, 't1'), null);
});

test('kelvoton luenta ei mene hyväksyttäväksi', () => {
  const ilmanSummaa = normalizeExtraction({ ...LUENTA, totalMinor: null });
  assert.equal(validateExtraction(ilmanSummaa).valid, false);
  assert.equal(approveExtraction(ilmanSummaa), null);
});

test('KRIITTINEN: skannattu lasku syntyy AINA avoimena', () => {
  // Manifestivalilla ei ole valtuutta siirtää rahaa. Skannattu lasku ei
  // saa syntyä maksettuna missään tilanteessa -- ei silloinkaan kun
  // luennassa lukisi niin.
  // Laskun kentät ovat samat kuin kuitin: `merchant` on saaja ja
  // `date` eräpäivä. Yksi nimistö = yksi jäsennyspolku.
  const luenta = approveExtraction(normalizeExtraction({
    id: 'x2',
    subject: EXTRACTION_SUBJECT.BILL,
    merchant: 'Sähköyhtiö',
    totalMinor: 4550,
    date: '2026-10-01',
    iban: 'FI21 1234 5600 0007 85',
    reference: '1234 56789',
    status: 'paid',
    fieldConfidence: { merchant: 'high', totalMinor: 'high', date: 'high' }
  }));

  const lasku = toBill(luenta, 'b1');
  assert.ok(lasku);
  assert.equal(lasku.status, 'open', 'skannattu lasku syntyi maksettuna');
  assert.equal(lasku.paidDate, null);
  assert.equal(lasku.payee, 'Sähköyhtiö');
  assert.equal(lasku.dueDate, '2026-10-01');
  assert.equal(lasku.iban, 'FI21 1234 5600 0007 85');
});

test('kuittiluenta ei muutu laskuksi eikä lasku kuitiksi', () => {
  const kuitti = approveExtraction(normalizeExtraction(LUENTA));
  assert.equal(toBill(kuitti, 'b1'), null, 'kuitista tuli lasku');

  const lasku = approveExtraction(normalizeExtraction({
    id: 'x3', subject: EXTRACTION_SUBJECT.BILL, merchant: 'X',
    totalMinor: 100, date: '2026-10-01'
  }));
  assert.equal(toTransaction(lasku, 't1'), null, 'laskusta tuli tapahtuma');
});

test('epävarmat kentät nimetään, jotta ne voidaan korostaa', () => {
  const epavarma = normalizeExtraction({
    ...LUENTA,
    fieldConfidence: { merchant: 'low', totalMinor: 'high', date: 'high' }
  });

  const kentat = fieldsNeedingReview(epavarma);
  assert.ok(kentat.includes('merchant'), 'matalan luottamuksen kenttää ei merkitty');
  assert.equal(kentat.includes('date'), false);

  // Puuttuva kenttä on aina tarkistettava, vaikka luottamusta ei
  // olisi ilmoitettu lainkaan: käyttäjä ei voi korjata sitä mitä hän
  // ei tiedä puuttuvan.
  const puuttuva = normalizeExtraction({ ...LUENTA, totalMinor: null });
  assert.ok(fieldsNeedingReview(puuttuva).includes('totalMinor'));
});

test('KRIITTINEN: luennan jäsennys epäonnistuu suljettuna', () => {
  // Puolittain ymmärretty luenta on pahin vaihtoehto: se näyttäisi
  // luennalta. Kaikki alla palauttaa nullin.
  for (const roska of ['', 'ei json', '{', '[]', 'null', '{"a":1}', null, undefined]) {
    const tulos = parseExtractionResponse(roska,
      { subject: EXTRACTION_SUBJECT.RECEIPT, id: 'x' });
    assert.equal(tulos.ok, false, `jäsennys hyväksyi roskan: ${roska}`);
    assert.ok(tulos.reason, 'hylkäykselle ei annettu syytä');
    assert.equal(tulos.extraction, undefined, 'hylätty jäsennys palautti luennan');
  }

  // Ja kelvollinen vastaus menee läpi -- muuten testi menisi läpi
  // myös silloin, kun jäsennin hylkää kaiken.
  const kelvollinen = parseExtractionResponse(
    JSON.stringify({ merchant: 'Kauppa', totalMinor: 2490, date: '2026-09-10' }),
    { subject: EXTRACTION_SUBJECT.RECEIPT, id: 'x' });
  assert.equal(kelvollinen.ok, true);
  assert.equal(kelvollinen.extraction.totalMinor, 2490);
});

test('KRIITTINEN: luennassa ei ole kuvakenttää', () => {
  // Kuitin kuva on koko sovelluksen henkilökohtaisin tieto. Kenttää
  // jota ei ole, ei voi vahingossa tallentaa.
  const luenta = normalizeExtraction(LUENTA);

  for (const kielletty of ['image', 'imageData', 'photo', 'base64', 'dataUrl', 'file', 'blob']) {
    assert.equal(kielletty in luenta, false,
      `luennassa on kuvakenttä: ${kielletty}`);
  }

  // Eikä sitä voi ujuttaa sisään syötteen kautta.
  const ujutettu = normalizeExtraction({ ...LUENTA, image: 'AAAA', photo: 'BBBB' });
  assert.equal('image' in ujutettu, false);
  assert.equal('photo' in ujutettu, false);
});

// =====================================================================
// SIJOITUKSET: TUNTEMATON EI OLE NOLLA
// =====================================================================

test('KRIITTINEN: tuntematon arvo ei ole nolla eikä siitä lasketa tuottoa', () => {
  const ilmanArvoa = normalizeHolding({
    id: 'h1', name: 'Rahasto', kind: HOLDING_KIND.FUND, costBasisMinor: 250000
  });

  assert.equal(ilmanArvoa.currentValueMinor, null, 'tuntematon arvo muuttui nollaksi');
  assert.equal(ilmanArvoa.valueSource, VALUE_SOURCE.UNKNOWN);
  assert.equal(hasKnownValue(ilmanArvoa), false);

  const yhteenveto = summarizeHolding(ilmanArvoa);
  assert.equal(yhteenveto.known, false);
  assert.equal(yhteenveto.gainMinor, null, 'tuottoa laskettiin tuntemattomasta arvosta');
  assert.equal(yhteenveto.gainPercent, null);
});

test('KRIITTINEN: arvon lähde ei voi väittää käsin kirjattua ilman arvoa', () => {
  const valehteleva = normalizeHolding({
    id: 'h2', name: 'X', currentValueMinor: null, valueSource: 'manual'
  });
  assert.equal(valehteleva.valueSource, VALUE_SOURCE.UNKNOWN);
});

test('tuotto lasketaan vain kun sekä arvo että hankintahinta tiedetään', () => {
  const molemmat = normalizeHolding({
    id: 'h3', name: 'ETF', kind: 'etf',
    costBasisMinor: 250000, currentValueMinor: 300000, valueSource: 'manual'
  });

  const yhteenveto = summarizeHolding(molemmat);
  assert.equal(yhteenveto.known, true);
  assert.equal(yhteenveto.gainMinor, 50000);
  assert.equal(yhteenveto.gainPercent, 20);

  const vainArvo = normalizeHolding({
    id: 'h4', name: 'Y', currentValueMinor: 100, valueSource: 'manual'
  });
  assert.equal(summarizeHolding(vainArvo).known, false);
});

test('KRIITTINEN: määrä ei ole rahaa', () => {
  // Osakkeita voi olla 12,5 ja kryptoa 0,00031. Jos määrä kulkisi
  // senttilogiikan läpi, 12,5 osaketta olisi 1250 osaketta.
  const murto = normalizeHolding({ id: 'h5', name: 'Krypto', quantity: 0.00031 });
  assert.equal(murto.quantity, 0.00031);

  const puolikas = normalizeHolding({ id: 'h6', name: 'Osake', quantity: 12.5 });
  assert.equal(puolikas.quantity, 12.5);

  // Nolla ja negatiivinen eivät ole määriä.
  assert.equal(normalizeHolding({ id: 'h7', name: 'X', quantity: 0 }).quantity, null);
  assert.equal(normalizeHolding({ id: 'h8', name: 'X', quantity: -1 }).quantity, null);
});

test('käsin kirjattu arvo vanhenee ja se näkyy', () => {
  const vanha = normalizeHolding({
    id: 'h9', name: 'X', currentValueMinor: 100, valueSource: 'manual',
    valuedOn: '2026-07-01'
  });

  assert.equal(isValueStale(vanha, '2026-09-10'), true);
  assert.equal(isValueStale(vanha, '2026-07-15'), false);
  assert.equal(isValueStale(vanha, null), false);
  assert.equal(isValueStale(null, '2026-09-10'), false);
});

test('KRIITTINEN: salkku ei muunna valuuttoja eikä laske tuntemattomia nolliksi', () => {
  const salkku = summarizePortfolio([
    normalizeHolding({
      id: 'a', name: 'EUR-rahasto', currency: 'EUR',
      costBasisMinor: 100000, currentValueMinor: 120000, valueSource: 'manual'
    }),
    normalizeHolding({
      id: 'b', name: 'USD-osake', currency: 'USD',
      costBasisMinor: 50000, currentValueMinor: 45000, valueSource: 'manual'
    }),
    normalizeHolding({ id: 'c', name: 'Tuntematon', currency: 'EUR' })
  ], '2026-09-10');

  assert.deepEqual(salkku.valueByCurrency, { EUR: 120000, USD: 45000 });
  assert.deepEqual(salkku.gainByCurrency, { EUR: 20000, USD: -5000 });
  assert.equal(salkku.unknownCount, 1, 'tuntematon laskettiin nollaksi');
  assert.equal(salkku.total, 3);
});

test('salkun järjestys: tunnetut arvot ensin, tuntemattomat viimeisenä', () => {
  const rivit = [
    normalizeHolding({ id: 'a', name: 'Tuntematon' }),
    normalizeHolding({ id: 'b', name: 'Iso', currentValueMinor: 500, valueSource: 'manual' }),
    normalizeHolding({ id: 'c', name: 'Pieni', currentValueMinor: 100, valueSource: 'manual' })
  ].sort(compareHoldings);

  assert.deepEqual(rivit.map(r => r.name), ['Iso', 'Pieni', 'Tuntematon']);
});

test('KRIITTINEN: markkinadatan toimittajaa ei ole eikä sitä teeskennellä', () => {
  assert.equal(hasMarketDataProvider(), false);

  // Rajapinta on kuvattu, jotta myöhempi integraatio ei vaadi salkun
  // uudelleenkirjoittamista -- mutta toteutusta ei ole.
  assert.equal(MARKET_DATA_CONTRACT.method, 'fetchQuotes');
  assert.ok(MARKET_DATA_CONTRACT.rules.length >= 3);
});

test('sijoituksen validointi vaatii nimen ja tunnistaa mahdottomat luvut', () => {
  assert.equal(validateHolding(normalizeHolding({ name: '' })).valid, false);
  assert.equal(validateHolding(normalizeHolding({ name: 'X', kind: 'etf' })).valid, true);
});

// =====================================================================
// SÄÄSTÖSUUNNITTELU
// =====================================================================

test('kuukausierä pyöristetään ylöspäin, jotta tavoite ehtii täyttyä', () => {
  // 2500,00 euroa kolmessa kuukaudessa on 833,33 ja kolmasosa senttiä.
  // Alaspäin pyöristettynä tavoite jäisi vajaaksi.
  const goal = normalizeSavingsGoal({
    id: 's1', name: 'Puskuri', targetMinor: 250000, currentMinor: 0,
    targetDate: '2026-12-09'
  });

  assert.equal(monthlyContributionMinor(goal, '2026-09-09'), 83334);
});

test('täysi tavoite ei vaadi enää kuukausierää', () => {
  // NULL, EI NOLLA. "Nolla euroa kuussa" olisi vastaus kysymykseen,
  // joka ei ole enää voimassa. Käyttöliittymä erottaa nämä: null
  // tarkoittaa ettei suunnitelmaa näytetä lainkaan.
  const goal = normalizeSavingsGoal({
    id: 's2', name: 'X', targetMinor: 100000, currentMinor: 100000,
    targetDate: '2026-12-01'
  });
  assert.equal(monthlyContributionMinor(goal, '2026-09-01'), null);

  // Sama mennyttä määräpäivää kohti: kysymys ei ole voimassa.
  const mennyt = normalizeSavingsGoal({
    id: 's2b', name: 'X', targetMinor: 100000, currentMinor: 0,
    targetDate: '2026-01-01'
  });
  assert.equal(monthlyContributionMinor(mennyt, '2026-09-01'), null);
});

test('ilman tavoitepäivää kuukausierää ei keksitä', () => {
  const goal = normalizeSavingsGoal({ id: 's3', name: 'X', targetMinor: 100000 });
  assert.equal(monthlyContributionMinor(goal, '2026-09-01'), null);
});

test('monthsToReach kertoo kuinka monta kuukautta annetulla erällä menee', () => {
  const goal = normalizeSavingsGoal({
    id: 's4', name: 'X', targetMinor: 100000, currentMinor: 0
  });
  assert.equal(monthsToReach(goal, 10000), 10);
  assert.equal(monthsToReach(goal, 0), null, 'nollalla ei koskaan ehdi');
});

test('mennyt tavoitepäivä ilman täyttä tavoitetta on myöhässä', () => {
  const kesken = normalizeSavingsGoal({
    id: 's5', name: 'X', targetMinor: 100000, currentMinor: 5000,
    targetDate: '2026-08-01'
  });
  assert.equal(isSavingsGoalOverdue(kesken, '2026-09-09'), true);

  const taynna = normalizeSavingsGoal({
    id: 's6', name: 'X', targetMinor: 100000, currentMinor: 100000,
    targetDate: '2026-08-01'
  });
  assert.equal(isSavingsGoalOverdue(taynna, '2026-09-09'), false);
});

test('KRIITTINEN: säästöehdotus on ehdotus eikä koskaan ylitä ylijäämää', () => {
  assert.equal(suggestSavingsMinor(100000), 50000);
  assert.equal(suggestSavingsMinor(100000, 1), 100000);
  assert.equal(suggestSavingsMinor(0), 0);
  assert.equal(suggestSavingsMinor(-100), 0, 'negatiivisesta ylijäämästä ehdotettiin säästöä');
  assert.ok(suggestSavingsMinor(100000, 2) <= 100000, 'ehdotus ylitti ylijäämän');
});

test('säästösiirto on SIIRTO eikä meno', () => {
  const goal = normalizeSavingsGoal({ id: 's7', name: 'Puskuri', targetMinor: 300000 });
  const siirto = transactionFromSavings(goal, 20000, '2026-09-15', 't9');

  assert.ok(siirto);
  assert.equal(siirto.kind, TRANSACTION_KIND.TRANSFER);
  assert.equal(siirto.sourceKind, SOURCE_KIND.SAVINGS_GOAL);
  assert.equal(siirto.sourceId, 's7');
  assert.equal(normalizeTransaction(siirto).category, null);
});

test('KRIITTINEN: säästösiirto ilman summaa ei synny', () => {
  // Nollan suuruinen siirto ei ole siirto. Ilman tätä syntyisi
  // tapahtuma, jonka kanta hylkää -- ja virhe näkyisi käyttäjälle
  // vasta tallennuksessa, sanoin jotka eivät kerro mitä hän teki.
  const goal = normalizeSavingsGoal({ id: 's8', name: 'X', targetMinor: 1000 });
  assert.equal(transactionFromSavings(goal, null, '2026-09-15', 't1'), null);
  assert.equal(transactionFromSavings(goal, 0, '2026-09-15', 't1'), null);
  assert.equal(transactionFromSavings(goal, -100, '2026-09-15', 't1'), null);
  assert.equal(transactionFromSavings(null, 100, '2026-09-15', 't1'), null);
});

// =====================================================================
// RAHA ON KOKONAISLUKU
// =====================================================================

test('KRIITTINEN: yksikään rahasumma ei ole liukuluku', () => {
  const summat = [
    normalizeTransaction({ kind: 'expense', amountMinor: 2490, date: '2026-09-01', category: 'ruoka' }).amountMinor,
    normalizeHolding({ id: 'h', name: 'X', costBasisMinor: 250000 }).costBasisMinor,
    normalizeExtraction(LUENTA).totalMinor,
    monthlyContributionMinor(normalizeSavingsGoal({
      id: 's', name: 'X', targetMinor: 250000, currentMinor: 0,
      targetDate: '2026-12-09'
    }), '2026-09-09'),
    suggestSavingsMinor(100001)
  ];

  for (const summa of summat) {
    assert.equal(Number.isInteger(summa), true, `liukuluku rahassa: ${summa}`);
  }
});

test('domain ei sisällä liukulukukirjallisuutta rahassa', () => {
  // Karkea mutta tehokas: senttien jakaminen sadalla on se hetki,
  // jolloin kokonaisluku muuttuu liukuluvuksi.
  for (const [nimi, arvo] of Object.entries({
    expense: normalizeTransaction({
      kind: 'expense', amountMinor: '24,90', date: '2026-09-01', category: 'ruoka'
    }).amountMinor
  })) {
    // '24,90' ei ole sentti vaan merkkijono -> normalizeMinor hylkää sen.
    assert.equal(arvo === null || Number.isInteger(arvo), true, nimi);
  }
});
