// Migraatioiden ja domain-mallin yhdenmukaisuus.
//
// Migraatioita ei ole ajettu mihinkään ympäristöön, joten niitä ei voi
// testata ajamalla. Sen sijaan tarkistetaan se, mikä oikeasti menee rikki
// hiljaisesti: kannan CHECK-rajoitteet ja domainin sallitut arvot erkanevat
// toisistaan.
//
// Konkreettinen vaara: joku lisää domainiin uuden toistotyypin tai
// tavoitteen tilan, mutta unohtaa migraation. Koodi toimii paikallisesti
// (muistivarasto ei rajoita mitään) ja kaatuu vasta production-kannassa
// rajoiterikkomukseen — pahimmillaan kuukausia myöhemmin.
//
// Nämä testit eivät ota yhteyttä mihinkään tietokantaan. Ne lukevat
// SQL-tiedostot tekstinä.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, read, browserModules } from './helpers/sources.mjs';

import { RECURRENCE, ROUTINE_SCHEDULING, EXCEPTION } from '../src/domain/routine.js';
import { GOAL_STATUS, PROGRESS_MODE } from '../src/domain/goal.js';
import { PROJECT_STATUS } from '../src/domain/project.js';
import { PRIORITIES } from '../src/domain/priority.js';
import { SCALE_MIN, SCALE_MAX } from '../src/domain/wellbeing.js';
import { DEFAULT_PREFERENCES } from '../src/domain/notification.js';
import { TABLES } from '../src/data/schema.js';
import { BILL_STATUS, CADENCE } from '../src/domain/finance.js';
import { AUDIT_RESULTS, MAX_INPUT_SUMMARY } from '../src/domain/audit.js';
import { RISK_LEVELS } from '../src/ai/intentSchema.js';

const MIGRATION_DIR = 'supabase/migrations';

/** Kaikki migraatiotiedostot numerojärjestyksessä. */
function migrationFiles() {
  return fs.readdirSync(path.join(ROOT, MIGRATION_DIR))
    .filter(name => name.endsWith('.sql'))
    .sort();
}

/** Migraation sisältö pienaakkosin — SQL ei ole kirjainkokoherkkää. */
function sql(name) {
  return read(`${MIGRATION_DIR}/${name}`).toLowerCase();
}

/**
 * Yhden CHECK-rajoitteen sallitut arvot.
 *
 * Etsii `add constraint <nimi> check (<sarake> in ('a', 'b'))` -muodon ja
 * palauttaa listan arvoja.
 */
function allowedValues(source, constraintName) {
  const pattern = new RegExp(
    `add constraint ${constraintName}\\s+check \\(\\s*\\w+ in \\(([^)]*)\\)`, 'i');
  const match = pattern.exec(source);
  assert.ok(match, `rajoitetta ${constraintName} ei löytynyt`);
  return [...match[1].matchAll(/'([^']*)'/g)].map(m => m[1]).sort();
}

const PRIORITY_KEYS = PRIORITIES.map(p => p.key).sort();

// ------------------------------------------------------ perusmuotoilu

test('jokainen migraatio on merkitty ajamattomaksi luonnokseksi', () => {
  for (const name of migrationFiles()) {
    const source = read(`${MIGRATION_DIR}/${name}`);
    assert.match(source, /TILA: LUONNOS\. TÄTÄ EI OLE AJETTU MIHINKÄÄN YMPÄRISTÖÖN\./,
      `${name}: tilamerkintä puuttuu`);
  }
});

test('jokainen migraatio ajetaan yhtenä transaktiona', () => {
  for (const name of migrationFiles()) {
    const source = sql(name);
    assert.equal((source.match(/^begin;$/gm) || []).length, 1,
      `${name}: begin puuttuu tai niitä on useita`);
    assert.equal((source.match(/^commit;$/gm) || []).length, 1,
      `${name}: commit puuttuu tai niitä on useita`);
    assert.ok(source.indexOf('\nbegin;') < source.indexOf('\ncommit;'),
      `${name}: commit ennen beginia`);
  }
});

test('jokaisessa migraatiossa on rollback-ohje', () => {
  for (const name of migrationFiles()) {
    assert.match(read(`${MIGRATION_DIR}/${name}`), /ROLLBACK/,
      `${name}: rollback-osio puuttuu`);
  }
});

test('migraatiot 0002-0006 tarkistavat että 0001 on ajettu', () => {
  for (const name of migrationFiles()) {
    if (name.startsWith('0001')) continue;
    assert.match(sql(name), /raise exception 'migraatio 0001 pitaa ajaa ensin/,
      `${name}: esiehtotarkistus puuttuu`);
  }
});

// ------------------------------------------------------------ turvamalli

test('yksikään migraatio ei luo politiikkaa anon-roolille', () => {
  for (const name of migrationFiles()) {
    const source = sql(name);
    assert.equal(/create policy[\s\S]*?\bto anon\b/.test(source), false,
      `${name}: anon-roolille luodaan politiikka`);
    assert.equal(/create policy[\s\S]*?\bto public\b/.test(source), false,
      `${name}: public-roolille luodaan politiikka`);
  }
});

