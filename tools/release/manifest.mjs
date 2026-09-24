// Julkaisumanifesti: mikä commit on minkäkin aallon deploykohde.
//
// MIKSI TÄMÄ ON OLEMASSA
//
// Juna on viisi erillistä tuotantodeployta, joiden väliin jää päiviä.
// Jokaisen väliin jää myös kysymys, johon on pystyttävä vastaamaan
// yksiselitteisesti: mikä SHA on seuraavaksi menossa tuotantoon, ja
// mihin se perutaan jos se epäonnistuu.
//
// Ilman manifestia vastaus etsittäisiin git-lokista muistin varassa,
// aallon nimen ja commitviestin perusteella. Sellainen vastaus voi olla
// väärä, eikä sitä voi tarkistaa koneellisesti.
//
// MITEN AALTOJEN COMMITIT TUNNISTETAAN
//
// Jokaisessa aaltocommitissa on trailer
//
//     Release-Wave: A
//
// Se ei ole kosmetiikkaa vaan koneellisesti luettava merkintä. Manifesti
// rakennetaan siitä, ja todennus lukee jokaisen aaltocommitin
// `src/data/schema.js`:n ja `sw.js`:n SIITÄ COMMITISTA — ei työpuusta.
//
// Juuri se tekee todennuksesta jotain muuta kuin kehän: manifesti
// väittää, että commit X on aalto A, ja todennus avaa commitin X ja
// tarkistaa, että sen porttimatriisi ja välimuistiversio ovat todella
// aallon A mukaiset.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  ALL_GATES, BASE, PRODUCTION, WAVES, cacheVersionOf, cumulativeGates,
  expectedMatrix, rollbackTargetOf
} from './waves.mjs';
import { gateDependencyMap } from './dependencies.mjs';
import { parseCacheVersion, parseGates, parseTaskExtendedFields } from './state.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

export const MANIFEST_PATH = 'docs/activation-0003-0008-release-manifest.json';

export const PRODUCTION_URL = 'https://manifestival-ten.vercel.app';

/**
 * Aja git ja palauta tuloste, tai null jos komento epäonnistuu.
 *
 * `cwd` on valinnainen ja oletuksena tämä repositorio. Sen avulla
 * SAMAA git-objektikantaa voi kysyä toisen työpuun (esim. `git
 * worktree add --detach`) näkökulmasta -- HEAD ratkeaa SIINÄ
 * työpuussa, objektit ovat silti samat. Ks. `tools/release/lineage.mjs`,
 * `isDetachedHead` ja `waveOfCommit`.
 */
export function git(args, cwd = ROOT) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** Onko git käytettävissä ja ollaanko repositoriossa? */
export function gitAvailable(cwd = ROOT) {
  return git(['rev-parse', '--git-dir'], cwd) !== null;
}

/** Tiedoston sisältö tietyssä commitissa, tai null. */
export function fileAtCommit(sha, relativePath) {
  return git(['show', `${sha}:${relativePath}`]);
}

/**
 * `Release-Wave:`-trailer. Tunnisteet luetaan `WAVES`-määrittelystä eikä
 * kirjoiteta käsin: aiempi `[A-E]` jätti aallot F–J tunnistamatta, joten
 * yhtäkään migraatioaallon committia ei olisi voitu kirjata manifestiin
 * (todettu rakentamalla aallon F harjoittelukandidaatti).
 */
export const RELEASE_WAVE_TRAILER = new RegExp(
  `^Release-Wave:\\s*(BASE|${WAVES.map(w => w.id).join('|')})\\s*$`, 'm');

/**
 * Aaltojen commitit `Release-Wave:`-trailerin perusteella.
 *
 * Etsitään perustilasta HEADiin. Jos aallolla on useampi commit,
 * VIIMEISIN voittaa — aaltoa on silloin korjattu, ja korjattu versio
 * on se joka deployataan.
 *
 * @returns {object} aaltotunniste -> SHA
 */
