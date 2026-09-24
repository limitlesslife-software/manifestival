// Julkaisujuna 0003–0008: aaltojen määrittely, tila ja työkalut.
//
// MITÄ TÄMÄ VARTIOI
//
// Kymmenen porttia avataan viidessä aallossa, ja jokainen aalto on oma
// tuotantodeploynsä. Yksitoista porttia tuottaisi 1024 yhdistelmää;
// niistä VAIN KUUSI on sallittuja. Kaikki muut ovat tuotantovirheitä:
// portti on avattu liian aikaisin, jäänyt avaamatta tai sulkeutunut
// vahingossa.
//
// Nämä testit lukitsevat sen, että
//
//   1. aallot kattavat kymmenen porttia täsmälleen kerran
//   2. järjestys kunnioittaa oikeita vierasavainriippuvuuksia
//   3. mikä tahansa poikkeama sallitusta kuudesta tilasta havaitaan
//   4. lähdekoodi, service worker ja tilannedokumentti ovat yhtä mieltä
//   5. julkaisumanifesti vastaa git-historiaa, ei omaa väitettään
//   6. aktivoinnin jälkeinen varmistus on vain lukeva ja ehyt

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, read } from './helpers/sources.mjs';
import { analyzeVerifier, outputColumns, REQUIRED_COLUMNS, withoutStrings }
  from './helpers/sql.mjs';

import {
  ALL_GATES, BASE, PRODUCTION, WAVES, WAVE_IDS, cacheVersionOf, cumulativeGates,
  describeMatrix, expectedMatrix, resolveWave, rollbackTargetOf, waveById, waveIndex
} from '../tools/release/waves.mjs';
import {
  currentState, matrixDifferences, parseCacheVersion, parseGates, parseStatusDoc,
  parseTaskExtendedFields
} from '../tools/release/state.mjs';
import { gateDependencies, gateDependencyMap, ownershipForeignKeys }
  from '../tools/release/dependencies.mjs';
import {
  MANIFEST_PATH, buildManifest, readManifest, validateManifest
} from '../tools/release/manifest.mjs';
import { TABLES, TASK_EXTENDED_FIELDS } from '../src/data/schema.js';

const NEWLINE = String.fromCharCode(10);
const POST_ACTIVATION = 'supabase/acceptance/verify_0003_0008_post_activation.sql';
const POST_ACCEPTANCE = 'supabase/acceptance/verify_0003_0008_post_acceptance_final.sql';

// =====================================================================
// AALTOJEN MÄÄRITTELY
// =====================================================================

test('KRIITTINEN: aallot kattavat kymmenen porttia täsmälleen kerran', () => {
  // Portti, joka on kahdessa aallossa, avattaisiin kahdesti — ja
  // toinen kerta olisi turha deploy. Portti, joka ei ole missään
  // aallossa, ei avautuisi koskaan: taulu olisi kannassa mutta
  // sovellus ei kirjoittaisi siihen.
  const kaikki = WAVES.flatMap(w => w.gates);

  assert.equal(new Set(kaikki).size, kaikki.length,
    'sama portti on useammassa kuin yhdessä aallossa');
  assert.deepEqual([...kaikki].sort(), [...ALL_GATES].sort(),
    'aaltojen portit eivät vastaa kymmentä porttia');
});

test('KRIITTINEN: porttiluettelo vastaa schema.js:ää', () => {
  // Jos schema.js:ään lisättäisiin portti jota tämä juna ei tunne, se
  // avautuisi ilman aaltoa, ilman välimuistiversiota ja ilman
  // hyväksyntää.
  assert.deepEqual(Object.keys(TABLES).sort(), [...ALL_GATES].sort(),
    'schema.js:n portit ja julkaisujunan portit ovat erkaantuneet');
});

test('KRIITTINEN: kumulatiivinen matriisi kasvaa monotonisesti', () => {
  // Aallon ei pidä koskaan SULKEA porttia. Peruutus tehdään
  // palaamalla aiempaan committiin, ei kirjoittamalla sulkeva aalto.
  let edellinen = new Set();
  for (const id of WAVE_IDS) {
    const nyt = new Set(cumulativeGates(id));
    for (const portti of edellinen) {
      assert.ok(nyt.has(portti),
        `aalto ${id} sulkee portin ${portti}, jonka aiempi aalto avasi`);
    }
    assert.ok(nyt.size > edellinen.size, `aalto ${id} ei avaa yhtään uutta porttia`);
    edellinen = nyt;
  }

  // Viimeisen aallon jälkeen kaikki kymmenen ovat auki.
  assert.equal(edellinen.size, ALL_GATES.length,
    'viimeisen aallon jälkeen kaikki portit eivät ole auki');
});

test('KRIITTINEN: välimuistiversiot ovat yksilöllisiä ja kasvavia', () => {
  // Sama versio kahdessa aallossa tarkoittaisi, ettei selain huomaa
  // jälkimmäistä lainkaan: sw.js olisi tavulleen sama, eikä uutta
  // service workeria asennettaisi. Portti avautuisi tuotannossa,
  // mutta osa käyttäjistä jäisi vanhaan kuoreen.
  const versiot = [PRODUCTION.cacheVersion, BASE.cacheVersion,
                   ...WAVE_IDS.map(cacheVersionOf)];
  assert.equal(new Set(versiot).size, versiot.length,
    `välimuistiversio toistuu: ${versiot.join(', ')}`);

  const numerot = versiot.map(v => Number(v.slice(1)));
  for (let i = 1; i < numerot.length; i++) {
    assert.ok(numerot[i] > numerot[i - 1],
      `välimuistiversio ei kasva: ${versiot[i - 1]} -> ${versiot[i]}`);
  }
});

test('KRIITTINEN: peruutuskohde on aina edellinen aalto', () => {
  // Perustilaan peruuttaminen aallosta D sulkisi myös aallot A–C,
  // jotka on jo todennettu toimiviksi. Peruutus saa sulkea vain sen
  // mikä epäonnistui.
  assert.equal(rollbackTargetOf('A'), 'BASE');
  for (let i = 1; i < WAVE_IDS.length; i++) {
    assert.equal(rollbackTargetOf(WAVE_IDS[i]), WAVE_IDS[i - 1],
      `aallon ${WAVE_IDS[i]} peruutuskohde ei ole edellinen aalto`);
  }

  // Ja peruutuskohteen matriisi on aidosti suppeampi.
  for (const id of WAVE_IDS) {
    const kohde = rollbackTargetOf(id);
    const auki = new Set(cumulativeGates(id));
    const kohteessa = kohde === 'BASE' ? new Set() : new Set(cumulativeGates(kohde));
    assert.ok(kohteessa.size < auki.size,
      `aallon ${id} peruutuskohde ei sulje yhtään porttia`);
    for (const portti of kohteessa) {
      assert.ok(auki.has(portti),
        `peruutuskohteessa on portti ${portti}, jota aallossa ${id} ei ole`);
    }
  }
});

