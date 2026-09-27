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
import { normalizeMinor, normalizeCurrency, formatMoney } from './money.js';

/** Käsin kirjattu arvo on vanha, kun se on kirjattu yli näin monta päivää sitten. */
export const STALE_AFTER_DAYS = 30;

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
 * Tuntematon arvo ei ole nolla. Myös puuttuva kenttä (undefined) on
 * tuntematon — aiemmin se meni "tunnetuksi" ja summaan tuli NaN.
 */
export function hasKnownValue(holding) {
  return Boolean(holding) && isMinor(holding.currentValueMinor);
}

function isMinor(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function hasKnownCost(holding) {
  return Boolean(holding) && isMinor(holding.costBasisMinor);
}

function holdingSummary(holding, stale) {
  const known = hasKnownValue(holding) && hasKnownCost(holding);
  if (!known) {
    return Object.freeze({ holding, known: false, gainMinor: null, gainPercent: null, stale });
  }
  const gainMinor = holding.currentValueMinor - holding.costBasisMinor;
  const gainPercent = holding.costBasisMinor > 0
    ? Math.round((gainMinor / holding.costBasisMinor) * 1000) / 10
    : 0;
  return Object.freeze({ holding, known: true, gainMinor, gainPercent, stale });
}

/**
 * Yhden omistuksen tuotto.
 *
 * Palauttaa `known: false` jos arvoa tai hankintahintaa ei ole. Tuotto
 * lasketaan vain kun molemmat tiedetään -- muuten luku olisi
 * puolittain arvattu, ja puolittain arvattu tuotto näyttää tuotolta.
 */
export function summarizeHolding(holding) {
  return holdingSummary(holding, false);
}

/**
 * Onko käsin kirjattu arvo vanhentunut?
 *
 * Käsin kirjattu arvo vanhenee, koska markkina liikkuu eikä kukaan
 * päivitä sitä puolestasi. Vanhentunut arvo ei ole väärä, mutta se on
 * vanha — ja sen on näyttävä siltä.
 */
export function isValueStale(holding, todayIso, maxAgeDays = STALE_AFTER_DAYS) {
  if (!holding || !isIsoDate(holding.valuedOn) || !isIsoDate(todayIso)) return false;
  const valued = Date.parse(holding.valuedOn + 'T00:00:00Z');
  const today = Date.parse(todayIso + 'T00:00:00Z');
  if (!Number.isFinite(valued) || !Number.isFinite(today)) return false;
  return (today - valued) / 86400000 > maxAgeDays;
}

function addTo(totals, currency, amount) {
  totals[currency] = (totals[currency] || 0) + amount;
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
 *
 * TUOTTO VAIN SAMASTA JOUKOSTA. `gainByCurrency` lasketaan vain
 * omistuksista, joilla on SEKÄ arvo ETTÄ hankintahinta. Aiemmin se oli
 * "kaikkien arvojen summa − kaikkien hankintahintojen summa", jolloin
 * esimerkiksi [{hinta 1000, arvo 1200}, {hinta 500, arvo tuntematon}]
 * näytti tappiota −300 eikä voittoa +200: tuntemattoman arvon omistuksen
 * hankintahinta vähennettiin, mutta sen arvoa ei lisätty.
 * `valueByCurrency` ja `costByCurrency` ovat yhä kaikkien tunnettujen
 * arvojen ja hankintahintojen summia (näytettäviä kokonaislukuja), joten
 * tuotto EI ole niiden erotus, kun osa tiedoista puuttuu.
 */
export function summarizePortfolio(holdings = [], todayIso = null) {
  const list = Array.isArray(holdings) ? holdings.filter(h => h && typeof h === 'object') : [];

  const valueByCurrency = {};
  const costByCurrency = {};
  const gainValueByCurrency = {};
  const gainCostByCurrency = {};
  let unknownCount = 0;
  let staleCount = 0;
  let gainKnownCount = 0;

  const summaries = list.map(holding => {
    const stale = isValueStale(holding, todayIso);
    if (stale) staleCount += 1;
    const currency = normalizeCurrency(holding.currency);
    const valueKnown = hasKnownValue(holding);
    const costKnown = hasKnownCost(holding);

    if (!valueKnown) unknownCount += 1;
    else addTo(valueByCurrency, currency, holding.currentValueMinor);
    if (costKnown) addTo(costByCurrency, currency, holding.costBasisMinor);
    if (valueKnown && costKnown) {
      gainKnownCount += 1;
      addTo(gainValueByCurrency, currency, holding.currentValueMinor);
      addTo(gainCostByCurrency, currency, holding.costBasisMinor);
    }
    return holdingSummary(holding, stale);
  });

  const gainByCurrency = {};
  const gainPercentByCurrency = {};
  for (const currency of Object.keys(gainValueByCurrency)) {
    const gain = gainValueByCurrency[currency] - gainCostByCurrency[currency];
    gainByCurrency[currency] = gain;
    gainPercentByCurrency[currency] = gainCostByCurrency[currency] > 0
      ? Math.round((gain / gainCostByCurrency[currency]) * 1000) / 10
      : null;
  }

  return Object.freeze({
    holdings: Object.freeze(summaries),
    valueByCurrency: Object.freeze(valueByCurrency),
    costByCurrency: Object.freeze(costByCurrency),
    gainByCurrency: Object.freeze(gainByCurrency),
    /** Tuotto prosentteina tuoton omasta hankintahinnasta; null, jos hinta on 0. */
    gainPercentByCurrency: Object.freeze(gainPercentByCurrency),
    /** Montako omistusta tuottoon sisältyy (arvo ja hankintahinta tiedossa). */
    gainKnownCount,
    total: list.length,
    /** Omistukset joiden arvoa ei tiedetä. EI nollia. */
    unknownCount,
    /** Omistukset joiden käsin kirjattu arvo on vanha. */
    staleCount
  });
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
// YKSIKKÖHINTA, TAVOITEARVO JA KÄYTTÄJÄN OMAT RAJAT
// =====================================================================
//
// Kaikki johdetaan käyttäjän itse kirjaamista luvuista. Ei ennustetta,
// ei suositusta: raja on kello, ei neuvonantaja. Teksteissä ei koskaan
// kehoteta ostamaan tai myymään.

/**
 * Yksikköhinta: kokonaisarvo / määrä (ja hankintahinta / määrä).
 *
 * Sentteinä kokonaislukuna. Jos arvo on positiivinen mutta yksikköhinta
 * pyöristyisi nollaan (alle sentin), kenttä on null ja `subCent` kertoo
 * syyn — nolla väittäisi yksikön olevan ilmainen.
 *
 * @returns {{currentMinor:number|null, costMinor:number|null, currency:string,
 *   quantity:number, subCent:boolean}|null} null, jos määrää tai kumpaakaan summaa ei tiedetä
 */
export function unitPrice(holding) {
  if (!holding || typeof holding !== 'object') return null;
  const quantity = holding.quantity;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) return null;
  const value = hasKnownValue(holding) ? holding.currentValueMinor : null;
  const cost = hasKnownCost(holding) ? holding.costBasisMinor : null;
  if (value === null && cost === null) return null;
  let subCent = false;
  const perUnit = total => {
    if (total === null) return null;
    const rounded = Math.round(total / quantity);
    if (!Number.isSafeInteger(rounded)) return null;
    if (rounded === 0 && total > 0) {
      subCent = true;
      return null;
    }
    return rounded;
  };
  const currentMinor = perUnit(value);
  const costMinor = perUnit(cost);
  // Kumpikaan ei mahdu senttilukuun (ylivuoto): ei vastausta, ei keksittyä lukua.
  if (currentMinor === null && costMinor === null && !subCent) return null;
  return Object.freeze({
    currentMinor,
    costMinor,
    currency: normalizeCurrency(holding.currency),
    quantity,
    subCent
  });
}

/**
 * Nykyarvo suhteessa käyttäjän omaan tavoitearvoon (targetValueMinor).
 *
 * Tavoitearvo on samaa yksikköä kuin nykyarvo: omistuksen KOKONAISARVO,
 * ei kappalehinta.
 *
 * @returns {object|null} null, kun tavoitetta tai arvoa ei tiedetä (tai tavoite on 0)
 */
export function targetComparison(holding, todayIso = null) {
  if (!holding || typeof holding !== 'object') return null;
  const target = isMinor(holding.targetValueMinor) ? holding.targetValueMinor : null;
  if (target === null || target === 0 || !hasKnownValue(holding)) return null;
  const current = holding.currentValueMinor;
  const currency = normalizeCurrency(holding.currency);
  const percentOfTarget = Math.round((current / target) * 100);
  const reached = current >= target;
  const stale = isValueStale(holding, todayIso);
  let text = reached
    ? `Arvo ${formatMoney(current, currency)} on saavuttanut tavoitearvosi ${formatMoney(target, currency)}.`
    : `Arvo on ${percentOfTarget} % tavoitearvostasi ${formatMoney(target, currency)}.`;
  if (stale) text += ` Arvo on kirjattu yli ${STALE_AFTER_DAYS} päivää sitten.`;
  return Object.freeze({
    targetMinor: target,
    currentMinor: current,
    differenceMinor: target - current,
    percentOfTarget,
    reached,
    stale,
    currency,
    text
  });
}

/** Käyttäjän oman rajan laji. Rajat ovat sisältäviä (">= raja", "<= raja"). */
export const ALERT_KIND = Object.freeze({
  VALUE_AT_OR_ABOVE: 'value_at_or_above',
  VALUE_AT_OR_BELOW: 'value_at_or_below',
  GAIN_PERCENT_AT_OR_ABOVE: 'gain_percent_at_or_above',
  GAIN_PERCENT_AT_OR_BELOW: 'gain_percent_at_or_below',
  TARGET_REACHED: 'target_reached'
});

export const ALERT_KINDS = Object.freeze(Object.values(ALERT_KIND));

export const ALERT_STATUS = Object.freeze({
  TRIGGERED: 'triggered',
  NOT_TRIGGERED: 'not_triggered',
  /** Arvoa, tuottoa tai tavoitetta ei tiedetä: rajaa ei voi verrata. EI "ei lauennut". */
  UNKNOWN: 'unknown'
});

const MAX_ALERT_PERCENT = 100000;

function percentOrNull(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > MAX_ALERT_PERCENT) return null;
  return Math.round(n * 10) / 10;
}

/** Normalisoi käyttäjän oma raja. Ei koskaan heitä. */
export function normalizeUserAlert(input) {
  const source = input && typeof input === 'object' ? input : {};
  const kind = ALERT_KINDS.includes(source.kind) ? source.kind : null;
  const byValue = kind === ALERT_KIND.VALUE_AT_OR_ABOVE || kind === ALERT_KIND.VALUE_AT_OR_BELOW;
  const byPercent = kind === ALERT_KIND.GAIN_PERCENT_AT_OR_ABOVE || kind === ALERT_KIND.GAIN_PERCENT_AT_OR_BELOW;
  return Object.freeze({
    id: source.id != null ? String(source.id).slice(0, 200) : null,
    holdingId: source.holdingId != null ? String(source.holdingId).slice(0, 200) : null,
    kind,
    thresholdMinor: byValue ? normalizeMinor(source.thresholdMinor) : null,
    thresholdPercent: byPercent ? percentOrNull(source.thresholdPercent) : null,
    /** Rajan valuutta; null = omistuksen oma valuutta. */
    currency: typeof source.currency === 'string' && /^[A-Za-z]{3}$/.test(source.currency.trim())
      ? normalizeCurrency(source.currency)
      : null,
    active: source.active !== false
  });
}

export function validateUserAlert(alert) {
  const a = normalizeUserAlert(alert);
  const errors = {};
  if (!a.holdingId) errors.holdingId = 'Valitse sijoitus.';
  if (!a.kind) errors.kind = 'Valitse rajan laji.';
  if ((a.kind === ALERT_KIND.VALUE_AT_OR_ABOVE || a.kind === ALERT_KIND.VALUE_AT_OR_BELOW) && a.thresholdMinor === null) {
    errors.thresholdMinor = 'Anna raja euroina.';
  }
  if ((a.kind === ALERT_KIND.GAIN_PERCENT_AT_OR_ABOVE || a.kind === ALERT_KIND.GAIN_PERCENT_AT_OR_BELOW)
    && a.thresholdPercent === null) {
    errors.thresholdPercent = 'Anna raja prosentteina.';
  }
  return Object.freeze({ valid: Object.keys(errors).length === 0, errors: Object.freeze(errors) });
}

const ALERT_STATUS_RANK = Object.freeze({ triggered: 0, unknown: 1, not_triggered: 2 });

function formatPercentFi(value) {
  return String(value).replace('.', ',');
}

function evaluateOne(alert, holding, todayIso) {
  const base = { alertId: alert.id, holdingId: alert.holdingId, kind: alert.kind };
  const name = holding && typeof holding.name === 'string' && holding.name ? holding.name : 'Sijoitus';
  const unknown = (reason, text) => Object.freeze({
    ...base,
    status: ALERT_STATUS.UNKNOWN,
    triggered: null,
    reason,
    observed: null,
    threshold: alert.thresholdMinor ?? alert.thresholdPercent ?? null,
    stale: false,
    holdingName: holding ? name : null,
    text
  });
  if (!holding) return unknown('holding_missing', 'Sijoitusta ei enää ole, joten rajaa ei voi verrata.');
  const currency = normalizeCurrency(holding.currency);
  const stale = isValueStale(holding, todayIso);
  const staleNote = stale ? ` Arvo on kirjattu yli ${STALE_AFTER_DAYS} päivää sitten.` : '';
  const result = (triggered, observed, threshold, text) => Object.freeze({
    ...base,
    status: triggered ? ALERT_STATUS.TRIGGERED : ALERT_STATUS.NOT_TRIGGERED,
    triggered,
    reason: null,
    observed,
    threshold,
    stale,
    holdingName: name,
    text: text + staleNote
  });

  switch (alert.kind) {
    case ALERT_KIND.VALUE_AT_OR_ABOVE:
    case ALERT_KIND.VALUE_AT_OR_BELOW: {
      if (alert.thresholdMinor === null) return unknown('no_threshold', `${name}: rajaa ei ole annettu.`);
      if (alert.currency !== null && alert.currency !== currency) {
        return unknown('currency', `${name}: raja on eri valuutassa kuin sijoitus, joten vertailua ei tehdä.`);
      }
      if (!hasKnownValue(holding)) {
        return unknown('no_value', `${name}: arvoa ei ole kirjattu, joten rajaa ei voi verrata.`);
      }
      const value = holding.currentValueMinor;
      const above = alert.kind === ALERT_KIND.VALUE_AT_OR_ABOVE;
      const triggered = above ? value >= alert.thresholdMinor : value <= alert.thresholdMinor;
      const valueText = formatMoney(value, currency);
      const limitText = formatMoney(alert.thresholdMinor, currency);
      const text = triggered
        ? `${name}: arvo ${valueText} on ${above ? 'vähintään' : 'enintään'} asettamasi raja ${limitText}.`
        : `${name}: arvo ${valueText}, asettamasi raja ${limitText}.`;
      return result(triggered, value, alert.thresholdMinor, text);
    }
    case ALERT_KIND.GAIN_PERCENT_AT_OR_ABOVE:
    case ALERT_KIND.GAIN_PERCENT_AT_OR_BELOW: {
      if (alert.thresholdPercent === null) return unknown('no_threshold', `${name}: rajaa ei ole annettu.`);
      const summary = summarizeHolding(holding);
      if (!summary.known || !(holding.costBasisMinor > 0)) {
        return unknown('no_gain', `${name}: tuottoa ei voi laskea ilman arvoa ja hankintahintaa.`);
      }
      const above = alert.kind === ALERT_KIND.GAIN_PERCENT_AT_OR_ABOVE;
      const gain = summary.gainPercent;
      const limit = alert.thresholdPercent;
      const triggered = above ? gain >= limit : gain <= limit;
      const gainText = `${formatPercentFi(gain)} %`;
      const limitText = `${formatPercentFi(limit)} %`;
      const text = triggered
        ? `${name}: tuotto ${gainText} on ${above ? 'vähintään' : 'enintään'} asettamasi raja ${limitText}.`
        : `${name}: tuotto ${gainText}, asettamasi raja ${limitText}.`;
      return result(triggered, summary.gainPercent, alert.thresholdPercent, text);
    }
    case ALERT_KIND.TARGET_REACHED: {
      const comparison = targetComparison(holding, todayIso);
      if (!comparison) return unknown('no_target', `${name}: tavoitearvoa tai nykyarvoa ei ole kirjattu.`);
      const text = comparison.reached
        ? `${name}: tavoitearvo ${formatMoney(comparison.targetMinor, currency)} on saavutettu.`
        : `${name}: ${comparison.percentOfTarget} % tavoitearvosta.`;
      return result(comparison.reached, comparison.currentMinor, comparison.targetMinor, text);
    }
    default:
      return unknown('invalid_alert', 'Rajan lajia ei tunnistettu.');
  }
}

/**
 * Käyttäjän omien rajojen tila.
 *
 * Kello, ei neuvonantaja: kertoo vain, onko käyttäjän itse asettama raja
 * ylittynyt käsin kirjatulla arvolla. Tuntematon arvo -> UNKNOWN, ei
 * "ei lauennut". Pois päältä olevat rajat ohitetaan.
 *
 * @returns {ReadonlyArray<object>} lauenneet ensin, sitten tuntemattomat,
 *   sitten sijoituksen nimen ja rajan tunnisteen mukaan
 */
export function evaluateUserAlerts(holdings, alerts, todayIso = null) {
  const byId = new Map();
  for (const holding of Array.isArray(holdings) ? holdings : []) {
    if (holding && typeof holding === 'object' && holding.id != null && !byId.has(String(holding.id))) {
      byId.set(String(holding.id), holding);
    }
  }
  const results = [];
  for (const raw of Array.isArray(alerts) ? alerts : []) {
    if (!raw || typeof raw !== 'object') continue;
    const alert = normalizeUserAlert(raw);
    if (!alert.active) continue;
    results.push(evaluateOne(alert, alert.holdingId !== null ? byId.get(alert.holdingId) : undefined, todayIso));
  }
  const compareText = (a, b) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a.localeCompare(b, 'fi'));
  results.sort((a, b) => ALERT_STATUS_RANK[a.status] - ALERT_STATUS_RANK[b.status]
    || compareText(a.holdingName, b.holdingName)
    || compareText(a.alertId, b.alertId)
    || compareText(a.kind, b.kind));
  return Object.freeze(results);
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