test('jokainen uusi taulu saa RLS:n ja neljä politiikkaa', () => {
  // Taulu, joka luodaan mutta jää ilman RLS:ää, olisi kaikkien luettavissa.
  for (const name of migrationFiles()) {
    const source = sql(name);
    const created = [...source.matchAll(/create table if not exists public\.(\w+)/g)]
      .map(match => match[1]);

    for (const table of created) {
      assert.match(source,
        new RegExp(`alter table public\\.${table}\\s+enable row level security`),
        `${name}: taulu ${table} ilman RLS:ää`);

      for (const action of ['select', 'insert', 'update', 'delete']) {
        assert.match(source, new RegExp(`create policy ${table}_${action}_own`),
          `${name}: taululta ${table} puuttuu ${action}-politiikka`);
      }

      assert.match(source, new RegExp(`revoke all on public\\.${table}\\s+from anon`),
        `${name}: taululta ${table} ei revokoida anon-oikeuksia`);
    }
  }
});

test('uusien taulujen omistajuuden asettaa tietokanta', () => {
  // Jos client saisi valita user_id:n, RLS ei suojaisi mitään.
  for (const name of migrationFiles()) {
    const source = sql(name);
    for (const match of source.matchAll(/create table if not exists public\.(\w+) \(([\s\S]*?)\n\);/g)) {
      const [, table, body] = match;
      const ownerColumn = /user_id\s+uuid not null default auth\.uid\(\)/.test(body)
        || /id\s+uuid primary key default auth\.uid\(\)/.test(body);
      assert.ok(ownerColumn,
        `${name}: taulussa ${table} ei ole omistajasaraketta oletuksella auth.uid()`);
    }
  }
});

test('uudet taulut viittaavat auth.users-tauluun poistoketjulla', () => {
  // Käyttäjän poisto ei saa jättää orpoja rivejä henkilökohtaista dataa.
  for (const name of migrationFiles()) {
    const source = sql(name);
    for (const match of source.matchAll(/create table if not exists public\.(\w+) \(([\s\S]*?)\n\);/g)) {
      const [, table, body] = match;
      assert.match(body, /references auth\.users\(id\) on delete cascade/,
        `${name}: taulusta ${table} puuttuu auth.users-viite`);
    }
  }
});

// ------------------------------------- domainin arvot vastaavat rajoitteita

test('rutiinin toistotyypit vastaavat migraatiota 0003', () => {
  const source = sql('0003_routines.sql');
  assert.deepEqual(
    allowedValues(source, 'routines_recurrence_type_check'),
    Object.values(RECURRENCE).sort());
});

test('rutiinin aikataulutustavat vastaavat migraatiota 0003', () => {
  const source = sql('0003_routines.sql');
  assert.deepEqual(
    allowedValues(source, 'routines_scheduling_check'),
    Object.values(ROUTINE_SCHEDULING).sort());
});

test('poikkeustyypit vastaavat migraatiota 0003', () => {
  const source = sql('0003_routines.sql');
  assert.deepEqual(
    allowedValues(source, 'routine_exceptions_type_check'),
    Object.values(EXCEPTION).sort());
});

test('tavoitteen tilat vastaavat migraatiota 0004', () => {
  const source = sql('0004_goals_projects.sql');
  assert.deepEqual(
    allowedValues(source, 'goals_status_check'),
    Object.values(GOAL_STATUS).sort());
});

test('tavoitteen edistymistavat vastaavat migraatiota 0004', () => {
  const source = sql('0004_goals_projects.sql');
  assert.deepEqual(
    allowedValues(source, 'goals_progress_mode_check'),
    Object.values(PROGRESS_MODE).sort());
});

test('projektin tilat vastaavat migraatiota 0004', () => {
  const source = sql('0004_goals_projects.sql');
  assert.deepEqual(
    allowedValues(source, 'projects_status_check'),
    Object.values(PROJECT_STATUS).sort());
});

test('prioriteetit ovat samat kaikissa migraatioissa', () => {
  assert.deepEqual(
    allowedValues(sql('0003_routines.sql'), 'routines_priority_check'),
    PRIORITY_KEYS);
  assert.deepEqual(
    allowedValues(sql('0004_goals_projects.sql'), 'goals_priority_check'),
    PRIORITY_KEYS);
  assert.deepEqual(
    allowedValues(sql('0002_task_domain_fields.sql'), 'tasks_priority_check'),
    PRIORITY_KEYS);
});

test('hyvinvoinnin asteikko vastaa migraatiota 0006', () => {
  const source = sql('0006_wellbeing.sql');
  for (const metric of ['energy', 'mood', 'stress']) {
    assert.match(source,
      new RegExp(`${metric}\\s+is null or ${metric}\\s+between ${SCALE_MIN} and ${SCALE_MAX}`),
      `${metric}: asteikko ei vastaa domainia`);
  }
});

