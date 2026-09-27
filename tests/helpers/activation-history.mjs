// Tynkähistoria aktivoinnin työkalujen testeille: git-kerros, tiedostojärjestelmä
// ja tuotannon fetch ilman oikeaa gitiä, levyä tai verkkoa.
//
// Juna C–K rakennetaan synteettisistä SHA:ista (aalto i -> '0i' * 20).
// Jokaisella aallolla on oma sw.js (välimuisti), schema.js (portit ja
// sarakeportit), index.html ja yksi moduuli. Lukon SQL-lähdeaallon
// (SQL_SOURCE_WAVE = K) commitissa ovat migraatiot, esitarkistukset ja
// varmistukset 0009–0014; aallon J commitissa vain 0009–0013 (kuten
// oikeassa historiassa). Tuotehaaran HEAD sisältää samat SQL-tiedostot
// kuin lähde.
//
// Aallot luetaan junasta (TRAIN), joten uusi lukittu aalto tulee tynkään
// ilman käsin ylläpidettyä listaa.
//
// Git-tynkä kirjaa jokaisen kutsun (`calls`), joten testit voivat todistaa,
// ettei push- tai update-ref-kutsua tehty.

import path from 'node:path';

import {
  ALL_GATES, COLUMN_GATES, WAVES, cacheVersionOf, expectedMatrix, preflightPathOf,
  verifyPathOf, waveIndex
} from '../../tools/release/waves.mjs';
import { SQL_SOURCE_WAVE, TRAIN, buildTrainMap } from '../../tools/activation/train-map.mjs';
import { SECURITY_HEADERS } from '../../tools/release/live-assets.mjs';
import { BASE_FILES } from '../../tools/release/preflight-checks.mjs';

export const TRAIN_WAVES = Object.freeze(TRAIN.map(entry => entry.wave));
/** Junan viimeinen (uusin lukittu) aalto. */
export const LAST_WAVE = TRAIN_WAVES[TRAIN_WAVES.length - 1];
export const shaOf = wave => (TRAIN_WAVES.indexOf(wave) + 1).toString(16).padStart(2, '0').repeat(20);
export const HEAD_SHA = 'ab'.repeat(20);

function schemaFor(wave, overrides = {}) {
  const matrix = expectedMatrix(wave);
  const gates = ALL_GATES.map(g => `  ${g}: ${matrix[g]},`).join('\n');
  const columns = Object.entries(COLUMN_GATES)
    .map(([g, from]) => `export const ${g} = ${g in overrides ? overrides[g] : waveIndex(wave) >= waveIndex(from)};`)
    .join('\n');
  return `export const TABLES = Object.freeze({\n${gates}\n});\nexport function hasTable(name) {}\n`
    + `export const TASK_EXTENDED_FIELDS = true;\n${columns}\n`;
}

function swFor(wave, cache = cacheVersionOf(wave)) {
  return `const CACHE_VERSION = '${cache}';\nconst SHELL = [\n  '/',\n  '/src/app/main.js',\n  '/src/domain/wellbeing.js',\n  '/src/data/collectionsRepo.js'\n];\n`;
}

/** Synteettinen tarkistus-SQL: `n` tarkistusta (score-sql-result laskee ne). */
export function checkSql(n, label) {
  const rows = Array.from({ length: n }, (_, i) =>
    `  select '${String(i + 1).padStart(2, '0')}'::text as check_no, '${label}'::text as section`).join('\n  union all\n');
  return `-- ${label}\nselect * from (\n${rows}\n) c;\n`;
}

/** Tarkistustaulukko (sarkain) liitettäväksi: `fail` FAIL-riviä, `poikkeavia`. */
export function checkResult(n, { fail = 0, poikkeavia = fail, drop = 0 } = {}) {
  const header = 'check_no\tsection\tcheck_name\tstatus\tdetails\tpoikkeavia_yhteensa';
  const lines = [];
  for (let i = 1; i <= n - drop; i++) {
    const status = i <= fail ? 'FAIL' : (i === n - drop ? 'INFO' : 'PASS');
    lines.push(`${String(i).padStart(2, '0')}\tosio\ttarkistus ${i}\t${status}\todotus 1, toteutui ${status === 'FAIL' ? 0 : 1}\t${poikkeavia}`);
  }
  return [header, ...lines].join('\n');
}

