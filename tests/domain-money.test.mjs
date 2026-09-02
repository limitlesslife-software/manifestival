// Rahan käsittelyn testit.
//
// Raha on se osa-alue, jossa hiljainen virhe maksaa eniten ja huomataan
// viimeisenä. Nämä testit ovat tarkoituksella yksityiskohtaisempia kuin
// muualla.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CURRENCY, MINOR_UNITS_PER_MAJOR, MAX_MINOR,
  normalizeCurrency, parseMoneyToMinor, normalizeMinor,
  formatMoney, formatMinorAsInput,
  sumByCurrency, hasMixedCurrencies, formatTotals,
  percentOf, remainingMinor
} from '../src/domain/money.js';

// ------------------------------------------------ liukulukujen välttäminen

test('KRIITTINEN: liukulukusumma ei kelpaa rahan totuudeksi', () => {
  // Tämä on koko moduulin olemassaolon syy. Testi dokumentoi ongelman,
  // jota vastaan koodi on kirjoitettu.
  assert.notEqual(0.1 + 0.2, 0.3, 'JS-liukuluku ei ole tarkka');

  // Kokonaislukuina sama lasku on täsmällinen.
  assert.equal(10 + 20, 30);
  assert.equal(parseMoneyToMinor('0.10') + parseMoneyToMinor('0.20'),
    parseMoneyToMinor('0.30'));
});

test('KRIITTINEN: sadan sentin summa on täsmälleen oikein', () => {
  // Liukuluvuilla tämä ajautuu sivuun; kokonaisluvuilla ei koskaan.
  let total = 0;
  for (let index = 0; index < 100; index++) total += parseMoneyToMinor('0.07');

  assert.equal(total, 700);
  assert.equal(Number.isInteger(total), true);
  assert.equal(formatMinorAsInput(total), '7.00');
});

test('summausjärjestys ei vaikuta lopputulokseen', () => {
  const amounts = ['0.05', '129.95', '0.01', '19.99', '1000.00'];
  const forward = amounts.reduce((sum, a) => sum + parseMoneyToMinor(a), 0);
  const backward = [...amounts].reverse().reduce((sum, a) => sum + parseMoneyToMinor(a), 0);

  assert.equal(forward, backward);
  assert.equal(Number.isInteger(forward), true);
});

// ------------------------------------------------------------- jäsennys

test('euromäärä muuttuu sentteinä kokonaisluvuksi', () => {
  assert.equal(parseMoneyToMinor('129.95'), 12995);
  assert.equal(parseMoneyToMinor('0.01'), 1);
  assert.equal(parseMoneyToMinor('0'), 0);
  assert.equal(parseMoneyToMinor('1000'), 100000);
  assert.equal(parseMoneyToMinor(129.95), 12995);
});

test('suomalainen pilkku kelpaa desimaalierottimena', () => {
  // Käyttäjä kirjoittaa "129,95", numeronäppäimistö tuottaa "129.95".
  assert.equal(parseMoneyToMinor('129,95'), parseMoneyToMinor('129.95'));
  assert.equal(parseMoneyToMinor('0,50'), 50);
});

test('tuhaterottimet siedetään', () => {
  assert.equal(parseMoneyToMinor('1 000,00'), 100000);
  assert.equal(parseMoneyToMinor('1 000,00'), 100000, 'sitomaton välilyönti');
});

test('yksi desimaali täydentyy oikein', () => {
  assert.equal(parseMoneyToMinor('5.5'), 550);
  assert.equal(parseMoneyToMinor('5,5'), 550);
});

test('kelvoton syöte hylätään eikä muutu nollaksi', () => {
  // Nolla olisi vaarallisin mahdollinen tulkinta: 0 € lasku näyttäisi
  // kirjatulta ja maksetulta.
  for (const bad of [null, undefined, '', '  ', 'paljon', 'abc', '-5', '1.234',
    NaN, Infinity, -1, {}, [], true]) {
    assert.equal(parseMoneyToMinor(bad), null, JSON.stringify(bad));
  }
});

test('järjetön summa hylätään kirjoitusvirheenä', () => {
  assert.equal(parseMoneyToMinor(MAX_MINOR / 100 + 1), null);
  assert.equal(parseMoneyToMinor(MAX_MINOR / 100), MAX_MINOR);
});

test('normalizeMinor hyväksyy vain kokonaislukusentit', () => {
  assert.equal(normalizeMinor(12995), 12995);
  assert.equal(normalizeMinor('12995'), 12995);
  assert.equal(normalizeMinor(129.6), 130, 'murto-osasentti pyöristyy');
  assert.equal(normalizeMinor(-1), null);
  assert.equal(normalizeMinor(null), null);
  assert.equal(normalizeMinor('roskaa'), null);
});

// ------------------------------------------------------------- valuutta

test('valuuttakoodi normalisoidaan', () => {
  assert.equal(normalizeCurrency('eur'), 'EUR');
  assert.equal(normalizeCurrency('  usd '), 'USD');
  assert.equal(normalizeCurrency('EUR'), 'EUR');
});

