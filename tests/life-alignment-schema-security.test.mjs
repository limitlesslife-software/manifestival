// Suunta: migraation 0012 turvamalli, rajoitteet ja repositoriot.
//
// REHELLINEN RAJAUS: testiympäristössä EI OLE PostgreSQL:ää. Politiikat
// todennetaan kahdella tavalla:
//
//   1. staattisesti migraation tekstistä (sama tapa kuin 0003–0011), ja
//   2. käyttäytymisenä: migraatiosta JÄSENNETYT politiikat ajetaan
//      kahden käyttäjän tekokantaa vasten. Tekokanta tuntee vain
//      lausekkeen `auth.uid() = user_id`; mikä tahansa muu lauseke
//      kaataa testin (fail closed), jotta muutettu politiikka ei voi
//      mennä läpi tulkitsemattomana.
//
// Mutaatiot todistavat, että testi huomaa rikkinäisen politiikan. Oikea
// RLS todennetaan vasta tuotannon kannassa: supabase/verify/verify_0012.sql.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { CATEGORY_KEYS } from '../src/domain/categories.js';
import { MAX_AREA_NAME_LENGTH, MAX_AREA_DESCRIPTION_LENGTH, MINUTES_PER_WEEK, MAX_SORT_ORDER }
  from '../src/domain/lifeArea.js';
import { MAX_NOTE_LENGTH } from '../src/domain/weeklyCapacity.js';
import { MAX_ENTRY_MINUTES, MAX_ENTRY_NOTE_LENGTH, TIME_SOURCES } from '../src/domain/timeEntry.js';
import { MAX_REFLECTION_LENGTH } from '../src/domain/alignmentReview.js';
import {
  lifeAreasRepo, weeklyCapacitiesRepo, timeEntriesRepo, alignmentReviewsRepo, goalsRepo,
  clearAllCollections
} from '../src/data/collectionsRepo.js';
import { TABLES, GOAL_LIFE_AREA_FIELD, volatileGoalAlignmentFields } from '../src/data/schema.js';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { normalizeGoal } from '../src/domain/goal.js';

const MIGRATION = read('supabase/migrations/0012_life_alignment.sql').replace(/\r\n/g, '\n');
const CODE = MIGRATION.split('\n').filter(line => !line.trim().startsWith('--')).join('\n').toLowerCase();
const TABLE_NAMES = ['life_areas', 'weekly_capacities', 'time_entries', 'alignment_reviews'];

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

// ============================================================ RAKENNE

test('jokainen uusi taulu: omistaja on tietokannan asettama, NOT NULL ja poistuu käyttäjän mukana', () => {
  for (const table of TABLE_NAMES) {
    const block = createBlock(table);
    assert.match(block, /user_id\s+uuid not null default auth\.uid\(\)\s+references auth\.users\(id\) on delete cascade/,
      `${table}: omistajasarake`);
    assert.match(block, /id\s+text primary key/, `${table}: pääavain`);
  }
});

test('jokainen uusi taulu: RLS päällä, neljä politiikkaa roolille authenticated, oikeudet nollattu', () => {
  for (const table of TABLE_NAMES) {
    assert.ok(CODE.includes(`alter table public.${table} enable row level security;`), `${table}: RLS`);
    for (const cmd of ['select', 'insert', 'update', 'delete']) {
      assert.ok(new RegExp(`create policy ${table}_${cmd}_own on public\\.${table}\\s+for ${cmd} to authenticated`).test(CODE),
        `${table}: ${cmd}-politiikka`);
    }
    for (const role of ['public', 'anon', 'authenticated']) {
      assert.ok(CODE.includes(`revoke all on public.${table} from ${role};`), `${table}: revoke ${role}`);
    }
    assert.ok(CODE.includes(`grant select, insert, update, delete on public.${table} to authenticated;`));
    assert.equal(new RegExp(`grant [^;]* on public\\.${table} to (anon|public)`).test(CODE), false);
  }
  assert.equal(/to anon\b/.test(CODE.replace(/revoke all on public\.\w+ from anon;/g, '')), false,
    'yksikään politiikka tai oikeus ei koske anonia');
});

test('viitteet ovat yhdistelmävierasavaimia ja poisto nollaa vain oman sarakkeensa', () => {
  const expected = {
    goals_life_area_fkey: ['life_area_id', 'life_areas'],
    time_entries_life_area_fkey: ['life_area_id', 'life_areas'],
    time_entries_goal_fkey: ['goal_id', 'goals'],
    time_entries_task_fkey: ['task_id', 'tasks']
  };
  for (const [name, [column, target]] of Object.entries(expected)) {
    const definition = constraint(name);
    assert.equal(definition,
      `foreign key (user_id, ${column}) references public.${target} (user_id, id) on delete set null (${column})`, name);
  }
  assert.equal(/on delete cascade/.test(CODE.replace(/references auth\.users\(id\) on delete cascade/g, '')), false,
    'yksikään sovellustaulujen välinen viite ei ole cascade');
});

