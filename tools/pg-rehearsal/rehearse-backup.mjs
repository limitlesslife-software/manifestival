// Loogisen tilannekuvan ja palautuksen harjoittelu — EI TUOTANTOA.
//
// Käyttö:
//   node tools/pg-rehearsal/rehearse-backup.mjs [--json=raportti.json]
//        [--fixtures=tests/fixtures/backup] [--variants=text,typed]
//        [--numbers=0009,0010,0011,0012,0013] [--quiet]
//
// Vaatii paikallisen PostgreSQL 15+ -palvelimen osoitteessa 127.0.0.1
// (portti PG_REHEARSAL_PORT) ja pg-ajurin (PG_REHEARSAL_MODULES), ks.
// tools/pg-rehearsal/README.md. Skenaariot B1–B14: backup-scenario.mjs.
//
// Tämä on erillinen ajo, jotta rehearse.mjs:ään ei tarvitse koskea.
// --fixtures kirjoittaa yksikkötestien aineiston (state-0009.json).

import fs, { writeFileSync } from 'node:fs';
import { connect, scalar, PG_HOST, PG_PORT } from './lib.mjs';
import { backupScenario, summarizeBackup, BACKUP_NUMBERS } from './backup-scenario.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const list = (value, fallback) => (value ? String(value).split(',').map(s => s.trim()).filter(Boolean) : fallback);

const report = { startedAt: new Date().toISOString(), server: null, target: `${PG_HOST}:${PG_PORT}`, results: [], failures: [] };

try {
  const admin = await connect();
  try {
    report.server = await scalar(admin, 'select version()');
    report.dataDirectory = await scalar(admin, `select current_setting('data_directory')`);
  } finally { await admin.end(); }
  const fixtureDir = args.fixtures ? String(args.fixtures) : null;
  if (fixtureDir) fs.mkdirSync(fixtureDir, { recursive: true });
  report.results = await backupScenario({
    fixtureDir,
    variants: list(args.variants, ['text', 'typed']),
    numbers: list(args.numbers, BACKUP_NUMBERS),
    log: args.quiet ? () => {} : line => console.log(line)
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
lines.push(`PostgreSQL: ${report.server} (${report.target})`);
lines.push(`backup: ${passed}/${report.results.length} PASS`);
lines.push(`  ${Object.entries(by).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
  .map(([id, v]) => `${id} ${v.pass}/${v.total}`).join(' · ')}`);
lines.push(`HYLÄTYT: ${report.failures.length}`);
for (const f of report.failures) lines.push(`  - ${f}`);
console.log(lines.join('\n'));
if (args.json) writeFileSync(String(args.json), JSON.stringify(report, null, 2));
process.exitCode = report.failures.length ? 1 : 0;