// =====================================================================
// SALLITUT TILAT — MUTAATIOTESTI
// =====================================================================

test('KRIITTINEN: resolveWave tunnistaa kahdeksan sallittua tilaa', () => {
  for (const id of ['BASE', ...WAVE_IDS]) {
    assert.equal(resolveWave(expectedMatrix(id)), id,
      `aallon ${id} matriisia ei tunnistettu`);
  }
});

test('KRIITTINEN: yhdenkin portin poikkeama muuttaa tai mitätöi tilan', () => {
  // TÄMÄ ON KOKO TYÖKALUN YDIN. Jos jokin muu kuin kahdeksan sallittua
  // matriisia menisi läpi, esitarkistus hyväksyisi tilan jota kukaan
  // ei suunnitellut — ja juuri sellainen tila on se, jossa portti on
  // avautunut vahingossa.
  //
  // Käydään läpi JOKAINEN sallittu tila ja JOKAINEN yhden portin
  // käännös: 8 × 13 = 104 mutaatiota.
  //
  // HUOM. YKSI KÄÄNNÖS EI AINA TUOTA MITÄTÖNTÄ TILAA.
  //
  // Aalto E avaa TASAN YHDEN portin (aiAudit), joten D ja E eroavat
  // toisistaan yhdellä käännöksellä. `resolveWave(D + aiAudit)` on
  // siis E — eikä null, eikä sen kuulukaan olla: E on kelvollinen
  // tila. Väite "yksikin käännös tuottaa mitättömän tilan" olisi
  // yksinkertaisesti epätosi, ja testi joka väittää sen menisi läpi
  // vain jos aaltojaon muoto olisi toinen.
  //
  // Oikea väite on kaksiosainen:
  //   1. käännös tuottaa joko mitättömän tilan tai ERI aallon
  //   2. nimettyä aaltoa vasten (matrixDifferences) jokainen käännös
  //      havaitaan — ja juuri sitä esitarkistus käyttää
  let mutaatioita = 0;
  let mitättömiä = 0;
  const siirtymät = [];

  for (const id of ['BASE', ...WAVE_IDS]) {
    const pohja = expectedMatrix(id);
    for (const portti of ALL_GATES) {
      const mutatoitu = { ...pohja, [portti]: !pohja[portti] };
      mutaatioita += 1;

      const tunnistettu = resolveWave(mutatoitu);
      assert.notEqual(tunnistettu, id,
        `tila ${id} portilla ${portti} käännettynä tunnistettiin yhä aalloksi ${id}:`
        + ` ${describeMatrix(mutatoitu)}`);

      if (tunnistettu === null) mitättömiä += 1;
      else siirtymät.push(`${id}->${tunnistettu} (${portti})`);

      // Ja nimettyä aaltoa vasten käännös havaitaan aina.
      assert.equal(matrixDifferences(mutatoitu, id).length, 1,
        `portin ${portti} käännöstä ei havaittu aaltoa ${id} vasten`);
    }
  }

  // Kymmenen tilaa (BASE + A-I) kertaa kaksikymmentäkaksi porttia.
  assert.equal(mutaatioita, 220, `mutaatioita ajettiin ${mutaatioita}, odotettiin 220`);

  // Ainoat sallitut siirtymät ovat niiden aaltojen välillä, jotka
  // eroavat tasan yhdellä portilla. Jos tähän ilmestyisi uusi pari,
  // aaltojako olisi muuttunut niin että kahta aaltoa ei enää erota
  // toisistaan yhdellä vahingolla.
  assert.deepEqual(siirtymät.sort(),
    ['D->E (aiAudit)', 'E->D (aiAudit)',
     'F->G (milestones)', 'G->F (milestones)'],
    `odottamattomia siirtymiä sallittujen tilojen välillä: ${siirtymät.join(', ')}`);
  // 162 mutaatiota, joista NELJÄ tuottaa toisen kelvollisen aallon.
  //
  // Kaksi paria eroaa tasan yhdellä portilla:
  //   D <-> E  (aiAudit)
  //   F <-> G  (milestones)
  //
  // Aalto F avaa kaksi porttia, joten E <-> F ei ole yhden käännöksen
  // päässä. Uusi pari on odotettu eikä merkki viasta — se on
  // seuraus siitä, että aalto G avaa tasan yhden portin.
  //
  // Aalto H avaa VIISI porttia, joten se ei tuo uutta paria: G:stä
  // H:hon on viiden käännöksen matka. Aalto I avaa NELJÄ porttia,
  // joten sekään ei tuo uutta paria: 220 - 4 sallittua siirtymää = 216.
  assert.equal(mitättömiä, 216);
});

test('KRIITTINEN: puuttuva tai ylimääräinen portti hylätään', () => {
  const pohja = expectedMatrix('A');

  const puuttuva = { ...pohja };
  delete puuttuva.aiAudit;
  assert.equal(resolveWave(puuttuva), null, 'puuttuva portti hyväksyttiin');

  assert.equal(resolveWave({ ...pohja, keksitty: false }), null,
    'ylimääräinen portti hyväksyttiin');

  assert.equal(resolveWave(null), null);
  assert.equal(resolveWave(undefined), null);
  assert.equal(resolveWave({}), null);
  assert.equal(resolveWave('A'), null);
});

test('KRIITTINEN: matrixDifferences löytää jokaisen eron', () => {
  // Esitarkistus nojaa tähän. Jos se vaikenisi erosta, aalto
  // deployattaisiin vajaana.
  for (const id of ['BASE', ...WAVE_IDS]) {
    assert.deepEqual(matrixDifferences(expectedMatrix(id), id), [],
      `oikea matriisi tuotti eron aallossa ${id}`);

    for (const portti of ALL_GATES) {
      const väärä = { ...expectedMatrix(id), [portti]: !expectedMatrix(id)[portti] };
      const erot = matrixDifferences(väärä, id);
      assert.equal(erot.length, 1, `portin ${portti} eroa ei havaittu aallossa ${id}`);
      assert.match(erot[0], new RegExp(portti));
    }
  }
});

