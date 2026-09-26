// Aktivoinnin orkestroija: junan C–J seuraava turvallinen askel (ACT-01).
//
// MITÄ TÄMÄ ON
//
// Puhtaat suunnittelufunktiot ja yksi suoritusfunktio, joille KAIKKI
// sivuvaikutukset annetaan parametreina (`deps`):
//
//   git       tools/release/git-layer.mjs -rajapinta (testeissä tynkä)
//   fetchImpl tuotannon staattisten tiedostojen GET (testeissä tynkä)
//   fs        tiedostojen luku; päiväkirjaan kirjoitus VAIN suoritus- ja
//             kirjaustilassa
//   root      projektin juuri
//   now       () => Date
//   sleep     ms => Promise (VERIFY_LIVE-kyselyväli)
//
// Komentorivit: scripts/activation-orchestrate.mjs,
// scripts/activation-dry-run.mjs ja (vain --record-acceptance)
// scripts/production-verify-assets.mjs. Ne eivät sisällä logiikkaa.
//
// HYVÄKSYNTÄPOLITIIKKA (omistajan päätös 2026-09-26, sitova;
// docs/activation/AUTOMATED-ACCEPTANCE-POLICY.md)
//
// Käsin tehtävä selain- ja laitehyväksyntä EI ole junan portti: se on
// LIVE_USE_VALIDATION_PENDING (tiedoksi, ei koskaan PASS). Tuotannossa
// olevan aallon on sen sijaan oltava AUTOMATED_TECHNICAL_ACCEPTANCE
// päiväkirjassa TÄSMÄLLEEN tuotannon commitille, ennen kuin seuraava
// migraatio tai deploy suunnitellaan ajettavaksi. Omistajan hyväksyntä
// vaaditaan vain migraatioille ja deployille (tools/activation/acceptance-policy.mjs).
//
// VAIHEET (yksi aalto kerrallaan, EI KOSKAAN automaattisesti seuraavaan)
//
//   READ_STATE            tuotanto = origin/main (paikallinen) + live-GET
//                         ristiintarkistus; kanta = inventaario;
//                         luokitus classifyActivation (ACT-05);
//                         --execute-deploy vaatii tarkistetun live-tilan
//   PREFLIGHT_REPO        lukko: ref == lukittu SHA, tietue johdonmukainen,
//                         pakolliset korjaukset mukana, isAncestor(tuotanto,
//                         ehdokas), ehdokkaan sw.js/schema.js odotusten mukaiset,
//                         julkaisun esitarkistus (repoChecks) ja tietoturvahaku
//   PREFLIGHT_DB          (MIGRATE) omistajan liittämä preflight_M-tulos:
//                         0 FAIL, 0 poikkeavaa, kaikki rivit
//   STOP_OWNER_MIGRATION  (MIGRATE) aina seis: omistaja ajaa migraation
//   VERIFY                (migraatioaallon DEPLOY) verify_M-tulos 0 poikkeavaa
//                         ja tuore inventaario näyttää M:n ajetuksi
//   STOP_OWNER_DEPLOY     seis, ellei --execute-deploy --approved-sha=<lukon
//                         deployTarget>, tuotannon aallon tekninen hyväksyntä,
//                         ehdokkaan vihreä testiajo ja ehdokkaan käynnistyssavu
//                         (PASS omalla koodilla ja porteilla) ole kirjattu
//   DEPLOY                compare-and-swap: ls-remote main == odotettu
//                         edellinen SHA, sitten push <sha>:refs/heads/main
//                         (EI force)
//   VERIFY_LIVE           kysele tuotantoa kunnes välimuisti, portit ja
//                         sormenjälki täsmäävät; aikakatkaisu -> STOP +
//                         peruutuspaketti
//   TECH_ACCEPTANCE       AUTOMATED_TECHNICAL_ACCEPTANCE (ehdot kirjattuina)
//                         + LIVE_USE_VALIDATION_PENDING (tiedoksi)
//   JOURNAL               .claude/activation/journal.jsonl (git-ignoroitu)
//
// Tuntematon tila, poikkeus tai siirtynyt viite = STOP. Oletus on
// kuivaharjoitus: ei kirjoituksia, ei pushia.
//
// MITÄ TÄMÄ EI TEE
//
// Ei ota yhteyttä tietokantaan (ei yhteysmerkkijonoa, ei psql:ää, ei
// Supabase-komentoriviä): kannan tila tulee AINA omistajan liittämästä
// inventaariosta ja SQL-tuloksista. Ei aja migraatioita. Ei deployaa
// ilman omistajan hyväksymää täyttä SHA:ta.

import path from 'node:path';
import { createHash } from 'node:crypto';

import { classifyActivation, parseInventory } from './score-inventory.mjs';
import { checkNumbersInSql, decide, parseCheckTable } from './score-sql-result.mjs';

/** SQL-tiedoston tarkistusnumerot (aukot sallittu) ja niiden määrä. */
function expectedChecksOf(sql) {
  const expectedNumbers = checkNumbersInSql(sql);
  return { expectedNumbers, expectedChecks: expectedNumbers.length };
}
import { LOCK_PATH, checkTrainMap } from './train-map.mjs';
import {
  LIVE_USE_PENDING, LIVE_USE_VALIDATION, OWNER_APPROVAL, OWNER_INPUT, PRE_TOOLING_WAVE,
  TECHNICAL_ACCEPTANCE, TECHNICAL_GATE, TECHNICAL_REQUIREMENTS, bootSmokeOf, bootSmokeProblems,
  candidateTestsOf, gateKind, ownerMessageFor, parseBootSmoke, parseTestSummary, technicalAcceptanceOf,
  testSummaryGreen
} from './acceptance-policy.mjs';
import { originMainStateFrom } from '../release/lineage.mjs';
import { parseCacheVersion, parseGates } from '../release/state.mjs';
import { blockingFailures, repoChecks } from '../release/preflight-checks.mjs';
import {
  ALL_GATES, COLUMN_GATES, RISK_LABEL_FI, TRAIN_FLOOR_WAVE, cacheVersionOf, classifyDeployedState,
  cumulativeGates, expectedMatrix, nextWaveId, previousWaveId, rollbackTargetOf, verifyPathOf,
  waveById, waveIndex, WAVE_IDS
} from '../release/waves.mjs';
import { fingerprintOf, readLiveState, verifyLive } from '../release/live-assets.mjs';

export const JOURNAL_PATH = '.claude/activation/journal.jsonl';
export const FIXTURE_DIR = 'tests/fixtures/activation-inventory';
export const INVENTORY_DOC_DIR = 'docs/activation';
/** Migraation edellyttämän inventaarion enimmäisikä. */
export const INVENTORY_MAX_AGE_HOURS = 24;
const SHA40 = /^[0-9a-f]{40}$/;

const sha256 = text => createHash('sha256').update(text === null || text === undefined ? '' : text).digest('hex');

/** Eräluku (git cat-file --batch), jos git-kerros tukee sitä. */
const preloadOf = git => (typeof git.showMany === 'function' ? (s, p) => git.showMany(s, p) : null);

// =====================================================================
// PÄIVÄKIRJA
// =====================================================================

/**
 * Päiväkirjan polku. Projektikansion ulkopuolinen polku hylätään
 * (projektin tallennussääntö: kaikki sovelluksen tiedostot sen omaan
 * kansioon).
 */
export function resolveJournalPath(root, requested = JOURNAL_PATH) {
  const full = path.resolve(root, requested);
  const relative = path.relative(path.resolve(root), full);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`päiväkirjan polku on projektikansion ulkopuolella: ${requested}`);
  }
  return full;
}

/** Lue päiväkirja. Kelvoton rivi -> ongelma (fail closed), ei ohitusta. */
export function readJournal({ fs, root, journalPath = JOURNAL_PATH }) {
  const full = resolveJournalPath(root, journalPath);
  if (!fs.existsSync(full)) return { entries: [], problems: [] };
  const entries = [];
  const problems = [];
  String(fs.readFileSync(full, 'utf8')).split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try { entries.push(JSON.parse(line)); } catch { problems.push(`päiväkirjan rivi ${i + 1} ei ole JSON:ia`); }
  });
  return { entries, problems };
}

/** Lisää päiväkirjaan yksi rivi. Kutsutaan VAIN suoritus- ja kirjaustilassa. */
export function appendJournal(entry, { fs, root, journalPath = JOURNAL_PATH }) {
  const full = resolveJournalPath(root, journalPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.appendFileSync(full, JSON.stringify(entry) + '\n', 'utf8');
  return full;
}

/**
 * Teknisesti hyväksytyt aallot päiväkirjasta: vain tuotannossa oleva
 * aalto, ja vain jos päiväkirjan rivin SHA on tuotannon SHA (fail
 * closed). Vanhan mallin 'acceptance'-rivit (omistajan UI-hyväksyntä)
 * eivät kelpaa: käyttöliittymä on LIVE_USE_VALIDATION_PENDING, ei portti.
 */
export function acceptedWavesFrom(entries, production) {
  if (!production || !production.codeWave || !production.sha) return [];
  return technicalAcceptanceOf(entries, { wave: production.codeWave, sha: production.sha }) ? [production.codeWave] : [];
}

/**
 * Onko juna pysäytetty peruutuksen takia (ACT-10)? Peruutus pysäyttää
 * junan niin kauaksi aikaa, kunnes lukko on kirjoitettu uudelleen
 * (uudelleenleikatut ehdokkaat, uudet välimuistiversiot).
 */
export function haltFrom(entries, lockSha256) {
  const rollback = [...entries].reverse().find(e => e.type === 'rollback');
  if (rollback && rollback.lockSha256 === lockSha256) {
    return {
      class: 'TRAIN_HALTED_RECUT_REQUIRED',
      reason: `aalto ${rollback.wave} on peruttu (${rollback.at}): myöhempien ehdokkaiden `
        + 'välimuistiversiot törmäävät peruutuksen versioon. Leikkaa ehdokkaat uudelleen, '
        + 'numeroi välimuistit ja kirjoita lukko (train-map --write).'
    };
  }
  return null;
}

// =====================================================================
// INVENTAARIO
// =====================================================================

/** Uusin tuotannon inventaario-fixture, jolla on dokumentti docs/activation-kansiossa. */
export function latestProductionInventory({ fs, root }) {
  const dir = path.join(root, FIXTURE_DIR);
  if (!fs.existsSync(dir)) return null;
  const dated = fs.readdirSync(dir)
    .map(name => /^production-(\d{4}-\d{2}-\d{2})\.json$/.exec(name))
    .filter(Boolean)
    .filter(m => fs.existsSync(path.join(root, INVENTORY_DOC_DIR, `PRODUCTION-INVENTORY-${m[1]}.md`)))
    .sort((a, b) => a[1].localeCompare(b[1]));
  if (!dated.length) return null;
  const last = dated[dated.length - 1];
  return { file: `${FIXTURE_DIR}/${last[0]}`, date: last[1], doc: `${INVENTORY_DOC_DIR}/PRODUCTION-INVENTORY-${last[1]}.md` };
}

/**
 * Lataa inventaario: --inventory=<tiedosto> tai uusin dokumentoitu
 * tuotannon fixture.
 *
 * @returns {{status: 'OK'|'MISSING'|'UNREADABLE', source?: string, rows?: object,
 *   reconstructed?: boolean, capturedAt?: string|null, provenance?: object, doc?: string}}
 */
export function loadInventory({ fs, root, inventoryPath = null }) {
  let source = inventoryPath;
  let doc = null;
  if (!source) {
    const latest = latestProductionInventory({ fs, root });
    if (!latest) return { status: 'MISSING' };
    source = latest.file;
    doc = latest.doc;
  }
  const full = path.resolve(root, source);
  if (!fs.existsSync(full)) return { status: 'MISSING', source };
  const text = String(fs.readFileSync(full, 'utf8'));
  const rows = parseInventory(text);
  if (!rows) return { status: 'UNREADABLE', source };
  let provenance = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.provenance) provenance = parsed.provenance;
  } catch { /* liitetty taulukko tai CSV: ei provenienssia */ }
  const stamp = rows['04'] ? `${String(rows['04']).replace(' ', 'T')}Z` : null;
  const capturedAt = stamp && !Number.isNaN(Date.parse(stamp))
    ? new Date(stamp).toISOString()
    : (provenance && provenance.capturedOn ? new Date(`${provenance.capturedOn}T00:00:00Z`).toISOString() : null);
  return {
    status: 'OK', source, doc, rows, provenance,
    reconstructed: Boolean(provenance && provenance.reconstructed),
    capturedAt
  };
}

