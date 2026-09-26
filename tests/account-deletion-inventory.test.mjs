// Tilin poiston inventaarion ja skeeman yhdenmukaisuus (GDPR-ajautuman esto).
//
// Yksi keskitetty inventaario (EXPORTED_COLLECTIONS) ohjaa vientiä,
// poiston kuiva-ajoa ja palvelinfunktion poistosuunnitelmaa. Nämä testit
// kaatuvat, jos jokin niistä ajautuu erilleen tai jos skeemaan lisätään
// käyttäjän omistama taulu, jota poisto ei tuntisi.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, read } from './helpers/sources.mjs';
import { classifyAccountSchema } from './helpers/migrationSchema.mjs';
import { EXPORTED_COLLECTIONS } from '../src/domain/dataExport.js';
import {
  ACCOUNT_DATA_MAP, RETENTION_DECISIONS, ACCOUNT_OWNED_COLLECTIONS
} from '../src/domain/accountLifecycle.js';
import { ACCOUNT_DATA_MAP as SHARED_MAP } from '../supabase/functions/_shared/accountInventory.js';
import { ALL_REPOSITORIES } from '../src/data/collectionsRepo.js';

const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');

function migrationsText() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(name => name.endsWith('.sql')).sort()
    .map(name => fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'))
    .join('\n');
}

/**
 * Taulut, joita migraatiot luovat mutta jotka EIVÄT ole käyttäjän dataa.
 *
 * Jokaisella on oltava kirjallinen perustelu. Uusi pysyvä taulu ei kuulu
 * tänne ilman omistajan päätöstä: jos siinä on käyttäjän rivejä, se kuuluu
 * poistokarttaan (ACCOUNT_DATA_MAP) ja vientiin (EXPORTED_COLLECTIONS).
 */
const NON_USER_TABLES = Object.freeze({
  _migration_params: 'Migraation 0001 väliaikainen parametritaulu (on commit drop): '
    + 'odotetut rivimäärät ja omistajan tunniste, ei pysyvää dataa.',
  _migration_0002_params: 'Migraation 0002 väliaikainen parametritaulu (on commit drop), ei pysyvää dataa.'
});

const MAPPED_TABLES = Object.values(ACCOUNT_DATA_MAP).map(entry => entry.table);

let classified = null;

/** Oikeiden migraatioiden luokittelu (lasketaan kerran). */
function schemaClassification() {
  classified ??= classifyAccountSchema(migrationsText(), { mappedTables: MAPPED_TABLES, exemptTables: NON_USER_TABLES });
  return classified;
}

/** { taulu -> omistajasarake } jokaiselle taululle, joka kaskadoituu auth.users:sta. */
function cascadingTables() {
  return schemaClassification().owners;
}

test('KRIITTINEN: poistokartta kattaa TÄSMÄLLEEN viennin kokoelmat', () => {
  assert.deepEqual(Object.keys(ACCOUNT_DATA_MAP).sort(), [...EXPORTED_COLLECTIONS].sort(),
    'ACCOUNT_DATA_MAP ja EXPORTED_COLLECTIONS ovat ajautuneet erilleen');
  assert.equal(ACCOUNT_OWNED_COLLECTIONS, EXPORTED_COLLECTIONS);
});

test('KRIITTINEN: Edge Functionin kartta on täsmälleen sama kuin src-kartta', () => {
  assert.deepEqual(SHARED_MAP, ACCOUNT_DATA_MAP,
    'supabase/functions/_shared/accountInventory.js on eri kuin src/domain/accountLifecycle.js');
});

test('KRIITTINEN: jokainen inventaarion taulu kaskadoituu auth.users:sta omistajasarakkeellaan', () => {
  const cascading = cascadingTables();
  for (const [collection, entry] of Object.entries(ACCOUNT_DATA_MAP)) {
    assert.equal(cascading.get(entry.table), entry.ownerColumn,
      `${collection}: taulu ${entry.table} ei kaskadoidu auth.users(id):stä sarakkeella ${entry.ownerColumn}`);
  }
});

