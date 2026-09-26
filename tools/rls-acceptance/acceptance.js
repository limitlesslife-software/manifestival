// Tuotannon RLS-eristystestin logiikka (T1-T5).
//
// MIKSI TÄMÄ ON OLEMASSA
//
// Koko repossa on täsmälleen yksi asia, jota ei voi testata lukemalla:
// toimiiko RLS oikeasti. Kaikki muut testit lukevat SQL:ää tekstinä. Ne
// todistavat että migraatio SANOO oikeat asiat — eivät sitä, että
// tietokanta TEKEE ne.
//
// TÄMÄ MODUULI EI SAA HUIJATA
//
// Testin arvo riippuu kokonaan siitä, mitä reittiä kyselyt kulkevat.
// Jos ne ajetaan SQL-editorissa `set local role authenticated` -tempulla,
// testataan vain politiikkojen lauseketta — ei anon-avainta, ei JWT:n
// todennusta, ei PostgRESTiä, ei sitä pinoa jota oikea käyttäjä käyttää.
// Siksi tämä moduuli saa vain supabase-js-clientejä, jotka on kirjattu
// sisään oikealla salasanalla oikeaan tuotantoprojektiin täsmälleen
// samalla julkisella anon-avaimella kuin sovellus.
//
// RLS:n ohittavaa palvelinavainta ei ole täällä eikä selaimessa. Jos se
// olisi, jokainen kielto menisi läpi ja testi kertoisi vain siitä.
//
// TURVAPERIAATTEET
//
//   1. Tilin A 36 oikeaa tehtävää ja profiili eivät ole testin kohteena.
//      Kiellon todistamiseen luodaan A:n omistama SYÖTTIRIVI, jolla on
//      sama omistaja ja siten täsmälleen sama RLS-raja. Jos RLS olisi
//      rikki, vahinko kohdistuu heitettävään riviin.
//   2. Profiilia ei voi monistaa (PK = id, yksi rivi per käyttäjä).
//      Siksi B:n yritys kirjoittaa A:n profiiliin tehdään ARVOT
//      SÄILYTTÄVÄNÄ: payload on A:n nykyiset arvot. Jos RLS pettäisi,
//      rivi kirjoittuisi itsekseen eikä mikään muutu.
//   3. Profiilin DELETE-kieltoa ei testata A:n riviä vastaan lainkaan —
//      sitä ei voi tehdä vaarattomasti. Se testataan toisesta suunnasta
//      (T5): A yrittää poistaa B:n väliaikaisen profiilin. Sama
//      politiikkaperhe, sama predikaatti, nollariski.
//   4. Jokainen testin luoma rivi tunnistetaan etuliitteestä
//      MARKER_PREFIX. Siivous kohdistuu vain siihen. Ei koskaan laajaa
//      DELETEä.
//   5. Nolla riviä RLS:n vuoksi ja virhe verkossa ovat ERI ASIA. Virhe
//      ei koskaan tuota PASSia — se tuottaa ERRORin. Muuten katkennut
//      yhteys näyttäisi täydelliseltä tietoturvalta.
//
// TUOTANTOA VASTEN, EI KOSKAAN AUTOMAATTISESTI
//
// Ajo vaatii omistajan kertakäyttöisen toisen tilin (B) ja omistajan
// nimenomaisen luvan jokaiselle ajolle. Migraatioiden 0009–0013 taulut
// (tableSpecs.js) ajetaan vain, kun ajaja valitsee aallon, jonka
// migraatiot tuotannossa on ajettu. Ks. docs/RLS-ACCEPTANCE.md.

import {
  TABLE_SPECS, COMPOSITE_FK_PROBES, CLEANUP_ORDER, ACCEPTANCE_WAVES,
  DEFAULT_ACCEPTANCE_WAVE, inWave, specFor
} from './tableSpecs.js';

/**
 * Etuliite, jonka jokainen tämän testin luoma rivi saa.
 *
 * Nimiavaruus on tarkoituksella pitkä ja tylsä. Se ei ole kosmetiikkaa:
 * siivous kohdistuu tähän etuliitteeseen, joten etuliitteen ja oikean
 * tehtävätunnisteen törmäys tarkoittaisi käyttäjän datan poistamista.
 * Sovelluksen omat tunnisteet ovat lyhyitä ja väliviivallisia, joten
 * alaviivoin kirjoitettu ja tuotteen nimellä alkava etuliite ei voi
 * syntyä vahingossa.
 */
export const MARKER_PREFIX = 'manifestival_rls_acceptance_';

/** Tilan arvot. PASS vaatii että odotus toteutui ilman virhettä. */
export const STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  ERROR: 'ERROR',
  SKIP: 'SKIP'
});

/** PostgreSQL: insufficient_privilege. Sekä RLS-hylkäys että puuttuva GRANT. */
const INSUFFICIENT_PRIVILEGE = '42501';

/**
 * PostgreSQL: foreign_key_violation.
 *
 * Tama on E4:n odotettu tulos eika 42501. Ero on olennainen: 42501
 * tarkoittaisi, etta RLS hylkasi rivin, ja 23503 sita etta
 * yhdistelmavierasavain hylkasi sen. Vain jalkimmainen todistaa, ettei
 * poikkeusta voi kiinnittaa toisen kayttajan rutiiniin.
 */
const FOREIGN_KEY_VIOLATION = '23503';

/** Testin luomien rivien tunnisteet yhdestä ajotunnuksesta. */
/**
 * Kelvollinen mutta olematon UUID.
 *
 * Nolla-UUID on syntaktisesti oikea eika ole kenenkaan tunniste:
 * auth.users-tunnisteet ovat satunnaisia. Sita kaytetaan kohteena
 * niissa anon-testeissa, joissa taulun avain on uuid — ks.
 * ANON_KOHTEET.
 */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** ISO-paiva N vuorokautta annetusta, UTC:ssa. */
function dayOffset(iso, days) {
  const paiva = new Date(`${iso}T00:00:00Z`);
  paiva.setUTCDate(paiva.getUTCDate() + days);
  return paiva.toISOString().slice(0, 10);
}

/**
 * Poikkeusten paivamaarat, yksi kutakin kiinnityskohdetta kohti.
 *
 * LOYTYNYT VIKA, JOTA TAMA KORJAA
 *
 * Rajoite on `unique (routine_id, date)` — RUTIINIkohtainen, ei
 * kayttajakohtainen. Kaikki poikkeusfikstuurit kayttivat samaa paivaa
 * `today`, ja E1 loi A:n poikkeuksen pariin (A:n rutiini, today).
 *
 * Kun E4 sitten yritti kiinnittaa B:n poikkeuksen SAMAAN rutiiniin
 * SAMALLE paivalle, PostgreSQL torjui rivin yksikasitteisyysindeksiin
 * — koodilla 23505 — eika koskaan paassyt yhdistelmavierasavaimeen
 * asti. Testi ei siis todistanut sita mita sen piti todistaa.
 *
 * Jarjestys kannassa on: RLS WITH CHECK -> yksikasitteisyysindeksi ->
 * vierasavaimen liipaisin. E3c saa siksi yha 42501:n (RLS torjuu sen
 * ensin), mutta E4 lapaisee RLS:n — sen rivin omistaja ON B — ja
 * pysahtyi indeksiin.
 *
 * Korjaus: jokainen A:n rutiiniin kohdistuva fikstuuri saa OMAN
 * paivansa. Silloin yksikasitteisyys ei ole tiella, ja jokainen testi
 * kohtaa sen rajoitteen jonka se on tarkoitettu kohtaamaan.
 *
 * Paivat johdetaan ajon `today`-arvosta, joten ne ovat deterministisia
 * eivatka riipu kellonajasta.
 */
export function exceptionDates(today) {
  return Object.freeze({
    // E1: A:n oma poikkeus A:n rutiiniin.
    ownA: today,
    // E3c: B:n vaarennos A:n nimiin, A:n rutiiniin. RLS torjuu, mutta
    // oma paiva varmistaa ettei se torju yksikasitteisyyden takia.
    forgedB: dayOffset(today, 1),
    // E4: B:n ristiinkiinnitys A:n rutiiniin. TAMAN on paastava
    // vierasavaimeen asti.
    attackB: dayOffset(today, 2),
    // E5: B:n oma poikkeus B:n OMAAN rutiiniin. Eri rutiini, joten
    // paiva saa olla sama kuin E1:lla.
    ownB: today
  });
}

/**
 * Anon-testien kohteet: taulu ja OLEMATON tunniste, jota vastaan
 * kirjautumattoman oikeudet koetellaan.
 *
 * LOYTYNYT VIKA, JOTA TAMA KORJAA
 *
 * Kaikki taulut kayttivat samaa merkkijonoa
 * `manifestival_rls_acceptance_anon`. Se toimii tekstiavaimellisissa
 * tauluissa, mutta notification_preferences.id on UUID: PostgreSQL
 * hylkasi arvon syntaksivirheena (22P02) ENNEN kuin oikeustarkistus
 * ehti tapahtua.
 *
 * Testi nayttti siis epaonnistuvan, mutta se ei ollut todistanut
 * mitaan anon-roolin oikeuksista — se oli todistanut, ettei
 * merkkijono ole UUID.
 *
 * Kohde on nyt TYYPILTAAN taulun mukainen, jolloin lause paasee
 * oikeustarkistukseen asti ja odotettu 42501 on oikeasti se, mita
 * mitataan.
 *
 * Kohteen on oltava olematon. Nolla-UUID ei ole kenenkaan tunniste:
 * auth.users-tunnisteet ovat satunnaisia. Oikean kayttajan tunnistetta
 * EI kayteta — anon ei saa kohdistaa mitaan olemassa olevaan riviin
 * edes epaonnistuakseen.
 */
export const ANON_KOHTEET = Object.freeze([
  { lyhenne: 'r', taulu: 'routines',                 kohde: `${MARKER_PREFIX}anon` },
  { lyhenne: 'e', taulu: 'routine_exceptions',       kohde: `${MARKER_PREFIX}anon` },
  { lyhenne: 'g', taulu: 'goals',                    kohde: `${MARKER_PREFIX}anon` },
  { lyhenne: 'j', taulu: 'projects',                 kohde: `${MARKER_PREFIX}anon` },
  // AINOA UUID-AVAIMELLINEN TAULU taman silmukan tauluista.
  { lyhenne: 'n', taulu: 'notification_preferences', kohde: NIL_UUID },
  { lyhenne: 'w', taulu: 'wellbeing_entries',        kohde: `${MARKER_PREFIX}anon` },
  { lyhenne: 'x', taulu: 'recurring_expenses',       kohde: `${MARKER_PREFIX}anon` },
  { lyhenne: 'l', taulu: 'bills',                    kohde: `${MARKER_PREFIX}anon` },
  { lyhenne: 's', taulu: 'savings_goals',            kohde: `${MARKER_PREFIX}anon` },
  { lyhenne: 'k', taulu: 'ai_action_audit',          kohde: `${MARKER_PREFIX}anon` }
]);

export function idsFor(runId) {
  const base = `${MARKER_PREFIX}${runId}`;
  return Object.freeze({
    baitA: `${base}_a_bait`,      // A:n omistama syötti, jota B yrittää muuttaa
    keepB: `${base}_b_keep`,      // B:n rivi, joka elää T5:n yli
    tempB: `${base}_b_temp`,      // B:n rivi, jonka B poistaa itse
    forgedB: `${base}_b_forged`,  // B:n yritys kirjoittaa A:n nimiin

    // Migraation 0003 taulut. Rutiini on saanto ja poikkeus on yhden
    // paivan muutos siihen; molemmat ovat kayttajakohtaisia ja RLS:n
    // suojaamia, ja molemmat testataan samalla A/B-mallilla.
    routineA: `${base}_a_routine`,
    routineB: `${base}_b_routine`,
    exceptionA: `${base}_a_exception`,
    exceptionB: `${base}_b_exception`,
    forgedRoutineB: `${base}_b_forged_routine`,
    forgedExceptionB: `${base}_b_forged_exception`,
    attackExceptionB: `${base}_b_attack_exception`,

    // Migraatioiden 0004-0008 taulut. Jokaisella on A:n rivi, B:n rivi
    // ja B:n vaarennosyritys A:n nimiin.
    goalA: `${base}_a_goal`,
    goalB: `${base}_b_goal`,
    forgedGoalB: `${base}_b_forged_goal`,
    projectA: `${base}_a_project`,
    projectB: `${base}_b_project`,
    forgedProjectB: `${base}_b_forged_project`,
    wellbeingA: `${base}_a_wellbeing`,
    wellbeingB: `${base}_b_wellbeing`,
    forgedWellbeingB: `${base}_b_forged_wellbeing`,
    expenseA: `${base}_a_expense`,
    expenseB: `${base}_b_expense`,
    forgedExpenseB: `${base}_b_forged_expense`,
    billA: `${base}_a_bill`,
    billB: `${base}_b_bill`,
    forgedBillB: `${base}_b_forged_bill`,
    savingsA: `${base}_a_savings`,
    savingsB: `${base}_b_savings`,
    forgedSavingsB: `${base}_b_forged_savings`,
    auditA: `${base}_a_audit`,
    auditB: `${base}_b_audit`,
    forgedAuditB: `${base}_b_forged_audit`,
    invariantB: `${base}_b_invariant`,

    // RISTIINKIINNITYSHYOKKAYKSET.
    //
    // Kahdeksan yritysta, yksi jokaista yhdistelmavierasavainta kohti.
    // Naiden EI ole tarkoitus paatya kantaan lainkaan: jos jokin niista
    // on siella ajon jalkeen, suoja petti. Siksi ne ovat omia
    // tunnisteitaan eivatka jaa muiden sekaan.
    attackGoalParentB: `${base}_b_attack_goal_parent`,
    attackGoalProjectB: `${base}_b_attack_goal_project`,
    attackProjectGoalB: `${base}_b_attack_project_goal`,
    attackTaskGoalB: `${base}_b_attack_task_goal`,
    attackTaskProjectB: `${base}_b_attack_task_project`,
    attackRoutineGoalB: `${base}_b_attack_routine_goal`,
    attackBillTaskB: `${base}_b_attack_bill_task`,
    attackBillExpenseB: `${base}_b_attack_bill_expense`,

    // Sallittu viite: B:n tehtava B:n omaan tavoitteeseen. Ilman tata
    // kiellot voisivat menna lapi siksi, etta viitteet ovat rikki
    // kaikille.
    ownLinkB: `${base}_b_own_link`
  });
}

/**
 * Migraatioiden 0009–0013 taulun testirivien tunnisteet (tableSpecs.js).
 * Erillään idsFor:sta, jotta 0003–0008:n tunnistejoukko pysyy ennallaan.
 */
export function specIdsFor(runId, code) {
  const base = `${MARKER_PREFIX}${runId}`;
  const tag = String(code).toLowerCase();
  return Object.freeze({
    a: `${base}_a_${tag}`,
    b: `${base}_b_${tag}`,
    forged: `${base}_b_forged_${tag}`
  });
}

/** Ristiinkiinnityshyökkäyksen (0009–0013) rivin tunniste. */
export function attackIdFor(runId, probe) {
  return `${MARKER_PREFIX}${runId}_b_attack_${probe.table}_${probe.column}`;
}

/**
 * Missä osiossa kunkin käyttäjän omistaman taulun RLS todistetaan.
 *
 * tests/rls-acceptance.test.mjs vaatii, että JOKAINEN
 * src/domain/accountLifecycle.js:n ACCOUNT_DATA_MAP-taulu on joko tässä,
 * TABLE_SPECS:ssä tai RLS_EXEMPTIONS:ssa perusteluineen. Uusi
 * käyttäjäkohtainen taulu ilman todistusta kaataa testin.
 */