// =====================================================================
// TILAN LUKEMINEN
// =====================================================================

/** Tuotanto = paikallinen origin/main + sen deploytila. */
export function productionState(git, now) {
  const origin = originMainStateFrom(git);
  const deployed = origin.available ? classifyDeployedState({ gates: origin.gates, cacheVersion: origin.cacheVersion }) : null;
  const fetchTime = git.fetchHeadTime ? git.fetchHeadTime() : null;
  return {
    ...origin,
    deployed,
    codeWave: deployed && deployed.state === 'WAVE' ? deployed.wave : null,
    fetchHeadTime: fetchTime ? fetchTime.toISOString() : null,
    fetchHeadAgeHours: fetchTime ? Math.round(((now - fetchTime) / 36e5) * 10) / 10 : null
  };
}

/** Lukko levyltä: { data, sha256, check }. */
function readLockState({ fs, root, git }, problems) {
  const lockFile = path.join(root, LOCK_PATH);
  if (!fs.existsSync(lockFile)) return { data: null, sha256: null, check: null };
  const text = String(fs.readFileSync(lockFile, 'utf8'));
  let data = null;
  try { data = JSON.parse(text); } catch { problems.push('lukko ei ole JSON:ia'); }
  return { data, sha256: sha256(text.replace(/\r\n/g, '\n')), check: data ? checkTrainMap(data, { git }) : null };
}

/**
 * Lue kaikki tila. Verkko vain, jos `live` on tosi ja fetchImpl annettu.
 *
 * @param {object} deps { git, fs, root, fetchImpl?, now? }
 * @param {object} [options] { live, inventoryPath, journalPath }
 */
export async function readState(deps, { live = false, inventoryPath = null, journalPath = JOURNAL_PATH } = {}) {
  const { git, fs, root } = deps;
  const now = deps.now ? deps.now() : new Date();
  const state = { now: now.toISOString(), problems: [] };

  state.production = productionState(git, now);
  state.lock = readLockState({ fs, root, git }, state.problems);

  state.journal = readJournal({ fs, root, journalPath });
  // Tekninen hyväksyntä luetaan VAIN päiväkirjasta ja vain tuotannon
  // commitille (aalto + SHA).
  state.technicalAcceptance = state.production.codeWave
    ? technicalAcceptanceOf(state.journal.entries, { wave: state.production.codeWave, sha: state.production.sha })
    : null;
  state.acceptedWaves = acceptedWavesFrom(state.journal.entries, state.production);
  state.halt = state.lock.sha256 ? haltFrom(state.journal.entries, state.lock.sha256) : null;

  state.inventory = loadInventory({ fs, root, inventoryPath });
  state.classification = state.inventory.status === 'OK'
    ? classifyActivation(state.inventory.rows, {
      codeWave: state.production.codeWave, acceptedWaves: state.acceptedWaves, lock: state.lock.data
    })
    : null;

  // null = git status epäonnistui tai kerros ei tue sitä (ei "puhdas").
  state.workingTree = typeof git.statusPorcelain === 'function' ? git.statusPorcelain() : null;

  state.live = null;
  if (live) {
    if (typeof deps.fetchImpl !== 'function') {
      state.live = { checked: false, problems: ['verkkohaku puuttuu (fetchImpl)'] };
    } else if (!state.production.available) {
      state.live = { checked: false, problems: ['origin/main ei ole saatavilla: ristiintarkistusta ei voi tehdä'] };
    } else {
      const fp = fingerprintOf(state.production.sha, (s, p) => git.showBuffer(s, p), preloadOf(git));
      const liveState = await readLiveState({ fetchImpl: deps.fetchImpl, paths: fp ? Object.keys(fp.files) : [] });
      const expectation = state.production.deployed && state.production.deployed.state === 'ROLLBACK'
        ? { rollbackOf: state.production.deployed.rollbackOf }
        : { wave: state.production.codeWave };
      const problems = expectation.wave || expectation.rollbackOf
        ? verifyLive(liveState, { ...expectation, sha: state.production.sha, gitShow: (s, p) => git.showBuffer(s, p), preload: preloadOf(git) })
        : ['origin/mainin tila ei vastaa yhtäkään aaltoa'];
      state.live = {
        checked: true, cacheVersion: liveState.cacheVersion, wave: liveState.wave,
        state: liveState.state.label, matchesProductionSha: problems.length === 0, problems,
        fingerprintFiles: fp ? Object.keys(fp.files).length : 0
      };
    }
  }
  return state;
}

// =====================================================================
// SUUNNITTELU
// =====================================================================

/** Ehdokkaan ristiintarkistukset lukitusta SHA:sta (git show). */
export function candidateChecks(git, wave, sha) {
  const sw = git.show(sha, 'sw.js');
  const schema = git.show(sha, 'src/data/schema.js');
  const cache = parseCacheVersion(sw);
  const gates = parseGates(schema, { allowMissing: true });
  const expected = expectedMatrix(wave);
  const gateDiff = gates ? ALL_GATES.filter(g => gates[g] !== expected[g]) : ['porttilohkoa ei voitu lukea'];
  const columns = {};
  const columnDiff = [];
  for (const [gate, openFrom] of Object.entries(COLUMN_GATES)) {
    const m = new RegExp(`export const ${gate} = (true|false);`).exec(schema || '');
    const actual = m ? m[1] === 'true' : false;
    const shouldBe = waveIndex(wave) >= waveIndex(openFrom);
    columns[gate] = shouldBe;
    if (actual !== shouldBe) columnDiff.push(gate);
  }
  return {
    cache: { expected: cacheVersionOf(wave), actual: cache, ok: cache === cacheVersionOf(wave) },
    gates: { open: [...cumulativeGates(wave)], ok: gateDiff.length === 0, differences: gateDiff },
    columnGates: { expected: columns, ok: columnDiff.length === 0, differences: columnDiff }
  };
}

/**
 * Julkaisun esitarkistus (repoChecks) ja tietoturvahaku ehdokkaalle.
 * Tietoturvahaku vaatii git grepin: sen puute on este (fail closed).
 */
export function candidatePreflight(git, wave, sha, sqlRef) {
  const gitGrep = typeof git.grep === 'function' ? (ref, regex, opts) => git.grep(ref, regex, opts) : null;
  const results = repoChecks({
    ref: sha, wave, gitShow: (s, p) => git.show(s, p), gitGrep, sqlRef: sqlRef || null, preload: preloadOf(git)
  });
  const failures = blockingFailures(results).map(r => `${r.name}${r.detail ? `: ${r.detail}` : ''}`);
  if (!gitGrep) failures.push('tietoturvahaku (git grep) ei ole käytettävissä');
  const security = results.filter(r => r.section === 'salaisuudet');
  return {
    checks: results.length, failures,
    securityOk: Boolean(gitGrep) && security.length > 0 && security.every(r => r.ok),
    ok: failures.length === 0
  };
}

/** SQL-tiedostot, jotka omistaja ajaa seuraavaksi (lukon SQL-lähteestä). */
export function sqlFilesFor(action, lock, git) {
  if (!action || !lock || !lock.sqlSource) return [];
  const source = lock.sqlSource;
  const files = [];
  if (action.kind === 'MIGRATE') {
    if (action.verifyPrerequisite) files.push({ role: 'edellytys (jo ajettu, 0 poikkeavaa)', path: action.verifyPrerequisite });
    files.push({ role: 'esitarkistus (vain luku)', path: action.preflight });
    files.push({ role: 'MIGRAATIO (omistajan hyväksynnällä)', path: action.migrationFile });
    files.push({ role: 'varmistus (vain luku)', path: action.verify });
  } else if (action.kind === 'DEPLOY' && action.migration) {
    files.push({ role: 'varmistus ennen deployta (vain luku)', path: action.verify });
  }
  return files.map(f => {
    const content = SHA40.test(String(source.sha)) ? git.show(source.sha, f.path) : null;
    const digest = content === null ? null : sha256(content);
    const head = git.show('HEAD', f.path);
    return {
      ...f,
      sourceRef: source.ref, sourceSha: source.sha,
      sha256: digest,
      lockSha256: source.files ? source.files[f.path] ?? null : null,
      matchesLock: digest !== null && source.files && source.files[f.path] === digest,
      matchesHead: head !== null && digest !== null && sha256(head) === digest
    };
  });
}

function ageHours(iso, now) {
  if (!iso) return null;
  return Math.round(((new Date(now) - new Date(iso)) / 36e5) * 10) / 10;
}

/** Komento, jolla tuotannon aallon tekninen hyväksyntä kirjataan live-todennuksesta. */
export function recordAcceptanceCommand(wave, sha) {
  const meta = waveById(wave);
  return `npm run production:verify-assets -- --wave=${wave} --sha=${sha} --record-acceptance`
    + (meta && meta.migration ? ` --verify-result=<${path.posix.basename(verifyPathOf(meta.migration))}-tulos>` : '');
}

/** Komennot, joilla ehdokkaan oma testipatteristo ajetaan ja kirjataan. */
export function candidateTestsCommand(wave, sha) {
  const out = `.claude/activation/tests-${wave}-${sha.slice(0, 7)}.txt`;
  return `git worktree add --detach .claude/worktrees/rc-${wave}-test ${sha} && (cd .claude/worktrees/rc-${wave}-test && node --test) > ${out}; `
    + `npm run activation:orchestrate -- --record-candidate-tests=${wave} --sha=${sha} --tests-result=${out}`;
}

