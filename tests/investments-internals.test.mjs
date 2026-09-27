// Sijoitusten sisäinen laskenta: salkun tuoton populaatiokorjaus,
// yksikköhinta, tavoitearvo, käyttäjän omat rajat ja markkinahintojen raja.
//
// PERIAATE: hintaa ei keksitä. Tuntematon arvo ei ole nolla, eikä
// hintapalvelun puuttuminen tuota lukua.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeHolding, summarizeHolding, summarizePortfolio, hasKnownValue, unitPrice, targetComparison,
  evaluateUserAlerts, normalizeUserAlert, validateUserAlert, ALERT_KIND, ALERT_STATUS, STALE_AFTER_DAYS,
  hasMarketDataProvider, MARKET_DATA_CONTRACT
} from '../src/domain/investments.js';
import {
  quoteFor, quotesFor, marketDataAvailability, normalizeProviderQuote, normalizeSymbol,
  QUOTE_STATUS, QUOTE_REASON
} from '../src/domain/marketData.js';
import { formatTotals } from '../src/domain/money.js';
import { readCode } from './helpers/sources.mjs';

const TODAY = '2026-09-26';
const holding = (overrides = {}) => normalizeHolding({
  id: 'h1', name: 'Rahasto', kind: 'fund', currency: 'EUR', valueSource: 'manual', valuedOn: '2026-09-20', ...overrides
});

const ADVICE = /\bosta|\bmyy|suosit|kannattaa|neuvo|pitäisi|kannattaisi/i;

// ================================================================ SALKKU

test('KORJAUS: salkun tuotto lasketaan vain omistuksista, joilla on sekä arvo että hankintahinta', () => {
  // Kartoituksen esimerkki: [{hinta 100000, arvo 120000}, {hinta 50000, arvo tuntematon}]
  // antoi ennen tuotoksi -30000. Oikein on +20000.
  const portfolio = summarizePortfolio([
    holding({ id: 'a', costBasisMinor: 100000, currentValueMinor: 120000 }),
    holding({ id: 'b', costBasisMinor: 50000, currentValueMinor: null })
  ], TODAY);
  assert.deepEqual({ ...portfolio.gainByCurrency }, { EUR: 20000 });
  assert.equal(portfolio.gainPercentByCurrency.EUR, 20);
  assert.equal(portfolio.gainKnownCount, 1);
  // Näytettävät kokonaissummat pysyvät ennallaan.
  assert.deepEqual({ ...portfolio.valueByCurrency }, { EUR: 120000 });
  assert.deepEqual({ ...portfolio.costByCurrency }, { EUR: 150000 });
  assert.equal(portfolio.unknownCount, 1);
});

test('KORJAUS: arvo ilman hankintahintaa ei kasvata tuottoa', () => {
  const portfolio = summarizePortfolio([
    holding({ id: 'a', costBasisMinor: 100000, currentValueMinor: 90000 }),
    holding({ id: 'b', costBasisMinor: null, currentValueMinor: 70000 })
  ], TODAY);
  assert.deepEqual({ ...portfolio.gainByCurrency }, { EUR: -10000 }, 'ennen korjausta +60000');
  assert.deepEqual({ ...portfolio.valueByCurrency }, { EUR: 160000 });
  assert.match(formatTotals(portfolio.gainByCurrency)[0], /100,00/, 'tappio näkyy muotoiltuna, ei tyhjänä');
});

test('salkku: valuutat pidetään erillään, tuototon valuutta puuttuu tuotoista', () => {
  const portfolio = summarizePortfolio([
    holding({ id: 'a', currency: 'EUR', costBasisMinor: 1000, currentValueMinor: 1500 }),
    holding({ id: 'b', currency: 'USD', costBasisMinor: null, currentValueMinor: 700 }),
    holding({ id: 'c', currency: 'SEK', costBasisMinor: 0, currentValueMinor: 300 })
  ], TODAY);
  assert.deepEqual({ ...portfolio.gainByCurrency }, { EUR: 500, SEK: 300 });
  assert.equal(portfolio.gainPercentByCurrency.SEK, null, 'nollahinnasta ei lasketa prosenttia');
  assert.equal('USD' in portfolio.gainByCurrency, false);
  assert.deepEqual({ ...portfolio.valueByCurrency }, { EUR: 1500, USD: 700, SEK: 300 });
});

