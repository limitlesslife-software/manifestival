// Julkaisujunan C–K LUKKO gitistä: node tools/activation/train-map.mjs [--write] [--sync-docs] [--json]
//
// MITÄ TÄMÄ ON (ACT-04)
//
// docs/activation/release-train-c-j.json on junan LUKKO (tiedostonimi on
// historiallinen: juna jatkui aallolla K, ja nimeen viittaa moni työkalu,
// testi ja dokumentti, joten sitä ei vaihdettu): jokainen aalto
// on kiinnitetty täyteen 40-merkkiseen SHA:han (`deployTarget`). Se on
// ainoa totuus siitä, mikä commit pushataan tuotantoon. Aliakset
// (`ref`, alla TRAIN) ovat vain muistiapu, jolla lukko KIRJOITETAAN.
//
//   ilman lippuja   TARKISTUS: jokaisen aliaksen `git rev-parse` on yhä
//                   lukittu SHA, ja lukittu SHA tuottaa yhä saman
//                   tietueen (välimuisti, matriisi, sarakeportit,
//                   sukulinja). Poikkeama = VIRHE, poistumiskoodi 1.
//   --write         ratkaise aliakset, rakenna tietueet ja kirjoita lukko.
//                   Kieltäytyy, jos yksikin alias puuttuu.
//   --sync-docs     päivitä dokumenttien deploy- ja push-rivit lukon
//                   SHA:ihin, STOP-huomautukset lukon missingPatches-
//                   tilaan ja SQL-lähteen viitteet lukon sqlSourceen
//                   (docs/SUUNTA-ACTIVATION-GO-NOGO.md,
//                   docs/SUUNTA-FAST-ACTIVATION.md ja
//                   docs/acceptance/WAVE-D..K.md: jokainen lukon aalto
//                   C:n jälkeen). Käytä --write:n jälkeen, kun aalto on
//                   leikattu uudelleen tai uusi aalto lukittu.
//
// MIKSI EI `origin/main`
//
// Aiemmin aalto C oli kiinnitetty liikkuvaan viitteeseen origin/main.
// Heti aallon D pushin jälkeen C:n tietue olisi ollut D:n commit, ja
// kartta olisi raportoinut VIRHEEN (todettu simuloimalla). Nyt C:n alias
// on sen oma SHA, ja tuotannon nykytila on ERILLINEN kenttä
// `production`, joka luetaan origin/mainista kirjoitushetkellä —
// tarkistus lukee sen uudelleen eikä pidä eroa virheenä.
//
// Tilaa (DEPLOYED/READY/…) ei tallenneta: se vanhenee jokaisesta
// askeleesta. Orkestroija johtaa sen tuotannosta, inventaariosta ja
// päiväkirjasta.
//
// Ei verkkoa, ei kirjoituksia gitiin. `git`-kerros on injektoitava
// (tools/release/git-layer.mjs), joten testit ajavat tämän tynkähistoriaa
// vasten.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { parseCacheVersion, parseGates } from '../release/state.mjs';
import {
  COLUMN_GATES, WAVES, cacheVersionOf, cumulativeGates, preflightPathOf, resolveWave,
  verifyPathOf, waveById, waveIndex
} from '../release/waves.mjs';
import { createGit, isFullSha } from '../release/git-layer.mjs';
import { originMainStateFrom } from '../release/lineage.mjs';
import { syncPushLines, syncSqlSourceRefs, syncTableDeployTargets, syncWaveShaArgs } from './push-lines.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LOCK_PATH = 'docs/activation/release-train-c-j.json';

/**
 * Aallot ja niiden ALIAKSET. Alias ratkaistaan vain --write:ssa; lukossa
 * on SHA. C:n alias on sen oma SHA (tuotannossa oleva lattia), D:n
 * samoin (jäädytetty aaltocommit). F–J on leikattu uudelleen (F v4, G v5,
 * H v5, I v3, J v2), ja K v1 on leikattu J v2:n päälle: uusi leikkaus =
 * päivitä aliakset uusiin haaroihin ja aja --write — SHA:ita EI kirjoiteta
 * tänne.
 */
