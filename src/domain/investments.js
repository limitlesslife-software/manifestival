// Sijoitukset.
//
// ---------------------------------------------------------------
// HINTATIETOA EI KEKSITÄ
// ---------------------------------------------------------------
//
// Manifestivalilla ei ole markkinadatan toimittajaa. Siksi tässä
// moduulissa ei ole yhtäkään kurssia, tikkeriä eikä hakua.
//
// Arvo on joko
//
//   KÄYTTÄJÄN ITSE KIRJAAMA   -- merkitty käsin syötetyksi ja
//                                päivätty, jotta vanhentuminen näkyy
//   TUNTEMATON                -- ja silloin se sanotaan ääneen
//
// Keksitty kurssi olisi pahin mahdollinen virhe tässä sovelluksessa:
// se näyttäisi täsmälleen yhtä varmalta kuin oikea. Tuotto laskettuna
// arvatusta hinnasta on arvaus, joka esiintyy tietona.
//
// `MarketDataProvider` alla on rajapinta myöhempää integraatiota
// varten. Sitä ei ole toteutettu, eikä sen puuttuminen estä mitään:
// salkku toimii käsin kirjatuilla arvoilla.
//
// SIJOITUS EI OLE PANKKITILI EIKÄ VÄLITTÄJÄTILI. Tämä on seuranta,
// ei yhteys. Manifestival ei osta, myy eikä näe todellista salkkua.

import { isIsoDate } from './task.js';
import { normalizeMinor, normalizeCurrency } from './money.js';

/** Sijoituslaji. */
export const HOLDING_KIND = Object.freeze({
  STOCK: 'stock',
  FUND: 'fund',
  ETF: 'etf',
  CRYPTO: 'crypto',
  INDEX: 'index',
  OTHER: 'other'
});

export const HOLDING_KINDS = Object.freeze(Object.values(HOLDING_KIND));

const KIND_LABELS = Object.freeze({
  stock: 'Osake',
  fund: 'Rahasto',
  etf: 'ETF',
  crypto: 'Kryptovaluutta',
  index: 'Indeksi',
  other: 'Muu'
});

export function holdingKindLabel(kind) {
  return KIND_LABELS[kind] || KIND_LABELS.other;
}

/** Mistä nykyarvo on peräisin. */
export const VALUE_SOURCE = Object.freeze({
  /** Käyttäjä kirjasi arvon itse. */
  MANUAL: 'manual',
  /** Arvoa ei ole. Tuottoa ei voi laskea. */
  UNKNOWN: 'unknown',
  /** Varattu tulevalle markkinadatan toimittajalle. Ei käytössä. */
  PROVIDER: 'provider'
});

const MAX_NAME = 120;
const MAX_SYMBOL = 20;
const MAX_NOTE = 500;

function cleanText(value, maxLength) {
  if (value == null) return null;
  const trimmed = String(value).trim().slice(0, maxLength);
  return trimmed === '' ? null : trimmed;
}

/**
 * Normalisoi omistus.
 *
 * MÄÄRÄ EI OLE RAHAA. Osakkeita voi olla 12,5 kappaletta ja
 * kryptoa 0,00031 -- murto-osat ovat todellisia, joten määrä on
 * liukuluku. Rahasummat ovat yhä kokonaislukuja sentteinä.
 *
 * Määrää ei tallenneta senttilogiikalla, koska se ei ole rahaa eikä
 * sillä ole valuuttaa.
 */