/**
 * Komennot, joilla ehdokkaan käynnistyssavu ajetaan sen omalla koodilla
 * ja porteilla (koskematon irrotettu työpuu, --expect-sha) ja kirjataan.
 * Savu ajetaan tämän haaran tools/e2e/boot-smoke.mjs:llä: vain se
 * tulostaa EHDOKAS-rivin, jonka kirjaus vaatii.
 */
export function bootSmokeCommand(wave, sha) {
  const tree = `.claude/worktrees/rc-${wave}-smoke`;
  const out = `.claude/activation/smoke-${wave}-${sha.slice(0, 7)}.txt`;
  return `git worktree add --detach ${tree} ${sha} && npm run e2e:boot-smoke -- --root ${tree} --label ${wave} --expect-sha ${sha} > ${out}; `
    + `npm run activation:orchestrate -- --record-boot-smoke=${wave} --sha=${sha} --smoke-result=${out}`;
}

/** Päiväkirjan boot-smoke-rivin todiste `checks.bootSmoke`-kenttään. */
function bootSmokeEvidence(entry) {
  return `käynnistyssavu [${entry.wave}] ${entry.pass}/${entry.total} PASS omilla porteilla, poikkeuksia 0, hylkäyksiä 0, `
    + `konsolivirheitä 0, tuotantopyyntöjä 0 (${entry.at})`;
}

/**
 * Seuraava askel. Puhdas funktio: ei I/O:ta (git-kerrosta käytetään
 * vain lukemiseen ehdokkaan ja SQL-tiedostojen ristiintarkistukseen).
 *
 * @param {object} state readState()-tulos
 * @param {object} input { wave, preflightResult, verifyResult,
 *   executeDeploy, approvedSha }
 * @param {object} deps { git }
 */
