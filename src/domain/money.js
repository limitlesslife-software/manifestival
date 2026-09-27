// Rahan esittäminen.
//
// PUHDAS MODUULI. Ei DOM:ia, ei verkkoa, ei kelloa.
//
// ---------------------------------------------------------------------
// PERUSSÄÄNTÖ: RAHA ON KOKONAISLUKU
// ---------------------------------------------------------------------
//
// Rahaa EI säilytetä eikä lasketa binäärisenä liukulukuna. Syy on
// osoitettavissa yhdellä rivillä:
//
//     0.1 + 0.2 === 0.30000000000000004
//
// Yksittäisenä virhe on näkymätön, mutta se kertautuu: sadan laskun
// summassa se on jo senttejä, ja käyttäjä näkee luvun joka ei täsmää
// mihinkään. Pahempaa on, että virhe on epädeterministinen suhteessa
// summausjärjestykseen — sama data tuottaa eri loppusumman eri
// järjestyksessä laskettuna.
//
// Siksi kaikki summat ovat SENTTEJÄ kokonaislukuina:
//
//     129,95 €  ->  12995
//
// Muunnos euroiksi tehdään VAIN näyttöhetkellä. Laskenta tapahtuu aina
// kokonaisluvuilla.
//
// ---------------------------------------------------------------------
// TOINEN SÄÄNTÖ: VALUUTTOJA EI SUMMATA
// ---------------------------------------------------------------------
//
// 10 EUR + 10 USD ei ole 20 mitään. Kurssia ei ole, eikä sovellus hae
// sitä — se olisi ulkoinen riippuvuus ja vanhenisi heti. Summaus tapahtuu
// aina valuutan sisällä, ja eri valuutat esitetään erikseen.

/** Oletusvaluutta. Monivaluuttatuki on olemassa, mutta oletus riittää useimmille. */
export const DEFAULT_CURRENCY = 'EUR';

/** Kuinka monta pienintä yksikköä yhdessä kokonaisessa. Euro = 100 senttiä. */
export const MINOR_UNITS_PER_MAJOR = 100;

/**
 * Suurin hyväksyttävä summa sentteinä (10 miljoonaa euroa).
 *
 * Suojaa kirjoitusvirheeltä, ei rikkaudelta: kolme ylimääräistä nollaa on
 * paljon todennäköisempi kuin kymmenen miljoonan euron sähkölasku.
 */
export const MAX_MINOR = 1_000_000_000;

/** Valuuttakoodi on kolme kirjainta. Tuntematon hylätään, ei arvata. */
export function normalizeCurrency(value) {
  if (typeof value !== 'string') return DEFAULT_CURRENCY;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : DEFAULT_CURRENCY;
}

/**
 * Muunna käyttäjän syöte senteiksi.
 *
 * Hyväksyy sekä pisteen että pilkun desimaalierottimena — suomalainen
 * käyttäjä kirjoittaa "129,95" ja näppäimistön numeronäppäimistö tuottaa
 * "129.95". Molemmat tarkoittavat samaa.
 *
 * Välilyönnit ja sitomattomat välilyönnit poistetaan tuhaterottimina.
 *
 * @returns {number|null} sentteinä, tai null jos syöte ei kelpaa
 */
export function parseMoneyToMinor(input) {
  if (input === null || input === undefined || input === '') return null;

  // Luku sellaisenaan: oletetaan MAJOR-yksiköksi (euroiksi).
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) return null;
    const minor = Math.round(input * MINOR_UNITS_PER_MAJOR);
    return minor > MAX_MINOR ? null : minor;
  }

  if (typeof input !== 'string') return null;

  const cleaned = input
    .replace(/ /g, '')   // sitomaton välilyönti
    .replace(/\s/g, '')
    .replace(',', '.');

  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;

  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;

  // Pyöristys hoitaa liukuluvun epätarkkuuden: 1.005 * 100 on 100.49999…
  const minor = Math.round(value * MINOR_UNITS_PER_MAJOR);
  return minor > MAX_MINOR ? null : minor;
}

/**
 * Normalisoi sentteinä annettu summa.
 * Tämä on se muoto, jossa raha kulkee koko sovelluksen läpi.
 */
export function normalizeMinor(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  const rounded = Math.round(n);
  return rounded > MAX_MINOR ? null : rounded;
}

