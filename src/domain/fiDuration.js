// Suomenkielisten kestoilmausten deterministinen jäsennin.
//
// PUHDAS MODUULI. Ei kelloa, ei verkkoa, ei satunnaisuutta, ei mallia.
// Sama teksti tuottaa aina saman, jäädytetyn tuloksen.
//
// =====================================================================
// MIKSI TÄMÄ ON OLEMASSA
// =====================================================================
//
// Päivän keskeytykset ("olen 10 min myöhässä", "tämä kestää vielä puoli
// tuntia") ja tapahtuman kesto ("hammaslääkäri kestää tunnin") ovat
// minuutteja, joita päivän suunnitelma tarvitsee. Paikallinen jäsennin
// tunnistaa ne ilman kielimallia, joten ne toimivat myös silloin, kun
// verkkoa tai mallia ei ole.
//
// EI ARVATA: "pari tuntia" ja "muutama minuutti" ovat epämääräisiä. Ne
// palautetaan epäselvinä (minutes = null), eikä niistä keksitä lukua.
// Tuntematon kesto on null, ei koskaan nolla.
//
// =====================================================================
// MIKSI SANOITTAIN EIKÄ YHDELLÄ ISOLLA SÄÄNNÖLLISELLÄ LAUSEKKEELLA
// =====================================================================
//
// Teksti pilkotaan ensin sanoiksi ja luvuiksi yhdellä lineaarisella
// läpikäynnillä, ja kestot haetaan sanalistasta hakutaululla. Vaihtoehtoja
// täynnä oleva säännöllinen lauseke voisi kokeilla jokaisessa kohdassa
// satoja sanoja (ja pahimmillaan perääntyä räjähdysmäisesti); tässä työ on
// aina suoraan verrannollinen tekstin pituuteen.

/** Pisin kesto, jota jäsennin väittää: vuorokausi. Pidempi ei ole päivän kesto. */
export const MAX_DURATION_MINUTES = 1440;

/** Miksi kesto jäi auki. Tyhjä merkkijono = selvä. */
export const DURATION_REASON = Object.freeze({
  NONE: '',
  /** "pari tuntia", "muutama minuutti": ei lukua. */
  VAGUE: 'vague',
  /** Yli vuorokauden. */
  TOO_LONG: 'too_long',
  /** Nolla tai muuten mahdoton. */
  INVALID: 'invalid',
  /** Kaksi eri kestoa samassa lauseessa. */
  MULTIPLE: 'multiple'
});

// ------------------------------------------------------------ lukusanat

// Perusluvut perusmuodossa, genetiivissä ja translatiivissa ("kahdeksi
// tunniksi"). Puhekieliset lyhyet muodot ("viis", "kaks") mukana, koska
// puheentunnistus kirjoittaa ne usein sellaisinaan.
const BASE_NUMBERS = Object.freeze([
  [1, 'yksi', 'yhden', 'yhdeksi', ['yks']],
  [2, 'kaksi', 'kahden', 'kahdeksi', ['kaks']],
  [3, 'kolme', 'kolmen', 'kolmeksi', []],
  [4, 'neljä', 'neljän', 'neljäksi', []],
  [5, 'viisi', 'viiden', 'viideksi', ['viis']],
  [6, 'kuusi', 'kuuden', 'kuudeksi', ['kuus']],
  [7, 'seitsemän', 'seitsemän', 'seitsemäksi', ['seittemän']],
  [8, 'kahdeksan', 'kahdeksan', 'kahdeksaksi', ['kaheksan']],
  [9, 'yhdeksän', 'yhdeksän', 'yhdeksäksi', ['yheksän']]
]);

function buildNumberWords() {
  const map = new Map();
  const add = (word, value) => {
    if (!map.has(word)) map.set(word, value);
  };
  for (const [value, nom, gen, transl, colloquial] of BASE_NUMBERS) {
    add(nom, value);
    add(gen, value);
    add(transl, value);
    for (const word of colloquial) add(word, value);
    // 11-19: "viisitoista", "viidentoista", "viideksitoista"
    add(`${nom}toista`, 10 + value);
    add(`${gen}toista`, 10 + value);
    add(`${transl}toista`, 10 + value);
  }
  add('kymmenen', 10);
  add('kymmeneksi', 10);
  // 20-90 ja niiden yhdistelmät: sama sija molemmissa osissa
  // ("kaksikymmentäviisi", "kahdenkymmenenviiden").
  for (const [tens, nom, gen, transl] of BASE_NUMBERS) {
    if (tens < 2) continue;
    const forms = [[`${nom}kymmentä`, 0], [`${gen}kymmenen`, 1], [`${transl}kymmeneksi`, 2]];
    for (const [stem, caseIndex] of forms) {
      add(stem, tens * 10);
      for (const [unit, uNom, uGen, uTransl] of BASE_NUMBERS) {
        add(stem + [uNom, uGen, uTransl][caseIndex], tens * 10 + unit);
      }
    }
  }
  return map;
}