test('olemassa oleva data: goals saa vain nullable sarakkeen ilman oletusta; ei täyttöä', () => {
  assert.ok(CODE.includes('alter table public.goals add column life_area_id text;'));
  for (const forbidden of ['update public.goals', 'update public.tasks', 'insert into public.goals',
    'delete from', 'alter table public.tasks', 'alter table public.routines', 'alter table public.projects',
    'drop constraint', 'not null default', 'truncate']) {
    const hits = CODE.split(forbidden).length - 1;
    // "not null default" esiintyy luonnostaan uusien taulujen user_id- ja aikaleimasarakkeissa.
    if (forbidden === 'not null default') continue;
    assert.equal(hits, 0, `migraatio sisältää: ${forbidden}`);
  }
  assert.equal(/life_area_id text not null|life_area_id text default/.test(CODE), false);
});

test('yksikäsitteisyys: alueen nimi ja kategoria, yksi kapasiteetti ja yksi katsaus viikkoa kohti — käyttäjäkohtaisesti', () => {
  assert.equal(constraint('life_areas_name_unique'), 'unique (user_id, name)');
  assert.equal(constraint('life_areas_category_unique'), 'unique (user_id, category_key)');
  assert.equal(constraint('weekly_capacities_week_unique'), 'unique (user_id, week_start)');
  assert.equal(constraint('alignment_reviews_week_unique'), 'unique (user_id, week_start)');
});

test('viikko alkaa maanantaina myös kannassa', () => {
  for (const name of ['weekly_capacities_week_start_check', 'alignment_reviews_week_start_check']) {
    assert.equal(constraint(name), 'check (extract(isodow from week_start) = 1)');
  }
});

// ============================================================ DOMAIN = KANTA

