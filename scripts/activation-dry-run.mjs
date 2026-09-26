// Junan C–J kuivaharjoitus: mikä on tuotannossa ja mikä on seuraava askel?
//
//   npm run activation:dry-run
//   npm run activation:dry-run -- --offline
//   npm run activation:dry-run -- --inventory=liitetty-inventaario.txt
//   npm run activation:dry-run -- --json
//
// TULOSTAA (ACT-13)
//
//   PRODUCTION_SHA         paikallinen origin/main + FETCH_HEADin ikä
//   CURRENT_WAVE / _CACHE  sen porttimatriisi ja välimuistiversio
//   LIVE                   ristiintarkistus tuotannon staattisista
//                          tiedostoista (vain GET; --offline ohittaa)
//   INVENTORY              oletus: uusin dokumentoitu tuotannon inventaario
//                          (tests/fixtures/activation-inventory/production-*.json
//                          + docs/activation/PRODUCTION-INVENTORY-*.md),
//                          tai --inventory=<tiedosto>. Puuttuu ->
//                          OWNER_READ_ONLY_SQL_REQUIRED ja poistumiskoodi 1.
//   CURRENT_DB_WAVE, NEXT_ACTION, NEXT_MIGRATION, NEXT_DEPLOYMENT, RISK,
//   REQUIRED_OWNER_GATE, EXPECTED_CANDIDATE_SHA (lukon deployTarget,
//   ref == lukko, tuotanto on ehdokkaan esi-isä), EXPECTED_CACHE (git show
//   <sha>:sw.js), EXPECTED_SCHEMA_GATE (git show <sha>:src/data/schema.js),
//   SQL (sha256 ja lukittu lähde)
//
// EI KIRJOITA MITÄÄN eikä muuta gitiä. Verkkoa käytetään vain LIVE-
// tarkistukseen, ja silloinkin vain julkisiin staattisiin tiedostoihin.
// Logiikka: tools/activation/orchestrate.mjs (runDryRun).
//
// POISTUMISKOODI: 0 = suunnitelma laskettu ilman STOPia (omistajan portit
// voivat olla auki), 1 = STOP, 2 = syötettä ei voitu lukea.

import fs from 'node:fs';
import process from 'node:process';

import { ROOT } from '../tools/release/state.mjs';
import { createGit } from '../tools/release/git-layer.mjs';
import { getOnlyFetch } from '../tools/release/live-assets.mjs';
import { runDryRun } from '../tools/activation/orchestrate.mjs';

const args = process.argv.slice(2);
const arg = name => (args.map(a => new RegExp(`^--${name}=(.+)$`).exec(a)).filter(Boolean).pop() || [])[1] || null;
const offline = args.includes('--offline');

const result = await runDryRun(
  { git: createGit(), fs, root: ROOT, fetchImpl: offline ? null : getOnlyFetch, now: () => new Date() },
  { live: !offline, inventoryPath: arg('inventory') }
);

if (args.includes('--json')) {
  process.stdout.write(JSON.stringify(result.report, null, 2) + '\n');
} else {
  process.stdout.write('\n  AKTIVOINNIN KUIVAHARJOITUS (vain luku)\n\n');
  for (const line of result.lines) process.stdout.write(`  ${line}\n`);
  process.stdout.write('\n');
}
process.exit(result.exitCode);