export function planNext(state, input = {}, { git }) {
  const steps = [];
  const pending = [];
  const warnings = [];
  const plan = {
    decision: 'GO', state: null, stopClass: null, reason: null, steps, pendingGates: pending, warnings,
    nextAction: null, candidate: null, sql: [], risk: null, nextMigration: null, readyToDeploy: false,
    evidence: {}, technicalAcceptance: null, liveUse: [], exitCode: 1
  };
  const step = (name, status, detail = []) => steps.push({ name, status, detail: [].concat(detail) });
  const stop = (stopClass, reason, exitCode = 1) => {
    plan.decision = 'STOP'; plan.state = stopClass; plan.stopClass = stopClass; plan.reason = reason; plan.exitCode = exitCode;
    return plan;
  };
  const gate = (cls, detail, extra = {}) => pending.push({ class: cls, kind: gateKind(cls), detail, ...extra });

  // ---------------------------------------------------------- READ_STATE
  const prod = state.production;
  const readDetail = [];
  if (!prod.available) { step('READ_STATE', 'STOP', 'origin/main ei ole paikallisesti saatavilla'); return stop('PRODUCTION_UNKNOWN', 'origin/main ei ole paikallisesti saatavilla (git fetch, vain luku)'); }
  readDetail.push(`tuotanto ${prod.sha} = ${prod.deployed.label} (${prod.cacheVersion})`);
  if (prod.fetchHeadAgeHours !== null && prod.fetchHeadAgeHours > 24) {
    warnings.push(`origin/main noudettu ${prod.fetchHeadAgeHours} h sitten: aja "git fetch" (vain luku) ennen päätöksiä`);
  }
  if (state.problems.length) { step('READ_STATE', 'STOP', state.problems); return stop('STATE_UNREADABLE', state.problems.join('; ')); }
  if (state.journal.problems.length) { step('READ_STATE', 'STOP', state.journal.problems); return stop('JOURNAL_UNREADABLE', state.journal.problems.join('; ')); }
  if (prod.deployed.state === 'ROLLBACK') {
    step('READ_STATE', 'STOP', readDetail);
    return stop('TRAIN_HALTED_RECUT_REQUIRED',
      `tuotanto on aallon ${prod.deployed.rollbackOf} peruutus (${prod.cacheVersion}): myöhempien ehdokkaiden välimuistiversiot törmäävät. Leikkaa uudelleen ja kirjoita lukko.`);
  }
  if (prod.deployed.state !== 'WAVE') { step('READ_STATE', 'STOP', readDetail); return stop('PRODUCTION_INCONSISTENT', `origin/mainin tila on epäjohdonmukainen: ${prod.deployed.label}`); }
  if (state.halt) { step('READ_STATE', 'STOP', state.halt.reason); return stop(state.halt.class, state.halt.reason); }
  if (state.live) {
    if (!state.live.checked || state.live.problems.length) {
      step('READ_STATE', 'STOP', state.live.problems);
      return stop('LIVE_MISMATCH', `tuotanto ei vastaa origin/mainia ${prod.sha}: ${state.live.problems.slice(0, 3).join('; ')}`);
    }
    readDetail.push(`live: ${state.live.state}, sormenjälki = ${prod.sha.slice(0, 7)}`);
  } else {
    readDetail.push('live: ei tarkistettu (--offline)');
  }
  // Deploy ilman tarkistettua live-tilaa on sokea: compare-and-swap
  // todistaa vain gitin, ei sitä mitä tuotanto tarjoilee (ACT-01).
  if (input.executeDeploy && !(state.live && state.live.checked)) {
    step('READ_STATE', 'STOP', 'deploy vaatii tarkistetun live-tilan');
    return stop('LIVE_REQUIRED', '--execute-deploy vaatii tuotannon live-todennuksen (poista --offline; fetchImpl pakollinen)');
  }
  if (!state.lock.data) { step('READ_STATE', 'STOP', 'lukko puuttuu'); return stop('LOCK_MISSING', `${LOCK_PATH} puuttuu tai on lukukelvoton`); }
  if (state.inventory.status === 'MISSING') {
    step('READ_STATE', 'STOP', 'inventaario puuttuu');
    return stop('OWNER_READ_ONLY_SQL_REQUIRED',
      'kannan tilaa ei tiedetä: omistaja ajaa supabase/acceptance/activation_readonly_inventory.sql (vain luku) ja liittää rivin 00 (--inventory=<tiedosto>)');
  }
  if (state.inventory.status === 'UNREADABLE') {
    step('READ_STATE', 'STOP', `inventaariota ${state.inventory.source} ei voitu lukea`);
    return stop('INVENTORY_UNREADABLE', `inventaariota ${state.inventory.source} ei voitu lukea`, 2);
  }
  readDetail.push(`inventaario ${state.inventory.source}${state.inventory.reconstructed ? ' (REKONSTRUOITU omistajan yhteenvedosta)' : ''}`);
  step('READ_STATE', 'OK', readDetail);

  // Tuotannon aallon tekninen hyväksyntä ja käyttötodennus (tiedoksi).
  plan.technicalAcceptance = {
    wave: prod.codeWave, sha: prod.sha, status: state.technicalAcceptance ? TECHNICAL_ACCEPTANCE : 'MISSING',
    at: state.technicalAcceptance ? state.technicalAcceptance.at : null,
    command: state.technicalAcceptance ? null : recordAcceptanceCommand(prod.codeWave, prod.sha)
  };
  plan.liveUse = WAVE_IDS
    .filter(w => waveIndex(w) >= waveIndex(TRAIN_FLOOR_WAVE) && waveIndex(w) <= waveIndex(prod.codeWave))
    .filter(w => LIVE_USE_VALIDATION[w])
    .map(w => ({ wave: w, status: LIVE_USE_PENDING, doc: LIVE_USE_VALIDATION[w].doc, items: [...LIVE_USE_VALIDATION[w].items] }));

  const c = state.classification;
  plan.nextAction = c.nextAction;
  const base = c.base;
  if (base.nextMigration) {
    // Migraatio M (aalto W) ajetaan vasta, kun tuotannossa on W:tä
    // edeltävä aalto teknisesti hyväksyttynä: 0009 (F) vasta kun E on
    // deployattu ja AUTOMATED_TECHNICAL_ACCEPTANCE on kirjattu.
    const needsCode = previousWaveId(base.nextWave);
    plan.nextMigration = {
      migration: base.nextMigration,
      wave: base.nextWave,
      deferred: c.codeWave !== needsCode,
      waitsFor: c.codeWave !== needsCode ? `aalto ${needsCode} tuotannossa ja teknisesti hyväksytty` : null
    };
  }
  if (c.decision === 'STOP') {
    return stop(c.nextAction.kind === 'STOP' ? 'STOP' : c.nextAction.kind, c.reason);
  }
  if (c.nextAction.kind === 'DONE') {
    plan.decision = 'DONE'; plan.state = 'DONE'; plan.reason = c.reason; plan.exitCode = 0;
    return plan;
  }

  // ------------------------------------------------------- PREFLIGHT_REPO
  const action = c.nextAction;
  const wave = action.wave;
  const meta = waveById(wave);
  plan.risk = { level: meta.risk, label: RISK_LABEL_FI[meta.risk], backupRequired: Boolean(meta.backupRequired) };
  const lock = state.lock.data;
  const record = lock.waves.find(w => w.wave === wave);
  const repo = [];
  if (input.wave && input.wave !== wave) {
    step('PREFLIGHT_REPO', 'STOP', `pyydetty aalto ${input.wave}, seuraava on ${wave}`);
    return stop('WAVE_MISMATCH', `pyydetty aalto ${input.wave}, mutta seuraava turvallinen aalto on ${wave}`);
  }
  if (!record || !SHA40.test(String(record.deployTarget))) {
    step('PREFLIGHT_REPO', 'STOP', `aallolla ${wave} ei ole lukittua deployTargetia`);
    return stop('LOCK_DRIFT', `aallolla ${wave} ei ole lukittua 40-merkkistä deployTargetia`);
  }
  const lockWave = state.lock.check ? state.lock.check.waves.find(w => w.wave === wave) : null;
  const lockProblems = [
    ...(lockWave ? lockWave.problems || [] : ['lukon tarkistus puuttuu']),
    ...(state.lock.check ? state.lock.check.problems.filter(p => p.startsWith('sqlSource')) : [])
  ];
  // Muiden aaltojen lukkopoikkeamat eivät estä TÄMÄN aallon deployta
  // (esim. H:n uudelleenleikkaus kesken, kun deployataan D), mutta ne
  // näytetään: lukko on kirjoitettava uudelleen ennen niiden vuoroa.
  if (state.lock.check) {
    for (const other of state.lock.check.waves.filter(w => w.wave !== wave && w.problems && w.problems.length)) {
      warnings.push(`lukko, aalto ${other.wave}: ${other.problems.join('; ')} (aja train-map --write ennen sen vuoroa)`);
    }
  }
  const fastForward = git.isAncestor(prod.sha, record.deployTarget);
  const checks = candidateChecks(git, wave, record.deployTarget);
  const preflight = candidatePreflight(git, wave, record.deployTarget, lock.sqlSource ? lock.sqlSource.sha : null);
  plan.candidate = {
    wave, sha: record.deployTarget, ref: record.ref, waveCommit: record.waveCommit,
    refMatchesLock: lockWave ? !(lockWave.problems || []).some(p => /ref /.test(p)) : false,
    fastForward, missingPatches: record.missingPatches || [], checks, acceptance: record.acceptance,
    preflight: { checks: preflight.checks, failures: preflight.failures, securityOk: preflight.securityOk }
  };
  plan.sql = sqlFilesFor(action, lock, git);
  if (lockProblems.length) repo.push(...lockProblems);
  if (record.consistent !== true) repo.push(`lukon tietue ${wave} ei ole johdonmukainen`);
  if (fastForward !== true) repo.push(`tuotanto ${prod.sha.slice(0, 7)} ei ole ehdokkaan ${record.deployTarget.slice(0, 7)} esi-isä: push ei olisi fast-forward`);
  if (!checks.cache.ok) repo.push(`ehdokkaan sw.js on ${checks.cache.actual}, odotettiin ${checks.cache.expected}`);
  if (!checks.gates.ok) repo.push(`ehdokkaan porttimatriisi poikkeaa: ${checks.gates.differences.join(', ')}`);
  if (!checks.columnGates.ok) repo.push(`ehdokkaan sarakeportit poikkeavat: ${checks.columnGates.differences.join(', ')}`);
  for (const f of preflight.failures) repo.push(`esitarkistus (repoChecks): ${f}`);
  for (const f of plan.sql) {
    if (f.sha256 === null) repo.push(`${f.path} puuttuu SQL-lähteestä ${String(f.sourceSha).slice(0, 7)}`);
    else if (!f.matchesLock) repo.push(`${f.path}: sha256 eroaa lukosta`);
    else if (!f.matchesHead) warnings.push(`${f.path}: tuotehaaran HEAD eroaa SQL-lähteestä — aja lukon lähteen versio`);
  }
  if (repo.length) {
    step('PREFLIGHT_REPO', 'STOP', repo);
    return stop('LOCK_DRIFT', repo.join('; '));
  }
  if (plan.candidate.missingPatches.length) {
    step('PREFLIGHT_REPO', 'STOP', `pakolliset korjaukset puuttuvat: ${plan.candidate.missingPatches.join(', ')}`);
    return stop('TRAIN_RECUT_REQUIRED',
      `aallon ${wave} ehdokas ${record.deployTarget.slice(0, 7)} ei sisällä korjauksia ${plan.candidate.missingPatches.map(s => s.slice(0, 7)).join(', ')}: leikkaa uudelleen ja aja train-map --write`);
  }
  if (input.executeDeploy && state.workingTree === null) {
    step('PREFLIGHT_REPO', 'STOP', 'git status epäonnistui: työpuun tilaa ei tiedetä');
    return stop('WORKING_TREE_UNKNOWN', 'työpuun tilaa ei voitu lukea (git status): lukko ja työkalut on luettava tunnetusta, committoidusta tilasta');
  }
  const dirty = state.workingTree !== null && String(state.workingTree).trim().length > 0;
  if (dirty) {
    if (input.executeDeploy) {
      step('PREFLIGHT_REPO', 'STOP', 'työpuussa on committoimattomia muutoksia');
      return stop('WORKING_TREE_DIRTY', 'työpuu ei ole puhdas: lukko ja työkalut on luettava committoidusta tilasta');
    }
    warnings.push('työpuussa on committoimattomia muutoksia (deploy vaatii puhtaan työpuun)');
  }
  step('PREFLIGHT_REPO', 'OK', [
    `ehdokas ${wave} = ${record.deployTarget} (${record.ref})`,
    `ref == lukko, fast-forward tuotannosta, ${checks.cache.actual}, portit ja sarakeportit ok`,
    `julkaisun esitarkistus (repoChecks) ${preflight.checks} tarkistusta PASS, tietoturvahaku ok`
  ]);

  // Koneelliset ehdot, jotka kirjataan deployn päiväkirjariviin.
  plan.evidence = {
    ancestry: `fast-forward ${prod.sha.slice(0, 7)} -> ${record.deployTarget.slice(0, 7)} (lukon deployTarget)`,
    migrationPrerequisite: `inventaario ${state.inventory.source}: kanta ${c.currentDbWave} (viimeisin migraatio ${c.lastMigration})`,
    security: 'git grep: ei AI-avaimia, ei palvelinroolin avainta selaimen koodissa',
    repoPreflight: `repoChecks ${preflight.checks} tarkistusta PASS`,
    cacheAndGates: `${checks.cache.actual}, ${checks.gates.open.length} porttia, sarakeportit ${Object.entries(checks.columnGates.expected).map(([g, v]) => `${g}=${v}`).join(' ')}`,
    migrationVerify: meta.migration ? null : 'ei migraatiota'
  };

  // --------------------------------------- KONEELLISET PORTIT (ei omistajaa)
  if (action.requiresAcceptanceOf) {
    gate(TECHNICAL_GATE.ACCEPTANCE,
      `aallon ${action.requiresAcceptanceOf} (${prod.sha.slice(0, 7)}) tekninen hyväksyntä puuttuu päiväkirjasta: ${recordAcceptanceCommand(action.requiresAcceptanceOf, prod.sha)}`,
      { acceptanceOf: action.requiresAcceptanceOf });
  }
  const tests = candidateTestsOf(state.journal.entries, { wave, sha: record.deployTarget });
  if (tests.ok) {
    plan.evidence.candidateTests = `node --test ${tests.entry.pass}/${tests.entry.tests} PASS, fail 0 (${tests.entry.at})`;
  } else {
    gate(TECHNICAL_GATE.CANDIDATE_TESTS,
      `ehdokkaan ${wave} (${record.deployTarget.slice(0, 7)}) oma testipatteristo ei ole kirjattu vihreäksi: ${candidateTestsCommand(wave, record.deployTarget)}`);
  }
  const smoke = bootSmokeOf(state.journal.entries, { wave, sha: record.deployTarget });
  if (smoke.ok) {
    plan.evidence.bootSmoke = bootSmokeEvidence(smoke.entry);
  } else {
    gate(TECHNICAL_GATE.BOOT_SMOKE,
      `ehdokkaan ${wave} (${record.deployTarget.slice(0, 7)}) käynnistyssavu omalla koodilla ja porteilla ei ole kirjattu PASSiksi: ${bootSmokeCommand(wave, record.deployTarget)}`);
  }
  const approval = ownerMessageFor(wave);

  // ------------------------------------------------- MIGRATE-POLKU
  if (action.kind === 'MIGRATE') {
    const inventoryAge = ageHours(state.inventory.capturedAt, state.now);
    const freshReal = !state.inventory.reconstructed && inventoryAge !== null && inventoryAge <= INVENTORY_MAX_AGE_HOURS;
    if (!freshReal) {
      gate(OWNER_INPUT.READ_ONLY_SQL,
        `tuore inventaario (≤ ${INVENTORY_MAX_AGE_HOURS} h, ei rekonstruoitu) ennen migraatiota ${action.migration}`);
    }
    if (!input.preflightResult) {
      gate(OWNER_INPUT.READ_ONLY_SQL, `${action.preflight}: aja (vain luku) ja liitä tulos --preflight-result=<tiedosto>`);
      step('PREFLIGHT_DB', 'PENDING', `${action.preflight} -tulos puuttuu`);
    } else {
      const parsed = parseCheckTable(input.preflightResult);
      if (!parsed) { step('PREFLIGHT_DB', 'STOP', 'tulosta ei voitu lukea'); return stop('PREFLIGHT_RESULT_UNREADABLE', `${action.preflight}: tulosta ei voitu lukea`, 2); }
      const { expectedChecks, expectedNumbers } = expectedChecksOf(git.show(lock.sqlSource.sha, action.preflight));
      const verdict = decide(parsed, { expectedChecks, expectedNumbers });
      if (verdict.decision !== 'GO') { step('PREFLIGHT_DB', 'STOP', verdict.reasons); return stop('PREFLIGHT_DB_FAILED', `${action.preflight}: ${verdict.reasons.join('; ')}`); }
      step('PREFLIGHT_DB', 'OK', `${parsed.rows.length}/${expectedChecks} tarkistusta, 0 FAIL, 0 poikkeavaa`);
    }
    const backup = action.backupRequired
      ? ` — TUORE VARMUUSKOPIO ENSIN (PAKOLLINEN): supabase/backup/snapshot_state_${previousMigrationOf(action.migration)}.sql`
        + ' + node tools/activation/restore-snapshot.mjs check <vienti> --save (docs/activation/0010-BACKUP-AND-RECOVERY.md)'
      : '';
    gate(OWNER_APPROVAL.MIGRATION,
      `omistaja ajaa ${action.migrationFile} SQL-editorissa: omistajan viesti "${approval}" (kattaa migraation ${action.migration} ja aallon ${wave} deployn, kun ${action.verify} = 0 poikkeavaa)${backup}`,
      { message: approval });
    step('STOP_OWNER_MIGRATION', 'STOP', [
      `migraatio ${action.migrationFile} (sha256 ${(plan.sql.find(f => f.path === action.migrationFile) || {}).sha256 || '?'})`,
      action.backupRequired ? 'varmuuskopio PAKOLLINEN ennen ajoa' : 'varmuuskopio suositeltava',
      `ajon jälkeen: ${action.verify} (vain luku) ja uusi inventaario, sitten orkestroija uudelleen`
    ]);
    plan.state = 'STOP_OWNER_MIGRATION';
    plan.exitCode = 1;
    return plan;
  }

  // ------------------------------------------------- DEPLOY-POLKU
  if (action.migration) {
    if (!input.verifyResult) {
      gate(OWNER_INPUT.READ_ONLY_SQL, `${action.verify}: aja (vain luku) ja liitä tulos --verify-result=<tiedosto>`);
      step('VERIFY', 'PENDING', `${action.verify} -tulos puuttuu`);
    } else {
      const parsed = parseCheckTable(input.verifyResult);
      if (!parsed) { step('VERIFY', 'STOP', 'tulosta ei voitu lukea'); return stop('VERIFY_RESULT_UNREADABLE', `${action.verify}: tulosta ei voitu lukea`, 2); }
      const { expectedChecks, expectedNumbers } = expectedChecksOf(git.show(lock.sqlSource.sha, action.verify));
      const verdict = decide(parsed, { expectedChecks, expectedNumbers });
      if (verdict.decision !== 'GO') { step('VERIFY', 'STOP', verdict.reasons); return stop('VERIFY_FAILED', `${action.verify}: ${verdict.reasons.join('; ')}`); }
      step('VERIFY', 'OK', [`${parsed.rows.length}/${expectedChecks} tarkistusta, 0 poikkeavaa`, `inventaario: migraatio ${action.migration} ajettu`]);
      plan.evidence.migrationVerify = `${path.posix.basename(action.verify)}: ${parsed.rows.length}/${expectedChecks} tarkistusta, 0 poikkeavaa`;
    }
  }

  const deployGate = {
    class: OWNER_APPROVAL.DEPLOY, kind: 'OWNER_APPROVAL', message: approval,
    detail: `aallon ${wave} deploy: omistajan viesti "${approval}"${action.migration ? ` (vasta kun ${path.posix.basename(action.verify)} = 0 poikkeavaa)` : ''} -> --execute-deploy --approved-sha=${record.deployTarget}`
  };

  if (input.approvedSha && input.approvedSha !== record.deployTarget) {
    step('STOP_OWNER_DEPLOY', 'STOP', `hyväksytty SHA ${input.approvedSha} ei ole lukon deployTarget ${record.deployTarget}`);
    return stop('APPROVED_SHA_MISMATCH', `--approved-sha ${input.approvedSha} ei ole aallon ${wave} lukittu deployTarget ${record.deployTarget}: ei pushia`);
  }
  if (!input.executeDeploy || !input.approvedSha) {
    pending.push(deployGate);
    step('STOP_OWNER_DEPLOY', 'STOP', pending.map(g => `${g.class}: ${g.detail}`));
    plan.state = 'STOP_OWNER_DEPLOY';
    plan.exitCode = 1;
    return plan;
  }
  if (pending.length) {
    // Omistaja hyväksyi, mutta koneellinen ehto tai omistajan syöte
    // puuttuu: ei pushia (fail closed).
    step('STOP_OWNER_DEPLOY', 'STOP', pending.map(g => `${g.class}: ${g.detail}`));
    return stop(pending[0].class, `deploy estetty: ${pending.map(g => g.class).join(', ')}`);
  }
  step('STOP_OWNER_DEPLOY', 'OK', [`omistaja hyväksyi ${record.deployTarget} ("${approval}")`,
    `aallon ${prod.codeWave} tekninen hyväksyntä ${state.technicalAcceptance ? state.technicalAcceptance.at : '?'}`]);
  plan.readyToDeploy = true;
  plan.state = 'READY_TO_DEPLOY';
  plan.exitCode = 0;
  return plan;
}