test('kannan rajat vastaavat domainin validointia', () => {
  assert.match(constraint('life_areas_name_check'), new RegExp(`length\\(name\\) <= ${MAX_AREA_NAME_LENGTH}`));
  assert.match(constraint('life_areas_description_check'), new RegExp(`<= ${MAX_AREA_DESCRIPTION_LENGTH}`));
  assert.equal(constraint('life_areas_importance_check'), 'check (importance between 1 and 5)');
  assert.match(constraint('life_areas_target_check'), new RegExp(`target_minutes_per_week <= ${MINUTES_PER_WEEK}`));
  assert.match(constraint('life_areas_sort_order_check'), new RegExp(`sort_order <= ${MAX_SORT_ORDER}`));
  assert.match(constraint('weekly_capacities_minutes_check'), new RegExp(`available_minutes <= ${MINUTES_PER_WEEK}`));
  assert.equal(constraint('weekly_capacities_energy_check'), 'check (energy_level is null or energy_level between 1 and 5)');
  assert.match(constraint('weekly_capacities_note_check'), new RegExp(`<= ${MAX_NOTE_LENGTH}`));
  assert.equal(constraint('time_entries_minutes_check'), `check (minutes > 0 and minutes <= ${MAX_ENTRY_MINUTES})`);
  assert.match(constraint('time_entries_note_check'), new RegExp(`<= ${MAX_ENTRY_NOTE_LENGTH}`));
  assert.match(constraint('alignment_reviews_reflection_check'), new RegExp(`<= ${MAX_REFLECTION_LENGTH}`));

  const sources = [...constraint('time_entries_source_check').matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(sources, [...TIME_SOURCES], 'toteuman lähteet');
  const categories = [...constraint('life_areas_category_check').matchAll(/'([^']+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(categories, [...CATEGORY_KEYS].sort(), 'kategoria-avaimet');
});

// ============================================================ POLITIIKKOJEN KÄYTTÄYTYMINEN

/** Jäsennä politiikat migraation tekstistä. */
function parsePolicies(code) {
  const policies = [];
  const pattern = /create policy (\w+) on public\.(\w+)\s+for (\w+) to (\w+)((?:\s+using \([^;]*?\))?)((?:\s+with check \([^;]*?\))?);/g;
  for (const m of code.matchAll(pattern)) {
    const using = /using \((.*)\)$/.exec(m[5].trim());
    const check = /with check \((.*)\)$/.exec(m[6].trim());
    policies.push({ name: m[1], table: m[2], cmd: m[3], role: m[4], using: using ? using[1] : null, check: check ? check[1] : null });
  }
  return policies;
}

/** Tunnettu lauseke tai testi kaatuu: tulkitsematon politiikka ei saa mennä läpi. */
function evaluate(expression, uid, row) {
  if (expression === null) return null;
  assert.equal(expression.replace(/\s+/g, ' ').trim(), 'auth.uid() = user_id',
    `tuntematon politiikkalauseke: ${expression}`);
  return uid === row.user_id;
}

/** Kahden käyttäjän tekokanta, joka noudattaa PostgreSQL:n RLS-sääntöjä yhdelle roolille. */
function simulator(policies) {
  const rows = new Map(TABLE_NAMES.map(t => [t, [
    { id: `${t}-a`, user_id: USER_A }, { id: `${t}-b`, user_id: USER_B }
  ]]));
  const forCmd = (table, cmd) => policies.filter(p => p.table === table && p.role === 'authenticated' && (p.cmd === cmd || p.cmd === 'all'));

  return {
    select(uid, table) {
      const ps = forCmd(table, 'select');
      return rows.get(table).filter(row => ps.some(p => evaluate(p.using, uid, row) !== false && p.using !== null));
    },
    insert(uid, table, row) {
      const ps = forCmd(table, 'insert');
      // INSERT: WITH CHECK ratkaisee. Ilman politiikkaa (tai ilman ehtoa) PostgreSQL päästäisi läpi.
      const allowed = ps.length > 0 && ps.some(p => p.check === null || evaluate(p.check, uid, row));
      if (allowed) rows.get(table).push(row);
      return allowed;
    },
    update(uid, table, id, changes) {
      const ps = forCmd(table, 'update');
      const target = rows.get(table).find(row => row.id === id);
      const visible = target && ps.some(p => p.using === null || evaluate(p.using, uid, target));
      if (!visible) return false;
      const next = { ...target, ...changes };
      // WITH CHECK uudelle riville; puuttuessa PostgreSQL käyttää USINGia.
      const ok = ps.some(p => (p.check !== null ? evaluate(p.check, uid, next) : (p.using === null || evaluate(p.using, uid, next))));
      if (ok) Object.assign(target, changes);
      return ok;
    },
    remove(uid, table, id) {
      const ps = forCmd(table, 'delete');
      const target = rows.get(table).find(row => row.id === id);
      const allowed = Boolean(target) && ps.some(p => p.using === null || evaluate(p.using, uid, target));
      if (allowed) rows.set(table, rows.get(table).filter(row => row.id !== id));
      return allowed;
    },
    count: table => rows.get(table).length
  };
}

function isolationProblems(policies) {
  const problems = [];
  const db = simulator(policies);
  for (const table of TABLE_NAMES) {
    const seen = db.select(USER_A, table).map(row => row.id);
    if (seen.includes(`${table}-b`)) problems.push(`${table}: A näkee B:n rivin`);
    if (!seen.includes(`${table}-a`)) problems.push(`${table}: A ei näe omaa riviään`);
    if (db.insert(USER_A, table, { id: `${table}-x`, user_id: USER_B })) problems.push(`${table}: A lisää B:n nimiin`);
    if (!db.insert(USER_A, table, { id: `${table}-own`, user_id: USER_A })) problems.push(`${table}: A ei voi lisätä omaa`);
    if (db.update(USER_A, table, `${table}-b`, { touched: true })) problems.push(`${table}: A muokkaa B:n riviä`);
    if (db.update(USER_A, table, `${table}-a`, { user_id: USER_B })) problems.push(`${table}: A siirtää rivin B:lle`);
    if (!db.update(USER_A, table, `${table}-a`, { touched: true })) problems.push(`${table}: A ei voi muokata omaa`);
    if (db.remove(USER_A, table, `${table}-b`)) problems.push(`${table}: A poistaa B:n rivin`);
  }
  return problems;
}

test('KRIITTINEN: käyttäjä A ei voi lukea, lisätä, muokata, siirtää eikä poistaa B:n rivejä (migraation politiikat)', () => {
  const policies = parsePolicies(CODE);
  assert.equal(policies.filter(p => TABLE_NAMES.includes(p.table)).length, 16);
  assert.deepEqual(isolationProblems(policies), []);
});

test('MUTAATIO: jokainen poistettu ehto havaitaan', () => {
  const mutations = [
    ['select ilman usingia', c => c.replace('create policy life_areas_select_own on public.life_areas\n  for select to authenticated using (auth.uid() = user_id);',
      'create policy life_areas_select_own on public.life_areas\n  for select to authenticated using (true);')],
    ['insert ilman with checkiä', c => c.replace('for insert to authenticated with check (auth.uid() = user_id);', 'for insert to authenticated;')],
    ['update ilman with checkiä', c => c.replace(/(create policy time_entries_update_own[\s\S]*?using \(auth\.uid\(\) = user_id\))\s+with check \(auth\.uid\(\) = user_id\);/, '$1 with check (true);')],
    ['delete ilman usingia', c => c.replace('create policy alignment_reviews_delete_own on public.alignment_reviews\n  for delete to authenticated using (auth.uid() = user_id);',
      'create policy alignment_reviews_delete_own on public.alignment_reviews\n  for delete to authenticated;')]
  ];
  for (const [name, mutate] of mutations) {
    const mutated = mutate(CODE);
    assert.notEqual(mutated, CODE, `mutaatio "${name}" ei osunut`);
    let detected = false;
    try {
      detected = isolationProblems(parsePolicies(mutated)).length > 0;
    } catch {
      detected = true; // tuntematon lauseke kaatuu: sekin on havaittu
    }
    assert.ok(detected, `mutaatiota "${name}" ei havaittu`);
  }
});

// ============================================================ REPOSITORIOT

test('portit ovat kiinni: Suunta ei kirjoita kantaan ennen migraatiota', () => {
  assert.equal(TABLES.lifeAreas, false);
  assert.equal(TABLES.weeklyCapacities, false);
  assert.equal(TABLES.timeEntries, false);
  assert.equal(TABLES.alignmentReviews, false);
  assert.equal(GOAL_LIFE_AREA_FIELD, false);
  assert.deepEqual(volatileGoalAlignmentFields(), ['lifeAreaId']);
  for (const repo of [lifeAreasRepo, weeklyCapacitiesRepo, timeEntriesRepo, alignmentReviewsRepo]) {
    assert.equal(repo.isPersistent(), false, repo.table);
  }
});

test('KRIITTINEN: tavoitteen tallennus ei lähetä life_area_id:tä ennen sarakeporttia (goals on tuotannossa auki)', () => {
  const row = goalsRepo.mapping.toRow(normalizeGoal({ id: 'g', title: 'T', lifeAreaId: 'a1' }));
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'life_area_id'), false);
  const source = read('src/data/collectionsRepo.js');
  assert.match(source, /\.\.\.\(GOAL_LIFE_AREA_FIELD \? \{ life_area_id: goal\.lifeAreaId \} : \{\}\)/);
  // Lukeminen on turvallista molemmissa tiloissa.
  assert.equal(goalsRepo.mapping.fromRow({ id: 'g', title: 'T', life_area_id: 'a1' }).lifeAreaId, 'a1');
  assert.equal(goalsRepo.mapping.fromRow({ id: 'g', title: 'T' }).lifeAreaId, null);
});