export const BESPOKE_COVERAGE = Object.freeze({
  tasks: 'T1–T5, T6a',
  profile: 'T1b, T2d, T3c, T3f, T5b, T5e, T6b',
  routines: 'R1–R5',
  routine_exceptions: 'E1–E6',
  notification_preferences: 'N1–N6',
  goals: 'G1–G5', projects: 'J1–J5', wellbeing_entries: 'W1–W5',
  recurring_expenses: 'X1a–X5b', bills: 'L1–L5', savings_goals: 'S1–S5',
  ai_action_audit: 'K1–K5, K9'
});

/**
 * Taulut, joiden RLS:ää tämä työkalu EI todista, ja miksi.
 *
 * TYHJÄ ON TAVOITE. Jokainen merkintä on perusteltava: pelkkä "ei vielä"
 * ei kelpaa, koska silloin taulun data on todistamatta tuotannossa.
 */
export const RLS_EXEMPTIONS = Object.freeze({});

// ---------------------------------------------------------------------
// Vastausten luokittelu
// ---------------------------------------------------------------------

/** Suorita kysely niin, ettei mikään poikkeus karkaa raportin ohi. */
async function call(run) {
  try {
    const response = await run();
    if (!response || typeof response !== 'object') {
      return { error: { message: 'tyhjä vastaus clientiltä' }, rows: [] };
    }
    const { data, error } = response;
    if (error) return { error, rows: [] };
    if (Array.isArray(data)) return { error: null, rows: data };
    return { error: null, rows: data == null ? [] : [data] };
  } catch (cause) {
    // Verkkovirhe, CORS, kaatunut client. EI ole RLS-kielto.
    return { error: { message: String((cause && cause.message) || cause), thrown: true }, rows: [] };
  }
}

function describeError(error) {
  if (!error) return '';
  const code = error.code ? `${error.code}: ` : '';
  return `${error.thrown ? 'POIKKEUS ' : ''}${code}${error.message || ''}`.trim();
}

/**
 * Kiellon odotus: nolla riviä ILMAN virhettä.
 *
 * RLS ei heitä poikkeusta update- ja delete-lauseissa eikä
 * select-kyselyissä. Se rajaa rivit pois. Nolla riviä on siis oikea
 * tulos — mutta vain jos virhettä ei tullut. Virhe tarkoittaa, ettei
 * testi päässyt edes yrittämään, ja se on ERROR, ei PASS.
 */
function expectDenied(result) {
  if (result.error) {
    return { status: STATUS.ERROR, actual: describeError(result.error) };
  }
  if (result.rows.length === 0) {
    return { status: STATUS.PASS, actual: '0 riviä — RLS rajasi rivit pois' };
  }
  return { status: STATUS.FAIL, actual: `${result.rows.length} riviä LÄPI` };
}

/**
 * Odotus: kanta hylkää lauseen NIMENOMAAN annetulla koodilla.
 *
 * Koodi on osa väitettä, ei yksityiskohta. 42501 tarkoittaa että RLS tai
 * puuttuva GRANT hylkäsi, 23503 että vierasavain hylkäsi. Jos E4
 * palauttaisi 42501:n, rivi olisi kyllä torjuttu — mutta ei siitä
 * syystä, jonka piti todistaa. Siksi väärä koodi on ERROR eikä PASS.
 */
function expectRejected(result, code = INSUFFICIENT_PRIVILEGE) {
  if (!result.error) {
    return { status: STATUS.FAIL, actual: `hyväksyttiin, ${result.rows.length} riviä` };
  }
  if (result.error.code === code) {
    return { status: STATUS.PASS, actual: `hylätty ${code}` };
  }
  return { status: STATUS.ERROR, actual: describeError(result.error) };
}

/** Odotus: täsmälleen n riviä, ei virhettä. */
/** Puuttuva taulu: PostgreSQL (42P01) tai PostgRESTin skeemavälimuisti (PGRST205). */
const MISSING_TABLE = /\b(?:42P01|PGRST205)\b/;

/**
 * Miksi ajo pysähtyi lähtötilan virheeseen (ei kirjoituksia).
 * @param {Array} unverified ERROR-tilaiset lähtötilarivit
 * @param {string} wave valittu aalto
 */
function preCheckErrorReason(unverified, wave) {
  const numbers = unverified.map(entry => entry.test_no).join(', ');
  if (unverified.some(entry => MISSING_TABLE.test(String(entry.actual || '')))) {
    return `lähtötilaa ei voitu tarkistaa (${numbers}): taulu puuttuu kannasta (42P01/PGRST205). `
      + `Aallon ${wave} migraatiot eivät ole tässä kannassa — valitse aalto, jonka migraatiot on ajettu. `
      + 'Mitään ei kirjoitettu.';
  }
  return `lähtötilaa ei voitu tarkistaa (${numbers}): kysely epäonnistui. `
    + 'Tarkista yhteys ja istunnot ennen uutta ajoa. Mitään ei kirjoitettu.';
}

function expectRows(result, n) {
  if (result.error) return { status: STATUS.ERROR, actual: describeError(result.error) };
  return {
    status: result.rows.length === n ? STATUS.PASS : STATUS.FAIL,
    actual: `${result.rows.length} riviä`
  };
}

// ---------------------------------------------------------------------
// Raportin rivit
// ---------------------------------------------------------------------

/** Yksi rivi loppuraporttiin. */
function row(no, name, expected, outcome, details) {
  return {
    test_no: no,
    test_name: name,
    status: outcome.status,
    expected,
    actual: outcome.actual,
    details: details || ''
  };
}

function skipped(no, name, expected, why) {
  return row(no, name, expected, { status: STATUS.SKIP, actual: 'ohitettu' }, why);
}

/**
 * Yhden taulun omistajuusmatriisi.
 *
 * Kahdeksan uutta taulua noudattavat samaa turvamallia: omistaja on
 * `user_id`, sen asettaa kanta, ja nelja politiikkaa rajaavat rivit
 * omistajaan. Siksi niiden testit ovat samat, ja ne ajetaan yhdesta
 * paikasta.
 *
 * MIKSI GENEERINEN EIKA KAHDEKSAN KOPIOTA
 * Kopioiduissa testeissa yksi unohtunut muutos jaa huomaamatta: seitseman
 * taulua tarkistaa jotain, kahdeksas ei, eika mikaan kerro sita. Kun
 * matriisi on yksi funktio, jokainen taulu saa saman kohtelun tai ei
 * yhtaan.
 *
 * MITA TAMA EI KATA
 * Ristiinkiinnitys EI ole taalla. Se on jokaisessa taulussa eri viite ja
 * eri hyokkays, ja se kirjoitetaan auki omana lohkonaan — sita ei saa
 * piilottaa silmukan sisaan.
 *
 * @returns {Promise<{aExists: boolean, bExists: boolean}>}
 */
async function ownershipSection(ctx, spec) {
  const { push, a, b, ownerAId, userBId } = ctx;
  const { code, table, label, rowA, rowB, forged, patch, patchField, patchValue } = spec;

  // --- 1: A luo ja hallitsee omansa ----------------------------------
  const luotuA = await call(() => a.from(table).insert(rowA).select());
  const omistajaA = luotuA.rows[0] ? luotuA.rows[0].user_id : null;
  push(row(`${code}1a`, `A luo ${label} ja kanta asettaa omistajaksi A:n`,
    '1 rivi, user_id = A',
    luotuA.error
      ? { status: STATUS.ERROR, actual: describeError(luotuA.error) }
      : { status: omistajaA === ownerAId ? STATUS.PASS : STATUS.FAIL,
          actual: `${luotuA.rows.length} riviä, user_id=${omistajaA || '-'}` },
    'user_id:tä ei lähetetä — DEFAULT auth.uid() asettaa sen'));

  const aExists = luotuA.rows.length === 1;

  push(aExists
    ? row(`${code}1b`, `A lukee oman ${label}`, '1 rivi',
        expectRows(await call(() =>
          a.from(table).select('id').eq('id', rowA.id)), 1), '')
    : skipped(`${code}1b`, `A lukee oman ${label}`, '1 rivi', 'riviä ei syntynyt'));

  push(aExists
    ? row(`${code}1c`, `A päivittää oman ${label}`, '1 rivi',
        expectRows(await call(() =>
          a.from(table).update(patch).eq('id', rowA.id).select()), 1), '')
    : skipped(`${code}1c`, `A päivittää oman ${label}`, '1 rivi', 'riviä ei syntynyt'));

  push(aExists
    ? row(`${code}1d`, `A:n listaus taulusta ${table} ei paljasta vieraita rivejä`,
        'vain omistajan A rivejä',
        await (async () => {
          const lista = await call(() => a.from(table).select('id,user_id'));
          if (lista.error) return { status: STATUS.ERROR, actual: describeError(lista.error) };
          const vieraat = lista.rows.filter(r => r.user_id !== ownerAId);
          if (vieraat.length > 0) {
            return { status: STATUS.FAIL, actual: `${vieraat.length} riviä vieraalla omistajalla` };
          }
          return { status: lista.rows.some(r => r.id === rowA.id) ? STATUS.PASS : STATUS.FAIL,
                   actual: `${lista.rows.length} riviä, kaikki omistajalla A` };
        })(),
        'listaus on eri koodipolku kuin yksittäisen rivin haku')
    : skipped(`${code}1d`, `A:n listaus taulusta ${table}`, '1 rivi', 'riviä ei syntynyt'));

  // --- 2: B ei nae A:n rivia -----------------------------------------
  push(row(`${code}2a`, `B ei näe yhtään A:n riviä taulussa ${table}`, '0 riviä',
    expectDenied(await call(() =>
      b.from(table).select('id').eq('user_id', ownerAId))),
    'SELECT-politiikan USING'));

  push(aExists
    ? row(`${code}2b`, `B ei näe A:n ${label}, jonka tunnisteen se tietää`, '0 riviä',
        expectDenied(await call(() =>
          b.from(table).select('id').eq('id', rowA.id))),
        'tunnisteen tietäminen ei riitä — RLS rajaa rivin pois')
    : skipped(`${code}2b`, `B ei näe A:n ${label}`, '0 riviä', 'riviä ei syntynyt'));

  // --- 3: B ei voi muuttaa eika poistaa A:n rivia --------------------
  push(aExists
    ? row(`${code}3a`, `B:n UPDATE A:n ${label} osuu nollaan riviin`, '0 riviä',
        expectDenied(await call(() =>
          b.from(table).update(patch).eq('id', rowA.id).select())),
        'UPDATE-politiikan USING')
    : skipped(`${code}3a`, `B:n UPDATE A:n ${label}`, '0 riviä', 'riviä ei syntynyt'));

  push(aExists
    ? row(`${code}3b`, `B:n DELETE A:n ${label} osuu nollaan riviin`, '0 riviä',
        expectDenied(await call(() =>
          b.from(table).delete().eq('id', rowA.id).select())),
        'DELETE-politiikan USING')
    : skipped(`${code}3b`, `B:n DELETE A:n ${label}`, '0 riviä', 'riviä ei syntynyt'));

  push(row(`${code}3c`, `B ei voi luoda ${label} A:n nimiin`,
    `virhe ${INSUFFICIENT_PRIVILEGE}`,
    expectRejected(await call(() =>
      b.from(table).insert({ ...forged, user_id: ownerAId }).select())),
    'INSERT-politiikan WITH CHECK — omistajuuden väärennös'));

  push(aExists
    ? row(`${code}3d`, `B ei voi siirtää A:n ${label} itselleen`, '0 riviä',
        expectDenied(await call(() =>
          b.from(table).update({ user_id: userBId }).eq('id', rowA.id).select())),
        'USING estää rivin näkymisen, joten omistajan vaihto ei osu mihinkään')
    : skipped(`${code}3d`, `B ei voi siirtää A:n ${label} itselleen`, '0 riviä',
        'riviä ei syntynyt'));

  push(aExists
    ? row(`${code}3e`, `A:n ${label} on koskematon B:n yritysten jälkeen`,
        '1 rivi, arvot ennallaan',
        await (async () => {
          const jalkeen = await call(() =>
            a.from(table).select(`id,user_id,${patchField}`).eq('id', rowA.id));
          if (jalkeen.error) return { status: STATUS.ERROR, actual: describeError(jalkeen.error) };
          const rivi = jalkeen.rows[0];
          const ok = jalkeen.rows.length === 1
            && rivi.user_id === ownerAId
            && String(rivi[patchField]) === String(patchValue);
          return { status: ok ? STATUS.PASS : STATUS.FAIL,
                   actual: `${jalkeen.rows.length} riviä, omistaja=${rivi ? rivi.user_id : '-'},`
                           + ` ${patchField}=${rivi ? rivi[patchField] : '-'}` };
        })(),
        'todiste ettei kielto onnistunut vain siksi ettei riviä ollut')
    : skipped(`${code}3e`, `A:n ${label} on koskematon`, '1 rivi', 'riviä ei syntynyt'));

  // --- 4: B hallitsee omaansa ----------------------------------------
  const luotuB = await call(() => b.from(table).insert(rowB).select());
  const omistajaB = luotuB.rows[0] ? luotuB.rows[0].user_id : null;
  push(row(`${code}4a`, `B luo oman ${label} ja kanta asettaa omistajaksi B:n`,
    '1 rivi, user_id = B',
    luotuB.error
      ? { status: STATUS.ERROR, actual: describeError(luotuB.error) }
      : { status: omistajaB === userBId ? STATUS.PASS : STATUS.FAIL,
          actual: `${luotuB.rows.length} riviä, user_id=${omistajaB || '-'}` },
    'sama polku kuin A:lla — kielto ei johdu siitä että B ei voisi kirjoittaa'));

  const bExists = luotuB.rows.length === 1;

  // --- 5: A ei nae eika muuta B:n rivia ------------------------------
  push(bExists
    ? row(`${code}5a`, `A ei näe B:n ${label}`, '0 riviä',
        expectDenied(await call(() =>
          a.from(table).select('id').eq('id', rowB.id))),
        'eristys on molempiin suuntiin, ei vain B:stä A:han')
    : skipped(`${code}5a`, `A ei näe B:n ${label}`, '0 riviä', 'B:n riviä ei syntynyt'));

  push(bExists
    ? row(`${code}5b`, `A:n UPDATE B:n ${label} osuu nollaan riviin`, '0 riviä',
        expectDenied(await call(() =>
          a.from(table).update(patch).eq('id', rowB.id).select())), '')
    : skipped(`${code}5b`, `A:n UPDATE B:n ${label}`, '0 riviä', 'B:n riviä ei syntynyt'));

  return { aExists, bExists };
}

// ---------------------------------------------------------------------
// Testin ajo
// ---------------------------------------------------------------------

/**
 * Aja koko T1-T5-hyväksyntätesti ja siivous.
 *
 * @param {object} options
 * @param {object} options.a       supabase-client, sisäänkirjautuneena tilinä A
 * @param {object} options.b       supabase-client, sisäänkirjautuneena tilinä B
 * @param {object} options.anon    supabase-client ILMAN istuntoa
 * @param {string} options.ownerAId    tilin A UUID
 * @param {string} options.userBId     tilin B UUID
 * @param {number} options.expectedTaskCount  A:n oikeiden tehtävien määrä (36)
 * @param {string} options.runId   yksilöivä ajotunnus rivien tunnisteisiin
 * @param {string} options.today   ISO-päivä testirivien date-sarakkeeseen
 * @param {string} [options.wave]  aalto, jonka migraatiot tuotannossa on
 *   ajettu ('E' = 0008 … 'J' = 0013). Oletus 'E': 0009–0013:n tauluja ei
 *   kosketa. Ks. tableSpecs.js.
 * @returns {Promise<{rows: Array, summary: object}>}
 */