/** Edellinen junan migraatio (0010 -> 0009), tilannekuvan nimeä varten. */
function previousMigrationOf(migration) {
  return String(Number(migration) - 1).padStart(4, '0');
}

// =====================================================================
// SUORITUS (vain --execute-deploy)
// =====================================================================

/**
 * Peruutuspaketti (ACT-10): tulostetaan VERIFY_LIVE-epäonnistumisessa.
 *
 * Järjestys: irrota HEAD pushattuun deployTargetiin, peru aaltocommit
 * ilman committia, nosta CACHE_VERSION seuraavaan vapaaseen versioon
 * (peruutus on deploy, ja deploy nostaa aina), committaa,
 * compare-and-swap (main on yhä deployTarget) ja push revert-commitin
 * SHA:sta ILMAN forcea.
 */
export function rollbackPack(wave, { lock } = {}) {
  const record = lock && lock.waves ? lock.waves.find(w => w.wave === wave) : null;
  const target = rollbackTargetOf(wave);
  const bump = `v${Number(cacheVersionOf(wave).slice(1)) + 1}`;
  const deployTarget = record && record.deployTarget ? record.deployTarget : `<aallon ${wave} deployTarget>`;
  const waveCommit = record && record.waveCommit ? record.waveCommit : `<aallon ${wave} aaltocommit>`;
  return [
    `PERUUTUS aallolle ${wave} -> tila ${target} (omistajan hyväksynnällä; EI force-pushia):`,
    `  git switch --detach ${deployTarget}`,
    `  git revert --no-commit ${waveCommit}`,
    `  # sw.js: nosta CACHE_VERSION ${cacheVersionOf(wave)} -> ${bump} (seuraava vapaa vN; peruutus on deploy ja nostaa aina)`,
    `  git commit -am "revert(release): peru aalto ${wave} (${bump})"`,
    '  git rev-parse HEAD                 # = <revert-sha>',
    `  git ls-remote origin refs/heads/main   # compare-and-swap: oltava yhä ${deployTarget}, muuten SEIS`,
    '  git push origin <revert-sha>:refs/heads/main   (EI --force)',
    `  npm run production:verify-assets -- --rollback-of=${wave}`,
    `  npm run activation:orchestrate -- --verify-rollback-of=${wave} --record`,
    `HUOM: ${bump} on aallon ${nextWaveId(wave) || '-'} varattu versio. Peruutuksen jälkeen juna on`,
    '  TRAIN_HALTED_RECUT_REQUIRED: myöhemmät ehdokkaat leikataan uudelleen uusin versioin',
    '  ja lukko kirjoitetaan uudelleen (train-map --write) ennen seuraavaa deployta.'
  ];
}

/** Hyväksyntäpaketti (TECH_ACCEPTANCE). */
export function acceptancePack(wave, record) {
  const meta = waveById(wave);
  const live = LIVE_USE_VALIDATION[wave];
  const lines = [
    `${TECHNICAL_ACCEPTANCE}: ${TECHNICAL_REQUIREMENTS.map(r => r.id).join(', ')} (kirjattu päiväkirjaan)`,
    `Koneellinen uudelleentodennus: npm run production:verify-assets -- --wave=${wave} --sha=${record.deployTarget}`
  ];
  if (meta.migration) lines.push(`Kanta: ${verifyPathOf(meta.migration)} (vain luku) = 0 poikkeavaa`);
  lines.push(`${LIVE_USE_PENDING} (tiedoksi — ei estä junaa, ei PASS): ${live ? live.doc : record.acceptance}`);
  if (live) for (const item of live.items) lines.push(`  - ${item}`);
  lines.push(`Tuotehaara: päivitä docs/RELEASE-SEQUENCING.md: LINEAGE-CHECK: origin/main sha=${record.deployTarget} cache=${cacheVersionOf(wave)}`
    + ' (jäljessä oleva rivi ei kaada testejä, mutta kertoo väärän nykytilan)');
  if (nextWaveId(wave) === null) lines.push('J:n jälkeen: APK (docs/activation/ANDROID-ACCEPTANCE-BUILD.md; vasta kun verify_0013 = 0 ja J on tuotannossa)');
  return lines;
}

/**
 * Deploy: compare-and-swap ja push. EI force-pushia. Kutsutaan vain,
 * kun planNext() antoi readyToDeploy.
 */
export function executeDeploy(plan, { git, expectedPrevious, approvedSha }) {
  if (!plan.readyToDeploy) return { ok: false, class: 'NOT_READY', reason: 'suunnitelma ei ole valmis deployhin' };
  if (!SHA40.test(String(approvedSha)) || approvedSha !== plan.candidate.sha) {
    return { ok: false, class: 'APPROVED_SHA_MISMATCH', reason: 'hyväksytty SHA ei ole lukittu deployTarget' };
  }
  const remote = git.lsRemoteMain();
  if (remote !== expectedPrevious) {
    return {
      ok: false, class: 'REMOTE_MAIN_MOVED',
      reason: `origin main on ${remote || 'lukematon'}, odotettiin ${expectedPrevious}: joku muu on pushannut — ei pushia`
    };
  }
  const result = git.pushMain(approvedSha);
  if (!result || !result.ok) {
    return { ok: false, class: 'PUSH_FAILED', reason: `push epäonnistui: ${result ? result.output : '?'}` };
  }
  return { ok: true, class: 'PUSHED', reason: `${approvedSha} -> refs/heads/main`, output: result.output };
}

/**
 * VERIFY_LIVE: kysele tuotantoa kunnes aalto, välimuisti, portit ja
 * sormenjälki täsmäävät, tai aikakatkaisu.
 */
export async function pollLive({ fetchImpl, git, wave, sha, timeoutMs = 10 * 60 * 1000, intervalMs = 15000, now = () => new Date(), sleep }) {
  const started = now().getTime();
  const fp = fingerprintOf(sha, (s, p) => git.showBuffer(s, p), preloadOf(git));
  if (!fp) return { ok: false, timedOut: false, attempts: 0, problems: [`commitin ${sha} sw.js puuttuu`] };
  const paths = Object.keys(fp.files);
  let attempts = 0;
  let problems = [];
  for (;;) {
    attempts++;
    const light = await readLiveState({ fetchImpl });
    problems = verifyLive(light, { wave });
    if (!problems.length) {
      const full = await readLiveState({ fetchImpl, paths });
      problems = verifyLive(full, { wave, sha, gitShow: (s, p) => git.showBuffer(s, p), preload: preloadOf(git) });
      if (!problems.length) return { ok: true, timedOut: false, attempts, problems, files: paths.length };
    }
    if (now().getTime() - started >= timeoutMs) return { ok: false, timedOut: true, attempts, problems };
    await sleep(intervalMs);
  }
}

const exceptionPlan = err => ({
  decision: 'STOP', state: 'EXCEPTION', stopClass: 'EXCEPTION', reason: String(err && err.message ? err.message : err),
  steps: [], pendingGates: [], warnings: [], liveUse: [], technicalAcceptance: null
});

/**
 * Koko ajo: tila -> suunnitelma -> (vain --execute-deploy) deploy ->
 * VERIFY_LIVE -> TECH_ACCEPTANCE -> päiväkirja.
 *
 * @returns {Promise<{plan: object, state: object, deploy: object|null,
 *   live: object|null, journal: object|null, exitCode: number}>}
 */
