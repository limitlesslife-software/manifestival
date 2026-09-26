// Tuotannon staattisten tiedostojen lukeminen ja todentaminen (ACT-06).
//
// MITÄ TÄMÄ TEKEE
//
// `readLiveState()` hakee tuotannosta ne julkiset staattiset tiedostot,
// joista deployn tila voidaan lukea, ja jäsentää ne: välimuistiversio,
// porttimatriisi, sarakeportit, tunnusmerkit ja jokaisen haetun
// tiedoston sha256. `verifyLive()` vertaa tilaa odotettuun aaltoon —
// tai peruutukseen (ACT-10) — ja halutessa SORMENJÄLKEEN: jokaisen
// sw.js:n SHELL-tiedoston tavut tuotannossa vs `git show <sha>:<polku>`.
// `identifySha()` kertoo, mikä ehdokas-SHA tuotannossa on.
//
// MIKSI SORMENJÄLKI
//
// sw.js ja schema.js eivät erota kahta committia, joilla on sama aalto:
// aallon J aaltocommit e96942c ja deploykohde 5df40b2 ovat niiden osalta
// identtiset, mutta eroavat src/app/*.js:ssä (Day 1 -korjaukset).
// Tuotannossa ei ole build-SHA:ta eikä version.json-tiedostoa, joten
// SHA päätellään tiedostojen sisällöstä.
//
// MITÄ TÄMÄ EI TEE, EIKÄ SAA TEHDÄ
//
//   - ei kirjautumista, ei tunnuksia, ei evästeitä
//   - ei POST/PUT/PATCH/DELETE-pyyntöjä, vain GET
//   - ei /api/-kutsuja (ne maksavat ja koskevat AI-rajapintaan)
//   - ei Supabase-kutsuja
//   - ei kirjoituksia mihinkään
//
// `fetchImpl` on injektoitava: testit antavat tyngän, joka tarjoilee
// `git show <ref>:<polku>` -sisältöä. Yksikään testi ei ota verkkoa.

import { createHash } from 'node:crypto';

import { parseCacheVersion, parseGates, parseTaskExtendedFields } from './state.mjs';
import {
  ALL_GATES, COLUMN_GATES, cacheVersionOf, classifyDeployedState, expectedMatrix,
  rollbackTargetOf, waveById, waveIndex
} from './waves.mjs';

export const PRODUCTION_URL = 'https://manifestival-ten.vercel.app';

/** Tiedostot, jotka luetaan aina. */
export const CORE_PATHS = Object.freeze([
  '/', '/sw.js', '/src/data/schema.js', '/src/domain/wellbeing.js', '/src/data/collectionsRepo.js'
]);

/** Odotetut turvaotsakkeet (vercel.json). */
export const SECURITY_HEADERS = Object.freeze([
  ['x-frame-options', 'DENY'],
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'strict-origin-when-cross-origin']
]);

/** Tunnusmerkit, jotka menivät tuotantoon perusdeployssa. */
export const MARKERS = Object.freeze([
  { path: '/src/domain/wellbeing.js', name: 'wellbeing.js: tyhjä arvo ei muutu nollaksi', pattern: /TYHJÄ EI OLE NOLLA/ },
  { path: '/src/data/collectionsRepo.js', name: 'collectionsRepo.js: aikaleima jätetään pois kun sitä ei ole', pattern: /occurred_at: entry\.timestamp/ }
]);

const FORBIDDEN_PATH = /^\/api\//;

/**
 * Komentorivien verkkohaku: VAIN GET, ei tunnuksia, ei /api/-polkuja.
 * Kääre pakottaa metodin riippumatta siitä, mitä kutsuja antaa.
 */
export async function getOnlyFetch(url, init = {}) {
  if (FORBIDDEN_PATH.test(new URL(url).pathname)) throw new Error(`kielletty polku: ${url}`);
  return globalThis.fetch(url, { ...init, method: 'GET', credentials: 'omit' });
}

