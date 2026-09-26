// 0010:n varmuuskopio- ja palautusdokumentti pitää paikkansa.
//
// Dokumentti, joka nimeää puuttuvan tiedoston tai vanhentuneen
// ROLLBACK-lauseen, ohjaa operaattoria väärin juuri silloin, kun tilanne
// on jo huono. Nämä testit vertaavat dokumentteja siihen, mitä
// repositoriossa oikeasti on (sama periaate kuin migrations.test.mjs:n
// palautusdokumenttitesteissä).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, read } from './helpers/sources.mjs';

const DOC = 'docs/activation/0010-BACKUP-AND-RECOVERY.md';
const lf = text => text.replace(/\r\n/g, '\n');
const doc = () => lf(read(DOC));

/**
 * Kommentoitu ROLLBACK-lohko sellaisena kuin se näkyy migraatiossa
 * (kuten tools/pg-rehearsal, mutta pelkkä `--` = tyhjä rivi).
 */
function extractRollback(sql) {
  const lines = lf(sql).split('\n');
  const start = lines.findIndex(l => /^-- ROLLBACK\s*$/.test(l));
  const out = [];
  let inside = false;
  for (const line of lines.slice(start + 1)) {
    const m = /^--   (.*)$/.exec(line);
    const body = m ? m[1] : (inside && line === '--' ? '' : null);
    if (!inside && body && /^begin;\s*$/.test(body.trim())) inside = true;
    if (inside && body !== null) out.push(body);
    if (inside && body && /^commit;\s*$/.test(body.trim())) break;
  }
  return out.join('\n');
}

