// Kohteen tunnistus AI-komennoille.
//
// PUHDAS MODUULI. Ei DOM:ia, ei verkkoa, ei kelloa, ei satunnaisuutta.
//
// MIKSI TÄMÄ ON OMA KERROKSENSA
// "Siirrä lääkäriaika huomiselle" on vaaraton lause vain jos sovellus tietää
// TÄSMÄLLEEN mitä siirretään. Jos käyttäjällä on kaksi lääkäriaikaa,
// arvaaminen tarkoittaa väärän tiedon muuttamista — ja käyttäjä huomaa sen
// vasta kun on myöhäistä.
//
// Siksi tunnistuksella on kolme lopputulosta eikä kahta:
//
//   EXACT      tasan yksi kohde. Vasta tämä sallii mutaation.
//   AMBIGUOUS  useita mahdollisia. Sovellus KYSYY, ei valitse.
//   NOT_FOUND  ei yhtään.
//
// AI EI SAA VALITA EPÄSELVÄÄ KOHDETTA. Se on tämän moduulin koko tarkoitus.
//
// FINNISH-HUOMIO: ä, ö ja å EIVÄT ole a:n ja o:n muunnelmia vaan omia
// kirjaimiaan. Niitä ei taiteta pois, koska "sää" ja "saa" ovat eri sanoja —
// ja taittaminen tarkoittaisi väärän kohteen muuttamista. Unicode
// normalisoidaan (NFC), jotta yhdistetty ja hajotettu esitysmuoto vastaavat
// toisiaan.

/** Tunnistuksen lopputulokset. */
export const RESOLUTION = Object.freeze({
  EXACT: 'exact',
  AMBIGUOUS: 'ambiguous',
  NOT_FOUND: 'not_found'
});

/** Kuinka monta vaihtoehtoa käyttäjälle näytetään enintään. */
export const MAX_CANDIDATES = 5;

/**
 * Normalisoi teksti vertailua varten.
 *
 * Tekee: NFC-normalisoinnin, välilyöntien siistimisen, pienaakkostuksen.
 * EI tee: diakriittien taittamista (ks. moduulin selitys).
 */
export function normalizeForMatch(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('fi');
}

/**
 * Osumatasot parhaasta heikoimpaan.
 *
 * Taso ratkaistaan ENNEN monikäsitteisyyttä: jos yksi kohde vastaa
 * täsmälleen ja kolme osittain, täsmällinen voittaa eikä tilanne ole
 * epäselvä. Ilman tasoja "Osta maitoa" jäisi epäselväksi aina kun
 * "Osta maitoa ja leipää" on olemassa.
 */
const TIERS = Object.freeze([
  { name: 'exact', test: (haystack, needle) => haystack === needle },
  { name: 'prefix', test: (haystack, needle) => haystack.startsWith(needle) },
  { name: 'contains', test: (haystack, needle) => haystack.includes(needle) }
]);

/** Kentät, joista kohteen nimi luetaan. Ensimmäinen olemassa oleva voittaa. */
const NAME_FIELDS = Object.freeze(['title', 'name']);

function nameOf(entity) {
  for (const field of NAME_FIELDS) {
    if (entity && entity[field] != null && String(entity[field]).trim()) {
      return String(entity[field]);
    }
  }
  return '';
}

function candidateOf(entity, entityType) {
  return {
    id: entity.id,
    type: entityType,
    label: nameOf(entity),
    date: entity.date ?? entity.dueDate ?? entity.targetDate ?? entity.deadline ?? null,
    entity
  };
}

/**
 * Tunnista kohde nimen perusteella.
 *
 * TAKUUT:
 *  - Deterministinen: sama syöte tuottaa aina saman tuloksen
 *  - EXACT vain kun kohteita on tasan yksi parhaalla osumatasolla
 *  - Ei koskaan valitse epäselvästä joukosta
 *  - Tyhjä hakusana ei koskaan osu mihinkään
 *
 * @param {object} args
 * @param {Array}  args.entities    Haettava joukko
 * @param {string} args.query       Käyttäjän antama nimi
 * @param {string} args.entityType  'task' | 'routine' | 'goal' | 'project' | 'bill'
 * @param {Function} [args.filter]  Lisärajaus, esim. vain avoimet
 * @returns {{status:string, match?:object, candidates:Array, tier?:string, query:string}}
 */
