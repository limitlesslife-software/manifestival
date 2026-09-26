// Ajonaikainen skeemakyvykkyys: mitä kanta OIKEASTI tukee juuri nyt.
//
// MIKSI TÄMÄ ON OLEMASSA
//
// Portit (src/data/schema.js) ovat käännösaikaisia vakioita. Asennettu
// APK kantaa omat vakionsa mukanaan, ja jokaisella migraatiolla 0009-0013
// on dokumentoitu peruutus. Sovellus voi siis olla kantaa EDELLÄ: portti on
// auki, mutta taulua tai saraketta ei ole. Silloin jokainen tallennus
// kaatuisi (PGRST204/PGRST205) ja lukeminen näyttäisi silti toimivan.
//
// Tämä moduuli pitää kirjaa siitä, mitä käynnistyksen tarkistus
// (src/data/schemaProbe.js) ja kannan virheet ovat kertoneet.
//
// YKSI SÄÄNTÖ: AJONAIKAINEN TIETO VOI VAIN LASKEA, EI KOSKAAN NOSTAA.
//
//   tehokas = käännösaikainen portti JA ei laskettu ajon aikana
//
// Kiinni oleva portti ei avaudu mistään, mitä kanta vastaa. Siksi
// tarkistus voi olla väärässä vain turvalliseen suuntaan.
//
// KOLME TILAA LASKETULLE TAULULLE (ks. computeCapabilities):
//
//   readonly     taulu on olemassa, vaadittu sarakejoukko puuttuu:
//                lukeminen toimii, kirjoitus torjutaan ennen verkkoa
//   missing      taulua ei ole: lataus palauttaa tyhjän, kirjoitus torjutaan
//   (sarakeportti) sarakkeet jätetään pois kirjoituksista, taulu toimii
//
// HUOLTOTILA: jos ydin (tehtävien perussarakkeet tai profiili) puuttuu tai
// on kielletty, mitään ei kirjoiteta, offline-jonoa ei toisteta eikä uusia
// muutoksia jonoteta. Käyttäjä näkee huoltoilmoituksen.
//
// Moduuli EI tunne vaatimuksia eikä portteja: ne annetaan parametreina
// (src/data/schema.js omistaa ne). Näin tuontisuunta pysyy yksisuuntaisena.

export const SCHEMA_STATUS = Object.freeze({
  /** Tarkistusta ei ole tehty eikä välimuistia ole: käännösaikaiset portit. */
  UNVERIFIED: 'unverified',
  /** Kaikki käytössä olevat vaatimukset löytyivät. */
  OK: 'ok',
  /** Osa uusista ominaisuuksista on laskettu pois; perustoiminnot toimivat. */
  DEGRADED: 'degraded',
  /** Ydin puuttuu: ei kirjoituksia. */
  MAINTENANCE: 'maintenance'
});

/** Tarkistuksen tulos yhdelle vaatimukselle. */
export const PROBE_RESULT = Object.freeze({
  OK: 'ok',
  MISSING_TABLE: 'missing_table',
  MISSING_COLUMN: 'missing_column',
  FORBIDDEN: 'forbidden',
  /** Verkko, aikakatkaisu, 5xx, istunto: ei tiedetä -> ei laske mitään. */
  UNKNOWN: 'unknown'
});

const FAILURES = new Set([PROBE_RESULT.MISSING_TABLE, PROBE_RESULT.MISSING_COLUMN, PROBE_RESULT.FORBIDDEN]);

/** Onko tulos varma puute (laskee kyvykkyyttä)? */
export function isFailure(result) {
  return FAILURES.has(result);
}

/** Onko vaatimus käytössä annetuilla käännösaikaisilla porteilla? */
export function isRequirementOpen(requirement, compile) {
  if (requirement.core) return true;
  if (requirement.kind === 'table') return compile.tables[requirement.tableKey] === true;
  return compile.columns[requirement.gate] === true;
}

/**
 * PUHDAS YDIN: vaatimukset + käännösaikaiset portit + tulokset -> kyvykkyys.
 *
 * Ei tilaa, ei verkkoa, ei kelloa. Testit ajavat tämän synteettisillä
 * porttiyhdistelmillä (aallot C-J) ja kannan tiloilla.
 *
 * @param {object} input
 * @param {ReadonlyArray<object>} input.requirements SCHEMA_REQUIREMENTS
 * @param {{tables: object, columns: object}} input.compile käännösaikaiset portit
 * @param {Record<string, string>} input.results vaatimus -> PROBE_RESULT
 * @param {boolean} [input.verified] onko tietoa ylipäätään (probe tai välimuisti)
 */