/**
 * Etumerkillinen summa näyttämistä varten.
 *
 * Tallennettava summa (normalizeMinor) ei ole koskaan negatiivinen, mutta
 * JOHDETTU luku voi olla: kuukauden erotus, ennuste tai salkun tuotto.
 * Aiemmin formatMoney kulki normalizeMinor-funktion kautta ja palautti
 * negatiiviselle luvulle tyhjän merkkijonon — "Erotus" ja "Jäljellä"
 * näkyivät tyhjinä juuri silloin, kun ne olivat tärkeimpiä.
 *
 * Itseisarvon yläraja on sama MAX_MINOR kuin tallennettavalla summalla.
 * Negatiivinen nolla (-0,4 senttiä pyöristettynä) on nolla.
 */
function signedMinorForDisplay(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (Math.abs(rounded) > MAX_MINOR) return null;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Muotoile sentit näytettäväksi.
 *
 * Käyttää Suomen muotoilua: pilkku desimaalierottimena, välilyönti
 * tuhaterottimena. `Intl` hoitaa sen oikein myös muille valuutoille.
 * Negatiivinen summa näytetään miinusmerkillä (esim. "−129,95 €").
 *
 * @param {number} minor sentteinä, myös negatiivinen johdettu luku
 * @param {string} currency ISO-koodi
 */
export function formatMoney(minor, currency = DEFAULT_CURRENCY) {
  const amount = signedMinorForDisplay(minor);
  if (amount === null) return '';

  const code = normalizeCurrency(currency);
  const major = amount / MINOR_UNITS_PER_MAJOR;

  try {
    return new Intl.NumberFormat('fi-FI', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(major);
  } catch {
    // Tuntematon valuuttakoodi tai puuttuva Intl: näytetään silti luku,
    // koska tyhjä kenttä olisi käyttäjälle pahempi kuin karu muotoilu.
    return `${major.toFixed(2)} ${code}`;
  }
}

/** Pelkkä luku ilman valuuttasymbolia. Käytetään syöttökentissä. */
export function formatMinorAsInput(minor) {
  const amount = normalizeMinor(minor);
  if (amount === null) return '';
  return (amount / MINOR_UNITS_PER_MAJOR).toFixed(2);
}

/**
 * Laske yhteen VAIN saman valuutan summat.
 *
 * Palauttaa olion, jonka avaimena on valuutta. Yhtä lukua ei palauteta
 * koskaan, koska sellaista ei ole olemassa ilman kurssia.
 *
 * @param {Array<{amountMinor:number, currency:string}>} items
 * @returns {Object<string, number>} valuutta -> sentit
 */
export function sumByCurrency(items = []) {
  const totals = {};
  for (const item of items) {
    if (!item) continue;
    const minor = normalizeMinor(item.amountMinor);
    if (minor === null) continue;
    const code = normalizeCurrency(item.currency);
    totals[code] = (totals[code] || 0) + minor;
  }
  return totals;
}

/**
 * Onko joukossa useampi kuin yksi valuutta?
 * Käyttöliittymä näyttää tällöin summat erikseen eikä yhtä lukua.
 */
export function hasMixedCurrencies(items = []) {
  return Object.keys(sumByCurrency(items)).length > 1;
}

/** Muotoile valuuttakohtaiset summat luettavaksi listaksi. */
export function formatTotals(totals = {}) {
  return Object.entries(totals)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, minor]) => formatMoney(minor, currency));
}

/**
 * Osuus prosentteina kokonaislukuna.
 *
 * Kokonaisluku, koska 33,333333 % ei ole tarkempi vaan vain pidempi.
 * Nolla tavoite on 0 %, ei jakolasku nollalla.
 */
export function percentOf(currentMinor, targetMinor) {
  const current = normalizeMinor(currentMinor) ?? 0;
  const target = normalizeMinor(targetMinor);
  if (target === null || target === 0) return 0;
  return Math.max(0, Math.min(100, Math.round((current / target) * 100)));
}

/** Paljonko puuttuu. Ei koskaan negatiivinen — ylitys ei ole velkaa. */
export function remainingMinor(currentMinor, targetMinor) {
  const current = normalizeMinor(currentMinor) ?? 0;
  const target = normalizeMinor(targetMinor) ?? 0;
  return Math.max(0, target - current);
}
