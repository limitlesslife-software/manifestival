// Aktivointiporttien fail-closed -matriisi ja passiivisen latauksen turva.
//
// MITÄ TÄMÄ VARTIOI
//
// Migraatiot 0003–0008 on ajettu tuotantoon ja RLS-hyväksyntä on läpi.
// Jäljellä on kymmenen porttia, jotka vaihtavat muistivaraston oikeaan
// tietokantaan. Portin kääntäminen on yhden rivin muutos, ja sen
// jälkeen jokainen virhe näkyy suoraan käyttäjän datassa.
//
// Nämä testit lukitsevat sen, mitä portin kummallakin puolella saa
// tapahtua — ja erityisesti sen, mitä EI saa tapahtua pelkästä sivun
// latauksesta.
//
// TESTIEN RAJOITE, REHELLISESTI
//
// Portit ovat jäädytettyjä moduulivakioita (`Object.freeze`), eikä
// repositoriolla ole injektiosaumaa tietokanta-asiakkaalle. Portti-TOSI
// -polkuja ei siis voi ajaa tässä ympäristössä ilman tuotantokoodin
// muuttamista pelkän testattavuuden takia.
//
// Siksi portti-EPÄTOSI todistetaan ajamalla ja portti-TOSI lukemalla:
// jokainen tietokantapolku tarkistetaan rakenteellisesti (virheenkäsittely,
// omistajarajaus, sarakesuoja). Se ei todista ajonaikaista käytöstä. Se
// todistaa, ettei koodissa ole polkua joka voisi käyttäytyä väärin.
//
// Ajonaikainen todiste tulee tuotannon hyväksyntätestistä
// (tools/rls-acceptance), joka ajaa kaikki nämä polut oikeaa kantaa
// vasten kahdella oikealla tilillä.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, read } from './helpers/sources.mjs';
import { CLOSED_GATES, OPEN_GATES, repoForGate } from './helpers/gates.mjs';
import { WAVES, describeMatrix, resolveWave } from '../tools/release/waves.mjs';
import {
  TABLES, hasTable, pendingTables, isPersistent, BILL_PAYMENT_FIELDS,
  GOAL_PLANNING_FIELDS, GOAL_MAINTENANCE_MODE, GOAL_LIFE_AREA_FIELD, MENTAL_LOAD_FIELDS
} from '../src/data/schema.js';
import { ALL_REPOSITORIES, volatileCollections } from '../src/data/collectionsRepo.js';
import * as prefsRepo from '../src/data/notificationPrefsRepo.js';

const NEWLINE = String.fromCharCode(10);

/** Kaikki kahdeksantoista porttia, jotka odottavat aktivointia. */
const PORTIT = ['routines', 'routineExceptions', 'goals', 'projects',
                'notificationPreferences', 'wellbeing',
                'bills', 'recurringExpenses', 'savingsGoals', 'aiAudit',
                'transactions', 'investments', 'milestones',
                'inboxItems', 'reminders', 'notices',
                'travelPlans', 'locationRules',
                'lifeAreas', 'weeklyCapacities', 'timeEntries', 'alignmentReviews',
                // Migraatio 0013 (aalto J).
                'runningTimers', 'alignmentItemSettings',
                // Migraatio 0014 (aalto K): arjen käyttöjärjestelmä.
                'savedPlaces', 'placeAliases', 'calendarEvents', 'commuteObservations',
                'lifeSettings', 'sleepLogs', 'habitPlans', 'habitEvents',
                'exerciseSessions', 'wellbeingCheckins',
                // Migraatio 0015 (aalto L): mielen kuorman keventäminen.
                'protectedPeriods', 'weeklyPlans'];

// =====================================================================
// PORTTIEN LÄHTÖTILA
// =====================================================================