// =====================================================================
// AKTIVOINTIJÄRJESTYS VS. VIERASAVAIMET
// =====================================================================

test('KRIITTINEN: vierasavaimet luetaan molemmista ilmoitusmuodoista', () => {
  // Vierasavain voidaan ilmoittaa create table -lohkossa tai
  // jälkikäteen alter tablella. Jos vain jälkimmäinen luettaisiin,
  // routine_exceptions -> routines jäisi huomaamatta — ja se on juuri
  // se riippuvuus, jonka takia rutiinit ja poikkeukset ovat samassa
  // aallossa.
  const viitteet = ownershipForeignKeys();

  // Yhdeksän erästä 0003-0008, kolme migraatiosta 0010, kaksi
  // migraatiosta 0011 ja neljä migraatiosta 0012.
  assert.equal(viitteet.length, 18,
    `omistajuusviitteitä löytyi ${viitteet.length}, odotettiin 18`);

  const parit = viitteet.map(v => `${v.child}->${v.parent}`);
  assert.ok(parit.includes('routine_exceptions->routines'),
    'create table -lohkon sisäinen viite jäi lukematta');
  assert.ok(parit.includes('bills->recurring_expenses'),
    'alter table -muotoinen viite jäi lukematta');

  // Lapsi luetaan oikein silloinkin, kun viitteen ja alter-lauseen
  // väliin osuu toinen alter table. Ilman tempered-kuviota tämä
  // raportoituisi muodossa projects -> projects.
  assert.ok(parit.includes('goals->projects'),
    'goals -> projects luettiin väärin: väliin osuva alter table vei lapsen nimen');
  // Migraation 0010 viitteet. Välitavoite kuuluu tavoitteelle, ja
  // tehtävä sekä projekti voivat viitata välitavoitteeseen.
  for (const odotettu of ['milestones->goals', 'tasks->milestones',
                          'projects->milestones']) {
    assert.ok(parit.includes(odotettu),
      `migraation 0010 viite ${odotettu} jäi lukematta`);
  }

  assert.equal(parit.filter(p => p === 'projects->projects').length, 0,
    'itseviittaus projects -> projects on jäsennysvirhe, ei todellinen viite');
});

test('KRIITTINEN: aktivointijärjestys kunnioittaa jokaista riippuvuutta', () => {
  // Portti, joka avataan ennen viittauskohdettaan, tuottaa
  // vierasavainvirheen heti kun käyttäjä yrittää liittää rivejä.
  const riippuvuudet = gateDependencies();
  assert.ok(riippuvuudet.size >= 4,
    `porttien välisiä riippuvuuksia löytyi vain ${riippuvuudet.size}`);

  const aalto = new Map();
  WAVES.forEach((w, i) => w.gates.forEach(g => aalto.set(g, i)));

  for (const portti of ALL_GATES) {
    assert.ok(aalto.has(portti), `portti ${portti} ei ole missään aallossa`);
  }

  for (const [lapsi, vanhemmat] of riippuvuudet) {
    for (const vanhempi of vanhemmat) {
      assert.ok(aalto.get(vanhempi) <= aalto.get(lapsi),
        `${lapsi} viittaa ${vanhempi}-tauluun, mutta se aktivoidaan myöhemmin`
        + ` (aalto ${aalto.get(vanhempi) + 1} vs ${aalto.get(lapsi) + 1})`);
    }
  }
});

test('KRIITTINEN: keskinäiset riippuvuudet ovat samassa aallossa', () => {
  // goals ja projects viittaavat TOISIINSA. Jos ne olisivat eri
  // aalloissa, kumpi tahansa järjestys rikkoisi toisen suunnan — ja
  // juuri siksi ne ovat samassa aallossa.
  const riippuvuudet = gateDependencies();
  const aalto = new Map();
  WAVES.forEach((w, i) => w.gates.forEach(g => aalto.set(g, i)));

  let kehiä = 0;
  for (const [lapsi, vanhemmat] of riippuvuudet) {
    for (const vanhempi of vanhemmat) {
      if ((riippuvuudet.get(vanhempi) || new Set()).has(lapsi)) {
        kehiä += 1;
        assert.equal(aalto.get(lapsi), aalto.get(vanhempi),
          `${lapsi} ja ${vanhempi} viittaavat toisiinsa mutta ovat eri aalloissa`);
      }
    }
  }
  assert.ok(kehiä >= 2, 'keskinäistä riippuvuutta ei löytynyt — onko jäsennys rikki?');
});

test('KRIITTINEN: aallon taulut vastaavat sen portteja', () => {
  const tauluPortti = {
    routines: 'routines', routine_exceptions: 'routineExceptions',
    goals: 'goals', projects: 'projects',
    notification_preferences: 'notificationPreferences',
    wellbeing_entries: 'wellbeing', bills: 'bills',
    recurring_expenses: 'recurringExpenses', savings_goals: 'savingsGoals',
    ai_action_audit: 'aiAudit',
    transactions: 'transactions', investments: 'investments',
    milestones: 'milestones',
    inbox_items: 'inboxItems', reminders: 'reminders', notices: 'notices',
    travel_plans: 'travelPlans', location_rules: 'locationRules',
    life_areas: 'lifeAreas', weekly_capacities: 'weeklyCapacities',
    time_entries: 'timeEntries', alignment_reviews: 'alignmentReviews'
  };

  for (const wave of WAVES) {
    assert.deepEqual(wave.tables.map(t => tauluPortti[t]).sort(), [...wave.gates].sort(),
      `aallon ${wave.id} taulut eivät vastaa sen portteja`);
  }
});

// =====================================================================
// REPOSITORION NYKYTILA — KOLME LÄHDETTÄ
// =====================================================================

test('KRIITTINEN: nykytila vastaa täsmälleen yhtä sallittua aaltoa', () => {
  const tila = currentState();
  assert.deepEqual(tila.problems, [],
    'lähdekoodi, service worker ja tilannedokumentti eivät ole yhtä mieltä');
  assert.ok(tila.wave !== null,
    `porttimatriisi ei vastaa yhtäkään aaltoa: ${describeMatrix(tila.gates || {})}`);
});