export async function runAcceptance(options) {
  const { a, b, anon, ownerAId, userBId, expectedTaskCount, runId, today } = options;
  const wave = options.wave === undefined ? DEFAULT_ACCEPTANCE_WAVE : options.wave;

  if (!a || !b || !anon) throw new Error('kaikki kolme clientiä vaaditaan');
  if (!ownerAId || !userBId) throw new Error('molempien tilien tunnisteet vaaditaan');
  if (ownerAId === userBId) throw new Error('A ja B ovat sama tili — testi ei todistaisi mitään');
  if (!runId) throw new Error('ajotunnus vaaditaan');
  if (!ACCEPTANCE_WAVES.includes(wave)) {
    throw new Error(`tuntematon aalto ${wave} — sallitut: ${ACCEPTANCE_WAVES.join(', ')}`);
  }

  // Migraatioiden 0009–0013 taulut, jotka ovat tuotannossa tässä aallossa.
  const specs = TABLE_SPECS.filter(entry => inWave(entry, wave));
  const probes = COMPOSITE_FK_PROBES.filter(entry => inWave(entry, wave));
  const scope = {
    wave,
    tablesInScope: specs.map(entry => entry.table),
    tablesOutOfScope: TABLE_SPECS.filter(entry => !specs.includes(entry)).map(entry => entry.table)
  };

  const id = idsFor(runId);
  const rows = [];
  // Kriittinen vika = jokin kielto ei pitänyt. Lähtötilan tarkistuksissa
  // se keskeyttää ajon; sen jälkeen se vain merkitään, koska jäljellä
  // olevat yritykset eivät voi vahingoittaa mitään (ks. TURVAPERIAATTEET).
  let critical = false;
  const push = entry => {
    rows.push(entry);
    if (entry.status === STATUS.FAIL) critical = true;
    return entry;
  };

  // --- P0: lähtötila ------------------------------------------------
  //
  // Jos edellisestä ajosta on jäänyt rivejä, siivous ei olisi
  // deterministinen: emme tietäisi kumman ajon rivin poistimme.
  const leftovers = await call(() =>
    a.from('tasks').select('id').like('id', `${MARKER_PREFIX}%`));
  push(row('P0', 'Ei edellisen ajon jäännösrivejä',
    '0 riviä', expectRows(leftovers, 0),
    leftovers.rows.map(r => r.id).join(', ')));

  const baseline = await call(() => a.from('tasks').select('id'));
  push(row('P1', 'A:n tehtävien lähtömäärä',
    `${expectedTaskCount} riviä`, expectRows(baseline, expectedTaskCount),
    'kaikki myöhemmät luvut verrataan tähän'));

  // 0009–0013: ei edellisen ajon jäänteitä kummallakaan tilillä. Viikko-
  // ja nimirivit ovat uniikkeja käyttäjää kohti, joten jäänne kaataisi
  // saman ajon rivin yksikäsitteisyyteen eikä siihen, mitä testataan.
  for (const entry of specs) {
    for (const [client, kuka] of [[a, 'A'], [b, 'B']]) {
      const jaanne = await call(() =>
        client.from(entry.table).select('id').like('id', `${MARKER_PREFIX}%`));
      push(row(`P0-${entry.code.toLowerCase()}-${kuka.toLowerCase()}`,
        `${kuka}: ei edellisen ajon jäännösrivejä taulussa ${entry.table}`,
        '0 riviä', expectRows(jaanne, 0), jaanne.rows.map(r => r.id).join(', ')));
    }
  }

  // YKSI AJASTIN KÄYTTÄJÄÄ KOHTI. A:n oikea, käynnissä oleva ajastin
  // estäisi testirivin (23505) — ja sen pysäyttäminen on omistajan asia,
  // ei tämän työkalun. Ajo pysähtyy ennen yhtäkään kirjoitusta.
  if (specs.some(entry => entry.table === 'running_timers')) {
    push(row('P2', 'A:lla ei ole käynnissä olevaa ajastinta',
      '0 riviä', expectRows(await call(() => a.from('running_timers').select('id')), 0),
      'pysäytä ajastin sovelluksessa ennen ajoa (running_timers_one_per_user)'));
    push(row('P3', 'B:llä ei ole ajastinta',
      '0 riviä', expectRows(await call(() => b.from('running_timers').select('id')), 0),
      'kertakäyttöisellä tilillä ei ole omaa dataa'));
  }

  if (critical) {
    return finish(rows, { runId, ids: id, ...scope, aborted: 'lähtötila ei ollut odotettu' });
  }
  // LÄHTÖTILAA EI VOITU TARKISTAA: virhe ei ole "0 riviä". Ajo pysähtyy
  // ennen yhtäkään kirjoitusta. Tavallisin syy on aalto, joka on tuotannon
  // skeemaa uudempi: taulua ei ole (42P01 / PGRST205), jolloin testirivit
  // kaatuisivat kesken ja siivous jäisi epävarmaksi.
  const unverified = rows.filter(entry => entry.status === STATUS.ERROR);
  if (unverified.length > 0) {
    return finish(rows, { runId, ids: id, ...scope, aborted: preCheckErrorReason(unverified, wave) });
  }

  // --- T1: A näkee oman datansa -------------------------------------
  //
  // Ensimmäisenä tarkoituksella. Liian tiukka politiikka lukitsee
  // omistajan ulos omasta datastaan, ja se on yhtä paha vika kuin liian
  // löysä — vain helpompi huomata.
  const aTasks = await call(() => a.from('tasks').select('id,user_id'));
  const aForeign = aTasks.rows.filter(r => r.user_id !== ownerAId);
  push(row('T1a', 'A lukee omat tehtävänsä',
    `${expectedTaskCount} riviä, kaikki omistajalla A`,
    aForeign.length > 0
      ? { status: STATUS.FAIL, actual: `${aForeign.length} riviä vieraalla omistajalla` }
      : expectRows(aTasks, expectedTaskCount),
    'USING ei ole liian tiukka eikä liian löysä'));

  const aProfile = await call(() => a.from('profile').select('id'));
  const aProfileOk = aProfile.rows.length === 1 && aProfile.rows[0].id === ownerAId;
  push(row('T1b', 'A lukee oman profiilinsa',
    '1 rivi, id = A',
    aProfile.error
      ? { status: STATUS.ERROR, actual: describeError(aProfile.error) }
      : { status: aProfileOk ? STATUS.PASS : STATUS.FAIL,
          actual: `${aProfile.rows.length} riviä, id=${aProfile.rows[0] ? aProfile.rows[0].id : '-'}` },
    'profile käyttää eri omistajuusmallia kuin tasks: id, ei user_id'));

  // A:n profiilin nykyiset arvot talteen. Niitä tarvitaan T3c:ssä
  // arvot säilyttävään kirjoitusyritykseen.
  const aProfileFull = await call(() => a.from('profile').select('*').eq('id', ownerAId));
  const aProfileValues = aProfileFull.rows[0] || null;

  // A luo syöttirivin. Tämä on ainoa kirjoitus tilin A nimissä, ja se
  // poistetaan siivouksessa. user_id:tä EI lähetetä — kanta asettaa sen.
  const bait = await call(() =>
    a.from('tasks').insert(taskRow(id.baitA, today, 'RLS-hyvaksyntatesti (syotti)')).select());
  const baitOwner = bait.rows[0] ? bait.rows[0].user_id : null;
  push(row('T1c', 'A luo syöttirivin, kanta asettaa omistajan',
    `1 rivi, user_id = A`,
    bait.error
      ? { status: STATUS.ERROR, actual: describeError(bait.error) }
      : { status: baitOwner === ownerAId ? STATUS.PASS : STATUS.FAIL,
          actual: `${bait.rows.length} riviä, user_id=${baitOwner || '-'}` },
    'DEFAULT auth.uid() toimii; syötti on B:n kieltotestien kohde'));

  const baitExists = !critical && bait.rows.length === 1;

  // --- T2: B ei näe A:n dataa ---------------------------------------
  const bAll = await call(() => b.from('tasks').select('id,user_id'));
  push(row('T2a', 'B ei näe yhtään tehtävää',
    '0 riviä', expectDenied(bAll),
    'B:llä ei ole vielä omaa dataa; kaikki näkyvä olisi A:n'));

  const bByOwner = await call(() =>
    b.from('tasks').select('id').eq('user_id', ownerAId));
  push(row('T2b', 'B ei näe A:n tehtäviä nimenomaisella omistajasuodattimella',
    '0 riviä', expectDenied(bByOwner),
    'suora kysely A:n tunnisteella — ei arvailua'));

  const bByBait = baitExists
    ? await call(() => b.from('tasks').select('id').eq('id', id.baitA))
    : null;
  push(bByBait
    ? row('T2c', 'B ei näe A:n riviä, jonka tunnisteen se tietää',
        '0 riviä', expectDenied(bByBait),
        'vahvin lukukielto: rivi on varmasti olemassa')
    : skipped('T2c', 'B ei näe A:n riviä, jonka tunnisteen se tietää',
        '0 riviä', 'syöttiriviä ei syntynyt'));

  const bProfileA = await call(() => b.from('profile').select('id').eq('id', ownerAId));
  push(row('T2d', 'B ei näe A:n profiilia',
    '0 riviä', expectDenied(bProfileA),
    'erillinen tarkistus: profile-politiikat osoittavat id-sarakkeeseen'));

  // --- T3: B ei voi muuttaa eikä poistaa A:n dataa -------------------
  //
  // Testiä ei keskeytetä vaikka jokin kielto pettäisi. Se on turvallista
  // rakenteen vuoksi eikä toiveen: jäljellä olevien kirjoitusyritysten
  // kohteet ovat joko syöttirivi, B:n väliaikainen data tai arvot
  // säilyttävä payload. Yksikään ei voi vahingoittaa A:n oikeaa dataa
  // edes silloin, kun RLS on täysin rikki. Keskeytys sen sijaan
  // hukkaisi juuri sen tiedon, jota vian selvittäminen vaatii: kuinka
  // moni kielto petti ja mitkä.
  push(baitExists
    ? row('T3a', 'B:n UPDATE A:n riviin osuu nollaan riviin',
        '0 riviä',
        expectDenied(await call(() =>
          b.from('tasks').update({ title: 'kaapattu' }).eq('id', id.baitA).select())),
        'UPDATE-politiikan USING; kohteena syötti, ei A:n oikeaa dataa')
    : skipped('T3a', 'B:n UPDATE A:n riviin osuu nollaan riviin', '0 riviä',
        'syöttiriviä ei syntynyt'));

  push(baitExists
    ? row('T3b', 'B:n DELETE A:n riviin osuu nollaan riviin',
        '0 riviä',
        expectDenied(await call(() =>
          b.from('tasks').delete().eq('id', id.baitA).select())),
        'DELETE-politiikan USING; kohteena syötti')
    : skipped('T3b', 'B:n DELETE A:n riviin osuu nollaan riviin', '0 riviä',
        'syöttiriviä ei syntynyt'));

  // Profiilia ei voi monistaa, joten kohteena on A:n oikea rivi.
  // Payload on A:n NYKYISET arvot: jos RLS pettäisi, rivi kirjoittuisi
  // itsekseen eikä yksikään arvo muutu.
  push(aProfileValues
    ? row('T3c', 'B:n UPDATE A:n profiiliin osuu nollaan riviin',
        '0 riviä',
        expectDenied(await call(() =>
          b.from('profile').update(preservingPayload(aProfileValues)).eq('id', ownerAId).select())),
        'arvot säilyttävä payload: rikkinäinen RLS ei voisi muuttaa mitään')
    : skipped('T3c', 'B:n UPDATE A:n profiiliin osuu nollaan riviin', '0 riviä',
        'A:n profiilin arvoja ei saatu luettua'));

  // WITH CHECK: B yrittää kirjoittaa rivin A:n nimiin. Tätä ei voi
  // tehdä käyttöliittymästä, koska sovellus ei koskaan lähetä user_id:tä.
  push(row('T3d', 'B ei voi luoda riviä A:n nimiin',
    `virhe ${INSUFFICIENT_PRIVILEGE}`,
    expectRejected(await call(() =>
      b.from('tasks')
        .insert({ ...taskRow(id.forgedB, today, 'ei saa onnistua'), user_id: ownerAId })
        .select())),
    'INSERT-politiikan WITH CHECK; ainoa testi joka odottaa virhettä eikä nollaa riviä'));

  const baitAfter = baitExists
    ? await call(() => a.from('tasks').select('id,title,user_id').eq('id', id.baitA))
    : null;
  push(baitAfter
    ? row('T3e', 'A:n syöttirivi on koskematon B:n yritysten jälkeen',
        '1 rivi, alkuperäinen otsikko',
        baitAfter.error
          ? { status: STATUS.ERROR, actual: describeError(baitAfter.error) }
          : { status: baitAfter.rows.length === 1 && baitAfter.rows[0].title === 'RLS-hyvaksyntatesti (syotti)'
                ? STATUS.PASS : STATUS.FAIL,
              actual: `${baitAfter.rows.length} riviä, title=${baitAfter.rows[0] ? baitAfter.rows[0].title : '-'}` },
        'todiste ettei kielto onnistunut vain siksi ettei rivi ollut olemassa')
    : skipped('T3e', 'A:n syöttirivi on koskematon B:n yritysten jälkeen', '1 rivi',
        'syöttiriviä ei syntynyt'));

  // T3c on koko ajon ainoa kohta, jossa kirjoitusyritys osuu tilin A
  // OIKEAAN riviin. Payload on arvot säilyttävä, joten rikkinäinenkään
  // RLS ei voisi muuttaa mitään — mutta "ei voisi" on päättelyä, ja
  // päättely on juuri se, mitä tämä testi on olemassa korvaamaan.
  // Siksi se tarkistetaan.
  const profileAfter = aProfileValues
    ? await call(() => a.from('profile').select('*').eq('id', ownerAId))
    : null;
  push(profileAfter
    ? row('T3f', 'A:n profiili on rivi riviltä muuttumaton',
        'kaikki arvot samat kuin ennen T3c:tä',
        profileAfter.error
          ? { status: STATUS.ERROR, actual: describeError(profileAfter.error) }
          : sameRow(profileAfter.rows[0], aProfileValues)
            ? { status: STATUS.PASS, actual: 'ei yhtään muuttunutta saraketta' }
            : { status: STATUS.FAIL, actual: `muuttuneet sarakkeet: ${changedColumns(profileAfter.rows[0], aProfileValues).join(', ')}` },
        'ainoa kohta, jossa kirjoitusyritys osui tilin A oikeaan riviin')
    : skipped('T3f', 'A:n profiili on rivi riviltä muuttumaton',
        'kaikki arvot samat', 'A:n profiilin arvoja ei saatu luettua'));

  // --- T4: B voi käsitellä omaa dataansa -----------------------------
  //
  // Ilman tätä koko testi olisi merkityksetön: politiikka `using (false)`
  // läpäisisi jokaisen kieltotestin ja rikkoisi sovelluksen täysin.
  const bInsert = await call(() =>
    b.from('tasks').insert(taskRow(id.keepB, today, 'B:n oma rivi')).select());
  const bOwner = bInsert && bInsert.rows[0] ? bInsert.rows[0].user_id : null;
  push(row('T4a', 'B luo oman rivin ja kanta asettaa omistajaksi B:n',
        '1 rivi, user_id = B',
        bInsert.error
          ? { status: STATUS.ERROR, actual: describeError(bInsert.error) }
          : { status: bOwner === userBId ? STATUS.PASS : STATUS.FAIL,
              actual: `${bInsert.rows.length} riviä, user_id=${bOwner || '-'}` },
        'ilman tätä kieltotestit voisivat läpäistä koska mikään ei toimi'));

  const bKeepExists = bInsert.rows.length === 1;

  push(bKeepExists
    ? row('T4b', 'B lukee oman rivinsä',
        '1 rivi',
        expectRows(await call(() => b.from('tasks').select('id').eq('id', id.keepB)), 1),
        '')
    : skipped('T4b', 'B lukee oman rivinsä', '1 rivi', 'B:n riviä ei syntynyt'));

  push(bKeepExists
    ? row('T4c', 'B päivittää oman rivinsä',
        '1 rivi',
        expectRows(await call(() =>
          b.from('tasks').update({ title: 'B:n oma rivi, muokattu' }).eq('id', id.keepB).select()), 1),
        'osoittaa että 0 riviä kieltotesteissä johtui RLS:stä eikä kyselyn muodosta')
    : skipped('T4c', 'B päivittää oman rivinsä', '1 rivi', 'B:n riviä ei syntynyt'));

  const bTemp = await call(() =>
    b.from('tasks').insert(taskRow(id.tempB, today, 'B:n hetkellinen rivi')).select());
  push(bTemp.rows.length === 1
    ? row('T4d', 'B poistaa oman rivinsä',
        '1 rivi',
        expectRows(await call(() => b.from('tasks').delete().eq('id', id.tempB).select()), 1),
        'DELETE toimii omistajalle — kielto T3b ei siis johtunut rikkinäisestä poistosta')
    : skipped('T4d', 'B poistaa oman rivinsä', '1 rivi',
        describeError(bTemp.error) || 'riviä ei syntynyt'));

  const bProfile = await call(() => b.from('profile').upsert(profileRow(userBId)).select());
  push(row('T4e', 'B luo oman profiilinsa',
        '1 rivi, id = B',
        bProfile.error
          ? { status: STATUS.ERROR, actual: describeError(bProfile.error) }
          : { status: bProfile.rows.length === 1 && bProfile.rows[0].id === userBId ? STATUS.PASS : STATUS.FAIL,
              actual: `${bProfile.rows.length} riviä, id=${bProfile.rows[0] ? bProfile.rows[0].id : '-'}` },
        'B:n profiili on T5:n kohde — se on väliaikaista dataa, joten sitä saa yrittää poistaa'));

  const bProfileExists = bProfile.rows.length === 1;

  // --- T5: A ei näe eikä muuta B:n dataa -----------------------------
  //
  // Eristys ei ole yksisuuntainen. Jos vain toinen suunta testataan,
  // politiikka joka vuotaa "vanhemmalta uudemmalle" jäisi huomaamatta.
  push(row('T5a', 'A ei näe B:n tehtäviä',
    '0 riviä',
    expectDenied(await call(() => a.from('tasks').select('id').eq('user_id', userBId))),
    ''));

  push(row('T5b', 'A ei näe B:n profiilia',
    '0 riviä',
    expectDenied(await call(() => a.from('profile').select('id').eq('id', userBId))),
    ''));

  push(bKeepExists
    ? row('T5c', 'A:n UPDATE B:n riviin osuu nollaan riviin',
        '0 riviä',
        expectDenied(await call(() =>
          a.from('tasks').update({ title: 'A kaappaa' }).eq('id', id.keepB).select())),
        '')
    : skipped('T5c', 'A:n UPDATE B:n riviin osuu nollaan riviin', '0 riviä', 'B:n riviä ei syntynyt'));

  push(bKeepExists
    ? row('T5d', 'A:n DELETE B:n riviin osuu nollaan riviin',
        '0 riviä',
        expectDenied(await call(() => a.from('tasks').delete().eq('id', id.keepB).select())),
        '')
    : skipped('T5d', 'A:n DELETE B:n riviin osuu nollaan riviin', '0 riviä', 'B:n riviä ei syntynyt'));

  push(bProfileExists
    ? row('T5e', 'A:n DELETE B:n profiiliin osuu nollaan riviin',
        '0 riviä',
        expectDenied(await call(() => a.from('profile').delete().eq('id', userBId).select())),
        'profiilin poistokielto testataan tästä suunnasta: kohde on väliaikainen, joten riski on nolla')
    : skipped('T5e', 'A:n DELETE B:n profiiliin osuu nollaan riviin', '0 riviä', 'B:n profiilia ei syntynyt'));

  push(bKeepExists
    ? row('T5f', 'B:n rivi on tallella A:n yritysten jälkeen',
        '1 rivi',
        expectRows(await call(() => b.from('tasks').select('id').eq('id', id.keepB)), 1),
        'todiste ettei T5c/T5d onnistunut vain siksi että rivi katosi')
    : skipped('T5f', 'B:n rivi on tallella A:n yritysten jälkeen', '1 rivi', 'B:n riviä ei syntynyt'));

  // =================================================================
  // R1-R5: rutiinit
  //
  // Migraatio 0003 loi taulut routines ja routine_exceptions. Niiden
  // RLS:stä ei ole samaa elävää todistetta kuin tasks- ja
  // profile-tauluista, ja tämä osuus hankkii sen. Portit ovat yhä
  // false, joten sovellus ei koske näihin tauluihin — tämä työkalu
  // puhuu Supabaselle suoraan, samalla julkisella anon-avaimella ja
  // samojen politiikkojen läpi kuin sovellus puhuisi.
  // =================================================================

  // --- R1: A luo ja hallitsee oman rutiininsa ------------------------
  const routineA = await call(() =>
    a.from('routines').insert(routineRow(id.routineA, 'A:n rutiini')).select());
  const routineAOwner = routineA.rows[0] ? routineA.rows[0].user_id : null;
  push(row('R1a', 'A luo rutiinin ja kanta asettaa omistajaksi A:n',
    '1 rivi, user_id = A',
    routineA.error
      ? { status: STATUS.ERROR, actual: describeError(routineA.error) }
      : { status: routineAOwner === ownerAId ? STATUS.PASS : STATUS.FAIL,
          actual: `${routineA.rows.length} riviä, user_id=${routineAOwner || '-'}` },
    'user_id:tä ei lähetetä — DEFAULT auth.uid() asettaa sen'));

  const routineAExists = routineA.rows.length === 1;

  push(routineAExists
    ? row('R1b', 'A lukee oman rutiininsa', '1 rivi',
        expectRows(await call(() =>
          a.from('routines').select('id').eq('id', id.routineA)), 1), '')
    : skipped('R1b', 'A lukee oman rutiininsa', '1 rivi', 'rutiinia ei syntynyt'));

  push(routineAExists
    ? row('R1c', 'A päivittää oman rutiininsa', '1 rivi',
        expectRows(await call(() =>
          a.from('routines').update({ title: 'A:n rutiini, muokattu' })
            .eq('id', id.routineA).select()), 1), '')
    : skipped('R1c', 'A päivittää oman rutiininsa', '1 rivi', 'rutiinia ei syntynyt'));

  push(routineAExists
    ? row('R1d', 'A näkee rutiinin listauksessa', 'vähintään 1 rivi',
        await (async () => {
          const lista = await call(() => a.from('routines').select('id,user_id'));
          if (lista.error) return { status: STATUS.ERROR, actual: describeError(lista.error) };
          const vieraat = lista.rows.filter(r => r.user_id !== ownerAId);
          if (vieraat.length > 0) {
            return { status: STATUS.FAIL, actual: `${vieraat.length} riviä vieraalla omistajalla` };
          }
          return { status: lista.rows.some(r => r.id === id.routineA) ? STATUS.PASS : STATUS.FAIL,
                   actual: `${lista.rows.length} riviä, kaikki omistajalla A` };
        })(),
        'listaus ei myöskään paljasta toisen rivejä')
    : skipped('R1d', 'A näkee rutiinin listauksessa', '1 rivi', 'rutiinia ei syntynyt'));

  // --- R2: B ei näe A:n rutiinia -------------------------------------
  push(row('R2a', 'B ei näe yhtään A:n rutiinia listauksessa', '0 riviä',
    expectDenied(await call(() =>
      b.from('routines').select('id').eq('user_id', ownerAId))), ''));

  push(routineAExists
    ? row('R2b', 'B ei näe A:n rutiinia, jonka tunnisteen se tietää', '0 riviä',
        expectDenied(await call(() =>
          b.from('routines').select('id').eq('id', id.routineA))),
        'vahvin lukukielto: rivi on varmasti olemassa')
    : skipped('R2b', 'B ei näe A:n rutiinia tunnisteella', '0 riviä', 'rutiinia ei syntynyt'));

  // --- R3: B ei voi muuttaa A:n rutiinia -----------------------------
  push(routineAExists
    ? row('R3a', 'B:n UPDATE A:n rutiiniin osuu nollaan riviin', '0 riviä',
        expectDenied(await call(() =>
          b.from('routines').update({ title: 'kaapattu' }).eq('id', id.routineA).select())),
        'UPDATE-politiikan USING')
    : skipped('R3a', 'B:n UPDATE A:n rutiiniin', '0 riviä', 'rutiinia ei syntynyt'));

  push(routineAExists
    ? row('R3b', 'B:n DELETE A:n rutiiniin osuu nollaan riviin', '0 riviä',
        expectDenied(await call(() =>
          b.from('routines').delete().eq('id', id.routineA).select())),
        'DELETE-politiikan USING')
    : skipped('R3b', 'B:n DELETE A:n rutiiniin', '0 riviä', 'rutiinia ei syntynyt'));

  push(row('R3c', 'B ei voi luoda rutiinia A:n nimiin',
    `virhe ${INSUFFICIENT_PRIVILEGE}`,
    expectRejected(await call(() =>
      b.from('routines')
        .insert({ ...routineRow(id.forgedRoutineB, 'ei saa onnistua'), user_id: ownerAId })
        .select())),
    'INSERT-politiikan WITH CHECK'));

  push(routineAExists
    ? row('R3d', 'B ei voi siirtää omistajuutta itselleen UPDATElla', '0 riviä',
        expectDenied(await call(() =>
          b.from('routines').update({ user_id: userBId }).eq('id', id.routineA).select())),
        'USING estää rivin näkymisen, joten omistajan vaihto ei osu mihinkään')
    : skipped('R3d', 'B ei voi siirtää omistajuutta', '0 riviä', 'rutiinia ei syntynyt'));

  push(routineAExists
    ? row('R3e', 'A:n rutiini on koskematon B:n yritysten jälkeen',
        '1 rivi, otsikko ennallaan',
        await (async () => {
          const jalkeen = await call(() =>
            a.from('routines').select('id,title,user_id').eq('id', id.routineA));
          if (jalkeen.error) return { status: STATUS.ERROR, actual: describeError(jalkeen.error) };
          const ok = jalkeen.rows.length === 1
            && jalkeen.rows[0].title === 'A:n rutiini, muokattu'
            && jalkeen.rows[0].user_id === ownerAId;
          return { status: ok ? STATUS.PASS : STATUS.FAIL,
                   actual: `${jalkeen.rows.length} riviä, omistaja=${jalkeen.rows[0] ? jalkeen.rows[0].user_id : '-'}` };
        })(),
        'todiste ettei kielto onnistunut vain siksi ettei rivi ollut olemassa')
    : skipped('R3e', 'A:n rutiini on koskematon', '1 rivi', 'rutiinia ei syntynyt'));

  // --- R4: B hallitsee omaa rutiiniaan -------------------------------
  const routineB = await call(() =>
    b.from('routines').insert(routineRow(id.routineB, 'B:n rutiini')).select());
  const routineBOwner = routineB.rows[0] ? routineB.rows[0].user_id : null;
  push(row('R4a', 'B luo rutiinin ja kanta asettaa omistajaksi B:n',
    '1 rivi, user_id = B',
    routineB.error
      ? { status: STATUS.ERROR, actual: describeError(routineB.error) }
      : { status: routineBOwner === userBId ? STATUS.PASS : STATUS.FAIL,
          actual: `${routineB.rows.length} riviä, user_id=${routineBOwner || '-'}` },
    'ilman tätä kieltotestit voisivat läpäistä koska mikään ei toimi'));

  const routineBExists = routineB.rows.length === 1;

  push(routineBExists
    ? row('R4b', 'B lukee ja päivittää oman rutiininsa', '1 rivi',
        expectRows(await call(() =>
          b.from('routines').update({ title: 'B:n rutiini, muokattu' })
            .eq('id', id.routineB).select()), 1), '')
    : skipped('R4b', 'B lukee ja päivittää oman rutiininsa', '1 rivi', 'rutiinia ei syntynyt'));

  // --- R5: A ei näe eikä muuta B:n rutiinia --------------------------
  push(row('R5a', 'A ei näe B:n rutiineja', '0 riviä',
    expectDenied(await call(() =>
      a.from('routines').select('id').eq('user_id', userBId))), ''));

  push(routineBExists
    ? row('R5b', 'A:n UPDATE B:n rutiiniin osuu nollaan riviin', '0 riviä',
        expectDenied(await call(() =>
          a.from('routines').update({ title: 'A kaappaa' }).eq('id', id.routineB).select())), '')
    : skipped('R5b', 'A:n UPDATE B:n rutiiniin', '0 riviä', 'rutiinia ei syntynyt'));

  push(routineBExists
    ? row('R5c', 'A:n DELETE B:n rutiiniin osuu nollaan riviin', '0 riviä',
        expectDenied(await call(() =>
          a.from('routines').delete().eq('id', id.routineB).select())), '')
    : skipped('R5c', 'A:n DELETE B:n rutiiniin', '0 riviä', 'rutiinia ei syntynyt'));

  // =================================================================
  // E1-E6: rutiinien poikkeukset
  // =================================================================

  // --- E1: A luo ja hallitsee oman poikkeuksensa ---------------------
  //
  // Jokainen A:n rutiiniin kohdistuva poikkeus saa oman paivansa, koska
  // `unique (routine_id, date)` on rutiinikohtainen. Ks. exceptionDates.
  const poikkeusPaivat = exceptionDates(today);

  const exceptionA = routineAExists
    ? await call(() => a.from('routine_exceptions')
        .insert(exceptionRow(id.exceptionA, id.routineA, poikkeusPaivat.ownA)).select())
    : null;
  const exceptionAOwner = exceptionA && exceptionA.rows[0] ? exceptionA.rows[0].user_id : null;
  push(exceptionA
    ? row('E1a', 'A luo poikkeuksen omaan rutiiniinsa, kanta asettaa omistajan',
        '1 rivi, user_id = A',
        exceptionA.error
          ? { status: STATUS.ERROR, actual: describeError(exceptionA.error) }
          : { status: exceptionAOwner === ownerAId ? STATUS.PASS : STATUS.FAIL,
              actual: `${exceptionA.rows.length} riviä, user_id=${exceptionAOwner || '-'}` },
        '')
    : skipped('E1a', 'A luo poikkeuksen omaan rutiiniinsa', '1 rivi', 'A:n rutiinia ei syntynyt'));

  const exceptionAExists = Boolean(exceptionA && exceptionA.rows.length === 1);

  push(exceptionAExists
    ? row('E1b', 'A lukee ja päivittää oman poikkeuksensa', '1 rivi',
        expectRows(await call(() =>
          a.from('routine_exceptions').update({ type: 'reschedule' })
            .eq('id', id.exceptionA).select()), 1), '')
    : skipped('E1b', 'A lukee ja päivittää oman poikkeuksensa', '1 rivi', 'poikkeusta ei syntynyt'));

  // --- E2: B ei näe A:n poikkeusta -----------------------------------
  push(exceptionAExists
    ? row('E2a', 'B ei näe A:n poikkeusta, jonka tunnisteen se tietää', '0 riviä',
        expectDenied(await call(() =>
          b.from('routine_exceptions').select('id').eq('id', id.exceptionA))), '')
    : skipped('E2a', 'B ei näe A:n poikkeusta', '0 riviä', 'poikkeusta ei syntynyt'));

  push(row('E2b', 'B ei näe yhtään A:n poikkeusta listauksessa', '0 riviä',
    expectDenied(await call(() =>
      b.from('routine_exceptions').select('id').eq('user_id', ownerAId))), ''));

  // --- E3: B ei voi muuttaa A:n poikkeusta ---------------------------
  push(exceptionAExists
    ? row('E3a', 'B:n UPDATE A:n poikkeukseen osuu nollaan riviin', '0 riviä',
        expectDenied(await call(() =>
          b.from('routine_exceptions').update({ type: 'skip' })
            .eq('id', id.exceptionA).select())), '')
    : skipped('E3a', 'B:n UPDATE A:n poikkeukseen', '0 riviä', 'poikkeusta ei syntynyt'));

  push(exceptionAExists
    ? row('E3b', 'B:n DELETE A:n poikkeukseen osuu nollaan riviin', '0 riviä',
        expectDenied(await call(() =>
          b.from('routine_exceptions').delete().eq('id', id.exceptionA).select())), '')
    : skipped('E3b', 'B:n DELETE A:n poikkeukseen', '0 riviä', 'poikkeusta ei syntynyt'));

  push(routineAExists
    ? row('E3c', 'B ei voi luoda poikkeusta A:n nimiin',
        `virhe ${INSUFFICIENT_PRIVILEGE}`,
        expectRejected(await call(() =>
          b.from('routine_exceptions')
            .insert({ ...exceptionRow(id.forgedExceptionB, id.routineA,
                                      poikkeusPaivat.forgedB),
                      user_id: ownerAId })
            .select())),
        'INSERT-politiikan WITH CHECK')
    : skipped('E3c', 'B ei voi luoda poikkeusta A:n nimiin', 'virhe', 'A:n rutiinia ei syntynyt'));

  // --- E4: RISTIINKIINNITYSHYÖKKÄYS ----------------------------------
  //
  // TÄMÄ ON KOKO OSUUDEN TÄRKEIN TESTI.
  //
  // B tuntee A:n rutiinin tunnisteen ja yrittää kiinnittää siihen OMAN
  // poikkeuksensa: user_id jää B:ksi (kanta asettaa sen), mutta
  // routine_id osoittaa A:n rutiiniin.
  //
  // RLS EI ESTÄ TÄTÄ. INSERT-politiikan WITH CHECK vertaa vain
  // omistajaa, ja omistaja on oikein — B. Vierasavaimen tarkistus taas
  // ei kulje RLS:n läpi lainkaan, joten pelkkä routine_id-viittaus
  // menisi läpi vaikka rutiini kuuluu toiselle.
  //
  // Ainoa este on yhdistelmävierasavain
  // routine_exceptions(user_id, routine_id) -> routines(user_id, id).
  // Paria (B, A:n rutiini) ei ole olemassa, joten kanta hylkää rivin
  // koodilla 23503 (foreign_key_violation).
  //
  // Jos tämä menisi läpi, B:n rivi viittaisi toisen ihmisen dataan.
  push(routineAExists
    ? row('E4', 'B ei voi kiinnittää omaa poikkeustaan A:n rutiiniin',
        `virhe ${FOREIGN_KEY_VIOLATION}`,
        expectRejected(await call(() =>
          b.from('routine_exceptions')
            .insert(exceptionRow(id.attackExceptionB, id.routineA, poikkeusPaivat.attackB))
            .select()), FOREIGN_KEY_VIOLATION),
        'yhdistelmävierasavain (user_id, routine_id) — RLS ei estäisi tätä')
    : skipped('E4', 'B ei voi kiinnittää poikkeustaan A:n rutiiniin',
        `virhe ${FOREIGN_KEY_VIOLATION}`, 'A:n rutiinia ei syntynyt'));

  // --- E5: B hallitsee omaa poikkeustaan -----------------------------
  const exceptionB = routineBExists
    ? await call(() => b.from('routine_exceptions')
        .insert(exceptionRow(id.exceptionB, id.routineB, poikkeusPaivat.ownB)).select())
    : null;
  push(exceptionB
    ? row('E5a', 'B luo poikkeuksen omaan rutiiniinsa',
        '1 rivi, user_id = B',
        exceptionB.error
          ? { status: STATUS.ERROR, actual: describeError(exceptionB.error) }
          : { status: exceptionB.rows[0] && exceptionB.rows[0].user_id === userBId
                ? STATUS.PASS : STATUS.FAIL,
              actual: `${exceptionB.rows.length} riviä` },
        'todiste ettei E4 epäonnistunut siksi että poikkeusten luonti on rikki')
    : skipped('E5a', 'B luo poikkeuksen omaan rutiiniinsa', '1 rivi', 'B:n rutiinia ei syntynyt'));

  const exceptionBExists = Boolean(exceptionB && exceptionB.rows.length === 1);

  push(exceptionBExists
    ? row('E5b', 'B päivittää oman poikkeuksensa', '1 rivi',
        expectRows(await call(() =>
          b.from('routine_exceptions').update({ type: 'override' })
            .eq('id', id.exceptionB).select()), 1), '')
    : skipped('E5b', 'B päivittää oman poikkeuksensa', '1 rivi', 'poikkeusta ei syntynyt'));

  // --- E6: A ei näe eikä muuta B:n poikkeusta ------------------------
  push(exceptionBExists
    ? row('E6a', 'A ei näe B:n poikkeusta', '0 riviä',
        expectDenied(await call(() =>
          a.from('routine_exceptions').select('id').eq('id', id.exceptionB))), '')
    : skipped('E6a', 'A ei näe B:n poikkeusta', '0 riviä', 'poikkeusta ei syntynyt'));

  push(exceptionBExists
    ? row('E6b', 'A:n UPDATE B:n poikkeukseen osuu nollaan riviin', '0 riviä',
        expectDenied(await call(() =>
          a.from('routine_exceptions').update({ type: 'skip' })
            .eq('id', id.exceptionB).select())), '')
    : skipped('E6b', 'A:n UPDATE B:n poikkeukseen', '0 riviä', 'poikkeusta ei syntynyt'));

  push(exceptionBExists
    ? row('E6c', 'A:n DELETE B:n poikkeukseen osuu nollaan riviin', '0 riviä',
        expectDenied(await call(() =>
          a.from('routine_exceptions').delete().eq('id', id.exceptionB).select())), '')
    : skipped('E6c', 'A:n DELETE B:n poikkeukseen', '0 riviä', 'poikkeusta ei syntynyt'));

  push(exceptionBExists
    ? row('E6d', 'B:n poikkeus on tallella A:n yritysten jälkeen', '1 rivi',
        expectRows(await call(() =>
          b.from('routine_exceptions').select('id').eq('id', id.exceptionB)), 1),
        'todiste ettei E6b/E6c onnistunut vain siksi että rivi katosi')
    : skipped('E6d', 'B:n poikkeus on tallella', '1 rivi', 'poikkeusta ei syntynyt'));

  // =================================================================
  // MIGRAATIOT 0004-0008: TAVOITTEET, PROJEKTIT, ASETUKSET,
  // HYVINVOINTI, TALOUS JA KIRJAUSKETJU
  // =================================================================
  //
  // Seitseman naista kahdeksasta taulusta noudattaa samaa turvamallia:
  // omistaja on user_id, sen asettaa kanta, ja nelja politiikkaa
  // rajaavat rivit omistajaan. Niiden matriisi ajetaan yhdesta
  // paikasta (ownershipSection), jotta jokainen taulu saa saman
  // kohtelun tai ei yhtaan.
  //
  // notification_preferences on kahdeksas ja erilainen: sen omistaja on
  // paaavain itse. Se testataan erikseen alla.
  //
  // RISTIINKIINNITYS EI OLE TAALLA. Se on jokaisessa taulussa eri viite
  // ja eri hyokkays, ja se kirjoitetaan auki omana lohkonaan.

  const ctx = { push, a, b, ownerAId, userBId };

  // --- G: tavoitteet -------------------------------------------------
  const goals = await ownershipSection(ctx, {
    code: 'G', table: 'goals', label: 'tavoitteen',
    rowA: goalRow(id.goalA, 'A:n tavoite'),
    rowB: goalRow(id.goalB, 'B:n tavoite'),
    forged: goalRow(id.forgedGoalB, 'ei saa onnistua'),
    patch: { title: 'muokattu' }, patchField: 'title', patchValue: 'muokattu'
  });

  // --- J: projektit --------------------------------------------------
  const projects = await ownershipSection(ctx, {
    code: 'J', table: 'projects', label: 'projektin',
    rowA: projectRow(id.projectA, 'A:n projekti'),
    rowB: projectRow(id.projectB, 'B:n projekti'),
    forged: projectRow(id.forgedProjectB, 'ei saa onnistua'),
    patch: { name: 'muokattu' }, patchField: 'name', patchValue: 'muokattu'
  });

  // --- W: hyvinvointimerkinnat ---------------------------------------
  //
  // Paivamaarat ovat tarkoituksella kaukana menneisyydessa ja eri
  // kummallakin tilillae. Taulussa on `unique (user_id, date)`, ja
  // oikean paivan kayttaminen voisi tormata kayttajan omaan merkintaan
  // — silloin testi kaatuisi syysta, jolla ei ole tekemista RLS:n
  // kanssa.
  const wellbeing = await ownershipSection(ctx, {
    code: 'W', table: 'wellbeing_entries', label: 'merkinnän',
    rowA: wellbeingRow(id.wellbeingA, '1990-01-01', 3),
    rowB: wellbeingRow(id.wellbeingB, '1990-01-02', 3),
    forged: wellbeingRow(id.forgedWellbeingB, '1990-01-03', 3),
    patch: { energy: 5 }, patchField: 'energy', patchValue: 5
  });

  // --- X: toistuvat kulut --------------------------------------------
  const expenses = await ownershipSection(ctx, {
    code: 'X', table: 'recurring_expenses', label: 'toistuvan kulun',
    rowA: recurringExpenseRow(id.expenseA, 'A:n kulu', today),
    rowB: recurringExpenseRow(id.expenseB, 'B:n kulu', today),
    forged: recurringExpenseRow(id.forgedExpenseB, 'ei saa onnistua', today),
    patch: { name: 'muokattu' }, patchField: 'name', patchValue: 'muokattu'
  });

  // --- L: laskut -----------------------------------------------------
  const bills = await ownershipSection(ctx, {
    code: 'L', table: 'bills', label: 'laskun',
    rowA: billRow(id.billA, 'A:n lasku', today),
    rowB: billRow(id.billB, 'B:n lasku', today),
    forged: billRow(id.forgedBillB, 'ei saa onnistua', today),
    patch: { name: 'muokattu' }, patchField: 'name', patchValue: 'muokattu'
  });

  // --- S: saastotavoitteet -------------------------------------------
  await ownershipSection(ctx, {
    code: 'S', table: 'savings_goals', label: 'säästötavoitteen',
    rowA: savingsGoalRow(id.savingsA, 'A:n säästö'),
    rowB: savingsGoalRow(id.savingsB, 'B:n säästö'),
    forged: savingsGoalRow(id.forgedSavingsB, 'ei saa onnistua'),
    patch: { name: 'muokattu' }, patchField: 'name', patchValue: 'muokattu'
  });

  // --- K: AI-kirjausketju --------------------------------------------
  await ownershipSection(ctx, {
    code: 'K', table: 'ai_action_audit', label: 'kirjauksen',
    rowA: auditRow(id.auditA),
    rowB: auditRow(id.auditB),
    forged: auditRow(id.forgedAuditB),
    patch: { result: 'cancelled' }, patchField: 'result', patchValue: 'cancelled'
  });

  // --- K9: kirjausketjun keskeinen invariantti -----------------------
  //
  // Kirjaus ei saa vaittaa, etta komento suoritettiin ilman
  // vahvistusta. Migraatio testaa taman ajaessaan, mutta se testaa sen
  // kannan omistajan oikeuksilla. Tama testaa saman OIKEALLA
  // kayttajalla: rajoite ei saa olla sellainen, joka koskee vain
  // migraatiota.
  push(row('K9', 'Vahvistamatonta suoritusta ei voi kirjata',
    'virhe 23514 (check_violation)',
    expectRejected(await call(() =>
      b.from('ai_action_audit')
        .insert({ ...auditRow(id.invariantB), executed: true, confirmed: false })
        .select()), '23514'),
    'ai_action_audit_confirmed_check — turvamallin rikkoutumista ei saa voida kirjata tapahtuneeksi'));

  // --- N: muistutusasetukset -----------------------------------------
  //
  // TAMAN TAULUN OMISTAJUUSMALLI ON ERI KUIN MUIDEN.
  //
  // Omistaja ei ole erillinen user_id-sarake vaan paaavain itse:
  // `id uuid primary key default auth.uid()`. Politiikat kohdistuvat
  // id-sarakkeeseen, ja rivi on tasan yksi per kayttaja.
  //
  // Siksi taalla ei ole "B ei voi luoda rivia A:n nimiin" erillisena
  // vaarennoksena: rivin luominen A:n nimiin ON id:n asettaminen A:ksi,
  // ja se on N3.
  const prefsA = await call(() =>
    a.from('notification_preferences').insert(notificationPrefsRow(ownerAId)).select());
  push(row('N1', 'A luo omat muistutusasetuksensa', '1 rivi, id = A',
    prefsA.error
      ? { status: STATUS.ERROR, actual: describeError(prefsA.error) }
      : { status: prefsA.rows[0] && prefsA.rows[0].id === ownerAId ? STATUS.PASS : STATUS.FAIL,
          actual: `${prefsA.rows.length} riviä, id=${prefsA.rows[0] ? prefsA.rows[0].id : '-'}` },
    'id on sekä pääavain että omistaja'));

  const prefsAExists = prefsA.rows.length === 1;

  push(prefsAExists
    ? row('N2', 'B ei näe A:n muistutusasetuksia', '0 riviä',
        expectDenied(await call(() =>
          b.from('notification_preferences').select('id').eq('id', ownerAId))),
        'SELECT-politiikka rajaa id:llä, ei user_id:llä')
    : skipped('N2', 'B ei näe A:n muistutusasetuksia', '0 riviä', 'A:n riviä ei syntynyt'));

  // TAMA ON TAMAN TAULUN TARKEIN TESTI.
  //
  // B yrittaa kirjoittaa rivin, jonka id on A. Muissa tauluissa
  // vastaava yritys on omistajakentan vaarennos; taalla se on
  // paaavaimen vaarennos, ja jos se menisi lapi, B kirjoittaisi A:n
  // asetukset — eli paattaisi milloin A saa ilmoituksia.
  push(row('N3', 'B ei voi kirjoittaa A:n muistutusasetuksia',
    `virhe ${INSUFFICIENT_PRIVILEGE}`,
    expectRejected(await call(() =>
      b.from('notification_preferences')
        .insert({ ...notificationPrefsRow(ownerAId), enabled: true })
        .select())),
    'INSERT-politiikan WITH CHECK (auth.uid() = id)'));

  push(prefsAExists
    ? row('N4', 'B:n UPDATE A:n asetuksiin osuu nollaan riviin', '0 riviä',
        expectDenied(await call(() =>
          b.from('notification_preferences').update({ enabled: true })
            .eq('id', ownerAId).select())),
        'UPDATE-politiikan USING')
    : skipped('N4', 'B:n UPDATE A:n asetuksiin', '0 riviä', 'A:n riviä ei syntynyt'));

  const prefsB = await call(() =>
    b.from('notification_preferences').insert(notificationPrefsRow(userBId)).select());
  push(row('N5', 'B luo omat muistutusasetuksensa', '1 rivi, id = B',
    prefsB.error
      ? { status: STATUS.ERROR, actual: describeError(prefsB.error) }
      : { status: prefsB.rows[0] && prefsB.rows[0].id === userBId ? STATUS.PASS : STATUS.FAIL,
          actual: `${prefsB.rows.length} riviä, id=${prefsB.rows[0] ? prefsB.rows[0].id : '-'}` },
    'kielto ei johdu siitä että B ei voisi kirjoittaa lainkaan'));

  const prefsBExists = prefsB.rows.length === 1;

  push(prefsAExists
    ? row('N6', 'A:n asetukset ovat koskemattomat', '1 rivi, enabled = false',
        await (async () => {
          const jalkeen = await call(() =>
            a.from('notification_preferences').select('id,enabled').eq('id', ownerAId));
          if (jalkeen.error) return { status: STATUS.ERROR, actual: describeError(jalkeen.error) };
          const ok = jalkeen.rows.length === 1 && jalkeen.rows[0].enabled === false;
          return { status: ok ? STATUS.PASS : STATUS.FAIL,
                   actual: `${jalkeen.rows.length} riviä, enabled=`
                           + `${jalkeen.rows[0] ? jalkeen.rows[0].enabled : '-'}` };
        })(),
        'B yritti kääntää A:n ilmoitukset päälle — hiljaisuus on oletus')
    : skipped('N6', 'A:n asetukset ovat koskemattomat', '1 rivi', 'A:n riviä ei syntynyt'));

  // =================================================================
  // RISTIINKIINNITYSHYOKKAYKSET
  // =================================================================
  //
  // TAMA ON KOKO HYVAKSYNTATESTIN TARKEIN OSUUS.
  //
  // Migraatiot 0004 ja 0007 muuttivat kahdeksan yhden sarakkeen
  // vierasavainta yhdistelmavierasavaimiksi. Tama osuus todistaa, etta
  // muutos puree oikeaa kantaa vasten oikealla kayttajalla — ei vain
  // sita, etta rajoite nakyy luettelossa.
  //
  // MIKSI RLS EI RIITA
  //
  //   RLS ESTAA LUKEMISEN, EI VIITTAAMISTA.
  //
  // Kun B lahettaa rivin, jonka goal_id on A:n tavoitteen tunniste,
  // INSERT-politiikan WITH CHECK vertaa vain OMISTAJAA — ja omistaja on
  // oikein, B. Vierasavaimen tarkistus taas ei kulje RLS:n lapi
  // lainkaan: kanta katsoo, onko rivi olemassa, ei sita saisiko
  // viittaaja nahda sen.
  //
  // Ainoa este on yhdistelmavierasavain
  // (user_id, viite) -> kohde(user_id, id). Paria (B, A:n rivi) ei ole
  // olemassa, joten kanta hylkaa rivin koodilla 23503.
  //
  // ODOTETTU KOODI ON OSA VAITETTA. Jos jokin nailla palauttaisi
  // 42501:n, rivi olisi kylla torjuttu — mutta RLS:n toimesta, ei
  // eheysrajoitteen. Silloin suoja riippuisi politiikasta, joka voidaan
  // muuttaa, eika rakenteesta. Siksi vaara koodi on ERROR eika PASS.
  //
  // KAHDEKSAN VIITETTA, KAKSI TAPAA KUMPIKIN
  // INSERT: B luo uuden rivin, joka viittaa A:n riviin.
  // UPDATE: B ottaa OMAN olemassa olevan rivinsa ja kaantaa viitteen
  //         A:n riviin. Tama on eri koodipolku: rivi lapaisee RLS:n,
  //         koska se on B:n oma, ja vain vierasavain voi torjua sen.

  /** Yksi ristiinkiinnitysyritys, INSERT. */
  const attackInsert = async (no, table, kuvaus, rivi, edellytys, selite) => {
    push(edellytys
      ? row(no, kuvaus, `virhe ${FOREIGN_KEY_VIOLATION}`,
          expectRejected(await call(() => b.from(table).insert(rivi).select()),
            FOREIGN_KEY_VIOLATION),
          selite)
      : skipped(no, kuvaus, `virhe ${FOREIGN_KEY_VIOLATION}`,
          'kohderiviä ei syntynyt — hyökkäystä ei voitu kokeilla'));
  };

  /** Yksi ristiinkiinnitysyritys, UPDATE omaan riviin. */
  const attackUpdate = async (no, table, kuvaus, omaId, muutos, edellytys, selite) => {
    push(edellytys
      ? row(no, kuvaus, `virhe ${FOREIGN_KEY_VIOLATION}`,
          expectRejected(await call(() =>
            b.from(table).update(muutos).eq('id', omaId).select()),
            FOREIGN_KEY_VIOLATION),
          selite)
      : skipped(no, kuvaus, `virhe ${FOREIGN_KEY_VIOLATION}`,
          'oma tai kohderivi puuttuu — hyökkäystä ei voitu kokeilla'));
  };

  // --- 0004:n kuusi viitetta -----------------------------------------

  await attackInsert('X1', 'goals',
    'B ei voi tehdä tavoitteestaan A:n tavoitteen alatavoitetta',
    goalRow(id.attackGoalParentB, 'hyökkäys', { parentGoalId: id.goalA }),
    goals.aExists,
    'goals_parent_goal_fkey (user_id, parent_goal_id) -> goals (user_id, id)');

  await attackInsert('X2', 'goals',
    'B ei voi liittää tavoitettaan A:n projektiin',
    goalRow(id.attackGoalProjectB, 'hyökkäys', { projectId: id.projectA }),
    projects.aExists,
    'goals_project_id_fkey (user_id, project_id) -> projects (user_id, id)');

  await attackInsert('X3', 'projects',
    'B ei voi liittää projektiaan A:n tavoitteeseen',
    projectRow(id.attackProjectGoalB, 'hyökkäys', { goalId: id.goalA }),
    goals.aExists,
    'projects_goal_id_fkey (user_id, goal_id) -> goals (user_id, id)');

  await attackInsert('X4', 'tasks',
    'B ei voi liittää tehtäväänsä A:n tavoitteeseen',
    { ...taskRow(id.attackTaskGoalB, today, 'hyökkäys'), goal_id: id.goalA },
    goals.aExists,
    'tasks_goal_id_fkey (user_id, goal_id) -> goals (user_id, id)');

  await attackInsert('X5', 'tasks',
    'B ei voi liittää tehtäväänsä A:n projektiin',
    { ...taskRow(id.attackTaskProjectB, today, 'hyökkäys'), project_id: id.projectA },
    projects.aExists,
    'tasks_project_id_fkey (user_id, project_id) -> projects (user_id, id)');

  await attackInsert('X6', 'routines',
    'B ei voi liittää rutiiniaan A:n tavoitteeseen',
    { ...routineRow(id.attackRoutineGoalB, 'hyökkäys'), goal_id: id.goalA },
    goals.aExists,
    'routines_goal_id_fkey (user_id, goal_id) -> goals (user_id, id)');

  // --- 0007:n kaksi viitetta -----------------------------------------

  await attackInsert('X7', 'bills',
    'B ei voi liittää laskuaan A:n tehtävään',
    billRow(id.attackBillTaskB, 'hyökkäys', today, { taskId: id.baitA }),
    true,
    'bills_task_id_fkey (user_id, task_id) -> tasks (user_id, id)');

  await attackInsert('X8', 'bills',
    'B ei voi liittää laskuaan A:n toistuvaan kuluun',
    billRow(id.attackBillExpenseB, 'hyökkäys', today, { recurringExpenseId: id.expenseA }),
    expenses.aExists,
    'bills_recurring_expense_id_fkey (user_id, recurring_expense_id) -> recurring_expenses (user_id, id)');

  // --- Samat kahdeksan UPDATElla -------------------------------------
  //
  // Nama ovat eri koodipolku kuin ylla. INSERTissa koko rivi on uusi ja
  // RLS arvioi sen WITH CHECKilla. UPDATEssa rivi on jo olemassa ja se
  // on B:n oma, joten se lapaisee seka USINGin etta WITH CHECKin —
  // omistaja ei muutu. Vain vierasavain voi torjua muutoksen.
  //
  // Jos vain INSERT testattaisiin, kanta voisi olla suojattu luonnissa
  // ja auki muokkauksessa, eika mikaan kertoisi sita.

  await attackUpdate('U1', 'goals',
    'B ei voi UPDATElla siirtää tavoitettaan A:n alatavoitteeksi',
    id.goalB, { parent_goal_id: id.goalA }, goals.aExists && goals.bExists,
    'sama vierasavain kuin X1, eri koodipolku');

  await attackUpdate('U2', 'goals',
    'B ei voi UPDATElla liittää tavoitettaan A:n projektiin',
    id.goalB, { project_id: id.projectA }, projects.aExists && goals.bExists,
    'sama vierasavain kuin X2, eri koodipolku');

  await attackUpdate('U3', 'projects',
    'B ei voi UPDATElla liittää projektiaan A:n tavoitteeseen',
    id.projectB, { goal_id: id.goalA }, goals.aExists && projects.bExists,
    'sama vierasavain kuin X3, eri koodipolku');

  await attackUpdate('U4', 'tasks',
    'B ei voi UPDATElla liittää tehtäväänsä A:n tavoitteeseen',
    id.keepB, { goal_id: id.goalA }, goals.aExists,
    'sama vierasavain kuin X4, eri koodipolku');

  await attackUpdate('U5', 'tasks',
    'B ei voi UPDATElla liittää tehtäväänsä A:n projektiin',
    id.keepB, { project_id: id.projectA }, projects.aExists,
    'sama vierasavain kuin X5, eri koodipolku');

  await attackUpdate('U6', 'routines',
    'B ei voi UPDATElla liittää rutiiniaan A:n tavoitteeseen',
    id.routineB, { goal_id: id.goalA }, goals.aExists,
    'sama vierasavain kuin X6, eri koodipolku');

  await attackUpdate('U7', 'bills',
    'B ei voi UPDATElla liittää laskuaan A:n tehtävään',
    id.billB, { task_id: id.baitA }, bills.bExists,
    'sama vierasavain kuin X7, eri koodipolku');

  await attackUpdate('U8', 'bills',
    'B ei voi UPDATElla liittää laskuaan A:n toistuvaan kuluun',
    id.billB, { recurring_expense_id: id.expenseA }, expenses.aExists && bills.bExists,
    'sama vierasavain kuin X8, eri koodipolku');

  // --- X9: oma viite SAA onnistua ------------------------------------
  //
  // Ilman tata koko osuus voisi menna lapi siksi, etta viitteet ovat
  // rikki kaikille. Kielto on merkityksellinen vain jos sallittu tapaus
  // toimii.
  push(goals.bExists
    ? row('X9', 'B saa liittää oman tehtävänsä OMAAN tavoitteeseensa', '1 rivi',
        expectRows(await call(() =>
          b.from('tasks')
            .insert({ ...taskRow(id.ownLinkB, today, 'oma liitos'), goal_id: id.goalB })
            .select()), 1),
        'todiste ettei kielto johdu siitä että viitteet olisivat rikki kaikille')
    : skipped('X9', 'B saa liittää tehtävänsä omaan tavoitteeseensa', '1 rivi',
        'B:n tavoitetta ei syntynyt'));

  // =================================================================
  // MIGRAATIOT 0009–0013 (tableSpecs.js), VAIN VALITUN AALLON TAULUT
  // =================================================================
  //
  // Sama omistajuusmatriisi kuin 0004–0008:lla, ja jokaiselle
  // yhdistelmävierasavaimelle kaksi ristiinkiinnityshyökkäystä.
  //
  // JÄRJESTYS: B:n INSERT-hyökkäykset ajastintauluun ajetaan ennen B:n
  // omaa ajastinta. running_timers_one_per_user torjuisi muuten jokaisen
  // hyökkäyksen yksikäsitteisyyteen (23505) eikä vierasavain pääsisi
  // koskaan sanomaan mitään — sama virhe kuin E4:ssä tuotantoajossa.
  const specResults = {};
  const specCtx = {
    today,
    parents: { goalA: id.goalA, goalB: id.goalB }
  };
  const runSpec = async entry => {
    const sid = specIdsFor(runId, entry.code);
    specResults[entry.table] = await ownershipSection(ctx, {
      code: entry.code, table: entry.table, label: entry.label,
      rowA: entry.row(sid.a, 'a', specCtx),
      rowB: entry.row(sid.b, 'b', specCtx),
      forged: entry.row(sid.forged, 'forged', specCtx),
      patch: entry.patch, patchField: entry.patchField, patchValue: entry.patchValue
    });
  };

  for (const entry of specs.filter(candidate => candidate.table !== 'running_timers')) {
    await runSpec(entry);
  }

  // A:n rivit, joihin B yrittää viitata. null = riviä ei syntynyt.
  const exists = table => Boolean(specResults[table] && specResults[table].aExists);
  const parentA = {
    goals: goals.aExists ? id.goalA : null,
    projects: projects.aExists ? id.projectA : null,
    tasks: baitExists ? id.baitA : null,
    routines: routineAExists ? id.routineA : null,
    life_areas: exists('life_areas') ? specIdsFor(runId, 'LA').a : null,
    milestones: exists('milestones') ? specIdsFor(runId, 'MS').a : null
  };
  // B:n OMAT rivit, joiden viitteen B yrittää kääntää A:han.
  const ownB = table => {
    if (table === 'tasks') return bKeepExists ? id.keepB : null;
    if (table === 'projects') return projects.bExists ? id.projectB : null;
    if (table === 'goals') return goals.bExists ? id.goalB : null;
    const entry = specFor(table);
    return entry && specResults[table] && specResults[table].bExists
      ? specIdsFor(runId, entry.code).b : null;
  };
  /** Uusi B:n rivi tauluun `table`, joka viittaa A:n riviin. */
  const attackRow = probe => {
    const attackId = attackIdFor(runId, probe);
    const base = probe.table === 'tasks' ? taskRow(attackId, today, 'hyökkäys')
      : probe.table === 'projects' ? projectRow(attackId, 'hyökkäys')
        : probe.table === 'goals' ? goalRow(attackId, 'hyökkäys')
          : specFor(probe.table).row(attackId, 'b', specCtx);
    return { ...base, [probe.column]: parentA[probe.parent] };
  };

  const insertProbe = async probe => {
    const kuvaus = `B ei voi luoda riviä tauluun ${probe.table}, jonka ${probe.column} on A:n rivi`;
    if (!parentA[probe.parent]) {
      push(skipped(`XV-${probe.key}`, kuvaus, `virhe ${FOREIGN_KEY_VIOLATION}`,
        `A:n riviä taulussa ${probe.parent} ei syntynyt — hyökkäystä ei voitu kokeilla`));
      return;
    }
    const tulos = await call(() => b.from(probe.table).insert(attackRow(probe)).select());
    let selite = `(user_id, ${probe.column}) -> ${probe.parent} (user_id, id), migraatio ${probe.migration}`;
    if (!tulos.error && tulos.rows.length > 0) {
      // Suoja petti. Rivi poistetaan heti tunnisteella: yksi ajastin
      // käyttäjää kohti tekisi muuten seuraavista hyökkäyksistä 23505:n
      // eikä niistä näkisi, pitääkö OMA vierasavain.
      await call(() => b.from(probe.table).delete().eq('id', attackIdFor(runId, probe)).select());
      selite += '; läpi mennyt rivi poistettiin heti';
    }
    push(row(`XV-${probe.key}`, kuvaus, `virhe ${FOREIGN_KEY_VIOLATION}`,
      expectRejected(tulos, FOREIGN_KEY_VIOLATION), selite));
  };

  // Ajastimen INSERT-hyökkäykset ensin (ks. JÄRJESTYS yllä), sitten muut.
  const timerFirst = [...probes].sort((x, y) =>
    Number(y.table === 'running_timers') - Number(x.table === 'running_timers'));
  for (const probe of timerFirst) await insertProbe(probe);

  for (const entry of specs.filter(candidate => candidate.table === 'running_timers')) {
    await runSpec(entry);
  }

  // UPDATE: B:n oma rivi läpäisee RLS:n (omistaja ei muutu), joten vain
  // vierasavain voi torjua viitteen kääntämisen A:n riviin.
  for (const probe of probes) {
    const kuvaus = `B ei voi UPDATElla kääntää oman rivinsä ${probe.table}.${probe.column} A:n riviin`;
    const oma = ownB(probe.table);
    push(oma && parentA[probe.parent]
      ? row(`UV-${probe.key}`, kuvaus, `virhe ${FOREIGN_KEY_VIOLATION}`,
          expectRejected(await call(() =>
            b.from(probe.table).update({ [probe.column]: parentA[probe.parent] }).eq('id', oma).select()),
            FOREIGN_KEY_VIOLATION),
          `sama vierasavain kuin XV-${probe.key}, eri koodipolku`)
      : skipped(`UV-${probe.key}`, kuvaus, `virhe ${FOREIGN_KEY_VIOLATION}`,
          'oma tai kohderivi puuttuu — hyökkäystä ei voitu kokeilla'));
  }

  // Sallittu viite: B:n kirjaus B:n omaan alueeseen. Ilman tätä kiellot
  // voisivat mennä läpi siksi, että viitteet ovat rikki kaikille.
  if (specs.some(entry => entry.table === 'time_entries')) {
    const omaKirjaus = ownB('time_entries');
    const omaAlue = ownB('life_areas');
    push(omaKirjaus && omaAlue
      ? row('XV-ok', 'B saa liittää oman aikakirjauksensa OMAAN elämänalueeseensa', '1 rivi',
          expectRows(await call(() =>
            b.from('time_entries').update({ life_area_id: omaAlue }).eq('id', omaKirjaus).select()), 1),
          'todiste ettei XV/UV-kielto johdu siitä että viitteet olisivat rikki kaikille')
      : skipped('XV-ok', 'B saa liittää kirjauksensa omaan alueeseensa', '1 rivi',
          'B:n kirjausta tai aluetta ei syntynyt'));
  }

  // POHDINTA ERI ARVOLLA. Omistajuusmatriisin AR3a käyttää samaa arvoa
  // kuin A:n oma päivitys, joten pelkkä AR3e ei erottaisi onnistunutta
  // kaappausta. Tässä B yrittää omaa tekstiään, ja A:n rivi luetaan.
  if (exists('alignment_reviews')) {
    const aReview = specIdsFor(runId, 'AR').a;
    const reviewSpec = specFor('alignment_reviews');
    push(row('AR6a', 'B:n UPDATE A:n viikkokatsauksen pohdintaan osuu nollaan riviin', '0 riviä',
      expectDenied(await call(() =>
        b.from('alignment_reviews').update({ reflection: 'B:n kaappaama pohdinta' })
          .eq('id', aReview).select())),
      'pohdinta on sovelluksen yksityisin sarake'));
    push(row('AR6b', 'A:n pohdinta on A:n kirjoittama B:n yrityksen jälkeen', '1 rivi, oma pohdinta',
      await (async () => {
        const jalkeen = await call(() =>
          a.from('alignment_reviews').select('id,reflection').eq('id', aReview));
        if (jalkeen.error) return { status: STATUS.ERROR, actual: describeError(jalkeen.error) };
        const ok = jalkeen.rows.length === 1 && jalkeen.rows[0].reflection === reviewSpec.patchValue;
        return { status: ok ? STATUS.PASS : STATUS.FAIL,
                 actual: `${jalkeen.rows.length} riviä, ${ok ? 'pohdinta ennallaan' : 'POHDINTA MUUTTUI'}` };
      })(),
      'arvoa ei tulosteta raporttiin'));
  }

  // --- T6: kirjautumaton ei saa mitään -------------------------------
  //
  // anon-roolilta on peruttu kaikki oikeudet, joten tämä ei edes yllä
  // RLS:ään asti: kanta hylkää lauseen oikeudettomana.
  push(row('T6a', 'Kirjautumaton ei saa lukea tehtäviä',
    `virhe ${INSUFFICIENT_PRIVILEGE}`,
    expectRejected(await call(() => anon.from('tasks').select('id'))),
    'anon-roolilta on peruttu kaikki oikeudet — RLS ei ole ainoa este'));

  push(row('T6b', 'Kirjautumaton ei saa lukea profiilia',
    `virhe ${INSUFFICIENT_PRIVILEGE}`,
    expectRejected(await call(() => anon.from('profile').select('id'))),
    ''));

  // Uudet taulut testataan kaikilla neljalla operaatiolla. Pelkka
  // lukukielto ei riittaisi: GRANT on operaatiokohtainen, ja puuttuva
  // revoke yhdelle operaatiolle jaisi nakymatta jos vain SELECT
  // tarkistettaisiin.
  // Jokainen uusi taulu, jokainen operaatio. Lyhenne on raportin
  // luettavuutta varten; taulun nimi on rivin tekstissa.
  // 0009–0013:n taulut (kaikki tekstiavaimellisia) samalla silmukalla.
  const anonKohteet = [
    ...ANON_KOHTEET,
    ...specs.map(entry => ({
      lyhenne: entry.code.toLowerCase(), taulu: entry.table, kohde: `${MARKER_PREFIX}anon`
    }))
  ];
  for (const { lyhenne, taulu, kohde } of anonKohteet) {
    const yritykset = [
      ['select', () => anon.from(taulu).select('id')],
      ['insert', () => anon.from(taulu).insert({ id: kohde }).select()],
      ['update', () => anon.from(taulu).update({ id: kohde })
        .eq('id', kohde).select()],
      ['delete', () => anon.from(taulu).delete().eq('id', kohde).select()]
    ];

    for (const [operaatio, kysely] of yritykset) {
      push(row(`T6-${lyhenne}-${operaatio}`,
        `Kirjautumaton ei saa ${operaatio}-oikeutta tauluun ${taulu}`,
        `virhe ${INSUFFICIENT_PRIVILEGE}`,
        expectRejected(await call(kysely)),
        'anon-roolilta on peruttu kaikki oikeudet — RLS ei ole ainoa este'));
    }
  }

  // --- Siivous -------------------------------------------------------
  //
  // Ajetaan AINA, myös kriittisen vian jälkeen. Kumpikin tili siivoaa
  // omansa: RLS itse takaa, ettei siivous voi osua toisen riveihin.
  // Kohteena on nimenomainen tunniste, ei koskaan laaja ehto.
  // Etuliite eikä pelkkä syöttirivin tunniste. Jos WITH CHECK olisi
  // pettänyt, kannassa olisi myös B:n väärentämä rivi, jonka omistaja on
  // A — B ei näkisi sitä eikä siis voisi siivota sitä. Vain A voi.
  // Ehto on turvallinen, koska P0 todisti ettei etuliitteellä ollut
  // rivejä ennen ajoa: se voi osua vain tämän ajon luomiin riveihin.
  const cleanupA = await call(() =>
    a.from('tasks').delete().like('id', `${MARKER_PREFIX}%`).select());
  push(row('C1', 'A poistaa omat testirivinsä',
    'ei virhettä; rivit poistuvat tai ovat jo poissa',
    cleanupA.error
      ? { status: STATUS.ERROR, actual: describeError(cleanupA.error) }
      : { status: STATUS.PASS, actual: `${cleanupA.rows.length} riviä` },
    'varsinainen tae on C4-C6, ei tämän lauseen rivimäärä'));

  const cleanupBTasks = await call(() =>
    b.from('tasks').delete().like('id', `${MARKER_PREFIX}%`).select());
  push(row('C2', 'B poistaa omat testirivinsä',
    'kaikki B:n merkityt rivit',
    cleanupBTasks.error
      ? { status: STATUS.ERROR, actual: describeError(cleanupBTasks.error) }
      : { status: STATUS.PASS, actual: `${cleanupBTasks.rows.length} riviä` },
    'like-ehto on turvallinen vain koska RLS rajaa sen B:n omiin riveihin'));

  const cleanupBProfile = await call(() =>
    b.from('profile').delete().eq('id', userBId).select());
  push(row('C3', 'B poistaa oman profiilinsa',
    bProfileExists ? '1 rivi' : '0 riviä',
    expectRows(cleanupBProfile, bProfileExists ? 1 : 0),
    ''));

  // POIKKEUKSET ENNEN RUTIINEJA.
  //
  // Vierasavain on ON DELETE CASCADE, joten rutiinin poisto veisi
  // poikkeukset mukanaan. Ne poistetaan silti ensin ja erikseen: jos
  // luottaisimme cascadeen, siivouksen onnistuminen todistaisi
  // cascaden toiminnan eikä sitä, että poikkeukset ovat oikeasti
  // poistettavissa. Nyt molemmat tulevat todistetuiksi erikseen.
  for (const [tunnus, client, kuka] of [['C4', a, 'A'], ['C5', b, 'B']]) {
    const poikkeukset = await call(() =>
      client.from('routine_exceptions').delete().like('id', `${MARKER_PREFIX}%`).select());
    push(row(tunnus, `${kuka} poistaa omat testipoikkeuksensa`,
      'ei virhettä',
      poikkeukset.error
        ? { status: STATUS.ERROR, actual: describeError(poikkeukset.error) }
        : { status: STATUS.PASS, actual: `${poikkeukset.rows.length} riviä` },
      'like-ehto on turvallinen vain koska RLS rajaa sen omiin riveihin'));
  }

  for (const [tunnus, client, kuka] of [['C6', a, 'A'], ['C7', b, 'B']]) {
    const rutiinit = await call(() =>
      client.from('routines').delete().like('id', `${MARKER_PREFIX}%`).select());
    push(row(tunnus, `${kuka} poistaa omat testirutiininsa`,
      'ei virhettä',
      rutiinit.error
        ? { status: STATUS.ERROR, actual: describeError(rutiinit.error) }
        : { status: STATUS.PASS, actual: `${rutiinit.rows.length} riviä` },
      ''));
  }

  // UUDET TAULUT, RIIPPUVUUSJARJESTYKSESSA.
  //
  // Laskut ensin: ne viittaavat seka tehtaviin etta toistuviin
  // kuluihin. Viitteet ovat ON DELETE SET NULL, joten cascade ei
  // poistaisi niita — kohteen poisto jattaisi laskun kantaan ilman
  // viitetta, ja se jaisi jaannokseksi.
  //
  // Tavoitteet ja projektit viittaavat toisiinsa molempiin suuntiin,
  // molemmat SET NULLilla. Poistojarjestys on siksi vapaa, mutta ne
  // tulevat laskujen ja tehtavien jalkeen: tehtava voi viitata
  // tavoitteeseen, ja rivit poistetaan mieluummin lapsista juureen.
  const SIIVOTTAVAT = [
    'bills', 'recurring_expenses', 'savings_goals',
    'ai_action_audit', 'wellbeing_entries',
    'goals', 'projects'
  ];

  let siivousNo = 13;
  for (const taulu of SIIVOTTAVAT) {
    for (const [client, kuka] of [[a, 'A'], [b, 'B']]) {
      const poisto = await call(() =>
        client.from(taulu).delete().like('id', `${MARKER_PREFIX}%`).select());
      push(row(`C${siivousNo}`, `${kuka} poistaa omat testirivinsä taulusta ${taulu}`,
        'ei virhettä',
        poisto.error
          ? { status: STATUS.ERROR, actual: describeError(poisto.error) }
          : { status: STATUS.PASS, actual: `${poisto.rows.length} riviä` },
        'like-ehto on turvallinen vain koska RLS rajaa sen omiin riveihin'));
      siivousNo += 1;
    }
  }

  // Muistutusasetukset poistetaan tunnisteella, ei etuliitteella: rivin
  // tunniste ON kayttajan uuid, joten etuliite ei osuisi siihen
  // koskaan. Kumpikin tili poistaa vain omansa.
  for (const [client, kuka, uid] of [[a, 'A', ownerAId], [b, 'B', userBId]]) {
    const poisto = await call(() =>
      client.from('notification_preferences').delete().eq('id', uid).select());
    push(row(`C${siivousNo}`, `${kuka} poistaa omat muistutusasetuksensa`,
      'ei virhettä',
      poisto.error
        ? { status: STATUS.ERROR, actual: describeError(poisto.error) }
        : { status: STATUS.PASS, actual: `${poisto.rows.length} riviä` },
      'tunniste on käyttäjän uuid, joten etuliite ei osuisi siihen'));
    siivousNo += 1;
  }

  // 0009–0013: lapset ennen vanhempia (tableSpecs.js CLEANUP_ORDER).
  // Omat tunnukset (CV-), jotta 0003–0008:n numerointi pysyy ennallaan.
  for (const taulu of CLEANUP_ORDER.filter(name => specs.some(entry => entry.table === name))) {
    const lyhenne = specFor(taulu).code.toLowerCase();
    for (const [client, kuka] of [[a, 'A'], [b, 'B']]) {
      const poisto = await call(() =>
        client.from(taulu).delete().like('id', `${MARKER_PREFIX}%`).select());
      push(row(`CV-${lyhenne}-${kuka.toLowerCase()}`, `${kuka} poistaa omat testirivinsä taulusta ${taulu}`,
        'ei virhettä',
        poisto.error
          ? { status: STATUS.ERROR, actual: describeError(poisto.error) }
          : { status: STATUS.PASS, actual: `${poisto.rows.length} riviä` },
        'like-ehto on turvallinen vain koska RLS rajaa sen omiin riveihin'));
    }
  }

  // --- Loppuvarmistus ------------------------------------------------
  const finalA = await call(() => a.from('tasks').select('id'));
  push(row('C8', 'A:n tehtävämäärä on palannut lähtöarvoon',
    `${expectedTaskCount} riviä`, expectRows(finalA, expectedTaskCount),
    'sama luku kuin P1'));

  const markersA = await call(() => a.from('tasks').select('id').like('id', `${MARKER_PREFIX}%`));
  push(row('C9', 'A ei näe yhtään testirivin jäännöstä tasks-taulussa',
    '0 riviä', expectRows(markersA, 0), markersA.rows.map(r => r.id).join(', ')));

  const markersB = await call(() => b.from('tasks').select('id').like('id', `${MARKER_PREFIX}%`));
  push(row('C10', 'B ei näe yhtään testirivin jäännöstä tasks-taulussa',
    '0 riviä', expectRows(markersB, 0), markersB.rows.map(r => r.id).join(', ')));

  // Molemmat tilit tarkistavat molemmat uudet taulut. Yksi tili ei riitä:
  // RLS piilottaa toisen rivit, joten A:n puhdas näkymä ei kerro mitään
  // siitä, jäikö B:lle jotain.
  const JAANNOSTAULUT = [
    ['r', 'routines'], ['e', 'routine_exceptions'],
    ['g', 'goals'], ['j', 'projects'],
    ['w', 'wellbeing_entries'], ['x', 'recurring_expenses'],
    ['l', 'bills'], ['s', 'savings_goals'], ['k', 'ai_action_audit'],
    ...specs.map(entry => [entry.code.toLowerCase(), entry.table])
  ];

  for (const [tunnus, client, kuka] of [['C11', a, 'A'], ['C12', b, 'B']]) {
    for (const [lyhenne, taulu] of JAANNOSTAULUT) {
      const jaannos = await call(() =>
        client.from(taulu).select('id').like('id', `${MARKER_PREFIX}%`));
      push(row(`${tunnus}-${lyhenne}`,
        `${kuka} ei näe jäännöstä taulussa ${taulu}`,
        '0 riviä', expectRows(jaannos, 0),
        jaannos.rows.map(r => r.id).join(', ')));
    }
  }

  // MUISTUTUSASETUKSET ERIKSEEN.
  //
  // Rivin tunniste on kayttajan uuid, joten etuliitehaku ei loytaisi
  // sita. Kumpikin tili tarkistaa oman rivinsa erikseen.
  for (const [tunnus, client, kuka, uid] of
       [['C11-n', a, 'A', ownerAId], ['C12-n', b, 'B', userBId]]) {
    const jaannos = await call(() =>
      client.from('notification_preferences').select('id').eq('id', uid));
    push(row(tunnus, `${kuka} ei näe jäännöstä muistutusasetuksissa`,
      '0 riviä', expectRows(jaannos, 0), ''));
  }

  // RISTIINKIINNITYSYRITYKSET EIVAT SAA OLLA KANNASSA.
  //
  // Tama on eri vaite kuin "siivous onnistui". Yksikaan naista rivista
  // EI SAANUT SYNTYA lainkaan: jokainen niista oli hyokkays, jonka
  // kannan piti torjua. Jos jokin niista loytyy, suoja petti — eika
  // sita nakisi siivouksen rivimaarista, koska siivous poisti ne.
  //
  // Tarkistus tehdaan B:n silmin, koska hyokkaykset olivat B:n rivejae:
  // A ei nakisi niita vaikka ne olisivat kannassa.
  const hyokkaykset = [
    ['goals', [id.attackGoalParentB, id.attackGoalProjectB]],
    ['projects', [id.attackProjectGoalB]],
    ['tasks', [id.attackTaskGoalB, id.attackTaskProjectB]],
    ['routines', [id.attackRoutineGoalB]],
    ['bills', [id.attackBillTaskB, id.attackBillExpenseB]]
  ];

  for (const [taulu, tunnisteet] of hyokkaykset) {
    const loytyi = await call(() =>
      b.from(taulu).select('id').in('id', tunnisteet));
    push(row(`C13-${taulu}`,
      `Ristiinkiinnitysyrityksiä ei ole kannassa taulussa ${taulu}`,
      '0 riviä', expectRows(loytyi, 0),
      loytyi.rows.length > 0
        ? `LÄPI MENNEET: ${loytyi.rows.map(r => r.id).join(', ')}`
        : 'yksikään hyökkäysrivi ei syntynyt'));
  }

  // 0009–0013:n hyökkäysrivit, samoin B:n silmin.
  for (const probe of probes) {
    const loytyi = await call(() =>
      b.from(probe.table).select('id').eq('id', attackIdFor(runId, probe)));
    push(row(`CV13-${probe.key}`,
      `Ristiinkiinnitysyritystä ${probe.key} ei ole kannassa`,
      '0 riviä', expectRows(loytyi, 0),
      loytyi.rows.length > 0 ? 'HYÖKKÄYSRIVI SYNTYI' : 'hyökkäysrivi ei syntynyt'));
  }

  return finish(rows, { runId, ids: id, ...scope, aborted: null });
}