export function computeCapabilities({ requirements, compile, results = {}, verified = false }) {
  const missingTables = new Set();
  const readOnlyTables = new Set();
  const loweredColumnGates = new Set();
  const pending = new Set();
  const applied = new Set();
  let maintenance = false;

  const open = requirements.filter(requirement => isRequirementOpen(requirement, compile));
  for (const requirement of open) {
    const result = results[requirement.id];
    if (!isFailure(result)) {
      if (result === PROBE_RESULT.OK) applied.add(requirement.migration);
      continue;
    }
    pending.add(requirement.migration);
    if (requirement.core) {
      maintenance = true;
    } else if (requirement.kind === 'table') {
      if (result === PROBE_RESULT.MISSING_TABLE) missingTables.add(requirement.tableKey);
      else readOnlyTables.add(requirement.tableKey);
    } else {
      loweredColumnGates.add(requirement.gate);
    }
  }

  // Sarakeportti, jonka puuttuminen tekee taulusta vain luettavan (eikä
  // sarakkeiden pois jättäminen riitä). Esimerkki: aikakirjaukset nojaavat
  // operation_id:n idempotenssiin; ilman saraketta uusinta monistaisi rivit.
  for (const requirement of open) {
    if (requirement.lowerAs !== 'readonly' || !loweredColumnGates.has(requirement.gate)) continue;
    if (compile.tables[requirement.tableKey] === true && !missingTables.has(requirement.tableKey)) {
      readOnlyTables.add(requirement.tableKey);
    }
  }

  for (const migration of pending) applied.delete(migration);

  const lowered = missingTables.size + readOnlyTables.size + loweredColumnGates.size;
  const status = maintenance ? SCHEMA_STATUS.MAINTENANCE
    : lowered > 0 ? SCHEMA_STATUS.DEGRADED
      : verified ? SCHEMA_STATUS.OK : SCHEMA_STATUS.UNVERIFIED;

  return Object.freeze({
    status,
    missingTables: Object.freeze([...missingTables].sort()),
    readOnlyTables: Object.freeze([...readOnlyTables].sort()),
    loweredColumnGates: Object.freeze([...loweredColumnGates].sort()),
    appliedMigrations: Object.freeze([...applied].sort()),
    pendingMigrations: Object.freeze([...pending].sort())
  });
}

/**
 * Tehokkaat portit: käännösaikainen JA ei laskettu. Puhdas.
 * Tulos ei voi olla true missään, missä käännösaikainen portti on false.
 */
export function effectiveGates(compile, capabilities) {
  const tables = {};
  for (const [key, open] of Object.entries(compile.tables)) {
    tables[key] = open === true
      && !capabilities.missingTables.includes(key)
      && !capabilities.readOnlyTables.includes(key);
  }
  const columns = {};
  for (const [name, open] of Object.entries(compile.columns)) {
    columns[name] = open === true && !capabilities.loweredColumnGates.includes(name);
  }
  return { tables, columns };
}

// =====================================================================
// MODUULIN TILA
// =====================================================================

const EMPTY = computeCapabilities({ requirements: [], compile: { tables: {}, columns: {} } });

let capabilities = EMPTY;
let source = 'compile';
/** Varmat tulokset tarkistuksesta tai välimuistista (vaatimus -> tulos). */
let probeResults = {};
/**
 * Kannan virheistä päätellyt puutteet: vaatimus -> { result, sticky, seq }.
 *
 * KAKSI LAJIA:
 *
 *   sticky   kirjoituksen PGRST204 (payloadin sarake puuttuu PostgRESTin
 *            skeemavälimuistista). PYSYVÄ ISTUNNON AJAN: GET-tarkistus
 *            kysyy PostgreSQL:ltä, mutta kirjoitus voi yhä kaatua
 *            vanhentuneeseen välimuistiin. Jos onnistunut tarkistus
 *            nollaisi tämän, toisto ja tarkistus ajaisivat toisiaan kehässä.
 *   muu      puuttuva taulu (PGRST205/42P01) tai PostgreSQL:n 42703.
 *            Tarkistus näkee saman asian kuin virhe, joten myöhempi varma
 *            "ok" samalle vaatimukselle poistaa puutteen. Muuten yksi
 *            hetkellinen virhe (esim. huoltokatkon aikana ladattu lista)
 *            pitäisi ominaisuuden poissa sivun lataukseen asti.
 *
 * `seq` kertoo järjestyksen: tarkistus poistaa vain ne puutteet, jotka
 * kirjattiin ENNEN kuin se lähti (ks. reactiveMark).
 */
