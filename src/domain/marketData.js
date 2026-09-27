// Markkinahintojen raja (provider boundary).
//
// PUHDAS MODUULI: ei verkkoa, ei kelloa. Tämä EI hae mitään.
//
// =====================================================================
// HINTAA EI KEKSITÄ — MYÖSKÄÄN RAJAPINNASSA
// =====================================================================
//
// Manifestivalilla ei ole markkinadatan toimittajaa (investments.js:
// hasMarketDataProvider() === false). Tämä moduuli on se yksi paikka,
// josta muu sovellus kysyy "mikä on tämän symbolin hinta?", ja vastaus
// on aina rehellinen:
//
//   status 'unknown', syy 'BLOCKED_EXTERNAL_PROVIDER', valueMinor null
//
// Ei nollaa, ei edellistä arvoa, ei arviota. Käyttöliittymä voi näyttää
// "hintatietoa ei haeta — kirjaa arvo itse", ja salkku toimii käsin
// kirjatuilla arvoilla kuten ennenkin.
//
// Tulevaa toimittajaa varten `normalizeProviderQuote` tarkistaa, että
// vastaus täyttää MARKET_DATA_CONTRACT-sopimuksen (sentit kokonaislukuina,
// asOf pakollinen, tuntematon ei ole nolla). Toimittajan kytkeminen vaatii
// silti tietosuojakatselmoinnin: hintakysely paljastaa omistukset.

import { hasMarketDataProvider, MARKET_DATA_CONTRACT } from './investments.js';
import { normalizeCurrency, MAX_MINOR } from './money.js';
import { isCalendarDate } from './zonedClock.js';

export const QUOTE_STATUS = Object.freeze({
  KNOWN: 'known',
  UNKNOWN: 'unknown'
});

/** Miksi hintaa ei ole. */
export const QUOTE_REASON = Object.freeze({
  /** Ulkoista hintapalvelua ei ole kytketty (eikä saa kytkeä ilman katselmointia). */
  BLOCKED_EXTERNAL_PROVIDER: 'BLOCKED_EXTERNAL_PROVIDER',
  INVALID_SYMBOL: 'invalid_symbol',
  INVALID_VALUE: 'invalid_value',
  MISSING_AS_OF: 'missing_as_of',
  FUTURE_AS_OF: 'future_as_of'
});

const MAX_SYMBOL_LENGTH = 20;
const MAX_SYMBOLS = 200;

export const MARKET_DATA_UNAVAILABLE_TEXT = 'Markkinahintoja ei haeta: hintapalvelua ei ole kytketty. Kirjaa arvo itse.';

/** Symboli sellaisenaan kuin se kysyttäisiin: trimmattu, isot kirjaimet. null, jos ei kelpaa. */
export function normalizeSymbol(value) {
  if (typeof value !== 'string') return null;
  const symbol = value.trim().toUpperCase();
  if (symbol === '' || symbol.length > MAX_SYMBOL_LENGTH) return null;
  return /^[A-Z0-9][A-Z0-9.\-:]*$/.test(symbol) ? symbol : null;
}

/** Hintapalvelun tila. Aina: ei käytettävissä. */
export function marketDataAvailability() {
  return Object.freeze({
    available: hasMarketDataProvider(),
    status: QUOTE_STATUS.UNKNOWN,
    reason: QUOTE_REASON.BLOCKED_EXTERNAL_PROVIDER,
    contractMethod: MARKET_DATA_CONTRACT.method,
    text: MARKET_DATA_UNAVAILABLE_TEXT
  });
}

function unknownQuote(symbol, reason) {
  return Object.freeze({
    symbol,
    status: QUOTE_STATUS.UNKNOWN,
    reason,
    valueMinor: null,
    currency: null,
    asOf: null
  });
}

/**
 * Yhden symbolin hinta. Koska toimittajaa ei ole, vastaus on aina
 * tuntematon — ei koskaan keksitty luku.
 */
export function quoteFor(symbol) {
  const normalized = normalizeSymbol(symbol);
  if (normalized === null) return unknownQuote(null, QUOTE_REASON.INVALID_SYMBOL);
  return unknownQuote(normalized, QUOTE_REASON.BLOCKED_EXTERNAL_PROVIDER);
}

/**
 * Usean symbolin hinnat: { [symbol]: quote }. Kelpaamattomat ja
 * kaksoiskappaleet ohitetaan; enintään MAX_SYMBOLS symbolia.
 */
export function quotesFor(symbols) {
  const result = {};
  const seen = new Set();
  if (Array.isArray(symbols)) {
    for (const raw of symbols) {
      const symbol = normalizeSymbol(raw);
      if (symbol === null || seen.has(symbol)) continue;
      if (seen.size >= MAX_SYMBOLS) break;
      seen.add(symbol);
      result[symbol] = quoteFor(symbol);
    }
  }
  return Object.freeze(result);
}

/**
 * Tarkista tulevan toimittajan vastaus sopimusta vasten.
 *
 * Hyväksyy vain: positiivinen kokonaisluku sentteinä (<= MAX_MINOR),
 * ISO-valuutta, asOf-päivä joka ei ole tulevaisuudessa. Nolla, liukuluku,
 * puuttuva asOf tai tuleva päivä -> tuntematon syyn kanssa. Hintaa ei
 * korjata eikä arvata.
 *
 * @param {object} raw {valueMinor, currency, asOf}
 * @param {{symbol:string, todayIso:string}} context
 */
export function normalizeProviderQuote(raw, context) {
  const { symbol: rawSymbol, todayIso } = context && typeof context === 'object' ? context : {};
  const symbol = normalizeSymbol(rawSymbol);
  if (symbol === null) return unknownQuote(null, QUOTE_REASON.INVALID_SYMBOL);
  if (!raw || typeof raw !== 'object') return unknownQuote(symbol, QUOTE_REASON.INVALID_VALUE);
  const value = raw.valueMinor;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_MINOR) {
    return unknownQuote(symbol, QUOTE_REASON.INVALID_VALUE);
  }
  if (typeof raw.currency !== 'string' || !/^[A-Za-z]{3}$/.test(raw.currency.trim())) {
    return unknownQuote(symbol, QUOTE_REASON.INVALID_VALUE);
  }
  const asOf = typeof raw.asOf === 'string' ? raw.asOf.slice(0, 10) : null;
  if (!isCalendarDate(asOf)) return unknownQuote(symbol, QUOTE_REASON.MISSING_AS_OF);
  if (isCalendarDate(todayIso) && asOf > todayIso) return unknownQuote(symbol, QUOTE_REASON.FUTURE_AS_OF);
  return Object.freeze({
    symbol,
    status: QUOTE_STATUS.KNOWN,
    reason: null,
    valueMinor: value,
    currency: normalizeCurrency(raw.currency),
    asOf
  });
}