/**
 * Testirivi tasks-tauluun.
 *
 * Sarakkeet ovat samat, jotka sovellus kirjoittaa (ks. rows.js,
 * TASK_COLUMNS_CORE ilman valinnaisia kellonaikoja). user_id EI ole
 * mukana: sen asettaa kanta. Yhtenevyys sovelluksen kanssa on tarkeaa
 * siksi, ettei mahdollinen NOT NULL -sarake kaada koko hyvaksyntatestia
 * sivuseikan takia.
 */
export function taskRow(id, date, title) {
  return { id, date, title, completed: false, is_wake: false };
}

/**
 * Testirivi routines-tauluun.
 *
 * Sarakkeet ovat samat, jotka sovellus kirjoittaa (collectionsRepo,
 * routinesRepo.toRow). user_id, created_at ja updated_at EIVAT ole
 * mukana: ne ovat kannan omaisuutta.
 */
export function routineRow(id, title) {
  return {
    id,
    title,
    description: null,
    category: 'muu',
    priority: 'normaali',
    duration_minutes: 10,
    recurrence_type: 'daily',
    recurrence_weekdays: [],
    preferred_time: null,
    scheduling: 'fixed',
    active: true,
    goal_id: null,
    start_date: null,
    end_date: null
  };
}

/**
 * Testirivi routine_exceptions-tauluun.
 *
 * Sarakkeet ovat samat kahdeksan, jotka sovellus kirjoittaa
 * (routineExceptionsRepo.toRow). user_id, created_at ja updated_at
 * jaavat pois — juuri se tekee E4:sta mielekkaan: kun omistajaa ei
 * laheteta, kanta asettaa sen, ja yhdistelmavierasavain joutuu
 * ratkaisemaan kuuluuko rutiini samalle omistajalle.
 */
