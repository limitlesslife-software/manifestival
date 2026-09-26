// Hyväksyntäpolitiikka (omistajan päätös 2026-09-26): koneellinen
// AUTOMATED_TECHNICAL_ACCEPTANCE on junan portti, käsin tehtävä selain- ja
// laitehyväksyntä on LIVE_USE_VALIDATION_PENDING eikä koskaan PASS.
//
// Vartioi moduulia tools/activation/acceptance-policy.mjs ja sitä, että
// dokumentit (politiikka, nopea polku, GO/NO-GO, WAVE-X.md) kertovat saman.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, read } from './helpers/sources.mjs';
import {
  FAST_ACTIVATION_DOC, LIVE_USE_VALIDATION, POLICY_DOC, TECHNICAL_REQUIREMENTS, candidateTestsOf, gateKind,
  ownerMessageFor, parseTestSummary, technicalAcceptanceOf, testSummaryGreen
} from '../tools/activation/acceptance-policy.mjs';
import { pushLineDocs } from '../tools/activation/train-map.mjs';
import { acceptanceEntry, shaOf, testOutput, testsEntry } from './helpers/activation-history.mjs';

const lf = text => text.replace(/\r\n/g, '\n');
const flat = text => lf(text).replace(/\s+/g, ' ');
const TRAIN = ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
const lock = JSON.parse(read('docs/activation/release-train-c-j.json'));

// ------------------------------------------------------------------ moduuli

test('omistajan viestit: "hyväksyn D", "hyväksyn E", "hyväksyn 0009/F" … "hyväksyn 0013/J"', () => {
  assert.deepEqual(['D', 'E', 'F', 'G', 'H', 'I', 'J'].map(ownerMessageFor),
    ['hyväksyn D', 'hyväksyn E', 'hyväksyn 0009/F', 'hyväksyn 0010/G', 'hyväksyn 0011/H', 'hyväksyn 0012/I', 'hyväksyn 0013/J']);
  assert.equal(ownerMessageFor('BASE'), null);
});

test('porttilajit: vain migraatio- ja deployhyväksyntä ovat omistajan hyväksyntöjä', () => {
  assert.equal(gateKind('OWNER_DEPLOY_APPROVAL_REQUIRED'), 'OWNER_APPROVAL');
  assert.equal(gateKind('OWNER_PRODUCTION_MIGRATION_APPROVAL_REQUIRED'), 'OWNER_APPROVAL');
  assert.equal(gateKind('OWNER_READ_ONLY_SQL_REQUIRED'), 'OWNER_INPUT');
  assert.equal(gateKind('TECHNICAL_ACCEPTANCE_REQUIRED'), 'TECHNICAL');
  assert.equal(gateKind('CANDIDATE_TESTS_REQUIRED'), 'TECHNICAL');
});

test('KRIITTINEN: node --test -yhteenveto: spec ja TAP; vain vihreä kelpaa; puuttuva yhteenveto = null', () => {
  const spec = parseTestSummary(testOutput({ pass: 1596 }));
  assert.equal(spec.tests, 1596);
  assert.equal(spec.fail, 0);
  assert.equal(testSummaryGreen(spec), true);
  const tap = parseTestSummary('ok 1 - a\n# tests 3\n# pass 2\n# fail 1\n# cancelled 0\n');
  assert.deepEqual([tap.tests, tap.pass, tap.fail], [3, 2, 1]);
  assert.equal(testSummaryGreen(tap), false);
  assert.equal(testSummaryGreen(parseTestSummary(testOutput({ pass: 10, cancelled: 1 }))), false);
  assert.equal(parseTestSummary('kaikki hyvin'), null);
  assert.equal(parseTestSummary('ℹ pass 5\n'), null, 'ilman tests/fail-rivejä ei arvata');
  // Testin nimessä oleva "pass 99" ei ole yhteenveto.
  assert.equal(parseTestSummary('✔ pass 99 kertaa\nℹ tests 1\nℹ pass 1\nℹ fail 0\n').pass, 1);
});