test('KRIITTINEN: jäsennin antaa saman tuloksen kuin moduulin import', () => {
  // Manifestin todennus lukee TOISEN COMMITIN schema.js:n jäsentämällä,
  // koska sitä ei voi importoida. Jos jäsennin erkanisi tulkinnasta,
  // todennus voisi olla vihreä väärästä syystä.
  const jäsennetty = parseGates(read('src/data/schema.js'));
  assert.ok(jäsennetty, 'porttilohkoa ei voitu jäsentää');

  for (const portti of ALL_GATES) {
    assert.equal(jäsennetty[portti], TABLES[portti],
      `${portti}: jäsennin sanoo ${jäsennetty[portti]}, import sanoo ${TABLES[portti]}`);
  }

  assert.equal(parseTaskExtendedFields(read('src/data/schema.js')), TASK_EXTENDED_FIELDS);
});

test('KRIITTINEN: service workerin välimuistiversio vastaa nykyistä aaltoa', () => {
  const tila = currentState();
  const versio = parseCacheVersion(read('sw.js'));
  assert.ok(versio, 'CACHE_VERSION-vakiota ei löytynyt');
  assert.equal(versio, cacheVersionOf(tila.wave),
    `sw.js on ${versio}, aalto ${tila.wave} edellyttää ${cacheVersionOf(tila.wave)}`);
});

test('KRIITTINEN: tilannedokumentin porttitaulukko vastaa lähdekoodia', () => {
  // Operaattori tekee päätöksiä tämän dokumentin varassa juuri
  // aktivoinnin hetkellä. Väärä tila siinä on vaarallisempi kuin
  // puuttuva.
  const dokumentti = parseStatusDoc(read('docs/PRODUCTION-STATUS.md'));
  assert.ok(dokumentti, 'PRODUCTION-STATUS.md:n porttitaulukkoa ei voitu lukea');

  for (const portti of ALL_GATES) {
    assert.equal(dokumentti[portti], TABLES[portti],
      `${portti}: dokumentti sanoo ${dokumentti[portti] ? 'auki' : 'kiinni'},`
      + ` koodi sanoo ${TABLES[portti] ? 'auki' : 'kiinni'}`);
  }
});

test('KRIITTINEN: TASK_EXTENDED_FIELDS ei sulkeudu missään aallossa', () => {
  // Se on jo tuotannossa auki. Takaisin epätodeksi vaihtaminen
  // lopettaisi kuvauksen, keston ja prioriteetin tallentamisen ilman
  // että kukaan huomaisi — ja juuri aaltocommitti on se hetki, jolloin
  // schema.js:ää muokataan.
  assert.equal(TASK_EXTENDED_FIELDS, true);
  assert.match(read('src/data/schema.js'), /export const TASK_EXTENDED_FIELDS = true/);
});

// =====================================================================
// JULKAISUMANIFESTI
// =====================================================================

test('KRIITTINEN: manifesti on olemassa ja rakenteeltaan kelvollinen', () => {
  const manifesti = readManifest();
  assert.ok(manifesti, `manifestia ei löytynyt: ${MANIFEST_PATH}`);

  const ongelmat = validateManifest(manifesti);
  assert.deepEqual(ongelmat, [], 'manifesti ei vastaa aaltojen määrittelyä');
});

test('KRIITTINEN: manifestin SHA:t todennetaan git-historiasta', () => {
  // Manifesti VÄITTÄÄ, että commit X on aalto A. Todennus avaa
  // commitin X ja lukee sen porttimatriisin ja välimuistiversion.
  // Ilman tätä manifesti olisi pelkkä muistiinpano.
  const manifesti = readManifest();
  assert.ok(manifesti);

  const commitoituja = manifesti.waves.filter(w => w.commitSha).length;

  // validateManifest tekee git-todennuksen. Se ajettiin jo yllä; tässä
  // varmistetaan, että todennus on aidosti päällä eikä ohitettu.
  const väärennetty = JSON.parse(JSON.stringify(manifesti));
  väärennetty.waves[0].commitSha = 'f'.repeat(40);
  const ongelmat = validateManifest(väärennetty);
  assert.ok(ongelmat.length > 0,
    'olematon SHA meni läpi — git-todennus ei ole päällä');

  // Ja jokainen manifestin SHA on 40 merkkiä tai null.
  for (const aalto of manifesti.waves) {
    assert.ok(aalto.commitSha === null || /^[0-9a-f]{40}$/.test(aalto.commitSha),
      `${aalto.id}.commitSha ei ole kelvollinen: ${aalto.commitSha}`);
  }

  assert.ok(commitoituja >= 0);
});

test('KRIITTINEN: manifesti vastaa levyllä sitä mitä generaattori tuottaa', () => {
  // Käsin muokattu manifesti olisi juuri se tiedosto, johon ei voi
  // luottaa. Vertailu tehdään SAMOILLA SHA:illa, jotta commitoimaton
  // aalto ei aiheuta eroa.
  const levyllä = readManifest();
  assert.ok(levyllä);

  // Perustilan SHA on mukana: se on oma vaiheensa eikä aalto, mutta
  // generaattori tarvitsee sen samalla tavalla. Ilman sitä vertailu
  // väittäisi manifestia vääräksi joka kerta kun perustila on
  // commitoitu.
  const shat = Object.assign(
    { BASE: levyllä.baseSha },
    Object.fromEntries(levyllä.waves.map(w => [w.id, w.commitSha])));
  const tuotettu = buildManifest(shat);

  assert.deepEqual(
    JSON.parse(JSON.stringify(levyllä)),
    JSON.parse(JSON.stringify(tuotettu)),
    'manifesti levyllä eroaa generaattorin tuloksesta — aja npm run release:manifest -- --write');
});

test('KRIITTINEN: manifestin riippuvuudet vastaavat migraatioita', () => {
  const manifesti = readManifest();
  assert.deepEqual(manifesti.gateDependencies, gateDependencyMap(),
    'manifestin riippuvuuskartta ei vastaa migraatioista luettua');

  // Jokaisen aallon periytyvä riippuvuus on aiemmassa aallossa.
  for (const aalto of manifesti.waves) {
    const oma = waveById(aalto.id);
    for (const riippuvuus of aalto.dependencies) {
      const lähde = WAVES.find(w => w.gates.includes(riippuvuus));
      assert.ok(lähde, `riippuvuutta ${riippuvuus} ei ole missään aallossa`);
      assert.ok(waveIndex(lähde.id) < waveIndex(oma.id),
        `aalto ${aalto.id} riippuu portista ${riippuvuus}, joka avataan myöhemmin`);
    }
  }
});