export async function runOrchestrator(deps, options = {}) {
  const {
    live = true, inventoryPath = null, journalPath = JOURNAL_PATH,
    preflightResult = null, verifyResult = null, executeDeploy: execute = false,
    approvedSha = null, wave = null, pollTimeoutMs, pollIntervalMs
  } = options;
  let state;
  try {
    state = await readState(deps, { live, inventoryPath, journalPath });
  } catch (err) {
    return { plan: exceptionPlan(err), state: null, deploy: null, live: null, journal: null, exitCode: 1 };
  }
  let plan;
  try {
    plan = planNext(state, { wave, preflightResult, verifyResult, executeDeploy: execute, approvedSha }, deps);
  } catch (err) {
    return { plan: exceptionPlan(err), state, deploy: null, live: null, journal: null, exitCode: 1 };
  }
  if (!plan.readyToDeploy || !execute) {
    return { plan, state, deploy: null, live: null, journal: null, exitCode: plan.exitCode };
  }

  // ------------------------------------------------------------ DEPLOY
  const record = state.lock.data.waves.find(w => w.wave === plan.candidate.wave);
  const deploy = executeDeploy(plan, { git: deps.git, expectedPrevious: state.production.sha, approvedSha });
  plan.steps.push({ name: 'DEPLOY', status: deploy.ok ? 'OK' : 'STOP', detail: [deploy.reason] });
  const baseEntry = {
    at: (deps.now ? deps.now() : new Date()).toISOString(), type: 'deploy', wave: plan.candidate.wave,
    sha: plan.candidate.sha, previousSha: state.production.sha, approvedSha,
    ownerMessage: ownerMessageFor(plan.candidate.wave),
    previousAcceptance: state.technicalAcceptance
      ? { wave: state.technicalAcceptance.wave, sha: state.technicalAcceptance.sha, at: state.technicalAcceptance.at }
      : null,
    lockSha256: state.lock.sha256
  };
  if (!deploy.ok) {
    plan.decision = 'STOP'; plan.state = deploy.class; plan.stopClass = deploy.class; plan.reason = deploy.reason;
    // Push ei tapahtunut: päiväkirjaan ei ole mitään kirjattavaa tuotannosta.
    return { plan, state, deploy, live: null, journal: null, exitCode: 1 };
  }

  // -------------------------------------------------------- VERIFY_LIVE
  const liveResult = await pollLive({
    fetchImpl: deps.fetchImpl, git: deps.git, wave: plan.candidate.wave, sha: plan.candidate.sha,
    timeoutMs: pollTimeoutMs, intervalMs: pollIntervalMs, now: deps.now, sleep: deps.sleep
  });
  let entry;
  if (!liveResult.ok) {
    plan.steps.push({ name: 'VERIFY_LIVE', status: 'STOP', detail: [...liveResult.problems.slice(0, 10), ...rollbackPack(plan.candidate.wave, { lock: state.lock.data })] });
    plan.decision = 'STOP'; plan.state = 'VERIFY_LIVE_FAILED'; plan.stopClass = 'VERIFY_LIVE_FAILED';
    plan.reason = liveResult.timedOut ? 'tuotanto ei täsmännyt aikarajassa' : liveResult.problems.join('; ');
    entry = { ...baseEntry, result: 'VERIFY_LIVE_FAILED', problems: liveResult.problems.slice(0, 20) };
  } else {
    const checks = {
      ...plan.evidence,
      liveAssets: `sormenjälki ${liveResult.files} tiedostoa = ${plan.candidate.sha.slice(0, 7)} (${liveResult.attempts} kyselyä)`
    };
    plan.steps.push({ name: 'VERIFY_LIVE', status: 'OK', detail: [`välimuisti ${cacheVersionOf(plan.candidate.wave)}, portit, sarakeportit ja sormenjälki täsmäävät (${liveResult.attempts} kyselyä)`] });
    plan.steps.push({ name: 'TECH_ACCEPTANCE', status: 'OK', detail: [TECHNICAL_ACCEPTANCE, LIVE_USE_PENDING, ...acceptancePack(plan.candidate.wave, record)] });
    plan.state = 'DEPLOYED_TECHNICALLY_ACCEPTED';
    plan.reason = `aalto ${plan.candidate.wave} tuotannossa ja teknisesti hyväksytty; käyttötodennus (${LIVE_USE_PENDING}) ei estä. Seuraava askel vaatii uuden ajon.`;
    entry = { ...baseEntry, result: TECHNICAL_ACCEPTANCE, liveUse: LIVE_USE_PENDING, checks };
  }

  // ----------------------------------------------------------- JOURNAL
  let journal = null;
  try {
    journal = { path: appendJournal(entry, { fs: deps.fs, root: deps.root, journalPath }), entry };
    plan.steps.push({ name: 'JOURNAL', status: 'OK', detail: [journal.path] });
  } catch (err) {
    plan.steps.push({ name: 'JOURNAL', status: 'STOP', detail: [String(err.message || err)] });
    plan.decision = 'STOP'; plan.stopClass = 'JOURNAL_WRITE_FAILED';
  }
  return { plan, state, deploy, live: liveResult, journal, exitCode: liveResult.ok && journal ? 0 : 1 };
}

/**
 * Peruutuksen todennus ja kirjaus (ACT-10). Kirjoittaa päiväkirjaan
 * vain, kun `record` on tosi.
 */
export async function verifyRollback(deps, { rollbackOf, record = false, journalPath = JOURNAL_PATH }) {
  const lockFile = path.join(deps.root, LOCK_PATH);
  const lockText = deps.fs.existsSync(lockFile) ? String(deps.fs.readFileSync(lockFile, 'utf8')) : '';
  const live = await readLiveState({ fetchImpl: deps.fetchImpl });
  const problems = verifyLive(live, { rollbackOf });
  const result = { ok: problems.length === 0, problems, live: { cacheVersion: live.cacheVersion, wave: live.wave, state: live.state.label }, journal: null };
  if (result.ok && record) {
    const entry = {
      at: (deps.now ? deps.now() : new Date()).toISOString(), type: 'rollback', wave: rollbackOf,
      cacheVersion: live.cacheVersion, state: 'TRAIN_HALTED_RECUT_REQUIRED',
      lockSha256: sha256(lockText.replace(/\r\n/g, '\n'))
    };
    result.journal = { path: appendJournal(entry, { fs: deps.fs, root: deps.root, journalPath }), entry };
  }
  return result;
}

// =====================================================================
// TEKNINEN HYVÄKSYNTÄ LIVE-TODENNUKSESTA (C ja palautuminen)
// =====================================================================

/**
 * Tuotannossa olevan aallon tekninen hyväksyntä ilman deployta: C
 * deployattiin ennen näitä työkaluja, ja myöhemmän aallon deployn
 * VERIFY_LIVE voi aikakatkaista vaikka tuotanto täsmäisi hetken päästä.
 *
 * Tarkistaa KAIKKI TECHNICAL_REQUIREMENTS-ehdot. Ehdokkaan testiajo ja
 * käynnistyssavu ovat pakollisia muille kuin aallolle C (PRE_TOOLING_WAVE),
 * jonka hyväksyntä perustuu omistajan päätöksellä live-todennukseen (C:lle
 * kirjattu testiajo tai savu näytetään todisteena). Ei kirjoita mitään.
 *
 * @param {object} deps { git, fs, root, fetchImpl, now }
 * @param {object} options { wave, sha, verifyResult?, inventoryPath?, journalPath? }
 * @returns {Promise<{ok: boolean, problems: string[], checks: object, entry: object|null}>}
 */