test('KRIITTINEN: tekninen hyväksyntä vain täsmälleen samalle aallolle ja SHA:lle; testiajo vain vihreänä', () => {
  const entries = [
    { type: 'acceptance', wave: 'C', sha: shaOf('C') },
    acceptanceEntry('C', 'cc'.repeat(20)),
    { ...acceptanceEntry('C'), result: 'VERIFY_LIVE_FAILED' }
  ];
  assert.equal(technicalAcceptanceOf(entries, { wave: 'C', sha: shaOf('C') }), null);
  const ok = [...entries, acceptanceEntry('C')];
  assert.equal(technicalAcceptanceOf(ok, { wave: 'C', sha: shaOf('C') }).type, 'technical-acceptance');
  const deploy = { type: 'deploy', wave: 'D', sha: shaOf('D'), result: 'AUTOMATED_TECHNICAL_ACCEPTANCE' };
  assert.equal(technicalAcceptanceOf([deploy], { wave: 'D', sha: shaOf('D') }), deploy);
  assert.equal(candidateTestsOf([testsEntry('D', shaOf('D'), { fail: 1 })], { wave: 'D', sha: shaOf('D') }).ok, false);
  assert.equal(candidateTestsOf([testsEntry('D')], { wave: 'D', sha: shaOf('D') }).ok, true);
  assert.equal(candidateTestsOf([testsEntry('D')], { wave: 'D', sha: shaOf('E') }).ok, false);
});

test('käyttötodennuksen lista kattaa C–J, ja jokainen dokumentti on olemassa', () => {
  assert.deepEqual(Object.keys(LIVE_USE_VALIDATION), TRAIN);
  for (const [wave, { doc, items }] of Object.entries(LIVE_USE_VALIDATION)) {
    assert.ok(fs.existsSync(path.join(ROOT, doc)), `${wave}: ${doc}`);
    assert.ok(items.length > 0, wave);
    for (const item of items) assert.equal(/\bPASS\b/.test(item), false, `${wave}: "${item}"`);
  }
  assert.deepEqual(TECHNICAL_REQUIREMENTS.map(r => r.id),
    ['ancestry', 'migrationPrerequisite', 'candidateTests', 'security', 'repoPreflight', 'migrationVerify', 'liveAssets', 'cacheAndGates']);
});

// --------------------------------------------------------------- dokumentit