test('salkku: vanhentuneet merkitään ilman syötteen muuttamista, tulos on jäädytetty', () => {
  const list = Object.freeze([
    Object.freeze(holding({ id: 'a', valuedOn: '2026-07-01', currentValueMinor: 5, costBasisMinor: 4 })),
    Object.freeze(holding({ id: 'b', valuedOn: TODAY, currentValueMinor: 5 }))
  ]);
  const before = JSON.stringify(list);
  const portfolio = summarizePortfolio(list, TODAY);
  assert.equal(portfolio.staleCount, 1);
  assert.equal(portfolio.holdings[0].stale, true);
  assert.equal(portfolio.holdings[1].stale, false);
  assert.equal(JSON.stringify(list), before);
  assert.ok(Object.isFrozen(portfolio) && Object.isFrozen(portfolio.holdings) && Object.isFrozen(portfolio.gainByCurrency));
  assert.ok(Object.isFrozen(summarizeHolding(list[0])));
});

test('salkku: roska ei kaada, puuttuva arvo ei ole tunnettu (ei NaN-summia)', () => {
  for (const bad of [undefined, null, 'x', 5, [null, 'x', 7], [{}], [{ currentValueMinor: undefined, costBasisMinor: 'x' }]]) {
    assert.doesNotThrow(() => summarizePortfolio(bad, TODAY));
  }
  const raw = summarizePortfolio([{ id: 'r', currency: 'EUR' }], TODAY);
  assert.equal(raw.unknownCount, 1);
  assert.deepEqual({ ...raw.valueByCurrency }, {});
  assert.equal(hasKnownValue({ currentValueMinor: undefined }), false);
  assert.equal(hasKnownValue({ currentValueMinor: -5 }), false);
  assert.equal(hasKnownValue({ currentValueMinor: 0 }), true, 'nolla-arvo on tieto');
});

// ================================================================ YKSIKKÖHINTA

test('yksikköhinta: arvo ja hankintahinta jaettuna määrällä, sentteinä', () => {
  const price = unitPrice(holding({ quantity: 12.5, currentValueMinor: 100000, costBasisMinor: 87500 }));
  assert.equal(price.currentMinor, 8000);
  assert.equal(price.costMinor, 7000);
  assert.equal(price.currency, 'EUR');
  assert.equal(price.subCent, false);
  assert.ok(Object.isFrozen(price));
  const crypto = unitPrice(holding({ quantity: 0.00031, currentValueMinor: 1000 }));
  assert.equal(crypto.currentMinor, 3225806);
  assert.equal(crypto.costMinor, null, 'tuntematon hankintahinta pysyy tuntemattomana');
});

test('yksikköhinta: ilman määrää tai summia null, alle sentin ei ole nolla', () => {
  assert.equal(unitPrice(holding({ quantity: null, currentValueMinor: 1000 })), null);
  assert.equal(unitPrice(holding({ quantity: 5 })), null);
  const tiny = unitPrice(holding({ quantity: 1e6, currentValueMinor: 100, costBasisMinor: 1e9 }));
  assert.equal(tiny.currentMinor, null);
  assert.equal(tiny.subCent, true);
  assert.equal(tiny.costMinor, 1000);
  assert.equal(unitPrice({ quantity: 1e-12, currentValueMinor: 1e9 }), null, 'ylivuoto ei tuota lukua');
  for (const bad of [undefined, null, 'x', { quantity: '5', currentValueMinor: 5 }, { quantity: -1, currentValueMinor: 5 }]) {
    assert.equal(unitPrice(bad), null);
  }
});

// ================================================================ TAVOITEARVO

test('tavoitearvo: osuus, erotus ja saavutettu', () => {
  const below = targetComparison(holding({ currentValueMinor: 85000, targetValueMinor: 100000 }), TODAY);
  assert.equal(below.percentOfTarget, 85);
  assert.equal(below.differenceMinor, 15000);
  assert.equal(below.reached, false);
  assert.match(below.text, /^Arvo on 85 % tavoitearvostasi 1\s000,00/);
  const at = targetComparison(holding({ currentValueMinor: 100000, targetValueMinor: 100000 }), TODAY);
  assert.equal(at.reached, true, 'raja on sisältävä');
  assert.equal(at.differenceMinor, 0);
  const above = targetComparison(holding({ currentValueMinor: 120000, targetValueMinor: 100000 }), TODAY);
  assert.equal(above.percentOfTarget, 120);
  assert.equal(above.differenceMinor, -20000);
  assert.ok(Object.isFrozen(above));
});