export function normalizeHolding(input = {}) {
  const quantity = Number(input.quantity);
  const valueSource = Object.values(VALUE_SOURCE).includes(input.valueSource)
    ? input.valueSource
    : VALUE_SOURCE.UNKNOWN;

  const currentValueMinor = normalizeMinor(input.currentValueMinor);

  return {
    id: input.id != null ? String(input.id) : null,
    name: cleanText(input.name, MAX_NAME) || '',
    /** Tikkeri tai tunnus. Vapaaehtoinen, ei haeta millään. */
    symbol: cleanText(input.symbol, MAX_SYMBOL),
    kind: HOLDING_KINDS.includes(input.kind) ? input.kind : HOLDING_KIND.OTHER,

    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null,

    /** Hankintahinta yhteensä, sentteinä. */
    costBasisMinor: normalizeMinor(input.costBasisMinor),
    /** Nykyarvo yhteensä, sentteinä. Käsin kirjattu tai tuntematon. */
    currentValueMinor,
    /** Milloin nykyarvo kirjattiin. Ilman tätä arvo ei kerro ikäänsä. */
    valuedOn: isIsoDate(input.valuedOn) ? input.valuedOn : null,
    valueSource: currentValueMinor === null ? VALUE_SOURCE.UNKNOWN : valueSource,

    currency: normalizeCurrency(input.currency),

    /** Käyttäjän oma tavoitehinta. Ei hälytystä, ei automatiikkaa. */
    targetValueMinor: normalizeMinor(input.targetValueMinor),

    note: cleanText(input.note, MAX_NOTE),
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

export function validateHolding(holding) {
  const errors = {};

  if (!holding.name) errors.name = 'Anna sijoituksen nimi.';
  if (!HOLDING_KINDS.includes(holding.kind)) errors.kind = 'Valitse laji.';

  if (holding.quantity !== null && !(holding.quantity > 0)) {
    errors.quantity = 'Määrän pitää olla suurempi kuin nolla.';
  }
  if (holding.costBasisMinor !== null && holding.costBasisMinor < 0) {
    errors.costBasisMinor = 'Hankintahinta ei voi olla negatiivinen.';
  }
  if (holding.currentValueMinor !== null && holding.currentValueMinor < 0) {
    errors.currentValueMinor = 'Arvo ei voi olla negatiivinen.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Onko nykyarvo tiedossa?
 *
 * Tämä on se kysymys, joka ratkaisee näytetäänkö tuotto lainkaan.
 * Tuntematon arvo ei ole nolla.
 */
export function hasKnownValue(holding) {
  return Boolean(holding) && holding.currentValueMinor !== null;
}

/**
 * Yhden omistuksen tuotto.
 *
 * Palauttaa `known: false` jos arvoa tai hankintahintaa ei ole. Tuotto
 * lasketaan vain kun molemmat tiedetään -- muuten luku olisi
 * puolittain arvattu, ja puolittain arvattu tuotto näyttää tuotolta.
 */
export function summarizeHolding(holding) {
  const known = hasKnownValue(holding) && holding.costBasisMinor !== null;

  if (!known) {
    return {
      holding,
      known: false,
      gainMinor: null,
      gainPercent: null,
      stale: false
    };
  }

  const gainMinor = holding.currentValueMinor - holding.costBasisMinor;
  const gainPercent = holding.costBasisMinor > 0
    ? Math.round((gainMinor / holding.costBasisMinor) * 1000) / 10
    : 0;

  return { holding, known: true, gainMinor, gainPercent, stale: false };
}

/**
 * Onko käsin kirjattu arvo vanhentunut?
 *
 * Käsin kirjattu arvo vanhenee, koska markkina liikkuu eikä kukaan
 * päivitä sitä puolestasi. Vanhentunut arvo ei ole väärä, mutta se on
 * vanha — ja sen on näyttävä siltä.
 */
export function isValueStale(holding, todayIso, maxAgeDays = 30) {
  if (!holding || !holding.valuedOn || !isIsoDate(todayIso)) return false;
  const valued = Date.parse(holding.valuedOn + 'T00:00:00Z');
  const today = Date.parse(todayIso + 'T00:00:00Z');
  if (!Number.isFinite(valued) || !Number.isFinite(today)) return false;
  return (today - valued) / 86400000 > maxAgeDays;
}

/**
 * Koko salkku.
 *
 * VALUUTTOJA EI MUUNNETA eikä summata yhteen. Ilman kurssia muunnos
 * olisi arvaus. Summat pidetään valuutoittain, ja käyttöliittymä
 * näyttää ne erikseen.
 *
 * Omistukset joiden arvoa ei tiedetä lasketaan erikseen: ne eivät ole
 * nolla-arvoisia vaan tuntemattomia, ja käyttäjän on hyvä tietää
 * montako niitä on.
 */
export function summarizePortfolio(holdings = [], todayIso = null) {
  const summaries = holdings.map(summarizeHolding);

  const valueByCurrency = {};
  const costByCurrency = {};
  let unknownCount = 0;
  let staleCount = 0;

  for (const summary of summaries) {
    const holding = summary.holding;

    if (isValueStale(holding, todayIso)) {
      summary.stale = true;
      staleCount += 1;
    }

    if (!hasKnownValue(holding)) {
      unknownCount += 1;
    } else {
      valueByCurrency[holding.currency] =
        (valueByCurrency[holding.currency] || 0) + holding.currentValueMinor;
    }

    if (holding.costBasisMinor !== null) {
      costByCurrency[holding.currency] =
        (costByCurrency[holding.currency] || 0) + holding.costBasisMinor;
    }
  }

  const gainByCurrency = {};
  for (const currency of Object.keys(valueByCurrency)) {
    if (costByCurrency[currency] === undefined) continue;
    gainByCurrency[currency] = valueByCurrency[currency] - costByCurrency[currency];
  }

  return {
    holdings: summaries,
    valueByCurrency,
    costByCurrency,
    gainByCurrency,
    total: holdings.length,
    /** Omistukset joiden arvoa ei tiedetä. EI nollia. */
    unknownCount,
    /** Omistukset joiden käsin kirjattu arvo on vanha. */
    staleCount
  };
}

/** Järjestys: arvo laskevasti, tuntemattomat viimeisenä, sitten nimi. */
export function compareHoldings(a, b) {
  const aKnown = hasKnownValue(a);
  const bKnown = hasKnownValue(b);
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  if (aKnown && bKnown) {
    const byValue = b.currentValueMinor - a.currentValueMinor;
    if (byValue !== 0) return byValue;
  }
  return String(a.name).localeCompare(String(b.name), 'fi');
}

// =====================================================================
// MARKKINADATAN RAJAPINTA — EI TOTEUTUSTA
// =====================================================================

/**
 * Rajapinta tulevalle markkinadatan toimittajalle.
 *
 * TÄTÄ EI OLE TOTEUTETTU EIKÄ SITÄ KUTSUTA. Se on olemassa siksi,
 * että myöhempi integraatio ei vaadi salkun uudelleenkirjoittamista:
 * toteuttaja täyttää `fetchQuotes`-funktion, ja `valueSource` muuttuu
 * arvoon PROVIDER.
 *
 * Sopimus:
 *   fetchQuotes(symbols) -> Promise<{ [symbol]: { valueMinor, currency, asOf } }>
 *
 * Toteuttajan on:
 *   - palautettava sentit kokonaislukuina
 *   - jätettävä tuntematon symboli POIS, ei nollana
 *   - merkittävä `asOf` päivämääränä, jotta vanhentuminen näkyy
 *   - epäonnistuttava näkyvästi, ei hiljaa nolliksi
 */
export const MARKET_DATA_CONTRACT = Object.freeze({
  method: 'fetchQuotes',
  input: 'string[] symbols',
  output: '{ [symbol]: { valueMinor: integer, currency: string, asOf: ISO date } }',
  rules: Object.freeze([
    'sentit kokonaislukuina',
    'tuntematon symboli jätetään pois, ei palauteta nollana',
    'asOf on pakollinen',
    'virhe on virhe, ei tyhjä tulos'
  ])
});

/**
 * Onko markkinadatan toimittaja käytettävissä?
 *
 * Aina epätosi. Funktio on olemassa, jotta kutsupaikat voidaan
 * kirjoittaa jo nyt oikein ja jotta tämän vastaus on yhdessä
 * paikassa, kun se joskus muuttuu.
 */
export function hasMarketDataProvider() {
  return false;
}
