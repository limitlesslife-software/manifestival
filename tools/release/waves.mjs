// Aktivoinnin julkaisujuna 0003–0008: aaltojen kanoninen määrittely.
//
// MITÄ TÄMÄ ON
//
// Kymmenen porttia avataan tuotantoon viidessä aallossa. Tämä moduuli
// on se yksi paikka, jossa aallot on määritelty: mitkä portit kuuluvat
// mihinkin aaltoon, mikä välimuistiversio kuuluu mihinkin aaltoon ja
// mihin kukin aalto perutaan.
//
// MIKSI OMANA MODUULINAAN EIKÄ src/-puussa
//
// Tämä on JULKAISUTYÖKALU, ei sovelluskoodi. Selaimeen menevä koodi ei
// saa tietää aalloista mitään: portit ovat käännösaikaisia vakioita
// `src/data/schema.js`:ssä, ja juuri se on niiden arvokkain
// ominaisuus — deployattu commit on determinististä tilaa, jota ei voi
// muuttaa ajon aikana eikä käyttäjäkohtaisesti.
//
// Siksi tämä moduuli EI ole `src/`-puussa eikä sitä importoida sieltä.
// Sen käyttäjät ovat testit ja skriptit.
//
// KOLME RIIPPUMATONTA LÄHDETTÄ
//
// Aallon tila todennetaan kolmesta toisistaan riippumattomasta
// tiedostosta, jotka jokainen aaltocommit muuttaa yhdessä:
//
//   1. src/data/schema.js          mitä sovellus oikeasti tekee
//   2. sw.js                       välimuistiversio
//   3. docs/PRODUCTION-STATUS.md   mitä väitämme tehneemme
//
// Yksikään ei yksin riitä. Jos tarkistus lukisi vain schema.js:ää ja
// vertaisi sitä schema.js:stä johdettuun odotukseen, se olisi kehä
// eikä todistaisi mitään. Kolmen lähteen on oltava keskenään
// yhtäpitäviä, ja väärennös vaatisi kaikkien kolmen muuttamista
// johdonmukaisesti — eli täsmälleen sen mitä kelvollinen aaltocommit
// tekee.

/** Kaikki kymmenen porttia siinä järjestyksessä kuin ne ovat schema.js:ssä. */
export const ALL_GATES = Object.freeze([
  'routines', 'routineExceptions',
  'goals', 'projects',
  'notificationPreferences',
  'wellbeing',
  'bills', 'recurringExpenses', 'savingsGoals',
  'aiAudit'
]);

/**
 * Tuotannossa JUURI NYT oleva julkaisu.
 *
 * Kaikki kymmenen porttia kiinni. Tämä on se, mihin perustilan korjaus
 * deployataan — ja se on korjauksen peruutuskohde, ei aaltojen.
 */
export const PRODUCTION = Object.freeze({
  sha: '63a96c5ab90b10a73369cd66e348f4a3774367e2',
  cacheVersion: 'v12'
});

/**
 * Perustila: KORJATTU pohja, jolta juna lähtee.
 *
 * Tämä ei ole sama kuin tuotannossa juuri nyt oleva commit. Tuotannon
 * `63a96c5` sisältää kolme käyttäjän löytämää vikaa:
 *
 *   1. kesto 01:00-02:00 näkyi lomakkeessa kolmenakymmenenä
 *   2. hyvinvointiosio oli otsikon "Miten menee?" takana, eikä sanaa
 *      hyvinvointi esiintynyt käyttöliittymässä lainkaan
 *   3. AI-kirjausketjulla ei ollut kirjoituspolkua
 *
 * Perustilan korjaus deployataan ENSIN, kaikki kymmenen porttia yhä
 * kiinni. Vasta sen jälkeen aallot. Näin porttien avaaminen ei sekoitu
 * korjausten todentamiseen.
 *
 * `sha` on null: tämä tiedosto on osa sitä committia, joten se ei voi
 * sisältää omaa tunnistettaan. Manifesti löytää sen
 * `Release-Wave: BASE` -merkinnästä.
 */
export const BASE = Object.freeze({
  id: 'BASE',
  sha: null,
  cacheVersion: 'v13',
  gates: Object.freeze([])
});