export const PREFLIGHT_CHECKS = 16;
export const VERIFY_CHECKS = 30;

/** docs/PRODUCTION-STATUS.md:n porttitaulukko, joka vastaa aallon matriisia. */
function statusDocFor(wave) {
  const matrix = expectedMatrix(wave);
  return ALL_GATES.map(g => `| \`${g}\` | 00xx | ${matrix[g] ? 'AKTIVOITU' : 'kiinni'} |`).join('\n') + '\n';
}

/** Tiedostot jokaiselle aallolle (repoChecks: BASE_FILES + tilannedokumentti). */
function filesFor(wave, { cache } = {}) {
  const files = {
    ...Object.fromEntries(BASE_FILES.map(f => [f, `-- ${f}\n`])),
    'docs/PRODUCTION-STATUS.md': statusDocFor(wave),
    'sw.js': swFor(wave, cache),
    'src/data/schema.js': schemaFor(wave),
    'index.html': `<!doctype html><title>${wave}</title>`,
    'src/app/main.js': `// aalto ${wave}\n`,
    'src/domain/wellbeing.js': '// TYHJÄ EI OLE NOLLA\n',
    'src/data/collectionsRepo.js': 'const row = { occurred_at: entry.timestamp };\n'
  };
  for (const w of WAVES.filter(x => x.migration && waveIndex(x.id) <= waveIndex(wave))) {
    files[w.migrationFile] = `-- migraatio ${w.migration}\n`;
  }
  return files;
}

/** SQL-tiedostot aaltoon `upTo` asti (oletus: kaikki junan migraatiot). */
function sqlFiles(upTo = null) {
  const files = {};
  for (const w of WAVES.filter(x => x.migration && (upTo === null || waveIndex(x.id) <= waveIndex(upTo)))) {
    files[w.migrationFile] = `-- migraatio ${w.migration}\n`;
    files[preflightPathOf(w.migration)] = checkSql(PREFLIGHT_CHECKS, `preflight ${w.migration}`);
    files[verifyPathOf(w.migration)] = checkSql(VERIFY_CHECKS, `verify ${w.migration}`);
  }
  return files;
}

/**
 * Tynkä-git.
 *
 * @param {object} [options]
 * @param {string} [options.production] tuotannon aalto (origin/main)
 * @param {object} [options.refOverrides] alias -> SHA (siirtynyt viite)
 * @param {string[]} [options.missingRefs] aliakset, joita ei ole
 * @param {string[]} [options.missingPatchWaves] aallot, joilta 5aa0d53 puuttuu
 * @param {object} [options.missingPatches] muut korjaukset: 7 merkin SHA -> aallot, joilta se puuttuu
 * @param {string|null} [options.remoteMain] ls-remote-vastaus (oletus: tuotanto)
 * @param {object} [options.extraCommits] sha -> tiedostot (esim. peruutus)
 * @param {object} [options.sqlOverrides] polku -> SQL lukon SQL-lähteessä (SQL_SOURCE_WAVE) ja HEADissa
 * @param {boolean} [options.pushOk]
 */