test('tavoitearvo: tuntematon arvo tai tavoite -> null; vanha arvo sanotaan', () => {
  assert.equal(targetComparison(holding({ currentValueMinor: null, targetValueMinor: 100 }), TODAY), null);
  assert.equal(targetComparison(holding({ currentValueMinor: 100, targetValueMinor: null }), TODAY), null);
  assert.equal(targetComparison(holding({ currentValueMinor: 100, targetValueMinor: 0 }), TODAY), null);
  assert.equal(targetComparison(null), null);
  const stale = targetComparison(holding({ currentValueMinor: 50, targetValueMinor: 100, valuedOn: '2026-08-01' }), TODAY);
  assert.equal(stale.stale, true);
  assert.match(stale.text, new RegExp(`yli ${STALE_AFTER_DAYS} päivää sitten`));
});

// ================================================================ OMAT RAJAT

const HOLDINGS = [
  holding({ id: 'eur', name: 'Indeksi', currentValueMinor: 120000, costBasisMinor: 100000, targetValueMinor: 150000 }),
  holding({ id: 'usd', name: 'Osake', currency: 'USD', currentValueMinor: 5000, costBasisMinor: 8000 }),
  holding({ id: 'none', name: 'Tuntematon', currentValueMinor: null, costBasisMinor: 1000 })
];

test('omat rajat: arvo- ja tuottorajat ovat sisältäviä', () => {
  const alerts = [
    { id: 'a1', holdingId: 'eur', kind: ALERT_KIND.VALUE_AT_OR_ABOVE, thresholdMinor: 120000 },
    { id: 'a2', holdingId: 'eur', kind: ALERT_KIND.VALUE_AT_OR_BELOW, thresholdMinor: 119999 },
    { id: 'a3', holdingId: 'eur', kind: ALERT_KIND.GAIN_PERCENT_AT_OR_ABOVE, thresholdPercent: 20 },
    { id: 'a4', holdingId: 'usd', kind: ALERT_KIND.GAIN_PERCENT_AT_OR_BELOW, thresholdPercent: -37.5 },
    { id: 'a5', holdingId: 'usd', kind: ALERT_KIND.GAIN_PERCENT_AT_OR_BELOW, thresholdPercent: -37.6 }
  ];
  const results = Object.fromEntries(evaluateUserAlerts(HOLDINGS, alerts, TODAY).map(r => [r.alertId, r]));
  assert.equal(results.a1.status, ALERT_STATUS.TRIGGERED);
  assert.match(results.a1.text, /on vähintään asettamasi raja/);
  assert.equal(results.a2.status, ALERT_STATUS.NOT_TRIGGERED);
  assert.equal(results.a2.triggered, false);
  assert.equal(results.a3.status, ALERT_STATUS.TRIGGERED);
  assert.equal(results.a3.observed, 20);
  assert.equal(results.a4.status, ALERT_STATUS.TRIGGERED);
  assert.match(results.a4.text, /-37,5 %/);
  assert.equal(results.a5.status, ALERT_STATUS.NOT_TRIGGERED);
});

test('omat rajat: tuntematon ei ole "ei lauennut"', () => {
  const alerts = [
    { id: 'u1', holdingId: 'none', kind: ALERT_KIND.VALUE_AT_OR_BELOW, thresholdMinor: 1000000 },
    { id: 'u2', holdingId: 'none', kind: ALERT_KIND.GAIN_PERCENT_AT_OR_BELOW, thresholdPercent: 0 },
    { id: 'u3', holdingId: 'poistettu', kind: ALERT_KIND.VALUE_AT_OR_ABOVE, thresholdMinor: 1 },
    { id: 'u4', holdingId: 'usd', kind: ALERT_KIND.VALUE_AT_OR_ABOVE, thresholdMinor: 1, currency: 'EUR' },
    { id: 'u5', holdingId: 'usd', kind: ALERT_KIND.TARGET_REACHED },
    { id: 'u6', holdingId: 'eur', kind: ALERT_KIND.VALUE_AT_OR_ABOVE, thresholdMinor: null },
    { id: 'u7', holdingId: 'eur', kind: 'moon' }
  ];
  const results = Object.fromEntries(evaluateUserAlerts(HOLDINGS, alerts, TODAY).map(r => [r.alertId, r]));
  const reasons = Object.fromEntries(Object.entries(results).map(([id, r]) => [id, r.reason]));
  assert.deepEqual(reasons, {
    u1: 'no_value', u2: 'no_gain', u3: 'holding_missing', u4: 'currency', u5: 'no_target', u6: 'no_threshold', u7: 'invalid_alert'
  });
  for (const r of Object.values(results)) {
    assert.equal(r.status, ALERT_STATUS.UNKNOWN);
    assert.equal(r.triggered, null);
    assert.equal(r.observed, null);
  }
});

