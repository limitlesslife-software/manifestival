// Julkaisumanifestin luonti ja todentaminen.
//
//   npm run release:manifest            todenna levyllä oleva manifesti
//   npm run release:manifest -- --write luo/päivitä manifesti git-historiasta
//
// Manifesti kertoo, mikä commit on minkäkin aallon deploykohde ja mihin
// kukin aalto perutaan. `--write` etsii aaltojen commitit
// `Release-Wave:`-trailerista — se ei koskaan keksi tunnisteita, ja
// löytymätön aalto jää nulliksi.
//
// Todennus avaa jokaisen SHA:n git-historiasta ja lukee sen
// porttimatriisin ja välimuistiversion siitä commitista. Manifesti,
// joka väittää väärää, kaatuu tässä.
//
// PALUUARVO
// 0 = manifesti on kunnossa
// 1 = vähintään yksi ongelma

import process from 'node:process';

import {
  MANIFEST_PATH, buildManifest, discoverWaveCommits, gitAvailable,
  readManifest, validateManifest, writeManifest
} from '../tools/release/manifest.mjs';

const NEWLINE = String.fromCharCode(10);
const out = teksti => process.stdout.write(teksti + NEWLINE);

const kirjoita = process.argv.slice(2).includes('--write');

out('');
out('  JULKAISUMANIFESTI');
out('');

if (kirjoita) {
  if (!gitAvailable()) {
    out('  FAIL  git ei ole käytettävissä — aaltojen committeja ei voi etsiä.');
    process.exit(1);
  }

  const shat = discoverWaveCommits();
  const manifesti = buildManifest(shat);
  writeManifest(manifesti);

  out(`  Kirjoitettu: ${MANIFEST_PATH}`);
  out('');
  for (const aalto of manifesti.waves) {
    out(`    ${aalto.id}  ${(aalto.commitSha || '(ei vielä commitoitu)').padEnd(42)}`
      + `${aalto.cacheVersion}  ${aalto.gatesEnabled.join(', ')}`);
  }
  out('');
}

const manifesti = readManifest();
if (!manifesti) {
  out(`  FAIL  Manifestia ei löytynyt: ${MANIFEST_PATH}`);
  out('        Luo se: npm run release:manifest -- --write');
  process.exit(1);
}

const ongelmat = validateManifest(manifesti);

out(`  Perustila:   ${manifesti.baseSha}  (${manifesti.baseCacheVersion})`);
out(`  Tuotanto:    ${manifesti.productionUrl}`);
out('');
out('    AALTO  COMMIT                                    CACHE  PERUUTUS  PORTIT');
for (const aalto of manifesti.waves) {
  out(`    ${aalto.id.padEnd(7)}${(aalto.commitSha || '-').padEnd(42)}`
    + `${aalto.cacheVersion.padEnd(7)}${aalto.rollbackTarget.padEnd(10)}`
    + `${aalto.gatesEnabled.join(', ')}`);
}
out('');

if (ongelmat.length === 0) {
  const commitoituja = manifesti.waves.filter(w => w.commitSha).length;
  out(`  MANIFESTI: PASS  (${commitoituja}/${manifesti.waves.length} aaltoa commitoitu)`);
  if (commitoituja < manifesti.waves.length) {
    out('');
    out('  Commitoimattomat aallot ovat null. Se on kelvollinen tila —');
    out('  manifesti on todennettavissa myös vajaana.');
  }
  out('');
  process.exit(0);
}

out(`  MANIFESTI: FAIL (${ongelmat.length} ongelmaa)`);
out('');
for (const ongelma of ongelmat) out(`    ${ongelma}`);
out('');
process.exit(1);