const NUMBER_WORDS = buildNumberWords();

/** Murto-osat, joita kestoissa käytetään. */
const FRACTION_WORDS = new Map([
  ['puoli', 0.5], ['puolen', 0.5], ['puoleksi', 0.5],
  ['puolitoista', 1.5], ['puolentoista', 1.5], ['puoleksitoista', 1.5]
]);

/** Epämääräiset määrät: kesto on olemassa, mutta lukua ei väitetä. */
const VAGUE_WORDS = new Set([
  'pari', 'parin', 'pariksi', 'muutama', 'muutaman', 'muutamaksi', 'jokunen', 'jonkun',
  'joitain', 'joitakin', 'useampi', 'useamman', 'monta', 'monen'
]);

// ------------------------------------------------------------ yksiköt

const MINUTE_UNITS = new Set([
  'min', 'mins', 'minsa', 'minsaa', 'minuutti', 'minuuttia', 'minuutin', 'minuutiksi', 'minuutissa',
  'minuuttiin', 'minuutteja', 'minuutilla', 'minuuteiksi'
]);
const HOUR_UNITS = new Set([
  'tunti', 'tuntia', 'tunnin', 'tunniksi', 'tunnissa', 'tuntiin', 'tunteja', 'tunnilla', 'tunnit'
]);
/** "h" kelpaa vain numeron perään ("2 h", "1,5h"): yksinään se ei ole kesto. */
const HOUR_ABBREVIATION = 'h';
const QUARTER_UNITS = new Set(['vartti', 'varttia', 'vartin', 'vartiksi', 'vartissa', 'varttiin']);

/** Yksikkö ilman lukua tarkoittaa yhtä: "kestää tunnin", "vartiksi". */
const BARE_HOUR = new Set(['tunti', 'tunnin', 'tunniksi', 'tunnissa', 'tuntiin', 'tunnilla']);
const BARE_QUARTER = new Set(['vartti', 'vartin', 'vartiksi', 'vartissa', 'varttiin']);
const BARE_MINUTE = new Set(['minuutti', 'minuutin', 'minuutiksi', 'minuutissa']);

/** "vartin yli kahdeksan", "varttia vaille yhdeksän" ovat kellonaikoja, eivät kestoja. */
const CLOCK_FOLLOWERS = new Set(['yli', 'vaille']);
/** "klo 8 tunnin ..." -- luku klo-sanan perässä on kellonaika. */
const CLOCK_WORDS = new Set(['klo', 'kello']);

const UNIT_MINUTES = Object.freeze({ minute: 1, hour: 60, quarter: 15 });

// ------------------------------------------------------------ pilkkominen

// Luku (desimaalit pilkulla tai pisteellä) tai kirjainjono. Kaikki muu on
// erotinta. Lauseke ei voi perääntyä: kumpikin haara on yksi toistettu
// merkkiluokka.
const TOKEN = /\d+(?:[.,]\d+)?|\p{L}+/gu;