test('muistutusten oletusarvot vastaavat migraatiota 0005', () => {
  const source = sql('0005_notification_preferences.sql');

  // Tärkein yksittäinen oletus: mitään ei lähetetä ilman lupaa.
  assert.equal(DEFAULT_PREFERENCES.enabled, false);
  assert.match(source, /enabled\s+boolean not null default false/);

  const pairs = [
    ['task_lead_minutes', DEFAULT_PREFERENCES.taskLeadMinutes],
    ['routine_lead_minutes', DEFAULT_PREFERENCES.routineLeadMinutes],
    ['max_per_day', DEFAULT_PREFERENCES.maxPerDay]
  ];
  for (const [column, value] of pairs) {
    assert.match(source, new RegExp(`${column}\\s+integer not null default ${value}\\b`),
      `${column}: oletus ei vastaa domainia`);
  }

  const times = [
    ['daily_plan_time', DEFAULT_PREFERENCES.dailyPlanTime],
    ['evening_review_time', DEFAULT_PREFERENCES.eveningReviewTime],
    ['quiet_hours_from', DEFAULT_PREFERENCES.quietHours.from],
    ['quiet_hours_to', DEFAULT_PREFERENCES.quietHours.to]
  ];
  for (const [column, value] of times) {
    assert.match(source, new RegExp(`${column}\\s+text\\s+not null default '${value}'`),
      `${column}: oletus ei vastaa domainia`);
  }
});

// ------------------------------------------ sarakenimet vastaavat repoja

test('collectionsRepo kirjoittaa vain sarakkeisiin jotka migraatio luo', () => {
  // Yksi kirjoitusvirhe sarakenimessä riittää rikkomaan tallennuksen
  // production-kannassa. Muistivarasto ei paljastaisi sitä koskaan.
  const repo = read('src/data/collectionsRepo.js');

  const tableToMigration = {
    routines: '0003_routines.sql',
    routine_exceptions: '0003_routines.sql',
    goals: '0004_goals_projects.sql',
    projects: '0004_goals_projects.sql',
    wellbeing_entries: '0006_wellbeing.sql'
  };

  for (const [table, migration] of Object.entries(tableToMigration)) {
    const createMatch = new RegExp(
      `create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`)
      .exec(sql(migration));
    assert.ok(createMatch, `${table}: create table ei löytynyt`);

    const columns = new Set(
      createMatch[1].split('\n')
        .map(line => /^\s{2}(\w+)\s+\S/.exec(line))
        .filter(Boolean)
        .map(match => match[1]));

    // toRow-lohko juuri tälle taululle.
    const repoBlock = new RegExp(
      `table: '${table}',([\\s\\S]*?)\\n\\}\\);`).exec(repo);
    assert.ok(repoBlock, `${table}: repositoriota ei löytynyt`);

    const toRow = /toRow: [^{]*\{([\s\S]*?)\n {2}\}\)/.exec(repoBlock[1]);
    assert.ok(toRow, `${table}: toRow-muunnosta ei löytynyt`);

    // Varmistus siitä, että jäsennys todella löysi jotain. Ilman tätä
    // testi menisi läpi myös silloin kun regexit lakkaavat osumasta.
    assert.ok(columns.size >= 6, `${table}: sarakkeita löytyi vain ${columns.size}`);

    const written = [...toRow[1].matchAll(/^\s{4}(\w+):/gm)].map(match => match[1]);
    assert.ok(written.length >= 5,
      `${table}: toRow-kenttiä löytyi vain ${written.length}`);

    for (const column of written) {
      assert.ok(columns.has(column),
        `${table}: toRow kirjoittaa sarakkeeseen ${column}, jota migraatio ei luo`);
    }
  }
});

// ------------------------------------------------ liput ovat yhä pois päältä

test('yksikään taululippu ei ole päällä ennen migraation ajoa', () => {
  // Tämä testi on tarkoituksellisesti hauras: se KAATUU, kun lippu
  // käännetään. Silloin on pakko todeta ääneen, että migraatio on oikeasti
  // ajettu tuotannossa — eikä lippua ole käännetty vahingossa.
  for (const [name, enabled] of Object.entries(TABLES)) {
    assert.equal(enabled, false,
      `TABLES.${name} on true. Onko migraatio todella ajettu tuotannossa?`
      + ' Jos on, päivitä tämä testi samassa committissa.');
  }
});

// ------------------------------------ WP13-WP20: raha ja kirjausketju

test('KRIITTINEN: rahasarakkeet ovat kokonaislukuja eivätkä liukulukuja', () => {
  // numeric olisi tarkka kannassa, mutta se palautuu JavaScriptiin
  // merkkijonona tai liukulukuna ajurin mukaan — ja juuri se muunnos on
  // se kohta, jossa sentit katoavat.
  const source = sql('0007_finance.sql');

  for (const column of ['amount_minor', 'target_minor', 'current_minor']) {
    const pattern = new RegExp(column + '\\s+(\\w+)');
    const match = pattern.exec(source);
    assert.ok(match, `saraketta ${column} ei löytynyt`);
    assert.equal(match[1], 'bigint',
      `${column} on tyyppiä ${match[1]} — pitää olla bigint`);
  }

  // Kommentit pois ennen tarkistusta: migraatio SELITTÄÄ miksi numericia
  // ei käytetä, ja selitys osuisi muuten omaan kieltoonsa.
  const code = source.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');

  for (const forbidden of ['numeric', 'decimal', 'real', 'double precision', 'float']) {
    assert.equal(code.includes(forbidden), false,
      `0007 käyttää liukulukutyyppiä: ${forbidden}`);
  }
});

