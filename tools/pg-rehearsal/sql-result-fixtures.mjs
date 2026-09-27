// Oikean kannan tulosfixturet score-sql-result.mjs:lle (ACT-12) — EI TUOTANTOA.
//
//   PG_REHEARSAL_PORT=54369 node tools/pg-rehearsal/sql-result-fixtures.mjs [--out=tests/fixtures/sql-results]
//                                                                           [--numbers=0014]
//
// Jokaiselle 0009–0014 tuotannon muotoisesta kannasta (prodshape.mjs),
// paikallisessa PostgreSQL 17 -harjoitteluklusterissa (lib.connect todentaa
// palvelimen ennen mitään):
//
//   preflight_00NN-pass.tsv  tila NN-1 (juuri ennen migraatiota)  -> 0 FAIL
//   preflight_00NN-fail.tsv  tila NN (migraatio jo ajettu)        -> FAIL
//   verify_00NN-pass.tsv     tila NN                              -> poikkeavia_yhteensa = 0
//   verify_00NN-fail.tsv     tila NN + NULL_SABOTAGE[NN]          -> poikkeavia_yhteensa > 0
//
// Muoto: sarkainerotettu, otsikkorivi (check_no, section, check_name,
// status, details, poikkeavia_yhteensa) — kuten tulostaulukko Supabasen
// editorista kopioituna. NULL = tyhjä solu. Synteettinen harjoitusdata:
// tuotannon muotoinen kanta rakennetaan sovelluksen omilla rivimuunnoksilla
// keksityistä arvoista; tulokset sisältävät vain rakenteen, lukumäärät,
// harjoituskannan nimen, palvelimen version ja hetken — ei käyttäjän
// sisältöä.
//
// manifest.json: alkuperä (git HEAD, SQL-tiedostojen blobit, palvelimen
// versio) ja jokaisen tiedoston pisteytys (decide) tiedoston omilla
// tarkistusnumeroilla. Poistumiskoodi 1, jos yksikin päätös on muu kuin
// odotettu (pass -> GO, fail -> STOP). Pelkkä importti ei aja mitään.
//
// --numbers=0014 ajaa vain annetut migraatiot ja YHDISTÄÄ niiden tulokset
// olemassa olevaan manifest.json-tiedostoon: muiden migraatioiden
// fixtureja ja manifestin rivejä ei kirjoiteta uudelleen (niiden SQL ei
// muuttunut). Manifestin alkuperä (git, palvelin) kirjataan tällöin
// ajokohtaisesti kenttään `runs`.

import fs from 'node:fs';
import path from 'node:path';
import { connect, dropDatabase, readSql, runVerify, provenance, isMain, ROOT, SERVER } from './lib.mjs';
import { cloneProdShape, dropTemplates } from './prodshape.mjs';
import { NULL_SABOTAGE } from './failure-scenarios.mjs';
import { checkNumbersInSql, decide, parseCheckTable } from '../activation/score-sql-result.mjs';

export const NUMBERS = Object.freeze(['0009', '0010', '0011', '0012', '0013', '0014', '0015']);
export const DEFAULT_OUT = 'tests/fixtures/sql-results';
export const COLUMNS = Object.freeze(['check_no', 'section', 'check_name', 'status', 'details', 'poikkeavia_yhteensa']);

/** Puhdas: tulosrivit sarkainerotetuksi tekstiksi (otsikko + rivit, LF). */
export function toTsv(rows) {
  const cell = v => (v === null || v === undefined ? '' : String(v).replace(/[\t\r\n]+/g, ' '));
  return [COLUMNS.join('\t'), ...rows.map(r => COLUMNS.map(c => cell(r[c])).join('\t'))].join('\n') + '\n';
}

/** Fixturen nimi: preflight_0009-pass.tsv jne. */
export const fixtureName = (kind, n, outcome) => `${kind}_${n}-${outcome}.tsv`;

/**
 * Puhdas: yhdistä osittaisen ajon tulokset aiempaan manifestiin. Vain
 * `numbers`-migraatioiden rivit korvataan; muut säilyvät sellaisinaan ja
 * samassa järjestyksessä.
 * Aiempi ylätason alkuperä siirtyy `runs`-listaan, jotta jokaisen rivin
 * lähde on yhä tiedossa.
 */
export function mergeManifest(previous, next, numbers) {
  if (!previous) return next;
  const touched = name => numbers.some(n => name.includes(`_${n}-`));
  const files = {};
  for (const [name, entry] of Object.entries(previous.files || {})) if (!touched(name)) files[name] = entry;
  for (const [name, entry] of Object.entries(next.files)) files[name] = entry;
  const runOf = m => ({ generatedAt: m.generatedAt, server: m.server, git: m.git, numbers: m.numbers ?? null });
  const runs = [...(previous.runs || [runOf(previous)]), runOf({ ...next, numbers })];
  // Aiempien rivien järjestys säilyy (pieni diff); uudet perään ajojärjestyksessä.
  return { ...previous, generatedAt: next.generatedAt, runs, files };
}