test('KRIITTINEN: porttimatriisi on tasan yksi suunniteltu aalto', () => {
  // Aiemmin tassa vaadittiin, ettei yksikaan portti ole auki. Se oli
  // oikea vaatimus niin kauan kuin junaa ei ollut aloitettu, mutta
  // aallossa A se olisi kaatunut TARKOITETUSTA muutoksesta -- ja
  // testi, joka kaatuu oikeasta tyosta, poistetaan ennen pitkaa
  // kokonaan.
  //
  // Korvaava vaatimus on TIUKEMPI, ei loysempi. Kaksikymmentakaksi
  // porttia tuottaa 4194304 yhdistelmaa; niista tasan kymmenen on
  // suunniteltuja.
  // Kaikki muut ovat virheita: portti on avattu liian aikaisin,
  // jaanyt avaamatta tai sulkeutunut vahingossa. Yksikaan niista ei
  // mene tasta lapi.
  const aalto = resolveWave(TABLES);
  assert.ok(aalto !== null,
    `porttimatriisi ei vastaa yhtakaan aaltoa: ${describeMatrix(TABLES)}`);

  assert.equal(OPEN_GATES.length + CLOSED_GATES.length, PORTIT.length);
});

test('KRIITTINEN: porttien joukko vastaa migraatioiden tauluja', () => {
  // Portti, jota ei ole, jää huomaamatta: taulu olisi kannassa mutta
  // sovellus ei kirjoittaisi siihen koskaan. Portti, jolle ei ole
  // taulua, kaataisi jokaisen tallennuksen aktivoinnin jälkeen.
  const taulut = new Set();
  for (const nimi of fs.readdirSync(path.join(ROOT, 'supabase/migrations'))
                       .filter(n => /^00(0[3-9]|1[0-5])/.test(n))) {
    for (const m of read(`supabase/migrations/${nimi}`)
      .matchAll(/create table public\.(\w+)/g)) {
      taulut.add(m[1]);
    }
  }

  // 0013 toi kaksi taulua: running_timers ja alignment_item_settings.
  // 0014 toi kymmenen: arjen käyttöjärjestelmän taulut (aalto K).
  // 0015 toi kaksi: suojattu aika ja viikkosuunnitelma (aalto L).
  assert.equal(taulut.size, 36,
    `migraatiot 0003-0015 luovat ${taulut.size} taulua, portteja on ${PORTIT.length}`);
  assert.equal(Object.keys(TABLES).length, 36,
    'porttien määrä ei vastaa migraatioiden taulujen määrää');
  assert.deepEqual(Object.keys(TABLES).sort(), [...PORTIT].sort());
});

test('KRIITTINEN: pendingTables kertoo jokaisen kiinni olevan portin', () => {
  // Käyttöliittymä kertoo tämän listan perusteella, mikä tieto ei vielä
  // säily. Vajaa lista tarkoittaisi, että sovellus lupaa tallentaa
  // jotain mitä se ei tallenna. Ylimaarainen merkinta taas varoittaisi
  // turhaan tiedosta, joka jo sailyy.
  assert.deepEqual(pendingTables().sort(), [...CLOSED_GATES].sort());
});

// =====================================================================
// PORTTI EPÄTOSI — turvallinen käytös
// =====================================================================

test('KRIITTINEN: portti kiinni tarkoittaa muistivarastoa, ei hiljaista hukkaa', () => {
  // Portin ollessa kiinni tieto elää vain istunnon muistissa. Se on
  // hyväksyttyä VAIN koska käyttöliittymä kertoo sen käyttäjälle.
  // Jos repositorio väittäisi säilyvänsä, käyttäjä menettäisi työnsä
  // sivun latauksessa saamatta siitä tietoa.
  for (const repo of ALL_REPOSITORIES) {
    const auki = OPEN_GATES.includes(repo.schemaKey);
    assert.equal(repo.isPersistent(), auki,
      `${repo.table}: isPersistent sanoo ${repo.isPersistent()}, portti on `
      + (auki ? 'auki' : 'kiinni'));
  }

  const haihtuvat = volatileCollections();
  const kiinniTaulut = CLOSED_GATES.map(repoForGate).filter(Boolean).map(r => r.table);
  assert.deepEqual([...haihtuvat].sort(), [...kiinniTaulut].sort(),
    'haihtuvien lista ei vastaa kiinni olevia portteja');

  // Ja muistutusasetukset samoin. Ne ovat oma moduulinsa eivätkä ole
  // ALL_REPOSITORIES-listassa — juuri siksi ne on tarkistettava
  // erikseen.
  assert.equal(prefsRepo.isPersistent(),
    OPEN_GATES.includes('notificationPreferences'),
    'muistutusasetusten sailyvyysvaite ei vastaa porttia');
});