test('rahasarakkeilla on valuutta ja se on validoitu', () => {
  const source = sql('0007_finance.sql');
  for (const table of ['bills', 'recurring_expenses', 'savings_goals']) {
    assert.match(source,
      new RegExp('create table if not exists public\\.' + table + '[\\s\\S]*?currency'),
      `${table}: valuutta puuttuu`);
  }
  assert.equal((source.match(/currency ~ '\^\[a-z\]\{3\}\$'/g) || []).length, 3,
    'jokaisella taululla pitää olla valuuttamuodon tarkistus');
});

test('laskun tilat vastaavat domainia', () => {
  assert.deepEqual(
    allowedValues(sql('0007_finance.sql'), 'bills_status_check'),
    Object.values(BILL_STATUS).sort());
});

test('toistuvan kulun jaksot vastaavat domainia', () => {
  assert.deepEqual(
    allowedValues(sql('0007_finance.sql'), 'recurring_expenses_cadence_check'),
    Object.values(CADENCE).sort());
});

test('maksettu lasku vaatii maksupäivän myös kannassa', () => {
  const source = sql('0007_finance.sql');
  assert.match(source, /status <> 'paid' or paid_date is not null/,
    'puolivalmis kirjaus pääsisi kantaan');
});

test('toistuvan kulun kuukauden päivä on rajattu kannassa', () => {
  const source = sql('0007_finance.sql');
  assert.match(source, /day_of_month >= 1 and day_of_month <= 31/);
});

test('kirjausketjun lopputulokset vastaavat domainia', () => {
  assert.deepEqual(
    allowedValues(sql('0008_ai_audit.sql'), 'ai_action_audit_result_check'),
    [...AUDIT_RESULTS].sort());
});

test('kirjausketjun riskitasot vastaavat AI-mallia', () => {
  assert.deepEqual(
    allowedValues(sql('0008_ai_audit.sql'), 'ai_action_audit_risk_check'),
    [...RISK_LEVELS].sort());
});

test('KRIITTINEN: kanta ei hyväksy suoritettua komentoa ilman vahvistusta', () => {
  // Sellainen rivi olisi merkki turvamallin rikkoutumisesta. Kirjaus ei
  // saa väittää sitä tapahtuneen edes silloin kun sovelluksessa on vika.
  const source = sql('0008_ai_audit.sql');
  assert.match(source, /executed = false or confirmed = true/,
    'invariantti puuttuu kannasta');
});

test('kirjausketju rajoittaa tiivistelmän pituuden kannassa asti', () => {
  // Sovellusvirhe ei saa johtaa siihen, että koko päiväkirjamerkintä
  // päätyy tietokantaan.
  const source = sql('0008_ai_audit.sql');
  assert.match(source, /length\(input_summary\) <= \d+/);
  assert.ok(MAX_INPUT_SUMMARY <= 200,
    'domainin raja on löysempi kuin kannan — kanta hylkäisi kelvollisen rivin');
});

test('kirjausketjun kohde ei ole vierasavain', () => {
  // Kohde on voitu poistaa, ja kirjaus siitä on nimenomaan se, mitä
  // halutaan säilyttää. Vierasavain poistaisi historian kohteen mukana.
  const source = sql('0008_ai_audit.sql');
  const createBlock = /create table if not exists public\.ai_action_audit \(([\s\S]*?)\n\);/
    .exec(source);
  assert.ok(createBlock);
  assert.equal(/target_id\s+text references/.test(createBlock[1]), false,
    'target_id on vierasavain — historia katoaisi kohteen mukana');
});

// ------------------------------------------ FREEZE: varmistuskyselyt

test('varmistuskyselyt ovat vain lukevia', () => {
  // Nämä tiedostot on tarkoitettu ajettaviksi tuotantokantaa vasten
  // käsin. Yksikään ei saa koskaan muuttaa mitään. Jos joku joskus
  // lisää tänne korjaavan lauseen, tämä testi kaatuu ensin.
  const dir = path.join(ROOT, 'supabase/verify');
  const files = fs.readdirSync(dir).filter(name => name.endsWith('.sql'));

  assert.equal(files.length, 8, 'yksi varmistustiedosto migraatiota kohti');

  // Tarkistus tehdään LAUSEEN ALKUSANASTA, ei sisältyvyydestä. Kielletty
  // sana esiintyy laillisesti tunnisteiden sisällä: role_table_grants
  // sisältää sanan "grant" ja odotettu "on delete set null" sanan "delete".
  // Sisältyvyystarkistus antaisi vääriä hälytyksiä lisäämättä kattavuutta:
  // muuttava lause voi olla vain lauseen alussa.
  for (const name of files) {
    // Kommentit pois: selitysteksti saa puhua migraatioista vapaasti.
    const sql = fs.readFileSync(path.join(dir, name), 'utf8')
      .split('\n')
      .filter(line => !line.trim().startsWith('--'))
      .join('\n');

    const statements = sql.split(';')
      .map(part => part.trim())
      .filter(part => part.length > 0);

    assert.ok(statements.length > 0, `${name} on tyhjä`);

    for (const statement of statements) {
      const first = statement.split(/\s+/)[0].toLowerCase();
      assert.equal(first, 'select',
        `${name}: lause alkaa sanalla "${first}" — vain select on sallittu`);
    }
  }
});