async function capture(client, kind, n) {
  const file = `supabase/${kind}/${kind}_${n}.sql`;
  const out = await runVerify(client, file);
  if (!out.ok) throw new Error(`${file}: ${out.error.message}`);
  return { file, rows: out.rows, failed: out.failed.length, poikkeavia: out.poikkeavia, countMismatch: out.countMismatch };
}

export async function main(argv = process.argv.slice(2)) {
  const args = Object.fromEntries(argv.map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }));
  const outDir = path.resolve(ROOT, String(args.out || DEFAULT_OUT));
  const numbers = args.numbers ? String(args.numbers).split(',').map(x => x.trim()).filter(Boolean) : [...NUMBERS];
  for (const n of numbers) if (!NUMBERS.includes(n)) throw new Error(`Tuntematon migraatio ${n} (sallitut: ${NUMBERS.join(', ')})`);
  const partial = numbers.length !== NUMBERS.length;
  const failures = [];
  const entries = {};
  let serverVerified = false;
  try {
    const probe = await connect();
    const version = (await probe.query('select version() as v')).rows[0].v;
    await probe.end();
    serverVerified = true;
    fs.mkdirSync(outDir, { recursive: true });

    const record = (kind, n, outcome, state, captured, extra = {}) => {
      const name = fixtureName(kind, n, outcome);
      const text = toTsv(captured.rows);
      fs.writeFileSync(path.join(outDir, name), text);
      const expectedNumbers = checkNumbersInSql(readSql(captured.file));
      const verdict = decide(parseCheckTable(text), { expectedChecks: expectedNumbers.length, expectedNumbers });
      const expected = outcome === 'pass' ? 'GO' : 'STOP';
      entries[name] = { sql: captured.file, state, outcome, ...extra, rows: captured.rows.length,
                        fail: captured.failed, poikkeavia: captured.poikkeavia, decision: verdict.decision, reasons: verdict.reasons };
      if (captured.countMismatch) failures.push(`${name}: poikkeavia_yhteensa ≠ FAIL-rivit`);
      if (verdict.decision !== expected) failures.push(`${name}: päätös ${verdict.decision}, odotus ${expected}: ${verdict.reasons.join('; ')}`);
      console.log(`${name}: ${captured.rows.length} riviä, FAIL ${captured.failed}, poikkeavia ${captured.poikkeavia} -> ${verdict.decision}`);
    };

    for (const n of numbers) {
      const prev = String(Number(n) - 1).padStart(4, '0');
      {
        const db = `mv_rehearsal_sqlres_${prev}`;
        const client = await cloneProdShape(prev, db);
        try {
          record('preflight', n, 'pass', prev, await capture(client, 'preflight', n));
        } finally { await client.end(); await dropDatabase(db); }
      }
      {
        const db = `mv_rehearsal_sqlres_${n}`;
        const client = await cloneProdShape(n, db);
        try {
          record('preflight', n, 'fail', n, await capture(client, 'preflight', n));
          record('verify', n, 'pass', n, await capture(client, 'verify', n));
          await client.query(NULL_SABOTAGE[n].sql);
          record('verify', n, 'fail', n, await capture(client, 'verify', n), { sabotage: NULL_SABOTAGE[n].sql });
        } finally { await client.end(); await dropDatabase(db); }
      }
    }

    const git = provenance([...new Set(Object.values(entries).map(e => e.sql))]);
    const manifest = {
      generatedBy: 'node tools/pg-rehearsal/sql-result-fixtures.mjs',
      generatedAt: new Date().toISOString(),
      server: { version, versionNum: SERVER.versionNum },
      data: 'synteettinen tuotannon muotoinen harjoituskanta (prodshape.mjs), ei käyttäjän sisältöä',
      git: { head: git.head, branch: git.branch, uncommittedReadFiles: git.uncommittedReadFiles, sqlBlobs: git.blobs },
      files: entries
    };
    const manifestFile = path.join(outDir, 'manifest.json');
    const previous = partial && fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
    const written = partial ? mergeManifest(previous, manifest, numbers) : manifest;
    fs.writeFileSync(manifestFile, JSON.stringify(written, null, 2) + '\n');
  } catch (error) {
    failures.push(`KESKEYTYS: ${error.stack || error.message}`);
  } finally {
    if (serverVerified) {
      try { await dropTemplates(); } catch (error) { failures.push(`mallikantojen poisto: ${error.message}`); }
    }
  }
  console.log(`HYLÄTYT: ${failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  return { failures, entries };
}

if (isMain(import.meta.url)) {
  const { failures } = await main();
  process.exitCode = failures.length ? 1 : 0;
}