export function exceptionRow(id, routineId, date, type = 'skip') {
  return {
    id,
    routine_id: routineId,
    date,
    type,
    time: null,
    duration_minutes: null,
    title: null,
    note: null
  };
}

/**
 * Testirivi goals-tauluun.
 *
 * Sarakkeet ovat samat yksitoista, jotka sovellus kirjoittaa
 * (collectionsRepo, goalsRepo.toRow). user_id, created_at ja updated_at
 * EIVAT ole mukana: ne ovat kannan omaisuutta.
 *
 * parent_goal_id ja project_id ovat parametreja, koska juuri niilla
 * ristiinkiinnitysta yritetaan. Oletuksena molemmat ovat null.
 */
export function goalRow(id, title, { parentGoalId = null, projectId = null } = {}) {
  return {
    id,
    title,
    description: null,
    category: 'muu',
    priority: 'normaali',
    status: 'active',
    target_date: null,
    progress_mode: 'task_based',
    manual_progress: 0,
    parent_goal_id: parentGoalId,
    project_id: projectId
  };
}

/**
 * Testirivi projects-tauluun.
 *
 * Yhdeksan saraketta, samat jotka projectsRepo.toRow kirjoittaa.
 * goal_id on parametri samasta syysta kuin goalRow:ssa.
 */
