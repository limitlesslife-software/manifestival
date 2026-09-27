// Julkaisujunan C–K kartta (docs/activation/release-train-c-j.json; nimi on
// historiallinen, lukko kattaa aallot C–K).
//
// Kartta generoidaan gitistä (tools/activation/train-map.mjs), joka lukee
// jokaisen aallon oman sw.js:n ja schema.js:n. Tämä testi ei tarvitse
// paikallisia ehdokashaaroja: se vartioi, että tallennettu kartta on
// sisäisesti johdonmukainen ja vastaa waves.mjs:n suunnitelmaa.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ROOT, read } from './helpers/sources.mjs';
import { cacheVersionOf, cumulativeGates, WAVE_IDS } from '../tools/release/waves.mjs';
import { versionNumber } from '../tools/release/lineage.mjs';
import { createGit } from '../tools/release/git-layer.mjs';
import {
  REQUIRED_PATCHES, SQL_SOURCE_WAVE, TRAIN, buildTrainMap, checkTrainMap, pushLineDocs, sqlSourceFiles, syncDoc
} from '../tools/activation/train-map.mjs';
import {
  deployLinesIn, goNoGoTableRows, pushLineProblems, pushLinesIn, sqlSourceProblems, stopLinesIn, syncPushLines,
  syncTableDeployTargets, waveShaArgProblems
} from '../tools/activation/push-lines.mjs';
import { shaOf, stubGit } from './helpers/activation-history.mjs';

const map = JSON.parse(read('docs/activation/release-train-c-j.json'));
const SHA40 = /^[0-9a-f]{40}$/;
const realGit = createGit({ cwd: ROOT });
const refsPresent = () => TRAIN.every(e => realGit.revParse(e.ref));