// =====================================================================
// AKTIVOINNIN JÄLKEINEN VARMISTUS
// =====================================================================

test('KRIITTINEN: aktivoinnin jälkeinen varmistus on vain lukeva', () => {
  const analyysi = analyzeVerifier(read(POST_ACTIVATION));
  assert.deepEqual(analyysi.writes, [],
    `varmistus sisältää kirjoittavia avainsanoja: ${analyysi.writes.join(', ')}`);
  assert.equal(analyysi.readOnly, true);
});

test('KRIITTINEN: varmistus on yksi lause ja yksi tulostaulukko', () => {
  const lähde = read(POST_ACTIVATION);
  const analyysi = analyzeVerifier(lähde);

  assert.equal(analyysi.semicolons, 1,
    `puolipisteitä on ${analyysi.semicolons}, pitäisi olla tasan yksi`);
  assert.equal(analyysi.semicolonLast, true, 'puolipiste ei ole viimeisenä');
  assert.equal(analyysi.balancedParens, true, 'sulut eivät mene tasan');
  assert.equal(analyysi.unterminatedString, false, 'merkkijono jää sulkematta');

  // Tiedosto lupaa tämän ääneen, joten lupauksen on pidettävä.
  assert.match(lähde, /TASAN YKSI puolipiste/);
});

test('KRIITTINEN: varmistuksen tarkistusnumerot ovat katkeamaton sarja', () => {
  const analyysi = analyzeVerifier(read(POST_ACTIVATION));

  assert.equal(analyysi.contiguous, true,
    `numerointi katkeaa: ${analyysi.checkNumbers.join(', ')}`);
  assert.equal(analyysi.chained, true,
    `union all -ketju ei kata jokaista tarkistusta`
    + ` (${analyysi.unionCount} liitosta, ${analyysi.checkNumbers.length} tarkistusta)`);
  assert.equal(analyysi.checkNumbers.length, 50,
    `tarkistuksia on ${analyysi.checkNumbers.length}, odotettiin 50`);
});

test('KRIITTINEN: varmistus palauttaa vaaditut sarakkeet', () => {
  const löytyneet = outputColumns(read(POST_ACTIVATION));
  assert.deepEqual(löytyneet, [...REQUIRED_COLUMNS],
    'lopputuloksesta puuttuu vaadittuja sarakkeita');
});