test('jokaiselle migraatiolle on varmistuskysely', () => {
  const verify = fs.readdirSync(path.join(ROOT, 'supabase/verify'))
    .filter(name => name.endsWith('.sql'));

  for (const migration of migrationFiles()) {
    const number = migration.slice(0, 4);
    assert.ok(verify.includes(`verify_${number}.sql`),
      `migraatiolta ${number} puuttuu varmistuskysely`);
  }
});

test('varmistuskyselyt eivät lue käyttäjän sisältöä', () => {
  // Varmistus katsoo rakennetta ja rivimääriä. Se ei saa tulostaa
  // tehtävien otsikoita, hyvinvointimerkintöjä eikä rahasummia — eikä
  // koskaan avaimia.
  const dir = path.join(ROOT, 'supabase/verify');

  for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(dir, name), 'utf8')
      .split('\n')
      .filter(line => !line.trim().startsWith('--'))
      .join('\n')
      .toLowerCase();

    assert.equal(/select\s+\*/.test(sql), false,
      `${name}: select * voi paljastaa käyttäjän sisältöä`);

    for (const column of ['title', 'note', 'anon_key', 'service_role', 'password']) {
      assert.equal(sql.includes(column), false,
        `${name} lukee saraketta ${column}`);
    }
  }
});

// -------------------------------- FREEZE: dokumentaation totuudellisuus

test('portin takainen ominaisuusdokumentti kertoo, ettei tieto vielä säily', () => {
  // Dokumentti, joka kuvaa ominaisuuden toimivaksi mainitsematta ettei se
  // säily, on väärässä tavalla joka huomataan vasta kun käyttäjä menettää
  // työnsä. Jokaisen portin takaisen ominaisuuden dokumentin pitää sanoa
  // se ääneen.
  const gated = [
    ['docs/ROUTINES.md', ['routines', 'routineExceptions']],
    ['docs/GOALS.md', ['goals', 'projects']],
    ['docs/NOTIFICATIONS.md', ['notificationPreferences']]
  ];

  for (const [file, gates] of gated) {
    const stillGated = gates.some(name => TABLES[name] !== true);
    if (!stillGated) continue;

    const doc = read(file);
    assert.ok(/eiv?[aä]?t? viel[aä] s[aä]ily|eiv?[aä]?t? s[aä]ily|ei tallennu|vain istunnon/i.test(doc),
      `${file} kuvaa portin takaista ominaisuutta kertomatta, ettei tieto vielä säily`);
  }
});

test('dokumentaatio ei viittaa poistettuihin moduuleihin', () => {
  // Rakennekuvaus, joka listaa tiedostoja joita ei ole, opettaa lukijaa
  // olemaan luottamatta siihen.
  const structureDoc = read('docs/MODULARIZATION.md');

  for (const match of structureDoc.matchAll(/^\s{2,}([a-zA-Z][\w-]*\.js)\s{2,}/gm)) {
    const name = match[1];
    const found = browserModules().some(file => file.endsWith('/' + name));
    assert.ok(found, `MODULARIZATION.md listaa moduulin jota ei ole: ${name}`);
  }
});

// ================================================================
// 0001 on sovitettu TODELLISEEN tuotantoskeemaan
// ================================================================
//
// Nämä testit eivät tarkista SQL:n syntaksia — sitä ei voi tarkistaa
// ilman kantaa. Ne vartioivat niitä KOHTIA, joissa yleisluonteinen
// migraatio meni tuotantoa vasten rikki, ja joissa tulevaisuuden
// muokkaaja voisi rikkoa sen uudelleen tietämättä miksi.
//
// Tuotannon todennettu lähtötila:
//   profile  1 rivi, id = 'me', tyyppi text
//   tasks   36 riviä, ei user_id-saraketta

const MIGRATION_0001 = '0001_auth_user_scoping.sql';
const OWNER_UUID = '2cc00622-f927-4604-a518-361a4328481b';

/** 0001 ilman kommentteja. Selitysteksti saa puhua vapaasti. */
function code0001() {
  return read(`${MIGRATION_DIR}/${MIGRATION_0001}`)
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')
    .toLowerCase();
}

test('KRIITTINEN: 0001 ei yritä muuntaa profile.id:tä uuid-tyypiksi', () => {
  // Tuotannon ainoan profiilirivin id on 'me'. Se EI ole uuid.
  //   alter column id type uuid using id::uuid
  // kaatuu heti ensimmäiseen riviin ja keskeyttää migraation.
  //
  // Tämä on se yksi virhe, jonka takia 0001 kirjoitettiin uusiksi.
  // Jos joku palauttaa sen, tämä testi kaatuu ensin.
  const code = code0001();

  assert.equal(/id\s*::\s*uuid/.test(code), false,
    'profile.id:tä muunnetaan uuid:ksi — tuotannon arvo on "me" ja muunnos kaatuu');
  assert.equal(/alter\s+column\s+id\s+type\s+uuid/.test(code), false,
    'profile.id:n tyyppiä muutetaan — tuotannon arvo ei ole uuid');
});