export function stubGit({
  production = 'C', productionSha = null, refOverrides = {}, missingRefs = [], missingPatchWaves = [], missingPatches = {},
  remoteMain, extraCommits = {}, sqlOverrides = {}, pushOk = true, throwOn = null
} = {}) {
  const calls = [];
  const commits = {};
  for (const w of TRAIN_WAVES) commits[shaOf(w)] = filesFor(w);
  // J:n kärjessä 0009–0013 (ei 0014); lähdeaallossa kaikki ja ohitukset.
  Object.assign(commits[shaOf('J')], sqlFiles('J'));
  Object.assign(commits[shaOf(SQL_SOURCE_WAVE)], sqlFiles(), sqlOverrides);
  commits[HEAD_SHA] = { ...sqlFiles(), ...sqlOverrides, 'sw.js': swFor('BASE', 'v13') };
  for (const [sha, files] of Object.entries(extraCommits)) commits[sha] = files;

  const aliases = {};
  for (const entry of TRAIN) aliases[entry.ref] = shaOf(entry.wave);
  Object.assign(aliases, refOverrides);
  for (const ref of missingRefs) delete aliases[ref];
  let originSha = productionSha || shaOf(production);
  const order = sha => TRAIN_WAVES.findIndex(w => shaOf(w) === sha);

  const resolve = ref => {
    if (ref === 'origin/main') return originSha;
    if (ref === 'HEAD') return HEAD_SHA;
    if (ref in aliases) return aliases[ref];
    if (commits[ref]) return ref;
    return null;
  };
  const record = (name, args) => {
    calls.push([name, ...args]);
    if (throwOn === name) throw new Error(`tynkä: ${name} kaatui`);
  };

  const git = {
    kind: 'stub',
    calls,
    revParse(ref) { record('revParse', [ref]); return resolve(ref); },
    show(sha, file) {
      record('show', [sha, file]);
      const resolved = resolve(sha);
      const files = resolved ? commits[resolved] : null;
      return files && file in files ? files[file] : null;
    },
    showBuffer(sha, file) {
      const text = git.show(sha, file);
      return text === null ? null : Buffer.from(text, 'utf8');
    },
    isAncestor(a, b) {
      record('isAncestor', [a, b]);
      const ra = resolve(a);
      const rb = resolve(b);
      if (!ra || !rb) return null;
      if (ra === rb) return true;
      const ia = order(ra);
      const ib = order(rb);
      if (ia === -1 || ib === -1) return false;
      return ia <= ib;
    },
    commitBody(sha) { record('commitBody', [sha]); const i = order(resolve(sha)); return i === -1 ? '' : `aalto\n\nRelease-Wave: ${TRAIN_WAVES[i]}\n`; },
    log(from, to) {
      record('log', [from, to]);
      const ia = order(resolve(from));
      const ib = order(resolve(to));
      if (ia === -1 || ib === -1) return [];
      const out = [];
      for (let i = ib; i > ia; i--) out.push({ sha: shaOf(TRAIN_WAVES[i]), body: `aalto\n\nRelease-Wave: ${TRAIN_WAVES[i]}\n` });
      return out;
    },
    statusPorcelain() { record('statusPorcelain', []); return ''; },
    grep() { record('grep', []); return []; },
    containsPatch(target, commit) {
      record('containsPatch', [target, commit]);
      const i = order(resolve(target));
      if (i === -1) return true;
      const key = String(commit).slice(0, 7);
      const missing = key === '5aa0d53' ? missingPatchWaves : (missingPatches[key] || []);
      return !missing.includes(TRAIN_WAVES[i]);
    },
    fetchHeadTime() { return new Date('2026-09-26T12:00:00Z'); },
    lsRemoteMain() { record('lsRemoteMain', []); return remoteMain === undefined ? originSha : remoteMain; },
    pushMain(sha) { record('push', [sha]); return pushOk ? { ok: true, output: 'ok' } : { ok: false, output: 'rejected' }; },
    /** Testit: siirrä origin/main (esim. deployn jälkeinen tila). */
    setOrigin(sha) { originSha = sha; }
  };
  return git;
}