export function discoverWaveCommits(from = PRODUCTION.sha, to = 'HEAD') {
  const shas = {};
  if (!gitAvailable()) return shas;

  const log = git(['log', '--format=%H%x1f%B%x1e', `${from}..${to}`]);
  if (log === null) return shas;

  // Vanhimmasta uusimpaan, jotta uusin jää voimaan.
  const commits = log.split(String.fromCharCode(30)).map(c => c.trim()).filter(Boolean).reverse();

  for (const commit of commits) {
    const [sha, body] = commit.split(String.fromCharCode(31));
    if (!sha || !body) continue;
    const match = RELEASE_WAVE_TRAILER.exec(body);
    if (match) shas[match[1]] = sha.trim();
  }
  return shas;
}

/**
 * Rakenna manifesti. Tuntemattomat SHA:t jäävät nulliksi — manifesti on
 * hyödyllinen ja todennettavissa myös vajaana, ja vajaus on rehellisempi
 * kuin keksitty tunniste.
 */
export function buildManifest(shas = discoverWaveCommits()) {
  const dependencies = gateDependencyMap();

  const waves = WAVES.map(wave => {
    const cumulative = [...cumulativeGates(wave.id)];
    const rollbackTarget = rollbackTargetOf(wave.id);

    // Riippuvuudet, jotka TÄMÄ aalto perii aiemmilta aalloilta.
    const inherited = new Set();
    for (const gate of wave.gates) {
      for (const parent of dependencies[gate] || []) {
        if (!wave.gates.includes(parent)) inherited.add(parent);
      }
    }

    return {
      id: wave.id,
      title: wave.title,
      commitSha: shas[wave.id] || null,
      cacheVersion: wave.cacheVersion,
      readiness: wave.readiness,
      gatesEnabled: [...wave.gates],
      gatesCumulative: cumulative,
      gatesDisabled: ALL_GATES.filter(g => !cumulative.includes(g)),
      tables: [...wave.tables],
      dependencies: [...inherited].sort(),
      rollbackTarget,
      rollbackSha: shas[rollbackTarget] || null,
      acceptancePack: `docs/acceptance/WAVE-${wave.id}.md`,
      requiredAcceptance: [
        `npm run activation:verify-wave -- ${wave.id}`,
        `npm run activation:preflight -- --wave=${wave.id}`,
        `npm run production:verify-assets -- --wave=${wave.id}`,
        'selainhyväksyntä: luonti, muokkaus, poisto, säilyvyys sivun latauksen yli',
        'supabase/acceptance/verify_0003_0008_post_activation.sql'
      ],
      rationale: wave.rationale
    };
  });

  return {
    schemaVersion: 2,
    package: 'activation-0003-0008',
    productionUrl: PRODUCTION_URL,
    /** Tuotannossa juuri nyt. Perustilan korjauksen peruutuskohde. */
    productionSha: PRODUCTION.sha,
    productionCacheVersion: PRODUCTION.cacheVersion,
    /** Korjattu pohja, jolta juna lähtee. Kaikki kymmenen porttia kiinni. */
    baseSha: shas.BASE || null,
    baseCacheVersion: BASE.cacheVersion,
    gateDependencies: dependencies,
    waves
  };
}

/** Manifesti levyltä, tai null. */
export function readManifest() {
  const full = path.join(ROOT, MANIFEST_PATH);
  if (!fs.existsSync(full)) return null;
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch {
    return null;
  }
}

/** Kirjoita manifesti levylle. */
export function writeManifest(manifest) {
  fs.writeFileSync(
    path.join(ROOT, MANIFEST_PATH),
    JSON.stringify(manifest, null, 2) + String.fromCharCode(10),
    'utf8');
}