test('KRIITTINEN: 0001 säilyttää alkuperäisen tunnisteen', () => {
  // Vanha arvo 'me' on ainoa asia, joka tekee migraatiosta peruttavan
  // ilman varmuuskopion palautusta. Sen pudottaminen tekisi
  // rollback-osion valheeksi.
  const code = code0001();

  assert.match(code, /rename\s+column\s+id\s+to\s+legacy_id/,
    'vanhaa tunnistetta ei siirretä talteen');
  assert.equal(/alter\s+table\s+public\.profile\s+drop\s+column/.test(code), false,
    '0001 pudottaa sarakkeen profile-taulusta — alkuperäinen arvo katoaisi');
});

test('KRIITTINEN: 0001 nimeää omistajan vakiona eikä valitse sitä ajossa', () => {
  // Dynaaminen valinta antaisi väärän vastauksen sillä hetkellä, kun
  // kantaan on ehtinyt syntyä toinen tili — ja 36 tehtävää siirtyisi
  // väärälle ihmiselle peruuttamattomasti.
  const code = code0001();

  assert.ok(code.includes(OWNER_UUID),
    'omistajan tunnistetta ei ole kirjoitettu migraatioon');

  assert.equal(/\blimit\s+1\b/.test(code), false,
    'migraatio käyttää LIMIT 1 -valintaa');
  assert.equal(/order\s+by\s+created_at/.test(code), false,
    'migraatio valitsee omistajan rivijärjestyksen perusteella');
  assert.equal(/\bemail\s*=/.test(code), false,
    'migraatio arvaa omistajan sähköpostin perusteella');

  // Paikanpitäjä oli aiemman luonnoksen tapa. Sitä ei saa palata.
  assert.equal(code.includes('00000000-0000-0000-0000-000000000000'), false,
    'paikanpitäjä-uuid on palannut migraatioon');
});

test('0001 tarkistaa esiehdot ennen kuin se muuttaa mitään', () => {
  // Migraatio ei saa luottaa siihen, että inventaario on yhä voimassa.
  // Kanta on voinut muuttua inventoinnin ja ajon välissä.
  const code = code0001();

  const firstChange = Math.min(
    ...['alter table public.tasks', 'alter table public.profile', 'update public.']
      .map(needle => {
        const at = code.indexOf(needle);
        return at === -1 ? Number.MAX_SAFE_INTEGER : at;
      }));

  const firstGuard = code.indexOf('raise exception');
  assert.ok(firstGuard !== -1, 'esiehtotarkistuksia ei ole lainkaan');
  assert.ok(firstGuard < firstChange,
    'ensimmäinen muutos tapahtuu ennen ensimmäistä esiehtoa');

  // Jokainen tarkistus vastaa yhtä tapaa tehdä vahinkoa.
  for (const guard of [
    'expected_task_rows',        // rivimäärä on yhä sama
    'expected_profile_rows',
    'legacy_profile_id',         // ainoa rivi on tunnettu
    'auth.users',                // omistaja on olemassa
    "column_name = 'user_id'",   // ei osittain ajettu
    "column_name = 'legacy_id'"
  ]) {
    assert.ok(code.includes(guard.toLowerCase()),
      `esiehto puuttuu: ${guard}`);
  }
});

test('KRIITTINEN: user_id lukitaan pakolliseksi vasta backfillin jälkeen', () => {
  // Väärä järjestys kaataisi migraation 36 olemassa olevaan riviin.
  const code = code0001();

  const backfill = code.indexOf('update public.tasks');
  const notNull  = code.indexOf('alter column user_id set not null');
  const check    = code.indexOf('user_id is null');

  assert.ok(backfill !== -1 && notNull !== -1, 'backfill tai lukitus puuttuu');
  assert.ok(backfill < notNull,
    'user_id lukitaan pakolliseksi ennen kuin data on täytetty');
  assert.ok(check !== -1 && check > backfill && check < notNull,
    'täyttöä ei tarkisteta backfillin ja lukituksen välissä');
});

test('KRIITTINEN: profile.id lukitaan vasta täytön jälkeen', () => {
  const code = code0001();

  const backfill = code.indexOf('update public.profile');
  const notNull  = code.indexOf('alter column id set not null');

  assert.ok(backfill !== -1 && notNull !== -1, 'backfill tai lukitus puuttuu');
  assert.ok(backfill < notNull,
    'profile.id lukitaan pakolliseksi ennen kuin arvo on asetettu');
});

test('KRIITTINEN: 0001 poistaa vanhat salli-kaikki-politiikat', () => {
  // Politiikat ovat OR-ehtoja keskenään. Yksi jäljelle jäänyt salliva
  // politiikka kumoaa kaikki kahdeksan uutta.
  const code = code0001();

  assert.match(code, /drop policy/,
    'vanhoja politiikkoja ei poisteta');
  assert.match(code, /from pg_policies/,
    'poisto nojaa politiikan nimeen — nimi on voitu antaa käsin');

  assert.ok(code.indexOf('drop policy') < code.indexOf('create policy'),
    'vanhat politiikat poistetaan vasta uusien luonnin jälkeen');
});