/** Muistinvarainen fs: vain luku + kirjausspyt. */
export function stubFs(files = {}) {
  const store = new Map(Object.entries(files).map(([p, c]) => [path.resolve(p), c]));
  const writes = [];
  const fs = {
    writes,
    store,
    existsSync(p) {
      const full = path.resolve(p);
      if (store.has(full)) return true;
      const prefix = full + path.sep;
      return [...store.keys()].some(k => k.startsWith(prefix));
    },
    readFileSync(p) {
      const full = path.resolve(p);
      if (!store.has(full)) { const err = new Error(`ENOENT: ${full}`); err.code = 'ENOENT'; throw err; }
      return store.get(full);
    },
    readdirSync(p) {
      const prefix = path.resolve(p) + path.sep;
      const names = new Set();
      for (const k of store.keys()) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split(path.sep)[0]);
      return [...names];
    },
    mkdirSync(p, opts) { writes.push(['mkdirSync', path.resolve(p), opts]); },
    appendFileSync(p, data) {
      writes.push(['appendFileSync', path.resolve(p), data]);
      const full = path.resolve(p);
      store.set(full, (store.has(full) ? store.get(full) : '') + data);
    },
    writeFileSync(p, data) { writes.push(['writeFileSync', path.resolve(p), data]); store.set(path.resolve(p), data); },
    rmSync(p) { writes.push(['rmSync', path.resolve(p)]); }
  };
  return fs;
}

/**
 * Tuotannon fetch-tynkä: tarjoilee `git.show(sha, polku)` -sisällön.
 * `serveSha` voi olla funktio (vaihtuu ajon aikana, esim. pushin jälkeen).
 */
export function stubFetch(git, serveSha, { headers = true, status = 200 } = {}) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, method: init.method || 'GET' });
    const sha = typeof serveSha === 'function' ? serveSha() : serveSha;
    const livePath = new URL(url).pathname;
    const repoPath = livePath === '/' ? 'index.html' : livePath.replace(/^\//, '');
    const body = git.show(sha, repoPath);
    const map = new Map(headers ? SECURITY_HEADERS.map(([k, v]) => [k, v]) : []);
    return {
      status: body === null ? 404 : status,
      headers: { get: name => map.get(String(name).toLowerCase()) ?? null },
      arrayBuffer: async () => {
        const buf = Buffer.from(body === null ? 'not found' : body, 'utf8');
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      }
    };
  };
  fetchImpl.requests = requests;
  return fetchImpl;
}

/** Lukko tynkä-gitistä (sama generaattori kuin oikea --write). */
export function lockFrom(git) {
  return buildTrainMap({ git });
}

export const ROOT_STUB = path.resolve('virtual-activation-root');

/** Päiväkirjarivi: aallon `wave` tekninen hyväksyntä tuotannon commitille. */
export function acceptanceEntry(wave, sha = shaOf(wave)) {
  return { at: '2026-09-26T10:00:00.000Z', type: 'technical-acceptance', wave, sha, result: 'AUTOMATED_TECHNICAL_ACCEPTANCE', liveUse: 'LIVE_USE_VALIDATION_PENDING', checks: {} };
}

/** Päiväkirjarivi: ehdokkaan vihreä testiajo. */
export function testsEntry(wave, sha = shaOf(wave), { pass = 1600, fail = 0 } = {}) {
  return { at: '2026-09-26T09:00:00.000Z', type: 'candidate-tests', wave, sha, result: fail ? 'FAIL' : 'PASS', tests: pass + fail, pass, fail, cancelled: 0, skipped: 0, todo: 0 };
}

/** Päiväkirjarivi: ehdokkaan käynnistyssavu (oletus PASS 27/27, laskurit 0). */
export function smokeEntry(wave, sha = shaOf(wave), { pass = 27, total = 27, result = 'PASS', exceptions = 0 } = {}) {
  return {
    at: '2026-09-26T09:30:00.000Z', type: 'boot-smoke', wave, sha, result, command: `npm run e2e:boot-smoke -- --label ${wave} --expect-sha ${sha}`,
    gates: 'omat', pass, total, exceptions, rejections: 0, consoles: 0, production: 0, outputSha256: 'ab'.repeat(32)
  };
}

/**
 * `npm run e2e:boot-smoke -- --root … --label X --expect-sha <sha> > tiedosto`
 * -tuloste (tools/e2e/boot-smoke.mjs reportLines-muoto, npm:n otsake mukana).
 * Oletus: PASS 27/27 omilla porteilla, HEAD = expectSha = sha.
 */