test('kelvoton valuutta putoaa oletukseen eikä kaada mitään', () => {
  for (const bad of ['E', 'EUROA', '123', '', null, undefined, 42]) {
    assert.equal(normalizeCurrency(bad), DEFAULT_CURRENCY, JSON.stringify(bad));
  }
});

// -------------------------------------------------------------- summaus

test('summaus tapahtuu valuutan sisällä', () => {
  const totals = sumByCurrency([
    { amountMinor: 1000, currency: 'EUR' },
    { amountMinor: 2500, currency: 'EUR' },
    { amountMinor: 900, currency: 'USD' }
  ]);

  assert.deepEqual(totals, { EUR: 3500, USD: 900 });
});

test('KRIITTINEN: eri valuuttoja ei koskaan lasketa yhteen', () => {
  // 10 EUR + 10 USD ei ole 20 mitään. Kurssia ei ole eikä sitä haeta.
  const items = [
    { amountMinor: 1000, currency: 'EUR' },
    { amountMinor: 1000, currency: 'USD' }
  ];

  const totals = sumByCurrency(items);
  assert.equal(Object.keys(totals).length, 2);
  assert.equal(hasMixedCurrencies(items), true);

  // Yhtä yhteenlaskettua lukua ei ole olemassa missään muodossa.
  assert.equal(typeof totals, 'object');
  assert.equal(Array.isArray(totals), false);
});

test('yhden valuutan joukko ei ole sekavaluuttainen', () => {
  assert.equal(hasMixedCurrencies([
    { amountMinor: 100, currency: 'EUR' },
    { amountMinor: 200, currency: 'EUR' }
  ]), false);
  assert.equal(hasMixedCurrencies([]), false);
});

test('kelvottomat rivit ohitetaan summauksessa', () => {
  const totals = sumByCurrency([
    { amountMinor: 1000, currency: 'EUR' },
    { amountMinor: null, currency: 'EUR' },
    { amountMinor: 'roskaa', currency: 'EUR' },
    null,
    undefined
  ]);
  assert.deepEqual(totals, { EUR: 1000 });
});

test('tyhjä summaus on tyhjä olio eikä nolla', () => {
  assert.deepEqual(sumByCurrency([]), {});
  assert.deepEqual(sumByCurrency(), {});
});

test('valuuttakohtaiset summat muotoillaan erikseen', () => {
  const formatted = formatTotals({ EUR: 3500, USD: 900 });
  assert.equal(formatted.length, 2);
  assert.ok(formatted.every(text => typeof text === 'string' && text.length > 0));
});

// ------------------------------------------------------------ muotoilu

test('summa muotoillaan suomalaisittain', () => {
  const text = formatMoney(12995, 'EUR');
  assert.match(text, /129/);
  assert.match(text, /95/);
  assert.match(text, /€/);
});

test('nolla muotoillaan, tyhjä ei', () => {
  assert.match(formatMoney(0, 'EUR'), /0/);
  assert.equal(formatMoney(null), '');
  assert.equal(formatMoney(undefined), '');
  assert.equal(formatMoney('roskaa'), '');
});

test('tuntematon valuutta ei kaada muotoilua', () => {
  // Intl heittää tuntemattomasta koodista. Tyhjä kenttä olisi käyttäjälle
  // pahempi kuin karu muotoilu, joten virhe napataan.
  const text = formatMoney(1000, 'XYZ');
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0);
});

test('syöttökentän muotoilu on aina kaksi desimaalia', () => {
  assert.equal(formatMinorAsInput(12995), '129.95');
  assert.equal(formatMinorAsInput(5), '0.05');
  assert.equal(formatMinorAsInput(100), '1.00');
  assert.equal(formatMinorAsInput(null), '');
});

test('muotoilun ja jäsennyksen kierros säilyttää arvon', () => {
  for (const minor of [0, 1, 5, 99, 100, 12995, 100000, 999999]) {
    assert.equal(parseMoneyToMinor(formatMinorAsInput(minor)), minor, String(minor));
  }
});

// -------------------------------------------------------------- osuudet

test('osuus on kokonaisluku välillä 0-100', () => {
  assert.equal(percentOf(0, 10000), 0);
  assert.equal(percentOf(5000, 10000), 50);
  assert.equal(percentOf(10000, 10000), 100);
  assert.equal(percentOf(3333, 10000), 33);
});

test('ylitys ei tuota yli sataa prosenttia', () => {
  assert.equal(percentOf(20000, 10000), 100);
});

test('nollatavoite ei jaa nollalla', () => {
  assert.equal(percentOf(5000, 0), 0);
  assert.equal(percentOf(5000, null), 0);
  assert.equal(Number.isNaN(percentOf(5000, 0)), false);
});

test('puuttuva osuus ei ole koskaan negatiivinen', () => {
  assert.equal(remainingMinor(3000, 10000), 7000);
  assert.equal(remainingMinor(10000, 10000), 0);
  assert.equal(remainingMinor(20000, 10000), 0, 'ylitys ei ole velkaa');
  assert.equal(remainingMinor(null, 10000), 10000);
});

test('minor-yksikkö on dokumentoitu vakiona', () => {
  assert.equal(MINOR_UNITS_PER_MAJOR, 100);
  assert.equal(parseMoneyToMinor('1.00'), MINOR_UNITS_PER_MAJOR);
});
