// Käyttäjän oman datan vienti ja tuonti.
//
// PUHDAS MODUULI. Ei DOM:ia, ei verkkoa, ei kelloa — aikaleima annetaan
// parametrina.
//
// ---------------------------------------------------------------------
// MIKSI TÄMÄ ON OLEMASSA
// ---------------------------------------------------------------------
// Tieto on käyttäjän, ei sovelluksen. Jos sovelluksesta ei pääse ulos, se
// ei ole työkalu vaan ansa. Konseptidokumentin luku 24 vaatii tämän, ja
// se on myös tietosuojan perusta.
//
// ---------------------------------------------------------------------
// MITÄ EI VIEDÄ — EIKÄ MISSÄÄN OLOSUHTEISSA
// ---------------------------------------------------------------------
//   - API-avaimet
//   - istuntotokenit, refresh-tokenit
//   - salasanat tai niiden tiivisteet
//   - Supabase-avaimet tai -konfiguraatio
//   - sisäiset autentikaatiokentät
//
// Vienti on tiedosto, joka päätyy latauskansioon, pilveen ja mahdollisesti
// sähköpostiin. Salaisuus siinä olisi salaisuus kaikkialla. Tämä on lukittu
// testillä, joka käy koko vientipuun läpi kenttä kentältä.

/**
 * Vientimuodon versio.
 *
 * Nostetaan aina kun rakenne muuttuu YHTEENSOPIMATTOMASTI. Tuonti tarkistaa
 * tämän ensimmäisenä: tuntemattoman version lukeminen arvaamalla olisi
 * paras tapa turmella käyttäjän tiedot.
 */
export const EXPORT_VERSION = 1;

/** Tunniste, josta tiedosto tunnistetaan Manifestivalin vienniksi. */
export const EXPORT_KIND = 'manifestival-export';

/**
 * Tietotyypit, jotka vienti kattaa.
 *
 * Lista on nimenomainen eikä johdettu tilasta: näin uusi tilakenttä ei
 * päädy vientiin vahingossa. Uuden tietotyypin lisääminen on tietoinen
 * päätös, ei sivuvaikutus.
 */
export const EXPORTED_COLLECTIONS = Object.freeze([
  'tasks',
  'routines',
  'routineExceptions',
  'goals',
  'projects',
  'bills',
  'recurringExpenses',
  'savingsGoals',
  'wellbeing',
  'notificationPreferences',
  'profile',
  'aiAudit',

  // Talous 2.0. Nämä ovat käyttäjän omaa taloushistoriaa, ja vienti
  // ilman niitä menettäisi sen hiljaa.
  //
  // KUITIN KUVAA EI OLE MISSÄÄN NÄISTÄ. Luenta on väliaikainen eikä se
  // ole kokoelma lainkaan; hyväksytystä luennasta jää vain tapahtuma,
  // jonka mallissa ei ole kuvakenttää. Ks. src/domain/receipts.js.
  'transactions',
  'investments',

  // Välitavoitteet. Käyttäjän omaa pysyvää dataa, ja vienti ilman
  // niitä menettäisi tavoitteiden rakenteen hiljaa.
  //
  // SUUNNITELMAEHDOTUKSET EIVÄT OLE TÄSSÄ eivätkä tule. Ne ovat
  // väliaikaisia: hyväksytystä ehdotuksesta jää tavoite,
  // välitavoitteet, projektit ja tehtävät, ja ehdotus itse katoaa.
  // Hylätty ehdotus on roskaa, joka ei koskaan katoaisi viennistä.
  'milestones'
]);

/**
 * Kentät, jotka poistetaan viennistä riippumatta siitä mistä ne tulevat.
 *
 * Suodatus tehdään NIMEN perusteella koko puusta eikä tyyppikohtaisesti:
 * jos jokin uusi rivi joskus kantaa tokenia, se putoaa pois ilman että
 * kukaan muistaa lisätä sääntöä.
 */