export const TRAIN = Object.freeze([
  Object.freeze({ wave: 'C', ref: 'cf259d0ef755f7e875cc9cd9c15405eba632e408', acceptance: 'docs/acceptance/WAVE-C-OWNER-ACCEPTANCE.md' }),
  Object.freeze({ wave: 'D', ref: '091e73c0091e8f135641e3501742b998dbac8461', acceptance: 'docs/acceptance/WAVE-D.md' }),
  Object.freeze({ wave: 'E', ref: 'release/activation-0003-0008', acceptance: 'docs/acceptance/WAVE-E.md' }),
  Object.freeze({ wave: 'F', ref: 'rehearsal/wave-f-v4', acceptance: 'docs/acceptance/WAVE-F.md' }),
  Object.freeze({ wave: 'G', ref: 'rehearsal/wave-g-v5', acceptance: 'docs/acceptance/WAVE-G.md' }),
  Object.freeze({ wave: 'H', ref: 'rehearsal/wave-h-v5', acceptance: 'docs/acceptance/WAVE-H.md' }),
  Object.freeze({ wave: 'I', ref: 'rehearsal/wave-i-v3', acceptance: 'docs/acceptance/WAVE-I.md' }),
  Object.freeze({ wave: 'J', ref: 'rehearsal/wave-j-v2', acceptance: 'docs/acceptance/WAVE-J.md' }),
  Object.freeze({ wave: 'K', ref: 'rehearsal/wave-k-v1', acceptance: 'docs/acceptance/WAVE-K.md' })
]);

/**
 * Korjaukset, joiden on oltava deploykohteessa aallosta `fromWave`
 * alkaen (ACT-02). Puuttuva korjaus ei tee tietueesta epäjohdonmukaista
 * (välimuisti ja portit ovat oikein), mutta aalto ei ole deployattavissa
 * ennen uudelleenleikkausta: orkestroija pysähtyy.
 */
export const REQUIRED_PATCHES = Object.freeze([
  Object.freeze({
    commit: '5aa0d53a2917db4a588aca91d92f5ed051259545',
    fromWave: 'H',
    reason: 'kellosta riippuvat testit ("perjantaille") kaatuvat ehdokkaan omassa patteristossa'
  }),
  Object.freeze({
    commit: '5ceb37135581f4bbda3e010cb4305461e9cdbe06',
    fromWave: 'F',
    reason: 'talouden yleiskatsaus kaatui ReferenceErroriin (key -> avain) jokaisella piirrolla ja pysäytti koko sovelluksen tilakuuntelijan'
  }),
  Object.freeze({
    commit: 'aaefa4dfd9bca8f01170a8114257278b15afd4cb',
    fromWave: 'I',
    reason: 'kannan virhetiedot (elämänalueiden nimet, pohdinnat) kulkivat konsoliin suodattamatta'
  })
]);

/**
 * SQL-tiedostot haetaan AINA tästä aallosta: vain sen kärjessä on kaikki
 * 0009–0014 -tiedostot. K:n kärjen (d11d8b4) 0009–0013 -tiedostot ovat
 * tavu tavulta samat kuin J:n (cba9463) — sama git-blob — joten niiden
 * sha256 lukossa ei muuttunut, kun lähde siirtyi J:stä K:hon.
 */
export const SQL_SOURCE_WAVE = 'K';

const sha256 = text => createHash('sha256').update(text).digest('hex');

function waveCommitIn(git, fromSha, toSha, wave) {
  const commits = git.log(fromSha, toSha);
  if (!commits) return null;
  const hit = commits.find(c => new RegExp(`^Release-Wave:\\s*${wave}\\s*$`, 'm').test(c.body || ''));
  return hit ? hit.sha : null;
}

