// Yhtenäinen paikallinen haku.
//
// PUHDAS MODUULI. Ei DOM:ia, ei verkkoa, ei kelloa, ei satunnaisuutta.
//
// ---------------------------------------------------------------------
// MIKSI HAKU EI OLE SAMA ASIA KUIN KOHTEEN TUNNISTUS
// ---------------------------------------------------------------------
// `src/ai/entityResolver.js` tunnistaa kohteen MUUTOSTA varten. Se on
// tarkoituksella tiukka: epäselvä lopputulos pysäyttää komennon, koska
// väärä osuma tarkoittaisi väärän tiedon muuttamista.
//
// Haku on eri asia. Se ei muuta mitään, joten se saa olla anteliaampi:
// useampi osuma on hyödyllinen tulos, ei ongelma. Siksi haku sietää
// diakriittien puuttumisen ("aani" löytää "ääni"), kun taas resolver ei
// koskaan taita ä:tä a:ksi.
//
// Ero on tietoinen ja sitä ei pidä yhtenäistää.
//
// ---------------------------------------------------------------------
// TURVALLISUUS
// ---------------------------------------------------------------------
// Hakusana ei koskaan päädy säännölliseksi lausekkeeksi. Käyttäjän
// kirjoittama "(" tai "[a-z]{1000}" kaataisi haun tai jumittaisi selaimen
// (ReDoS). Vertailu tehdään merkkijono-operaatioilla.
//
// Hakutulokset eivät sisällä HTML:ää. Korostus palautetaan INDEKSEINÄ,
// jotka käyttöliittymä muuntaa merkinnäksi escapetuksen JÄLKEEN.

/** Haettavat tietotyypit. */
export const SEARCH_TYPE = Object.freeze({
  TASK: 'task',
  ROUTINE: 'routine',
  GOAL: 'goal',
  PROJECT: 'project',
  BILL: 'bill'
});

export const SEARCH_TYPES = Object.freeze(Object.values(SEARCH_TYPE));

const TYPE_LABELS = Object.freeze({
  [SEARCH_TYPE.TASK]: 'Tehtävät',
  [SEARCH_TYPE.ROUTINE]: 'Rutiinit',
  [SEARCH_TYPE.GOAL]: 'Tavoitteet',
  [SEARCH_TYPE.PROJECT]: 'Projektit',
  [SEARCH_TYPE.BILL]: 'Laskut'
});

export function searchTypeLabel(type) {
  return TYPE_LABELS[type] || type;
}

/** Enintään näin monta osumaa per tietotyyppi. */
export const MAX_RESULTS_PER_TYPE = 8;

/** Lyhin hakusana. Yksi merkki osuisi lähes kaikkeen eikä kertoisi mitään. */
export const MIN_QUERY_LENGTH = 2;

/**
 * Normalisoi teksti hakua varten.
 *
 * Taittaa yhdistyvät diakriitit, jotta "aani" löytää "ääni". Tämä on
 * turvallista HAUSSA, koska haku ei muuta mitään — toisin kuin
 * entityResolver, jossa taittaminen voisi osua väärään kohteeseen.
 */