export function projectRow(id, name, { goalId = null } = {}) {
  return {
    id,
    name,
    description: null,
    category: 'muu',
    priority: 'normaali',
    status: 'active',
    goal_id: goalId,
    start_date: null,
    deadline: null
  };
}

/**
 * Testirivi wellbeing_entries-tauluun.
 *
 * Seitseman saraketta, samat jotka wellbeingRepo.toRow kirjoittaa.
 *
 * `note` jaa aina nulliksi. Se on kayttajan vapaata tekstia, eika tama
 * tyokalu kirjoita sellaista edes omiin testiriveihinsa: rivi voi jaada
 * kantaan jos siivous epaonnistuu, ja silloin siina ei saa olla mitaan
 * mika muistuttaa oikeaa merkintaa.
 */
export function wellbeingRow(id, date, energy = 3) {
  return {
    id,
    date,
    energy,
    mood: null,
    stress: null,
    sleep_hours: null,
    note: null
  };
}

/**
 * Testirivi recurring_expenses-tauluun.
 *
 * Kymmenen saraketta, samat jotka recurringExpensesRepo.toRow
 * kirjoittaa. Summa on SENTTEINA (bigint), kuten koko sovelluksessa.
 */
export function recurringExpenseRow(id, name, nextDueDate) {
  return {
    id,
    name,
    amount_minor: 1000,
    currency: 'EUR',
    cadence: 'monthly',
    day_of_month: null,
    next_due_date: nextDueDate,
    category: 'talous',
    active: true,
    note: null
  };
}