export function resolveByName({ entities = [], query, entityType = 'entity', filter = null }) {
  const needle = normalizeForMatch(query);

  // Tyhjä hakusana osuisi `includes`-tasolla KAIKKEEN. Se on vaarallisin
  // mahdollinen lopputulos, joten se torjutaan ennen kaikkea muuta.
  if (!needle) {
    return { status: RESOLUTION.NOT_FOUND, candidates: [], query: String(query ?? '') };
  }

  const pool = (entities || [])
    .filter(entity => entity && entity.id != null)
    .filter(entity => (filter ? filter(entity) : true));

  for (const tier of TIERS) {
    const hits = pool.filter(entity => tier.test(normalizeForMatch(nameOf(entity)), needle));
    if (hits.length === 0) continue;

    // Deterministinen järjestys: nimi, sitten tunniste. Ilman tätä
    // vaihtoehtolista voisi vaihtaa järjestystä ajokerrasta toiseen.
    const sorted = [...hits].sort((a, b) =>
      String(nameOf(a)).localeCompare(String(nameOf(b)), 'fi')
      || String(a.id).localeCompare(String(b.id)));

    if (sorted.length === 1) {
      return {
        status: RESOLUTION.EXACT,
        match: candidateOf(sorted[0], entityType),
        candidates: [candidateOf(sorted[0], entityType)],
        tier: tier.name,
        query: String(query)
      };
    }

    return {
      status: RESOLUTION.AMBIGUOUS,
      candidates: sorted.slice(0, MAX_CANDIDATES).map(e => candidateOf(e, entityType)),
      totalMatches: sorted.length,
      tier: tier.name,
      query: String(query)
    };
  }

  return { status: RESOLUTION.NOT_FOUND, candidates: [], query: String(query) };
}

/**
 * Tunnista kohde tunnisteella tai nimellä.
 *
 * Tunniste voittaa aina nimen: se on yksiselitteinen. Nimeen turvaudutaan
 * vain kun tunnistetta ei ole.
 */
export function resolveTarget({
  entities = [],
  id = null,
  name = null,
  entityType = 'entity',
  filter = null
}) {
  if (id != null && String(id).trim()) {
    const wanted = String(id);
    const found = (entities || []).find(entity => entity && String(entity.id) === wanted);
    if (found) {
      return {
        status: RESOLUTION.EXACT,
        match: candidateOf(found, entityType),
        candidates: [candidateOf(found, entityType)],
        tier: 'id',
        query: wanted
      };
    }
    return { status: RESOLUTION.NOT_FOUND, candidates: [], query: wanted };
  }

  return resolveByName({ entities, query: name, entityType, filter });
}

/** Vain avoimet tehtävät — valmista ei yleensä siirretä eikä muokata. */
export function openTasksOnly(task) {
  return task && task.completed !== true;
}

/** Vain avoimet laskut — maksettua ei merkitä uudelleen maksetuksi. */
export function unpaidBillsOnly(bill) {
  return bill && bill.status !== 'paid' && bill.status !== 'cancelled';
}

/**
 * Ihmisluettava selitys epäonnistuneesta tunnistuksesta.
 * Käyttöliittymä näyttää tämän — se ei koskaan näytä raakaa tulosta.
 */
export function describeResolution(result, entityType = 'kohde') {
  if (!result) return 'Kohdetta ei voitu tunnistaa.';

  if (result.status === RESOLUTION.NOT_FOUND) {
    return result.query
      ? `Ei löytynyt: "${result.query}".`
      : `Kohdetta ei kerrottu.`;
  }

  if (result.status === RESOLUTION.AMBIGUOUS) {
    const count = result.totalMatches ?? result.candidates.length;
    return `Löytyi ${count} vaihtoehtoa haulle "${result.query}". Valitse mitä tarkoitat.`;
  }

  return `Kohde tunnistettu: ${result.match.label}`;
}
