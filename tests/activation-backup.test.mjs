// Looginen tilannekuva ja palautus ennen 0010:tä (ja 0009–0013).
//
// Oikean kannan todiste on tools/pg-rehearsal/rehearse-backup.mjs
// (B1–B14 jokaiselle 0009–0013 molemmilla lähtötiloilla). Nämä testit
// vartioivat ilman kantaa sen, mikä voi rikkoutua koodissa:
//
//   1. generoidut tilannekuvatiedostot ovat ajan tasalla ja vain lukevia,
//      yksilauseisia ja auth-skeemasta vain olemassaolo/lukumäärä
//   2. jäsennys hylkää katkenneen, muokatun ja repeytyneen kuvan
//      (tests/fixtures/backup/state-0009.json on harjoittelun tuottama:
//      node tools/pg-rehearsal/rehearse-backup.mjs --fixtures=tests/fixtures/backup)
//   3. palautusskripti noudattaa jokaista sääntöä, jonka harjoittelu
//      osoitti välttämättömäksi (raaka teksti, liipaisimet, kaksivaiheisuus,
//      itsetarkistus, rollback kuivaharjoituksessa)
//   4. tulokset menevät vain git-ignoroituun polkuun eikä mitään
//      ylikirjoiteta

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { ROOT, read } from './helpers/sources.mjs';
import { buildSnapshotFile, snapshotPath } from '../tools/activation/build-snapshots.mjs';
import {
  SNAPSHOT_STATES, OWNER, md5, parseExport, parseSnapshot, splitJsonArray, buildRestoreSql,
  buildCompareSql, restorePlan, rowDigests, describeSnapshot, defaultOutputDir, tablesAtState
} from '../tools/activation/snapshot-core.mjs';

const lf = text => text.replace(/\r\n/g, '\n');
const FIXTURE = 'tests/fixtures/backup/state-0009.json';
const fixtureRows = () => JSON.parse(read(FIXTURE));
const snap0009 = () => parseSnapshot(fixtureRows());
const CLI = path.join(ROOT, 'tools/activation/restore-snapshot.mjs');
const USER_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

/** Koodi ilman kommentteja ja merkkijonoliteraaleja (sama kuin activation-inventory.test.mjs). */
function code(sql) {
  return sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .replace(/\$q\$[\s\S]*?\$q\$/g, "''").replace(/'[^']*'/g, "''").toLowerCase();
}

/** Palautusskripti ilman upotettuja tilannekuvia (aineistossa itsessään on $mv0$). */
const withoutPayload = sql => sql.replace(/(\$mv\d+\$)[\s\S]*?\1/g, "''");

/** Kirjoita manifesti uudelleen niin, että tiivisteet täsmäävät (kuin PostgreSQL). */
function rewrite(rows, mutate) {
  const copy = rows.map(r => ({ ...r }));
  const head = copy.find(r => r.nro === '00');
  const manifest = JSON.parse(head.sisalto);
  mutate(copy, manifest);
  head.sisalto = JSON.stringify(manifest);
  head.tiiviste = md5(head.sisalto);
  return copy;
}

function migrationTables(state) {
  const dir = path.join(ROOT, 'supabase/migrations');
  const out = ['tasks', 'profile'];
  for (const name of fs.readdirSync(dir).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()) {
    if (name.slice(0, 4) > state) continue;
    for (const m of lf(fs.readFileSync(path.join(dir, name), 'utf8')).matchAll(/^create table public\.(\w+)/gm)) out.push(m[1]);
  }
  return out;
}

// ---------------------------------------------------------------------
// 1. Generoidut tilannekuvatiedostot
// ---------------------------------------------------------------------

test('KRIITTINEN: tilannekuvatiedostot 0008–0013 ovat ajan tasalla generaattorin kanssa', () => {
  assert.deepEqual([...SNAPSHOT_STATES], ['0008', '0009', '0010', '0011', '0012', '0013']);
  for (const state of SNAPSHOT_STATES) {
    assert.equal(lf(read(snapshotPath(state))), buildSnapshotFile(state),
      `${snapshotPath(state)}: aja node tools/activation/build-snapshots.mjs`);
  }
});