/** Yhden aallon tietue lukitusta SHA:sta. Puhdas git-kerroksen suhteen. */
export function buildRecord(entry, tip, previous, git) {
  const wave = waveById(entry.wave);
  if (typeof git.showMany === 'function') git.showMany(tip, ['sw.js', 'src/data/schema.js']);
  const schema = git.show(tip, 'src/data/schema.js');
  const cache = parseCacheVersion(git.show(tip, 'sw.js'));
  const gates = parseGates(schema, { allowMissing: true });
  const record = {
    wave: entry.wave,
    deployTarget: tip,
    ref: entry.ref,
    waveCommit: entry.wave === 'C' ? tip : (previous && previous.deployTarget ? waveCommitIn(git, previous.deployTarget, tip, entry.wave) : null),
    parentWave: previous ? previous.wave : 'B',
    descendsFromParent: previous && previous.deployTarget ? git.isAncestor(previous.deployTarget, tip) : null,
    cacheVersion: cache,
    expectedCacheVersion: cacheVersionOf(entry.wave),
    gateMatrixResolvesTo: gates ? resolveWave(gates) : null,
    gatesCumulative: [...cumulativeGates(entry.wave)],
    migration: wave.migrationFile ? path.posix.basename(wave.migrationFile) : null,
    preflight: preflightPathOf(wave.migration),
    verify: verifyPathOf(wave.migration),
    acceptance: entry.acceptance,
    rollbackTarget: previous ? previous.wave : 'B',
    risk: wave.risk,
    backupRequired: wave.backupRequired,
    columnGates: {}
  };
  // Sarakeportit eivät kuulu taulumatriisiin: auki täsmälleen siitä
  // aallosta alkaen, jolle COLUMN_GATES ne antaa.
  for (const [gate, openFrom] of Object.entries(COLUMN_GATES)) {
    const m = new RegExp(`export const ${gate} = (true|false);`).exec(schema || '');
    record.columnGates[gate] = { actual: m ? m[1] === 'true' : false, expected: waveIndex(entry.wave) >= waveIndex(openFrom) };
  }
  record.missingPatches = REQUIRED_PATCHES
    .filter(p => waveIndex(entry.wave) >= waveIndex(p.fromWave))
    .filter(p => git.containsPatch(tip, p.commit) !== true)
    .map(p => p.commit);
  record.consistent = record.cacheVersion === record.expectedCacheVersion
    && record.gateMatrixResolvesTo === entry.wave
    && record.descendsFromParent !== false
    && Object.values(record.columnGates).every(g => g.actual === g.expected)
    && (!record.migration || isFullSha(record.waveCommit));
  record.problem = record.consistent ? null : 'tietue ei ole johdonmukainen';
  return record;
}

/** Tietue, kun alias ei ratkea. */
function missingRecord(entry, previous) {
  return {
    wave: entry.wave, deployTarget: null, ref: entry.ref, parentWave: previous ? previous.wave : 'B',
    consistent: false, problem: 'ref puuttuu'
  };
}

/**
 * SQL-lähteen tiedostot ja niiden sha256 (lukittu SHA).
 *
 * VAIN SQL-LÄHDEAALTOON ASTI. Lähdeaallon kärjessä on sen omat ja kaikkien
 * aiempien aaltojen tiedostot, ei myöhempien. Lähde siirtyi J:stä
 * (cba9463, 0009–0013) K:hon (d11d8b4, 0009–0014), kun K leikattiin:
 * 0014:n tiedostot tulivat lukkoon samalla --write-ajolla, ja 0009–0013:n
 * tiivisteet pysyivät samoina. Jos junaan lisätään myöhempi aalto ennen
 * kuin sen SQL on lähteessä, sen tiedostojen puuttuminen täältä ei ole
 * virhe — lähdeaalto siirretään, kun aalto leikataan.
 */
export function sqlSourceFiles(git, sha, sourceWave = SQL_SOURCE_WAVE) {
  const last = waveIndex(sourceWave);
  const paths = WAVES.filter(w => w.migration && (last === null || waveIndex(w.id) <= last))
    .flatMap(wave => [wave.migrationFile, preflightPathOf(wave.migration), verifyPathOf(wave.migration)]);
  if (typeof git.showMany === 'function') git.showMany(sha, paths);
  const files = {};
  for (const file of paths) {
    const content = git.show(sha, file);
    files[file] = content === null ? null : sha256(content);
  }
  return files;
}

/**
 * Rakenna lukko ALIAKSISTA (--write). Puuttuva alias -> tietue
 * {consistent:false, problem:'ref puuttuu'}, ei poikkeusta.
 */