export async function technicalAcceptance(deps, { wave, sha, verifyResult = null, inventoryPath = null, journalPath = JOURNAL_PATH }) {
  const { git, fs, root } = deps;
  const now = deps.now ? deps.now() : new Date();
  const problems = [];
  const checks = {};
  const fail = message => ({ ok: false, problems: [message], checks, entry: null });

  if (!waveById(wave) || wave === 'BASE' || waveIndex(wave) < waveIndex(TRAIN_FLOOR_WAVE)) return fail(`aalto ${wave} ei ole junan C–J aalto`);
  if (!SHA40.test(String(sha))) return fail(`--sha vaatii 40-merkkisen SHA:n (annettiin ${sha || '-'})`);

  const journal = readJournal({ fs, root, journalPath });
  if (journal.problems.length) return fail(`päiväkirja: ${journal.problems.join('; ')}`);

  // Tuotanto: juuri tämä aalto ja commit.
  const prod = productionState(git, now);
  if (!prod.available) problems.push('origin/main ei ole paikallisesti saatavilla (git fetch, vain luku)');
  else if (prod.deployed.state !== 'WAVE') problems.push(`origin/mainin tila on ${prod.deployed.label}: ei aalto`);
  else {
    if (prod.codeWave !== wave) problems.push(`origin/main on aalto ${prod.codeWave}, ei ${wave}`);
    if (prod.sha !== sha) problems.push(`origin/main on ${prod.sha}, ei ${sha}: vain tuotannossa oleva commit hyväksytään`);
  }

  // Lukko ja sukulinja.
  const lockProblems = [];
  const lockState = readLockState({ fs, root, git }, lockProblems);
  problems.push(...lockProblems);
  const lock = lockState.data;
  const record = lock && Array.isArray(lock.waves) ? lock.waves.find(w => w.wave === wave) : null;
  if (!record) problems.push(`lukossa ei ole aaltoa ${wave}`);
  else {
    if (record.deployTarget !== sha) problems.push(`${sha.slice(0, 7)} ei ole aallon ${wave} lukittu deployTarget ${String(record.deployTarget).slice(0, 7)}`);
    if (record.consistent !== true) problems.push(`lukon tietue ${wave} ei ole johdonmukainen`);
    if (record.missingPatches && record.missingPatches.length) problems.push(`aallolta ${wave} puuttuu pakollisia korjauksia (${record.missingPatches.map(s => s.slice(0, 7)).join(', ')})`);
    const lockWave = lockState.check ? lockState.check.waves.find(w => w.wave === wave) : null;
    if (!lockWave) problems.push('lukon tarkistus puuttuu');
    else for (const p of lockWave.problems || []) problems.push(`lukko: ${p}`);
    const index = lock.waves.indexOf(record);
    const parent = index > 0 ? lock.waves[index - 1] : null;
    if (parent) {
      const ancestor = git.isAncestor(parent.deployTarget, sha);
      if (ancestor !== true) problems.push(`${sha.slice(0, 7)} ei ole aallon ${parent.wave} (${String(parent.deployTarget).slice(0, 7)}) jälkeläinen`);
      else checks.ancestry = `fast-forward ${parent.wave} ${parent.deployTarget.slice(0, 7)} -> ${wave} ${sha.slice(0, 7)} (lukon deployTarget)`;
    } else {
      checks.ancestry = `${wave} = junan lattia: tuotannossa ennen aktivointityökaluja (lukon tietue johdonmukainen)`;
    }
  }

  // Välimuisti, portit ja sarakeportit ehdokkaan omista tiedostoista.
  const cc = candidateChecks(git, wave, sha);
  if (!cc.cache.ok) problems.push(`sw.js on ${cc.cache.actual}, odotettiin ${cc.cache.expected}`);
  if (!cc.gates.ok) problems.push(`porttimatriisi poikkeaa: ${cc.gates.differences.join(', ')}`);
  if (!cc.columnGates.ok) problems.push(`sarakeportit poikkeavat: ${cc.columnGates.differences.join(', ')}`);

  // Julkaisun esitarkistus ja tietoturvahaku.
  const preflight = candidatePreflight(git, wave, sha, lock && lock.sqlSource ? lock.sqlSource.sha : null);
  for (const f of preflight.failures) problems.push(`esitarkistus (repoChecks): ${f}`);
  if (preflight.ok) {
    checks.repoPreflight = `repoChecks ${preflight.checks} tarkistusta PASS`;
    checks.security = 'git grep: ei AI-avaimia, ei palvelinroolin avainta selaimen koodissa';
  }

  // Migraatioedellytys: kanta tukee aaltoa.
  const inventory = loadInventory({ fs, root, inventoryPath });
  if (inventory.status !== 'OK') {
    problems.push(`${OWNER_INPUT.READ_ONLY_SQL}: inventaario ${inventory.status}${inventory.source ? ` (${inventory.source})` : ''}`);
  } else {
    const classification = classifyActivation(inventory.rows, { codeWave: wave, lock });
    if (classification.decision === 'STOP') problems.push(`migraatioedellytys: ${classification.reason}`);
    else checks.migrationPrerequisite = `inventaario ${inventory.source}${inventory.reconstructed ? ' (rekonstruoitu)' : ''}: kanta ${classification.currentDbWave} (viimeisin migraatio ${classification.lastMigration}) tukee aaltoa ${wave}`;
  }

  // verify_00XX (migraatioaallot).
  const meta = waveById(wave);
  if (meta.migration) {
    const verifyPath = verifyPathOf(meta.migration);
    if (!verifyResult) problems.push(`${OWNER_INPUT.READ_ONLY_SQL}: ${verifyPath} -tulos puuttuu (--verify-result=<tiedosto>)`);
    else {
      const parsed = parseCheckTable(verifyResult);
      const source = lock && lock.sqlSource ? lock.sqlSource.sha : null;
      const { expectedChecks = null, expectedNumbers = null } = source ? expectedChecksOf(git.show(source, verifyPath)) : {};
      const verdict = parsed ? decide(parsed, { expectedChecks, expectedNumbers }) : null;
      if (!parsed) problems.push(`${verifyPath}: tulosta ei voitu lukea`);
      else if (verdict.decision !== 'GO') problems.push(`${verifyPath}: ${verdict.reasons.join('; ')}`);
      else checks.migrationVerify = `${path.posix.basename(verifyPath)}: ${parsed.rows.length}/${expectedChecks} tarkistusta, 0 poikkeavaa`;
    }
  } else {
    checks.migrationVerify = 'ei migraatiota';
  }

  // Ehdokkaan oma testipatteristo.
  const tests = candidateTestsOf(journal.entries, { wave, sha });
  if (tests.ok) checks.candidateTests = `node --test ${tests.entry.pass}/${tests.entry.tests} PASS, fail 0 (${tests.entry.at})`;
  else if (wave === PRE_TOOLING_WAVE) checks.candidateTests = `${wave}: ei kirjattua ajoa — ${wave} deployattiin ennen aktivointityökaluja; hyväksyntä live-todennuksesta (omistajan päätös 2026-09-26)`;
  else problems.push(`${TECHNICAL_GATE.CANDIDATE_TESTS}: ${candidateTestsCommand(wave, sha)}`);

  // Ehdokkaan käynnistyssavu omalla koodilla ja porteilla (sama poikkeus C:lle).
  const smoke = bootSmokeOf(journal.entries, { wave, sha });
  if (smoke.ok) checks.bootSmoke = bootSmokeEvidence(smoke.entry);
  else if (wave === PRE_TOOLING_WAVE) checks.bootSmoke = `${wave}: ei kirjattua savua — ${wave} deployattiin ennen aktivointityökaluja; hyväksyntä live-todennuksesta (omistajan päätös 2026-09-26)`;
  else problems.push(`${TECHNICAL_GATE.BOOT_SMOKE}: ${bootSmokeCommand(wave, sha)}`);

  // Live: tuotanto tarjoilee juuri tämän commitin.
  if (typeof deps.fetchImpl !== 'function') {
    problems.push('LIVE_REQUIRED: tekninen hyväksyntä vaatii tuotannon live-todennuksen (verkkohaku puuttuu)');
  } else {
    const fp = fingerprintOf(sha, (s, p) => git.showBuffer(s, p), preloadOf(git));
    if (!fp) problems.push(`commitin ${sha} sw.js puuttuu: sormenjälkeä ei voitu laskea`);
    else {
      const live = await readLiveState({ fetchImpl: deps.fetchImpl, paths: Object.keys(fp.files) });
      const liveProblems = verifyLive(live, { wave, sha, gitShow: (s, p) => git.showBuffer(s, p), preload: preloadOf(git) });
      if (liveProblems.length) problems.push(...liveProblems.slice(0, 10).map(p => `live: ${p}`));
      else {
        checks.liveAssets = `sormenjälki ${Object.keys(fp.files).length} tiedostoa = ${sha.slice(0, 7)}`;
        checks.cacheAndGates = `live ja commit: ${cc.cache.actual}, ${cc.gates.open.length} porttia, sarakeportit ${Object.entries(cc.columnGates.expected).map(([g, v]) => `${g}=${v}`).join(' ')}`;
      }
    }
  }

  const missing = TECHNICAL_REQUIREMENTS.filter(r => !checks[r.id]).map(r => r.id);
  if (!problems.length && missing.length) problems.push(`ehtoja ei todennettu: ${missing.join(', ')}`);
  if (problems.length) return { ok: false, problems, checks, entry: null };
  return {
    ok: true, problems, checks,
    entry: {
      at: now.toISOString(), type: 'technical-acceptance', wave, sha, result: TECHNICAL_ACCEPTANCE,
      source: 'live-todennus', liveUse: LIVE_USE_PENDING, checks, lockSha256: lockState.sha256
    }
  };
}

/**
 * Kirjaa tekninen hyväksyntä päiväkirjaan (paikallinen, git-ignoroitu),
 * vain jos jokainen ehto täyttyy.
 */
export async function recordTechnicalAcceptance(deps, options) {
  const result = await technicalAcceptance(deps, options);
  if (!result.ok) return { ...result, journal: null };
  const journalPath = options.journalPath || JOURNAL_PATH;
  return { ...result, journal: { path: appendJournal(result.entry, { fs: deps.fs, root: deps.root, journalPath }), entry: result.entry } };
}

/**
 * Ehdokaskirjauksen kohde: junan C–J aalto, 40-merkkinen SHA, joka on
 * aallon lukittu deployTarget ja löytyy paikallisesti. null = kelpaa,
 * muuten syy.
 */
function candidateTargetProblem({ git, fs, root }, wave, sha) {
  if (!waveById(wave) || wave === 'BASE' || waveIndex(wave) < waveIndex(TRAIN_FLOOR_WAVE)) return `aalto ${wave} ei ole junan C–J aalto`;
  if (!SHA40.test(String(sha))) return `--sha vaatii 40-merkkisen SHA:n (annettiin ${sha || '-'})`;
  const lockProblems = [];
  const lock = readLockState({ fs, root, git }, lockProblems).data;
  const record = lock && Array.isArray(lock.waves) ? lock.waves.find(w => w.wave === wave) : null;
  if (!record) return `lukossa ei ole aaltoa ${wave}${lockProblems.length ? ` (${lockProblems.join('; ')})` : ''}`;
  if (record.deployTarget !== sha) return `${sha.slice(0, 7)} ei ole aallon ${wave} lukittu deployTarget ${String(record.deployTarget).slice(0, 7)}`;
  if (!git.revParse(sha)) return `committia ${sha} ei ole paikallisesti`;
  return null;
}

/**
 * Kirjaa ehdokkaan oman testipatteriston vihreä ajo. Vain lukon
 * deployTargetille, ja vain vihreä yhteenveto (fail 0, cancelled 0).
 *
 * @param {object} deps { git, fs, root, now }
 * @param {object} options { wave, sha, testsText, journalPath? }
 */
export function recordCandidateTests(deps, { wave, sha, testsText, journalPath = JOURNAL_PATH }) {
  const { fs, root } = deps;
  const refuse = reason => ({ ok: false, reason, journal: null });
  const target = candidateTargetProblem(deps, wave, sha);
  if (target) return refuse(target);
  const summary = parseTestSummary(testsText);
  if (!summary) return refuse('testituloksesta ei löytynyt node --test -yhteenvetoa (tests/pass/fail)');
  if (!testSummaryGreen(summary)) {
    return refuse(`testiajo ei ole vihreä: ${summary.pass}/${summary.tests} PASS, fail ${summary.fail}, cancelled ${summary.cancelled} — ei kirjata`);
  }
  const entry = {
    at: (deps.now ? deps.now() : new Date()).toISOString(), type: 'candidate-tests', wave, sha, result: 'PASS',
    command: 'node --test', tests: summary.tests, pass: summary.pass, fail: summary.fail,
    cancelled: summary.cancelled, skipped: summary.skipped, todo: summary.todo, outputSha256: summary.sha256
  };
  return { ok: true, reason: null, entry, journal: { path: appendJournal(entry, { fs, root, journalPath }), entry } };
}

/**
 * Kirjaa ehdokkaan käynnistyssavu (tools/e2e/boot-smoke.mjs). Vain lukon
 * deployTargetille, ja vain yhden ajon tuloste, jonka viimeinen rivi on
 * `KÄYNNISTYSSAVU [aalto]: PASS (n/n; poikkeuksia 0, hylkäyksiä 0,
 * konsolivirheitä 0, tuotantopyyntöjä 0)` ja jonka EHDOKAS-rivin täysi
 * HEAD on juuri tämä SHA omilla porteilla ja --expect-sha:lla
 * (acceptance-policy.mjs bootSmokeProblems). Hylätty tuloste ei kirjoita
 * mitään.
 *
 * @param {object} deps { git, fs, root, now }
 * @param {object} options { wave, sha, smokeText, journalPath? }
 */
export function recordBootSmoke(deps, { wave, sha, smokeText, journalPath = JOURNAL_PATH }) {
  const { fs, root } = deps;
  const refuse = reason => ({ ok: false, reason, journal: null });
  const target = candidateTargetProblem(deps, wave, sha);
  if (target) return refuse(target);
  if (smokeText === null || smokeText === undefined || !String(smokeText).trim()) {
    return refuse('käynnistyssavun tuloste puuttuu tai on tyhjä (--smoke-result=<tiedosto>)');
  }
  if (String(smokeText).includes('\u0000')) {
    return refuse('käynnistyssavun tuloste on UTF-16-muodossa (Windows PowerShellin >): aja komento Git Bashissa tai sh:ssa');
  }
  const summary = parseBootSmoke(smokeText);
  const problems = bootSmokeProblems(summary, { wave, sha });
  if (problems.length) return refuse(`käynnistyssavua ei kirjata: ${problems.join('; ')}`);
  const entry = {
    at: (deps.now ? deps.now() : new Date()).toISOString(), type: 'boot-smoke', wave, sha, result: 'PASS',
    command: `npm run e2e:boot-smoke -- --label ${wave} --expect-sha ${sha}`, gates: summary.candidate.gates,
    pass: summary.pass, total: summary.total, exceptions: summary.exceptions, rejections: summary.rejections,
    consoles: summary.consoles, production: summary.production, outputSha256: summary.sha256
  };
  return { ok: true, reason: null, entry, journal: { path: appendJournal(entry, { fs, root, journalPath }), entry } };
}

// =====================================================================
// DRY-RUN-RAPORTTI (ACT-13)
// =====================================================================

const gateLine = g => `${g.class} — ${g.detail}`;