/**
 * Testirivi bills-tauluun.
 *
 * Yksitoista saraketta, samat jotka billsRepo.toRow kirjoittaa.
 *
 * task_id ja recurring_expense_id ovat parametreja: ne ovat ne kaksi
 * viitetta, joilla ristiinkiinnitysta yritetaan.
 */
export function billRow(id, name, dueDate, { taskId = null, recurringExpenseId = null } = {}) {
  return {
    id,
    name,
    amount_minor: 1000,
    currency: 'EUR',
    due_date: dueDate,
    status: 'open',
    paid_date: null,
    category: 'talous',
    task_id: taskId,
    recurring_expense_id: recurringExpenseId,
    note: null
  };
}

/**
 * Testirivi savings_goals-tauluun.
 *
 * Seitseman saraketta, samat jotka savingsGoalsRepo.toRow kirjoittaa.
 */
export function savingsGoalRow(id, name) {
  return {
    id,
    name,
    target_minor: 100000,
    current_minor: 0,
    currency: 'EUR',
    target_date: null,
    note: null
  };
}

/**
 * Testirivi ai_action_audit-tauluun.
 *
 * Samat sarakkeet jotka aiAuditRepo.toRow kirjoittaa, PAITSI
 * occurred_at: repositorio jattaa sen pois kun aikaleimaa ei ole, jotta
 * kannan oletus `now()` paasee voimaan. Nimenomainen NULL kaataisi
 * rivin koodilla 23502, koska sarake on NOT NULL.
 *
 * `input_summary` ja `proposal` jaavat tyhjiksi. Ne ovat kayttajan omaa
 * tekstia, ja koko taulun tarkoitus on rajata sen maaraa.
 */