export function buildTrainMap({ git = createGit(), train = TRAIN } = {}) {
  const waves = [];
  let previous = null;
  for (const entry of train) {
    const tip = git.revParse(entry.ref);
    const record = tip ? buildRecord(entry, tip, previous, git) : missingRecord(entry, previous);
    waves.push(record);
    previous = record;
  }
  const sqlRecord = waves.find(w => w.wave === SQL_SOURCE_WAVE);
  const sqlSource = sqlRecord && sqlRecord.deployTarget
    ? { wave: SQL_SOURCE_WAVE, ref: sqlRecord.ref, sha: sqlRecord.deployTarget, files: sqlSourceFiles(git, sqlRecord.deployTarget) }
    : { wave: SQL_SOURCE_WAVE, ref: sqlRecord ? sqlRecord.ref : null, sha: null, files: {} };
  const origin = originMainStateFrom(git);
  return {
    generatedBy: 'tools/activation/train-map.mjs',
    lockVersion: 2,
    note: 'LUKKO: push-kohde on aina waves[].deployTarget (40 merkkiä). ref on vain alias, jolla lukko kirjoitettiin.',
    production: {
      source: 'origin/main (paikallinen, luettu --write-hetkellä; ei osa lukkoa)',
      sha: origin.sha, cacheVersion: origin.cacheVersion, wave: origin.wave
    },
    requiredPatches: REQUIRED_PATCHES.map(p => ({ ...p })),
    sqlSource,
    waves
  };
}

/**
 * Tarkista lukko (oletus): jokainen alias osoittaa yhä lukittuun SHA:han,
 * ja lukittu SHA tuottaa yhä saman tietueen. Tuotannon nykytila luetaan
 * erikseen (`production`), eikä sen muutos ole virhe.
 *
 * @returns {{ok: boolean, problems: string[], waves: object[], production: object}}
 */
export function checkTrainMap(lock, { git = createGit(), train = TRAIN } = {}) {
  const problems = [];
  const waves = [];
  if (!lock || !Array.isArray(lock.waves)) {
    return { ok: false, problems: ['lukkoa ei voitu lukea'], waves, production: originMainStateFrom(git) };
  }
  let previous = null;
  for (const entry of train) {
    const locked = lock.waves.find(w => w.wave === entry.wave);
    if (!locked) { problems.push(`${entry.wave}: puuttuu lukosta`); waves.push({ wave: entry.wave, ok: false }); continue; }
    const waveProblems = [];
    if (!isFullSha(locked.deployTarget)) waveProblems.push(`deployTarget ei ole 40-merkkinen SHA: ${locked.deployTarget}`);
    if (locked.ref !== entry.ref) waveProblems.push(`alias on muuttunut: lukossa ${locked.ref}, koodissa ${entry.ref} — aja --write`);
    const resolved = git.revParse(entry.ref);
    if (!resolved) waveProblems.push(`ref puuttuu: ${entry.ref}`);
    else if (isFullSha(locked.deployTarget) && resolved !== locked.deployTarget) {
      waveProblems.push(`ref siirtynyt: ${entry.ref} -> ${resolved}, lukittu ${locked.deployTarget}`);
    }
    if (isFullSha(locked.deployTarget)) {
      if (!git.revParse(locked.deployTarget)) {
        waveProblems.push(`lukittua SHA:ta ${locked.deployTarget} ei ole paikallisesti`);
      } else {
        const fresh = buildRecord(entry, locked.deployTarget, previous, git);
        for (const field of ['waveCommit', 'descendsFromParent', 'cacheVersion', 'gateMatrixResolvesTo', 'migration', 'preflight', 'verify', 'missingPatches', 'consistent']) {
          if (JSON.stringify(fresh[field]) !== JSON.stringify(locked[field])) {
            waveProblems.push(`${field}: lukossa ${JSON.stringify(locked[field])}, gitissä ${JSON.stringify(fresh[field])}`);
          }
        }
        if (JSON.stringify(fresh.columnGates) !== JSON.stringify(locked.columnGates)) waveProblems.push('columnGates eroaa lukosta');
        if (!fresh.consistent) waveProblems.push('tietue ei ole johdonmukainen');
      }
    }
    for (const p of waveProblems) problems.push(`${entry.wave}: ${p}`);
    waves.push({ wave: entry.wave, ok: waveProblems.length === 0, problems: waveProblems, missingPatches: locked.missingPatches || [] });
    previous = locked;
  }
  const sql = lock.sqlSource;
  if (!sql || !isFullSha(sql.sha)) {
    problems.push('sqlSource: lukittu SHA puuttuu');
  } else {
    const fresh = sqlSourceFiles(git, sql.sha);
    for (const [file, digest] of Object.entries(fresh)) {
      if (digest === null) problems.push(`sqlSource: ${file} puuttuu commitista ${sql.sha.slice(0, 7)}`);
      else if (sql.files[file] !== digest) problems.push(`sqlSource: ${file} sha256 eroaa lukosta`);
    }
  }
  return { ok: problems.length === 0, problems, waves, production: originMainStateFrom(git) };
}