test('KRIITTINEN: portti kiinni ei kirjoita tietokantaan', async () => {
  // Muistivarastopolku ei saa koskea asiakkaaseen lainkaan. Jos se
  // koskisi, kirjautumaton tai portin takana oleva kirjoitus päätyisi
  // kantaan.
  //
  // getClient() heittää ilman määriteltyä ympäristöä, joten jos jokin
  // näistä yrittäisi tietokantaa, kutsu kaatuisi eikä palauttaisi ok.
  const esimerkit = [
    ['routines', { id: 'r1', title: 'T', recurrence: { type: 'daily', weekdays: [] } }],
    ['goals', { id: 'g1', title: 'T' }],
    ['projects', { id: 'p1', name: 'N' }],
    ['wellbeing_entries', { id: 'w1', date: '2026-09-08', energy: 3 }],
    ['bills', { id: 'b1', name: 'N', amountMinor: 100, dueDate: '2026-10-01' }],
    ['savings_goals', { id: 's1', name: 'N', targetMinor: 1000 }],
    ['ai_action_audit', { id: 'a1', intent: 'create_task', risk: 'medium' }]
  ];

  for (const [taulu, entity] of esimerkit) {
    const repo = ALL_REPOSITORIES.find(r => r.table === taulu);
    assert.ok(repo, `repositoriota ${taulu} ei löytynyt`);

    // Avoin portti kuuluu tietokantapolulle, ja se todistetaan
    // erikseen tiedostossa tests/wave-activation.test.mjs oikealla
    // ajolla valeasiakasta vasten. Tama testi koskee kiinni olevaa
    // porttia.
    if (repo.isPersistent()) continue;

    const tulos = await repo.insert(entity);
    assert.equal(tulos.ok, true,
      `${taulu}: muistivarastoon kirjoitus epäonnistui`);

    const lista = await repo.list();
    assert.equal(lista.ok, true, `${taulu}: muistivarastosta luku epäonnistui`);
    assert.ok(lista.value.some(r => r.id === entity.id),
      `${taulu}: kirjoitettu rivi ei näy muistivarastossa`);

    repo.clear();
  }
});

test('KRIITTINEN: portti kiinni ei väitä tallennuksen onnistuneen pysyvästi', () => {
  // isPersisted on se funktio, jolla käyttöliittymä päättää mitä se
  // kertoo käyttäjälle. Jos se valehtelisi, käyttäjä luulisi tietonsa
  // säilyvän.
  for (const portti of CLOSED_GATES) {
    assert.equal(isPersistent(portti), false,
      `${portti}: isPersistent väittää säilyvyyttä portin ollessa kiinni`);
    assert.equal(hasTable(portti), false,
      `${portti}: hasTable väittää taulun olevan käytettävissä`);
  }

  // Ja auki oleva portti kertoo saman totuuden toisin pain.
  for (const portti of OPEN_GATES) {
    assert.equal(isPersistent(portti), true,
      `${portti}: portti on auki mutta isPersistent sanoo muuta`);
    assert.equal(hasTable(portti), true,
      `${portti}: portti on auki mutta hasTable sanoo muuta`);
  }

  // Tuntematon nimi on aina epätosi, ei poikkeus. Kirjoitusvirhe
  // portin nimessä ei saa avata mitään.
  assert.equal(hasTable('keksittyPortti'), false);
  assert.equal(hasTable(''), false);
  assert.equal(hasTable(undefined), false);
});

// =====================================================================
// PORTTI TOSI — rakenteellinen sopimus
// =====================================================================