export const REDACTED_FIELDS = Object.freeze([
  'user_id', 'userId',
  'password', 'passwordHash', 'salt',
  'token', 'accessToken', 'refreshToken', 'idToken', 'sessionToken',
  'apiKey', 'anonKey', 'serviceRoleKey', 'secret', 'clientSecret',
  'authorization', 'session', 'credentials'
]);

const REDACTED_LOWER = new Set(REDACTED_FIELDS.map(field => field.toLowerCase()));

/**
 * Poista arkaluontoiset kentät rekursiivisesti.
 *
 * Toimii myös sisäkkäisille rakenteille, koska tulevaisuuden tietotyyppi
 * voi olla syvempi kuin nykyiset.
 */
export function redact(value, depth = 0) {
  // Syvyysraja estää syklisen rakenteen aiheuttaman ikuisen rekursion.
  if (depth > 12) return null;

  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));

  if (value && typeof value === 'object') {
    const cleaned = {};
    for (const [key, item] of Object.entries(value)) {
      if (REDACTED_LOWER.has(key.toLowerCase())) continue;
      cleaned[key] = redact(item, depth + 1);
    }
    return cleaned;
  }

  return value;
}

/**
 * Kokoa käyttäjän datan vienti.
 *
 * PUHDAS FUNKTIO. Ottaa datan, palauttaa vientiolion. Ei lue tilaa, ei
 * kirjoita tiedostoa, ei tunne selainta.
 *
 * @param {object} data      Kokoelmat nimillä (ks. EXPORTED_COLLECTIONS)
 * @param {object} [options]
 * @param {string} [options.exportedAt] ISO-aikaleima
 * @param {string} [options.appVersion]
 * @returns {object} vientiolio
 */
export function buildUserDataExport(data = {}, options = {}) {
  const collections = {};

  for (const name of EXPORTED_COLLECTIONS) {
    const value = data[name];
    if (value === undefined || value === null) {
      // Puuttuva kokoelma viedään tyhjänä eikä jätetä pois: tuonti näkee
      // silloin eron "ei ollut mitään" ja "kenttää ei ollut olemassa".
      collections[name] = Array.isArray(data[name]) ? [] : (isObjectCollection(name) ? {} : []);
      continue;
    }
    collections[name] = redact(value);
  }

  return {
    kind: EXPORT_KIND,
    manifestivalExportVersion: EXPORT_VERSION,
    exportedAt: options.exportedAt ?? null,
    appVersion: options.appVersion ?? null,
    /** Rivimäärät nopeaan tarkistukseen ilman koko puun lukemista. */
    counts: countCollections(collections),
    data: collections
  };
}

/** Kokoelmat, jotka ovat yksi olio eivätkä lista. */
function isObjectCollection(name) {
  return name === 'profile' || name === 'notificationPreferences';
}

function countCollections(collections) {
  const counts = {};
  for (const [name, value] of Object.entries(collections)) {
    counts[name] = Array.isArray(value) ? value.length : (value && typeof value === 'object' ? 1 : 0);
  }
  return counts;
}

/** Vienti tekstiksi. Sisennys on tarkoituksellinen: tiedosto on luettava. */
export function serializeExport(exported) {
  return JSON.stringify(exported, null, 2);
}

// ============================================================== TUONTI

/** Tuonnin lopputulokset. */
export const IMPORT_STATUS = Object.freeze({
  OK: 'ok',
  INVALID_JSON: 'invalid_json',
  NOT_MANIFESTIVAL: 'not_manifestival',
  UNSUPPORTED_VERSION: 'unsupported_version',
  INVALID_STRUCTURE: 'invalid_structure'
});

/**
 * Jäsennä ja validoi tuontitiedosto.
 *
 * EI KIRJOITA MITÄÄN. Palauttaa esikatselun, jonka käyttäjä hyväksyy tai
 * hylkää. Massakirjoitus ilman esikatselua olisi paras tapa tuhota
 * olemassa oleva data yhdellä väärällä tiedostolla.
 *
 * @param {string} text tiedoston sisältö
 * @returns {{status:string, reason?:string, preview?:object, parsed?:object}}
 */
