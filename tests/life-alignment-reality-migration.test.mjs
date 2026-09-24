// Suunta 2: migraatio 0013, sen turvamalli, repositoriot, tilin elinkaari
// ja toteuman lähteiden rajat.
//
// REHELLINEN RAJAUS: testiympäristössä EI OLE PostgreSQL:ää. Politiikat
// todennetaan staattisesti ja kahden käyttäjän tekokantaa vasten (sama
// tapa kuin 0012:lle). Oikea RLS todennetaan vasta kannassa:
// supabase/verify/verify_0013.sql. REAL DB RLS = NOT YET PROVEN.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { TIME_SOURCES, MAX_OPERATION_ID_LENGTH, isOperationId } from '../src/domain/timeEntry.js';
import { TIMER_TARGETS, MAX_TIMER_NOTE_LENGTH, normalizeTimer } from '../src/domain/timer.js';
import { ITEM_KINDS, MAX_ITEM_ID_LENGTH, normalizeItemSettings } from '../src/domain/alignmentItemSettings.js';
import { MAX_REFLECTION_LENGTH } from '../src/domain/alignmentReview.js';
import {
  runningTimersRepo, alignmentItemSettingsRepo, timeEntriesRepo, weeklyCapacitiesRepo, alignmentReviewsRepo,
  ALL_REPOSITORIES
} from '../src/data/collectionsRepo.js';
import { TABLES, ALIGNMENT_REALITY_FIELDS, volatileAlignmentRealityFields } from '../src/data/schema.js';
import { EXPORTED_COLLECTIONS, buildUserDataExport } from '../src/domain/dataExport.js';
import { ACCOUNT_DATA_MAP, ACCOUNT_DOMAIN_LABELS, dryRunDeletion } from '../src/domain/accountLifecycle.js';
import { ACCOUNT_DATA_MAP as SHARED_MAP } from '../supabase/functions/_shared/accountInventory.js';
import {
  REALITY_SOURCES, realityFact, timeEntryAdapter, futureAdapter, suggestEnergyFromWellbeing,
  moneyCapacityShape, summarizeFacts, SOURCE_STATUS
} from '../src/domain/realitySources.js';
import { normalizeTimeEntry } from '../src/domain/timeEntry.js';
import { normalizeWeeklyCapacity } from '../src/domain/weeklyCapacity.js';

const MIGRATION = read('supabase/migrations/0013_alignment_reality.sql').replace(/\r\n/g, '\n');
const CODE = MIGRATION.split('\n').filter(line => !line.trim().startsWith('--')).join('\n').toLowerCase();
const M0012 = read('supabase/migrations/0012_life_alignment.sql').replace(/\r\n/g, '\n');
const VERIFY = read('supabase/verify/verify_0013.sql').replace(/\r\n/g, '\n');
const NEW_TABLES = ['running_timers', 'alignment_item_settings'];
const USER_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const USER_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

function createBlock(table) {
  const match = new RegExp(`create table public\\.${table} \\(([\\s\\S]*?)\\n\\);`).exec(CODE);
  assert.ok(match, `create table ${table} puuttuu`);
  return match[1];
}

function constraint(name) {
  const match = new RegExp(`add constraint ${name}\\s+([\\s\\S]*?);`).exec(CODE);
  assert.ok(match, `rajoite ${name} puuttuu`);
  return match[1].replace(/\s+/g, ' ');
}

// ================================================================ RAKENNE

test('0013: uudet taulut — omistaja on kannan asettama ja poistuu käyttäjän mukana', () => {
  for (const table of NEW_TABLES) {
    assert.match(createBlock(table), /user_id\s+uuid not null default auth\.uid\(\)\s+references auth\.users\(id\) on delete cascade/, table);
    assert.match(CODE, new RegExp(`add constraint ${table}_owner_row_key unique \\(user_id, id\\)`));
  }
});