/** Osio otsikosta seuraavaan saman tason otsikkoon. */
function section(text, heading) {
  const start = text.indexOf(heading);
  assert.ok(start >= 0, `otsikko puuttuu: ${heading}`);
  const level = /^#+/.exec(heading)[0];
  const rest = text.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n${level} `));
  return next === -1 ? rest : rest.slice(0, next);
}

/** Backtick-polut, joissa ei ole paikkamerkkiä. */
function repoPaths(text) {
  return [...text.matchAll(/`((?:supabase|docs|tools|tests|src)\/[\w./+-]+)`/g)].map(m => m[1])
    .filter(p => !/NN|\*|<|WAVE-X/.test(p));
}

function markdownLinks(text, fromFile) {
  return [...text.matchAll(/\]\(([^)#\s]+)\)/g)].map(m => m[1]).filter(h => !/^https?:/.test(h))
    .map(h => path.join(path.dirname(path.join(ROOT, fromFile)), h));
}

test('KRIITTINEN: 0010:n varmuuskopio- ja palautusdokumentti on olemassa', () => {
  assert.ok(fs.existsSync(path.join(ROOT, DOC)));
});

test('KRIITTINEN: jokainen dokumentin nimeämä tiedosto on olemassa', () => {
  const paths = repoPaths(doc());
  assert.ok(paths.length >= 15, `tiedostoviittauksia vain ${paths.length}`);
  for (const p of new Set(paths)) assert.ok(fs.existsSync(path.join(ROOT, p)), `puuttuu: ${p}`);
  for (const link of markdownLinks(doc(), DOC)) assert.ok(fs.existsSync(link), `rikkinäinen linkki: ${link}`);
});

test('KRIITTINEN: dokumentti sisältää 0010:n ROLLBACK-osion sellaisenaan', () => {
  const migration = read('supabase/migrations/0010_goal_to_action.sql');
  const rollback = extractRollback(migration);
  assert.ok(rollback.startsWith('begin;') && rollback.trimEnd().endsWith('commit;'));
  assert.ok(doc().includes('```sql\n' + rollback + '\n```'), 'ROLLBACK-lohko ei vastaa migraatiota');
  // Ja erikseen jokainen drop-lause (0010:ssä ei ole `if exists`).
  const drops = rollback.split('\n').filter(l => /^(alter table [^;]* drop [^;]*;|drop table [^;]*;)$/.test(l));
  assert.ok(drops.length >= 20, `drop-lauseita vain ${drops.length}`);
  for (const d of drops) assert.ok(doc().includes(d), `puuttuu: ${d}`);
});

test('KRIITTINEN: dokumentti nimeää tilannekuvat, työkalun, preflightin ja verifyn', () => {
  for (const name of ['snapshot_state_0009.sql', 'snapshot_state_0010.sql', 'restore-snapshot.mjs',
    'preflight_0010.sql', 'verify_0010.sql', 'build-snapshots.mjs', 'rehearse-backup.mjs']) {
    assert.ok(doc().includes(name), name);
  }
});

test('KRIITTINEN: osiot §0–§11, "Mitä EI tehdä" ja "Vain tuotannossa todennettavissa"', () => {
  const text = doc();
  for (let i = 0; i <= 11; i++) assert.match(text, new RegExp(`^## §${i} `, 'm'), `§${i} puuttuu`);
  assert.match(text, /^## §0 TL;DR$/m);
  assert.match(text, /^## §9 Mitä EI tehdä$/m);
  assert.match(text, /^### Vain tuotannossa todennettavissa$/m);
  assert.match(text, /Ensisijainen varmuuskopio = looginen tilannekuva \(suunnitelmasta\nriippumaton, todennettu paikallisesti\); Supabase-varmuuskopio\/PITR = lisä,\njos olemassa\./);
  for (const branch of ['A', 'B', 'C', 'D', 'E']) assert.match(text, new RegExp(`^### ${branch}\\. `, 'm'), `haara ${branch}`);
});

test('KRIITTINEN: kerrokset L1 pakollinen, L2 ja L3 valinnaisia', () => {
  const layers = section(doc(), '## §3 Kerrokset');
  assert.match(layers, /### L1 — looginen tilannekuva \(PAKOLLINEN\)/);
  assert.match(layers, /### L2 — Supabasen oma varmuuskopio \(VALINNAINEN\)/);
  assert.match(layers, /### L3 — pg_dump \/ `supabase db dump` \(VALINNAINEN\)/);
  assert.match(layers, /Organization → Billing/);
  assert.match(layers, /Database → Backups/);
  assert.match(layers, /PITR/);
});

test('KRIITTINEN: tuotannon kuivaharjoitus vaatii omistajan hyväksynnän', () => {
  const t2 = section(doc(), '### T-2 päivää: tuotannon kuivaharjoitus — VAATII OMISTAJAN HYVÄKSYNNÄN');
  assert.match(t2, /omistajan erillinen\s+hyväksyntä/);
  assert.match(t2, /lukkoja/);
  assert.match(t2, /rollback;/);
  assert.match(t2, /--dry-run/);
});

test('KRIITTINEN: virhe 0010:ssä = ei palautusta, ei ROLLBACKia (ja keskeytys perutaan kokonaan)', () => {
  const s6 = section(doc(), '## §6 Jos 0010 päättyy virheeseen');
  assert.match(s6, /\*\*Keskeytynyt ajo perutaan kokonaan\.\*\*/);
  assert.match(s6, /\*\*Älä palauta\.\*\*/);
  assert.match(s6, /\*\*Älä aja ROLLBACK-osiota\.\*\*/);
  assert.match(s6, /`preflight_0010\.sql`:n rivi 09/);
  assert.match(s6, /`verify_0010\.sql`:n rivi 20/);
  assert.match(s6, /rivi 14 = \*\*0\*\*/);
  assert.match(s6, /JO AJETTU/);
  assert.match(s6, /CASE B2/);
  // Väärä väite, jota ei saa toistaa: keskeytynyt ajo EI jätä taulua ilman rajoitetta.
  assert.equal(/keskeytynyt ajo jättäisi/i.test(doc()), false);
});

test('KRIITTINEN: G -> F -revertin maintenance-sivuvaikutus ja sen hoito on kerrottu', () => {
  const c = section(doc(), '### C. Aalto G deployattu, sitten sovellusvirhe');
  assert.match(c, /snapshot_state_0010\.sql/);
  assert.match(c, /rivi 44/);
  assert.match(c, /`maintenance`[\s\S]*`active`/);
  assert.match(c, /--tables=goals --dry-run/);
  assert.match(section(doc(), '## §9 Mitä EI tehdä'), /aaltoon F tekemättä ensin §7 C:n kohtia 1 ja 2/);
});

test('KRIITTINEN: vain tuotannossa todennettavat asiat on lueteltu', () => {
  const only = section(doc(), '### Vain tuotannossa todennettavissa');
  assert.match(only, /viennin tarkkuus suurelle tekstisolulle/);
  assert.match(only, /`postgres`-roolin oikeudet/);
  assert.match(only, /disable trigger user/);
  assert.match(only, /suunnitelma, varmuuskopiot ja PITR/);
});

test('harjoittelun lukutaulukko on sisäisesti johdonmukainen', () => {
  const local = section(doc(), '### Todennettu paikallisesti');
  const rows = [...local.matchAll(/^\| B(\d+) \|[^\n]*\| (\d+)\/(\d+) \|$/gm)];
  assert.deepEqual(rows.map(r => Number(r[1])), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  const pass = rows.reduce((n, r) => n + Number(r[2]), 0);
  const total = rows.reduce((n, r) => n + Number(r[3]), 0);
  assert.match(local, new RegExp(`\\*\\*${pass}/${total} PASS\\.\\*\\*`));
});

test('KRIITTINEN: tietosuoja: ignoroitu hakemisto, ei jakamista', () => {
  const text = doc();
  assert.match(text, /`\.local-backups\/db\/<UTC>_state_0009\/`/);
  assert.match(text, /`\.gitignore` ignoroi `\/\.local-backups\/`/);
  assert.match(text, /\*\*koskaan\s+ylikirjoita\*\*/);
  assert.match(text, /`compare\.sql` sisältää vain rivien tunnisteet ja tiivisteet/);
});

// ---------------------------------------------------------------------
// Linkit muista dokumenteista
// ---------------------------------------------------------------------

test('KRIITTINEN: WAVE-G.md §6 kertoo maintenance-varauksen ja linkittää dokumenttiin', () => {
  const g = lf(read('docs/acceptance/WAVE-G.md'));
  const s6 = section(g, '## 6. Peruutus');
  assert.ok(s6.includes('docs/activation/0010-BACKUP-AND-RECOVERY.md'));
  assert.match(s6, /`maintenance`/);
  assert.match(s6, /snapshot_state_0010\.sql/);
  assert.match(s6, /--tables=goals/);
  for (const link of markdownLinks(s6, 'docs/acceptance/WAVE-G.md')) assert.ok(fs.existsSync(link), link);
  // Paketti ei silti ohjaa poistamaan rivejä SQL:llä (release-waves.test.mjs).
  assert.equal(/delete from|drop table|truncate/i.test(g), false);
});

test('KRIITTINEN: PRODUCTION-PREFLIGHT.md P14 ohjaa loogiseen tilannekuvaan', () => {
  const p = lf(read('docs/PRODUCTION-PREFLIGHT.md'));
  const p14 = section(p, '### P14 — Tuore varmuuskopio');
  assert.ok(p14.includes('docs/activation/0010-BACKUP-AND-RECOVERY.md'));
  assert.match(p14, /snapshot_state_00NN\.sql/);
  for (const link of markdownLinks(p14, 'docs/PRODUCTION-PREFLIGHT.md')) assert.ok(fs.existsSync(link), link);
});

test('KRIITTINEN: supabase/README.md on ajan tasalla ja sen viittaukset ovat olemassa', () => {
  const readme = lf(read('supabase/README.md'));
  assert.equal(/Yksikään migraatio ei ole ajettu/.test(readme), false, 'väittää, ettei mitään ole ajettu');
  assert.match(readme, /migraatiot 0001–0008 on ajettu tuotantoon/);
  assert.match(readme, /`backup\/snapshot_state_00NN\.sql`/);
  assert.ok(readme.includes('docs/activation/0010-BACKUP-AND-RECOVERY.md'));
  assert.equal(/1\. Ota varmuuskopio \(Database -> Backups\)/.test(readme), false, 'vanha pyynnöstä-oletus');
  for (const link of markdownLinks(readme, 'supabase/README.md')) assert.ok(fs.existsSync(link), link);
  // Hakemiston sisäiset polut (suhteessa supabase/) ja repon polut.
  const relative = [...readme.matchAll(/`((?:inventory\.sql|acceptance\/|functions\/|preflight\/|verify\/|backup\/|migrations\/)[\w./-]*)`/g)]
    .map(m => m[1]).filter(p => !/NN|\*|<|…/.test(p));
  assert.ok(relative.length >= 3, `suhteellisia polkuja vain ${relative.length}`);
  for (const p of relative) assert.ok(fs.existsSync(path.join(ROOT, 'supabase', p)), `puuttuu: supabase/${p}`);
  for (const p of repoPaths(readme)) assert.ok(fs.existsSync(path.join(ROOT, p)), `puuttuu: ${p}`);
});
