// Pisteytä aktivoinnin inventaario: mikä on seuraava turvallinen portti?
//
//   node tools/activation/score-inventory.mjs tulos.txt
//   node tools/activation/score-inventory.mjs < tulos.txt
//   node tools/activation/score-inventory.mjs --json tulos.txt
//   node tools/activation/score-inventory.mjs --code-wave=C tulos.txt
//   node tools/activation/score-inventory.mjs --code-wave=origin-main tulos.txt
//
// Syöte on supabase/acceptance/activation_readonly_inventory.sql:n
// tulos: joko rivin 00 JSON-solu tai koko taulukko liitettynä (sarkain-,
// pilkku- tai putkierotettuna). Mitään ei lähetetä minnekään.
//
// Poistumiskoodi: 0 = GO, 1 = pysähdy (STOP), 2 = syötettä ei voitu lukea.
// Ilman --code-wave päätös koskee vain KANNAN kuntoa (kuten ennenkin);
// --code-wave:lla päätös koskee koko junaa (classifyActivation).
//
// KOODIAALTO (ACT-05)
//
// Kanta kertoo vain migraatiot. Seuraava turvallinen askel riippuu myös
// siitä, mikä SOVELLUSAALTO on tuotannossa: kanta 0008 + koodi C
// tarkoittaa "deployaa D", ei "aja 0009". Koodiaalto annetaan
// --code-wave=<X>, tai --code-wave=origin-main, jolloin se luetaan
// paikallisesta origin/mainista (tools/release/lineage.mjs, ei verkkoa).

import fs from 'node:fs';
import { EXPECTED } from './build-inventory.mjs';
import {
  DB_FLOOR, MIGRATION_WAVE, TRAIN_FLOOR_WAVE, TRAIN_MIGRATIONS, WAVE_IDS,
  nextWaveId, preflightPathOf, previousWaveId, schemaWaveOfMigration,
  verifyPathOf, waveById, waveIndex
} from '../release/waves.mjs';

export { MIGRATION_WAVE } from '../release/waves.mjs';

/** Rivinumerot, joihin sääntöjä sovelletaan (build-inventory.mjs). */
export const ROW = Object.freeze({
  pgNum: '01', pgVersion: '02',
  m0001: '10',
  migrations: Object.freeze({
    '0002': '11', '0003': '12', '0004': '13', '0005': '14', '0006': '15', '0007': '16',
    '0008': '17', '0009': '18', '0010': '19', '0011': '20', '0012': '21', '0013': '22'
  }),
  v2Check: '30',
  owner: '40', authUsers: '41', ownerKeys: '42', touchFn: '43', badGoalStatus: '44', idleTx: '45',
  noRls: '50', anonGrants: '51', publicGrants: '52',
  taskDateType: '60', taskTimeType: '61', tasksWithDuration: '62',
  tasks: '63',
  tasksWithPositiveDuration: '89'
});

/**
 * Rivit, joita ilman päätöstä EI tehdä (ACT-11). Puuttuva rivi tarkoittaa
 * joko vanhempaa inventaarioversiota tai vajaata liitosta — kummassakin
 * tapauksessa hiljainen oletus olisi arvaus. Aiemmin puuttuva rivi 44 tai
 * 45 meni läpi GO:na, koska "ei lukua" ei ollut "> 0".
 */
export const REQUIRED_ROWS = Object.freeze([
  ROW.pgNum, ROW.m0001, ...Object.values(ROW.migrations),
  ROW.owner, ROW.ownerKeys, ROW.touchFn, ROW.badGoalStatus, ROW.idleTx,
  ROW.noRls, ROW.anonGrants, ROW.publicGrants
]);

/** Taulukkomuodossa vaaditut rivit (ACT-11): muuten syöte ei ole inventaario. */
export const TABLE_REQUIRED_ROWS = Object.freeze([
  '01', '10', ...Object.values(ROW.migrations), '30',
  '40', '41', '42', '43', '44', '45', '50', '51', '52'
]);

const ROW_LABEL = Object.freeze({
  '01': 'PostgreSQL server_version_num', '10': '0001 tasks.user_id',
  '30': '0013 korvaava lähderajoite',
  '40': 'hyväksytty omistaja', '41': 'auth-käyttäjiä', '42': 'omistajan rivin avaimet',
  '43': 'touch_updated_at kovennettu', '44': 'kelpaamattomat tavoitetilat',
  '45': 'idle in transaction -istunnot',
  '50': 'taulut ilman RLS:ää', '51': 'anon-oikeudet', '52': 'PUBLIC-oikeudet',
  ...Object.fromEntries(Object.entries(ROW.migrations).map(([n, r]) => [r, `migraatio ${n}`]))
});

