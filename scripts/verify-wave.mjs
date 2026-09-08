// Porttimatriisin todentaminen: onko repositorio täsmälleen siinä
// aaltotilassa, jonka operaattori sanoo deployaavansa?
//
//   npm run activation:verify-wave -- BASE
//   npm run activation:verify-wave -- A
//   npm run activation:verify-wave              (päättele lähteestä)
//
// MIKSI TÄMÄ ON ERILLÄÄN ESITARKISTUKSESTA
//
// `activation:preflight` ajaa koko testipatteriston ja kestää
// kymmeniä sekunteja. Tämä kestää millisekunteja, koska se lukee vain
// kolme tiedostoa. Deployhetkellä halutaan tietää nopeasti ja
// varmasti, mikä matriisi on menossa tuotantoon — ja sitä kysytään
// useammin kuin kerran.
//
// Ilman argumenttia tämä PÄÄTTELEE aallon lähteestä ja tarkistaa vain,
// että kolme lähdettä ovat keskenään yhtäpitäviä. Se on hyödyllinen
// tilannekuva mutta EI korvaa nimettyä aaltoa deployhetkellä:
// päättely hyväksyy minkä tahansa sallitun aallon, kun taas nimetty
// aalto hyväksyy vain sen yhden.
//
// PALUUARVO
// 0 = matriisi on kunnossa
// 1 = matriisi ei vastaa odotusta

import process from 'node:process';

import {
  ALL_GATES, WAVE_IDS, cacheVersionOf, cumulativeGates, expectedMatrix
} from '../tools/release/waves.mjs';
import { currentState, matrixDifferences } from '../tools/release/state.mjs';

const NEWLINE = String.fromCharCode(10);
const out = teksti => process.stdout.write(teksti + NEWLINE);

const argumentti = process.argv.slice(2).find(arg => !arg.startsWith('-'));
const pyydetty = argumentti ? argumentti.trim().toUpperCase() : null;

if (pyydetty && pyydetty !== 'BASE' && !WAVE_IDS.includes(pyydetty)) {
  out(`  Tuntematon aalto: ${pyydetty}`);
  out(`  Sallitut: BASE, ${WAVE_IDS.join(', ')}`);
  process.exit(1);
}

const tila = currentState();

out('');
out('  AALLON TODENNUS');
out('');

if (!tila.gates) {
  out('  FAIL  src/data/schema.js: porttilohkoa ei voitu lukea');
  process.exit(1);
}

const aalto = pyydetty || tila.wave;

if (aalto === null) {
  out('  FAIL  Porttimatriisi ei vastaa yhtäkään sallittua aaltoa.');
  out('');
  for (const portti of ALL_GATES) {
    out(`        ${portti.padEnd(24)}${tila.gates[portti] ? 'auki' : 'kiinni'}`);
  }
  out('');
  out('        Sallitut tilat: BASE, ' + WAVE_IDS.join(', '));
  process.exit(1);
}

const erot = matrixDifferences(tila.gates, aalto);
const odotettu = expectedMatrix(aalto);

out(`  Aalto:            ${aalto}${pyydetty ? '' : '  (päätelty lähteestä)'}`);
out(`  CACHE_VERSION:    ${tila.cacheVersion || 'lukematon'}`
  + `  (aalto edellyttää ${cacheVersionOf(aalto)})`);
out(`  TASK_EXTENDED:    ${tila.taskExtendedFields ? 'true' : 'FALSE — VIRHE'}`);
out('');

for (const portti of ALL_GATES) {
  const on = tila.gates[portti];
  const pitäisi = odotettu[portti];
  const merkki = on === pitäisi ? 'PASS' : 'FAIL';
  out(`    ${merkki}  ${portti.padEnd(24)}${on ? 'auki  ' : 'kiinni'}`
    + `  (odotettu ${pitäisi ? 'auki' : 'kiinni'})`);
}

out('');

const ongelmat = [];
if (erot.length) ongelmat.push(...erot);
if (tila.cacheVersion !== cacheVersionOf(aalto)) {
  ongelmat.push(
    `sw.js CACHE_VERSION on ${tila.cacheVersion || 'lukematon'}, `
    + `aalto ${aalto} edellyttää ${cacheVersionOf(aalto)}`);
}
if (!tila.taskExtendedFields) {
  ongelmat.push('TASK_EXTENDED_FIELDS ei ole enää true — jo aktivoitu portti sulkeutuisi');
}
if (tila.statusGates) {
  for (const portti of ALL_GATES) {
    if (tila.statusGates[portti] !== tila.gates[portti]) {
      ongelmat.push(
        `${portti}: PRODUCTION-STATUS.md ja schema.js eroavat`);
    }
  }
} else {
  ongelmat.push('docs/PRODUCTION-STATUS.md: porttitaulukkoa ei voitu lukea');
}

if (ongelmat.length === 0) {
  const auki = aalto === 'BASE' ? [] : cumulativeGates(aalto);
  out(`  AALTO ${aalto}: PASS`);
  out('');
  out(`  Auki: ${auki.length ? auki.join(', ') : 'ei yhtään porttia'}`);
  out(`  Kolme lähdettä (schema.js, sw.js, PRODUCTION-STATUS.md) ovat yhtäpitäviä.`);
  out('');
  process.exit(0);
}

out(`  AALTO ${aalto}: FAIL (${ongelmat.length} ongelmaa)`);
out('');
for (const ongelma of ongelmat) out(`    ${ongelma}`);
out('');
process.exit(1);