test('KRIITTINEN: varmistuksessa on kolme statusta ja INFO ei kaada', () => {
  const koodi = withoutStrings(read(POST_ACTIVATION));
  const lähde = read(POST_ACTIVATION);

  // INFO-rivit eivät saa kasvattaa failures_totalia. Muuten
  // tehtävämäärän muuttuminen — joka on hyväksynnässä TARKOITUS —
  // näyttäisi epäonnistumiselta.
  assert.match(lähde, /when t\.kind = 'info' then 'INFO'/,
    'INFO-statusta ei muodosteta');
  assert.match(lähde, /filter \(where t\.kind = 'gate'/,
    'failures_total ei rajaa INFO-rivejä pois');

  const infoRivejä = (lähde.match(/^\s+'info'$/gm) || []).length;
  assert.equal(infoRivejä, 4, `INFO-rivejä on ${infoRivejä}, odotettiin 4`);

  assert.ok(koodi.length > 0);
});

test('KRIITTINEN: varmistus sallii rivit mutta vaatii omistajuuden', () => {
  // TÄMÄ ON SE ERO edeltäjäänsä. Jos tyhjyysvaatimus jäisi vahingossa
  // paikalleen, varmistus kaatuisi ensimmäisestä oikeasta rutiinista.
  const lähde = read(POST_ACTIVATION);

  assert.equal(/Kaikki kymmenen porttitaulua ovat tyhjia/.test(lähde), false,
    'aktivoinnin jälkeinen varmistus vaatii yhä taulujen olevan tyhjiä');
  assert.equal(/'Muistutusasetusrivia ei ole'/.test(lähde), false,
    'varmistus vaatii yhä, ettei muistutusasetusriviä ole');

  // Mutta omistajuus ja eheys vaaditaan.
  assert.match(lähde, /Omistajattomia riveja ei ole yhdessakaan porttitaulussa/);
  assert.match(lähde, /Jokainen porttitaulun rivi kuuluu tunnetulle omistajalle/);
  assert.match(lähde, /Yhtaan riviae ei ole kiinnitetty toisen kayttajan riviin/);

  // Ja hyväksyntätestin jäännökset ovat yhä kiellettyjä.
  assert.match(lähde, /Hyvaksyntatestin tehtavajaannoksia ei ole/);
  assert.match(lähde, /Ristiinkiinnitysyrityksia ei ole kannassa/);
});

test('KRIITTINEN: vanha post-acceptance-varmistus on yhä ennallaan', () => {
  // Sitä ei korvattu vaan täydennettiin. Peruutustilanteessa — kaikki
  // portit kiinni — se on yhä oikea varmistus, ja tyhjyysvaatimus on
  // silloin oikea vaatimus.
  const vanha = read(POST_ACCEPTANCE);
  assert.match(vanha, /Kaikki kymmenen porttitaulua ovat tyhjia/,
    'vanhasta varmistuksesta katosi tyhjyysvaatimus');

  const analyysi = analyzeVerifier(vanha);
  assert.equal(analyysi.readOnly, true);
  assert.equal(analyysi.checkNumbers.length, 40);
});

test('KRIITTINEN: varmistuksen odotusluvut vastaavat migraatioita', () => {
  // Luvut eivät saa olla arvattuja. Jokainen luetaan migraatioista ja
  // verrataan varmistuksen odotukseen.
  const lähde = read(POST_ACTIVATION);
  const migraatiot = fs.readdirSync(path.join(ROOT, 'supabase/migrations'))
    .filter(n => /^000[3-8]/.test(n))
    .map(n => read(`supabase/migrations/${n}`))
    .join(NEWLINE);

  // 42 nimettyä CHECK-rajoitetta.
  const rajoitteita = (migraatiot.match(/add constraint \w+_check/g) || []).length;
  assert.equal(rajoitteita, 42,
    `migraatioissa on ${rajoitteita} check-rajoitetta`);
  assert.match(lähde, /'Neljakymmentakaksi domain-rajoitetta on tallella', '42'/,
    'varmistuksen rajoitemäärä ei vastaa migraatioita');

  // 9 omistajuusvierasavainta ERÄSSÄ 0003-0008.
  //
  // Rajaus on pakollinen: loppuvarmistus kattaa nimenomaan tämän erän,
  // ja migraatio 0010 tuo kolme lisää. Ilman rajausta tämä testi
  // kertoisi, että ajettu varmistustiedosto on väärässä — vaikka se
  // kuvaa oikein sitä erää jota se varmistaa.
  const eranViitteet = ownershipForeignKeys()
    .filter(v => /^000[3-8]/.test(v.file));
  assert.equal(eranViitteet.length, 9);
  assert.match(lähde, /'Yhdeksan omistajuuden yhdistelmavierasavainta', '9'/);

  // ERÄN ULKOPUOLISET LUETELLAAN NIMELTÄ.
  //
  // Rajaus yllä poistaisi muuten kanarialinnun: uusi omistajuusviite
  // missä tahansa migraatiossa menisi läpi huomaamatta.
  const ulkopuoliset = ownershipForeignKeys()
    .filter(v => !/^000[3-8]/.test(v.file))
    .map(v => `${v.child}->${v.parent}`)
    .sort();
  assert.deepEqual(ulkopuoliset,
    ['goals->life_areas', 'location_rules->tasks', 'milestones->goals',
     'projects->milestones', 'tasks->milestones', 'time_entries->goals',
     'time_entries->life_areas', 'time_entries->tasks', 'travel_plans->tasks'],
    'erän ulkopuolisten omistajuusviitteiden joukko muuttui');

  // 10 porttitaulua.
  const taulut = new Set(
    [...migraatiot.matchAll(/create table public\.(\w+)/g)].map(m => m[1]));
  assert.equal(taulut.size, 10);
  assert.match(lähde, /'Kaikki kymmenen porttitaulua ovat olemassa', '10'/);
});

test('KRIITTINEN: staattinen analyysi havaitsee kirjoituksen ja rikkoutuneen rakenteen', () => {
  // MUTAATIOTESTI. Analysaattori, joka hyväksyy kaiken, on pahempi
  // kuin ei analysaattoria: se antaisi väärän varmuuden.
  const alkuperäinen = read(POST_ACTIVATION);

  // HUOM. Tiedostossa on CRLF-rivinvaihdot. Mutaatiot tehdään siksi
  // säännöllisillä lausekkeilla, jotka eivät oleta rivinvaihdon muotoa
  // — muuten mutaatio ei muuttaisi mitään ja testi menisi läpi
  // todistamatta yhtään mitään.
  const mutaatiot = [
    ['kirjoitus', s => s.replace(/\r?\nwith\r?\n/, '\ndelete from public.tasks; with\n'),
      a => a.readOnly === false],
    ['toinen lause', s => s + '\nselect 1;\n',
      a => a.singleStatement === false],
    ['sulku puuttuu', s => s.replace('portit(taulu) as (', 'portit(taulu) as '),
      a => a.balancedParens === false],
    ['numero hyppää', s => s.replace("select '04', 'B rakenne'", "select '05', 'B rakenne'"),
      a => a.contiguous === false],
    ['union katoaa', s => s.replace(/\r?\n  union all\r?\n/, '\n'),
      a => a.chained === false]
  ];

  for (const [nimi, mutatoi, odotus] of mutaatiot) {
    const mutatoitu = mutatoi(alkuperäinen);
    assert.notEqual(mutatoitu, alkuperäinen, `mutaatio "${nimi}" ei muuttanut mitään`);
    assert.ok(odotus(analyzeVerifier(mutatoitu)),
      `mutaatio "${nimi}" meni analyysistä läpi`);
  }

  // Ja alkuperäinen menee läpi.
  const puhdas = analyzeVerifier(alkuperäinen);
  assert.ok(puhdas.readOnly && puhdas.singleStatement && puhdas.balancedParens
    && puhdas.contiguous && puhdas.chained,
    'alkuperäinen varmistus ei mene omasta analyysistään läpi');
});

// =====================================================================
// TYÖKALUT
// =====================================================================

test('KRIITTINEN: julkaisutyökalut ovat olemassa ja kytketty package.jsoniin', () => {
  const skriptit = JSON.parse(read('package.json')).scripts;

  const odotetut = {
    'activation:preflight': 'scripts/activation-preflight.mjs',
    'activation:verify-wave': 'scripts/verify-wave.mjs',
    'production:verify-assets': 'scripts/production-verify-assets.mjs',
    'release:manifest': 'scripts/release-manifest.mjs'
  };

  for (const [nimi, tiedosto] of Object.entries(odotetut)) {
    assert.ok(skriptit[nimi], `package.jsonista puuttuu skripti ${nimi}`);
    assert.ok(skriptit[nimi].includes(tiedosto),
      `skripti ${nimi} ei aja tiedostoa ${tiedosto}`);
    assert.ok(fs.existsSync(path.join(ROOT, tiedosto)),
      `skriptiä ${tiedosto} ei ole olemassa`);
  }
});

test('KRIITTINEN: tuotannon resurssitodennus on vain lukeva eikä käytä tunnuksia', () => {
  // Tämä skripti ottaa yhteyttä tuotantoon. Sen on oltava
  // kiistattomasti vaaraton: vain GET, ei tunnuksia, ei /api/-kutsuja.
  const koodi = read('scripts/production-verify-assets.mjs');

  assert.match(koodi, /method: 'GET'/, 'pyyntömetodia ei ole kiinnitetty');
  for (const kielletty of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(new RegExp(`method:\\s*'${kielletty}'`).test(koodi), false,
      `skripti käyttää metodia ${kielletty}`);
  }

  for (const kielletty of ['service_role', 'SUPABASE_ANON_KEY', 'Authorization',
                           'apikey', 'password', 'sk-ant-']) {
    assert.equal(koodi.includes(kielletty), false,
      `resurssitodennus viittaa tunnisteeseen ${kielletty}`);
  }

  // Ei /api/-kutsuja: ne maksavat ja koskevat AI-rajapintaan.
  assert.equal(/hae\('\/api\//.test(koodi), false,
    'resurssitodennus kutsuu /api/-polkua');
});

test('KRIITTINEN: yksikään testi ei riipu verkkoyhteydestä', () => {
  // Resurssitodennus on tarkoituksella erillinen komento. Jos jokin
  // testi hakisi verkosta, testipatteristo kaatuisi lentokoneessa eikä
  // kertoisi koodista mitään.
  const testit = fs.readdirSync(path.join(ROOT, 'tests'))
    .filter(n => n.endsWith('.test.mjs') || n.endsWith('.test.cjs'));

  for (const nimi of testit) {
    const koodi = read(`tests/${nimi}`);

    assert.equal(/\bfetch\(\s*['"`]https?:/.test(koodi), false,
      `testi ${nimi} tekee verkkopyynnön`);

    // Skriptin NIMEN mainitseminen ei ole ajamista — tämä tiedosto
    // mainitsee sen tarkoituksella. Etsitään siis suoritusta, ei
    // merkkijonoa.
    assert.equal(
      /(?:execFileSync|execSync|spawnSync|spawn|exec)\([^)]*production-verify-assets/
        .test(koodi), false,
      `testi ${nimi} ajaa tuotannon resurssitodennuksen`);
  }
});

test('KRIITTINEN: esitarkistus tuntee aaltoparametrin', () => {
  const koodi = read('scripts/activation-preflight.mjs');

  assert.match(koodi, /--wave=/, 'esitarkistus ei tue aaltoparametria');
  assert.match(koodi, /ODOTETTU_AALTO = aaltoArgumentti \|\| 'BASE'/,
    'esitarkistuksen oletus ei ole perustila');
  assert.ok(koodi.includes('matrixDifferences'),
    'esitarkistus ei vertaa matriisia aallon odotukseen');
  assert.ok(koodi.includes('cacheVersionOf'),
    'esitarkistus ei tarkista välimuistiversiota');
});

// =====================================================================
// HYVÄKSYNTÄPAKETIT
// =====================================================================
//
// Paketit ovat se, mitä operaattori seuraa deployhetkellä. Väärä
// välimuistiversio tai väärä peruutuskohde niissä on vaarallisempi kuin
// puuttuva paketti: väärää ohjetta noudatetaan, puuttuvaa ei.

test('KRIITTINEN: jokaisella aallolla on hyväksyntäpaketti', () => {
  for (const wave of WAVES) {
    const polku = `docs/acceptance/WAVE-${wave.id}.md`;
    assert.ok(fs.existsSync(path.join(ROOT, polku)),
      `hyväksyntäpaketti puuttuu: ${polku}`);
  }
});

test('KRIITTINEN: paketti kertoo oikeat portit, välimuistin ja peruutuksen', () => {
  for (const wave of WAVES) {
    const paketti = read(`docs/acceptance/WAVE-${wave.id}.md`);

    // Aallon omat portit on nimettävä.
    for (const portti of wave.gates) {
      assert.ok(paketti.includes(portti),
        `WAVE-${wave.id}.md ei mainitse porttia ${portti}`);
    }

    // Ja aallon omat taulut.
    for (const taulu of wave.tables) {
      assert.ok(paketti.includes(taulu),
        `WAVE-${wave.id}.md ei mainitse taulua ${taulu}`);
    }

    // Välimuistiversio täsmälleen oikein. Väärä versio paketissa
    // johtaisi deployhin, jota selain ei koskaan huomaa.
    assert.ok(paketti.includes('`' + wave.cacheVersion + '`'),
      `WAVE-${wave.id}.md ei kerro välimuistiversiota ${wave.cacheVersion}`);

    // Peruutuskohde.
    const kohde = rollbackTargetOf(wave.id);
    const odotettuKohde = kohde === 'BASE' ? 'perustila' : `aalto ${kohde}`;
    assert.ok(paketti.toLowerCase().includes(odotettuKohde.toLowerCase()),
      `WAVE-${wave.id}.md ei kerro peruutuskohdetta "${odotettuKohde}"`);

    // Aaltokohtaiset komennot.
    for (const komento of [
      `activation:verify-wave -- ${wave.id}`,
      `activation:preflight -- --wave=${wave.id}`,
      `production:verify-assets -- --wave=${wave.id}`
    ]) {
      assert.ok(paketti.includes(komento),
        `WAVE-${wave.id}.md ei sisällä komentoa: ${komento}`);
    }

    // Aktivoinnin jälkeinen varmistus, ei aktivointia edeltävä.
    assert.ok(paketti.includes('verify_0003_0008_post_activation.sql'),
      `WAVE-${wave.id}.md ei ohjaa ajamaan aktivoinnin jälkeistä varmistusta`);
    assert.ok(paketti.includes('precheck_0003_0008_auth_final.sql'),
      `WAVE-${wave.id}.md ei ohjaa ajamaan precheckiä`);
  }
});

test('KRIITTINEN: paketti ei ohjaa peruuttamaan kantaa eikä poistamaan rivejä', () => {
  // Portin sulkeminen on peruutus. Rivien poisto ei ole: ne ovat
  // käyttäjän omaa dataa, ja SQL-poisto ohittaisi domainin säännöt.
  for (const wave of WAVES) {
    const paketti = read(`docs/acceptance/WAVE-${wave.id}.md`);

    assert.match(paketti, /git revert/,
      `WAVE-${wave.id}.md ei kerro peruutuskomentoa`);
    assert.equal(/push\s+.*--force(?!-with-lease)/.test(paketti), false,
      `WAVE-${wave.id}.md ohjaa force-pushiin`);
    assert.equal(/delete from|drop table|truncate/i.test(paketti), false,
      `WAVE-${wave.id}.md ohjaa poistamaan rivejä SQL:llä`);
  }
});

test('KRIITTINEN: paketti nostaa välimuistiversion myös peruutuksessa', () => {
  // Jos peruutus palauttaisi vanhan versionumeron, selain joka on jo
  // kerran nähnyt sen numeron voisi jäädä vanhaan kuoreen pysyvästi.
  // Ks. docs/RELEASE-TRAIN-0003-0008.md, "Peruutus ja service worker".
  for (const wave of WAVES) {
    const paketti = read(`docs/acceptance/WAVE-${wave.id}.md`);
    const seuraava = 'v' + (Number(wave.cacheVersion.slice(1)) + 1);

    assert.ok(paketti.includes(`${wave.cacheVersion} -> ${seuraava}`),
      `WAVE-${wave.id}.md ei kerro nostavansa välimuistia peruutuksessa`
      + ` (${wave.cacheVersion} -> ${seuraava})`);
  }
});

test('KRIITTINEN: junan yleisohje on olemassa ja vastaa aaltoja', () => {
  const ohje = read('docs/RELEASE-TRAIN-0003-0008.md');

  for (const wave of WAVES) {
    assert.ok(ohje.includes(`WAVE-${wave.id}.md`),
      `yleisohje ei viittaa pakettiin WAVE-${wave.id}.md`);
    assert.ok(ohje.includes('`' + wave.cacheVersion + '`'),
      `yleisohje ei mainitse välimuistiversiota ${wave.cacheVersion}`);
  }

  assert.ok(ohje.includes(PRODUCTION.sha),
    'yleisohje ei mainitse tuotannon nykyistä SHA:ta');
  assert.ok(ohje.includes('manifestival-prod-v2'), 'tagiehdotus puuttuu');
  assert.match(ohje, /cap sync android/, 'Android-järjestys puuttuu');

  // Vanhaa tagia ei siirretä.
  assert.match(ohje, /manifestival-prod-v1/);
  assert.match(ohje, /ei siirret/i);
});

test('KRIITTINEN: yleisohje viittaa olemassa oleviin tiedostoihin', () => {
  const ohje = read('docs/RELEASE-TRAIN-0003-0008.md');
  const polut = [...ohje.matchAll(/`((?:supabase|docs|src|tests|scripts|tools|android)\/[\w./-]+)`/g)]
    .map(m => m[1]);

  assert.ok(polut.length >= 6, `yleisohjeesta löytyi vain ${polut.length} viittausta`);
  for (const polku of new Set(polut)) {
    assert.ok(fs.existsSync(path.join(ROOT, polku)),
      `yleisohje viittaa tiedostoon jota ei ole: ${polku}`);
  }
});

// =====================================================================
// TURVAEHTO EI SAA ERKAANTUA VARMISTUSTEN VALILLA
// =====================================================================

test('KRIITTINEN: SECURITY DEFINER -ehto on sama kaikissa kolmessa varmistuksessa', () => {
  // KOLME VARMISTUSTA KYSYY SAMASTA FUNKTIOSTA.
  //
  // public.rls_auto_enable() on SECURITY DEFINER, eli se ohittaa RLS:n.
  // Se on tarkalleen se rakenne, jolla koko omistajuussuoja voidaan
  // kiertaa, ja siksi kolme eri varmistusta tarkistaa sen.
  //
  // Jos ne kysyisivat eri kysymyksen, ne voisivat antaa eri vastauksen
  // -- ja operaattori uskoisi sita joka sattuu olemaan vihrea. Pahempi
  // vaihtoehto on hiljainen: uusi varmistus kirjoitetaan muistin
  // varassa, ehto on lahes sama mutta ei aivan, eika kukaan huomaa.
  //
  // TAMA TESTI SYNTYI JUURI SIITA. Aktivoinnin jalkeinen varmistus
  // kirjoitettiin ensin kasin, ja sen runkoehto poikkesi todennetusta:
  // se ei tunnistanut sanaa `revoke` eika dblinkia, ja se vaati
  // vakiovalilyonnit siina missa todennettu kaytti [[:space:]]+.
  // Kumpikin ero olisi nakynyt vasta tuotannossa -- toinen vaarana
  // FAILina, toinen vaarana PASSina.
  const TIEDOSTOT = [
    'supabase/verify/verify_0004_0008_final.sql',
    'supabase/acceptance/verify_0003_0008_post_acceptance_final.sql',
    'supabase/acceptance/verify_0003_0008_post_activation.sql'
  ];

  /** Ehto ilman kommentteja ja ilman valilyontieroja. */
  const ehto = (lahde, nimi) => {
    const koodi = lahde.split(NEWLINE)
      .map(rivi => {
        const i = rivi.indexOf('--');
        return i === -1 ? rivi : rivi.slice(0, i);
      })
      .join(NEWLINE);

    const merkki = 'as ' + nimi;
    const loppu = koodi.indexOf(merkki);
    assert.ok(loppu > -1, `${nimi} puuttuu`);
    const start = koodi.lastIndexOf('coalesce(', loppu);
    assert.ok(start > -1, `${nimi}: coalescea ei loytynyt`);
    return koodi.slice(start, loppu).replace(/\s+/g, ' ').trim();
  };

  const ehdot = TIEDOSTOT.map(tiedosto => ({
    tiedosto,
    identiteetti: ehto(read(tiedosto), 'identiteetti_ok'),
    runko: ehto(read(tiedosto), 'runko_ok')
  }));

  for (const nimi of ['identiteetti', 'runko']) {
    const eka = ehdot[0];
    for (const muu of ehdot.slice(1)) {
      assert.equal(muu[nimi], eka[nimi],
        `${nimi}_ok eroaa:${NEWLINE}  ${eka.tiedosto}:${NEWLINE}    ${eka[nimi]}`
        + `${NEWLINE}  ${muu.tiedosto}:${NEWLINE}    ${muu[nimi]}`);
    }
  }

  // Ja ehto on aidosti olemassa eika tyhja -- muuten kolme tyhjaa
  // merkkijonoa olisivat keskenaan yhtapitavia.
  for (const rivi of ehdot) {
    assert.ok(rivi.runko.length > 120,
      `${rivi.tiedosto}: runkoehto on epailyttavan lyhyt`);
    assert.ok(rivi.identiteetti.length > 120,
      `${rivi.tiedosto}: identiteettiehto on epailyttavan lyhyt`);
  }

  // Ja se sisaltaa ne rakenteet, joiden takia se on olemassa.
  const runko = ehdot[0].runko;
  for (const vaadittu of ['pg_event_trigger_ddl_commands', 'grant|revoke',
                          'dblink', 'pg_read_file', '[[:space:]]+']) {
    assert.ok(runko.includes(vaadittu),
      `runkoehdosta puuttuu ${vaadittu}`);
  }
});
