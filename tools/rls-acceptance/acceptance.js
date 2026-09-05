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

/** Testin luomien rivien tunnisteet yhdestä ajotunnuksesta. */
export function idsFor(runId) {
  const base = `${MARKER_PREFIX}${runId}`;
  return Object.freeze({
    baitA: `${base}_a_bait`,      // A:n omistama syötti, jota B yrittää muuttaa
    keepB: `${base}_b_keep`,      // B:n rivi, joka elää T5:n yli
    tempB: `${base}_b_temp`,      // B:n rivi, jonka B poistaa itse
    forgedB: `${base}_b_forged`   // B:n yritys kirjoittaa A:n nimiin
  });
}

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

/** Odotus: kanta hylkää lauseen oikeudettomana (42501). */
function expectRejected(result) {
  if (!result.error) {
    return { status: STATUS.FAIL, actual: `hyväksyttiin, ${result.rows.length} riviä` };
  }
  if (result.error.code === INSUFFICIENT_PRIVILEGE) {
    return { status: STATUS.PASS, actual: `hylätty ${INSUFFICIENT_PRIVILEGE}` };
  }
  return { status: STATUS.ERROR, actual: describeError(result.error) };
}

/** Odotus: täsmälleen n riviä, ei virhettä. */
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
 * @returns {Promise<{rows: Array, summary: object}>}
 */
export async function runAcceptance(options) {
  const { a, b, anon, ownerAId, userBId, expectedTaskCount, runId, today } = options;

  if (!a || !b || !anon) throw new Error('kaikki kolme clientiä vaaditaan');
  if (!ownerAId || !userBId) throw new Error('molempien tilien tunnisteet vaaditaan');
  if (ownerAId === userBId) throw new Error('A ja B ovat sama tili — testi ei todistaisi mitään');
  if (!runId) throw new Error('ajotunnus vaaditaan');

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

  if (critical) {
    return finish(rows, { runId, ids: id, aborted: 'lähtötila ei ollut odotettu' });
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

  // --- Loppuvarmistus ------------------------------------------------
  const finalA = await call(() => a.from('tasks').select('id'));
  push(row('C4', 'A:n tehtävämäärä on palannut lähtöarvoon',
    `${expectedTaskCount} riviä`, expectRows(finalA, expectedTaskCount),
    'sama luku kuin P1'));

  const markersA = await call(() => a.from('tasks').select('id').like('id', `${MARKER_PREFIX}%`));
  push(row('C5', 'A ei näe yhtään testirivin jäännöstä',
    '0 riviä', expectRows(markersA, 0), markersA.rows.map(r => r.id).join(', ')));

  const markersB = await call(() => b.from('tasks').select('id').like('id', `${MARKER_PREFIX}%`));
  push(row('C6', 'B ei näe yhtään testirivin jäännöstä',
    '0 riviä', expectRows(markersB, 0), markersB.rows.map(r => r.id).join(', ')));

  return finish(rows, { runId, ids: id, aborted: null });
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
    if (summary.aborted) lines.push(`KESKEYTETTY: ${summary.aborted}`);
  }
  return lines.join('\n');
}