export function smokeOutput({
  label = 'D', sha = shaOf('D'), head = sha, expectSha = sha, gates = 'omat', result = 'PASS', pass = 27, total = 27,
  exceptions = 0, rejections = 0, consoles = 0, production = 0, candidateLine = true, verdictLine = true, trailing = ''
} = {}) {
  const checks = [
    ...(expectSha ? [
      `PASS  HEAD on odotettu commit\n      HEAD ${head.slice(0, 7)}, odotettu ${expectSha.slice(0, 7)}`,
      'PASS  tarjoiltu puu = commit (src, index.html, sw.js, manifest.json, vendor)\n      412 tiedostoa'
    ] : []),
    'PASS  käynnistys: istunto palautui, sovellus näkyy\n      57 kyselyä; opastus: ohitettu',
    `${exceptions ? 'FAIL' : 'PASS'}  ei käsittelemättömiä poikkeuksia\n      ${exceptions ? '[Talous] Uncaught ReferenceError: key is not defined' : 'ei yhtään'}`
  ];
  return [
    '', `> manifestival@1.0.0 e2e:boot-smoke`, `> node tools/e2e/boot-smoke.mjs --root .claude/worktrees/rc-${label}-smoke --label ${label} --expect-sha ${expectSha || ''}`, '',
    `KÄYNNISTYSSAVU [${label}] — C:\\Users\\x\\Manifestival\\.claude\\worktrees\\rc-${label}-smoke`,
    `  HEAD ${head.slice(0, 7)} (irrotettu); puu = HEAD: kyllä (412 tiedostoa)`,
    '  käynnistyksen ja napautusten kirjoitukset kantaan: ei yhtään',
    ...checks,
    '',
    ...(candidateLine ? [`EHDOKAS [${label}]: ${head} (portit: ${gates}; --expect-sha: ${expectSha || '-'})`] : []),
    ...(verdictLine ? [`KÄYNNISTYSSAVU [${label}]: ${result} (${pass}/${total}; poikkeuksia ${exceptions}, hylkäyksiä ${rejections}, konsolivirheitä ${consoles}, tuotantopyyntöjä ${production})`] : []),
    trailing
  ].join('\n');
}

/** Päiväkirja (JSONL) riveistä. */
export function journalOf(...entries) {
  return entries.map(e => JSON.stringify(e)).join('\n') + '\n';
}

/** `node --test` -yhteenveto (spec-raportoija). */
export function testOutput({ pass = 1600, fail = 0, cancelled = 0 } = {}) {
  return [`✔ jokin testi (1.2ms)`, `ℹ tests ${pass + fail + cancelled}`, 'ℹ suites 0', `ℹ pass ${pass}`,
    `ℹ fail ${fail}`, `ℹ cancelled ${cancelled}`, 'ℹ skipped 3', 'ℹ todo 0', 'ℹ duration_ms 81234.5'].join('\n') + '\n';
}

/** Projektin tiedostot tynkä-fs:ään: lukko ja valinnainen inventaario. */
export function projectFiles({ lock, inventory = null, inventoryName = 'inventaario.json', productionFixture = null, journal = null } = {}) {
  const files = {};
  files[path.join(ROOT_STUB, 'docs/activation/release-train-c-j.json')] = JSON.stringify(lock, null, 2) + '\n';
  if (inventory) files[path.join(ROOT_STUB, inventoryName)] = inventory;
  if (productionFixture) {
    files[path.join(ROOT_STUB, `tests/fixtures/activation-inventory/production-${productionFixture.date}.json`)] = productionFixture.text;
    if (productionFixture.doc !== false) files[path.join(ROOT_STUB, `docs/activation/PRODUCTION-INVENTORY-${productionFixture.date}.md`)] = '# inventaario\n';
  }
  if (journal) files[path.join(ROOT_STUB, '.claude/activation/journal.jsonl')] = journal;
  return files;
}
