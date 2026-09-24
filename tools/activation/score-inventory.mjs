// Pisteytä aktivoinnin inventaario: mikä on seuraava turvallinen portti?
//
//   node tools/activation/score-inventory.mjs tulos.txt
//   node tools/activation/score-inventory.mjs < tulos.txt
//   node tools/activation/score-inventory.mjs --json tulos.txt
//
// Syöte on supabase/acceptance/activation_readonly_inventory.sql:n
// tulos: joko rivin 00 JSON-solu tai koko taulukko liitettynä (sarkain-,
// pilkku- tai putkierotettuna). Mitään ei lähetetä minnekään.
//
// Poistumiskoodi: 0 = seuraava portti on avoin (GO), 1 = pysähdy (STOP),
// 2 = syötettä ei voitu lukea.
//
// TÄMÄ EI TIEDÄ, MIKÄ SOVELLUSAALTO ON TUOTANNOSSA. Kanta kertoo vain
// migraatiot. Deployattu aalto todennetaan erikseen:
//   npm run production:verify-assets -- --wave=<X>

import fs from 'node:fs';
import { EXPECTED } from './build-inventory.mjs';

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
  taskDateType: '60', taskTimeType: '61', tasksWithDuration: '62'
});

/** Aallot, joita kukin migraatio edeltää (docs/SUUNTA-ACTIVATION-GO-NOGO.md). */
export const MIGRATION_WAVE = Object.freeze({
  '0009': 'F', '0010': 'G', '0011': 'H', '0012': 'I', '0013': 'J'
});