test('KRIITTINEN: yksikään skeeman käyttäjätaulu ei puutu poistokartasta', () => {
  const mapped = new Set(Object.values(ACCOUNT_DATA_MAP).map(entry => entry.table));
  const unmapped = [...cascadingTables().keys()].filter(table => !mapped.has(table));
  assert.deepEqual(unmapped, [],
    `Skeemassa on käyttäjän omistamia tauluja, joita poisto ei tuntisi: ${unmapped.join(', ')}. `
    + 'Lisää ne EXPORTED_COLLECTIONS-listaan ja ACCOUNT_DATA_MAP:iin.');
});

test('KRIITTINEN: jokainen migraatioiden CREATE TABLE on luokiteltu (poistokartassa tai perustellusti vapautettu)', () => {
  // Omistajuutta ei päätellä kirjoitustavasta: taulu ilman suoraa
  // auth.users-viitettä (esim. vain yhdistelmäviite vanhempaan tauluun)
  // voi silti sisältää käyttäjän dataa. Siksi JOKAINEN luotu taulu on
  // luokiteltava nimenomaisesti.
  const { unclassified, created } = schemaClassification();
  assert.ok(created.length >= 24, 'CREATE TABLE -haku ei löydä tunnettuja tauluja -- haku on rikki');
  assert.deepEqual(unclassified, [],
    `Migraatiot luovat tauluja, joita poisto ei tunne: ${unclassified.join(', ')}. `
    + 'Lisää ne ACCOUNT_DATA_MAP:iin (ja vientiin) tai perustellusti NON_USER_TABLES-listaan.');
});

test('vapautetut taulut ovat olemassa, perusteltuja eivätkä ole poistokartassa', () => {
  const created = new Map(schemaClassification().created.map(table => [table.display, table]));
  for (const [name, reason] of Object.entries(NON_USER_TABLES)) {
    assert.ok(created.has(name), `${name}: vanhentunut vapautus, taulua ei enää luoda`);
    assert.ok(typeof reason === 'string' && reason.length >= 20, `${name}: perustelu puuttuu`);
    assert.equal(MAPPED_TABLES.includes(name), false, name);
    assert.equal(created.get(name).temporary, true, `${name}: vain väliaikainen taulu voi olla vapautettu ilman omistajan päätöstä`);
  }
});

test('KRIITTINEN: jokainen viittaus auth.users-tauluun on ON DELETE CASCADE', () => {
  // RESTRICT / NO ACTION (myös puuttuva ON DELETE = NO ACTION) estäisi
  // auth.admin.deleteUserin kokonaan: koko tilin poisto epäonnistuisi.
  const { nonCascade, nonCascadeReferences } = schemaClassification();
  assert.deepEqual(nonCascade, [], 'omistajasarake ei kaskadoidu');
  assert.deepEqual(nonCascadeReferences, [], 'auth.users-viittaus ilman on delete cascade');
});

test('KRIITTINEN: kaskadoituvat taulut ovat TÄSMÄLLEEN poistokartan taulut omistajasarakkeineen', () => {
  const expected = new Map(Object.values(ACCOUNT_DATA_MAP).map(entry => [entry.table, entry.ownerColumn]));
  const cascading = cascadingTables();
  assert.equal(cascading.size, Object.keys(ACCOUNT_DATA_MAP).length);
  assert.deepEqual([...cascading].sort(), [...expected].sort());
});

// ------------------------------------------ vartijan negatiiviset näytteet
//
// Vartija on arvokas vain, jos se tunnistaa muunkin kuin talon oman
// kirjoitustavan. Jokainen näyte alla meni aiemmin läpi hiljaa.

const HOUSE_STYLE = `create table public.routines (
  id text primary key,
  user_id uuid not null default auth.uid()
          references auth.users(id) on delete cascade,
  title text not null
);`;

function classifyFixture(sql, mappedTables = ['routines']) {
  return classifyAccountSchema(sql, { mappedTables, exemptTables: {} });
}

test('näyte: talon oma kirjoitustapa (myös CRLF) tunnistetaan kartoitetuksi', () => {
  for (const sql of [HOUSE_STYLE, HOUSE_STYLE.replace(/\n/g, '\r\n')]) {
    const result = classifyFixture(sql);
    assert.deepEqual(result.unclassified, []);
    assert.deepEqual(result.nonCascade, []);
    assert.deepEqual([...result.owners], [['routines', 'user_id']]);
  }
});

