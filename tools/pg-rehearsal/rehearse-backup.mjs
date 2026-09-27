// Loogisen tilannekuvan ja palautuksen harjoittelu — EI TUOTANTOA.
//
// Käyttö (PG_REHEARSAL_PORT on PAKOLLINEN, ks. alla):
//   PG_REHEARSAL_PORT=54349 node tools/pg-rehearsal/rehearse-backup.mjs [--json=raportti.json]
//        [--fixtures=tests/fixtures/backup] [--variants=text,typed]
//        [--numbers=0009,0010,0011,0012,0013,0014] [--quiet]
//
// Sama ajo rehearse.mjs:n kautta: node tools/pg-rehearsal/rehearse.mjs --only=backup
// (aineisto: --backup-fixtures=tests/fixtures/backup).
//
// VAHTI ENNEN YHTÄKÄÄN KANTAA TAI ROOLIA (lib.guardBackupRehearsal):
//   1. PG_REHEARSAL_PORT on annettu nimenomaisesti eikä se ole 54329
//      (toisen projektin PostgreSQL 15) — tarkistetaan ENNEN yhteyttä
//   2. palvelin on PostgreSQL >= 17 (server_version_num >= 170000)
//   3. data_directory on projektin PÄÄKANSION .claude/pg-local/-hakemistossa
//      (myös worktreestä ajettaessa); ohitusta ei ole
// Muuten ajo keskeytyy, eikä mitään luoda.
//
// Vaatii pg-ajurin (PG_REHEARSAL_MODULES), ks. tools/pg-rehearsal/README.md.
// Skenaariot B1–B15: backup-scenario.mjs. --fixtures kirjoittaa
// yksikkötestien aineiston (state-0009.json). Pelkkä importti ei aja mitään.

import fs from 'node:fs';
import { guardBackupRehearsal, isMain, PG_HOST } from './lib.mjs';
import { backupScenario, summarizeBackup, BACKUP_NUMBERS } from './backup-scenario.mjs';

const list = (value, fallback) => (value ? String(value).split(',').map(s => s.trim()).filter(Boolean) : fallback);

/**
 * Pääohjelma. Sivuvaikutukset injektoitavissa (testit ajavat vahdin
 * ilman kantaa): `guard`, `scenario`, `log`, `writeFile`, `mkdir`.
 */
export async function main(argv = process.argv.slice(2), {
  env = process.env, guard = guardBackupRehearsal, scenario = backupScenario,
  log = line => console.log(line), writeFile = fs.writeFileSync, mkdir = fs.mkdirSync
} = {}) {
  const args = Object.fromEntries(argv.map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }));
  const report = {
    startedAt: new Date().toISOString(), server: null, dataDirectory: null,
    target: `${PG_HOST}:${env.PG_REHEARSAL_PORT ?? '(ei annettu)'}`, results: [], failures: []
  };

  try {
    // Vahti ENNEN yhtäkään kannan tai roolin luontia.
    const server = await guard({ env });
    report.server = server.versionString || server.version;
    report.dataDirectory = server.dataDirectory;
    const fixtureDir = args.fixtures ? String(args.fixtures) : null;
    if (fixtureDir) mkdir(fixtureDir, { recursive: true });
    report.results = await scenario({
      fixtureDir,
      variants: list(args.variants, ['text', 'typed']),
      numbers: list(args.numbers, BACKUP_NUMBERS),
      log: args.quiet ? () => {} : log
    });
  } catch (error) {
    report.failures.push(`KESKEYTYS: ${error.stack || error.message}`);
  }
  report.finishedAt = new Date().toISOString();
  for (const r of report.results.filter(x => !x.pass)) {
    report.failures.push(`[${r.variant} ${r.migration}] ${r.id} ${r.label}: ${r.detail}`);
  }

  const by = summarizeBackup(report.results);
  const passed = report.results.filter(r => r.pass).length;
  const lines = [];
  lines.push(`PostgreSQL: ${report.server || '?'} (${report.target}, data ${report.dataDirectory || '?'})`);
  lines.push(`backup: ${passed}/${report.results.length} PASS`);
  lines.push(`  ${Object.entries(by).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([id, v]) => `${id} ${v.pass}/${v.total}`).join(' · ')}`);
  lines.push(`HYLÄTYT: ${report.failures.length}`);
  for (const f of report.failures) lines.push(`  - ${f}`);
  log(lines.join('\n'));
  if (args.json) writeFile(String(args.json), JSON.stringify(report, null, 2));
  report.exitCode = report.failures.length ? 1 : 0;
  return report;
}

if (isMain(import.meta.url)) {
  const report = await main();
  process.exitCode = report.exitCode;
}