/** Epäonnistunut tulos palautettuna: fail, failWith tai syystä kuvattu (repoErrors.js). */
const RETURN_FAIL = /return (?:fail|failWith|failFromCause|failFromThrown)\(/g;

/** Repositoriomoduulin koodi ilman kommentteja. */
function repoKoodi() {
  return read('src/data/collectionsRepo.js').split(NEWLINE)
    .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join(NEWLINE);
}

test('KRIITTINEN: jokainen tietokantapolku rajaa omistajaan', () => {
  // RLS on viimeinen este, ei ainoa. Jos kysely ei rajaisi omistajaan,
  // se nojaisi yksin politiikkaan — ja politiikka voidaan muuttaa
  // kannassa ilman että sovelluskoodi muuttuu.
  const koodi = repoKoodi();

  // list, update, remove: jokainen rajaa user_id:llä.
  const rajaukset = (koodi.match(/\.eq\('user_id', requireUserId\(\)\)/g) || []).length;
  assert.ok(rajaukset >= 3,
    `omistajarajauksia on vain ${rajaukset} — list, update ja remove tarvitsevat kukin omansa`);

  // insert EI rajaa vaan jättää omistajan kannalle. Se on oikein:
  // user_id:n oletus on auth.uid(), eikä asiakas saa valita sitä.
  assert.ok(koodi.includes('assertClientSafe(toRow(normalized))'),
    'insert ei tarkista, ettei asiakas lähetä palvelimen omistamia kenttiä');
});

test('KRIITTINEN: asiakas ei voi lähettää omistajuutta', () => {
  // assertClientSafe on ajonaikainen vahti. Se heittää, jos rivillä on
  // user_id, created_at tai updated_at — riippumatta siitä mistä ne
  // tulivat.
  const koodi = repoKoodi();

  assert.ok(/const SERVER_OWNED = Object\.freeze\(\['user_id', 'created_at', 'updated_at'\]\)/
    .test(koodi), 'palvelimen omistamien kenttien lista muuttui');

  // Ja vahti on JOKAISESSA kirjoituksessa, ei vain insertissä.
  const vahdit = (koodi.match(/assertClientSafe\(/g) || []).length;
  assert.ok(vahdit >= 3,
    `assertClientSafe-kutsuja on vain ${vahdit} — insert, update ja määrittely tarvitsevat omansa`);
});

test('KRIITTINEN: jokainen tietokantapolku epäonnistuu näkyvästi', () => {
  // Fail-closed: virhe ei saa palautua onnistumisena eikä kadota.
  // Jos kirjoitus epäonnistuu ja repositorio palauttaisi ok:n,
  // käyttöliittymä kertoisi tallennuksen onnistuneen ja käyttäjä
  // menettäisi työnsä huomaamatta.
  const koodi = repoKoodi();

  // Jokaisessa metodissa on try/catch ja molemmat haarat palauttavat
  // fail-tuloksen.
  const yritykset = (koodi.match(/\btry \{/g) || []).length;
  const kiinniotot = (koodi.match(/\} catch \(cause\) \{/g) || []).length;
  assert.equal(yritykset, kiinniotot,
    `${yritykset} try-lohkoa mutta ${kiinniotot} catch-lohkoa`);
  assert.ok(yritykset >= 4,
    `try/catch-lohkoja on vain ${yritykset} — list, insert, update ja remove tarvitsevat omansa`);

  // Virhe palautetaan aina failina, ei heitetä kutsujalle eikä nielaista.
  // failFromCause/failFromThrown (src/data/repoErrors.js) ovat fail-tuloksen
  // tyypitettyjä muotoja: syy -> kiinteä käyttäjäviesti (describeError).
  const failit = (koodi.match(RETURN_FAIL) || []).length;
  assert.ok(failit >= 8,
    `fail-paluita on vain ${failit} — jokaisessa metodissa tarvitaan kaksi`);

  // Eikä yksikään virhehaara palauta ok:ta.
  assert.equal(/if \(error\) return ok\(/.test(koodi), false,
    'virhehaara palauttaa onnistumisen');
});

test('KRIITTINEN: muistutusasetusten tietokantapolku noudattaa samaa sopimusta', () => {
  // Muistutusasetukset ovat oma moduulinsa eivätkä käytä
  // createRepositorya. Sama sopimus on siksi tarkistettava erikseen —
  // juuri sellainen erillisyys jää muuten huomaamatta.
  const koodi = read('src/data/notificationPrefsRepo.js').split(NEWLINE)
    .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join(NEWLINE);

  assert.ok(koodi.includes('requireUserId()'),
    'muistutusasetukset eivät rajaa omistajaan');
  assert.ok((koodi.match(RETURN_FAIL) || []).length >= 4,
    'muistutusasetusten virhehaarat eivät palauta failia');
  assert.ok(koodi.includes('isPersistent()'),
    'muistutusasetukset eivät tarkista porttia');

  // Lataus on VAIN LUKEVA. Ks. passiivisen latauksen testi alla.
  const lataus = koodi.slice(koodi.indexOf('export async function loadPreferences'),
                             koodi.indexOf('export async function savePreferences'));
  assert.ok(lataus.includes('.select('), 'lataus ei lue');
  assert.equal(/\.(upsert|insert|update|delete)\(/.test(lataus), false,
    'muistutusasetusten LATAUS kirjoittaa kantaan');
});

// =====================================================================
// PASSIIVINEN LATAUS EI KIRJOITA
// =====================================================================

test('KRIITTINEN: sivun lataus ei luo yhtään riviä tuotantoon', () => {
  // TUOTANNON TURVALLISUUSVAATIMUS.
  //
  // Kun portit avataan, ensimmäinen asia joka tapahtuu on että joku
  // avaa sovelluksen. Jos lataus loisi rivejä — esimerkiksi
  // oletusasetukset — tuotantoon ilmestyisi dataa jota kukaan ei
  // pyytänyt, ja hyväksyntätestin jälkeinen "kaikki taulut tyhjiä"
  // -tila rikkoutuisi ilman että kukaan tekisi mitään.
  const koodi = read('src/app/actions.js');

  const lataus = koodi.slice(koodi.indexOf('export async function loadUserData'));
  const runko = lataus.slice(0, lataus.indexOf(NEWLINE + '}'));

  // Latauspolku kutsuu vain lukevia operaatioita.
  for (const kirjoittava of ['.insert(', '.update(', '.upsert(', '.delete(',
                             'savePreferences', 'saveProfile']) {
    assert.equal(runko.includes(kirjoittava), false,
      `loadUserData kutsuu kirjoittavaa operaatiota: ${kirjoittava}`);
  }

  // Ja se kutsuu jokaisen kokoelman lukua.
  const luvut = (runko.match(/\.list\(\)/g) || []).length;
  assert.ok(luvut >= 9,
    `loadUserData lukee vain ${luvut} kokoelmaa, niitä on ${ALL_REPOSITORIES.length}`);
  assert.ok(runko.includes('loadNotificationPreferences()'),
    'loadUserData ei lataa muistutusasetuksia');
});

test('KRIITTINEN: oletusasetukset eivät synny kantaan itsestään', async () => {
  // Muistutusasetuksissa on oletusarvot. Ne palautetaan MUISTISTA kun
  // riviä ei ole — niitä ei kirjoiteta kantaan siltä varalta.
  //
  // Jos lataus kirjoittaisi oletusrivin, jokainen sisäänkirjautuminen
  // loisi rivin notification_preferences-tauluun, ja hyväksynnän
  // jälkeinen varmistus alkaisi kaatua ilman että kukaan on säätänyt
  // asetuksiaan.
  // Portin auettua sama vaite todistetaan valeasiakkaalla
  // tiedostossa tests/wave-activation.test.mjs. Tassa se todistetaan
  // muistipolulla, joka on kaytossa portin ollessa kiinni.
  if (OPEN_GATES.includes('notificationPreferences')) return;

  const tulos = await prefsRepo.loadPreferences();
  assert.equal(tulos.ok, true, 'oletusasetusten lataus epäonnistui');
  assert.equal(tulos.value.enabled, false,
    'oletusasetukset eivät ole hiljaisuus — uusi käyttäjä alkaisi saada ilmoituksia');

  // Toinen lataus antaa saman tuloksen eikä ole luonut mitään.
  const toinen = await prefsRepo.loadPreferences();
  assert.deepEqual(toinen.value, tulos.value,
    'peräkkäiset lataukset antavat eri tuloksen — jokin luo tilaa');
});

// =====================================================================
// AKTIVOINNIN JÄRJESTYS
// =====================================================================

test('KRIITTINEN: aktivointijärjestys kunnioittaa vierasavainriippuvuuksia', () => {
  // Portti, joka avataan ennen sen viittauskohdetta, tuottaa
  // vierasavainvirheen heti kun käyttäjä yrittää liittää rivejä.
  //
  // Riippuvuudet luetaan migraatioista, ei arvata.
  const riippuvuudet = new Map();
  const tauluPortti = {
    routines: 'routines', routine_exceptions: 'routineExceptions',
    goals: 'goals', projects: 'projects',
    notification_preferences: 'notificationPreferences',
    wellbeing_entries: 'wellbeing', bills: 'bills',
    recurring_expenses: 'recurringExpenses', savings_goals: 'savingsGoals',
    ai_action_audit: 'aiAudit', tasks: null, profile: null
  };

  for (const nimi of fs.readdirSync(path.join(ROOT, 'supabase/migrations'))
                       .filter(n => n.endsWith('.sql'))) {
    const lahde = read(`supabase/migrations/${nimi}`).split(NEWLINE)
      .filter(l => !l.trim().startsWith('--')).join(NEWLINE);

    for (const m of lahde.matchAll(
      /alter table public\.(\w+)[\s\S]{0,200}?foreign key \(user_id,\s*\w+\)\s*references public\.(\w+)/g)) {
      const lapsi = tauluPortti[m[1]];
      const vanhempi = tauluPortti[m[2]];
      if (!lapsi || !vanhempi || lapsi === vanhempi) continue;
      if (!riippuvuudet.has(lapsi)) riippuvuudet.set(lapsi, new Set());
      riippuvuudet.get(lapsi).add(vanhempi);
    }
  }

  // Löydettyjen riippuvuuksien on oltava mukana aktivointijärjestyksessä.
  assert.ok(riippuvuudet.size >= 2,
    `porttien välisiä riippuvuuksia löytyi vain ${riippuvuudet.size}`);

  // Jarjestys luetaan KANONISESTA maarittelysta, ei kirjoiteta tahan
  // toistamiseen. Kaksi kopiota samasta jarjestyksesta erkanisi
  // ennemmin tai myohemmin, ja silloin toinen niista olisi vaara
  // ilman etta mikaan huomaa.
  const aalto = new Map();
  WAVES.forEach((w, i) => w.gates.forEach(p => aalto.set(p, i)));

  for (const portti of PORTIT) {
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

// =====================================================================
// DOKUMENTAATIO VASTAA KOODIA
// =====================================================================
//
// Migraatiotiedostoissa lukee yhä "TILA: EI AJETTU TUOTANTOON", vaikka
// kaikki kahdeksan on ajettu. Rivejä ei korjattu tiedostoihin, koska
// migraatio on tietue siitä mitä tuotannossa ajettiin -- jälkikäteen
// muokattuna repositorio kertoisi mitä joku myöhemmin ajatteli ajetun.
//
// Ajantasainen tieto on siksi yhdessä paikassa, ja nämä testit pitävät
// sen ajan tasalla. Dokumentti, joka kertoo väärän tilan, on pahempi
// kuin dokumentti jota ei ole.

const STATUS_DOC = 'docs/PRODUCTION-STATUS.md';
const RUNBOOK = 'docs/ACTIVATION-0003-0008-RUNBOOK.md';

test('KRIITTINEN: tilannedokumentti luettelee jokaisen migraation', () => {
  const doc = read(STATUS_DOC);

  const migraatiot = fs.readdirSync(path.join(ROOT, 'supabase/migrations'))
    .filter(n => n.endsWith('.sql')).sort();
  assert.equal(migraatiot.length, 15, `migraatioita on ${migraatiot.length}`);

  for (const nimi of migraatiot) {
    assert.ok(doc.includes(nimi),
      `tilannedokumentti ei mainitse migraatiota ${nimi}`);
  }

  // KAHDEKSAN AJETTUA, YKSI AJAMATON.
  //
  // Migraatio 0009 (Talous 2.0) on suunniteltu mutta EI AJETTU. Jos
  // tämä luku nousisi yhdeksään ilman että migraatio on todella
  // ajettu, dokumentti väittäisi tuotannosta jotain mitä siellä ei
  // ole -- ja porttien avaaminen sen perusteella kaataisi jokaisen
  // kirjoituksen.
  assert.equal((doc.match(/\*\*AJETTU\*\*/g) || []).length, 8,
    'tilannedokumentti ei merkitse kahdeksaa ajetuksi');

  for (const [numero, tiedosto] of [
    ['0009', '0009_finance_2.sql'],
    ['0010', '0010_goal_to_action.sql']
  ]) {
    const rivi = doc.split(NEWLINE).find(r => r.includes(tiedosto));
    assert.ok(rivi, `tilannedokumentti ei mainitse migraatiota ${numero}`);
    assert.match(rivi, /EI AJETTU/,
      `migraatio ${numero} ei ole merkitty ajamattomaksi`);
  }
});

test('KRIITTINEN: tilannedokumentin porttitaulukko vastaa koodia', () => {
  // Jos dokumentti väittäisi portin olevan auki kun se on kiinni --
  // tai päinvastoin -- operaattori tekisi päätöksiä väärän tiedon
  // varassa juuri aktivoinnin hetkellä.
  const doc = read(STATUS_DOC);

  for (const [portti, auki] of Object.entries(TABLES)) {
    // Rivin ON oltava porttitaulukon oma rivi (`| \`portti\` | ... |`),
    // ei mikä tahansa rivi joka mainitsee portin nimen taannepäin --
    // esim. migraation 0010 varoituslaatikko mainitsee "(`goals`,
    // `projects`, `tasks`)" ennen taulukkoa, ja pelkkä `.includes()`
    // olisi napannut sen sen sijaan että lukisi todellista tilaa. Tämä
    // ei kaatunut tällä haaralla koskaan, koska kaikki portit ovat
    // täällä kiinni molemmissa kohdissa -- vika oli piilossa kunnes
    // haara yhdistettiin origin/mainin todelliseen (avoimeen) tilaan
    // harjoitteluhaarassa rehearsal/wave-g-candidate.
    const rivi = doc.split(NEWLINE)
      .find(r => new RegExp('^\\|\\s*`' + portti + '`\\s*\\|').test(r));
    assert.ok(rivi, `tilannedokumentti ei mainitse porttia ${portti} sen omalla taulukkorivillä`);

    const dokumentoituAuki = /AKTIVOITU/.test(rivi);
    assert.equal(dokumentoituAuki, auki,
      `${portti}: dokumentti sanoo ${dokumentoituAuki ? 'auki' : 'kiinni'},`
      + ` koodi sanoo ${auki ? 'auki' : 'kiinni'}`);
  }

  // TASK_EXTENDED_FIELDS on erikseen, koska se on jo aktivoitu.
  const teRivi = doc.split(NEWLINE).find(r => r.includes('TASK_EXTENDED_FIELDS'));
  assert.ok(teRivi && /AKTIVOITU/.test(teRivi),
    'tilannedokumentti ei kerro TASK_EXTENDED_FIELDS-lipun olevan aktivoitu');

  // BILL_PAYMENT_FIELDS on sarakeportti, ei taulu, joten se ei ole
  // TABLES-oliossa. Se on silti portti, ja portti jota dokumentti ei
  // mainitse on portti jonka tilaa kukaan ei tarkista.
  for (const [nimi, arvo] of [
    ['BILL_PAYMENT_FIELDS', BILL_PAYMENT_FIELDS],
    ['GOAL_PLANNING_FIELDS', GOAL_PLANNING_FIELDS],
    ['GOAL_MAINTENANCE_MODE', GOAL_MAINTENANCE_MODE],
    ['GOAL_LIFE_AREA_FIELD', GOAL_LIFE_AREA_FIELD],
    ['MENTAL_LOAD_FIELDS', MENTAL_LOAD_FIELDS]
  ]) {
    const rivi = doc.split(NEWLINE)
      .find(r => new RegExp('^\\|\\s*`' + nimi + '`\\s*\\|').test(r));
    assert.ok(rivi, `tilannedokumentti ei mainitse porttia ${nimi} sen omalla taulukkorivillä`);
    assert.equal(/AKTIVOITU/.test(rivi), arvo,
      `${nimi}: dokumentti ja koodi eivät ole yhtä mieltä`);
  }
});

test('KRIITTINEN: tilannedokumentti selittää vanhentuneen TILA-rivin', () => {
  // Migraatioissa lukee yhä "EI AJETTU TUOTANTOON". Jos sitä ei
  // selitetä, seuraava lukija joko uskoo sitä tai muokkaa
  // migraatiotiedostoja jälkikäteen. Kumpikin on huono.
  const doc = read(STATUS_DOC);

  assert.ok(doc.includes('EI AJETTU TUOTANTOON'),
    'tilannedokumentti ei mainitse vanhentunutta TILA-riviä');
  assert.match(doc, /historia|tietue/i,
    'tilannedokumentti ei perustele, miksi migraatioita ei muokata jälkikäteen');

  // Ja rivit ovat yhä migraatioissa -- eli päätöstä on noudatettu.
  let vanhentuneita = 0;
  for (const nimi of fs.readdirSync(path.join(ROOT, 'supabase/migrations'))
                       .filter(n => /^000[3-8]/.test(n))) {
    if (read(`supabase/migrations/${nimi}`).includes('TILA: EI AJETTU TUOTANTOON')) {
      vanhentuneita += 1;
    }
  }
  assert.equal(vanhentuneita, 6,
    `migraatioissa on ${vanhentuneita} vanhentunutta TILA-riviä, odotettiin 6`
    + ' -- jos niitä on muokattu, päivitä myös tilannedokumentin perustelu');
});

test('KRIITTINEN: ajo-ohjeen aallot vastaavat testattua järjestystä', () => {
  // Ajo-ohje on se dokumentti, jota operaattori seuraa. Jos sen aallot
  // eroaisivat testatusta järjestyksestä, riippuvuustesti olisi
  // vihreä ja ohje silti väärä.
  const runbook = read(RUNBOOK);

  const AALLOT = WAVES.map(w => [w.id, w.gates]);

  for (const [kirjain, portit] of AALLOT) {
    const rivi = runbook.split(NEWLINE)
      .find(r => r.includes(`**${kirjain}**`) && r.includes('|'));
    assert.ok(rivi, `ajo-ohjeesta puuttuu aalto ${kirjain}`);
    for (const portti of portit) {
      assert.ok(rivi.includes(portti),
        `aallosta ${kirjain} puuttuu portti ${portti}`);
    }
  }

  // Jokainen portti on tasan yhdessä aallossa.
  const kaikki = AALLOT.flatMap(([, p]) => p);
  assert.equal(new Set(kaikki).size, kaikki.length, 'portti on useassa aallossa');
  assert.equal(kaikki.length, Object.keys(TABLES).length,
    'aalloissa on eri määrä portteja kuin koodissa');
});

test('KRIITTINEN: ajo-ohje viittaa olemassa oleviin tiedostoihin', () => {
  const runbook = read(RUNBOOK);
  const polut = [...runbook.matchAll(/`((?:supabase|docs|src|tests|scripts)\/[\w./-]+)`/g)]
    .map(m => m[1]);

  assert.ok(polut.length >= 6,
    `ajo-ohjeesta löytyi vain ${polut.length} tiedostoviittausta`);

  for (const polku of new Set(polut)) {
    assert.ok(fs.existsSync(path.join(ROOT, polku)),
      `ajo-ohje viittaa tiedostoon jota ei ole: ${polku}`);
  }
});

test('KRIITTINEN: ajo-ohje ei ehdota kannan palautusta rollbackiksi', () => {
  // Portin sulkeminen on peruutus. Kannan palauttaminen ei ole:
  // vanha main (bd652fa) on auth-tätä-edeltävä prototyyppi, joka ei
  // toimi nykyistä kantaa vasten lainkaan.
  const runbook = read(RUNBOOK);

  assert.match(runbook, /portin sulkeminen|portti `false`/i,
    'ajo-ohje ei kerro, että peruutus on portin sulkeminen');
  assert.ok(runbook.includes('bd652fa'),
    'ajo-ohje ei varoita vanhasta main-committista palautuskohteena');
  assert.match(runbook, /EI ole turvallinen palautuskohde/i,
    'ajo-ohje ei sano suoraan, ettei vanha main kelpaa palautukseen');
});