function tokenize(lower) {
  const tokens = [];
  TOKEN.lastIndex = 0;
  let match;
  while ((match = TOKEN.exec(lower)) !== null) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

function unitOf(token, afterDigits) {
  if (MINUTE_UNITS.has(token)) return 'minute';
  if (HOUR_UNITS.has(token)) return 'hour';
  if (QUARTER_UNITS.has(token)) return 'quarter';
  if (afterDigits && token === HOUR_ABBREVIATION) return 'hour';
  return null;
}

/** Määrä sanana tai numerona; null = ei määrä. */
function quantityOf(token) {
  if (/^\d/.test(token)) {
    const value = Number(token.replace(',', '.'));
    return Number.isFinite(value) ? { value, digits: true, vague: false } : null;
  }
  if (NUMBER_WORDS.has(token)) return { value: NUMBER_WORDS.get(token), digits: false, vague: false };
  if (FRACTION_WORDS.has(token)) return { value: FRACTION_WORDS.get(token), digits: false, vague: false };
  if (VAGUE_WORDS.has(token)) return { value: null, digits: false, vague: true };
  return null;
}

/** Yksi kesto kohdasta i: { unit, minutes|null, vague, from, to } tai null. */
function durationAt(tokens, i) {
  const token = tokens[i].text;
  const quantity = quantityOf(token);
  if (quantity) {
    const next = tokens[i + 1];
    if (!next) return null;
    const unit = unitOf(next.text, quantity.digits);
    if (!unit) return null;
    // "klo 8 tunnin ..." -- numero on kellonaika, ei määrä.
    if (quantity.digits && i > 0 && CLOCK_WORDS.has(tokens[i - 1].text)) return null;
    if (unit === 'quarter' && tokens[i + 2] && CLOCK_FOLLOWERS.has(tokens[i + 2].text)) return null;
    if (quantity.vague) return { unit, minutes: null, vague: true, from: i, to: i + 1 };
    return { unit, minutes: quantity.value * UNIT_MINUTES[unit], vague: false, from: i, to: i + 1 };
  }
  // Yksikkö ilman lukua.
  const followsClock = tokens[i + 1] && CLOCK_FOLLOWERS.has(tokens[i + 1].text);
  if (BARE_HOUR.has(token)) return { unit: 'hour', minutes: 60, vague: false, from: i, to: i };
  if (BARE_QUARTER.has(token) && !followsClock) return { unit: 'quarter', minutes: 15, vague: false, from: i, to: i };
  if (BARE_MINUTE.has(token)) return { unit: 'minute', minutes: 1, vague: false, from: i, to: i };
  return null;
}

function finish(entry, tokens, lower) {
  const first = tokens[entry.from];
  const last = tokens[entry.to];
  const before = entry.from > 0 ? tokens[entry.from - 1].text : null;
  const after = entry.to + 1 < tokens.length ? tokens[entry.to + 1].text : null;
  const base = {
    expr: lower.slice(first.start, last.end),
    start: first.start,
    end: last.end,
    precededBy: before,
    followedBy: after
  };
  if (entry.vague || entry.minutes === null) {
    return Object.freeze({ minutes: null, ambiguous: true, reason: DURATION_REASON.VAGUE, ...base });
  }
  const minutes = Math.round(entry.minutes);
  if (!Number.isFinite(minutes) || minutes < 1) {
    return Object.freeze({ minutes: null, ambiguous: true, reason: DURATION_REASON.INVALID, ...base });
  }
  if (minutes > MAX_DURATION_MINUTES) {
    return Object.freeze({ minutes: null, ambiguous: true, reason: DURATION_REASON.TOO_LONG, ...base });
  }
  return Object.freeze({ minutes, ambiguous: false, reason: DURATION_REASON.NONE, ...base });
}

/**
 * Kaikki kestoilmaukset tekstissä järjestyksessä.
 *
 * Jokaisella on `start`/`end` (merkkikohdat NFC-muotoisessa, pienaakkosiksi
 * muutetussa tekstissä) sekä edeltävä ja seuraava sana, jotta kutsuja voi
 * erottaa keston ("kestää tunnin") ajankohdasta ("tunnin päästä").
 *
 * Tunti ja sitä seuraavat minuutit ovat yksi kesto: "tunti ja vartti" = 75,
 * "1 h 30 min" = 90.
 *
 * @param {string} text
 * @returns {ReadonlyArray<{minutes:number|null, ambiguous:boolean, reason:string,
 *          expr:string, start:number, end:number, precededBy:string|null, followedBy:string|null}>}
 */
export function findFinnishDurations(text) {
  if (typeof text !== 'string' || text.length === 0) return Object.freeze([]);
  const lower = text.normalize('NFC').toLocaleLowerCase('fi');
  const tokens = tokenize(lower);
  const found = [];

  let i = 0;
  while (i < tokens.length) {
    const entry = durationAt(tokens, i);
    if (!entry) {
      i += 1;
      continue;
    }
    // Tunnin perään voi tulla minuutit tai vartti: "tunti ja vartti", "2 h 15 min".
    if (entry.unit === 'hour' && !entry.vague) {
      let j = entry.to + 1;
      if (tokens[j] && tokens[j].text === 'ja') j += 1;
      const tail = j < tokens.length ? durationAt(tokens, j) : null;
      if (tail && !tail.vague && (tail.unit === 'minute' || tail.unit === 'quarter')) {
        entry.minutes += tail.minutes;
        entry.to = tail.to;
      }
    }
    found.push(finish(entry, tokens, lower));
    i = entry.to + 1;
  }
  return Object.freeze(found);
}

/**
 * Tekstin kesto yhtenä lukuna.
 *
 * - Ei kestoa: { minutes: null, ambiguous: false, expr: null }
 * - Yksi selvä kesto (sama kahdesti on yksi): { minutes, ambiguous: false, expr }
 * - Epämääräinen, liian pitkä tai kaksi eri kestoa: { minutes: null, ambiguous: true }
 *
 * @param {string} text
 * @returns {{minutes:number|null, ambiguous:boolean, expr:string|null, reason:string}}
 */
export function parseFinnishDuration(text) {
  const entries = findFinnishDurations(text);
  if (entries.length === 0) {
    return Object.freeze({ minutes: null, ambiguous: false, expr: null, reason: DURATION_REASON.NONE });
  }
  const unclear = entries.find(entry => entry.ambiguous);
  if (unclear) {
    return Object.freeze({ minutes: null, ambiguous: true, expr: unclear.expr, reason: unclear.reason });
  }
  const distinct = new Set(entries.map(entry => entry.minutes));
  if (distinct.size > 1) {
    return Object.freeze({ minutes: null, ambiguous: true, expr: entries[0].expr, reason: DURATION_REASON.MULTIPLE });
  }
  return Object.freeze({ minutes: entries[0].minutes, ambiguous: false, expr: entries[0].expr, reason: DURATION_REASON.NONE });
}