export function normalizeForSearch(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')  // yhdistyvät diakriitit pois
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Mitkä kentät kustakin tietotyypistä haetaan. */
const SEARCHABLE_FIELDS = Object.freeze({
  [SEARCH_TYPE.TASK]: ['title', 'description', 'note'],
  [SEARCH_TYPE.ROUTINE]: ['title', 'description'],
  [SEARCH_TYPE.GOAL]: ['title', 'description'],
  [SEARCH_TYPE.PROJECT]: ['name', 'description'],
  [SEARCH_TYPE.BILL]: ['name', 'note']
});

function labelOf(entity, type) {
  const primary = SEARCHABLE_FIELDS[type][0];
  return String(entity[primary] ?? '');
}

/**
 * Osuman laatu. Suurempi on parempi.
 *
 * Järjestys on tärkeä: käyttäjä odottaa täsmällisen osuman ensimmäiseksi,
 * ei aakkosjärjestystä.
 */
const SCORE = Object.freeze({
  EXACT: 100,
  PREFIX: 60,
  WORD_START: 40,
  CONTAINS: 20,
  SECONDARY_FIELD: 5
});

/**
 * Pisteytä yksi kenttä hakusanaa vasten.
 * @returns {{score:number, index:number}|null}
 */
function scoreField(text, needle, isPrimary) {
  const haystack = normalizeForSearch(text);
  if (!haystack) return null;

  const index = haystack.indexOf(needle);
  if (index === -1) return null;

  let score;
  if (haystack === needle) score = SCORE.EXACT;
  else if (index === 0) score = SCORE.PREFIX;
  else if (haystack[index - 1] === ' ') score = SCORE.WORD_START;
  else score = SCORE.CONTAINS;

  // Osuma kuvauksessa on vähemmän merkittävä kuin otsikossa.
  if (!isPrimary) score = Math.max(1, score - SCORE.EXACT + SCORE.SECONDARY_FIELD);

  return { score, index };
}

/**
 * Etsi yhdestä joukosta.
 *
 * @returns {Array<{id, type, label, score, matchIndex, matchLength, entity}>}
 */
/**
 * Onko kohde yha ajankohtainen?
 *
 * Tuntematon muoto tulkitaan ajankohtaiseksi: haku ei saa piilottaa
 * mitaan sen takia, ettei se tunnista kentta.
 */
function isActive(entity) {
  if (entity.completed === true) return false;
  if (entity.active === false) return false;

  const status = typeof entity.status === 'string' ? entity.status : null;
  if (status && ['archived', 'completed', 'abandoned', 'cancelled', 'paid']
    .includes(status)) return false;

  return true;
}

export function searchCollection({ entities = [], query, type }) {
  const needle = normalizeForSearch(query);
  if (needle.length < MIN_QUERY_LENGTH) return [];

  const fields = SEARCHABLE_FIELDS[type];
  if (!fields) return [];

  const results = [];

  for (const entity of entities) {
    if (!entity || entity.id == null) continue;

    let best = null;
    for (const [position, field] of fields.entries()) {
      const scored = scoreField(entity[field], needle, position === 0);
      if (!scored) continue;
      if (!best || scored.score > best.score) {
        best = { ...scored, field, isPrimary: position === 0 };
      }
    }

    if (!best) continue;

    results.push({
      id: String(entity.id),
      type,
      label: labelOf(entity, type),
      field: best.field,
      score: best.score,
      /** Onko kohde yha ajankohtainen. Vaikuttaa vain jarjestykseen. */
      active: isActive(entity),
      /** Korostus indekseinä — käyttöliittymä escapettaa ensin. */
      matchIndex: best.isPrimary ? best.index : -1,
      matchLength: best.isPrimary ? needle.length : 0,
      entity
    });
  }

  // Deterministinen jarjestys: ajankohtaisuus, pisteet, nimi, tunniste.
  //
  // AJANKOHTAISUUS ON ENSIN, ja se on tarkoituksellinen paatos.
  // Arkistoidut ja valmiit LOYTYVAT - kayttaja tietaa arkistoineensa
  // jotain ja haluaa loytaa sen - mutta ne eivat saa ohittaa
  // ajankohtaista samalla osuvuudella. Komentopaletti kohdistaa
  // Enterin parhaaseen osumaan, joten jarjestys ei ole vain
  // mukavuuskysymys.
  return results
    .sort((a, b) => (b.active === true) - (a.active === true)
      || b.score - a.score
      || a.label.localeCompare(b.label, 'fi')
      || a.id.localeCompare(b.id))
    .slice(0, MAX_RESULTS_PER_TYPE);
}

/**
 * Etsi kaikista tietotyypeistä ja ryhmittele tulokset.
 *
 * TAKUUT:
 *  - Deterministinen
 *  - Hakusana ei koskaan päädy säännölliseksi lausekkeeksi
 *  - Tulokset eivät sisällä HTML:ää
 *  - Enintään MAX_RESULTS_PER_TYPE osumaa per tyyppi
 *
 * @param {object} args
 * @param {string} args.query
 * @param {object} args.collections { tasks, routines, goals, projects, bills }
 * @returns {{query:string, groups:Array, total:number, tooShort:boolean}}
 */
export function searchAll({ query, collections = {} }) {
  const needle = normalizeForSearch(query);

  if (needle.length < MIN_QUERY_LENGTH) {
    return { query: String(query ?? ''), groups: [], total: 0, tooShort: true };
  }

  const sources = [
    [SEARCH_TYPE.TASK, collections.tasks],
    [SEARCH_TYPE.ROUTINE, collections.routines],
    [SEARCH_TYPE.GOAL, collections.goals],
    [SEARCH_TYPE.PROJECT, collections.projects],
    [SEARCH_TYPE.BILL, collections.bills]
  ];

  const groups = [];
  let total = 0;

  for (const [type, entities] of sources) {
    const results = searchCollection({ entities: entities || [], query, type });
    if (results.length === 0) continue;
    groups.push({ type, label: searchTypeLabel(type), results });
    total += results.length;
  }

  // Ryhmät parhaan osuman mukaan: käyttäjä odottaa relevanteinta ylimmäs,
  // ei aina tehtäviä ensin.
  groups.sort((a, b) => b.results[0].score - a.results[0].score
    || a.type.localeCompare(b.type));

  return { query: String(query), groups, total, tooShort: false };
}

/**
 * Paras yksittäinen osuma kaikista ryhmistä.
 * Komentopaletti käyttää tätä Enter-näppäimen kohteena.
 */
export function bestMatch(searchResult) {
  if (!searchResult || searchResult.groups.length === 0) return null;
  return searchResult.groups[0].results[0] || null;
}