/** Lue syöte: JSON-tiiviste tai liitetty taulukko -> { nro: arvo }. */
export function parseInventory(text) {
  let src = String(text || '');
  // CSV-vienti tuplaa solun lainausmerkit: {""inventory"" : ...}.
  if (src.includes('{""inventory""')) src = src.replace(/""/g, '"');
  const start = src.indexOf('{"inventory"');
  if (start !== -1) {
    // Solu voi olla lainausmerkeissä (CSV), jolloin "" -> ".
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
  return Object.keys(rows).length > 10 ? rows : null;
}

const num = value => (value === undefined || value === null || value === 'puuttuu' ? null : Number(value));

function migrationState(number, rows) {
  const count = num(rows[ROW.migrations[number]]);
  if (count === null || Number.isNaN(count)) return { state: 'unknown', count: rows[ROW.migrations[number]] };
  const expected = EXPECTED[number];
  const full = String(expected).split('|').map(Number);
  if (count === 0) return { state: 'not_run', count, expected };
  if (full.includes(count)) return { state: 'run', count, expected };
  // 0013 korvaa 0012:n rajoitteen: 57 + korvaava rajoite = ajettu.
  if (number === '0012' && count === 57 && num(rows[ROW.v2Check]) === 1) return { state: 'run', count, expected };
  return { state: 'partial', count, expected };
}

/** Päätös syötteestä. Palauttaa { decision: 'GO'|'STOP', ... }. */
export function scoreInventory(rows) {
  const stops = [];
  const warnings = [];
  const facts = {};

  const pg = num(rows[ROW.pgNum]);
  facts.postgres = rows[ROW.pgVersion] || String(pg);
  if (!pg || pg < 150000) stops.push(`PostgreSQL ${facts.postgres}: migraatiot vaativat vähintään version 15.`);

  if (num(rows[ROW.m0001]) !== 1) stops.push('Migraatio 0001 ei näytä ajetulta (tasks.user_id puuttuu). Väärä projekti?');

  const states = {};
  for (const n of Object.keys(ROW.migrations)) states[n] = migrationState(n, rows);
  facts.migrations = Object.fromEntries(Object.entries(states).map(([n, s]) => [n, s.state]));

  for (const n of ['0002', '0003', '0004', '0005', '0006', '0007', '0008']) {
    if (states[n].state !== 'run') {
      stops.push(`Migraatio ${n} ei ole täysin ajettu (${states[n].count}/${states[n].expected}). Tuotannon perustila ei vastaa hyväksyttyä.`);
    }
  }

  const partial = Object.entries(states).filter(([, s]) => s.state === 'partial' || s.state === 'unknown');
  for (const [n, s] of partial) {
    stops.push(`Migraatio ${n} on KESKEN: ${s.count} objektia ${s.expected}:sta. Älä aja mitään — ks. palautusohje ennen jatkoa.`);
  }

  const train = ['0009', '0010', '0011', '0012', '0013'];
  const firstNotRun = train.find(n => states[n].state !== 'run');
  const gap = train.slice(train.indexOf(firstNotRun) + 1).find(n => states[n]?.state === 'run');
  if (firstNotRun && gap) stops.push(`Migraatio ${gap} on ajettu mutta ${firstNotRun} ei: järjestys on rikki.`);

  facts.ownerPresent = num(rows[ROW.owner]) === 1;
  facts.authUsers = num(rows[ROW.authUsers]);
  if (!facts.ownerPresent) stops.push('Hyväksyttyä omistajaa (2cc00622-…) ei löydy auth.users-taulusta: jokainen migraatio 0002–0013 keskeytyy. Väärä projekti?');
  if (num(rows[ROW.ownerKeys]) !== 5) stops.push(`Omistajan rivin avaimia ${rows[ROW.ownerKeys]}/5.`);
  if (num(rows[ROW.touchFn]) !== 1) stops.push('touch_updated_at ei ole kovennettu (INVOKER + search_path).');
  const badGoals = num(rows[ROW.badGoalStatus]);
  if (badGoals !== null && badGoals > 0) stops.push(`${badGoals} tavoitetta, joiden tila ei kelpaa 0010:n rajoitteelle.`);
  const idle = num(rows[ROW.idleTx]);
  if (idle > 0) warnings.push(`${idle} avointa "idle in transaction" -istuntoa: migraatio luovuttaisi 5 s lukon jälkeen. Sulje muut SQL-välilehdet ja aja inventaario uudelleen.`);

  for (const [key, label] of [[ROW.noRls, 'taulua ilman RLS:ää'], [ROW.anonGrants, 'anon-oikeutta'], [ROW.publicGrants, 'PUBLIC-oikeutta']]) {
    const v = num(rows[key]);
    if (v !== 0) stops.push(`Turva: ${rows[key]} ${label}. Odotus 0.`);
  }

  facts.taskDateType = rows[ROW.taskDateType];
  facts.taskTimeType = rows[ROW.taskTimeType];
  facts.tasks = num(rows['63']);
  facts.tasksWithDuration = num(rows[ROW.tasksWithDuration]);

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

function report(result) {
  const lines = [];
  lines.push(`PÄÄTÖS: ${result.decision}`);
  lines.push(`PostgreSQL: ${result.facts.postgres}`);
  lines.push('Migraatiot: ' + Object.entries(result.facts.migrations).map(([n, s]) => `${n}=${s}`).join(' '));
  lines.push(`Omistaja auth.users-taulussa: ${result.facts.ownerPresent ? 'kyllä' : 'EI'}; auth-käyttäjiä ${result.facts.authUsers}`);
  lines.push(`tasks.date: ${result.facts.taskDateType}, tasks.time: ${result.facts.taskTimeType}; tehtäviä ${result.facts.tasks}, kesto tiedossa ${result.facts.tasksWithDuration}`);
  for (const s of result.stops) lines.push(`STOP  ${s}`);
  for (const w of result.warnings) lines.push(`HUOM  ${w}`);
  lines.push(`SEURAAVAKSI: ${result.nextAction}`);
  return lines.join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('score-inventory.mjs')) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const file = args.find(a => !a.startsWith('--'));
  const text = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
  const rows = parseInventory(text);
  if (!rows) {
    console.error('Syötettä ei voitu lukea: odotettiin rivin 00 JSON-solua tai koko taulukkoa.');
    process.exit(2);
  }
  const result = scoreInventory(rows);
  console.log(json ? JSON.stringify(result, null, 2) : report(result));
  process.exit(result.decision === 'GO' ? 0 : 1);
}