for (const [label, sql, expected] of [
  ['ilman default auth.uid()',
    'create table public.notes (id text primary key, user_id uuid not null references auth.users(id) on delete cascade);',
    { unclassified: ['notes'], unmappedOwners: ['notes'] }],
  ['if not exists',
    'create table if not exists public.notes (\n  user_id uuid default auth.uid() references auth.users(id) on delete cascade\n);',
    { unclassified: ['notes'], unmappedOwners: ['notes'] }],
  ['isot kirjaimet',
    'CREATE TABLE PUBLIC.NOTES (\n  USER_ID UUID NOT NULL DEFAULT AUTH.UID() REFERENCES AUTH.USERS(ID) ON DELETE CASCADE\n);',
    { unclassified: ['notes'], unmappedOwners: ['notes'] }],
  ['skeematon nimi',
    'create table notes (user_id uuid references auth.users on delete cascade);',
    { unclassified: ['notes'], unmappedOwners: ['notes'] }],
  ['ei-public-skeema',
    'create table private.notes (user_id uuid references auth.users(id) on delete cascade);',
    { unclassified: ['private.notes'], unmappedOwners: ['private.notes'] }],
  ['vain yhdistelmäviite vanhempaan tauluun (ei suoraa auth.users-viitettä)',
    'create table public.note_items (\n  id text, user_id uuid not null, note_id text,\n'
      + '  foreign key (note_id, user_id) references public.routines (id, user_id) on delete cascade\n);',
    { unclassified: ['note_items'], unmappedOwners: [] }],
  ['lainattu tunniste',
    'create table "public"."Notes" ("user_id" uuid references "auth"."users" ("id") on delete cascade);',
    { unclassified: ['Notes'], unmappedOwners: ['Notes'] }]
]) {
  test(`näyte: kartoittamaton taulu (${label}) havaitaan`, () => {
    const result = classifyFixture(sql);
    assert.deepEqual(result.unclassified, expected.unclassified);
    assert.deepEqual(result.unmappedOwners, expected.unmappedOwners);
    assert.deepEqual(result.nonCascade, []);
  });
}

for (const [label, sql, onDelete] of [
  ['on delete restrict',
    'create table public.routines (user_id uuid not null references auth.users(id) on delete restrict);', 'restrict'],
  ['ei ON DELETE -lauseketta (NO ACTION)',
    'create table public.routines (user_id uuid not null references auth.users(id));', 'no action (oletus)'],
  ['on delete set null',
    'create table public.routines (user_id uuid references auth.users(id) on delete set null);', 'set null'],
  ['taulutason rajoite no action',
    'create table public.routines (\n  id text,\n  user_id uuid not null,\n'
      + '  constraint routines_user_fk foreign key (user_id) references auth.users (id) on delete no action\n);', 'no action'],
  ['ALTER ... ADD CONSTRAINT ilman kaskadia',
    'create table public.routines (id text, user_id uuid);\n'
      + 'alter table public.routines add constraint r_fk foreign key (user_id) references auth.users(id);', 'no action (oletus)'],
  ['ALTER ... ADD COLUMN restrict',
    'create table public.routines (id text);\n'
      + 'alter table public.routines add column user_id uuid references auth.users on delete restrict;', 'restrict']
]) {
  test(`näyte: kaskadoitumaton auth.users-viittaus (${label}) havaitaan`, () => {
    const result = classifyFixture(sql);
    assert.equal(result.nonCascade.length, 1, JSON.stringify(result.nonCascade));
    assert.equal(result.nonCascade[0].table, 'routines');
    assert.equal(result.nonCascade[0].column, 'user_id');
    assert.equal(result.nonCascade[0].onDelete, onDelete);
    assert.equal(result.nonCascadeReferences.length, 1);
    assert.equal(result.owners.has('routines'), false, 'kaskadoitumaton ei ole omistaja');
  });
}