/**
 * Todenna manifesti.
 *
 * Rakenne tarkistetaan aina. SHA:lliset aallot tarkistetaan lisäksi
 * GIT-HISTORIASTA: commit avataan ja sen porttimatriisi, välimuistiversio
 * ja TASK_EXTENDED_FIELDS luetaan siitä. Nullilla merkitty aalto on
 * kelvollinen — sitä ei ole vielä commitoitu.
 *
 * @returns {string[]} ongelmat; tyhjä lista tarkoittaa kunnossa olevaa
 */
export function validateManifest(manifest, { checkGit = true } = {}) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object') return ['manifestia ei voitu lukea'];

  const expected = buildManifest(Object.assign(
    { BASE: manifest.baseSha || null },
    Object.fromEntries(WAVES.map(w => {
      const wave = (manifest.waves || []).find(x => x && x.id === w.id);
      return [w.id, wave ? wave.commitSha : null];
    }))));

  if (manifest.productionSha !== PRODUCTION.sha) {
    problems.push(`productionSha on ${manifest.productionSha}, odotettiin ${PRODUCTION.sha}`);
  }
  if (manifest.productionCacheVersion !== PRODUCTION.cacheVersion) {
    problems.push('productionCacheVersion ei vastaa tuotannon versiota');
  }
  if (manifest.baseSha !== null && !/^[0-9a-f]{40}$/.test(String(manifest.baseSha || ''))) {
    problems.push(`baseSha ei ole 40 merkin SHA: ${manifest.baseSha}`);
  }
  if (manifest.baseCacheVersion !== BASE.cacheVersion) {
    problems.push(
      `baseCacheVersion on ${manifest.baseCacheVersion}, odotettiin ${BASE.cacheVersion}`);
  }
  if (manifest.productionUrl !== PRODUCTION_URL) {
    problems.push(`productionUrl on ${manifest.productionUrl}, odotettiin ${PRODUCTION_URL}`);
  }

  // PERUSTILAN KORJAUS TODENNETAAN SAMALLA TAVALLA KUIN AALLOT.
  //
  // Se on junan ensimmäinen deploy ja aallon A peruutuskohde, joten sen
  // on oltava täsmälleen se mitä manifesti väittää: kaikki kymmenen
  // porttia kiinni ja välimuistiversio v13.
  if (checkGit && manifest.baseSha && gitAvailable()) {
    const schema = fileAtCommit(manifest.baseSha, 'src/data/schema.js');
    if (schema === null) {
      problems.push(`perustilan committia ${manifest.baseSha} ei löydy historiasta`);
    } else {
      const gates = parseGates(schema, { allowMissing: true });
      if (!gates) problems.push('perustilan schema.js:n porttilohkoa ei voitu lukea');
      else {
        const auki = ALL_GATES.filter(gate => gates[gate]);
        if (auki.length > 0) {
          problems.push(`perustilassa on auki olevia portteja: ${auki.join(', ')}`);
        }
      }
      if (!parseTaskExtendedFields(schema)) {
        problems.push('perustilassa TASK_EXTENDED_FIELDS ei ole true');
      }
      const versio = parseCacheVersion(fileAtCommit(manifest.baseSha, 'sw.js') || '');
      if (versio !== BASE.cacheVersion) {
        problems.push(
          `perustilan CACHE_VERSION on ${versio || 'lukematon'},`
          + ` odotettiin ${BASE.cacheVersion}`);
      }
    }
  }

  const waves = Array.isArray(manifest.waves) ? manifest.waves : [];
  if (waves.length !== WAVES.length) {
    problems.push(`manifestissa on ${waves.length} aaltoa, odotettiin ${WAVES.length}`);
    return problems;
  }

  for (let i = 0; i < WAVES.length; i++) {
    const wave = waves[i];
    const odotettu = expected.waves[i];

    if (wave.id !== odotettu.id) {
      problems.push(`aalto ${i + 1}: tunniste on ${wave.id}, odotettiin ${odotettu.id}`);
      continue;
    }

    for (const kentta of ['cacheVersion', 'rollbackTarget', 'acceptancePack',
                          'title', 'readiness']) {
      if (wave[kentta] !== odotettu[kentta]) {
        problems.push(
          `${wave.id}.${kentta}: on ${JSON.stringify(wave[kentta])}, `
          + `odotettiin ${JSON.stringify(odotettu[kentta])}`);
      }
    }

    for (const kentta of ['gatesEnabled', 'gatesCumulative', 'gatesDisabled',
                          'tables', 'dependencies']) {
      const on = JSON.stringify(wave[kentta]);
      const pitaisi = JSON.stringify(odotettu[kentta]);
      if (on !== pitaisi) {
        problems.push(`${wave.id}.${kentta}: on ${on}, odotettiin ${pitaisi}`);
      }
    }

    // Portti ei saa olla sekä auki että kiinni, eikä kadota.
    const kaikki = [...(wave.gatesCumulative || []), ...(wave.gatesDisabled || [])].sort();
    if (kaikki.join(',') !== [...ALL_GATES].sort().join(',')) {
      problems.push(
        `${wave.id}: auki ja kiinni yhdessä eivät kata kymmentä porttia kertaalleen`);
    }

    if (wave.commitSha !== null && !/^[0-9a-f]{40}$/.test(String(wave.commitSha || ''))) {
      problems.push(`${wave.id}.commitSha ei ole 40 merkin SHA: ${wave.commitSha}`);
      continue;
    }

    // Peruutuskohteen SHA:n on vastattava sitä aaltoa, johon perutaan.
    if (wave.rollbackTarget === 'BASE') {
      if (wave.rollbackSha !== manifest.baseSha) {
        problems.push(`${wave.id}.rollbackSha ei ole perustilan korjauksen SHA`);
      }
    } else {
      const kohde = waves.find(w => w.id === wave.rollbackTarget);
      if (kohde && wave.rollbackSha !== kohde.commitSha) {
        problems.push(
          `${wave.id}.rollbackSha ei vastaa aallon ${wave.rollbackTarget} committia`);
      }
    }

    if (!checkGit || wave.commitSha === null || !gitAvailable()) continue;

    // -------- COMMITIN OMA SISÄLTÖ --------
    // Tässä manifesti lakkaa olemasta väite ja alkaa olla todistettu.

    const schema = fileAtCommit(wave.commitSha, 'src/data/schema.js');
    if (schema === null) {
      problems.push(`${wave.id}: committia ${wave.commitSha} ei löydy historiasta`);
      continue;
    }

    const gates = parseGates(schema, { allowMissing: true });
    if (!gates) {
      problems.push(`${wave.id}: commitin schema.js:n porttilohkoa ei voitu lukea`);
    } else {
      const odotettuMatriisi = expectedMatrix(wave.id);
      for (const gate of ALL_GATES) {
        if (gates[gate] !== odotettuMatriisi[gate]) {
          problems.push(
            `${wave.id} (${wave.commitSha.slice(0, 7)}): ${gate} on `
            + `${gates[gate] ? 'auki' : 'kiinni'}, aallossa pitäisi olla `
            + `${odotettuMatriisi[gate] ? 'auki' : 'kiinni'}`);
        }
      }
    }

    if (!parseTaskExtendedFields(schema)) {
      problems.push(`${wave.id}: TASK_EXTENDED_FIELDS ei ole true tuossa commitissa`);
    }

    const sw = fileAtCommit(wave.commitSha, 'sw.js');
    const versio = parseCacheVersion(sw || '');
    if (versio !== cacheVersionOf(wave.id)) {
      problems.push(
        `${wave.id} (${wave.commitSha.slice(0, 7)}): CACHE_VERSION on `
        + `${versio || 'lukematon'}, odotettiin ${cacheVersionOf(wave.id)}`);
    }
  }

  return problems;
}
