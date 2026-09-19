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

/** { taulu -> omistajasarake } jokaiselle taululle, joka kaskadoituu auth.users:sta. */
function cascadingTables() {
  const sql = migrationsText();
  const found = new Map();

  const created = /create table public\.(\w+)\s*\(([\s\S]*?)\n\);/g;
  for (const match of sql.matchAll(created)) {
    const owner = /(\w+)\s+uuid\s+(?:not null\s+)?(?:primary key\s+)?default auth\.uid\(\)\s+references auth\.users\(id\) on delete cascade/
      .exec(match[2]);
    if (owner) found.set(match[1], owner[1]);
  }

  const altered = /alter table public\.(\w+)\s+add constraint \w+\s+foreign key \((\w+)\) references auth\.users\(id\) on delete cascade/g;
  for (const match of sql.matchAll(altered)) found.set(match[1], match[2]);

  return found;
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
