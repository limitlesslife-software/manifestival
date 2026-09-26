// Aktivoinnin orkestroija: junan C–J seuraava turvallinen askel (ACT-01).
//
// MITÄ TÄMÄ ON
//
// Puhtaat suunnittelufunktiot ja yksi suoritusfunktio, joille KAIKKI
// sivuvaikutukset annetaan parametreina (`deps`):
//
//   git       tools/release/git-layer.mjs -rajapinta (testeissä tynkä)
//   fetchImpl tuotannon staattisten tiedostojen GET (testeissä tynkä)
//   fs        tiedostojen luku; päiväkirjaan kirjoitus VAIN suoritustilassa
//   root      projektin juuri
//   now       () => Date
//   sleep     ms => Promise (VERIFY_LIVE-kyselyväli)
//
// Komentorivit: scripts/activation-orchestrate.mjs ja
// scripts/activation-dry-run.mjs. Kumpikaan ei sisällä logiikkaa.
//
// VAIHEET (yksi aalto kerrallaan, EI KOSKAAN automaattisesti seuraavaan)
//
//   READ_STATE            tuotanto = origin/main (paikallinen) + live-GET
//                         ristiintarkistus; kanta = inventaario;
//                         luokitus classifyActivation (ACT-05)
//   PREFLIGHT_REPO        lukko: ref == lukittu SHA, tietue johdonmukainen,
//                         pakolliset korjaukset mukana, isAncestor(tuotanto,
//                         ehdokas), ehdokkaan sw.js/schema.js odotusten mukaiset
//   PREFLIGHT_DB          (MIGRATE) omistajan liittämä preflight_M-tulos:
//                         0 FAIL, 0 poikkeavaa, kaikki rivit
//   STOP_OWNER_MIGRATION  (MIGRATE) aina seis: omistaja ajaa migraation
//   VERIFY                (migraatioaallon DEPLOY) verify_M-tulos 0 poikkeavaa
//                         ja tuore inventaario näyttää M:n ajetuksi
//   STOP_OWNER_DEPLOY     seis, ellei --execute-deploy --approved-sha=<lukon
//                         deployTarget> ja tuotannon aallon hyväksyntä
//   DEPLOY                compare-and-swap: ls-remote main == odotettu
//                         edellinen SHA, sitten push <sha>:refs/heads/main
//                         (EI force)
//   VERIFY_LIVE           kysele tuotantoa kunnes välimuisti, portit ja
//                         sormenjälki täsmäävät; aikakatkaisu -> STOP +
//                         peruutuspaketti
//   TECH_ACCEPTANCE       AUTOMATED_TECHNICAL_ACCEPTANCE vs
//                         LIVE_USE_VALIDATION_PENDING (omistajan UI-hyväksyntä)
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
import { countChecksInSql, decide, parseCheckTable } from './score-sql-result.mjs';
import { LOCK_PATH, checkTrainMap } from './train-map.mjs';
import { originMainStateFrom } from '../release/lineage.mjs';
import { parseCacheVersion, parseGates } from '../release/state.mjs';
import {
  ALL_GATES, COLUMN_GATES, RISK_LABEL_FI, cacheVersionOf, classifyDeployedState,
  cumulativeGates, expectedMatrix, nextWaveId, preflightPathOf, previousWaveId,
  rollbackTargetOf, verifyPathOf, waveById, waveIndex
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

/** Lisää päiväkirjaan yksi rivi. Kutsutaan VAIN suoritustilassa. */
export function appendJournal(entry, { fs, root, journalPath = JOURNAL_PATH }) {
  const full = resolveJournalPath(root, journalPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.appendFileSync(full, JSON.stringify(entry) + '\n', 'utf8');
  return full;
}

/** Hyväksytyt aallot päiväkirjasta. */
export function acceptedWavesFrom(entries) {
  const accepted = new Set();
  for (const e of entries) {
    if (e.type === 'acceptance' && e.wave) accepted.add(e.wave);
    if (e.type === 'deploy' && e.acceptedWave) accepted.add(e.acceptedWave);
  }
  return [...accepted];
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

/**
 * Lue kaikki tila. Verkko vain, jos `live` on tosi ja fetchImpl annettu.
 *
 * @param {object} deps { git, fs, root, fetchImpl?, now? }
 * @param {object} [options] { live, inventoryPath, accepted, journalPath }
 */
export async function readState(deps, { live = false, inventoryPath = null, accepted = [], journalPath = JOURNAL_PATH } = {}) {
  const { git, fs, root } = deps;
  const now = deps.now ? deps.now() : new Date();
  const state = { now: now.toISOString(), problems: [] };

  state.production = productionState(git, now);

  const lockFile = path.join(root, LOCK_PATH);
  if (fs.existsSync(lockFile)) {
    const text = String(fs.readFileSync(lockFile, 'utf8'));
    let data = null;
    try { data = JSON.parse(text); } catch { state.problems.push('lukko ei ole JSON:ia'); }
    state.lock = { data, sha256: sha256(text.replace(/\r\n/g, '\n')), check: data ? checkTrainMap(data, { git }) : null };
  } else {
    state.lock = { data: null, sha256: null, check: null };
  }

  state.journal = readJournal({ fs, root, journalPath });
  // Luokitus käyttää VAIN päiväkirjaan kirjattuja hyväksyntöjä. Tämän
  // ajon --accepted käsitellään suunnitelmassa, jotta se kirjautuu
  // deployn päiväkirjariviin.
  state.acceptedWaves = acceptedWavesFrom(state.journal.entries);
  state.cliAccepted = [...accepted];
  state.halt = state.lock.sha256 ? haltFrom(state.journal.entries, state.lock.sha256) : null;

  state.inventory = loadInventory({ fs, root, inventoryPath });
  state.classification = state.inventory.status === 'OK'
    ? classifyActivation(state.inventory.rows, {
      codeWave: state.production.codeWave, acceptedWaves: state.acceptedWaves, lock: state.lock.data
    })
    : null;

  state.workingTree = git.statusPorcelain ? git.statusPorcelain() : null;

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
        state: liveState.state.label, matchesProductionSha: problems.length === 0, problems
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

/**
 * Seuraava askel. Puhdas funktio: ei I/O:ta (git-kerrosta käytetään
 * vain lukemiseen ehdokkaan ja SQL-tiedostojen ristiintarkistukseen).
 *
 * @param {object} state readState()-tulos
 * @param {object} input { wave, preflightResult, verifyResult,
 *   executeDeploy, approvedSha, requireCleanTree }
 * @param {object} deps { git }
 */
export function planNext(state, input = {}, { git }) {
  const steps = [];
  const pending = [];
  const warnings = [];
  const plan = {
    decision: 'GO', state: null, stopClass: null, reason: null, steps, pendingGates: pending, warnings,
    nextAction: null, candidate: null, sql: [], risk: null, nextMigration: null, readyToDeploy: false,
    exitCode: 1
  };
  const step = (name, status, detail = []) => steps.push({ name, status, detail: [].concat(detail) });
  const stop = (stopClass, reason, exitCode = 1) => {
    plan.decision = 'STOP'; plan.state = stopClass; plan.stopClass = stopClass; plan.reason = reason; plan.exitCode = exitCode;
    return plan;
  };

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

  const c = state.classification;
  plan.nextAction = c.nextAction;
  const base = c.base;
  if (base.nextMigration) {
    // Migraatio M (aalto W) ajetaan vasta, kun tuotannossa on W:tä
    // edeltävä aalto: 0009 (F) vasta kun E on deployattu ja hyväksytty.
    const needsCode = previousWaveId(base.nextWave);
    plan.nextMigration = {
      migration: base.nextMigration,
      wave: base.nextWave,
      deferred: c.codeWave !== needsCode,
      waitsFor: c.codeWave !== needsCode ? `aalto ${needsCode} tuotannossa ja hyväksytty` : null
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
  plan.candidate = {
    wave, sha: record.deployTarget, ref: record.ref, waveCommit: record.waveCommit,
    refMatchesLock: lockWave ? !(lockWave.problems || []).some(p => /ref /.test(p)) : false,
    fastForward, missingPatches: record.missingPatches || [], checks, acceptance: record.acceptance
  };
  plan.sql = sqlFilesFor(action, lock, git);
  if (lockProblems.length) repo.push(...lockProblems);
  if (record.consistent !== true) repo.push(`lukon tietue ${wave} ei ole johdonmukainen`);
  if (fastForward !== true) repo.push(`tuotanto ${prod.sha.slice(0, 7)} ei ole ehdokkaan ${record.deployTarget.slice(0, 7)} esi-isä: push ei olisi fast-forward`);
  if (!checks.cache.ok) repo.push(`ehdokkaan sw.js on ${checks.cache.actual}, odotettiin ${checks.cache.expected}`);
  if (!checks.gates.ok) repo.push(`ehdokkaan porttimatriisi poikkeaa: ${checks.gates.differences.join(', ')}`);
  if (!checks.columnGates.ok) repo.push(`ehdokkaan sarakeportit poikkeavat: ${checks.columnGates.differences.join(', ')}`);
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
    `ref == lukko, fast-forward tuotannosta, ${checks.cache.actual}, portit ja sarakeportit ok`
  ]);

  const acceptanceGate = action.requiresAcceptanceOf
    ? { class: 'OWNER_DEPLOY_APPROVAL_REQUIRED', detail: `aallon ${action.requiresAcceptanceOf} hyväksyntä (UI) ennen seuraavaa askelta`, acceptanceOf: action.requiresAcceptanceOf }
    : null;

  // ------------------------------------------------- MIGRATE-POLKU
  if (action.kind === 'MIGRATE') {
    const inventoryAge = ageHours(state.inventory.capturedAt, state.now);
    const freshReal = !state.inventory.reconstructed && inventoryAge !== null && inventoryAge <= INVENTORY_MAX_AGE_HOURS;
    if (acceptanceGate) pending.push(acceptanceGate);
    if (!freshReal) {
      pending.push({ class: 'OWNER_READ_ONLY_SQL_REQUIRED',
        detail: `tuore inventaario (≤ ${INVENTORY_MAX_AGE_HOURS} h, ei rekonstruoitu) ennen migraatiota ${action.migration}` });
    }
    if (!input.preflightResult) {
      pending.push({ class: 'OWNER_READ_ONLY_SQL_REQUIRED', detail: `${action.preflight}: aja (vain luku) ja liitä tulos --preflight-result=<tiedosto>` });
      step('PREFLIGHT_DB', 'PENDING', `${action.preflight} -tulos puuttuu`);
    } else {
      const parsed = parseCheckTable(input.preflightResult);
      if (!parsed) { step('PREFLIGHT_DB', 'STOP', 'tulosta ei voitu lukea'); return stop('PREFLIGHT_RESULT_UNREADABLE', `${action.preflight}: tulosta ei voitu lukea`, 2); }
      const expectedChecks = countChecksInSql(git.show(lock.sqlSource.sha, action.preflight));
      const verdict = decide(parsed, { expectedChecks });
      if (verdict.decision !== 'GO') { step('PREFLIGHT_DB', 'STOP', verdict.reasons); return stop('PREFLIGHT_DB_FAILED', `${action.preflight}: ${verdict.reasons.join('; ')}`); }
      step('PREFLIGHT_DB', 'OK', `${parsed.rows.length}/${expectedChecks} tarkistusta, 0 FAIL, 0 poikkeavaa`);
    }
    pending.push({ class: 'OWNER_PRODUCTION_MIGRATION_APPROVAL_REQUIRED',
      detail: `omistaja ajaa ${action.migrationFile} SQL-editorissa${action.backupRequired ? ' — TUORE VARMUUSKOPIO ENSIN (PAKOLLINEN)' : ''}` });
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
      pending.push({ class: 'OWNER_READ_ONLY_SQL_REQUIRED', detail: `${action.verify}: aja (vain luku) ja liitä tulos --verify-result=<tiedosto>` });
      step('VERIFY', 'PENDING', `${action.verify} -tulos puuttuu`);
    } else {
      const parsed = parseCheckTable(input.verifyResult);
      if (!parsed) { step('VERIFY', 'STOP', 'tulosta ei voitu lukea'); return stop('VERIFY_RESULT_UNREADABLE', `${action.verify}: tulosta ei voitu lukea`, 2); }
      const expectedChecks = countChecksInSql(git.show(lock.sqlSource.sha, action.verify));
      const verdict = decide(parsed, { expectedChecks });
      if (verdict.decision !== 'GO') { step('VERIFY', 'STOP', verdict.reasons); return stop('VERIFY_FAILED', `${action.verify}: ${verdict.reasons.join('; ')}`); }
      step('VERIFY', 'OK', [`${parsed.rows.length}/${expectedChecks} tarkistusta, 0 poikkeavaa`, `inventaario: migraatio ${action.migration} ajettu`]);
    }
  }

  const acceptedNow = acceptanceGate && input.accepted && input.accepted.includes(acceptanceGate.acceptanceOf);
  if (acceptanceGate && !acceptedNow) pending.push(acceptanceGate);
  const deployGate = { class: 'OWNER_DEPLOY_APPROVAL_REQUIRED', detail: `aallon ${wave} deployhyväksyntä: --execute-deploy --approved-sha=${record.deployTarget}` };

  if (input.approvedSha && input.approvedSha !== record.deployTarget) {
    step('STOP_OWNER_DEPLOY', 'STOP', `hyväksytty SHA ${input.approvedSha} ei ole lukon deployTarget ${record.deployTarget}`);
    return stop('APPROVED_SHA_MISMATCH', `--approved-sha ${input.approvedSha} ei ole aallon ${wave} lukittu deployTarget ${record.deployTarget}: ei pushia`);
  }
  if (!input.executeDeploy || !input.approvedSha || pending.length) {
    if (!input.executeDeploy || !input.approvedSha) pending.push(deployGate);
    step('STOP_OWNER_DEPLOY', 'STOP', pending.map(g => `${g.class}: ${g.detail}`));
    plan.state = 'STOP_OWNER_DEPLOY';
    plan.exitCode = 1;
    return plan;
  }
  step('STOP_OWNER_DEPLOY', 'OK', `omistaja hyväksyi ${record.deployTarget}${acceptedNow ? ` ja aallon ${acceptanceGate.acceptanceOf}` : ''}`);
  plan.readyToDeploy = true;
  plan.state = 'READY_TO_DEPLOY';
  plan.exitCode = 0;
  return plan;
}

// =====================================================================
// SUORITUS (vain --execute-deploy)
// =====================================================================

/** Peruutuspaketti (ACT-10): tulostetaan VERIFY_LIVE-epäonnistumisessa. */
export function rollbackPack(wave, { lock } = {}) {
  const record = lock && lock.waves ? lock.waves.find(w => w.wave === wave) : null;
  const target = rollbackTargetOf(wave);
  const bump = `v${Number(cacheVersionOf(wave).slice(1)) + 1}`;
  return [
    `PERUUTUS aallolle ${wave} -> tila ${target} (omistajan hyväksynnällä):`,
    `  git revert --no-edit ${record && record.waveCommit ? record.waveCommit : `<aallon ${wave} aaltocommit>`}`,
    `  # revert-commitissa: nosta CACHE_VERSION ${cacheVersionOf(wave)} -> ${bump}`,
    '  git push origin HEAD:main            (EI --force)',
    `  npm run production:verify-assets -- --rollback-of=${wave}`,
    `  node scripts/activation-orchestrate.mjs --verify-rollback-of=${wave} --record`,
    `HUOM: ${bump} on aallon ${nextWaveId(wave) || '-'} varattu versio. Peruutuksen jälkeen juna on`,
    '  TRAIN_HALTED_RECUT_REQUIRED: myöhemmät ehdokkaat leikataan uudelleen uusin versioin',
    '  ja lukko kirjoitetaan uudelleen (train-map --write) ennen seuraavaa deployta.'
  ];
}

/** Hyväksyntäpaketti (TECH_ACCEPTANCE). */
export function acceptancePack(wave, record) {
  const meta = waveById(wave);
  const lines = [
    `Hyväksyntäpaketti: ${record.acceptance}`,
    `Koneellinen: npm run production:verify-assets -- --wave=${wave} --sha=${record.deployTarget}`
  ];
  if (meta.migration) lines.push(`Kanta: ${verifyPathOf(meta.migration)} (vain luku) = 0 poikkeavaa`);
  lines.push('Aktivoinnin jälkeinen varmistus: supabase/acceptance/verify_0003_0008_post_activation.sql');
  lines.push(`UI: ${record.acceptance} — omistajan käyttöhyväksyntä (LIVE_USE_VALIDATION_PENDING)`);
  lines.push(`Tuotehaara: päivitä docs/RELEASE-SEQUENCING.md: LINEAGE-CHECK: origin/main sha=${record.deployTarget} cache=${cacheVersionOf(wave)}`
    + ' (jäljessä oleva rivi ei kaada testejä, mutta kertoo väärän nykytilan)');
  if (nextWaveId(wave) === null) lines.push('J:n jälkeen: APK (docs/activation/ANDROID-ACCEPTANCE-BUILD.md) ja Day 1 -hyväksyntä');
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
      if (!problems.length) return { ok: true, timedOut: false, attempts, problems };
    }
    if (now().getTime() - started >= timeoutMs) return { ok: false, timedOut: true, attempts, problems };
    await sleep(intervalMs);
  }
}

/**
 * Koko ajo: tila -> suunnitelma -> (vain --execute-deploy) deploy ->
 * VERIFY_LIVE -> TECH_ACCEPTANCE -> päiväkirja.
 *
 * @returns {Promise<{plan: object, state: object, deploy: object|null,
 *   live: object|null, journal: object|null, exitCode: number}>}
 */
export async function runOrchestrator(deps, options = {}) {
  const {
    live = true, inventoryPath = null, accepted = [], journalPath = JOURNAL_PATH,
    preflightResult = null, verifyResult = null, executeDeploy: execute = false,
    approvedSha = null, wave = null, pollTimeoutMs, pollIntervalMs
  } = options;
  let state;
  try {
    state = await readState(deps, { live, inventoryPath, accepted, journalPath });
  } catch (err) {
    return { plan: { decision: 'STOP', state: 'EXCEPTION', stopClass: 'EXCEPTION', reason: String(err && err.message ? err.message : err), steps: [], pendingGates: [], warnings: [] }, state: null, deploy: null, live: null, journal: null, exitCode: 1 };
  }
  let plan;
  try {
    plan = planNext(state, { wave, preflightResult, verifyResult, executeDeploy: execute, approvedSha, accepted }, deps);
  } catch (err) {
    return { plan: { decision: 'STOP', state: 'EXCEPTION', stopClass: 'EXCEPTION', reason: String(err && err.message ? err.message : err), steps: [], pendingGates: [], warnings: [] }, state, deploy: null, live: null, journal: null, exitCode: 1 };
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
    acceptedWave: plan.nextAction.requiresAcceptanceOf && accepted.includes(plan.nextAction.requiresAcceptanceOf)
      ? plan.nextAction.requiresAcceptanceOf : null,
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
    plan.steps.push({ name: 'VERIFY_LIVE', status: 'OK', detail: [`välimuisti ${cacheVersionOf(plan.candidate.wave)}, portit, sarakeportit ja sormenjälki täsmäävät (${liveResult.attempts} kyselyä)`] });
    plan.steps.push({ name: 'TECH_ACCEPTANCE', status: 'OK', detail: ['AUTOMATED_TECHNICAL_ACCEPTANCE', 'LIVE_USE_VALIDATION_PENDING', ...acceptancePack(plan.candidate.wave, record)] });
    plan.state = 'DEPLOYED_LIVE_USE_VALIDATION_PENDING';
    plan.reason = `aalto ${plan.candidate.wave} tuotannossa; omistajan käyttöhyväksyntä odottaa. Seuraava askel vaatii uuden ajon.`;
    entry = { ...baseEntry, result: 'AUTOMATED_TECHNICAL_ACCEPTANCE', liveUse: 'LIVE_USE_VALIDATION_PENDING' };
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

/**
 * Kirjaa omistajan hyväksyntä tuotannossa olevalle aallolle. Vain
 * eksplisiittisellä lipulla; aallon on oltava tuotannon aalto.
 */
export function recordAcceptance(deps, { wave, journalPath = JOURNAL_PATH }) {
  const prod = productionState(deps.git, deps.now ? deps.now() : new Date());
  if (prod.codeWave !== wave) {
    return { ok: false, reason: `tuotannossa on ${prod.codeWave || prod.deployed?.label || 'tuntematon'}, ei ${wave}: hyväksyntää ei kirjata` };
  }
  const entry = { at: (deps.now ? deps.now() : new Date()).toISOString(), type: 'acceptance', wave, sha: prod.sha };
  return { ok: true, journal: { path: appendJournal(entry, { fs: deps.fs, root: deps.root, journalPath }), entry } };
}

// =====================================================================
// DRY-RUN-RAPORTTI (ACT-13)
// =====================================================================

/** Dry-runin kentät objektina (--json) ja riveinä. */
export function dryRunReport(state, plan) {
  const prod = state.production;
  const c = state.classification;
  const action = plan.nextAction;
  const cand = plan.candidate;
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
    NEXT_ACTION: action ? { kind: action.kind, wave: action.wave, migration: action.migration } : null,
    NEXT_MIGRATION: plan.nextMigration,
    NEXT_DEPLOYMENT: cand ? { wave: cand.wave, sha: cand.sha, afterMigration: action && action.kind === 'MIGRATE' ? action.migration : null } : null,
    RISK: plan.risk,
    REQUIRED_OWNER_GATE: plan.pendingGates,
    EXPECTED_CANDIDATE_SHA: cand ? { sha: cand.sha, ref: cand.ref, refMatchesLock: cand.refMatchesLock, fastForwardFromProduction: cand.fastForward, missingPatches: cand.missingPatches } : null,
    EXPECTED_CACHE: cand ? cand.checks.cache : null,
    EXPECTED_SCHEMA_GATE: cand ? { gates: cand.checks.gates, columnGates: cand.checks.columnGates } : null,
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
  lines.push(`NEXT_ACTION: ${action ? [action.kind, action.wave, action.kind === 'MIGRATE' ? action.migration : null].filter(Boolean).join(' ') : '-'}`);
  lines.push(`NEXT_MIGRATION: ${plan.nextMigration ? `${plan.nextMigration.migration} (aalto ${plan.nextMigration.wave})${plan.nextMigration.deferred ? ` — ODOTTAA: ${plan.nextMigration.waitsFor}` : ' — SEURAAVA'}` : 'ei (kaikki ajettu)'}`);
  lines.push(`NEXT_DEPLOYMENT: ${cand ? `${cand.wave} ${cand.sha}${action.kind === 'MIGRATE' ? ` (migraation ${action.migration} jälkeen)` : ''}` : '-'}`);
  lines.push(`RISK: ${plan.risk ? `${plan.risk.label} (${plan.risk.level})${plan.risk.backupRequired ? ', varmuuskopio PAKOLLINEN' : ''}` : '-'}`);
  lines.push(`REQUIRED_OWNER_GATE: ${plan.pendingGates.length ? plan.pendingGates.map(g => `${g.class} — ${g.detail}`).join(' | ') : '-'}`);
  lines.push(`EXPECTED_CANDIDATE_SHA: ${cand ? `${cand.sha} (lukko; ref ${cand.ref} == lukko: ${yes(cand.refMatchesLock)}; fast-forward tuotannosta: ${yes(cand.fastForward)}${cand.missingPatches.length ? `; PUUTTUVAT KORJAUKSET ${cand.missingPatches.map(s => s.slice(0, 7)).join(', ')}` : ''})` : '-'}`);
  lines.push(`EXPECTED_CACHE: ${cand ? `${cand.checks.cache.expected} (git show ${cand.sha.slice(0, 7)}:sw.js = ${cand.checks.cache.actual || '?'}: ${yes(cand.checks.cache.ok)})` : '-'}`);
  lines.push(`EXPECTED_SCHEMA_GATE: ${cand ? `${cand.checks.gates.open.length} porttia auki (${cand.checks.gates.open.join(', ')}); sarakeportit ${Object.entries(cand.checks.columnGates.expected).map(([g, v]) => `${g}=${v}`).join(' ')} (git show ${cand.sha.slice(0, 7)}:src/data/schema.js: ${yes(cand.checks.gates.ok && cand.checks.columnGates.ok)})` : '-'}`);
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
    lines.push(`GO: seuraava askel ${next} — ${plan.pendingGates.length ? `odottaa omistajan porttia (${plan.state})` : plan.state}`);
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