test('omat rajat: tavoitearvo, pois päältä olevat ohitetaan, järjestys on vakaa', () => {
  const alerts = [
    { id: 'z', holdingId: 'eur', kind: ALERT_KIND.TARGET_REACHED },
    { id: 'off', holdingId: 'eur', kind: ALERT_KIND.VALUE_AT_OR_ABOVE, thresholdMinor: 1, active: false },
    { id: 'b', holdingId: 'usd', kind: ALERT_KIND.VALUE_AT_OR_ABOVE, thresholdMinor: 1 },
    { id: 'c', holdingId: 'none', kind: ALERT_KIND.VALUE_AT_OR_ABOVE, thresholdMinor: 1 }
  ];
  const results = evaluateUserAlerts(HOLDINGS, alerts, TODAY);
  assert.deepEqual(results.map(r => r.alertId), ['b', 'c', 'z'], 'lauenneet, tuntemattomat, muut');
  assert.match(results[2].text, /80 % tavoitearvosta/);
  const reversed = evaluateUserAlerts([...HOLDINGS].reverse(), [...alerts].reverse(), TODAY);
  assert.deepEqual(reversed, results);
  assert.ok(Object.isFrozen(results) && results.every(Object.isFrozen));
});

test('omat rajat: vanhentunut arvo kerrotaan, normalisointi ja validointi', () => {
  const old = [holding({ id: 'old', name: 'Vanha', currentValueMinor: 500, valuedOn: '2026-01-01' })];
  const [r] = evaluateUserAlerts(old, [{ id: 's', holdingId: 'old', kind: ALERT_KIND.VALUE_AT_OR_ABOVE, thresholdMinor: 100 }], TODAY);
  assert.equal(r.stale, true);
  assert.match(r.text, /yli 30 päivää sitten/);
  const n = normalizeUserAlert({ id: 1, holdingId: 2, kind: ALERT_KIND.GAIN_PERCENT_AT_OR_ABOVE, thresholdPercent: '12.34', thresholdMinor: 5 });
  assert.equal(n.thresholdPercent, 12.3);
  assert.equal(n.thresholdMinor, null, 'prosenttirajalla ei ole summaa');
  assert.equal(validateUserAlert({ holdingId: 'x', kind: ALERT_KIND.VALUE_AT_OR_ABOVE }).valid, false);
  assert.match(validateUserAlert({ kind: 'x' }).errors.kind, /Valitse/);
  assert.equal(validateUserAlert({ holdingId: 'x', kind: ALERT_KIND.TARGET_REACHED }).valid, true);
  for (const bad of [undefined, null, 'x', [], [null, 5, 'x', {}]]) {
    assert.doesNotThrow(() => evaluateUserAlerts(bad, bad, bad));
    assert.doesNotThrow(() => normalizeUserAlert(bad));
    assert.doesNotThrow(() => validateUserAlert(bad));
  }
});

test('SÄVY: rajat ja tavoitteet eivät neuvo ostamaan tai myymään', () => {
  const texts = [];
  for (const kind of Object.values(ALERT_KIND)) {
    for (const h of HOLDINGS) {
      for (const threshold of [1, 1e9]) {
        const [r] = evaluateUserAlerts(HOLDINGS, [{ id: 'x', holdingId: h.id, kind, thresholdMinor: threshold, thresholdPercent: threshold }], TODAY);
        texts.push(r.text);
      }
    }
  }
  texts.push(targetComparison(HOLDINGS[0], TODAY).text, marketDataAvailability().text);
  for (const text of texts) assert.doesNotMatch(text, ADVICE, text);
});

// ================================================================ MARKKINAHINNAT