test('kartta kattaa aallot C–K järjestyksessä; K on viimeinen', () => {
  assert.deepEqual(map.waves.map(w => w.wave), ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']);
  for (const w of map.waves) assert.ok(WAVE_IDS.includes(w.wave));
  // Lukon viimeinen aalto on julkaisuaaltojen viimeinen: yhtäkään
  // julkaisuaaltoa ei ole jätetty lukitsematta junan loppuun.
  assert.equal(map.waves.at(-1).wave, WAVE_IDS.at(-1));
});

test('KRIITTINEN: välimuistiversio nousee joka aallossa eikä törmää', () => {
  const versions = map.waves.map(w => versionNumber(w.cacheVersion));
  for (let i = 1; i < versions.length; i++) {
    assert.ok(versions[i] > versions[i - 1], `${map.waves[i].wave}: ${map.waves[i].cacheVersion} ei ole edellistä suurempi`);
  }
  assert.equal(new Set(versions).size, versions.length);
  for (const w of map.waves) assert.equal(w.cacheVersion, cacheVersionOf(w.wave), w.wave);
});

test('KRIITTINEN: jokaisen aallon porttimatriisi ratkeaa täsmälleen siihen aaltoon', () => {
  for (const w of map.waves) {
    assert.equal(w.gateMatrixResolvesTo, w.wave, `${w.wave}: matriisi ratkeaa aaltoon ${w.gateMatrixResolvesTo}`);
    assert.deepEqual(w.gatesCumulative, [...cumulativeGates(w.wave)]);
  }
});

test('KRIITTINEN: sarakeportit aukeavat vasta omassa aallossaan', () => {
  for (const w of map.waves) {
    for (const [gate, g] of Object.entries(w.columnGates)) {
      assert.equal(g.actual, g.expected, `${w.wave}: ${gate} on ${g.actual ? 'auki' : 'kiinni'}`);
    }
  }
});

test('KRIITTINEN: jokainen aalto on edellisen jälkeläinen (ei ohituksia)', () => {
  for (const w of map.waves.slice(1)) {
    assert.equal(w.descendsFromParent, true, `${w.wave} ei ole aallon ${w.parentWave} jälkeläinen`);
    assert.equal(w.rollbackTarget, w.parentWave);
  }
});

test('migraatioaalloilla on esitarkistus, varmistus ja aaltocommit', () => {
  for (const w of map.waves.filter(x => x.migration)) {
    assert.ok(read(w.preflight), `${w.wave}: ${w.preflight}`);
    assert.ok(read(w.verify), `${w.wave}: ${w.verify}`);
    assert.match(w.waveCommit || '', /^[0-9a-f]{40}$/, `${w.wave}: aaltocommit puuttuu`);
  }
  assert.deepEqual(map.waves.filter(x => x.migration).map(w => w.migration.slice(0, 4)),
    ['0009', '0010', '0011', '0012', '0013', '0014']);
});

test('kaikki kartan aallot on merkitty johdonmukaisiksi generoitaessa', () => {
  for (const w of map.waves) assert.equal(w.consistent, true, w.wave);
});

// =====================================================================
// ACT-04: LUKKO — jokainen aalto täyteen SHA:han, ei liikkuvaa viitettä
// =====================================================================

test('KRIITTINEN: jokainen lukittu deployTarget on 40-merkkinen SHA eikä tilaa tallenneta', () => {
  for (const w of map.waves) {
    assert.match(w.deployTarget, SHA40, `${w.wave}: ${w.deployTarget}`);
    assert.equal('status' in w, false, `${w.wave}: staattinen status vanhenee joka askeleesta`);
    assert.ok(Array.isArray(w.missingPatches), `${w.wave}: missingPatches puuttuu`);
  }
  assert.equal(map.lockVersion, 2);
  assert.ok(map.production && 'sha' in map.production, 'tuotanto ei ole erillinen kenttä');
  assert.equal('originMain' in map, false);
});

test('KRIITTINEN: TRAIN ei kiinnitä yhtäkään aaltoa liikkuvaan origin/mainiin; C:n alias on sen SHA', () => {
  for (const entry of TRAIN) {
    assert.equal(/^origin\//.test(entry.ref), false, `${entry.wave}: ${entry.ref}`);
    assert.notEqual(entry.ref, 'HEAD');
    assert.equal('status' in entry, false);
  }
  assert.match(TRAIN.find(e => e.wave === 'C').ref, SHA40);
  assert.deepEqual(TRAIN.map(e => e.wave), map.waves.map(w => w.wave));
  for (const entry of TRAIN) assert.equal(map.waves.find(w => w.wave === entry.wave).ref, entry.ref, entry.wave);
});

test('SQL-lähde on lukittu: K:n deployTarget ja jokaisen tiedoston sha256 (0009–0014)', () => {
  const k = map.waves.find(w => w.wave === 'K');
  assert.equal(SQL_SOURCE_WAVE, 'K');
  assert.equal(map.sqlSource.wave, 'K');
  assert.equal(map.sqlSource.ref, k.ref);
  assert.equal(map.sqlSource.sha, k.deployTarget);
  assert.equal(Object.keys(map.sqlSource.files).length, 18);
  for (const n of ['0009', '0010', '0011', '0012', '0013', '0014']) {
    for (const file of [`supabase/preflight/preflight_${n}.sql`, `supabase/verify/verify_${n}.sql`]) {
      assert.ok(file in map.sqlSource.files, `${file} puuttuu lukon SQL-lähteestä`);
    }
  }
  for (const [file, digest] of Object.entries(map.sqlSource.files)) {
    assert.match(digest, /^[0-9a-f]{64}$/, file);
    assert.ok(read(file), `${file} puuttuu tuotehaarasta`);
  }
});

/**
 * 0009–0013:n tiivisteet lukossa ENNEN kuin lähde siirtyi J:stä K:hon
 * (lukko 2026-09-26, lähde J v2 cba9463). Lähteen siirto ei saa muuttaa
 * jo harjoiteltujen ja osin tuotantoon ajettujen (0009) tiedostojen tavuja.
 */
const SQL_0009_0013_AT_J = Object.freeze({
  'supabase/migrations/0009_finance_2.sql': '7a7d605de64616711ac0f63676c1822821dadfe9a10f6ebd31196cac0c61bd8c',
  'supabase/preflight/preflight_0009.sql': 'be1eb6092a43690bd707f315f88f052ea432087733430bab4709a935444c214c',
  'supabase/verify/verify_0009.sql': '6dfbffab31b9f7b0b905c5dbe54087b7c7caf2daea4df7069b1a05dc05909163',
  'supabase/migrations/0010_goal_to_action.sql': 'a718bfe2c172dddf5bce8671a29d24262588b8cb90d63209cdaea740a652b7af',
  'supabase/preflight/preflight_0010.sql': '859a10fdc5799d3f3dcb9fcea0cf242901504082e5b40f4890931b939743e984',
  'supabase/verify/verify_0010.sql': 'dd097adccb7696dff1d34b876989b7faaf86d6b54c9d4e2c1e15478c760a31a6',
  'supabase/migrations/0011_personal_assistant.sql': 'a7c88ba6c133bb9608a48b79341be61f4608e1d154f911d852040d154449821a',
  'supabase/preflight/preflight_0011.sql': 'd3fa310fd24cff1dda486fda72da9fe50df4fd65d6b0ad3ba93db8622f19744d',
  'supabase/verify/verify_0011.sql': 'c9ff53d779ab15452268663a22920496e64d4abd609685eaf7a2ba36c2eca9c6',
  'supabase/migrations/0012_life_alignment.sql': 'eb9848024784b4ec20e4149677be06289ca1607f7045708ad2570768c7de91d7',
  'supabase/preflight/preflight_0012.sql': '1ecad5739b5a11baa01f4829837cf1ef82d139c003b58f5d7e024c9db9ada85e',
  'supabase/verify/verify_0012.sql': '5859fedb6dbddb284e4e541264dc889352837f596d6d5b761f1213a161a3d514',
  'supabase/migrations/0013_alignment_reality.sql': 'b6d1a14468b096baf779c39248c6e24d2d12d3990f443f56e3b17710f38d802a',
  'supabase/preflight/preflight_0013.sql': '3624909f1b6b2ea0fee6fab9aac925849f1afd55805da9f00c11385b59ec3eda',
  'supabase/verify/verify_0013.sql': 'd4716ef31fe44fde78b1fb65ee8e6e4a64018b1a4b9bc78763963a8ddb1887bc'
});

test('KRIITTINEN: SQL-lähteen siirto J -> K ei muuttanut 0009–0013:n tavuja', () => {
  for (const [file, digest] of Object.entries(SQL_0009_0013_AT_J)) {
    assert.equal(map.sqlSource.files[file], digest, `${file}: lukon tiiviste muuttui lähteen siirrossa`);
  }
});

test('oikea historia (ehdollinen): J:n ja K:n kärjissä 0009–0013 ovat samat tavut', t => {
  const j = map.waves.find(w => w.wave === 'J').deployTarget;
  const k = map.waves.find(w => w.wave === 'K').deployTarget;
  if (!realGit.revParse(j) || !realGit.revParse(k)) { t.skip('ehdokashistoria ei ole paikallisesti saatavilla'); return; }
  const fromJ = sqlSourceFiles(realGit, j, 'J');
  assert.deepEqual(Object.keys(fromJ).sort(), Object.keys(SQL_0009_0013_AT_J).sort(), 'J:n lähdetiedostot ovat 0009–0013');
  for (const [file, digest] of Object.entries(fromJ)) {
    assert.equal(digest, map.sqlSource.files[file], `${file}: J ${String(digest).slice(0, 12)} != K ${String(map.sqlSource.files[file]).slice(0, 12)}`);
  }
});

test('tynkä: origin/mainin siirtyminen ei muuta yhtäkään aallon tietuetta', () => {
  const before = buildTrainMap({ git: stubGit({ production: 'C' }) });
  const after = buildTrainMap({ git: stubGit({ production: 'D' }) });
  assert.deepEqual(after.waves, before.waves);
  assert.equal(before.production.wave, 'C');
  assert.equal(after.production.wave, 'D');
  const check = checkTrainMap(before, { git: stubGit({ production: 'E' }) });
  assert.deepEqual(check.problems, []);
  assert.equal(check.production.wave, 'E', 'tuotanto luetaan tarkistushetkellä erikseen');
});

test('KRIITTINEN: tynkä: puuttuva viite -> {consistent:false, problem:"ref puuttuu"}, ei poikkeusta', () => {
  const missing = TRAIN.find(e => e.wave === 'H').ref;
  const built = buildTrainMap({ git: stubGit({ missingRefs: [missing] }) });
  const h = built.waves.find(w => w.wave === 'H');
  assert.equal(h.consistent, false);
  assert.equal(h.problem, 'ref puuttuu');
  assert.equal(h.deployTarget, null);
});

test('KRIITTINEN: tynkä: siirtynyt viite on tarkistuksessa VIRHE', () => {
  const lock = buildTrainMap({ git: stubGit() });
  const moved = TRAIN.find(e => e.wave === 'F').ref;
  const check = checkTrainMap(lock, { git: stubGit({ refOverrides: { [moved]: shaOf('G') } }) });
  assert.equal(check.ok, false);
  assert.ok(check.problems.some(p => p.startsWith('F: ref siirtynyt')), check.problems.join('; '));
  const tampered = JSON.parse(JSON.stringify(lock));
  tampered.waves.find(w => w.wave === 'E').cacheVersion = 'v99';
  assert.ok(checkTrainMap(tampered, { git: stubGit() }).problems.some(p => /E: cacheVersion/.test(p)));
});

test('tynkä: puuttuva pakollinen korjaus kirjataan H:sta alkaen, ei aiemmille', () => {
  const lock = buildTrainMap({ git: stubGit({ missingPatchWaves: ['G', 'H', 'I', 'J', 'K'] }) });
  assert.deepEqual(lock.waves.find(w => w.wave === 'G').missingPatches, [], 'G ei tarvitse korjausta');
  for (const wave of ['H', 'I', 'J', 'K']) {
    assert.deepEqual(lock.waves.find(w => w.wave === wave).missingPatches, [REQUIRED_PATCHES[0].commit], wave);
    assert.equal(lock.waves.find(w => w.wave === wave).consistent, true, 'korjauksen puute ei tee tietueesta epäjohdonmukaista');
  }
});

test('tynkä: talouskorjaus vaaditaan F:stä ja tietosuojakorjaus I:stä alkaen, ei aiemmille', () => {
  const finance = REQUIRED_PATCHES.find(p => p.commit.startsWith('5ceb371'));
  const privacy = REQUIRED_PATCHES.find(p => p.commit.startsWith('aaefa4d'));
  assert.equal(finance.fromWave, 'F');
  assert.equal(privacy.fromWave, 'I');
  const lock = buildTrainMap({ git: stubGit({ missingPatches: { '5ceb371': ['E', 'F', 'J'], aaefa4d: ['H', 'I', 'K'] } }) });
  const of = wave => lock.waves.find(w => w.wave === wave).missingPatches;
  assert.deepEqual(of('E'), [], 'E ei tarvitse talouskorjausta');
  assert.deepEqual(of('F'), [finance.commit]);
  assert.deepEqual(of('J'), [finance.commit]);
  assert.deepEqual(of('H'), [], 'H ei tarvitse tietosuojakorjausta');
  assert.deepEqual(of('I'), [privacy.commit]);
  assert.deepEqual(of('K'), [privacy.commit], 'myös junan viimeinen aalto vaatii korjaukset');
});

test('oikea historia (ehdollinen): lukko vastaa gitiä ja aliakset osoittavat lukittuihin SHA:ihin', t => {
  if (!refsPresent()) { t.skip('ehdokashaarat eivät ole paikallisesti saatavilla'); return; }
  const fresh = buildTrainMap({ git: realGit });
  assert.deepEqual(JSON.parse(JSON.stringify(fresh.waves)), map.waves,
    'lukko eroaa gitistä: aja node tools/activation/train-map.mjs --write');
  const check = checkTrainMap(map, { git: realGit });
  assert.deepEqual(check.problems, []);
});

// =====================================================================
// ACT-02: H:sta alkaen jokainen deployTarget sisältää kellokorjauksen
// =====================================================================

/**
 * Uudelleenleikkausta EDELTÄVÄT deploykohteet (docs/activation/
 * release-train-c-j.json 2026-09-26). Näistä tiedetään, että 5aa0d53
 * puuttuu; testi ohitetaan niille selkeällä viestillä, jotta tuotehaaran
 * patteristo ei kaadu ennen kuin pääkehittäjä leikkaa H:n, I:n ja J:n
 * uudelleen. Tämä on hylkylista, ei kiinnitys: uudet SHA:t tulevat
 * lukkoon train-map --write:lla, eikä niitä kirjoiteta tänne.
 */
const PRE_RECUT_DEPLOY_TARGETS = new Set([
  '48b2cad8bc62362dbe371d08f36b32677df270f6',
  '4cfb4bcfea649146fb0bc9202d309aea8d1ffd9e',
  '5df40b20cee4f35279a79888959d49c9af88bcc7'
]);

for (const wave of ['H', 'I', 'J', 'K']) {
  test(`ACT-02 (uudelleenleikkauksen jälkeen): aallon ${wave} deployTarget sisältää korjauksen 5aa0d53`, t => {
    const record = map.waves.find(w => w.wave === wave);
    const patch = REQUIRED_PATCHES.find(p => p.commit.startsWith('5aa0d53'));
    if (PRE_RECUT_DEPLOY_TARGETS.has(record.deployTarget)) {
      t.skip(`ODOTTAA UUDELLEENLEIKKAUSTA: lukittu ${wave} ${record.deployTarget.slice(0, 7)} edeltää leikkausta (lukossa missingPatches)`);
      return;
    }
    if (!realGit.revParse(record.deployTarget) || !realGit.revParse(patch.commit)) {
      t.skip('ehdokashistoria ei ole paikallisesti saatavilla'); return;
    }
    assert.equal(realGit.containsPatch(record.deployTarget, patch.commit), true,
      `${wave} ${record.deployTarget.slice(0, 7)} ei sisällä korjausta ${patch.commit.slice(0, 7)}`);
    assert.deepEqual(record.missingPatches, []);
  });
}

for (const patch of REQUIRED_PATCHES.filter(p => !p.commit.startsWith('5aa0d53'))) {
  for (const wave of TRAIN.map(e => e.wave).filter(w => w >= patch.fromWave)) {
    test(`pakollinen korjaus ${patch.commit.slice(0, 7)}: aallon ${wave} deployTarget sisältää sen`, t => {
      const record = map.waves.find(w => w.wave === wave);
      if (!realGit.revParse(record.deployTarget) || !realGit.revParse(patch.commit)) {
        t.skip('ehdokashistoria ei ole paikallisesti saatavilla'); return;
      }
      assert.equal(realGit.containsPatch(record.deployTarget, patch.commit), true,
        `${wave} ${record.deployTarget.slice(0, 7)} ei sisällä korjausta ${patch.commit.slice(0, 7)}: ${patch.reason}`);
      assert.ok(!record.missingPatches.includes(patch.commit));
    });
  }
}

test('ACT-02: lukko ja hylkylista ovat samaa mieltä: esileikatuilla on missingPatches', () => {
  for (const w of map.waves) {
    if (PRE_RECUT_DEPLOY_TARGETS.has(w.deployTarget)) {
      assert.deepEqual(w.missingPatches, [REQUIRED_PATCHES[0].commit], `${w.wave}: lukko väittää korjauksen olevan mukana`);
    }
  }
});

// =====================================================================
// ACT-09: manifestin aaltocommit vs lukon deployTarget
// =====================================================================

test('ACT-09 (ehdollinen): manifestin aaltocommit on lukon waveCommit ja deployTargetin esi-isä', t => {
  if (!refsPresent()) { t.skip('ehdokashaarat eivät ole paikallisesti saatavilla'); return; }
  for (const w of map.waves) {
    assert.equal(realGit.isAncestor(w.waveCommit, w.deployTarget), true, `${w.wave}: aaltocommit ei ole deployTargetin esi-isä`);
    const manifest = realGit.show(w.deployTarget, 'docs/activation-0003-0008-release-manifest.json');
    if (!manifest) continue;
    const own = (JSON.parse(manifest).waves || []).find(x => x.id === w.wave);
    if (own && own.commitSha) {
      assert.equal(own.commitSha, w.waveCommit, `${w.wave}: manifestin commitSha ${own.commitSha} != lukon waveCommit`);
    }
  }
});

// =====================================================================
// ACT-14: dokumenttien push-rivit ja GO/NO-GO-taulukko seuraavat lukkoa
// =====================================================================

test('KRIITTINEN: jokainen push- ja deploy-rivi käyttää lukon 40-merkkistä deployTargetia (tai HEAD:ia), ja STOP-rivit vastaavat lukkoa', () => {
  const problems = [];
  let lines = 0;
  for (const { file, wave } of pushLineDocs(map)) {
    const text = read(file);
    lines += pushLinesIn(text).length + deployLinesIn(text).length + stopLinesIn(text).length;
    problems.push(...pushLineProblems(text, { lock: map, wave, file }));
    problems.push(...sqlSourceProblems(text, { lock: map, file }));
    problems.push(...waveShaArgProblems(text, { lock: map, file }));
  }
  assert.deepEqual(problems, []);
  assert.ok(lines >= 30, `push-, deploy- ja STOP-rivejä löytyi vain ${lines}`);
});

test('KRIITTINEN: ensisijainen deploy-askel on orkestroija: jokaisessa WAVE-D..K.md:n kohdassa 2 orkestroijan komento tai STOP-huomautus', () => {
  for (const w of map.waves.slice(1)) {
    const doc = read(`docs/acceptance/WAVE-${w.wave}.md`).replace(/\r\n/g, '\n');
    const start = doc.indexOf('\n## 2. Deploy');
    const s2 = doc.slice(start, doc.indexOf('\n## 3. ', start));
    const firstBlock = /```\n([^\n]*)\n```/.exec(s2);
    assert.ok(firstBlock, `${w.wave}: kohdassa 2 ei ole koodilohkoa`);
    const expected = w.missingPatches.length
      ? new RegExp(`^# STOP ${w.wave} — TRAIN_RECUT_REQUIRED: .*\\[deploy`)
      : new RegExp(`^npm run activation:orchestrate -- --execute-deploy --approved-sha=${w.deployTarget}`);
    assert.match(firstBlock[1], expected, `${w.wave}: ensimmäinen deploy-rivi ei ole orkestroija`);
    assert.match(s2, /Omistajan viesti \*\*"hyväksyn /, `${w.wave}: omistajan viesti puuttuu`);
    assert.ok(s2.indexOf('npm run activation:orchestrate') === -1 || s2.indexOf('npm run activation:orchestrate') < (s2.indexOf('git push origin') === -1 ? Infinity : s2.indexOf('git push origin')),
      `${w.wave}: raaka push ennen orkestroijaa`);
  }
});

test('KRIITTINEN: raaka push- tai deploy-rivi aallolle, jonka lukossa on missingPatches, kaatuu; STOP-huomautus kelpaa', () => {
  const lock = JSON.parse(JSON.stringify(map));
  const h = lock.waves.find(w => w.wave === 'H');
  h.missingPatches = [REQUIRED_PATCHES[0].commit];
  const sha = h.deployTarget;
  for (const [text, wave] of [
    [`git push origin ${sha}:refs/heads/main   # H v21`, null],
    [`git push origin ${sha}:refs/heads/main   # H v21 (leikataan uudelleen)`, null],
    [`git push origin ${sha}:refs/heads/main`, 'H'],
    [`npm run activation:orchestrate -- --execute-deploy --approved-sha=${sha}`, 'H'],
    [`npm run activation:orchestrate -- --execute-deploy --approved-sha=${sha} --verify-result=<x>   # H v21`, null]
  ]) {
    const problems = pushLineProblems(text, { lock, wave });
    assert.ok(problems.some(p => /missingPatches: raaka (push|deploy)-rivi on korvattava STOP-huomautuksella/.test(p)), `${text}: ${problems.join('; ')}`);
  }
  // --sync-docs muuttaa rivin STOP-huomautukseksi, joka kelpaa ja on idempotentti.
  const synced = syncPushLines(`\`\`\`\ngit push origin ${sha}:refs/heads/main   # H v21 (leikataan uudelleen)\n\`\`\``, { lock });
  assert.match(synced, /^# STOP H — TRAIN_RECUT_REQUIRED: lukon deployTarget [0-9a-f]{7} ei sisällä pakollista korjausta 5aa0d53; .*\[push {3}# H v21\]$/m);
  assert.deepEqual(pushLineProblems(synced, { lock }), []);
  assert.equal(syncPushLines(synced, { lock }), synced);
  // Ilman missingPatches STOP-huomautus on itse virhe (vanhentunut).
  const clean = JSON.parse(JSON.stringify(lock));
  clean.waves.find(w => w.wave === 'H').missingPatches = [];
  assert.ok(pushLineProblems(synced, { lock: clean }).some(p => /STOP-huomautus aallolle H, mutta lukossa ei ole missingPatches/.test(p)));
  // Muokattu STOP-teksti ei vastaa lukkoa.
  assert.ok(pushLineProblems(synced.replace('5aa0d53', '1234567'), { lock }).some(p => /ei vastaa lukkoa/.test(p)));
});

test('KRIITTINEN: uudelleenleikkaus palauttaa STOP-rivit komennoiksi uusilla SHA:illa ja säilyttää liput', () => {
  const recut = JSON.parse(JSON.stringify(map));
  const fresh = { H: '1'.repeat(40), I: '2'.repeat(40), J: '3'.repeat(40), K: '4'.repeat(40) };
  for (const [wave, sha] of Object.entries(fresh)) {
    const record = recut.waves.find(w => w.wave === wave);
    record.deployTarget = sha;
    record.missingPatches = [];
  }
  recut.sqlSource = { ...recut.sqlSource, sha: fresh.K, ref: 'rehearsal/wave-k-v2' };
  const stale = map.waves.filter(w => fresh[w.wave]).map(w => w.deployTarget);
  for (const { file, wave, table } of pushLineDocs(map)) {
    const text = read(file).replace(/\r\n/g, '\n');
    const updated = syncDoc(text, { lock: recut, wave, table });
    for (const old of stale) assert.equal(updated.includes(old), false, `${file}: vanha SHA ${old.slice(0, 7)} jäi`);
    assert.deepEqual(pushLineProblems(updated, { lock: recut, wave, file }), [], file);
    assert.deepEqual(sqlSourceProblems(updated, { lock: recut, file }), [], file);
    assert.deepEqual(waveShaArgProblems(updated, { lock: recut, file }), [], file);
    assert.equal(stopLinesIn(updated).length, 0, `${file}: STOP-rivi jäi uudelleenleikkauksen jälkeen`);
  }
  const fast = syncDoc(read('docs/SUUNTA-FAST-ACTIVATION.md').replace(/\r\n/g, '\n'), { lock: recut });
  assert.match(fast, new RegExp(`--approved-sha=${fresh.H} --inventory=<uusi-inventaario> --verify-result=<verify_0011-tulos> {3}# H v21`));
  assert.match(fast, new RegExp(`--approved-sha=${fresh.K} --inventory=<uusi-inventaario> --verify-result=<verify_0014-tulos> {3}# K v24`));
  assert.match(fast, new RegExp(`git show ${fresh.K}:supabase/migrations/0013_alignment_reality\\.sql`));
  assert.match(fast, new RegExp(`git show ${fresh.K}:supabase/migrations/0014_daily_life\\.sql`));
  assert.match(fast, new RegExp(`--record-boot-smoke=K --sha=${fresh.K} `));
  assert.match(fast, /SQL-lähde \(lukon sqlSource\): `rehearsal\/wave-k-v2` @ `4{40}`/);
  const waveK = syncDoc(read('docs/acceptance/WAVE-K.md').replace(/\r\n/g, '\n'), { lock: recut, wave: 'K' });
  assert.match(waveK, new RegExp(`--approved-sha=${fresh.K} --verify-result=<verify_0014-tulos>`));
  assert.match(waveK, new RegExp(`--record-candidate-tests=K --sha=${fresh.K} `));
  assert.match(waveK, new RegExp(`--label K --expect-sha ${fresh.K} `));
});

test('käynnistyssavun rivit (--label X --expect-sha, --record-boot-smoke=X --sha=) seuraavat lukkoa', () => {
  const d = map.waves.find(w => w.wave === 'D').deployTarget;
  const e = map.waves.find(w => w.wave === 'E').deployTarget;
  const stale = [
    `npm run e2e:boot-smoke -- --root .claude/worktrees/rc-D-smoke --label D --expect-sha ${e} > .claude/activation/smoke-D.txt`,
    `npm run activation:orchestrate -- --record-boot-smoke=D --sha=${e} --smoke-result=.claude/activation/smoke-D.txt`,
    `node tools/e2e/boot-smoke.mjs --root x --label=D --expect-sha=${e}`
  ].join('\n');
  const problems = waveShaArgProblems(stale, { lock: map, file: 'x.md' });
  assert.equal(problems.length, 3, problems.join('; '));
  assert.match(problems[0], new RegExp(`--expect-sha ${e.slice(0, 7)} ei ole aallon D lukittu deployTarget`));
  const synced = syncDoc(stale, { lock: map });
  assert.equal(synced.includes(e), false);
  assert.equal(synced.split(d).length - 1, 3);
  assert.deepEqual(waveShaArgProblems(synced, { lock: map, file: 'x.md' }), []);
  // Paikkamerkki X ei ole aalto: politiikan yleisohje ei muutu.
  const generic = 'npm run e2e:boot-smoke -- --root .claude/worktrees/rc-X-smoke --label X --expect-sha <deployTarget>';
  assert.equal(syncDoc(generic, { lock: map }), generic);
});

test('push-rivien tarkistus hylkää haaran nimen, lyhyen SHA:n ja väärän aallon SHA:n', () => {
  const d = map.waves.find(w => w.wave === 'D').deployTarget;
  const e = map.waves.find(w => w.wave === 'E').deployTarget;
  const bad = [
    'git push origin release/activation-0003-0008:main',
    'git push origin 091e73c:main',
    `git push origin ${e}:refs/heads/main`
  ].join('\n');
  assert.equal(pushLineProblems(bad, { lock: map, wave: 'D' }).length, 3);
  assert.deepEqual(pushLineProblems(`git push origin ${d}:refs/heads/main\ngit push origin HEAD:main`, { lock: map, wave: 'D' }), []);
});

test('--sync-docs on idempotentti nykyisellä lukolla ja päivittää vanhentuneen SHA:n', () => {
  for (const { file, wave, table } of pushLineDocs(map)) {
    const text = read(file).replace(/\r\n/g, '\n');
    const synced = syncDoc(text, { lock: map, wave, table });
    assert.equal(synced, text, `${file} ei vastaa lukkoa: aja node tools/activation/train-map.mjs --sync-docs`);
  }
  const recut = JSON.parse(JSON.stringify(map));
  const h = recut.waves.find(w => w.wave === 'H');
  h.deployTarget = '1'.repeat(40);
  h.missingPatches = [];
  const doc = read('docs/SUUNTA-ACTIVATION-GO-NOGO.md').replace(/\r\n/g, '\n');
  const updated = syncTableDeployTargets(syncPushLines(doc, { lock: recut }), { lock: recut });
  assert.match(updated, new RegExp(`git push origin ${'1'.repeat(40)}:refs/heads/main   # H v21\\n`));
  assert.equal(goNoGoTableRows(updated).H.deployTarget, '1'.repeat(40));
  assert.equal(/# H v21 \(leikataan uudelleen\)/.test(updated), false);
});

test('KRIITTINEN: GO/NO-GO-taulukon deploykohteet ovat lukon deployTargetit', () => {
  const rows = goNoGoTableRows(read('docs/SUUNTA-ACTIVATION-GO-NOGO.md'));
  for (const w of map.waves) {
    assert.ok(rows[w.wave], `taulukosta puuttuu aalto ${w.wave}`);
    assert.equal(rows[w.wave].deployTarget, w.deployTarget, `${w.wave}: taulukko ${rows[w.wave].deployTarget}`);
    assert.equal(rows[w.wave].cacheVersion, w.cacheVersion, w.wave);
  }
});

test('ACT-09: manifesti kirjaa lukon deployTargetin, ja todennus vertaa sitä lukkoon', async () => {
  const { buildManifest, validateManifest, readManifest } = await import('../tools/release/manifest.mjs');
  const onDisk = readManifest();
  const shas = Object.assign({ BASE: onDisk.baseSha }, Object.fromEntries(onDisk.waves.map(w => [w.id, w.commitSha])));
  const plain = JSON.parse(JSON.stringify(buildManifest(shas)));
  assert.equal('deployTarget' in plain.waves[0], false, 'ilman lukkoa kenttää ei kirjoiteta');
  const targets = Object.fromEntries(map.waves.map(w => [w.wave, w.deployTarget]));
  const withLock = JSON.parse(JSON.stringify(buildManifest(shas, { deployTargets: targets })));
  assert.equal(withLock.waves.find(w => w.id === 'D').deployTarget, targets.D);
  assert.equal(withLock.waves.find(w => w.id === 'A').deployTarget, null);
  assert.deepEqual(validateManifest(withLock, { checkGit: false, lock: map }), []);
  const wrong = JSON.parse(JSON.stringify(withLock));
  wrong.waves.find(w => w.id === 'J').deployTarget = targets.I;
  assert.ok(validateManifest(wrong, { checkGit: false, lock: map }).some(p => /J\.deployTarget on .* lukossa/.test(p)));
  wrong.waves.find(w => w.id === 'J').deployTarget = '5df40b2';
  assert.ok(validateManifest(wrong, { checkGit: false, lock: map }).some(p => /J\.deployTarget ei ole 40 merkin SHA/.test(p)));
});

test('WAVE-D..K.md kertovat, että push-kohde on lukon deployTarget eikä manifestin commitSha', () => {
  for (const w of map.waves.slice(1)) {
    const doc = read(`docs/acceptance/WAVE-${w.wave}.md`);
    assert.match(doc, /\*\*Push-kohde \(deployTarget\):\*\* junan lukon `docs\/activation\/release-train-c-j\.json`/, w.wave);
    assert.match(doc, /EI push-kohde/, w.wave);
    assert.equal(/Aallon commit-SHA: ks\./.test(doc), false, `${w.wave}: vanha manifestiviittaus push-kohteena`);
  }
});

test('KRIITTINEN: WAVE-K.md: lukon SHA, ei "ei vielä leikattu" -tilaa, ja testiajon ja käynnistyssavun kirjaus testiajon vieressä', () => {
  const k = map.waves.find(w => w.wave === 'K');
  const doc = read('docs/acceptance/WAVE-K.md').replace(/\r\n/g, '\n');
  assert.equal(/ei ole vielä\s+leikattu|lukossa ei vielä ole/.test(doc), false, 'WAVE-K.md väittää yhä, ettei K:ta ole lukittu');
  assert.equal(/^npm run activation:orchestrate -- --execute-deploy --approved-sha=</m.test(doc), false,
    'deploy-rivillä on yhä paikkamerkki lukon SHA:n sijasta');
  const s1 = doc.slice(doc.indexOf('\n## 1. Ennen deployta'), doc.indexOf('\n## 2. Deploy'));
  const tests = `npm run activation:orchestrate -- --record-candidate-tests=K --sha=${k.deployTarget} --tests-result=.claude/activation/tests-K.txt`;
  const smoke = `npm run e2e:boot-smoke -- --root .claude/worktrees/rc-K-smoke --label K --expect-sha ${k.deployTarget} > .claude/activation/smoke-K.txt`;
  const record = `npm run activation:orchestrate -- --record-boot-smoke=K --sha=${k.deployTarget} --smoke-result=.claude/activation/smoke-K.txt`;
  assert.ok(s1.includes('npm test && npm run check'), 'kohdan 1 testiajo puuttuu');
  assert.ok(s1.includes(`${tests}\n${smoke}\n${record}\n`), 'testiajon ja käynnistyssavun kirjaus puuttuu kohdasta 1');
  assert.ok(doc.includes(`git push origin ${k.deployTarget}:refs/heads/main`), 'viitteellinen push-rivi lukon SHA:han puuttuu');
});