/**
 * Aallot järjestyksessä.
 *
 * JÄRJESTYS ON JOHDETTU VIERASAVAINRIIPPUVUUKSISTA, ei
 * migraationumeroista. `tests/activation-gates.test.mjs` lukee
 * riippuvuudet migraatioista ja kaatuu, jos tämä järjestys rikkoo
 * yhtäkään niistä.
 *
 * `gates` on se joukko, joka avataan TÄSSÄ aallossa. Aiempien aaltojen
 * portit pysyvät auki — kumulatiivinen joukko lasketaan
 * `cumulativeGates()`-funktiolla.
 */
export const WAVES = Object.freeze([
  Object.freeze({
    id: 'A',
    cacheVersion: 'v14',
    readiness: 'READY',
    gates: Object.freeze(['notificationPreferences', 'wellbeing']),
    title: 'Muistutusasetukset ja hyvinvointi',
    rationale:
      'Ei viittauksia mihinkään. Pienin pinta-ala. notification_preferences '
      + 'on lisäksi eri omistajuusmalli (pääavain on omistaja), joten se on '
      + 'syytä todentaa yksin.',
    tables: Object.freeze(['notification_preferences', 'wellbeing_entries'])
  }),
  Object.freeze({
    id: 'B',
    cacheVersion: 'v15',
    readiness: 'READY',
    gates: Object.freeze(['goals', 'projects']),
    title: 'Tavoitteet ja projektit',
    rationale:
      'Viittaavat toisiinsa mutta eivät mihinkään ulkopuoliseen. Ovat '
      + 'viittauskohteita aalloille C ja D, joten ne on avattava ennen niitä.',
    tables: Object.freeze(['goals', 'projects'])
  }),
  Object.freeze({
    id: 'C',
    cacheVersion: 'v16',
    readiness: 'READY',
    gates: Object.freeze(['routines', 'routineExceptions']),
    title: 'Rutiinit ja poikkeukset',
    rationale:
      'routines.goal_id viittaa goals-tauluun, joten B on oltava ensin. '
      + 'Poikkeus viittaa rutiiniin, joten ne kuuluvat samaan aaltoon.',
    tables: Object.freeze(['routines', 'routine_exceptions'])
  }),
  Object.freeze({
    id: 'D',
    cacheVersion: 'v17',
    readiness: 'READY',
    gates: Object.freeze(['recurringExpenses', 'savingsGoals', 'bills']),
    title: 'Talous',
    rationale:
      'bills.recurring_expense_id viittaa recurring_expenses-tauluun ja '
      + 'bills.task_id tasks-tauluun. Toistuvat kulut on siksi avattava '
      + 'viimeistään samassa aallossa kuin laskut.',
    tables: Object.freeze(['recurring_expenses', 'savings_goals', 'bills'])
  }),
  Object.freeze({
    id: 'E',
    cacheVersion: 'v18',
    readiness: 'READY',
    gates: Object.freeze(['aiAudit']),
    title: 'AI-toimintojen kirjausketju',
    rationale:
      'Ei vierasavaimia. Viimeisenä, koska se kirjaa muiden toimintaa — '
      + 'sen kannattaa olla käytössä vasta kun kirjattavaa on.',
    tables: Object.freeze(['ai_action_audit'])
  })
]);

/** Aaltotunnisteet järjestyksessä. */
export const WAVE_IDS = Object.freeze(WAVES.map(w => w.id));

/** Aalto tunnisteella, tai null. `BASE` kelpaa tunnisteeksi. */
export function waveById(id) {
  if (id === 'BASE') return BASE;
  return WAVES.find(w => w.id === id) || null;
}

/** Aallon järjestysnumero (BASE = -1, A = 0, ...), tai null. */
export function waveIndex(id) {
  if (id === 'BASE') return -1;
  const index = WAVES.findIndex(w => w.id === id);
  return index === -1 ? null : index;
}

/**
 * Kaikki portit, jotka ovat auki kun tämä aalto on deployattu —
 * aiemmat aallot mukaan luettuina.
 */
