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
import { MARKER_PREFIX } from '../tools/rls-acceptance/acceptance.js';

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
const NEWLINE = String.fromCharCode(10);

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

  // supabase/acceptance elaa saman saannon alla. Se ei ole
  // migraatiokohtainen varmistus, joten se on eri hakemistossa, mutta se
  // ajetaan tuotantoa vasten kasin samalla tavalla — ja siksi sen on
  // oltava yhta ehdottomasti vain lukeva.
  const kaikki = [
    ...files.map(name => ['supabase/verify', name]),
    ...fs.readdirSync(path.join(ROOT, 'supabase/acceptance'))
      .filter(name => name.endsWith('.sql'))
      .map(name => ['supabase/acceptance', name])
  ];

  // Tarkistus tehdään LAUSEEN ALKUSANASTA, ei sisältyvyydestä. Kielletty
  // sana esiintyy laillisesti tunnisteiden sisällä: role_table_grants
  // sisältää sanan "grant" ja odotettu "on delete set null" sanan "delete".
  // Sisältyvyystarkistus antaisi vääriä hälytyksiä lisäämättä kattavuutta:
  // muuttava lause voi olla vain lauseen alussa.
  for (const [hakemisto, name] of kaikki) {
    // Kommentit pois: selitysteksti saa puhua migraatioista vapaasti.
    const sql = fs.readFileSync(path.join(ROOT, hakemisto, name), 'utf8')
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

test('KRIITTINEN: jokainen vierasavain on varmistuskyselyn ulottuvilla', () => {
  // Vierasavaimen poistosääntö on domain-päätös, joka elää vain
  // kannassa. Jos SET NULL vaihtuisi CASCADEksi, tavoitteen poisto
  // veisi tehtävät — eikä mikään sovelluskoodissa huomaisi sitä.
  // Varmistuskysely on ainoa paikka, jossa se voitaisiin nähdä.
  //
  // Tämä testi löysi verify_0004:stä oikean aukon: se listasi
  // vierasavaimet NIMELTÄ ja kaksi kuudesta puuttui listasta. Molemmat
  // syntyvät create table -lauseen sisällä, joten ne on helppo unohtaa.
  //
  // Kaksi hyväksyttyä tapaa kattaa vierasavain:
  //   1. rajoite mainitaan nimeltä
  //   2. kysely rajataan taulun conrelid-arvolla, jolloin kaikki sen
  //      taulun vierasavaimet tulevat mukaan nimistä riippumatta
  for (const name of migrationFiles()) {
    const number = name.slice(0, 4);
    const source = sql(name);
    const verify = read(`supabase/verify/verify_${number}.sql`).toLowerCase();

    /** taulu -> vierasavaimen nimi, sekä nimetyt että create tablen sisäiset. */
    const foreignKeys = new Map();
    const add = (table, constraint) => {
      if (!foreignKeys.has(table)) foreignKeys.set(table, new Set());
      foreignKeys.get(table).add(constraint);
    };

    for (const match of source.matchAll(
      /alter table public\.(\w+)[\s\S]{0,120}?add constraint (\w+)\s+foreign key/g)) {
      add(match[1], match[2]);
    }

    for (const table of source.matchAll(
      /create table if not exists public\.(\w+) \(([\s\S]*?)\n\);/g)) {
      for (const column of table[2].matchAll(
        /^\s+(\w+)\s+\w+[^\n]*?references\s+public\./gm)) {
        add(table[1], `${table[1]}_${column[1]}_fkey`);
      }
    }

    for (const [table, constraints] of foreignKeys) {
      // Taulukohtainen rajaus kattaa kaikki taulun vierasavaimet.
      const scopedByTable = verify.includes(`'public.${table}'::regclass`);
      if (scopedByTable) continue;

      for (const constraint of constraints) {
        assert.ok(verify.includes(constraint),
          `verify_${number}.sql ei kata vierasavainta ${constraint}`
          + ` — ei nimeltä eikä taulun ${table} kautta.`
          + ' Väärä poistosääntö jäisi huomaamatta.');
      }
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
  const tiedostot = ['supabase/verify', 'supabase/acceptance'].flatMap(hakemisto =>
    fs.readdirSync(path.join(ROOT, hakemisto))
      .filter(f => f.endsWith('.sql'))
      .map(f => [hakemisto, f]));

  for (const [hakemisto, name] of tiedostot) {
    const sql = fs.readFileSync(path.join(ROOT, hakemisto, name), 'utf8')
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

test('KRIITTINEN: 0001 lukitsee taulut ennen kuin luottaa niiden tilaan', () => {
  // begin; ei jäädytä mitään. Postgresin oletuseristystaso on
  // READ COMMITTED, ja pelkkä select ottaa vain ACCESS SHARE -lukon,
  // joka ei estä toisen istunnon kirjoituksia.
  //
  // Ilman lukkoa aukko on todellinen: sovellus on pystyssä koko ajon
  // ajan, ja taustalle jäänyt välilehti voisi lisätä tehtävän SEN
  // JÄLKEEN kun rivimäärä on todettu 36:ksi mutta ENNEN kuin migraatio
  // saa oman DDL-lukkonsa. Migraatio tekisi päätöksensä tilasta, jota
  // ei enää ole — juuri se vika, jonka esiehdot oli tarkoitettu
  // estämään.
  const code = code0001();

  const lock = code.indexOf('lock table public.tasks, public.profile');
  assert.ok(lock !== -1,
    'tauluja ei lukita lainkaan — esiehdot voivat vanhentua kesken ajon');
  assert.match(code.slice(lock, lock + 120), /in access exclusive mode/,
    'lukko ei ole ACCESS EXCLUSIVE — heikompi ei estä kaikkia kirjoituksia');

  // Molemmat samassa lauseessa. Kaksi peräkkäistä lukkoa eri
  // järjestyksessä eri istunnoissa on klassinen lukkiutuma.
  assert.equal((code.match(/^lock table /gm) || []).length, 1,
    'lukkoja on useampi lause — lukkiutumisen riski');

  // Olemassaolotarkistus ENNEN lukkoa: LOCK TABLE olemattomaan tauluun
  // antaisi epäselvemmän virheen kuin oma tarkistus.
  const existence = code.indexOf('to_regclass');
  assert.ok(existence !== -1 && existence < lock,
    'lukitaan ennen kuin on varmistettu että taulut ovat olemassa');

  // Tuotannon tauluja ei LUETA ennen lukkoa. Tämä on se varsinainen
  // sääntö: mikä tahansa rivimäärä tai sisältö, joka luetaan lukitse-
  // mattomasta taulusta, voi olla vanhentunut jo seuraavalla rivillä.
  //
  // Vakioiden esittely vaiheessa 0 ei ole tuotannon lukemista, joten
  // tarkistus kohdistuu nimenomaan taulusta lukemiseen.
  for (const read of ['from public.tasks', 'from public.profile']) {
    const first = code.indexOf(read);
    assert.ok(first !== -1, `migraatio ei lue taulua lainkaan: ${read}`);
    assert.ok(first > lock,
      `taulusta luetaan ennen lukkoa (${read}) — tila voi muuttua sen jälkeen`);
  }

  // Osittaisen ajon tunnistus kuuluu myös lukon taakse: toinen istunto
  // voisi muuten ehtiä lisätä saman sarakkeen.
  for (const guard of ["column_name = 'user_id'", "column_name = 'legacy_id'"]) {
    const at = code.indexOf(guard.toLowerCase());
    assert.ok(at !== -1, `esiehto puuttuu: ${guard}`);
    assert.ok(at > lock, `esiehto "${guard}" tarkistetaan ennen lukkoa`);
  }

  // Ja lukko on ennen ensimmäistä muutosta.
  const firstChange = Math.min(
    ...['alter table public.tasks', 'alter table public.profile', 'update public.']
      .map(needle => {
        const at = code.indexOf(needle);
        return at === -1 ? Number.MAX_SAFE_INTEGER : at;
      }));
  assert.ok(lock < firstChange, 'ensimmäinen muutos tapahtuu ennen lukkoa');

  // Jonossa odottava ACCESS EXCLUSIVE estää jo itsessään kaikki uudet
  // lukijat. Ilman aikakatkaisua roikkuva istunto veisi sovelluksen alas.
  assert.match(code, /set local lock_timeout/,
    'lukon odotukselle ei ole aikakatkaisua');
  assert.ok(code.indexOf('set local lock_timeout') < lock,
    'aikakatkaisu asetetaan vasta lukon jälkeen');
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

/** verify_0001.sql ilman kommentteja. Selitysteksti saa puhua vapaasti. */
function verify0001() {
  return read('supabase/verify/verify_0001.sql')
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')
    .toLowerCase();
}

test('varmistuskysely 0001 tarkistaa juuri ne asiat jotka voivat mennä pieleen', () => {
  const verify = verify0001();

  const required = [
    ['relrowsecurity',             'RLS-tila'],
    ['pg_policies',                'politiikat'],
    ["grantee = 'anon'",           'anonin oikeudet'],
    ['user_id is null',            'omistajattomat rivit'],
    ['count(distinct user_id)',    'omistajien lukumäärä'],
    ['confdeltype',                'vierasavaimen poistosääntö'],
    ['legacy_id',                  'säilytetty alkuperäinen tunniste'],
    ['indkey[0]',                  'indeksin ensimmäinen sarake'],
    ['tasks_user_id_fkey',         'tehtävän vierasavain nimeltä'],
    ['profile_id_fkey',            'profiilin vierasavain nimeltä'],
    ['column_default',             'sarakkeiden oletusarvot']
  ];

  for (const [needle, what] of required) {
    assert.ok(verify.includes(needle), `varmistuksesta puuttuu: ${what}`);
  }
});

test('KRIITTINEN: varmistus lukee politiikkojen EHDOT, ei vain nimiä', () => {
  // Politiikan olemassaolo ei todista mitään. Väärä ehto näyttää
  // ulospäin tasan samalta kuin oikea: sama nimi, sama operaatio, sama
  // rooli. Ero on vain USING- ja WITH CHECK -lausekkeissa, ja juuri ne
  // ratkaisevat näkeekö käyttäjä toisen rivit.
  const verify = verify0001();

  assert.ok(verify.includes('qual'),
    'varmistus ei lue USING-lauseketta — väärä ehto menisi läpi');
  assert.ok(verify.includes('with_check'),
    'varmistus ei lue WITH CHECK -lauseketta — toisen nimiin kirjoittaminen menisi läpi');

  // Jokainen kahdeksasta nimeltä, jotta yksikään ei voi kadota
  // huomaamatta.
  for (const table of ['tasks', 'profile']) {
    for (const action of ['select', 'insert', 'update', 'delete']) {
      assert.ok(verify.includes(`${table}_${action}_own`),
        `varmistus ei tunne politiikkaa ${table}_${action}_own`);
    }
  }

  // Odotetut lausekkeet on kirjoitettu auki, ei vain luettu kannasta.
  // Ilman odotusarvoa vertailua ei ole, vain tuloste.
  assert.ok(verify.includes('auth.uid()=user_id'),
    'tasks-politiikoille ei ole odotettua lauseketta');
  assert.ok(verify.includes('auth.uid()=id'),
    'profile-politiikoille ei ole odotettua lauseketta');

  // Objektiivinen yhteenveto: kahdeksan riviä lausekkeita on juuri
  // sopivan pituinen lista siihen, että yksi väärä merkki jää
  // huomaamatta silmämääräisessä luvussa.
  assert.match(verify, /count\(\*\) filter \(where x\.tulos <> 'ok'\) over \(\)/,
    'poikkeamille ei ole koontilukua — virhe voisi piiloutua riveihin');

  // Normalisointi saa koskea vain muotoilua.
  assert.match(verify, /btrim\(replace\(coalesce\(p\.qual/,
    'lausekevertailu ei normalisoi muotoilua — se olisi hauras');
});

test('KRIITTINEN: varmistus todentaa vierasavaimen PÄÄT, ei vain nimeä', () => {
  // Rajoitteen nimi ei kerro mihin se osoittaa. Oikean niminen
  // vierasavain väärään sarakkeeseen tai väärään tauluun näyttäisi
  // nimilistassa täysin oikealta.
  const verify = verify0001();

  for (const [needle, what] of [
    ['con.conkey',   'lähdesarake'],
    ['con.confkey',  'kohdesarake'],
    ['con.confrelid', 'kohdetaulu'],
    ['nspname',      'skeema']
  ]) {
    assert.ok(verify.includes(needle),
      `vierasavaimen ${what} jää todentamatta`);
  }

  assert.ok(verify.includes("<> 'auth'") || verify.includes("'auth'"),
    'kohdeskeemaa auth ei tarkisteta');
  assert.ok(verify.includes("'users'"),
    'kohdetaulua auth.users ei tarkisteta');

  // Ja ettei odotettujen lisäksi ole muita.
  assert.match(verify, /conname not in \('tasks_user_id_fkey', 'profile_id_fkey'\)/,
    'ylimääräisiä vierasavaimia ei havaita');
});

test('KRIITTINEN: indeksitarkistus katsoo rakennetta eikä nimeä', () => {
  // LÖYTYNYT VIKA, JOTA TÄMÄ VARTIOI
  //
  // Tuotannon indeksi on yhdistelmä (user_id, date). Nimeen tai
  // täsmälliseen sarakelistaan (user_id) sidottu tarkistus raportoi
  // siitä FAILin, vaikka kanta oli kunnossa — ja väärä hälytys keskellä
  // tuotannon aktivointia on kallis: se pysäyttää oikean työn ja
  // opettaa ohittamaan varmistuksen.
  //
  // Sama sidonta pettää myös toisin päin. Indeksi nimeltä
  // tasks_user_id_date_idx voi olla sarakkeella (date), ja nimeen
  // luottava tarkistus hyväksyisi sen.
  //
  // Vaatimus on rakenteellinen: jonkin indeksin ENSIMMÄISEN sarakkeen on
  // oltava user_id. btree-indeksiä voi käyttää etuliitteellään, joten
  // (user_id, date) täyttää sen.
  const verify = verify0001();

  assert.ok(verify.includes('indkey[0]'),
    'indeksin ensimmäistä saraketta ei katsota lainkaan');
  assert.ok(verify.includes("a.attname = 'user_id'"),
    'ensimmäistä saraketta ei verrata user_id:hen');

  // Nimi saa esiintyä tuloksessa, mutta se ei saa olla ehto.
  const indexCheck = verify0001()
    .split(';')
    .map(part => part.trim())
    .find(part => part.includes('pg_index'));

  assert.ok(indexCheck, 'indeksitarkistusta ei löytynyt lainkaan');
  assert.equal(indexCheck.includes('tasks_user_id_date_idx'), false,
    'indeksitarkistus on yhä sidottu indeksin nimeen');
  assert.equal(/indexname\s*=/.test(indexCheck), false,
    'indeksitarkistus vertaa yhä indeksin nimeä');

  // Ja migraatio luo yhä sen indeksin, jota tarkistus edellyttää.
  assert.ok(code0001().includes('create index if not exists tasks_user_id_date_idx'),
    'migraatio ei enää luo user_id-alkuista indeksiä');
  assert.ok(code0001().includes('on public.tasks (user_id, date)'),
    'migraatio ei enää luo (user_id, date) -indeksiä');
});

/**
 * Poimii indeksitarkistuksen SÄÄNNÖN suoraan SQL:stä.
 *
 * Tämä ei ole SQL:n uudelleentoteutus vaan sen lukemista. Sääntö on
 * kokonaan kahdessa kohdassa: mihin indeksin sarakkeeseen katsotaan
 * (`indkey[n]`) ja mihin nimeen sitä verrataan (`attname = '...'`).
 * Molemmat luetaan tiedostosta, joten jos joku vaihtaisi tarkistuksen
 * takaisin nimipohjaiseksi, poiminta ei löytäisi sääntöä lainkaan — ja
 * jos joku vaihtaisi alaindeksin ykköseksi, alla olevat tapaukset
 * kääntyisivät toisin päin.
 *
 * @returns {(index: {columns: string[]}) => boolean}
 */
function indexRuleFrom(sqlSource, tiedosto) {
  const subscript = /indkey\[(\d+)\]/.exec(sqlSource);
  const column = /attname = '([a-z_]+)'/.exec(sqlSource);

  assert.ok(subscript, `${tiedosto}: indeksitarkistus ei katso indkey-alkiota`);
  assert.ok(column, `${tiedosto}: indeksitarkistus ei vertaa sarakkeen nimeä`);

  const position = Number(subscript[1]);
  const expected = column[1];
  return index => index.columns[position] === expected;
}

test('KRIITTINEN: indeksisääntö hyväksyy etuliitteen ja hylkää väärän järjestyksen', () => {
  // TÄMÄ ON SE VIKA, JOKA OIKEASTI SATTUI
  //
  // Kertaluontoinen varmistin vaati täsmälleen sarakelistan (user_id).
  // Tuotannossa on (user_id, date), joten varmistin raportoi FAILin
  // kannasta joka oli kunnossa. Väärä hälytys keskellä tuotannon
  // aktivointia on kallis: se pysäyttää oikean työn ja opettaa
  // ohittamaan varmistuksen.
  //
  // Sidonta pettää myös toisin päin: (date, user_id) on eri indeksi.
  // btree-indeksiä voi käyttää etuliitteellään, joten (user_id, date)
  // kelpaa omistajahakuun mutta (date, user_id) ei — jälkimmäisessä
  // omistajalla suodattava kysely joutuu lukemaan koko indeksin.
  //
  // Sääntö luetaan molemmista tiedostoista erikseen: ne ovat eri
  // tiedostoja, ja toinen voi ajautua erilleen huomaamatta.
  const lahteet = [
    ['verify_0001.sql', verify0001()
      .split(';').map(part => part.trim()).find(part => part.includes('pg_index'))],
    ['verify_acceptance.sql', read('supabase/acceptance/verify_acceptance.sql')
      .split(NEWLINE)
      .filter(line => !line.trim().startsWith('--'))
      .join(NEWLINE)
      .toLowerCase()]
  ];

  const tapaukset = [
    ['(user_id)',            ['user_id'],         true,  'pelkkä omistajaindeksi kelpaa'],
    ['(user_id, date)',      ['user_id', 'date'], true,  'yhdistelmä, jonka etuliite on user_id, kelpaa'],
    ['(date, user_id)',      ['date', 'user_id'], false, 'väärä järjestys ei kelpaa'],
    ['(id)',                 ['id'],              false, 'pääavain ei kelpaa omistajaindeksiksi'],
    ['(date)',               ['date'],            false, 'liittymätön indeksi ei kelpaa'],
    ['(completed, user_id)', ['completed', 'user_id'], false, 'user_id muualla kuin ensimmäisenä ei kelpaa']
  ];

  for (const [tiedosto, sqlSource] of lahteet) {
    assert.ok(sqlSource, `${tiedosto}: indeksitarkistusta ei löytynyt lainkaan`);
    const kelpaa = indexRuleFrom(sqlSource, tiedosto);

    for (const [nimi, columns, odotus, miksi] of tapaukset) {
      assert.equal(kelpaa({ columns }), odotus,
        `${tiedosto}: indeksi ${nimi} — ${miksi}`);
    }
  }
});

test('KRIITTINEN: varmistus todentaa perumisen merkkipaalun', () => {
  // legacy_id on ainoa asia, joka tekee läpimenneestä migraatiosta
  // purettavan ilman varmuuskopiota. Jos arvo on kadonnut, migraation
  // ROLLBACK-osio ei enää pidä paikkaansa — ja se huomattaisiin vasta
  // silloin kun perumista oikeasti tarvitaan.
  const verify = verify0001();

  assert.match(verify, /filter \(where legacy_id = 'me'\)/,
    'alkuperäisen arvon säilymistä ei tarkisteta');
  assert.match(verify, /filter \(where legacy_id is not null\)/,
    'ei-tyhjien legacy-arvojen määrää ei tarkisteta');
  assert.match(verify, /legacy_id <> 'me'/,
    'muita legacy-arvoja ei havaita — jäänyt oletusarvo jäisi huomaamatta');
});

test('hyväksyntätestin jälkivarmistus kattaa jokaisen vaaditun kohdan', () => {
  // Selaimessa ajettu hyväksyntätesti katsoo kantaa RLS:n läpi. Se ei
  // siis voi nähdä, jäikö toisen tilin rivi kantaan — RLS piilottaisi
  // juuri sen rivin, jota etsitään. Tämä tiedosto on ainoa paikka,
  // josta jäännöksen voi nähdä, ja siksi sen kattavuus lukitaan tässä.
  const sql = read('supabase/acceptance/verify_acceptance.sql')
    .split(NEWLINE)
    .filter(line => !line.trim().startsWith('--'))
    .join(NEWLINE)
    .toLowerCase();

  // Yhtenainen tuloste: check_no / section / check_name / status / details.
  for (const sarake of ['check_no', 'section', 'check_name', 'status', 'details']) {
    assert.ok(sql.includes(sarake), `jälkivarmistuksesta puuttuu sarake ${sarake}`);
  }

  const vaaditut = [
    ['relrowsecurity',            'RLS on yhä päällä'],
    ['indkey[0]',                 'indeksin ensimmäinen sarake'],
    ['pg_policies',               'politiikat ovat yhä tallella'],
    ['with_check',                'politiikkojen kirjoitusehdot'],
    [OWNER_UUID.toLowerCase(),    'omistajan tunniste'],
    ['user_id is null',           'omistajattomat rivit'],
    // Vahvempi kuin omistajien lukumäärä: count(distinct user_id) = 1
    // olisi tosi myös silloin, kun se yksi omistaja on joku muu kuin A.
    // is distinct from nimeää omistajan ja näkee myös NULL-omistajan,
    // jonka tavallinen <>-vertailu jättäisi huomaamatta.
    ['user_id is distinct from', 'omistajan nimenomainen vertailu'],
    ['left join auth.users',      'orvot viittaukset'],
    ["legacy_id = 'me'",          'perumisen merkkipaalu'],
    [`${MARKER_PREFIX}%`,         'hyväksyntätestin jäännösrivit'],
    ['from auth.users',           'väliaikaisen tilin poisto'],
    ['confdeltype',               'vierasavaimen poistosääntö'],
    ["has_table_privilege('anon'", 'anonin teholliset oikeudet'],
    ['aclexplode',                'PUBLIC-roolin oikeudet']
  ];

  for (const [needle, mita] of vaaditut) {
    assert.ok(sql.includes(needle), `jälkivarmistuksesta puuttuu: ${mita}`);
  }

  // Odotettu rivimäärä on kirjoitettu auki, ei pääteltävissä.
  assert.ok(sql.includes("'36'"), 'tehtävien odotettua määrää ei tarkisteta');
});

test('KRIITTINEN: hyväksyntätestin tunniste on sama JS:ssä ja SQL:ssä', () => {
  // Kaksi eri kieltä, yksi sopimus. Jos ajuri vaihtaisi etuliitteen ja
  // jälkivarmistus etsisi vanhaa, siivouksen aukko jäisi näkymättömäksi:
  // SQL raportoisi tyytyväisenä nolla jäännösriviä, koska se etsii
  // etuliitettä, jota kukaan ei enää käytä.
  const sql = read('supabase/acceptance/verify_acceptance.sql');
  assert.ok(sql.includes(`${MARKER_PREFIX}%`),
    `jälkivarmistus ei etsi etuliitettä ${MARKER_PREFIX}`);

  const runner = read('tools/rls-acceptance/acceptance.js');
  assert.ok(runner.includes(`'${MARKER_PREFIX}'`),
    'ajurin etuliite ei ole enää vakio');
});

test('KRIITTINEN: varmistus 0001 ei muuta mitään', () => {
  // Sama sääntö kuin kaikilla varmistustiedostoilla, mutta erikseen
  // tälle: tämä on ainoa tiedosto, jota ajetaan tuotantoa vasten heti
  // migraation jälkeen, ja se ajetaan käsin liittämällä.
  const statements = read('supabase/verify/verify_0001.sql')
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map(part => part.trim())
    .filter(part => part.length > 0);

  assert.ok(statements.length >= 20,
    `varmistuksessa on vain ${statements.length} lausetta — onko jotain kadonnut?`);

  for (const statement of statements) {
    assert.equal(statement.split(/\s+/)[0].toLowerCase(), 'select',
      `lause alkaa väärin: ${statement.slice(0, 60)}`);
  }
});