let reactiveResults = {};
let reactiveSeq = 0;
let verified = false;
let generation = 0;
const listeners = new Set();
let reprobeHandler = null;

function same(a, b) {
  return a.status === b.status
    && ['missingTables', 'readOnlyTables', 'loweredColumnGates', 'appliedMigrations', 'pendingMigrations']
      .every(key => a[key].join(',') === b[key].join(','));
}

function emit(change) {
  const snapshot = schemaSnapshot();
  for (const listener of listeners) {
    try { listener(snapshot, change); } catch { /* näkymän virhe ei kaada tarkistusta */ }
  }
}

function tableLevel(caps, key) {
  if (caps.missingTables.includes(key)) return 0;
  if (caps.readOnlyTables.includes(key)) return 1;
  return 2;
}

/**
 * PUHDAS: taulut, joiden kyvykkyys NOUSI (puuttui -> luettavissa, tai
 * vain luku -> kirjoitettavissa). Näiden tieto on voitu ladata tyhjänä
 * tai niiden kirjoitukset ovat odottaneet: sovellus lataa ja lähettää
 * uudelleen (src/app/schemaStatus.js).
 */
export function raisedTables(previous, next) {
  const keys = new Set([...previous.missingTables, ...previous.readOnlyTables]);
  return [...keys].filter(key => tableLevel(next, key) > tableLevel(previous, key)).sort();
}

/** Yhdistetyt tulokset: reaktiivinen puute voittaa tarkistuksen "ok":n. */
export function currentResults() {
  const merged = { ...probeResults };
  for (const [id, entry] of Object.entries(reactiveResults)) {
    if (isFailure(entry.result)) merged[id] = entry.result;
  }
  return merged;
}

/**
 * Reaktiivisen kirjanpidon merkki. Tarkistus ottaa sen ENNEN pyyntöjä ja
 * antaa sen recordProbeResultsille: vain sitä ennen kirjatut (ei-pysyvät)
 * puutteet voi kumota. Tarkistuksen aikana tullut virhe on sitä tuoreempi.
 */
export function reactiveMark() {
  return reactiveSeq;
}

/** Onko tietoa (tarkistus tai välimuisti) saatu? */
export function isVerified() {
  return verified;
}

/**
 * Tallenna tarkistuksen tulokset. Tuntemattomat (UNKNOWN) eivät korvaa
 * aiempaa tietoa: ne eivät laske eivätkä nosta mitään.
 *
 * Oikean tarkistuksen (from: 'probe') varma "ok" kumoaa saman vaatimuksen
 * ei-pysyvän reaktiivisen puutteen, jos se kirjattiin ennen tarkistuksen
 * lähtöä (`reactiveUpTo`, ks. reactiveMark). Välimuisti ei kumoa mitään:
 * se on vanhempaa tietoa kuin virhe.
 */
export function recordProbeResults(results, { from = 'probe', reactiveUpTo = -Infinity } = {}) {
  const next = { ...probeResults };
  let definite = 0;
  let reactive = reactiveResults;
  for (const [id, result] of Object.entries(results || {})) {
    if (result === PROBE_RESULT.UNKNOWN || result == null) continue;
    next[id] = result;
    definite += 1;
    const noted = reactive[id];
    if (from === 'probe' && result === PROBE_RESULT.OK && noted && !noted.sticky && noted.seq <= reactiveUpTo) {
      reactive = { ...reactive };
      delete reactive[id];
    }
  }
  probeResults = next;
  reactiveResults = reactive;
  if (definite > 0) {
    verified = true;
    source = from;
  }
  return definite;
}

/**
 * Merkitse vaatimukset puuttuviksi kannan virheen perusteella.
 *
 * @param {Record<string,string>} failures vaatimus -> PROBE_RESULT
 * @param {{sticky?: boolean}} [options] sticky: pysyy istunnon loppuun
 *   (kirjoituksen PGRST204); muuten seuraava varma "ok" kumoaa sen
 */
