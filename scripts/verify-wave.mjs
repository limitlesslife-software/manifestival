// Porttimatriisin todentaminen: onko repositorio täsmälleen siinä
// aaltotilassa, jonka operaattori sanoo deployaavansa?
//
//   npm run activation:verify-wave -- BASE
//   npm run activation:verify-wave -- A
//   npm run activation:verify-wave              (päättele lähteestä)
//   npm run activation:verify-wave -- --rollback-of=D   (peruutuscommit, ACT-10)
//
// MIKSI TÄMÄ ON ERILLÄÄN ESITARKISTUKSESTA
//
// `activation:preflight` lukee commitin git show'lla, tarkistaa
// migraatio- ja SQL-tiedostot ja salaisuudet, ja halutessa ajaa
// testipatteriston (--run-tests). Tämä kestää millisekunteja, koska se
// lukee vain kolme tiedostoa työpuusta. Deployhetkellä halutaan tietää nopeasti ja
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
  ALL_GATES, WAVE_IDS, cacheVersionOf, cumulativeGates, expectedMatrix, rollbackTargetOf
} from '../tools/release/waves.mjs';
import { currentState, matrixDifferences } from '../tools/release/state.mjs';

const NEWLINE = String.fromCharCode(10);
const out = teksti => process.stdout.write(teksti + NEWLINE);

const argumentti = process.argv.slice(2).find(arg => !arg.startsWith('-'));
const pyydetty = argumentti ? argumentti.trim().toUpperCase() : null;
const peruutus = ((process.argv.slice(2).map(a => /^--rollback-of=(.+)$/.exec(a)).filter(Boolean).pop() || [])[1] || '')
  .trim().toUpperCase() || null;

for (const aaltoId of [pyydetty, peruutus]) {
  if (aaltoId && aaltoId !== 'BASE' && !WAVE_IDS.includes(aaltoId)) {
    out(`  Tuntematon aalto: ${aaltoId}`);
    out(`  Sallitut: BASE, ${WAVE_IDS.join(', ')}`);
    process.exit(1);
  }
}

// PERUUTUS (ACT-10): `npm run activation:verify-wave -- --rollback-of=D`
//
// Peruutuscommit palauttaa edellisen aallon matriisin mutta NOSTAA
// välimuistia (peruutus on deploy). Tavallinen tarkistus kaatuisi aina,
// koska välimuisti ei ole matriisiaallon oma. Tämä tila vaatii: matriisi
// = peruutuskohteen matriisi, välimuisti SUUREMPI kuin perutun aallon.
if (peruutus) {
  const tila = currentState();
  const kohde = rollbackTargetOf(peruutus);
  const erot = tila.gates ? matrixDifferences(tila.gates, kohde) : ['porttilohkoa ei voitu lukea'];
  const numero = v => { const m = /^v(\d+)$/.exec(String(v)); return m ? Number(m[1]) : null; };
  if (numero(tila.cacheVersion) === null || numero(tila.cacheVersion) <= numero(cacheVersionOf(peruutus))) {
    erot.push(`CACHE_VERSION on ${tila.cacheVersion || 'lukematon'}, peruutuksen on oltava suurempi kuin ${cacheVersionOf(peruutus)}`);
  }
  out('');
  out(`  PERUUTUKSEN TODENNUS: aalto ${peruutus} -> ${kohde}`);
  out('');
  if (erot.length === 0) {
    out(`  ROLLBACK(${peruutus}): PASS — matriisi ${kohde}, välimuisti ${tila.cacheVersion}`);
    out('  HUOM: juna on nyt TRAIN_HALTED_RECUT_REQUIRED (ks. docs/RELEASE-SEQUENCING.md, "Peruutus").');
    out('');
    process.exit(0);
  }
  out(`  ROLLBACK(${peruutus}): FAIL (${erot.length})`);
  for (const ero of erot) out(`    ${ero}`);
  out('');
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