test('0013: RLS päällä, neljä politiikkaa roolille authenticated, oikeudet nollattu ja anon ilman pääsyä', () => {
  for (const table of NEW_TABLES) {
    assert.match(CODE, new RegExp(`alter table public\\.${table} enable row level security;`));
    for (const role of ['public', 'anon', 'authenticated']) {
      assert.match(CODE, new RegExp(`revoke all on public\\.${table} from ${role};`), `${table}: revoke ${role}`);
    }
    assert.match(CODE, new RegExp(`grant select, insert, update, delete on public\\.${table} to authenticated;`));
    assert.equal(new RegExp(`grant [^;]* on public\\.${table} to anon`).test(CODE), false);
    const policies = [...CODE.matchAll(new RegExp(`create policy \\w+ on public\\.${table}\\s+for (\\w+) to (\\w+)`, 'g'))];
    assert.deepEqual(policies.map(p => p[1]).sort(), ['delete', 'insert', 'select', 'update']);
    assert.ok(policies.every(p => p[2] === 'authenticated'));
  }
});

test('0013: YKSI AJASTIN KÄYTTÄJÄÄ KOHTI ja SAMA OPERAATIO KERRAN kannan tasolla', () => {
  assert.equal(constraint('running_timers_one_per_user'), 'unique (user_id)');
  assert.equal(constraint('time_entries_operation_unique'), 'unique (user_id, operation_id)');
  assert.equal(constraint('alignment_item_settings_item_unique'), 'unique (user_id, item_kind, item_id)');
});