export function recordReactiveFailures(failures, { sticky = false } = {}) {
  let changed = false;
  for (const [id, result] of Object.entries(failures || {})) {
    if (!isFailure(result)) continue;
    const previous = reactiveResults[id];
    const keepSticky = Boolean(sticky || (previous && previous.sticky));
    if (previous && previous.result === result && previous.sticky === keepSticky) continue;
    reactiveSeq += 1;
    reactiveResults = { ...reactiveResults, [id]: { result, sticky: keepSticky, seq: reactiveSeq } };
    changed = true;
  }
  return changed;
}

/**
 * Uloskirjautuminen: kielto (42501) koskee istunnon roolia, ei kantaa.
 * Edellisen käyttäjän (tai kirjautumattoman) kielto ei saa jäädä seuraavan
 * kirjautumisen huoltoilmoitukseksi. Palauttaa poistettujen määrän.
 */
export function clearForbiddenResults() {
  const next = {};
  let removed = 0;
  for (const [id, result] of Object.entries(probeResults)) {
    if (result === PROBE_RESULT.FORBIDDEN) removed += 1;
    else next[id] = result;
  }
  probeResults = next;
  // Pelkkiä kieltoja: kannasta ei tiedetä mitään (seuraava tarkistus kysyy).
  if (removed > 0 && Object.keys(next).length === 0) {
    verified = false;
    source = 'compile';
  }
  return removed;
}

/**
 * Aseta laskettu kyvykkyys. Kuuntelijat kuulevat vain todellisen muutoksen,
 * ja toinen argumentti kertoo sen suunnan: `{ raisedTables }`.
 */
export function setCapabilities(next) {
  if (same(capabilities, next)) return false;
  const previous = capabilities;
  capabilities = next;
  generation += 1;
  emit(Object.freeze({ raisedTables: Object.freeze(raisedTables(previous, next)) }));
  return true;
}

// ---------------------------------------------------------- lukijat

/** Taulun ajonaikainen tila: 'ok', 'readonly' tai 'missing'. */
export function tableState(key) {
  if (capabilities.missingTables.includes(key)) return 'missing';
  if (capabilities.readOnlyTables.includes(key)) return 'readonly';
  return 'ok';
}

export function isTableLowered(key) {
  return tableState(key) !== 'ok';
}

export function isColumnGateLowered(name) {
  return capabilities.loweredColumnGates.includes(name);
}

export function schemaStatus() {
  return capabilities.status;
}

export function isMaintenance() {
  return capabilities.status === SCHEMA_STATUS.MAINTENANCE;
}

/** Saako kantaan kirjoittaa ylipäätään? (false = huoltotila) */
export function isWritable() {
  return !isMaintenance();
}

/** Kasvaa jokaisessa todellisessa muutoksessa. */
export function schemaGeneration() {
  return generation;
}

/** Näkymälle: jäädytetty kopio. EI sisällä taulujen tai sarakkeiden nimiä käyttäjälle. */
export function schemaSnapshot() {
  return Object.freeze({
    status: capabilities.status,
    source,
    generation,
    loweredCount: capabilities.missingTables.length + capabilities.readOnlyTables.length
      + capabilities.loweredColumnGates.length,
    appliedMigrations: capabilities.appliedMigrations,
    pendingMigrations: capabilities.pendingMigrations
  });
}

/**
 * Tilan muutoksen kuuntelija: listener(snapshot, { raisedTables }).
 * Palauttaa peruutusfunktion.
 */
export function subscribeSchemaStatus(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ------------------------------------------------ uudelleentarkistus

/** Sovelluskerros kertoo, miten tarkistus ajetaan uudelleen. */
export function setReprobeHandler(handler) {
  reprobeHandler = typeof handler === 'function' ? handler : null;
}

/** Pyydä uutta tarkistusta (esim. kanta vastasi skeemavirheellä). Ei heitä. */
export function requestReprobe(reason = 'schema_error') {
  if (!reprobeHandler) return false;
  try {
    const result = reprobeHandler(reason);
    if (result && typeof result.catch === 'function') result.catch(() => { /* tarkistus ei kaada kutsujaa */ });
  } catch { /* ignore */ }
  return true;
}

/** Testejä varten: takaisin käännösaikaisiin portteihin. */
export function resetSchemaRuntimeForTests() {
  capabilities = EMPTY;
  source = 'compile';
  probeResults = {};
  reactiveResults = {};
  reactiveSeq = 0;
  verified = false;
  generation += 1;
  reprobeHandler = null;
  listeners.clear();
}