test('0001 luo kahdeksan omistajuuspolitiikkaa authenticated-roolille', () => {
  const code = code0001();

  for (const table of ['tasks', 'profile']) {
    const column = table === 'tasks' ? 'user_id' : 'id';
    for (const action of ['select', 'insert', 'update', 'delete']) {
      assert.match(code,
        new RegExp(`create policy ${table}_${action}_own on public\\.${table}`),
        `${table}: ${action}-politiikka puuttuu`);
    }
    assert.match(code, new RegExp(`auth\\.uid\\(\\) = ${column}`),
      `${table}: omistajuusehto ei osoita sarakkeeseen ${column}`);
  }

  assert.equal((code.match(/create policy/g) || []).length, 8,
    'politiikkoja ei ole tasan kahdeksaa');
  assert.equal((code.match(/for \w+ to authenticated/g) || []).length, 8,
    'jokaisen politiikan pitää kohdistua rooliin authenticated');
});

test('KRIITTINEN: 0001 poistaa anonin oikeudet molemmista tauluista', () => {
  // Julkinen avain on selaimessa. Jos anon säilyttää oikeudet, RLS on
  // ainoa este ja yksi väärin kirjoitettu politiikka avaa kaiken.
  const code = code0001();

  for (const table of ['tasks', 'profile']) {
    assert.match(code, new RegExp(`revoke all on table public\\.${table}\\s+from anon`),
      `${table}: anonin oikeuksia ei revokoida`);
  }

  // authenticated saa takaisin vain rivioperaatiot — ei TRUNCATE,
  // REFERENCES eikä TRIGGER.
  assert.equal((code.match(/grant select, insert, update, delete/g) || []).length, 2,
    'authenticated-roolin oikeuksia ei rajata neljään operaatioon');
});

test('KRIITTINEN: 0001 sulkee myös PUBLIC-roolin perintäpolun', () => {
  // PostgreSQL-rooli PUBLIC tarkoittaa "kaikki roolit". Sille myönnetyn
  // oikeuden perii jokainen rooli, myös anon — eikä
  //   revoke all on public.tasks from anon
  // poista sitä, koska anonilla ei ole sitä suoraan. Se on peritty.
  //
  // Pelkkä anon-revoke on siis todiste vain siitä, ettei anonilla ole
  // SUORAA oikeutta. Se ei ole todiste siitä, ettei anon pääse tauluun.
  const code = code0001();

  for (const table of ['tasks', 'profile']) {
    assert.match(code, new RegExp(`revoke all on table public\\.${table}\\s+from public`),
      `${table}: PUBLIC-roolin oikeuksia ei revokoida — anon perisi ne`);
  }

  // Järjestys: revoke ennen grantia. Toisin päin authenticated
  // menettäisi juuri saamansa oikeudet.
  const lastRevoke = code.lastIndexOf('revoke all on table');
  const firstGrant = code.indexOf('grant select, insert, update, delete');
  assert.ok(lastRevoke !== -1 && firstGrant !== -1);
  assert.ok(lastRevoke < firstGrant,
    'oikeuksia myönnetään ennen kuin vanhat on poistettu');
});