test('0013: vierasavaimet ovat yhdistelmäavaimia ja poisto nollaa vain oman sarakkeensa', () => {
  const fks = [...CODE.matchAll(/add constraint (\w+)\s+foreign key \((user_id), (\w+)\) references public\.(\w+) \(user_id, id\)\s+on delete set null \((\w+)\);/g)];
  assert.equal(fks.length, 7);
  for (const [, name, , column, , nulled] of fks) {
    assert.equal(column, nulled, `${name}: nollaa väärän sarakkeen`);
  }
  assert.equal(/foreign key \((?!user_id)/.test(CODE), false, 'yksisarakkeinen viittaus ohittaisi omistajan');
});

test('0013: kannan rajat vastaavat domainia', () => {
  const sources = [...constraint('time_entries_source_v2_check').matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(sources, [...TIME_SOURCES]);
  const kinds = [...constraint('running_timers_target_kind_check').matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(kinds.sort(), [...TIMER_TARGETS].sort());
  const items = [...constraint('alignment_item_settings_kind_check').matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(items.sort(), [...ITEM_KINDS].sort());
  assert.match(constraint('alignment_item_settings_energy_check'), /energy_demand between 1 and 5/);
  assert.match(constraint('alignment_item_settings_item_id_check'), new RegExp(`between 1 and ${MAX_ITEM_ID_LENGTH}`));
  assert.match(constraint('running_timers_note_check'), new RegExp(`<= ${MAX_TIMER_NOTE_LENGTH}`));
  assert.match(constraint('running_timers_paused_check'), /paused_seconds <= 604800/);
  assert.equal(normalizeTimer({ pausedSeconds: 10 ** 9 }).pausedSeconds, 604800);
  assert.match(constraint('time_entries_operation_check'), new RegExp(`between 1 and ${MAX_OPERATION_ID_LENGTH}`));
  assert.equal(isOperationId('timer:abc.1'), true);
  assert.equal(isOperationId("x'; drop"), false);
  assert.match(constraint('weekly_capacities_energy_budget_check'), /energy_budget_minutes <= 10080/);
  assert.match(constraint('alignment_reviews_policy_version_check'), /policy_version >= 1 and policy_version <= 100/);
  assert.ok(MAX_REFLECTION_LENGTH <= 4000);
});

test('0013: objektilaskenta (46) vastaa migraation sisältöä ja tunnistuslistaa', () => {
  const tables = (CODE.match(/create table public\.\w+/g) || []).length;
  const columns = (CODE.match(/add column \w+/g) || []).length;
  const constraints = [...CODE.matchAll(/add constraint (\w+)/g)].map(m => m[1]);
  const indexes = (CODE.match(/create index \w+/g) || []).length;
  const triggers = (CODE.match(/create trigger \w+/g) || []).length;
  const policies = (CODE.match(/create policy \w+/g) || []).length;
  assert.deepEqual({ tables, columns, constraints: constraints.length, indexes, triggers, policies },
    { tables: 2, columns: 9, constraints: 24, indexes: 1, triggers: 2, policies: 8 });
  assert.equal(tables + columns + constraints.length + indexes + triggers + policies, 46);
  const detection = CODE.slice(CODE.indexOf('select count(*) into olemassa'), CODE.indexOf('if olemassa = 46 then'));
  for (const name of constraints) assert.ok(detection.includes(`'${name}'`), `tunnistus ei laske rajoitetta ${name}`);
  assert.match(CODE, /if olemassa = 46 then/);
});

test('0013: esiehdot, transaktio, lukitusraja ja invarianttien todistus', () => {
  assert.match(CODE, /^\s*begin;/m);
  assert.match(CODE, /^commit;/m);
  assert.match(CODE, /set local lock_timeout = '5s';/);
  assert.match(CODE, /migraatio 0001 pitaa ajaa ensin/);
  assert.match(CODE, /migraatio 0012 pitaa ajaa ensin/);
  assert.match(CODE, /server_version_num/);
  assert.match(CODE, /time_entries_source_check puuttuu/);
  assert.match(CODE, /odotettiin 8 politiikkaa/);
  assert.match(CODE, /olemassa olevien taulujen politiikat muuttuivat/);
});

test('0013 ei muuta tuotannossa auki olevia tauluja eikä 0012:ta', () => {
  for (const table of ['tasks', 'goals', 'projects', 'routines']) {
    assert.equal(new RegExp(`alter table public\\.${table}\\b`).test(CODE), false, `${table} muuttuu`);
  }
  for (const marker of ['running_timers', 'operation_id', 'energy_budget', 'alignment_item_settings']) {
    assert.equal(M0012.includes(marker), false, `0012 sisältää 0013:n asian ${marker}`);
  }
  assert.match(M0012, /check \(source in \('manual'\)\)/, '0012:n alkuperäinen lähderajoite on ennallaan');
});

test('0013: peruutusohje ja riskit ovat mukana, eikä peruutus hukkaa kirjattua aikaa', () => {
  assert.match(MIGRATION, /ROLLBACK/);
  assert.match(MIGRATION, /drop table public\.alignment_item_settings;/);
  assert.match(MIGRATION, /drop table public\.running_timers;/);
  assert.match(MIGRATION, /update public\.time_entries set source = 'manual' where source = 'timer';/);
  assert.match(MIGRATION, /Kirjattu aika säilyy/);
  assert.match(MIGRATION, /TILA: EI AJETTU TUOTANTOON/);
});

test('verify_0013 on vain lukeva eikä lue käyttäjän sisältöä', () => {
  const code = VERIFY.split('\n').filter(line => !line.trim().startsWith('--')).join('\n').toLowerCase();
  // Merkkijonoliteraalit pois: oikeuksien NIMET ('UPDATE', 'DELETE') ovat dataa, eivät lauseita.
  assert.equal(/\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/.test(code.replace(/'[^']*'/g, "''")), false);
  for (const column of ['note', 'reflection', 'reflection_answers', 'snapshot', 'adjustments']) {
    assert.equal(new RegExp(`select[^;]*\\b${column}\\b`).test(code.replace(/'[^']*'/g, "''")), false, `lukee saraketta ${column}`);
  }
  assert.match(code, /unique \(user_id\)/i);
  assert.match(code, /'24'/);
});

// ================================================================ RLS (simuloitu)

function parsePolicies(code) {
  const policies = [];
  const pattern = /create policy (\w+) on public\.(\w+)\s+for (\w+) to (\w+)((?:\s+using \([^;]*?\))?)((?:\s+with check \([^;]*?\))?);/g;
  for (const m of code.matchAll(pattern)) {
    const using = /using \((.*)\)$/.exec(m[5].trim());
    const check = /with check \((.*)\)$/.exec(m[6].trim());
    policies.push({ table: m[2], cmd: m[3], role: m[4], using: using ? using[1] : null, check: check ? check[1] : null });
  }
  return policies;
}

function evaluate(expression, uid, row) {
  assert.equal(expression.replace(/\s+/g, ' ').trim(), 'auth.uid() = user_id', `tuntematon lauseke: ${expression}`);
  return uid === row.user_id;
}

function isolationProblems(policies) {
  const problems = [];
  for (const table of NEW_TABLES) {
    const rows = [{ id: 'a', user_id: USER_A }, { id: 'b', user_id: USER_B }];
    const of = cmd => policies.filter(p => p.table === table && p.role === 'authenticated' && p.cmd === cmd);
    const sees = row => of('select').some(p => p.using !== null && evaluate(p.using, USER_A, row));
    if (sees(rows[1])) problems.push(`${table}: A näkee B:n rivin`);
    if (!sees(rows[0])) problems.push(`${table}: A ei näe omaansa`);
    const inserts = row => of('insert').length > 0 && of('insert').some(p => p.check === null || evaluate(p.check, USER_A, row));
    if (inserts({ id: 'x', user_id: USER_B })) problems.push(`${table}: A lisää B:n nimiin (esim. ajastimen)`);
    const updates = (row, next) => of('update').some(p => (p.using === null || evaluate(p.using, USER_A, row))
      && (p.check !== null ? evaluate(p.check, USER_A, next) : (p.using === null || evaluate(p.using, USER_A, next))));
    if (updates(rows[1], { ...rows[1] })) problems.push(`${table}: A muokkaa B:n riviä`);
    if (updates(rows[0], { ...rows[0], user_id: USER_B })) problems.push(`${table}: A siirtää rivin B:lle`);
    const removes = row => of('delete').some(p => p.using === null || evaluate(p.using, USER_A, row));
    if (removes(rows[1])) problems.push(`${table}: A poistaa B:n rivin`);
  }
  return problems;
}

test('KRIITTINEN: ajastin ja kohdeasetukset — A ei lue, lisää, muokkaa, siirrä eikä poista B:n rivejä', () => {
  const policies = parsePolicies(CODE);
  assert.equal(policies.length, 8);
  assert.deepEqual(isolationProblems(policies), []);
});

test('MUTAATIO: rikottu politiikka havaitaan', () => {
  const mutations = [
    c => c.replace('create policy running_timers_select_own on public.running_timers\n  for select to authenticated using (auth.uid() = user_id);',
      'create policy running_timers_select_own on public.running_timers\n  for select to authenticated using (true);'),
    c => c.replace(/(create policy alignment_item_settings_insert_own on public\.alignment_item_settings\s+for insert to authenticated) with check \(auth\.uid\(\) = user_id\);/, '$1;'),
    c => c.replace(/(create policy running_timers_update_own[\s\S]*?using \(auth\.uid\(\) = user_id\))\s+with check \(auth\.uid\(\) = user_id\);/, '$1 with check (true);')
  ];
  for (const mutate of mutations) {
    const mutated = mutate(CODE);
    assert.notEqual(mutated, CODE, 'mutaatio ei osunut');
    let detected;
    try { detected = isolationProblems(parsePolicies(mutated)).length > 0; } catch { detected = true; }
    assert.ok(detected);
  }
});

// ================================================================ PORTIT JA REPOSITORIOT

test('portit kiinni: ajastin ja kohdeasetukset elävät muistissa, eivät kannassa', () => {
  assert.equal(TABLES.runningTimers, false);
  assert.equal(TABLES.alignmentItemSettings, false);
  assert.equal(ALIGNMENT_REALITY_FIELDS, false);
  assert.equal(runningTimersRepo.isPersistent(), false);
  assert.equal(alignmentItemSettingsRepo.isPersistent(), false);
  assert.ok(volatileAlignmentRealityFields().includes('timeEntry.operationId'));
});

test('KRIITTINEN: sarakeportti kiinni -> 0013:n sarakkeita ei lähetetä 0012:n tauluihin', () => {
  const entry = normalizeTimeEntry({
    id: 'e', entryDate: '2026-09-21', minutes: 30, source: 'timer', operationId: 'timer:x', projectId: 'p',
    routineId: 'r', occurrenceDate: '2026-09-21', startedAt: '2026-09-21T06:00:00Z', endedAt: '2026-09-21T06:30:00Z'
  });
  const row = timeEntriesRepo.mapping.toRow(entry);
  for (const column of ['project_id', 'routine_id', 'occurrence_date', 'operation_id', 'started_at', 'ended_at']) {
    assert.equal(Object.prototype.hasOwnProperty.call(row, column), false, column);
  }
  assert.equal(row.source, 'manual', '0012 sallii vain manual: ajastimen minuutit säilyvät, lähde odottaa 0013:a');
  const capacity = weeklyCapacitiesRepo.mapping.toRow(normalizeWeeklyCapacity({ id: 'c', weekStart: '2026-09-21', availableMinutes: 600, energyBudgetMinutes: 120 }));
  assert.equal('energy_budget_minutes' in capacity, false);
  const review = alignmentReviewsRepo.mapping.toRow(alignmentReviewsRepo.mapping.normalize({ id: 'r', weekStart: '2026-09-21', snapshot: { version: 2 } }));
  assert.equal('policy_version' in review, false);
  assert.equal('reflection_answers' in review, false);
});

test('repositoriot: palvelimen kentät eivät lähde, paluumuunnos palauttaa saman', () => {
  const timer = normalizeTimer({ id: 't', targetKind: 'task', taskId: 'k', startedAt: '2026-09-21T06:00:00Z', pausedSeconds: 60 });
  const timerRow = runningTimersRepo.mapping.toRow(timer);
  assert.equal('user_id' in timerRow, false);
  assert.deepEqual(runningTimersRepo.mapping.fromRow({ ...timerRow, user_id: USER_A }), { ...timer, createdAt: undefined ?? null, updatedAt: null });
  const settings = normalizeItemSettings({ id: 's', itemKind: 'task', itemId: 'k', energyDemand: 4, alignmentOptOut: true });
  const settingsRow = alignmentItemSettingsRepo.mapping.toRow(settings);
  assert.equal('user_id' in settingsRow, false);
  assert.deepEqual(alignmentItemSettingsRepo.mapping.fromRow(settingsRow), settings);
});

// ================================================================ ELINKAARI

test('elinkaari: jokainen käyttäjän repositorio on viennissä ja poistoinventaariossa', () => {
  const tables = new Set(Object.values(ACCOUNT_DATA_MAP).map(entry => entry.table));
  for (const repo of ALL_REPOSITORIES) {
    assert.ok(tables.has(repo.table), `${repo.table} puuttuu tilin poiston inventaariosta`);
    const name = Object.entries(ACCOUNT_DATA_MAP).find(([, entry]) => entry.table === repo.table)[0];
    assert.ok(EXPORTED_COLLECTIONS.includes(name), `${name} puuttuu viennistä`);
    assert.ok(ACCOUNT_DOMAIN_LABELS[name], `${name}: ei käyttäjälle näytettävää nimeä`);
  }
  assert.deepEqual(SHARED_MAP, ACCOUNT_DATA_MAP, 'Edge Functionin kopio on sama');
});

test('elinkaari: uusien taulujen rivit poistuvat käyttäjän mukana (kaskadi migraatiosta)', () => {
  for (const table of NEW_TABLES) {
    assert.match(createBlock(table), /references auth\.users\(id\) on delete cascade/);
  }
});

test('vienti: ajastin ja kohdeasetukset mukana ilman omistajatunnistetta; kuiva-ajo laskee ne', () => {
  const exported = buildUserDataExport({
    runningTimers: [{ id: 't', user_id: USER_A, startedAt: '2026-09-21T06:00:00Z' }],
    alignmentItemSettings: [{ id: 's', userId: USER_A, itemKind: 'task', itemId: 'k', energyDemand: 3 }]
  });
  assert.equal(exported.counts.runningTimers, 1);
  assert.equal(exported.counts.alignmentItemSettings, 1);
  assert.equal(JSON.stringify(exported).includes(USER_A), false);
  const dry = dryRunDeletion({ runningTimers: [{}], alignmentItemSettings: [{}, {}] });
  const counts = Object.fromEntries(dry.collections.map(c => [c.name, c.count]));
  assert.equal(counts.runningTimers, 1);
  assert.equal(counts.alignmentItemSettings, 2);
});

// ================================================================ TOTEUMAN LÄHTEET

test('lähteet: yksikään lähde ei kirjoita kapasiteettia', () => {
  for (const [name, source] of Object.entries(REALITY_SOURCES)) {
    assert.equal(source.writesCapacity, false, name);
  }
  assert.deepEqual(Object.entries(REALITY_SOURCES).filter(([, s]) => s.status === SOURCE_STATUS.IMPLEMENTED).map(([n]) => n).sort(),
    ['manual', 'timer']);
});

test('lähteet: aikakirjaus -> fakta lähteen, jakson, resurssin ja varmuuden kanssa', () => {
  const facts = timeEntryAdapter.toFacts([
    normalizeTimeEntry({ id: 'a', entryDate: '2026-09-21', minutes: 30, lifeAreaId: 'x' }),
    normalizeTimeEntry({ id: 'b', entryDate: '2026-09-21', minutes: 45, source: 'timer',
      startedAt: '2026-09-21T06:00:00Z', endedAt: '2026-09-21T06:45:00Z' })
  ]);
  assert.deepEqual(facts.map(f => [f.source, f.resource, f.quantity, f.confidence]),
    [['manual', 'time', 30, 'reported'], ['timer', 'time', 45, 'exact']]);
  assert.equal(facts[0].target.lifeAreaId, 'x');
  assert.equal(facts[1].period.from, '2026-09-21T06:00:00.000Z');
  assert.deepEqual(summarizeFacts(facts), { 'manual:time': 30, 'timer:time': 45 });
  assert.equal(realityFact({ source: 'timer', resource: 'money', quantity: 1, period: { date: '2026-09-21' } }), null,
    'lähde ei voi tuottaa resurssia, jota se ei tunne');
});

test('lähteet: tulevat lähteet ovat rajapintoja eivätkä teeskentele toimivansa', () => {
  for (const name of ['calendar', 'activity', 'finance', 'wellbeing']) {
    const adapter = futureAdapter(name);
    assert.equal(adapter.implemented, false);
    assert.deepEqual(adapter.toFacts([{ anything: true }]), []);
  }
  assert.throws(() => futureAdapter('manual'));
  assert.equal(moneyCapacityShape({ period: '2026-09', availableCents: 100000 }).source, 'finance');
  const imports = [...read('src/domain/realitySources.js').matchAll(/from '([^']+)'/g)];
  assert.equal(imports.length, 0, 'ei omaa taloustaulua eikä riippuvuutta Talouteen');
});

test('hyvinvointi: vain suostumuksella, vain ehdotus, ei koskaan kirjoitusta', () => {
  const entries = [{ energy: 2 }, { energy: 2 }, { energy: 1 }];
  const capacity = Object.freeze({ energyLevel: 4 });
  assert.equal(suggestEnergyFromWellbeing({ entries, capacity }), null, 'oletus: ei suostumusta');
  const suggestion = suggestEnergyFromWellbeing({ optIn: true, entries, capacity });
  assert.equal(suggestion.suggestedEnergyLevel, 2);
  assert.equal(suggestion.applies, false);
  assert.equal(capacity.energyLevel, 4, 'kapasiteetti ei muuttunut');
  assert.equal(suggestEnergyFromWellbeing({ optIn: true, entries: entries.slice(0, 2), capacity }), null, 'liian vähän aineistoa');
  const app = read('src/app/alignment.js') + read('src/app/timeTracking.js');
  assert.equal(app.includes('suggestEnergyFromWellbeing'), false, 'sovellus ei kytke hyvinvointia kapasiteettiin');
});