test('KRIITTINEN: politiikkadokumentti: korvaa selainportin, omistajan hyväksynnät ja jokaisen aallon taulukko', () => {
  const doc = lf(read(POLICY_DOC));
  const f = flat(doc);
  assert.match(f, /korvaa aiemman aaltokohtaisen selainhyväksyntäportin/);
  for (const needed of ['jokainen tuotantomigraatio 0009–0013', 'jokainen tuotantodeploy D–J', 'T-2-varmuuskopion kuivaharjoitus',
    'AI-selityksen käyttöönotto', 'versionCode-politiikka']) {
    assert.ok(f.includes(needed), `omistajan hyväksyntä puuttuu: ${needed}`);
  }
  for (const r of TECHNICAL_REQUIREMENTS) assert.ok(doc.includes(`(\`${r.id}\`)`), `ehto puuttuu: ${r.id}`);
  assert.match(doc, /\.claude\/activation\/journal\.jsonl/);
  for (const wave of TRAIN) {
    const start = doc.indexOf(`### Aalto ${wave} `);
    assert.ok(start !== -1, `aallon ${wave} osio puuttuu`);
    const next = doc.indexOf('\n### ', start + 1);
    const section = doc.slice(start, next === -1 ? doc.indexOf('\n## ', start) : next);
    assert.match(section, /\| AUTOMATED PASS \|/, `${wave}: AUTOMATED PASS -rivi`);
    assert.match(section, /\| LIVE USE VALIDATION PENDING \|.*ei estä, ei PASS \|/, `${wave}: LIVE USE -rivi`);
    const own = wave === 'C' ? 'WAVE-C.md' : `WAVE-${wave}.md`;
    assert.ok(section.includes(`../acceptance/${own}`), `${wave}: linkki pakettiin`);
    if (wave !== 'C') assert.ok(section.includes(`"${ownerMessageFor(wave)}"`), `${wave}: omistajan viesti`);
  }
  assert.match(doc, /### Aalto G[\s\S]*snapshot_state_0009\.sql[\s\S]*restore-snapshot\.mjs check/);
  assert.match(doc, /### Aalto J[\s\S]*vasta kun `verify_0013` = 0 ja J on tuotannossa/);
});

test('KRIITTINEN: jokainen WAVE-C..J.md linkittää politiikkaan ja merkitsee selainosion LIVE_USE_VALIDATION_PENDING:ksi', () => {
  for (const wave of TRAIN) {
    const doc = lf(read(`docs/acceptance/WAVE-${wave}.md`));
    assert.ok(doc.includes('(../activation/AUTOMATED-ACCEPTANCE-POLICY.md)'), `WAVE-${wave}.md: linkki politiikkaan`);
    const s4 = doc.slice(doc.indexOf('## 4. Selainhyväksyntä'));
    assert.match(s4.slice(0, 600), /LIVE_USE_VALIDATION_PENDING/, `WAVE-${wave}.md kohta 4`);
    assert.match(flat(s4.slice(0, 600)), /ei estä junaa/, `WAVE-${wave}.md kohta 4`);
  }
  assert.ok(read('docs/acceptance/WAVE-C-OWNER-ACCEPTANCE.md').includes('LIVE_USE_VALIDATION_PENDING'));
  for (const wave of ['C', 'D']) {
    const gate = lf(read(`docs/acceptance/WAVE-${wave}.md`)).split('Portti seuraavaan aaltoon')[1];
    assert.equal(/Selainhyväksyntä läpi/.test(gate.split('Käyttötodennus')[0]), false, `WAVE-${wave}.md: selainhyväksyntä yhä portti`);
  }
});

test('KRIITTINEN: GO/NO-GO: uusi politiikka, askel 1 odottaa DEPLOY D:tä, linkit ja rivi G', () => {
  const doc = lf(read('docs/SUUNTA-ACTIVATION-GO-NOGO.md'));
  const f = flat(doc);
  assert.ok(doc.includes('(activation/AUTOMATED-ACCEPTANCE-POLICY.md)'));
  assert.ok(doc.includes('(SUUNTA-FAST-ACTIVATION.md)'));
  const rowG = doc.split('\n').find(l => l.startsWith('| **G** v20 |'));
  assert.ok(rowG.includes('(activation/0010-BACKUP-AND-RECOVERY.md)'), 'rivi G ei linkitä varmuuskopio-ohjeeseen');
  assert.match(f, /Odotettu: `NEXT_ACTION: DEPLOY D` — \*\*ei\*\* migraatio 0009/);
  assert.equal(/Odotettu: \*GO, seuraava migraatio 0009\*/.test(doc), false, 'vanha odotus (migraatio 0009) jäi');
  assert.equal(/Hyväksyntä ~10 min|5 min UI|UI-hyväksyntä\./.test(doc), false, 'käsin tehtävä UI-hyväksyntä on yhä askel');
  assert.match(f, /\| LIVE_USE_VALIDATION_PENDING \| .*ei estä junaa, ei koskaan PASS/);
  for (const msg of ['hyväksyn D', 'hyväksyn E', 'hyväksyn 0009/F', 'hyväksyn 0010/G', 'hyväksyn 0011/H', 'hyväksyn 0012/I', 'hyväksyn 0013/J']) {
    assert.ok(doc.includes(`"${msg}"`), msg);
  }
  assert.equal(/--accepted=/.test(doc), false, 'poistettu --accepted-lippu dokumentissa');
});

test('KRIITTINEN: nopea polku: jokainen askel C–J ja APK, omistajan viesti, TILA/KOMENTO/ODOTUS/STOP JOS/SEURAAVA', () => {
  const doc = lf(read(FAST_ACTIVATION_DOC));
  const steps = ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'APK'];
  let last = -1;
  for (const step of steps) {
    const start = doc.indexOf(`\n## Askel ${step} `);
    assert.ok(start > last, `askel ${step} puuttuu tai väärässä järjestyksessä`);
    last = start;
    const next = doc.indexOf('\n## Askel ', start + 1);
    const section = doc.slice(start, next === -1 ? undefined : next);
    for (const key of ['**TILA:**', '**KOMENTO', '**ODOTUS:**', '**STOP JOS:**', '**SEURAAVA:**']) {
      assert.ok(section.includes(key), `askel ${step}: ${key}`);
    }
    if (!['C', 'APK'].includes(step)) assert.ok(section.includes(`**OMISTAJAN VIESTI:** **"${ownerMessageFor(step)}"**`), `askel ${step}: omistajan viesti`);
    const meta = { F: '0009', G: '0010', H: '0011', I: '0012', J: '0013' }[step];
    if (meta) {
      for (const file of [`supabase/preflight/preflight_${meta}.sql`, `supabase/verify/verify_${meta}.sql`]) {
        assert.ok(section.includes(`git show ${lock.sqlSource.sha}:${file}`), `askel ${step}: ${file} lukon lähteestä`);
      }
      assert.match(section, /score-sql-result\.mjs/, `askel ${step}: Claude pisteyttää`);
    }
  }
  const g = doc.slice(doc.indexOf('\n## Askel G '), doc.indexOf('\n## Askel H '));
  assert.ok(g.indexOf('snapshot_state_0009.sql') !== -1 && g.indexOf('snapshot_state_0009.sql') < g.indexOf('"hyväksyn 0010/G" → aja'),
    'tilannekuva ennen 0010:n ajoa');
  assert.match(g, /restore-snapshot\.mjs check <vienti> --save/);
  const apk = doc.slice(doc.indexOf('\n## Askel APK '));
  assert.match(flat(apk), /`verify_0013` ≠ 0 tai J ei ole tuotannossa: \*\*älä asenna\*\*/);
  assert.ok(doc.includes(`SQL-lähde (lukon sqlSource): \`${lock.sqlSource.ref}\` @ \`${lock.sqlSource.sha}\``));
});

test('KRIITTINEN: nopean polun SHA:t ovat lukon SHA:t (--sync-docs pitää ne ajan tasalla)', () => {
  assert.ok(pushLineDocs(lock).some(d => d.file === FAST_ACTIVATION_DOC), 'sync-docs ei kata nopeaa polkua');
  const doc = read(FAST_ACTIVATION_DOC);
  const known = new Set([...lock.waves.map(w => w.deployTarget), lock.sqlSource.sha]);
  const shas = [...doc.matchAll(/\b[0-9a-f]{40}\b/g)].map(m => m[0]);
  assert.ok(shas.length >= 20, `SHA:ita vain ${shas.length}`);
  for (const sha of shas) assert.ok(known.has(sha), `${sha} ei ole lukossa`);
  for (const w of lock.waves.filter(x => x.wave !== 'C')) {
    const line = doc.split(/\r?\n/).find(l => l.includes(`# ${w.wave} v`) && /approved-sha=|# STOP/.test(l));
    assert.ok(line, `aallon ${w.wave} deploy-riviä ei löydy`);
    if (w.missingPatches.length) assert.match(line, new RegExp(`^# STOP ${w.wave} — TRAIN_RECUT_REQUIRED`));
    else assert.ok(line.includes(`--approved-sha=${w.deployTarget}`), `${w.wave}: ${line}`);
  }
});