test('repositoriot: rivimuunnos ei lähetä palvelimen kenttiä ja paluumuunnos palauttaa saman', () => {
  const cases = [
    [lifeAreasRepo, { id: 'a', name: 'Perhe', importance: 5, targetMinutesPerWeek: 600, categoryKey: 'perhe', active: true, sortOrder: 1, description: 'Lapset' }],
    [weeklyCapacitiesRepo, { id: 'c', weekStart: '2026-09-14', availableMinutes: 1500, energyLevel: 3, note: null }],
    [timeEntriesRepo, { id: 't', entryDate: '2026-09-15', minutes: 45, lifeAreaId: 'a', goalId: null, taskId: 'x', note: 'n' }],
    [alignmentReviewsRepo, { id: 'r', weekStart: '2026-09-14', snapshotVersion: 1, snapshot: { version: 1 }, reflection: 'r', adjustments: ['x'] }]
  ];
  for (const [repo, input] of cases) {
    const normalized = repo.mapping.normalize(input);
    const row = repo.mapping.toRow(normalized);
    for (const forbidden of ['user_id', 'created_at', 'updated_at']) {
      assert.equal(Object.prototype.hasOwnProperty.call(row, forbidden), false, `${repo.table}: ${forbidden}`);
    }
    const back = repo.mapping.fromRow({ ...row, user_id: USER_A, created_at: 'x', updated_at: 'y' });
    for (const key of Object.keys(input)) {
      assert.deepEqual(back[key], normalized[key], `${repo.table}.${key}`);
    }
  }
});

beforeEach(() => {
  clearUser();
  setClient(null);
  clearAllCollections();
});

test('muistivarasto (portti kiinni): tieto elää istunnon ajan ja katoaa uloskirjautumisessa', async () => {
  setUser({ id: USER_A, email: 'a@example.com' });
  await lifeAreasRepo.insert({ id: 'a1', name: 'Perhe', importance: 5 });
  await timeEntriesRepo.insert({ id: 't1', entryDate: '2026-09-15', minutes: 30 });
  assert.equal((await lifeAreasRepo.list()).value.length, 1);
  clearAllCollections();
  assert.equal((await lifeAreasRepo.list()).value.length, 0, 'käyttäjän B ei pidä nähdä A:n alueita');
  assert.equal((await timeEntriesRepo.list()).value.length, 0);
});
