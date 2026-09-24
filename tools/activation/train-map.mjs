// Julkaisujunan C–J kartta gitistä: node tools/activation/train-map.mjs [--write]
//
// Lukee jokaisen aallon ehdokashaaran kärjen, aaltocommitin
// (Release-Wave-trailer), välimuistiversion ja porttimatriisin SIITÄ
// COMMITISTA — ei työpuusta — sekä todentaa, että jokainen aalto on
// edellisen jälkeläinen (git merge-base --is-ancestor). Tulos:
// docs/activation/release-train-c-j.json.
//
// Vaatii paikalliset haarat (ks. TRAIN alla). Ei verkkoa, ei kirjoituksia
// gitiin. Ilman --write tulostaa vain.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCacheVersion, parseGates } from '../release/state.mjs';
import {
  resolveWave, cacheVersionOf, cumulativeGates, COLUMN_GATES, waveIndex
} from '../release/waves.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = 'docs/activation/release-train-c-j.json';

/** Aallot, niiden deploykohteet (haara tai SHA), migraatio ja hyväksyntäpaketti. */
export const TRAIN = Object.freeze([
  { wave: 'C', ref: 'origin/main', migration: null, acceptance: 'docs/acceptance/WAVE-C-OWNER-ACCEPTANCE.md', status: 'DEPLOYED_NOT_ACCEPTED' },
  { wave: 'D', ref: '091e73c0091e8f135641e3501742b998dbac8461', migration: null, acceptance: 'docs/acceptance/WAVE-D.md', status: 'READY_FROZEN' },
  { wave: 'E', ref: 'release/activation-0003-0008', migration: null, acceptance: 'docs/acceptance/WAVE-E.md', status: 'READY_FROZEN' },
  { wave: 'F', ref: 'rehearsal/wave-f-v3', migration: '0009_finance_2.sql', acceptance: 'docs/acceptance/WAVE-F.md', status: 'READY_AFTER_MIGRATION' },
  { wave: 'G', ref: 'rehearsal/wave-g-v3', migration: '0010_goal_to_action.sql', acceptance: 'docs/acceptance/WAVE-G.md', status: 'READY_AFTER_MIGRATION' },
  { wave: 'H', ref: 'rehearsal/wave-h-v3', migration: '0011_personal_assistant.sql', acceptance: 'docs/acceptance/WAVE-H.md', status: 'READY_AFTER_MIGRATION' },
  { wave: 'I', ref: 'rehearsal/wave-i-v1', migration: '0012_life_alignment.sql', acceptance: 'docs/acceptance/WAVE-I.md', status: 'READY_AFTER_MIGRATION' },
  { wave: 'J', ref: 'rehearsal/wave-j-v1', migration: '0013_alignment_reality.sql', acceptance: 'docs/acceptance/WAVE-J.md', status: 'READY_AFTER_MIGRATION' }
]);

const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const show = (sha, file) => { try { return git(['show', `${sha}:${file}`]); } catch { return null; } };
const isAncestor = (a, b) => {
  try { execFileSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: ROOT, stdio: 'ignore' }); return true; }
  catch { return false; }
};

function waveCommit(fromSha, toSha, wave) {
  const log = git(['log', '--format=%H%x1f%B%x1e', `${fromSha}..${toSha}`]);
  const hits = log.split('\x1e').map(c => c.trim()).filter(Boolean)
    .map(c => c.split('\x1f')).filter(([, body]) => new RegExp(`^Release-Wave:\\s*${wave}\\s*$`, 'm').test(body || ''));
  return hits.length ? hits[0][0] : null;
}

export function buildTrainMap() {
  const waves = [];
  let previous = null;
  for (const entry of TRAIN) {
    const tip = git(['rev-parse', entry.ref]);
    const cache = parseCacheVersion(show(tip, 'sw.js'));
    const gates = parseGates(show(tip, 'src/data/schema.js'), { allowMissing: true });
    const resolved = gates ? resolveWave(gates) : null;
    const record = {
      wave: entry.wave,
      deployTarget: tip,
      ref: entry.ref,
      waveCommit: entry.wave === 'C' ? tip : (previous ? waveCommit(previous.deployTarget, tip, entry.wave) : null),
      parentWave: previous ? previous.wave : 'B',
      descendsFromParent: previous ? isAncestor(previous.deployTarget, tip) : null,
      cacheVersion: cache,
      expectedCacheVersion: cacheVersionOf(entry.wave),
      gateMatrixResolvesTo: resolved,
      gatesCumulative: [...cumulativeGates(entry.wave)],
      migration: entry.migration,
      preflight: entry.migration ? `supabase/preflight/preflight_${entry.migration.slice(0, 4)}.sql` : null,
      verify: entry.migration ? `supabase/verify/verify_${entry.migration.slice(0, 4)}.sql` : null,
      acceptance: entry.acceptance,
      status: entry.status,
      rollbackTarget: previous ? previous.wave : 'B'
    };
    // Sarakeportit eivät kuulu taulumatriisiin: auki täsmälleen siitä
    // aallosta alkaen, jolle COLUMN_GATES ne antaa.
    const schema = show(tip, 'src/data/schema.js') || '';
    record.columnGates = {};
    for (const [gate, openFrom] of Object.entries(COLUMN_GATES)) {
      const m = new RegExp(`export const ${gate} = (true|false);`).exec(schema);
      const actual = m ? m[1] === 'true' : false;
      const expected = waveIndex(entry.wave) >= waveIndex(openFrom);
      record.columnGates[gate] = { actual, expected };
    }
    record.consistent = record.cacheVersion === record.expectedCacheVersion
      && record.gateMatrixResolvesTo === entry.wave
      && (record.descendsFromParent !== false)
      && Object.values(record.columnGates).every(g => g.actual === g.expected);
    waves.push(record);
    previous = record;
  }
  return {
    generatedBy: 'tools/activation/train-map.mjs',
    originMain: git(['rev-parse', 'origin/main']),
    productBranch: { ref: 'feature/life-alignment-foundation', sha: git(['rev-parse', 'feature/life-alignment-foundation']) },
    waves
  };
}

if (process.argv[1] && process.argv[1].endsWith('train-map.mjs')) {
  const map = buildTrainMap();
  for (const w of map.waves) {
    console.log(`${w.wave}  ${w.deployTarget.slice(0, 7)}  wave=${(w.waveCommit || '-').slice(0, 7)}  ${w.cacheVersion}/${w.expectedCacheVersion}  matrix=${w.gateMatrixResolvesTo}  parent=${w.parentWave}:${w.descendsFromParent}  ${w.consistent ? 'OK' : 'VIRHE'}`);
  }
  const bad = map.waves.filter(w => !w.consistent);
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.join(ROOT, 'docs/activation'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, OUT), JSON.stringify(map, null, 2) + '\n');
    console.log(`kirjoitettu ${OUT}`);
  }
  process.exit(bad.length ? 1 : 0);
}