test('näyte: kommentit ohitetaan, mutta merkkijonon "--" ei katkaise lausetta', () => {
  const sql = [
    '-- create table public.ghost (user_id uuid references auth.users(id));',
    '/* create table public.ghost2 (user_id uuid references auth.users(id)); /* sisäkkäinen */ */',
    "comment on table public.routines is 'ei -- kommentti; references auth.users';",
    'create table public.notes2 (label text default \'a -- b\', user_id uuid references auth.users(id) on delete cascade);'
  ].join('\n');
  const result = classifyFixture(sql);
  assert.deepEqual(result.unclassified, ['notes2']);
  assert.deepEqual(result.unmappedOwners, ['notes2']);
});

test('näyte: funktion rungossa (dollarilainaus) luotu taulu ei jää piiloon', () => {
  const sql = "do $$ begin\n  create table public.hidden (user_id uuid references auth.users(id) on delete cascade);\nend $$;";
  assert.deepEqual(classifyFixture(sql).unclassified, ['hidden']);
});

test('taulunimet vastaavat repositorioiden todellisia tauluja', () => {
  for (const repo of ALL_REPOSITORIES) {
    const entry = ACCOUNT_DATA_MAP[repo.schemaKey];
    assert.ok(entry, `repositoriolla ${repo.schemaKey} ei ole poistokarttaa`);
    if (repo.table) assert.equal(entry.table, repo.table, repo.schemaKey);
  }
});

test('poistokartta on jäädytetty eikä salli prototyyppitemppuja', () => {
  assert.ok(Object.isFrozen(ACCOUNT_DATA_MAP));
  assert.ok(Object.isFrozen(SHARED_MAP));
});

test('säilytyspäätöstä vaativat kokoelmat on nimetty eikä oletusta piiloteta', () => {
  assert.equal(RETENTION_DECISIONS.aiAudit.decision, 'delete-with-account');
  assert.equal(RETENTION_DECISIONS.aiAudit.ownerReviewRequired, true);
  for (const name of Object.keys(RETENTION_DECISIONS)) {
    assert.ok(EXPORTED_COLLECTIONS.includes(name), name);
  }
});

// ------------------------------------------------ korotettu oikeus vain funktiossa

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', '.claude', 'worktrees'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|cjs|ts|html|json|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('KRIITTINEN: service-role/secret-avaimeen viitataan vain delete-account-funktiossa', () => {
  const allowed = new Set([
    path.join(ROOT, 'supabase', 'functions', 'delete-account', 'handler.js'),
    path.join(ROOT, 'supabase', 'functions', 'delete-account', 'index.ts')
  ]);
  const offenders = [];
  for (const dir of ['src', 'api', 'supabase/functions']) {
    for (const file of walk(path.join(ROOT, dir))) {
      if (allowed.has(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (/service_role|SERVICE_ROLE|SUPABASE_SECRET_KEYS|SUPABASE_SERVICE/.test(text)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
  }
  assert.deepEqual(offenders, []);
  assert.equal(/service_role|SERVICE_ROLE|SUPABASE_SECRET_KEYS/.test(read('index.html')), false);
});

test('KRIITTINEN: funktio ei sisällä kovakoodattua avainta eikä lue avainta pyynnöstä', () => {
  const handler = read('supabase/functions/delete-account/handler.js');
  const index = read('supabase/functions/delete-account/index.ts');
  for (const text of [handler, index]) {
    assert.equal(/eyJ[A-Za-z0-9_-]{20,}/.test(text), false, 'JWT-muotoinen merkkijono lähdekoodissa');
    assert.equal(/sb_secret_|sb_publishable_/.test(text), false, 'kovakoodattu avain');
  }
  // Avain tulee vain env:stä, ei request-oliosta.
  assert.equal(/request\.(headers\.get\(['"]apikey|json)/i.test(handler), false);
});

test('selain- ja api-koodi ei tuo funktion koodia eikä päinvastoin', () => {
  for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'api'))]) {
    // Vain import-lauseet: kommentti saa viitata funktioon.
    assert.equal(/(?:from|import)\s*\(?\s*['"][^'"]*supabase\/functions/.test(fs.readFileSync(file, 'utf8')), false,
      path.relative(ROOT, file));
  }
  const handler = read('supabase/functions/delete-account/handler.js');
  assert.equal(/from ['"]\.\.\/\.\.\/\.\.\/src/.test(handler), false, 'funktio ei saa tuoda src/-koodia');
});