export function sha256(content) {
  return createHash('sha256').update(content === null || content === undefined ? '' : content).digest('hex');
}

/** Sarakeporttien arvot schema.js:n lähteestä. Puuttuva = kiinni. */
export function parseColumnGates(source) {
  const gates = {};
  for (const gate of Object.keys(COLUMN_GATES)) {
    const match = new RegExp(`export const ${gate} = (true|false);`).exec(source || '');
    gates[gate] = match ? match[1] === 'true' : false;
  }
  return gates;
}

/** sw.js:n SHELL-lista (polut '/'-alkuisina), tai []. */
export function parseShellList(swSource) {
  const match = /const SHELL = \[([\s\S]*?)\];/.exec(swSource || '');
  if (!match) return [];
  return [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
}

/** Tuotannon polku -> repon polku ('/' -> index.html). */
export function repoPathOf(livePath) {
  return livePath === '/' ? 'index.html' : livePath.replace(/^\//, '');
}

/**
 * Yksi GET. Ei tunnuksia, ei evästeitä, ei /api/-polkuja.
 */
async function get(fetchImpl, baseUrl, livePath) {
  if (FORBIDDEN_PATH.test(livePath)) throw new Error(`kielletty polku: ${livePath}`);
  const response = await fetchImpl(baseUrl + livePath, {
    method: 'GET',
    redirect: 'follow',
    credentials: 'omit',
    headers: { 'cache-control': 'no-cache' }
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, bytes };
}

/**
 * Lue tuotannon tila.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl]
 * @param {Function} [options.fetchImpl] fetch-yhteensopiva (testit: tynkä)
 * @param {string[]} [options.paths] lisäpolut sormenjälkeä varten
 * @returns {Promise<object>} ks. palautusarvo alla; `errors` kertoo
 *   tavoittamattomat polut (ei heitä)
 */
export async function readLiveState({ baseUrl = PRODUCTION_URL, fetchImpl = globalThis.fetch, paths = [] } = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const wanted = [...new Set([...CORE_PATHS, ...paths])];
  const files = {};
  const statuses = {};
  const errors = [];
  const bodies = {};
  let rootHeaders = null;

  // Enintään kahdeksan samanaikaista GET-pyyntöä: sormenjälki hakee
  // koko SHELL-listan (~100 tiedostoa), eikä peräkkäinen haku ole
  // tarpeen, mutta palvelinta ei myöskään kuormiteta kerralla.
  const queue = [...wanted];
  const worker = async () => {
    while (queue.length) {
      const livePath = queue.shift();
      try {
        const r = await get(fetchImpl, base, livePath);
        statuses[livePath] = r.status;
        if (livePath === '/') rootHeaders = r.headers;
        if (r.status === 200) {
          files[livePath] = sha256(r.bytes);
          bodies[livePath] = r.bytes;
        }
      } catch (err) {
        errors.push(`${livePath}: ${err && err.message ? err.message : err}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, wanted.length) }, worker));

  const text = livePath => (bodies[livePath] ? bodies[livePath].toString('utf8') : '');
  const schema = text('/src/data/schema.js');
  const gates = parseGates(schema, { allowMissing: true });
  const cacheVersion = parseCacheVersion(text('/sw.js'));
  const headers = {};
  for (const [name] of SECURITY_HEADERS) headers[name] = rootHeaders ? rootHeaders.get(name) : null;
  const deployed = classifyDeployedState({ gates, cacheVersion });

  return {
    baseUrl: base,
    status: statuses['/'] ?? null,
    statuses,
    headers,
    cacheVersion,
    gates,
    columnGates: parseColumnGates(schema),
    taskExtended: parseTaskExtendedFields(schema),
    markers: Object.fromEntries(MARKERS.map(m => [m.name, statuses[m.path] === 200 && m.pattern.test(text(m.path))])),
    wave: gates ? deployed.matrixWave : null,
    state: deployed,
    shell: parseShellList(text('/sw.js')),
    files,
    errors
  };
}

/**
 * Sormenjälki commitista: SHELL-polku -> sha256(git show <sha>:<polku>).
 *
 * @param {string} sha
 * @param {(sha: string, path: string) => (Buffer|string|null)} gitShow
 * @returns {{files: object, missing: string[]}|null} null jos sw.js puuttuu
 */
export function fingerprintOf(sha, gitShow, preload = null) {
  const sw = gitShow(sha, 'sw.js');
  if (sw === null || sw === undefined) return null;
  const shell = parseShellList(Buffer.isBuffer(sw) ? sw.toString('utf8') : sw);
  // Valinnainen eräluku (git cat-file --batch): ~100 tiedostoa yhdellä
  // prosessilla sadan sijaan.
  if (typeof preload === 'function') preload(sha, shell.map(repoPathOf));
  const files = {};
  const missing = [];
  for (const livePath of ['/sw.js', ...shell]) {
    const content = gitShow(sha, repoPathOf(livePath));
    if (content === null || content === undefined) missing.push(livePath);
    else files[livePath] = sha256(content);
  }
  return { files, missing };
}

/**
 * Todenna tuotannon tila.
 *
 * @param {object} live readLiveState()-tulos
 * @param {object} options
 * @param {string} [options.wave] odotettu aalto
 * @param {string} [options.rollbackOf] odotettu tila on TÄMÄN aallon
 *   peruutus (ACT-10): matriisi = edellinen aalto, välimuisti > aallon oma
 * @param {string} [options.sha] odotettu commit (sormenjälki)
 * @param {Function} [options.gitShow] (sha, polku) -> sisältö; pakollinen
 *   kun `sha` annetaan
 * @returns {string[]} ongelmat; tyhjä = täsmää
 */
export function verifyLive(live, { wave = null, rollbackOf = null, sha = null, gitShow = null, preload = null } = {}) {
  const problems = [];
  if (!wave && !rollbackOf) return ['odotettua aaltoa ei annettu (wave tai rollbackOf)'];
  const matrixWave = rollbackOf ? rollbackTargetOf(rollbackOf) : wave;
  if (!waveById(matrixWave)) return [`tuntematon aalto: ${matrixWave}`];

  for (const error of live.errors || []) problems.push(`haku epäonnistui: ${error}`);
  if (live.status !== 200) problems.push(`sovellus vastasi HTTP ${live.status ?? '-'}, odotettiin 200`);
  for (const [name, expected] of SECURITY_HEADERS) {
    if (live.headers[name] !== expected) {
      problems.push(`turvaotsake ${name} on ${live.headers[name] || 'puuttuu'}, odotettiin ${expected}`);
    }
  }
  // Vain ydinpolut tarkistetaan tässä. Sormenjälkeä varten haettuja
  // MUIDEN ehdokkaiden polkuja ei ole odotetussa commitissa (404 on
  // silloin oikea vastaus); odotetun commitin polut tarkistetaan alla.
  for (const path of CORE_PATHS) {
    const status = (live.statuses || {})[path];
    if (status !== undefined && status !== 200) problems.push(`${path} vastasi HTTP ${status}`);
  }

  // Välimuisti.
  const number = v => { const m = /^v(\d+)$/.exec(String(v)); return m ? Number(m[1]) : null; };
  if (rollbackOf) {
    const floor = number(cacheVersionOf(rollbackOf));
    if (number(live.cacheVersion) === null || number(live.cacheVersion) <= floor) {
      problems.push(`peruutuksen välimuisti on ${live.cacheVersion || 'lukematon'}, `
        + `odotettiin suurempaa kuin ${cacheVersionOf(rollbackOf)} (peruutus on deploy ja nostaa aina)`);
    }
  } else if (live.cacheVersion !== cacheVersionOf(wave)) {
    let hint = '';
    const state = classifyDeployedState({ gates: live.gates, cacheVersion: live.cacheVersion });
    if (state.state === 'ROLLBACK') hint = ` — tila näyttää aallon ${state.rollbackOf} peruutukselta: todenna --rollback-of=${state.rollbackOf}`;
    problems.push(`CACHE_VERSION on ${live.cacheVersion || 'lukematon'}, aalto ${wave} edellyttää ${cacheVersionOf(wave)}${hint}`);
  }

  // Porttimatriisi.
  if (!live.gates) {
    problems.push('schema.js:n porttilohkoa ei voitu jäsentää (tuntematon ylimääräinen portti?)');
  } else {
    const expected = expectedMatrix(matrixWave);
    for (const gate of ALL_GATES) {
      if (live.gates[gate] !== expected[gate]) {
        problems.push(`portti ${gate}: tuotannossa ${live.gates[gate] ? 'auki' : 'kiinni'}, `
          + `aallossa ${matrixWave} pitää olla ${expected[gate] ? 'auki' : 'kiinni'}`);
      }
    }
  }

  // Sarakeportit: auki täsmälleen siitä aallosta alkaen, jolle COLUMN_GATES ne antaa.
  for (const [gate, openFrom] of Object.entries(COLUMN_GATES)) {
    const expected = waveIndex(matrixWave) >= waveIndex(openFrom);
    const actual = live.columnGates ? live.columnGates[gate] === true : false;
    if (actual !== expected) {
      problems.push(`sarakeportti ${gate}: tuotannossa ${actual ? 'auki' : 'kiinni'}, `
        + `aallossa ${matrixWave} pitää olla ${expected ? 'auki' : 'kiinni'}`);
    }
  }

  if (!live.taskExtended) problems.push('TASK_EXTENDED_FIELDS ei ole true tuotannossa');
  for (const [name, ok] of Object.entries(live.markers || {})) {
    if (!ok) problems.push(`tunnusmerkki puuttuu: ${name}`);
  }

  // Sormenjälki.
  if (sha) {
    if (typeof gitShow !== 'function') {
      problems.push('sormenjälkeä ei voitu laskea: gitShow puuttuu');
    } else {
      const fp = fingerprintOf(sha, gitShow, preload);
      if (!fp) {
        problems.push(`commitin ${sha} sw.js:ää ei löydy: sormenjälkeä ei voitu laskea`);
      } else {
        for (const path of fp.missing) problems.push(`sormenjälki: ${path} puuttuu commitista ${sha.slice(0, 7)}`);
        for (const [path, digest] of Object.entries(fp.files)) {
          const status = (live.statuses || {})[path];
          if (status !== undefined && status !== 200) problems.push(`sormenjälki: ${path} vastasi HTTP ${status}`);
          else if (!(path in live.files)) problems.push(`sormenjälki: ${path} ei haettu tuotannosta`);
          else if (live.files[path] !== digest) {
            problems.push(`sormenjälki: ${path} eroaa commitista ${sha.slice(0, 7)}`);
          }
        }
      }
    }
  }

  return problems;
}

/**
 * Mikä ehdokkaista on tuotannossa?
 *
 * @param {object} live readLiveState()-tulos (sormenjälkipolut haettuina)
 * @param {{sha: string, files: object}[]} candidates fingerprintOf()-tulokset
 * @returns {string|null} ainoa täsmäävä SHA, tai null (ei yhtään tai useita)
 */
export function identifySha(live, candidates) {
  const matches = candidates.filter(candidate => {
    const entries = Object.entries(candidate.files || {});
    if (!entries.length) return false;
    return entries.every(([path, digest]) => live.files[path] === digest);
  });
  return matches.length === 1 ? matches[0].sha : null;
}

/** Sormenjäljen polut ehdokkaille: kaikkien SHELL-listojen unioni. */
export function fingerprintPaths(candidates) {
  const paths = new Set();
  for (const c of candidates) for (const p of Object.keys(c.files || {})) paths.add(p);
  return [...paths];
}