export function parseImport(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    return { status: IMPORT_STATUS.INVALID_JSON, reason: 'Tiedosto ei ole kelvollista JSONia.' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: IMPORT_STATUS.INVALID_STRUCTURE, reason: 'Tiedoston rakenne ei kelpaa.' };
  }

  if (parsed.kind !== EXPORT_KIND) {
    return {
      status: IMPORT_STATUS.NOT_MANIFESTIVAL,
      reason: 'Tiedosto ei ole Manifestivalin vienti.'
    };
  }

  const version = Number(parsed.manifestivalExportVersion);
  if (!Number.isInteger(version) || version < 1) {
    return {
      status: IMPORT_STATUS.UNSUPPORTED_VERSION,
      reason: 'Vientiversio puuttuu tai ei kelpaa.'
    };
  }
  if (version > EXPORT_VERSION) {
    // Uudempi versio voi sisältää rakenteita, joita tämä versio ei
    // ymmärrä. Arvaaminen turmelisi tiedot.
    return {
      status: IMPORT_STATUS.UNSUPPORTED_VERSION,
      reason: `Tiedosto on uudempaa versiota (${version}) kuin tämä sovellus tukee (${EXPORT_VERSION}).`
    };
  }

  if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    return { status: IMPORT_STATUS.INVALID_STRUCTURE, reason: 'Tiedostosta puuttuu data-osio.' };
  }

  return {
    status: IMPORT_STATUS.OK,
    parsed,
    preview: buildImportPreview(parsed)
  };
}

/**
 * Esikatselu: mitä tiedosto sisältää ja mitä tuonti tekisi.
 *
 * Ei vertaa nykyiseen dataan — konfliktianalyysi on erillinen askel, joka
 * tarvitsee nykytilan. Tämä kertoo vain mitä tiedostossa on.
 */
export function buildImportPreview(parsed) {
  const collections = [];

  for (const name of EXPORTED_COLLECTIONS) {
    const value = parsed.data ? parsed.data[name] : undefined;
    const count = Array.isArray(value)
      ? value.length
      : (value && typeof value === 'object' ? 1 : 0);

    collections.push({ name, count, present: value !== undefined });
  }

  return {
    version: Number(parsed.manifestivalExportVersion),
    exportedAt: parsed.exportedAt ?? null,
    appVersion: parsed.appVersion ?? null,
    collections,
    totalRows: collections.reduce((sum, entry) => sum + entry.count, 0)
  };
}

/**
 * Vertaa tuotavaa dataa nykyiseen.
 *
 * Kertoo mikä olisi uutta ja mikä törmäisi olemassa olevaan tunnisteeseen.
 * EI ratkaise törmäystä — se on käyttäjän päätös, ja tässä aallossa
 * kirjoitusta ei tehdä lainkaan.
 */
export function analyzeImportConflicts(parsed, current = {}) {
  const conflicts = [];

  for (const name of EXPORTED_COLLECTIONS) {
    const incoming = parsed.data ? parsed.data[name] : undefined;
    if (!Array.isArray(incoming)) continue;

    const existing = Array.isArray(current[name]) ? current[name] : [];
    const existingIds = new Set(existing.map(row => row && String(row.id)));

    const incomingIds = incoming
      .filter(row => row && row.id != null)
      .map(row => String(row.id));

    const collides = incomingIds.filter(id => existingIds.has(id));

    conflicts.push({
      name,
      incoming: incoming.length,
      existing: existing.length,
      newRows: incomingIds.length - collides.length,
      collisions: collides.length
    });
  }

  return {
    conflicts,
    totalCollisions: conflicts.reduce((sum, entry) => sum + entry.collisions, 0),
    totalNew: conflicts.reduce((sum, entry) => sum + entry.newRows, 0)
  };
}