/** Dry-runin kentät objektina (--json) ja riveinä. */
export function dryRunReport(state, plan) {
  const prod = state.production;
  const c = state.classification;
  const action = plan.nextAction;
  const cand = plan.candidate;
  const gates = plan.pendingGates || [];
  const approvals = gates.filter(g => g.kind === 'OWNER_APPROVAL');
  const inputs = gates.filter(g => g.kind === 'OWNER_INPUT');
  const technical = gates.filter(g => g.kind === 'TECHNICAL');
  const liveUse = plan.liveUse || [];
  const report = {
    PRODUCTION_SHA: prod.sha,
    FETCH_HEAD: prod.fetchHeadTime ? { at: prod.fetchHeadTime, ageHours: prod.fetchHeadAgeHours } : null,
    CURRENT_WAVE: prod.deployed ? prod.deployed.label : null,
    CURRENT_CACHE: prod.cacheVersion,
    LIVE: state.live ? { checked: state.live.checked, matches: state.live.matchesProductionSha === true, cacheVersion: state.live.cacheVersion ?? null, problems: state.live.problems } : 'OFFLINE',
    INVENTORY: state.inventory.status === 'OK'
      ? { source: state.inventory.source, doc: state.inventory.doc, reconstructed: state.inventory.reconstructed, capturedAt: state.inventory.capturedAt, decision: c.base.decision }
      : { status: state.inventory.status, required: 'OWNER_READ_ONLY_SQL_REQUIRED' },
    CURRENT_DB_WAVE: c ? c.currentDbWave : null,
    LAST_MIGRATION: c ? c.lastMigration : null,
    TECHNICAL_ACCEPTANCE: plan.technicalAcceptance,
    NEXT_ACTION: action ? { kind: action.kind, wave: action.wave, migration: action.migration } : null,
    NEXT_MIGRATION: plan.nextMigration,
    NEXT_DEPLOYMENT: cand ? { wave: cand.wave, sha: cand.sha, afterMigration: action && action.kind === 'MIGRATE' ? action.migration : null } : null,
    RISK: plan.risk,
    REQUIRED_OWNER_GATE: approvals,
    REQUIRED_OWNER_INPUT: inputs,
    REQUIRED_TECHNICAL_GATE: technical,
    LIVE_USE_VALIDATION_PENDING: liveUse,
    EXPECTED_CANDIDATE_SHA: cand ? { sha: cand.sha, ref: cand.ref, refMatchesLock: cand.refMatchesLock, fastForwardFromProduction: cand.fastForward, missingPatches: cand.missingPatches } : null,
    EXPECTED_CACHE: cand ? cand.checks.cache : null,
    EXPECTED_SCHEMA_GATE: cand ? { gates: cand.checks.gates, columnGates: cand.checks.columnGates } : null,
    REPO_PREFLIGHT: cand && cand.preflight ? cand.preflight : null,
    SQL: plan.sql.map(f => ({ role: f.role, path: f.path, sha256: f.sha256, source: `${f.sourceRef} @ ${f.sourceSha}`, matchesLock: f.matchesLock, matchesHead: f.matchesHead })),
    DECISION: plan.decision,
    STATE: plan.state,
    REASON: plan.reason,
    WARNINGS: plan.warnings
  };
  const yes = v => (v === true ? 'OK' : (v === false ? 'EI' : '?'));
  const lines = [];
  lines.push(`PRODUCTION_SHA: ${prod.sha || 'ei saatavilla'}` + (prod.fetchHeadTime ? `  (FETCH_HEAD ${prod.fetchHeadTime}, ${prod.fetchHeadAgeHours} h sitten)` : '  (FETCH_HEAD: tuntematon)'));
  lines.push(`CURRENT_WAVE: ${report.CURRENT_WAVE || '-'}`);
  lines.push(`CURRENT_CACHE: ${prod.cacheVersion || '-'}`);
  lines.push(`LIVE: ${state.live ? (state.live.matchesProductionSha ? `OK — tuotanto tarjoilee ${prod.sha ? prod.sha.slice(0, 7) : '?'} (${state.live.cacheVersion})` : `POIKKEAMA — ${state.live.problems.slice(0, 3).join('; ')}`) : 'OFFLINE (ei tarkistettu)'}`);
  if (state.inventory.status === 'OK') {
    lines.push(`INVENTORY: ${state.inventory.source}${state.inventory.reconstructed ? ' — REKONSTRUOITU omistajan yhteenvedosta' : ''}${state.inventory.capturedAt ? `, ${state.inventory.capturedAt}` : ''}${state.inventory.doc ? ` (${state.inventory.doc})` : ''}; kanta ${c.base.decision}`);
  } else {
    lines.push(`INVENTORY: UNKNOWN — OWNER_READ_ONLY_SQL_REQUIRED (${state.inventory.status}${state.inventory.source ? `: ${state.inventory.source}` : ''})`);
  }
  lines.push(`CURRENT_DB_WAVE: ${c ? `${c.currentDbWave || '-'} (viimeisin ajettu migraatio ${c.lastMigration || '-'})` : '-'}`);
  const ta = plan.technicalAcceptance;
  lines.push(`TECHNICAL_ACCEPTANCE: ${ta ? (ta.status === TECHNICAL_ACCEPTANCE
    ? `${ta.wave} ${ta.sha.slice(0, 7)} = ${TECHNICAL_ACCEPTANCE} (${ta.at})`
    : `${ta.wave} ${ta.sha.slice(0, 7)} PUUTTUU — ${ta.command}`) : '-'}`);
  lines.push(`NEXT_ACTION: ${action ? [action.kind, action.wave, action.kind === 'MIGRATE' ? action.migration : null].filter(Boolean).join(' ') : '-'}`);
  lines.push(`NEXT_MIGRATION: ${plan.nextMigration ? `${plan.nextMigration.migration} (aalto ${plan.nextMigration.wave})${plan.nextMigration.deferred ? ` — ODOTTAA: ${plan.nextMigration.waitsFor}` : ' — SEURAAVA'}` : 'ei (kaikki ajettu)'}`);
  lines.push(`NEXT_DEPLOYMENT: ${cand ? `${cand.wave} ${cand.sha}${action.kind === 'MIGRATE' ? ` (migraation ${action.migration} jälkeen)` : ''}` : '-'}`);
  lines.push(`RISK: ${plan.risk ? `${plan.risk.label} (${plan.risk.level})${plan.risk.backupRequired ? ', varmuuskopio PAKOLLINEN' : ''}` : '-'}`);
  lines.push(`REQUIRED_OWNER_GATE: ${approvals.length ? approvals.map(gateLine).join(' | ') : '-'}`);
  lines.push(`REQUIRED_OWNER_INPUT: ${inputs.length ? inputs.map(gateLine).join(' | ') : '-'}`);
  lines.push(`REQUIRED_TECHNICAL_GATE: ${technical.length ? technical.map(gateLine).join(' | ') : '-'}`);
  for (const lu of liveUse) {
    lines.push(`LIVE_USE_VALIDATION_PENDING: ${lu.wave} — tiedoksi, ei estä junaa eikä ole PASS (${lu.doc})`);
    for (const item of lu.items) lines.push(`  - ${item}`);
  }
  lines.push(`EXPECTED_CANDIDATE_SHA: ${cand ? `${cand.sha} (lukko; ref ${cand.ref} == lukko: ${yes(cand.refMatchesLock)}; fast-forward tuotannosta: ${yes(cand.fastForward)}${cand.missingPatches.length ? `; PUUTTUVAT KORJAUKSET ${cand.missingPatches.map(s => s.slice(0, 7)).join(', ')}` : ''})` : '-'}`);
  lines.push(`EXPECTED_CACHE: ${cand ? `${cand.checks.cache.expected} (git show ${cand.sha.slice(0, 7)}:sw.js = ${cand.checks.cache.actual || '?'}: ${yes(cand.checks.cache.ok)})` : '-'}`);
  lines.push(`EXPECTED_SCHEMA_GATE: ${cand ? `${cand.checks.gates.open.length} porttia auki (${cand.checks.gates.open.join(', ')}); sarakeportit ${Object.entries(cand.checks.columnGates.expected).map(([g, v]) => `${g}=${v}`).join(' ')} (git show ${cand.sha.slice(0, 7)}:src/data/schema.js: ${yes(cand.checks.gates.ok && cand.checks.columnGates.ok)})` : '-'}`);
  if (cand && cand.preflight) {
    lines.push(`REPO_PREFLIGHT: ${cand.preflight.failures.length ? `FAIL — ${cand.preflight.failures.slice(0, 3).join('; ')}` : `PASS (${cand.preflight.checks} tarkistusta, tietoturvahaku ${cand.preflight.securityOk ? 'ok' : 'EI AJETTU'})`}`);
  }
  if (plan.sql.length) {
    lines.push('SQL:');
    for (const f of plan.sql) lines.push(`  ${f.path}  sha256 ${f.sha256 || 'PUUTTUU'}  [${f.role}]  lähde ${f.sourceRef} @ ${f.sourceSha}${f.matchesLock ? '' : '  EI VASTAA LUKKOA'}`);
  } else {
    lines.push('SQL: ei ajettavaa ennen seuraavaa askelta');
  }
  for (const w of plan.warnings) lines.push(`HUOM: ${w}`);
  if (plan.decision === 'STOP') {
    lines.push(`STOP: ${plan.stopClass} — ${plan.reason}`);
  } else if (plan.decision === 'DONE') {
    lines.push(`GO: DONE — ${plan.reason}`);
  } else {
    const next = [action.kind, action.wave, action.kind === 'MIGRATE' ? action.migration : null].filter(Boolean).join(' ');
    const waiting = [
      technical.length ? `koneelliset (${technical.map(g => g.class).join(', ')})` : null,
      inputs.length ? `omistajan vain lukeva SQL (${inputs.length})` : null,
      approvals.length ? `omistajan hyväksyntä ${approvals.map(g => `"${g.message}"`).join(', ')}` : null
    ].filter(Boolean);
    lines.push(`GO: seuraava askel ${next} — ${waiting.length ? `odottaa: ${waiting.join('; ')} (${plan.state})` : plan.state}`);
  }
  return { report, lines };
}

/** Dry-run: ei kirjoituksia, ei git-muutoksia; verkko vain live-GET:iin. */
export async function runDryRun(deps, { live = true, inventoryPath = null, journalPath = JOURNAL_PATH } = {}) {
  let state;
  let plan;
  try {
    state = await readState(deps, { live, inventoryPath, journalPath });
    plan = planNext(state, {}, deps);
  } catch (err) {
    return { report: { DECISION: 'STOP', STATE: 'EXCEPTION', REASON: String(err && err.message ? err.message : err) }, lines: [`STOP: EXCEPTION — ${err && err.message ? err.message : err}`], exitCode: 1 };
  }
  const { report, lines } = dryRunReport(state, plan);
  const exitCode = plan.decision === 'STOP' ? (plan.exitCode === 2 ? 2 : 1) : 0;
  return { report, lines, exitCode, plan, state };
}