test('KRIITTINEN: 0001 todentaa TEHOLLISET oikeudet, ei vain myönnettyjä', () => {
  // Suora grant-luettelo ei näe perintää. Kaksi eri tarkistusta
  // todistavat eri asian, ja kumpikin yksin jättäisi aukon:
  //   aclexplode           -> mitä on nimenomaisesti myönnetty (PUBLIC näkyy)
  //   has_table_privilege  -> mitä rooli todella saa tehdä (perintä mukana)
  const code = code0001();

  assert.match(code, /aclexplode/,
    'PUBLIC-myöntöjä ei tarkisteta — role_table_grants ei näytä niitä');
  assert.match(code, /a\.grantee = 0/,
    'PUBLIC-myöntöä ei tunnisteta (grantee 0)');
  assert.match(code, /has_table_privilege\('anon'/,
    'anonin tehollista oikeutta ei tarkisteta');
  assert.match(code, /has_table_privilege\('authenticated'/,
    'authenticated-roolin tehollista oikeutta ei tarkisteta');

  // Tarkistuksen pitää kattaa myös ne kolme oikeutta, joita kumpikaan
  // rooli ei tarvitse. Pelkkä CRUD-tarkistus päästäisi TRUNCATEn läpi.
  for (const privilege of ['truncate', 'references', 'trigger']) {
    assert.ok(code.includes(`'${privilege}'`),
      `tehollisten oikeuksien tarkistus ei kata oikeutta ${privilege}`);
  }
});

test('KRIITTINEN: legacy_id menettää vanhan oletusarvon', () => {
  // Tuotannon profile.id:llä on `default 'me'`, ja Postgresissa
  // oletusarvo SEURAA saraketta uudelleennimeämisessä.
  //
  // Ilman nimenomaista drop defaultia jokainen migraation jälkeen
  // syntyvä profiilirivi saisi automaattisesti legacy_id = 'me'.
  // Sarake, jonka nimi lupaa historiatietoa, täyttyisi uudella datalla,
  // ja rollback-osion oletus "legacy_id kertoo mikä rivi oli
  // alkuperäinen" lakkaisi pitämästä paikkaansa.
  const code = code0001();

  const rename    = code.indexOf('rename column id to legacy_id');
  const dropDeflt = code.indexOf('alter column legacy_id drop default');

  assert.ok(rename !== -1, 'uudelleennimeämistä ei löytynyt');
  assert.ok(dropDeflt !== -1,
    'legacy_id ei menetä vanhaa oletusarvoa — uudet rivit perisivät arvon "me"');
  assert.ok(rename < dropDeflt,
    'oletusarvo pudotetaan ennen uudelleennimeämistä — sarakenimi ei vielä osu');

  // Oletuksen katoaminen myös tarkistetaan ajossa, ei vain kirjoiteta.
  assert.match(code, /column_default into v_default/,
    'oletusarvon katoamista ei varmisteta ajon aikana');
});

test('KRIITTINEN: alkuperäinen legacy-arvo säilyy koskemattomana', () => {
  // legacy_id on ainoa asia, joka tekee migraatiosta purettavaksi ilman
  // varmuuskopiota. Sen tyhjentäminen tai pudottaminen tekisi
  // rollback-osiosta valheen.
  const code = code0001();

  assert.equal(/update public\.profile[\s\S]{0,200}?set\s+legacy_id/.test(code), false,
    '0001 kirjoittaa legacy_id-sarakkeen päälle');
  assert.equal(/drop column\s+(if exists\s+)?legacy_id/.test(code), false,
    '0001 pudottaa legacy_id-sarakkeen');

  // Ja säilyminen tarkistetaan ajossa.
  assert.match(code, /legacy_id = \(select legacy_profile_id from _migration_params\)/,
    'legacy-arvon säilymistä ei tarkisteta ajon aikana');
});

test('KRIITTINEN: sovelluskoodi ei riipu legacy_id-sarakkeesta', () => {
  // legacy_id on migraation historiatietoa. Jos ajonaikainen koodi
  // alkaisi lukea tai kirjoittaa sitä, sarakkeen pudottaminen myöhemmin
  // rikkoisi sovelluksen — ja juuri se pudottaminen on dokumentoitu
  // sallituksi myöhemmäksi päätökseksi.
  for (const file of browserModules()) {
    assert.equal(read(file).includes('legacy_id'), false,
      `${file} viittaa sarakkeeseen legacy_id`);
  }
});

test('varmistuskysely 0001 todentaa PUBLIC-perinnän ja tehollisen oikeuden', () => {
  const verify = read('supabase/verify/verify_0001.sql')
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')
    .toLowerCase();

  assert.ok(verify.includes('aclexplode'),
    'varmistus ei näe PUBLIC-roolille myönnettyjä oikeuksia');
  assert.ok(verify.includes('a.grantee = 0'),
    'varmistus ei tunnista PUBLIC-myöntöä');
  assert.ok(verify.includes("has_table_privilege('anon'"),
    'varmistus ei tarkista anonin tehollista oikeutta');
  assert.ok(verify.includes("has_table_privilege('authenticated'"),
    'varmistus ei tarkista authenticated-roolin tehollista oikeutta');
  assert.ok(verify.includes('legacy_id'),
    'varmistus ei katso legacy_id-saraketta');
});

test('0001 sitoo molemmat taulut auth.users-tauluun', () => {
  const code = code0001();

  assert.match(code,
    /add constraint tasks_user_id_fkey[\s\S]*?references auth\.users\(id\) on delete cascade/,
    'tasks.user_id ilman viitettä auth.users-tauluun');
  assert.match(code,
    /add constraint profile_id_fkey[\s\S]*?references auth\.users\(id\) on delete cascade/,
    'profile.id ilman viitettä auth.users-tauluun');
});

test('0001 antaa omistajuuden tietokannalle, ei selaimelle', () => {
  // Jos client saisi valita user_id:n, RLS ei suojaisi mitään.
  // Sama päätös kuin src/lib/rows.js: SERVER_OWNED_FIELDS.
  const code = code0001();

  assert.match(code, /alter column user_id set default auth\.uid\(\)/);
  assert.match(code, /alter column id set default auth\.uid\(\)/);
});

test('varmistuskysely 0001 tarkistaa saman omistajan kuin migraatio', () => {
  // Kaksi tiedostoa, yksi totuus. Jos migraation omistaja vaihtuu mutta
  // varmistus jää vanhaan, varmistus näyttäisi vihreää väärästä syystä.
  const verify = read('supabase/verify/verify_0001.sql');

  assert.ok(verify.includes(OWNER_UUID),
    'varmistuskysely ei tarkista omistajaa lainkaan');
  assert.ok(code0001().includes(OWNER_UUID),
    'migraatio ja varmistus eivät käytä samaa omistajaa');
});

test('varmistuskysely 0001 tarkistaa juuri ne asiat jotka voivat mennä pieleen', () => {
  const verify = read('supabase/verify/verify_0001.sql')
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')
    .toLowerCase();

  const required = [
    ['relrowsecurity',             'RLS-tila'],
    ['pg_policies',                'politiikat'],
    ["grantee = 'anon'",           'anonin oikeudet'],
    ['user_id is null',            'omistajattomat rivit'],
    ['count(distinct user_id)',    'omistajien lukumäärä'],
    ['confdeltype',                'vierasavaimen poistosääntö'],
    ['legacy_id',                  'säilytetty alkuperäinen tunniste'],
    ['tasks_user_id_date_idx',     'indeksi']
  ];

  for (const [needle, what] of required) {
    assert.ok(verify.includes(needle), `varmistuksesta puuttuu: ${what}`);
  }
});