const INVENTORY_START = /\{\s*"inventory"\s*:/;
const INVENTORY_START_CSV = /\{\s*""inventory""\s*:/;

/** Lue syöte: JSON-tiiviste tai liitetty taulukko -> { nro: arvo }. */
export function parseInventory(text) {
  let src = String(text || '');
  // CSV-vienti tuplaa solun lainausmerkit: {""inventory"" : ...}.
  if (INVENTORY_START_CSV.test(src)) src = src.replace(/""/g, '"');
  const found = INVENTORY_START.exec(src);
  if (found) {
    const start = found.index;
    let depth = 0;
    let end = -1;
    for (let i = start; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end !== -1) {
      const raw = src.slice(start, end + 1);
      for (const candidate of [raw, raw.replace(/""/g, '"')]) {
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && parsed.inventory === 'mv-activation-v1' && parsed.rows) return { ...parsed.rows };
        } catch { /* seuraava muoto */ }
      }
    }
  }
  // Taulukko: "nro<erotin>osio<erotin>tarkistus<erotin>arvo" riveittäin.
  const rows = {};
  for (const line of src.split(/\r?\n/)) {
    const cells = line.split(/\t|\s*\|\s*|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(c => c.trim().replace(/^"|"$/g, ''))
      .filter((c, i, all) => !(i === 0 && c === '') && !(i === all.length - 1 && c === ''));
    if (cells.length >= 4 && /^\d{2}$/.test(cells[0]) && cells[0] !== '00') rows[cells[0]] = cells[cells.length - 1];
  }
  // Taulukko kelpaa vain, jos siinä on inventaarion ydinrivit: pelkkä
  // "yli kymmenen kaksinumeroista riviä" hyväksyi minkä tahansa taulukon.
  if (!TABLE_REQUIRED_ROWS.every(key => rows[key] !== undefined && rows[key] !== '')) return null;
  return rows;
}

const missing = value => value === undefined || value === null || value === '';
const num = value => (missing(value) || value === 'puuttuu' ? null : Number(value));

function migrationState(number, rows) {
  const raw = rows[ROW.migrations[number]];
  if (missing(raw)) return { state: 'missing', count: null, expected: EXPECTED[number] };
  const count = num(raw);
  if (count === null || Number.isNaN(count)) return { state: 'unknown', count: raw, expected: EXPECTED[number] };
  const expected = EXPECTED[number];
  const full = String(expected).split('|').map(Number);
  if (count === 0) return { state: 'not_run', count, expected };
  if (full.includes(count)) return { state: 'run', count, expected };
  // 0013 korvaa 0012:n rajoitteen: 57 + korvaava rajoite = ajettu.
  if (number === '0012' && count === 57 && num(rows[ROW.v2Check]) === 1) return { state: 'run', count, expected };
  return { state: 'partial', count, expected };
}

/** Päätös kannan kunnosta. Palauttaa { decision: 'GO'|'STOP', ... }. */
export function scoreInventory(rows) {
  const stops = [];
  const warnings = [];
  const facts = {};

  for (const key of REQUIRED_ROWS) {
    if (missing(rows[key])) {
      stops.push(`rivi ${key} puuttuu (${ROW_LABEL[key] || 'inventaarion rivi'}): `
        + 'inventaario ei ole tätä versiota tai liitos on vajaa. Aja inventaario uudelleen.');
    }
  }

  const pgRaw = rows[ROW.pgNum];
  const pg = num(pgRaw);
  facts.postgres = rows[ROW.pgVersion] || (missing(pgRaw) ? null : String(pgRaw));
  facts.postgresNum = pg;
  if (!missing(pgRaw) && (!pg || Number.isNaN(pg) || pg < 150000)) {
    stops.push(`PostgreSQL server_version_num ${pgRaw}`
      + `${rows[ROW.pgVersion] ? ` (${rows[ROW.pgVersion]})` : ''}: migraatiot vaativat vähintään version 15 (150000).`);
  }

  if (!missing(rows[ROW.m0001]) && num(rows[ROW.m0001]) !== 1) {
    stops.push('Migraatio 0001 ei näytä ajetulta (tasks.user_id puuttuu). Väärä projekti?');
  }

  const states = {};
  for (const n of Object.keys(ROW.migrations)) states[n] = migrationState(n, rows);
  facts.migrations = Object.fromEntries(Object.entries(states).map(([n, s]) => [n, s.state]));

  for (const n of ['0002', '0003', '0004', '0005', '0006', '0007', '0008']) {
    const s = states[n];
    if (s.state === 'missing') continue; // raportoitu yllä: "rivi NN puuttuu"
    if (s.state !== 'run' && s.state !== 'partial' && s.state !== 'unknown') {
      stops.push(`Migraatio ${n} ei ole täysin ajettu (${s.count}/${s.expected}). Tuotannon perustila ei vastaa hyväksyttyä.`);
    }
  }

  for (const [n, s] of Object.entries(states)) {
    if (s.state === 'partial') {
      stops.push(`Migraatio ${n} on KESKEN: ${s.count} objektia ${s.expected}:sta. Älä aja mitään — ks. palautusohje ennen jatkoa.`);
    } else if (s.state === 'unknown') {
      stops.push(`Migraation ${n} rivi ${ROW.migrations[n]} ei ole luku ("${s.count}"): tila tuntematon. Älä aja mitään.`);
    }
  }

  const firstNotRun = TRAIN_MIGRATIONS.find(n => states[n].state !== 'run');
  const gap = firstNotRun
    ? TRAIN_MIGRATIONS.slice(TRAIN_MIGRATIONS.indexOf(firstNotRun) + 1).find(n => states[n]?.state === 'run')
    : undefined;
  if (firstNotRun && gap) stops.push(`Migraatio ${gap} on ajettu mutta ${firstNotRun} ei: järjestys on rikki.`);

  facts.ownerPresent = num(rows[ROW.owner]) === 1;
  facts.authUsers = num(rows[ROW.authUsers]);
  if (!missing(rows[ROW.owner]) && !facts.ownerPresent) {
    stops.push('Hyväksyttyä omistajaa (2cc00622-…) ei löydy auth.users-taulusta: jokainen migraatio 0002–0013 keskeytyy. Väärä projekti?');
  }
  if (!missing(rows[ROW.ownerKeys]) && num(rows[ROW.ownerKeys]) !== 5) {
    stops.push(`Omistajan rivin avaimia ${rows[ROW.ownerKeys]}/5.`);
  }
  if (!missing(rows[ROW.touchFn]) && num(rows[ROW.touchFn]) !== 1) {
    stops.push('touch_updated_at ei ole kovennettu (INVOKER + search_path).');
  }
  const badGoalsRaw = rows[ROW.badGoalStatus];
  const badGoals = num(badGoalsRaw);
  if (!missing(badGoalsRaw)) {
    if (badGoalsRaw === 'puuttuu') stops.push('goals-taulu puuttuu (rivi 44): tuotannon perustila ei vastaa hyväksyttyä.');
    else if (badGoals === null || Number.isNaN(badGoals)) stops.push(`Rivi 44 ei ole luku ("${badGoalsRaw}").`);
    else if (badGoals > 0) stops.push(`${badGoals} tavoitetta, joiden tila ei kelpaa 0010:n rajoitteelle.`);
  }
  const idleRaw = rows[ROW.idleTx];
  const idle = num(idleRaw);
  if (!missing(idleRaw)) {
    if (idle === null || Number.isNaN(idle)) stops.push(`Rivi 45 ei ole luku ("${idleRaw}").`);
    else if (idle > 0) warnings.push(`${idle} avointa "idle in transaction" -istuntoa: migraatio luovuttaisi 5 s lukon jälkeen. Sulje muut SQL-välilehdet ja aja inventaario uudelleen.`);
  }

  for (const [key, label] of [[ROW.noRls, 'taulua ilman RLS:ää'], [ROW.anonGrants, 'anon-oikeutta'], [ROW.publicGrants, 'PUBLIC-oikeutta']]) {
    if (missing(rows[key])) continue;
    const v = num(rows[key]);
    if (v !== 0) stops.push(`Turva: ${rows[key]} ${label}. Odotus 0.`);
  }

  facts.taskDateType = rows[ROW.taskDateType] ?? null;
  facts.taskTimeType = rows[ROW.taskTimeType] ?? null;
  facts.tasks = num(rows[ROW.tasks]);
  facts.tasksWithDuration = num(rows[ROW.tasksWithDuration]);
  // Rivi 62 laskee `duration_minutes is not null`. Jos tuotanto tallentaa
  // arvioimattoman keston nollana, se liioittelee. Rivi 89 laskee > 0.
  facts.tasksWithPositiveDuration = num(rows[ROW.tasksWithPositiveDuration]);

  const next = firstNotRun || null;
  let nextAction;
  if (stops.length) {
    nextAction = 'PYSÄHDY. Älä aja migraatioita eikä deployaa. Liitä tämä raportti Claudelle.';
  } else if (!next) {
    nextAction = 'Kaikki migraatiot 0009–0013 on ajettu. Seuraava: aallon J deploy/hyväksyntä, sitten Day 1 -hyväksyntä puhelimella.';
  } else {
    const wave = MIGRATION_WAVE[next];
    const before = { F: 'aallot D ja E on deployattu ja hyväksytty', G: 'aalto F on deployattu ja hyväksytty',
      H: 'aalto G on deployattu ja hyväksytty', I: 'aalto H on deployattu ja hyväksytty',
      J: 'aalto I on deployattu ja hyväksytty, ja verify_0012 on ajettu' }[wave];
    nextAction = `Seuraava migraatio on ${next} (aalto ${wave}). Aja se VASTA kun ${before}. `
      + `Ensin supabase/preflight/preflight_${next}.sql (vain luku) -> 0 FAIL, sitten Panun hyväksyntä, sitten migraatio, sitten verify_${next}.sql.`;
  }

  return {
    decision: stops.length ? 'STOP' : 'GO',
    nextMigration: next,
    nextWave: next ? MIGRATION_WAVE[next] : null,
    nextAction,
    stops,
    warnings,
    facts
  };
}

// =====================================================================
// KOODIAALTO + KANTA -> SEURAAVA TOIMENPIDE (ACT-05)
// =====================================================================

/**
 * Viimeisin täysin ajettu migraatio väliltä 0008–0013, tai null.
 */
export function lastRunMigration(base) {
  const order = [DB_FLOOR.migration, ...TRAIN_MIGRATIONS];
  let last = null;
  for (const n of order) if (base.facts.migrations[n] === 'run') last = n;
  return last;
}

/** Kannan tukemat koodiaallot: 0008 -> [C, D, E], muuten [W-1, W]. */
export function allowedCodeWavesFor(currentDbWave) {
  if (!currentDbWave) return [];
  if (currentDbWave === DB_FLOOR.wave) {
    return WAVE_IDS.slice(waveIndex(TRAIN_FLOOR_WAVE), waveIndex(DB_FLOOR.wave) + 1);
  }
  return [previousWaveId(currentDbWave), currentDbWave];
}

const OWNER_DEPLOY = 'OWNER_DEPLOY_APPROVAL_REQUIRED';
const OWNER_MIGRATION = 'OWNER_PRODUCTION_MIGRATION_APPROVAL_REQUIRED';

function emptyAction(kind) {
  return {
    kind, wave: null, migration: null, migrationFile: null, preflight: null, verify: null,
    ownerGate: null, backupRequired: false, verifyPrerequisite: null,
    requiresAcceptanceOf: null, expectedSha: null
  };
}

/**
 * Luokittele junan tila: kanta (inventaario) + tuotannon koodiaalto.
 *
 * SÄÄNNÖT (docs/activation, ACT-05):
 *
 *   kanta STOP                           -> STOP
 *   codeWave puuttuu                     -> STOP / VERIFY_CODE_WAVE
 *   codeWave > kannan aalto              -> STOP / ROLLBACK_CODE (koodi edellä kantaa)
 *   codeWave ei sallittu                 -> STOP
 *   codeWave < kannan aalto              -> GO / DEPLOY seuraava aalto
 *   codeWave == kannan aalto < J         -> GO / MIGRATE seuraava migraatio
 *   J + 0013                             -> GO / DONE
 *
 * @param {object} rows parseInventory()-tulos
 * @param {object} [options]
 * @param {string|null} [options.codeWave] tuotannon koodiaalto
 * @param {string[]} [options.acceptedWaves] omistajan hyväksymät aallot
 * @param {object} [options.lock] docs/activation/release-train-c-j.json
 *   (expectedSha luetaan sen deployTarget-kentästä)
 */
export function classifyActivation(rows, { codeWave = null, acceptedWaves = [], lock = null } = {}) {
  const base = scoreInventory(rows);
  const lockSha = wave => {
    const record = lock && Array.isArray(lock.waves) ? lock.waves.find(w => w.wave === wave) : null;
    return record ? record.deployTarget : null;
  };
  const result = (decision, nextAction, reason, extra = {}) => ({
    decision, currentDbWave: extra.currentDbWave ?? null, lastMigration: extra.lastMigration ?? null,
    expectedCodeWave: extra.expectedCodeWave ?? null, allowedCodeWaves: extra.allowedCodeWaves ?? [],
    codeWave, nextAction, reason, base
  });

  if (base.decision === 'STOP') {
    return result('STOP', emptyAction('STOP'), `kanta: ${base.stops[0]}`);
  }

  const lastMigration = lastRunMigration(base);
  const currentDbWave = lastMigration ? schemaWaveOfMigration(lastMigration) : null;
  const known = { currentDbWave, lastMigration, expectedCodeWave: currentDbWave,
    allowedCodeWaves: allowedCodeWavesFor(currentDbWave) };
  if (!currentDbWave) {
    return result('STOP', emptyAction('STOP'), 'kannan aaltoa ei voitu päätellä (0008 ei ajettu?)', known);
  }

  if (!codeWave) {
    return result('STOP', emptyAction('VERIFY_CODE_WAVE'),
      'tuotannon koodiaaltoa ei tiedetä: anna --code-wave=<X> tai --code-wave=origin-main', known);
  }
  if (codeWave !== 'BASE' && !waveById(codeWave)) {
    return result('STOP', emptyAction('VERIFY_CODE_WAVE'), `tuntematon koodiaalto: ${codeWave}`, known);
  }

  if (waveIndex(codeWave) > waveIndex(currentDbWave)) {
    const action = emptyAction('ROLLBACK_CODE');
    action.wave = currentDbWave;
    return result('STOP', action,
      `koodi edellä kantaa: koodi ${codeWave}, kanta tukee aaltoon ${currentDbWave} asti. `
      + `Aallon ${codeWave} kirjoitukset kaatuvat puuttuviin tauluihin — peru koodi aaltoon ${currentDbWave}.`, known);
  }

  if (!known.allowedCodeWaves.includes(codeWave)) {
    return result('STOP', emptyAction('STOP'),
      `koodiaalto ${codeWave} ei ole sallittu kannalle ${lastMigration} `
      + `(sallitut: ${known.allowedCodeWaves.join(', ')})`, known);
  }

  const accepted = acceptedWaves.includes(codeWave);

  if (waveIndex(codeWave) < waveIndex(currentDbWave)) {
    const wave = nextWaveId(codeWave);
    const meta = waveById(wave);
    const action = emptyAction('DEPLOY');
    action.wave = wave;
    action.migration = meta.migration;
    action.migrationFile = meta.migrationFile;
    action.verify = verifyPathOf(meta.migration);
    action.ownerGate = OWNER_DEPLOY;
    action.requiresAcceptanceOf = accepted ? null : codeWave;
    action.expectedSha = lockSha(wave);
    return result('GO', action,
      `kanta ${lastMigration} tukee aaltoa ${currentDbWave}, tuotannossa ${codeWave}: deployaa ${wave}`
      + (accepted ? '' : ` (edellyttää aallon ${codeWave} hyväksyntää)`), known);
  }

  // codeWave === currentDbWave
  const wave = nextWaveId(codeWave);
  if (!wave) {
    const action = emptyAction('DONE');
    action.wave = codeWave;
    return result('GO', action, 'kaikki migraatiot ja aallot tuotannossa: Day 1 -hyväksyntä ja APK sallittu', known);
  }
  const meta = waveById(wave);
  const action = emptyAction('MIGRATE');
  action.wave = wave;
  action.migration = meta.migration;
  action.migrationFile = meta.migrationFile;
  action.preflight = preflightPathOf(meta.migration);
  action.verify = verifyPathOf(meta.migration);
  action.ownerGate = OWNER_MIGRATION;
  action.backupRequired = Boolean(meta.backupRequired);
  action.verifyPrerequisite = meta.verifyPrerequisite ? verifyPathOf(meta.verifyPrerequisite) : null;
  action.requiresAcceptanceOf = accepted ? null : codeWave;
  action.expectedSha = lockSha(wave);
  return result('GO', action,
    `kanta ja koodi ovat aallossa ${codeWave}: seuraava on migraatio ${meta.migration} (aalto ${wave})`
    + (action.backupRequired ? ' — TUORE VARMUUSKOPIO PAKOLLINEN' : '')
    + (action.verifyPrerequisite ? ` — edellyttää ${action.verifyPrerequisite} = 0 poikkeavaa` : ''), known);
}

/** Ihmisluettavat ACT-05-rivit (CLI ja dry-run käyttävät samoja). */
export function classificationLines(c) {
  const a = c.nextAction;
  const target = [a.kind, a.wave, a.kind === 'MIGRATE' ? a.migration : null].filter(Boolean).join(' ');
  return [
    `CURRENT_DB_WAVE: ${c.currentDbWave || '-'}${c.lastMigration ? ` (viimeisin ajettu migraatio ${c.lastMigration})` : ''}`,
    `EXPECTED_CODE_WAVE: ${c.expectedCodeWave || '-'} (sallitut koodiaallot: ${c.allowedCodeWaves.join(', ') || '-'})`,
    `CODE_WAVE: ${c.codeWave || 'tuntematon'}`,
    `NEXT_ACTION: ${target}`
      + (a.preflight ? ` [esitarkistus ${a.preflight}]` : '')
      + (a.backupRequired ? ' [VARMUUSKOPIO PAKOLLINEN]' : '')
      + (a.verifyPrerequisite ? ` [edellyttää ${a.verifyPrerequisite}]` : '')
      + (a.expectedSha ? ` [${a.expectedSha}]` : ''),
    `${c.decision}: ${c.reason}`
  ];
}

function report(result, classification) {
  const lines = [];
  lines.push(`PÄÄTÖS (kanta): ${result.decision}`);
  lines.push(`PostgreSQL: ${result.facts.postgres ?? 'tuntematon'}`);
  lines.push('Migraatiot: ' + Object.entries(result.facts.migrations).map(([n, s]) => `${n}=${s}`).join(' '));
  lines.push(`Omistaja auth.users-taulussa: ${result.facts.ownerPresent ? 'kyllä' : 'EI'}; auth-käyttäjiä ${result.facts.authUsers ?? '?'}`);
  lines.push(`tasks.date: ${result.facts.taskDateType ?? '?'}, tasks.time: ${result.facts.taskTimeType ?? '?'}; `
    + `tehtäviä ${result.facts.tasks ?? '?'}, kesto tiedossa ${result.facts.tasksWithDuration ?? '?'}`
    + `, kesto > 0 ${result.facts.tasksWithPositiveDuration ?? '? (rivi 89 puuttuu)'}`);
  for (const s of result.stops) lines.push(`STOP  ${s}`);
  for (const w of result.warnings) lines.push(`HUOM  ${w}`);
  lines.push(`SEURAAVAKSI (kanta): ${result.nextAction}`);
  lines.push('');
  lines.push(...classificationLines(classification));
  return lines.join('\n');
}

async function resolveCodeWave(value) {
  if (!value) return { codeWave: null, note: null };
  if (value === 'origin-main') {
    const { originMainState } = await import('../release/lineage.mjs');
    const origin = originMainState();
    if (!origin.available) return { codeWave: null, note: 'origin/main ei ole paikallisesti saatavilla' };
    return { codeWave: origin.wave, note: `origin/main ${origin.sha} = ${origin.wave || 'tuntematon'} (${origin.cacheVersion})` };
  }
  return { codeWave: value.toUpperCase(), note: null };
}

if (process.argv[1] && process.argv[1].endsWith('score-inventory.mjs')) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const codeWaveArg = (args.map(a => /^--code-wave=(.+)$/.exec(a)).filter(Boolean).pop() || [])[1] || null;
  const file = args.find(a => !a.startsWith('--'));
  const text = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
  const rows = parseInventory(text);
  if (!rows) {
    console.error('Syötettä ei voitu lukea: odotettiin rivin 00 JSON-solua tai koko taulukkoa.');
    process.exit(2);
  }
  const { codeWave, note } = await resolveCodeWave(codeWaveArg);
  const result = scoreInventory(rows);
  const classification = classifyActivation(rows, { codeWave });
  if (json) {
    console.log(JSON.stringify({ ...result, activation: { ...classification, base: undefined, codeWaveSource: note } }, null, 2));
  } else {
    if (note) console.log(`KOODIAALTO: ${note}`);
    console.log(report(result, classification));
  }
  // Ilman --code-wave päätös koskee kantaa (entinen käytös); koodiaallon
  // kanssa koko junaa.
  const decision = codeWaveArg ? classification.decision : result.decision;
  process.exit(decision === 'GO' ? 0 : 1);
}
