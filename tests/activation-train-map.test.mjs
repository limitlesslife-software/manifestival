// Julkaisujunan C–J kartta (docs/activation/release-train-c-j.json).
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
  REQUIRED_PATCHES, TRAIN, buildTrainMap, checkTrainMap, pushLineDocs
} from '../tools/activation/train-map.mjs';
import {
  goNoGoTableRows, pushLineProblems, pushLinesIn, syncPushLines, syncTableDeployTargets
} from '../tools/activation/push-lines.mjs';
import { shaOf, stubGit } from './helpers/activation-history.mjs';

const map = JSON.parse(read('docs/activation/release-train-c-j.json'));
const SHA40 = /^[0-9a-f]{40}$/;
const realGit = createGit({ cwd: ROOT });
const refsPresent = () => TRAIN.every(e => realGit.revParse(e.ref));

test('kartta kattaa aallot C–J järjestyksessä', () => {
  assert.deepEqual(map.waves.map(w => w.wave), ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']);
  for (const w of map.waves) assert.ok(WAVE_IDS.includes(w.wave));
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
    ['0009', '0010', '0011', '0012', '0013']);
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

test('SQL-lähde on lukittu: J:n deployTarget ja jokaisen tiedoston sha256', () => {
  const j = map.waves.find(w => w.wave === 'J');
  assert.equal(map.sqlSource.sha, j.deployTarget);
  assert.equal(Object.keys(map.sqlSource.files).length, 15);
  for (const [file, digest] of Object.entries(map.sqlSource.files)) {
    assert.match(digest, /^[0-9a-f]{64}$/, file);
    assert.ok(read(file), `${file} puuttuu tuotehaarasta`);
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
  const lock = buildTrainMap({ git: stubGit({ missingPatchWaves: ['G', 'H', 'I', 'J'] }) });
  assert.deepEqual(lock.waves.find(w => w.wave === 'G').missingPatches, [], 'G ei tarvitse korjausta');
  for (const wave of ['H', 'I', 'J']) {
    assert.deepEqual(lock.waves.find(w => w.wave === wave).missingPatches, [REQUIRED_PATCHES[0].commit], wave);
    assert.equal(lock.waves.find(w => w.wave === wave).consistent, true, 'korjauksen puute ei tee tietueesta epäjohdonmukaista');
  }
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

for (const wave of ['H', 'I', 'J']) {
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

test('KRIITTINEN: jokainen "git push origin X:main" -rivi käyttää lukon 40-merkkistä deployTargetia (tai HEAD:ia)', () => {
  const problems = [];
  let lines = 0;
  for (const { file, wave } of pushLineDocs(map)) {
    const text = read(file);
    lines += pushLinesIn(text).length;
    problems.push(...pushLineProblems(text, { lock: map, wave, file }));
  }
  assert.deepEqual(problems, []);
  assert.ok(lines >= 14, `push-rivejä löytyi vain ${lines}`);
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
  for (const { file, wave } of pushLineDocs(map)) {
    const text = read(file).replace(/\r\n/g, '\n');
    let synced = syncPushLines(text, { lock: map, wave });
    if (!wave) synced = syncTableDeployTargets(synced, { lock: map });
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

test('WAVE-D..J.md kertovat, että push-kohde on lukon deployTarget eikä manifestin commitSha', () => {
  for (const w of map.waves.slice(1)) {
    const doc = read(`docs/acceptance/WAVE-${w.wave}.md`);
    assert.match(doc, /\*\*Push-kohde \(deployTarget\):\*\* junan lukon `docs\/activation\/release-train-c-j\.json`/, w.wave);
    assert.match(doc, /EI push-kohde/, w.wave);
    assert.equal(/Aallon commit-SHA: ks\./.test(doc), false, `${w.wave}: vanha manifestiviittaus push-kohteena`);
  }
});