export function cumulativeGates(id) {
  const index = waveIndex(id);
  if (index === null) throw new Error(`Tuntematon aalto: ${id}`);
  const gates = [];
  for (let i = 0; i <= index; i++) gates.push(...WAVES[i].gates);
  return Object.freeze(gates);
}

/**
 * Odotettu porttimatriisi tälle aallolle: jokainen kymmenestä portista
 * ja sen odotettu arvo.
 *
 * Tämä on se joukko, jota vasten `src/data/schema.js` tarkistetaan.
 * Osittainenkin ero on virhe: portti joka avautuu liian aikaisin
 * tuottaa vierasavainvirheitä, ja portti joka jää auki liian pitkäksi
 * aikaa hämärtää sen, mikä aalto vian aiheutti.
 */
export function expectedMatrix(id) {
  const open = new Set(id === 'BASE' ? [] : cumulativeGates(id));
  const matrix = {};
  for (const gate of ALL_GATES) matrix[gate] = open.has(gate);
  return Object.freeze(matrix);
}

/** Aallon odotettu välimuistiversio. */
export function cacheVersionOf(id) {
  const wave = waveById(id);
  if (!wave) throw new Error(`Tuntematon aalto: ${id}`);
  return wave.cacheVersion;
}

/**
 * Mihin tämä aalto perutaan, jos se epäonnistuu tuotannossa?
 *
 * Aina EDELLINEN aalto — ei perustila. Aallon A epäonnistuminen
 * perutaan perustilaan, aallon B epäonnistuminen aaltoon A ja niin
 * edelleen. Näin peruutus sulkee vain ne portit, joiden avaaminen
 * epäonnistui, eikä sellaisia jotka on jo todennettu toimiviksi.
 */
export function rollbackTargetOf(id) {
  const index = waveIndex(id);
  if (index === null) throw new Error(`Tuntematon aalto: ${id}`);
  return index === 0 ? 'BASE' : WAVES[index - 1].id;
}

/**
 * Mitä aaltoa annettu porttimatriisi vastaa?
 *
 * Palauttaa aaltotunnisteen ('BASE', 'A', ...) tai null, jos matriisi
 * ei vastaa YHTÄKÄÄN sallittua tilaa.
 *
 * TÄMÄ ON KOKO TYÖKALUN YDIN. Yksitoista porttia tuottaisi 1024
 * yhdistelmää; niistä vain kuusi on sallittuja. Kaikki muut ovat
 * virheitä — joko portti on avattu liian aikaisin, portti on jäänyt
 * avaamatta tai jokin on sulkeutunut vahingossa. Jokainen näistä on
 * tuotantovirhe, ja jokainen niistä kaatuu tässä.
 */
export function resolveWave(tables) {
  if (!tables || typeof tables !== 'object') return null;

  // Tuntematon portti on aina virhe: se tarkoittaa, että schema.js ja
  // tämä moduuli ovat erkaantuneet toisistaan.
  const keys = Object.keys(tables).sort();
  if (keys.length !== ALL_GATES.length) return null;
  if (keys.join(',') !== [...ALL_GATES].sort().join(',')) return null;

  for (const id of ['BASE', ...WAVE_IDS]) {
    const expected = expectedMatrix(id);
    if (ALL_GATES.every(gate => tables[gate] === expected[gate])) return id;
  }
  return null;
}

/** Ihmisluettava kuvaus matriisista, virheilmoituksia varten. */
export function describeMatrix(tables) {
  return ALL_GATES
    .map(gate => `${gate}=${tables && tables[gate] === true ? 'true' : 'false'}`)
    .join(' ');
}

/**
 * Aaltojen koko suunnitelma taulukkona — julkaisumanifestia ja
 * dokumentaatiota varten.
 */
export function releasePlan() {
  return WAVES.map(wave => Object.freeze({
    id: wave.id,
    title: wave.title,
    cacheVersion: wave.cacheVersion,
    gatesEnabled: [...wave.gates],
    gatesCumulative: [...cumulativeGates(wave.id)],
    gatesDisabled: ALL_GATES.filter(g => !cumulativeGates(wave.id).includes(g)),
    tables: [...wave.tables],
    rollbackTarget: rollbackTargetOf(wave.id),
    rationale: wave.rationale
  }));
}