/** Lukko levyltä, tai null. */
export function readLock(root = ROOT, fsImpl = fs) {
  try {
    return JSON.parse(fsImpl.readFileSync(path.join(root, LOCK_PATH), 'utf8'));
  } catch {
    return null;
  }
}

/** Dokumentit, joiden deploy- ja push-rivit seuraavat lukkoa (ACT-14). */
export function pushLineDocs(lock) {
  const docs = [
    { file: 'docs/SUUNTA-ACTIVATION-GO-NOGO.md', wave: null, table: true },
    { file: 'docs/SUUNTA-FAST-ACTIVATION.md', wave: null, table: false }
  ];
  for (const w of (lock.waves || []).slice(1)) docs.push({ file: `docs/acceptance/WAVE-${w.wave}.md`, wave: w.wave, table: false });
  return docs;
}

/** Yhden dokumentin synkronointi lukkoon (LF-teksti sisään ja ulos). */
export function syncDoc(text, { lock, wave = null, table = false }) {
  let out = syncPushLines(text, { lock, wave });
  if (table) out = syncTableDeployTargets(out, { lock });
  return syncWaveShaArgs(syncSqlSourceRefs(out, { lock }), { lock });
}

if (process.argv[1] && process.argv[1].endsWith('train-map.mjs')) {
  const args = process.argv.slice(2);
  const git = createGit();
  if (args.includes('--write')) {
    const map = buildTrainMap({ git });
    for (const w of map.waves) {
      console.log(`${w.wave}  ${(w.deployTarget || '-------').slice(0, 7)}  ${w.ref}  ${w.consistent ? 'OK' : `VIRHE (${w.problem})`}`
        + (w.missingPatches && w.missingPatches.length ? `  UUDELLEENLEIKKAUS VAADITAAN: ${w.missingPatches.map(c => c.slice(0, 7)).join(', ')} puuttuu` : ''));
    }
    if (map.waves.some(w => !w.deployTarget)) {
      console.error('Lukkoa EI kirjoitettu: vähintään yksi alias puuttuu (ref puuttuu).');
      process.exit(1);
    }
    fs.writeFileSync(path.join(ROOT, LOCK_PATH), JSON.stringify(map, null, 2) + '\n');
    console.log(`kirjoitettu ${LOCK_PATH}`);
    process.exit(map.waves.every(w => w.consistent) ? 0 : 1);
  }
  const lock = readLock();
  if (args.includes('--sync-docs')) {
    if (!lock) { console.error('lukkoa ei voitu lukea'); process.exit(1); }
    for (const { file, wave, table } of pushLineDocs(lock)) {
      const full = path.join(ROOT, file);
      const before = fs.readFileSync(full, 'utf8');
      const crlf = before.includes('\r\n');
      let after = syncDoc(before.replace(/\r\n/g, '\n'), { lock, wave, table });
      if (crlf) after = after.replace(/\n/g, '\r\n');
      if (after !== before) { fs.writeFileSync(full, after); console.log(`päivitetty ${file}`); }
    }
    process.exit(0);
  }
  const result = checkTrainMap(lock, { git });
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const prod = result.production;
    console.log(`TUOTANTO (origin/main, paikallinen): ${prod.sha || 'ei saatavilla'} = ${prod.wave || '?'} (${prod.cacheVersion || '?'})`);
    for (const w of result.waves) {
      const locked = (lock && lock.waves.find(x => x.wave === w.wave)) || {};
      console.log(`${w.wave}  ${(locked.deployTarget || '-------').slice(0, 7)}  ${locked.ref || '-'}  ${w.ok ? 'OK' : 'VIRHE'}`
        + (w.missingPatches && w.missingPatches.length ? '  (UUDELLEENLEIKKAUS VAADITAAN ennen deployta)' : ''));
    }
    for (const p of result.problems) console.log(`VIRHE  ${p}`);
  }
  process.exit(result.ok ? 0 : 1);
}