test('KRIITTINEN: tilannekuvat ovat vain lukevia ja yksilauseisia', () => {
  for (const state of SNAPSHOT_STATES) {
    const c = code(read(snapshotPath(state)));
    assert.equal(/\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|comment|lock|vacuum|call|do|set)\b/.test(c),
      false, `${state}: kirjoittava lause`);
    assert.equal(c.trim().replace(/;\s*$/, '').includes(';'), false, `${state}: useampi lause`);
    // query_to_xml on VOLATILE: dynaaminen luku voisi repeytyä.
    assert.equal(/query_to_xml|execute|format\(/.test(c), false, `${state}: dynaaminen luku`);
  }
});

test('KRIITTINEN: taululista = tasks, profile + migraatioiden <= NN create table', () => {
  for (const state of SNAPSHOT_STATES) {
    const expected = migrationTables(state);
    const sql = read(snapshotPath(state));
    const read_ = [...sql.matchAll(/^\s+from public\.(\w+) x$/gm)].map(m => m[1]);
    assert.deepEqual([...read_].sort(), [...expected].sort(), `${state}: luettavat taulut`);
    assert.match(sql, new RegExp(`-- Taulut \\(${expected.length}\\):`));
  }
  const t0009 = migrationTables('0009');
  assert.equal(t0009.length, 14);
  for (const t of ['goals', 'projects', 'tasks', 'profile', 'routines', 'routine_exceptions', 'bills']) {
    assert.ok(t0009.includes(t), `snapshot_state_0009 ei sisällä taulua ${t}`);
    assert.match(read(snapshotPath('0009')), new RegExp(`from public\\.${t} x\\b`));
  }
  assert.equal(/public\.milestones/.test(read(snapshotPath('0009'))), false, '0009 ei saa lukea 0010:n taulua');
  assert.match(read(snapshotPath('0010')), /from public\.milestones x/);
  assert.equal(migrationTables('0013').length, 26);
  assert.deepEqual(tablesAtState('0009', [{ name: '0010_x', sql: 'create table public.later (id text);' },
    { name: '0003_y', sql: 'create table public.early (id text);' }]), ['tasks', 'profile', 'early']);
});

test('KRIITTINEN: auth-skeemasta vain omistajan olemassaolo ja käyttäjien lukumäärä', () => {
  for (const state of SNAPSHOT_STATES) {
    const sql = read(snapshotPath(state));
    assert.equal(/\b(email|encrypted_password|raw_\w+|phone|confirmation_token)\b/i.test(sql), false, state);
    const uses = [...code(sql).matchAll(/[^\n]*auth\.users[^\n]*/g)].map(m => m[0].trim());
    assert.equal(uses.length, 2, `${state}: ${uses.join(' | ')}`);
    assert.ok(uses.some(u => /exists \(select 1 from auth\.users u where u\.id = ''::uuid\)/.test(u)), state);
    assert.ok(uses.some(u => /\(select count\(\*\) from auth\.users\)/.test(u)), state);
    assert.equal(/auth\.(?!users\b)\w+/.test(code(sql)), false, `${state}: muu auth-taulu`);
  }
});