export function auditRow(id) {
  return {
    id,
    input_summary: '',
    intent: 'create_task',
    risk: 'medium',
    target_type: null,
    target_id: null,
    proposal: null,
    confirmed: false,
    executed: false,
    result: 'proposed',
    error_code: null
  };
}

/**
 * Testirivi notification_preferences-tauluun.
 *
 * Tama on ainoa taulu, jossa selain lahettaa omistajan: paaavain ON
 * omistaja, eika upsertilla ole muuta kohdetta. Politiikka
 * `with check (auth.uid() = id)` hylkaa rivin, jonka id ei ole
 * kirjoittaja itse — selain saa kertoa kuka se on, muttei valehdella.
 *
 * Juuri sita alla oleva N3 yrittaa.
 */
export function notificationPrefsRow(userId) {
  return {
    id: userId,
    enabled: false,
    task_lead_minutes: 10,
    routine_lead_minutes: 5,
    daily_plan_time: '07:30',
    evening_review_time: '21:00',
    daily_plan_enabled: true,
    evening_review_enabled: true,
    deadline_warnings_enabled: true,
    max_per_day: 12,
    quiet_hours_from: '22:00',
    quiet_hours_to: '06:30'
  };
}

/**
 * Testirivi profile-tauluun.
 *
 * Sarakkeet ovat samat, jotka sovellus kirjoittaa (ks. profileRepo.js,
 * profileToRow). id lahetetaan nimenomaisesti: se on samalla
 * INSERT-politiikan WITH CHECK -ehdon myonteinen testi, koska kanta
 * hylkaisi rivin jos id olisi joku muu kuin kirjautunut kayttaja.
 */
export function profileRow(id) {
  return { id, age: 30 };
}

/** Mitkä sarakkeet eroavat kahden rivin välillä. */
function changedColumns(now, before) {
  if (!now || !before) return ['rivi puuttuu'];
  const columns = new Set([...Object.keys(now), ...Object.keys(before)]);
  return [...columns].filter(column => JSON.stringify(now[column]) !== JSON.stringify(before[column]));
}

/** Ovatko rivit sarakkeittain identtiset. */
function sameRow(now, before) {
  return Boolean(now) && Boolean(before) && changedColumns(now, before).length === 0;
}

/**
 * Profiilin arvot säilyttävä payload.
 *
 * Otetaan mukaan vain kirjoitettavat sarakkeet: id on kohdistusehdossa
 * ja legacy_id on migraation jäänne, jota sovellus ei kirjoita.
 */
function preservingPayload(profileRow) {
  const payload = {};
  for (const [key, value] of Object.entries(profileRow)) {
    if (key === 'id' || key === 'legacy_id') continue;
    payload[key] = value;
  }
  // Jos kirjoitettavia sarakkeita ei ole, kirjoitetaan id itsekseen.
  // Se ei muuta mitään, mutta tekee lauseesta laillisen UPDATEn.
  if (Object.keys(payload).length === 0) payload.id = profileRow.id;
  return payload;
}

function finish(rows, meta) {
  const count = status => rows.filter(entry => entry.status === status).length;
  const summary = {
    ...meta,
    total: rows.length,
    pass: count(STATUS.PASS),
    fail: count(STATUS.FAIL),
    error: count(STATUS.ERROR),
    skip: count(STATUS.SKIP)
  };
  // Kokonaistulos on PASS vain jos JOKAINEN rivi on PASS. Ohitettu rivi
  // ei ole hyväksytty rivi — se on rivi, jota ei ajettu.
  summary.verdict = summary.total > 0 && summary.pass === summary.total ? 'PASS' : 'FAIL';
  return { rows, summary };
}

// ---------------------------------------------------------------------
// Raportin muotoilu
// ---------------------------------------------------------------------

const COLUMNS = ['test_no', 'test_name', 'status', 'expected', 'actual', 'details'];

/** Yhdellä kopioinnilla siirtyvä markdown-taulukko. */
export function formatReport(rows, summary) {
  const escape = value => String(value == null ? '' : value).replace(/\|/g, '\\|');
  const lines = [
    `| ${COLUMNS.join(' | ')} |`,
    `| ${COLUMNS.map(() => '---').join(' | ')} |`,
    ...rows.map(entry => `| ${COLUMNS.map(column => escape(entry[column])).join(' | ')} |`)
  ];
  if (summary) {
    lines.push('');
    lines.push(`TULOS: ${summary.verdict} — ${summary.pass}/${summary.total} PASS, `
      + `${summary.fail} FAIL, ${summary.error} ERROR, ${summary.skip} SKIP`);
    lines.push(`ajotunnus: ${summary.runId}`);
    if (summary.wave) {
      lines.push(`aalto: ${summary.wave} — 0009–0013:n taulut ajossa: `
        + `${(summary.tablesInScope || []).join(', ') || 'ei yhtään'}`);
    }
    if (summary.aborted) lines.push(`KESKEYTETTY: ${summary.aborted}`);
  }
  return lines.join('\n');
}