test('KRIITTINEN: hintapalvelua ei ole, eikä rajapinta keksi hintaa', () => {
  assert.equal(hasMarketDataProvider(), false);
  assert.equal(MARKET_DATA_CONTRACT.method, 'fetchQuotes');
  const availability = marketDataAvailability();
  assert.equal(availability.available, false);
  assert.equal(availability.reason, QUOTE_REASON.BLOCKED_EXTERNAL_PROVIDER);
  assert.equal(availability.reason, 'BLOCKED_EXTERNAL_PROVIDER');
  const quote = quoteFor('aapl ');
  assert.equal(quote.symbol, 'AAPL');
  assert.equal(quote.status, QUOTE_STATUS.UNKNOWN);
  assert.equal(quote.reason, 'BLOCKED_EXTERNAL_PROVIDER');
  assert.equal(quote.valueMinor, null, 'tuntematon hinta ei ole nolla');
  assert.equal(quote.asOf, null);
  assert.ok(Object.isFrozen(quote));
});

test('markkinahinnat: usean symbolin kysely, kelpaamattomat ja kaksoiskappaleet pois', () => {
  const quotes = quotesFor(['NOKIA', 'nokia', ' ', null, 5, 'BRK.B', 'x'.repeat(21), 'constructor', '__proto__']);
  assert.deepEqual(Object.keys(quotes), ['NOKIA', 'BRK.B', 'CONSTRUCTOR']);
  assert.ok(Object.values(quotes).every(q => q.status === 'unknown' && q.valueMinor === null));
  assert.equal(Object.getPrototypeOf(quotes), Object.prototype);
  assert.deepEqual(quotesFor('x'), {});
  assert.equal(Object.keys(quotesFor(Array.from({ length: 500 }, (_, i) => `S${i}`))).length, 200);
  assert.equal(quoteFor('').reason, QUOTE_REASON.INVALID_SYMBOL);
  assert.equal(normalizeSymbol('ok symbol'), null);
});

test('markkinahinnat: tulevan toimittajan vastaus tarkistetaan sopimusta vasten', () => {
  const ctx = { symbol: 'NOKIA', todayIso: TODAY };
  const ok = normalizeProviderQuote({ valueMinor: 412, currency: 'eur', asOf: '2026-09-25T16:00:00Z' }, ctx);
  assert.equal(ok.status, QUOTE_STATUS.KNOWN);
  assert.equal(ok.valueMinor, 412);
  assert.equal(ok.currency, 'EUR');
  assert.equal(ok.asOf, '2026-09-25');
  const cases = [
    [{ valueMinor: 0, currency: 'EUR', asOf: TODAY }, QUOTE_REASON.INVALID_VALUE],
    [{ valueMinor: 4.12, currency: 'EUR', asOf: TODAY }, QUOTE_REASON.INVALID_VALUE],
    [{ valueMinor: -1, currency: 'EUR', asOf: TODAY }, QUOTE_REASON.INVALID_VALUE],
    [{ valueMinor: '412', currency: 'EUR', asOf: TODAY }, QUOTE_REASON.INVALID_VALUE],
    [{ valueMinor: 412, currency: 'euro', asOf: TODAY }, QUOTE_REASON.INVALID_VALUE],
    [{ valueMinor: 412, currency: 'EUR' }, QUOTE_REASON.MISSING_AS_OF],
    [{ valueMinor: 412, currency: 'EUR', asOf: '2026-02-30' }, QUOTE_REASON.MISSING_AS_OF],
    [{ valueMinor: 412, currency: 'EUR', asOf: '2026-09-27' }, QUOTE_REASON.FUTURE_AS_OF],
    [null, QUOTE_REASON.INVALID_VALUE]
  ];
  for (const [raw, reason] of cases) {
    const q = normalizeProviderQuote(raw, ctx);
    assert.equal(q.status, QUOTE_STATUS.UNKNOWN, JSON.stringify(raw));
    assert.equal(q.reason, reason, JSON.stringify(raw));
    assert.equal(q.valueMinor, null);
  }
  assert.equal(normalizeProviderQuote({ valueMinor: 1, currency: 'EUR', asOf: TODAY }, null).reason, QUOTE_REASON.INVALID_SYMBOL);
});

test('markkinahinnat: moduuli ei tee verkkokutsuja eikä tuo sivuvaikutuksellisia kerroksia', () => {
  const code = readCode('src/domain/marketData.js');
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'http://', 'https://', 'Date.now(', 'new Date()', 'Math.random']) {
    assert.equal(code.includes(forbidden), false, forbidden);
  }
  const imports = [...code.matchAll(/from '([^']+)'/g)].map(m => m[1]);
  assert.ok(imports.every(path => path.startsWith('./')), imports.join(', '));
});