test('tilannekuvan tiedoston otsikko kertoo tilan, ajankohdan ja tietosuojan', () => {
  const s9 = read(snapshotPath('0009'));
  assert.match(s9, /TILALLE 0009/);
  assert.match(s9, /ENNEN migraatiota 0010/);
  const s10 = read(snapshotPath('0010'));
  assert.match(s10, /0010:n JÄLKEEN/);
  assert.match(s10, /ennen aallon G revertiä/);
  for (const state of SNAPSHOT_STATES) {
    const s = read(snapshotPath(state));
    assert.match(s, /SISÄLTÄÄ HENKILÖTIETOJA/);
    assert.match(s, /restore-snapshot\.mjs check/);
    assert.match(s, /\.local-backups\/db\//);
  }
});

// ---------------------------------------------------------------------
// 2. Jäsennys ja todennus
// ---------------------------------------------------------------------

test('KRIITTINEN: harjoittelun tuottama tilannekuva (tila 0009) kelpaa', () => {
  const snap = snap0009();
  assert.equal(snap.manifest.format, 'mv-snapshot-v1');
  assert.equal(snap.manifest.state, '0009');
  assert.equal(snap.manifest.owner, OWNER);
  assert.equal(snap.manifest.ownerPresent, true);
  assert.equal(Object.keys(snap.manifest.tables).length, 14);
  assert.deepEqual(snap.users, [OWNER, USER_B].sort());
  // numeric-mittakaava säilyy raakatekstissä.
  assert.ok(snap.raw.profile.includes('"weight_kg": 82.40'), 'profile.weight_kg 82.40 puuttuu raakatekstistä');
  assert.equal(JSON.stringify(JSON.parse(snap.raw.profile)).includes('82.40'), false,
    'kontrolli: JSON-kierros pudottaa mittakaavan — siksi raaka teksti upotetaan');
  for (const [t, m] of Object.entries(snap.manifest.tables)) {
    assert.equal(md5(snap.raw[t]), m.md5, t);
    assert.equal(snap.elements[t].length, Number(m.rows), t);
    assert.equal('[' + snap.elements[t].join(', ') + ']', snap.raw[t], t);
  }
  assert.deepEqual(snap.warnings, []);
});

test('KRIITTINEN: katkennut solu hylätään (tiiviste)', () => {
  const rows = fixtureRows().map(r => (r.taulu === 'tasks' ? { ...r, sisalto: r.sisalto.slice(0, -40) } : r));
  assert.throws(() => parseSnapshot(rows), /tasks: tiiviste ei täsmää/);
});

test('KRIITTINEN: muokattu manifesti hylätään (MANIFEST)', () => {
  const tasksMd5 = snap0009().manifest.tables.tasks.md5;
  const rows = fixtureRows().map(r => (r.nro === '00' ? { ...r, sisalto: r.sisalto.replace(tasksMd5, '0'.repeat(32)) } : r));
  assert.ok(rows[0].sisalto !== fixtureRows()[0].sisalto, 'manifestin muokkaus ei osunut');
  assert.throws(() => parseSnapshot(rows), /MANIFEST/);
});

test('KRIITTINEN: itsessään eheä mutta repeytynyt kuva hylätään (repeytynyt)', () => {
  // goals-rivi poistettu, kaikki tiivisteet laskettu uudelleen: vain
  // viite-eheys paljastaa, että tehtävät viittaavat puuttuvaan tavoitteeseen.
  const rows = rewrite(fixtureRows(), (copy, manifest) => {
    const g = copy.find(r => r.taulu === 'goals');
    const kept = splitJsonArray(g.sisalto).filter(e => JSON.parse(e).id !== 'p-goal');
    g.sisalto = '[' + kept.join(', ') + ']';
    g.tiiviste = md5(g.sisalto);
    g.rivit = String(kept.length);
    Object.assign(manifest.tables.goals, { md5: g.tiiviste, rows: kept.length, bytes: Buffer.byteLength(g.sisalto) });
  });
  assert.throws(() => parseSnapshot(rows), /repeytynyt/);
});

test('puuttuva omistaja, puuttuva payload-rivi ja tuntematon muoto hylätään', () => {
  assert.throws(() => parseSnapshot(rewrite(fixtureRows(), (_, m) => { m.ownerPresent = false; })), /omistajaa ei löytynyt/);
  assert.throws(() => parseSnapshot(fixtureRows().filter(r => r.taulu !== 'bills')), /bills: payload-rivejä 0/);
  assert.throws(() => parseSnapshot(rewrite(fixtureRows(), (_, m) => { m.format = 'x'; })), /tuntematon muoto/);
  assert.throws(() => parseSnapshot(fixtureRows().filter(r => r.nro !== '00')), /MANIFEST-rivi 00 puuttuu/);
});

test('kanta myöhemmässä tilassa kuin tiedosto: varoitus', () => {
  const rows = rewrite(fixtureRows(), (_, m) => { m.publicTables = [...m.publicTables, 'milestones']; });
  const snap = parseSnapshot(rows);
  assert.equal(snap.warnings.length, 1);
  assert.match(snap.warnings[0], /milestones/);
});

test('KRIITTINEN: CSV-, sarkain- ja JSON-vienti antavat saman tavu tavulta', () => {
  const rows = fixtureRows();
  const cols = ['nro', 'taulu', 'rivit', 'tiiviste', 'sisalto'];
  const q = v => (v === null ? '' : `"${String(v).replace(/"/g, '""')}"`);
  const csv = '﻿' + [cols.join(','), ...rows.map(r => cols.map(k => q(r[k])).join(','))].join('\r\n') + '\r\n';
  const tsv = [cols.join('\t'), ...rows.map(r => cols.map(k => r[k] ?? '').join('\t'))].join('\n');
  const reference = snap0009();
  for (const text of [csv, tsv, JSON.stringify(rows)]) {
    const snap = parseSnapshot(parseExport(text));
    assert.equal(snap.manifestMd5, reference.manifestMd5);
    for (const t of Object.keys(reference.raw)) assert.equal(snap.raw[t], reference.raw[t], t);
  }
  assert.throws(() => parseExport(csv.slice(0, csv.length / 2)), /katkennut|kenttää/);
  assert.throws(() => parseExport(''), /tyhjä/);
});

test('jsonb-taulukon alkiojako ei jäsennä lukuja eikä hämäänny merkkijonoista', () => {
  assert.deepEqual(splitJsonArray('[]'), []);
  const raw = '[{"a": "}, {\\"x\\": [1, 2]}", "n": 82.40}, {"b": [1, {"c": "]"}]}]';
  assert.deepEqual(splitJsonArray(raw), ['{"a": "}, {\\"x\\": [1, 2]}", "n": 82.40}', '{"b": [1, {"c": "]"}]}']);
  assert.throws(() => splitJsonArray('[{"a":1},{"b":2}]'), /alkiojako/);
});

// ---------------------------------------------------------------------
// 3. Palautusskripti (BK-05)
// ---------------------------------------------------------------------

test('KRIITTINEN: palautus upottaa todennetun raakatekstin sellaisenaan (82.40 säilyy)', () => {
  const snap = snap0009();
  const sql = buildRestoreSql(snap);
  for (const t of Object.keys(snap.raw)) assert.ok(sql.includes(snap.raw[t]), `${t}: raaka teksti puuttuu`);
  assert.ok(sql.includes('"weight_kg": 82.40'));
  // Dollarilainausmerkki ei esiinny aineistossa (aineistossa on $mv0$).
  assert.ok(Object.values(snap.raw).some(r => r.includes('$mv0$')), 'aineistossa pitäisi olla $mv0$');
  const tag = /jsonb_populate_recordset\(null::public\.\w+, (\$mv\d+\$)/.exec(sql)[1];
  assert.notEqual(tag, '$mv0$');
  for (const r of Object.values(snap.raw)) assert.equal(r.includes(tag), false);
  for (const t of Object.keys(snap.raw)) {
    assert.match(sql, new RegExp(`create temp table mv_r_${t} on commit drop as\\n  select \\* from jsonb_populate_recordset\\(null::public\\.${t}, \\${tag.slice(0, -1)}\\$`));
  }
});

test('KRIITTINEN: palautus on yksi transaktio suojineen', () => {
  const snap = snap0009();
  const sql = buildRestoreSql(snap);
  const firstCode = sql.split('\n').find(l => l.trim() && !l.startsWith('--'));
  assert.equal(firstCode, 'begin;');
  assert.match(sql, /\nset local lock_timeout = '5s';\n/);
  assert.match(sql, /\nset local timezone = '[^']+';\n/);
  assert.ok(sql.includes(`from auth.users where id = '${OWNER}'::uuid`), 'omistajasuoja');
  assert.match(sql, /VÄÄRÄ PROJEKTI/);
  assert.match(sql, /käyttäjää puuttuu auth\.users-taulusta/);
  assert.match(sql, /VÄÄRÄ KANTA/);
  assert.match(sql, /format_type\(a\.atttypid, a\.atttypmod\) = v\.ty/);
  assert.match(sql, /Skeema ei vastaa tilannekuvaa/);
  assert.match(sql, /Liipaisimet eivät vastaa tilannekuvaa/);
  assert.match(sql, /ei omista tauluja/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  // Jokainen sarake tyyppeineen on suojassa.
  for (const [t, m] of Object.entries(snap.manifest.tables)) {
    for (const [name, type] of m.cols) assert.ok(sql.includes(`('${t}', '${name}', '${type}')`), `${t}.${name}`);
  }
  // Suojat ennen ensimmäistä muutosta.
  const code_ = withoutPayload(sql);
  assert.ok(code_.indexOf('end $mv_guard$;') < code_.search(/\n(update|insert|delete|alter) /));
  assert.ok(sql.trimEnd().endsWith('commit;'));
  assert.equal(/\brollback;/.test(code(withoutPayload(sql))), false);
});

test('KRIITTINEN: lopputarkistus kattaa jokaisen taulun tiivisteen ja rivimäärän', () => {
  const snap = snap0009();
  const sql = buildRestoreSql(snap);
  const verify = /do \$mv_verify\$([\s\S]*?)end \$mv_verify\$;/.exec(sql)[1];
  for (const [t, m] of Object.entries(snap.manifest.tables)) {
    assert.ok(verify.includes(`'${m.md5}'`), `${t}: tiiviste puuttuu tarkistuksesta`);
    assert.ok(verify.includes(`PALAUTUS EI TÄSMÄÄ: ${t} (rivejä % / ${m.rows},`), `${t}: rivimäärä`);
  }
  const code_ = withoutPayload(sql);
  assert.ok(code_.indexOf('do $mv_verify$') > code_.lastIndexOf('\nupdate '), 'tarkistus viimeisen muutoksen jälkeen');
  assert.ok(code_.indexOf('do $mv_verify$') < code_.indexOf('\ncommit;'), 'tarkistus ennen committia');
});

test('KRIITTINEN: liipaisimet pois ja takaisin tasapainossa', () => {
  const snap = snap0009();
  const sql = buildRestoreSql(snap);
  const withTriggers = Object.entries(snap.manifest.tables).filter(([, m]) => m.triggers.length).map(([t]) => t);
  assert.ok(withTriggers.includes('tasks') && withTriggers.includes('goals'));
  const off = [...sql.matchAll(/^alter table public\.(\w+) disable trigger user;$/gm)].map(m => m[1]);
  const on = [...sql.matchAll(/^alter table public\.(\w+) enable trigger user;$/gm)].map(m => m[1]);
  assert.deepEqual(off.sort(), [...withTriggers].sort());
  assert.deepEqual(on.sort(), [...withTriggers].sort());
  assert.ok(sql.indexOf('enable trigger user') > sql.indexOf('end $mv_verify$;'));
});

test('KRIITTINEN: ei drop- eikä truncate-lausetta; delete vain --prune -valinnalla', () => {
  const snap = snap0009();
  const plain = code(withoutPayload(buildRestoreSql(snap)));
  const pruned = code(withoutPayload(buildRestoreSql(snap, { prune: true })));
  // Ainoa sallittu "drop" on väliaikaisen taulun `on commit drop`.
  for (const c of [plain, pruned]) {
    assert.equal(/\b(drop|truncate)\b/.test(c.replace(/ on commit drop as\n/g, ' as\n')), false);
    assert.equal([...c.matchAll(/ on commit drop as\n/g)].length, 14);
  }
  assert.equal(/\bdelete\b/.test(plain), false);
  assert.equal([...pruned.matchAll(/^delete from public\.(\w+) x where not exists/gm)].length, 14);
  // Karsinnassa lapset ennen vanhempia.
  const order = [...pruned.matchAll(/^delete from public\.(\w+)/gm)].map(m => m[1]);
  assert.ok(order.indexOf('routine_exceptions') < order.indexOf('routines'));
  assert.match(buildRestoreSql(snap, { prune: true }), /karsinnan jälkeen % riviä/);
});

test('KRIITTINEN: kuivaharjoitus on sama skripti, joka päättyy rollback;iin', () => {
  const snap = snap0009();
  const real = buildRestoreSql(snap);
  const dry = buildRestoreSql(snap, { dryRun: true });
  assert.ok(dry.trimEnd().endsWith('rollback;'));
  assert.equal(/\bcommit;/.test(dry), false);
  const body = s => s.split('\n').filter(l => !l.startsWith('--')).join('\n').replace(/(commit|rollback);\n$/, '');
  assert.equal(body(dry), body(real));
});

test('KRIITTINEN: kaksivaiheinen järjestys kehäviittauksille', () => {
  const snap = snap0009();
  const { info, order } = restorePlan(snap.manifest, Object.keys(snap.manifest.tables).sort());
  assert.deepEqual([...info.goals.deferred].sort(), ['parent_goal_id', 'project_id']);
  assert.deepEqual([...info.projects.deferred], ['goal_id']);
  assert.ok(info.tasks.deferred.has('goal_id') && info.tasks.deferred.has('project_id'));
  assert.ok(order.indexOf('routines') < order.indexOf('routine_exceptions'), 'NOT NULL -viite ensin');
  const sql = buildRestoreSql(snap);
  const insertGoals = /insert into public\.goals \(([^)]*)\)\n  select ([^\n]*)/.exec(sql);
  const cols = insertGoals[1].split(', ');
  const vals = insertGoals[2].split(', ');
  assert.equal(vals[cols.indexOf('"project_id"')], 'null');
  assert.equal(vals[cols.indexOf('"parent_goal_id"')], 'null');
  assert.match(sql, /update public\.goals x set ("parent_goal_id" = r\."parent_goal_id", "project_id" = r\."project_id"|"project_id" = r\."project_id", "parent_goal_id" = r\."parent_goal_id")\n/);
  assert.ok(sql.indexOf('-- Vaihe 2') < sql.indexOf('update public.goals x set "p'));
});

test('--tables rajaa palautuksen ja tuntematon taulu hylätään', () => {
  const snap = snap0009();
  const sql = buildRestoreSql(snap, { tables: ['goals'] });
  assert.deepEqual([...sql.matchAll(/^create temp table mv_r_(\w+)/gm)].map(m => m[1]), ['goals']);
  assert.ok(sql.includes(snap.raw.goals));
  assert.equal(sql.includes(snap.raw.tasks), false);
  assert.throws(() => buildRestoreSql(snap, { tables: ['milestones'] }), /ei ole tilannekuvassa/);
});

// ---------------------------------------------------------------------
// compare.sql
// ---------------------------------------------------------------------

test('KRIITTINEN: compare.sql on vain lukeva ja yksilauseinen', () => {
  const sql = buildCompareSql(snap0009());
  const c = code(sql);
  assert.equal(/\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|comment|lock|vacuum|call|do|set)\b/.test(c), false);
  assert.equal(c.trim().replace(/;\s*$/, '').includes(';'), false);
  for (const status of ['SAMA', 'UUTTA', 'MUUTTUNUT', 'EI VERTAILTAVISSA']) assert.ok(sql.includes(status), status);
});

test('KRIITTINEN: compare.sql ei sisällä sisältöä — vain tunnisteet ja rivitiivisteet', () => {
  const snap = snap0009();
  const sql = buildCompareSql(snap);
  const contentKeys = ['title', 'note', 'description', 'name', 'payee', 'iban', 'reference', 'category'];
  let checked = 0;
  for (const rows of Object.values(snap.data)) {
    for (const row of rows) {
      for (const k of contentKeys) {
        if (typeof row[k] === 'string' && row[k].length >= 4) {
          checked += 1;
          assert.equal(sql.includes(row[k]), false, `sisältöä vertailussa: ${k}`);
        }
      }
    }
  }
  assert.ok(checked > 40, `tarkistettuja arvoja vain ${checked}`);
  assert.equal(sql.includes('82.40'), false);
  for (const t of Object.keys(snap.raw)) {
    for (const d of rowDigests(snap, t)) assert.ok(sql.includes(`('${d.id}', '${d.md5}')`), `${t}.${d.id}`);
  }
});

test('rivitiiviste lasketaan raakatekstistä, ei uudelleen sarjallistetusta', () => {
  const snap = snap0009();
  const profile = rowDigests(snap, 'profile').find(d => d.id === OWNER);
  const element = snap.elements.profile.find(e => e.includes(OWNER) && e.includes('82.40'));
  assert.equal(profile.md5, md5(element));
});

test('check-yhteenveto: preflight_0010:n rivit 11, 12, 13 ja 18 sekä oletushakemisto', () => {
  const snap = snap0009();
  const text = describeSnapshot(snap);
  assert.match(text, /TILANNEKUVA KUNNOSSA/);
  assert.match(text, new RegExp(`rivi 11  goals\\s+= ${snap.manifest.tables.goals.rows}`));
  assert.match(text, new RegExp(`rivi 12  projects\\s+= ${snap.manifest.tables.projects.rows}`));
  assert.match(text, new RegExp(`rivi 13  profile\\s+= ${snap.manifest.tables.profile.rows}`));
  assert.match(text, new RegExp(`rivi 18  tasks\\s+= ${snap.manifest.tables.tasks.rows}`));
  assert.equal(/Synteettinen|82\.40/.test(text), false, 'yhteenveto ei tulosta sisältöä');
  assert.match(defaultOutputDir(snap.manifest), /^\.local-backups\/db\/\d{8}T\d{6}Z_state_0009$/);
});

// ---------------------------------------------------------------------
// 4. Tietosuoja: vain git-ignoroituun polkuun, ei ylikirjoitusta (BK-07)
// ---------------------------------------------------------------------

test('KRIITTINEN: .gitignore ignoroi .local-backups/-hakemiston', () => {
  assert.ok(lf(read('.gitignore')).split('\n').includes('/.local-backups/'));
});

const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
const hasGit = spawnSync('git', ['-C', ROOT, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).status === 0;

function tempOut() {
  const rel = `.local-backups/.unit-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return { rel, abs: path.join(ROOT, rel), cleanup: () => fs.rmSync(path.join(ROOT, rel), { recursive: true, force: true }) };
}

test('CLI check: hyväksyy aineiston eikä tulosta sisältöä', { skip: !hasGit && 'git puuttuu' }, () => {
  const r = cli('check', FIXTURE);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /TILANNEKUVA KUNNOSSA/);
  assert.match(r.stdout, /rivi 18  tasks/);
  assert.equal(/Synteettinen|82\.40|Paino/.test(r.stdout + r.stderr), false);
});

test('KRIITTINEN: CLI kieltäytyy versionhallitusta tulospolusta', { skip: !hasGit && 'git puuttuu' }, () => {
  const before = fs.readdirSync(path.join(ROOT, 'docs/activation')).sort();
  const r = cli('restore', FIXTURE, '--dry-run', '--out=docs/activation');
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /ei ole git-ignoroitu/);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'docs/activation')).sort(), before);
  const outside = cli('compare', FIXTURE, `--out=${path.join(path.dirname(ROOT), 'mv-backup-outside')}`);
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /projektin sisällä/);
});

test('KRIITTINEN: CLI ei koskaan ylikirjoita', { skip: !hasGit && 'git puuttuu' }, () => {
  const out = tempOut();
  try {
    fs.mkdirSync(out.abs, { recursive: true });
    fs.writeFileSync(path.join(out.abs, 'compare.sql'), 'alkuperäinen');
    const r = cli('compare', FIXTURE, `--out=${out.rel}`);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /on jo olemassa/);
    assert.equal(fs.readFileSync(path.join(out.abs, 'compare.sql'), 'utf8'), 'alkuperäinen');
  } finally { out.cleanup(); }
});

test('CLI kirjoittaa ignoroituun hakemistoon: check --save, compare, restore --dry-run', { skip: !hasGit && 'git puuttuu' }, () => {
  const out = tempOut();
  try {
    let r = cli('check', FIXTURE, '--save', `--out=${out.rel}`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(out.abs, 'vienti.json'), 'utf8'), read(FIXTURE));
    assert.match(fs.readFileSync(path.join(out.abs, 'check.txt'), 'utf8'), /MANIFEST md5/);
    r = cli('check', FIXTURE, '--save', `--out=${out.rel}`);
    assert.equal(r.status, 2, 'toinen arkistointi samaan hakemistoon ei saa ylikirjoittaa');
    r = cli('compare', FIXTURE, `--out=${out.rel}`);
    assert.equal(r.status, 0, r.stderr);
    r = cli('restore', FIXTURE, '--dry-run', '--prune', `--out=${out.rel}`);
    assert.equal(r.status, 0, r.stderr);
    const dry = fs.readFileSync(path.join(out.abs, 'restore.prune.dry-run.sql'), 'utf8');
    assert.ok(dry.trimEnd().endsWith('rollback;'));
    r = cli('restore', FIXTURE, '--tables=goals,projects', `--out=${out.rel}`);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(out.abs, 'restore.goals+projects.sql')));
    assert.equal(/Synteettinen|82\.40/.test(r.stdout), false);
  } finally { out.cleanup(); }
});

test('CLI hylkää katkenneen viennin koodilla 1', { skip: !hasGit && 'git puuttuu' }, () => {
  const out = tempOut();
  try {
    fs.mkdirSync(out.abs, { recursive: true });
    const rows = fixtureRows().map(r => (r.taulu === 'goals' ? { ...r, sisalto: r.sisalto.slice(0, -5) } : r));
    const file = path.join(out.abs, 'katkennut.json');
    fs.writeFileSync(file, JSON.stringify(rows));
    const r = cli('restore', file, `--out=${out.rel}`);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /TILANNEKUVA HYLÄTTY/);
    assert.match(r.stderr, /goals: tiiviste ei täsmää/);
    assert.equal(fs.existsSync(path.join(out.abs, 'restore.sql')), false);
  } finally { out.cleanup(); }
});
