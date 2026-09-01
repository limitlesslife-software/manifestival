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

import { ROOT, read } from './helpers/sources.mjs';

import { RECURRENCE, ROUTINE_SCHEDULING, EXCEPTION } from '../src/domain/routine.js';
import { GOAL_STATUS, PROGRESS_MODE } from '../src/domain/goal.js';
import { PROJECT_STATUS } from '../src/domain/project.js';
import { PRIORITIES } from '../src/domain/priority.js';
import { SCALE_MIN, SCALE_MAX } from '../src/domain/wellbeing.js';
import { DEFAULT_PREFERENCES } from '../src/domain/notification.js';
import { TABLES } from '../src/data/schema.js';

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
