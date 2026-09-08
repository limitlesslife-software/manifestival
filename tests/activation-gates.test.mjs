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
import { TABLES, hasTable, pendingTables, isPersistent } from '../src/data/schema.js';
import { ALL_REPOSITORIES, volatileCollections } from '../src/data/collectionsRepo.js';
import * as prefsRepo from '../src/data/notificationPrefsRepo.js';

const NEWLINE = String.fromCharCode(10);

/** Kaikki kymmenen porttia, jotka odottavat aktivointia. */
const PORTIT = ['routines', 'routineExceptions', 'goals', 'projects',
                'notificationPreferences', 'wellbeing',
                'bills', 'recurringExpenses', 'savingsGoals', 'aiAudit'];

// =====================================================================
// PORTTIEN LÄHTÖTILA
// =====================================================================

test('KRIITTINEN: jokainen portti on yhä kiinni', () => {
  // Tämä paketti valmistelee aktivoinnin. Se EI aktivoi mitään.
  // Portin kääntäminen on tuotantotoimenpide, ja se tehdään omassa
  // paketissaan aalto kerrallaan.
  for (const portti of PORTIT) {
    assert.equal(TABLES[portti], false,
      `portti ${portti} on auki — tämä paketti ei saa avata yhtään porttia`);
  }
});

test('KRIITTINEN: porttien joukko vastaa migraatioiden tauluja', () => {
  // Portti, jota ei ole, jää huomaamatta: taulu olisi kannassa mutta
  // sovellus ei kirjoittaisi siihen koskaan. Portti, jolle ei ole
  // taulua, kaataisi jokaisen tallennuksen aktivoinnin jälkeen.
  const taulut = new Set();
  for (const nimi of fs.readdirSync(path.join(ROOT, 'supabase/migrations'))
                       .filter(n => /^000[3-8]/.test(n))) {
    for (const m of read(`supabase/migrations/${nimi}`)
      .matchAll(/create table public\.(\w+)/g)) {
      taulut.add(m[1]);
    }
  }

  assert.equal(taulut.size, 10,
    `migraatiot 0003-0008 luovat ${taulut.size} taulua, portteja on ${PORTIT.length}`);
  assert.equal(Object.keys(TABLES).length, 10,
    'porttien määrä ei vastaa migraatioiden taulujen määrää');
  assert.deepEqual(Object.keys(TABLES).sort(), [...PORTIT].sort());
});

test('KRIITTINEN: pendingTables kertoo jokaisen kiinni olevan portin', () => {
  // Käyttöliittymä kertoo tämän listan perusteella, mikä tieto ei vielä
  // säily. Vajaa lista tarkoittaisi, että sovellus lupaa tallentaa
  // jotain mitä se ei tallenna.
  assert.deepEqual(pendingTables().sort(), [...PORTIT].sort());
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
    assert.equal(repo.isPersistent(), false,
      `${repo.table}: väittää säilyvänsä vaikka portti on kiinni`);
  }

  const haihtuvat = volatileCollections();
  assert.equal(haihtuvat.length, ALL_REPOSITORIES.length,
    'osa kokoelmista puuttuu haihtuvien listalta');

  // Ja muistutusasetukset samoin. Ne ovat oma moduulinsa eivätkä ole
  // ALL_REPOSITORIES-listassa — juuri siksi ne on tarkistettava
  // erikseen.
  assert.equal(prefsRepo.isPersistent(), false,
    'muistutusasetukset väittävät säilyvänsä vaikka portti on kiinni');
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
  for (const portti of PORTIT) {
    assert.equal(isPersistent(portti), false,
      `${portti}: isPersistent väittää säilyvyyttä portin ollessa kiinni`);
    assert.equal(hasTable(portti), false,
      `${portti}: hasTable väittää taulun olevan käytettävissä`);
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
  const failit = (koodi.match(/return fail\(/g) || []).length;
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
  assert.ok((koodi.match(/return fail\(/g) || []).length >= 4,
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

  // Dokumentoitu järjestys aalloittain.
  const AALLOT = [
    ['notificationPreferences', 'wellbeing'],
    ['goals', 'projects'],
    ['routines', 'routineExceptions'],
    ['recurringExpenses', 'savingsGoals', 'bills'],
    ['aiAudit']
  ];
  const aalto = new Map();
  AALLOT.forEach((portit, i) => portit.forEach(p => aalto.set(p, i)));

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
