// Tuotannon staattisten resurssien todennus deployn jälkeen.
//
//   npm run production:verify-assets -- --wave=D
//   npm run production:verify-assets -- --wave=D --sha=<40 merkin SHA>
//   npm run production:verify-assets -- --infer
//   npm run production:verify-assets -- --rollback-of=D
//   npm run production:verify-assets -- --wave=A --url=https://oma.esikatselu.example
//   npm run production:verify-assets -- --wave=C --sha=<40 merkin SHA> --record-acceptance
//
// TEKNINEN HYVÄKSYNTÄ (--record-acceptance)
//
// Todentaa tuotannossa olevan aallon KAIKKI koneelliset ehdot
// (tools/activation/acceptance-policy.mjs: sukulinja, migraatioedellytys,
// ehdokkaan testit, tietoturva, esitarkistus, verify_00XX, live-
// sormenjälki, välimuisti ja portit, ehdokkaan käynnistyssavu) ja vain
// niiden täyttyessä kirjaa
// AUTOMATED_TECHNICAL_ACCEPTANCE-rivin PAIKALLISEEN, git-ignoroituun
// päiväkirjaan .claude/activation/journal.jsonl. Käsin tehtävä
// käyttötodennus jää tilaan LIVE_USE_VALIDATION_PENDING. Vaatii --wave ja
// --sha, ei salli --url-, --infer- eikä --rollback-of-lippua.
// Migraatioaallolle myös --verify-result=<verify_00XX-tulos>.
// Logiikka: tools/activation/orchestrate.mjs (recordTechnicalAcceptance).
//
// MITÄ TÄMÄ TEKEE
//
// Hakee tuotannosta ne tiedostot, joista deployn tila voidaan lukea, ja
// vertaa niitä odotettuun aaltoon: välimuistiversio, 24 taulupotin
// matriisi, sarakeportit (COLUMN_GATES), TASK_EXTENDED_FIELDS,
// turvaotsakkeet ja kaksi tunnusmerkkiä. `--sha` lisää sormenjäljen:
// jokainen sw.js:n SHELL-tiedosto tuotannossa vs `git show <sha>:<polku>`.
// `--infer` ei oleta aaltoa: se kertoo tuotannon aallon, välimuistin ja
// sen, mikä junan ehdokas-SHA:ista tuotannossa on.
//
// Logiikka on tools/release/live-assets.mjs:ssä (importoitava ja
// testattu). Tämä tiedosto on vain komentorivi.
//
// AALTO ON ANNETTAVA. Aiempi oletus luki aallon TYÖPUUSTA, joka
// tuotehaaralla on BASE — ja FAILasi siksi tuotantoa C vastaan. Nyt
// vaaditaan --wave, --rollback-of tai --infer.
//
// MITÄ TÄMÄ EI TEE, EIKÄ SAA TEHDÄ
//
//   - ei kirjautumista, ei tunnuksia, ei evästeitä
//   - ei POST/PUT/PATCH/DELETE-pyyntöjä, vain GET
//   - ei /api/-kutsuja (ne maksavat ja koskevat AI-rajapintaan)
//   - ei Supabase-kutsuja
//   - ei kirjoituksia mihinkään — ainoa poikkeus on --record-acceptance,
//     joka lisää yhden rivin paikalliseen päiväkirjaan
//
// MIKSI TÄMÄ EI OLE YKSIKKÖTESTI
//
// Tämä ottaa yhteyttä verkkoon. tests/production-live-assets.test.mjs
// todentaa saman logiikan tyngällä, joka tarjoilee git-historian
// tiedostoja — ei verkkoa.
//
// PALUUARVO
// 0 = tuotanto vastaa odotusta
// 1 = vähintään yksi poikkeama, tai aaltoa ei annettu

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { WAVE_IDS, cacheVersionOf } from '../tools/release/waves.mjs';
import { ROOT } from '../tools/release/state.mjs';
import { createGit, isFullSha } from '../tools/release/git-layer.mjs';
import {
  PRODUCTION_URL, fingerprintOf, fingerprintPaths, identifySha, readLiveState, verifyLive
} from '../tools/release/live-assets.mjs';

const NEWLINE = String.fromCharCode(10);
const out = teksti => process.stdout.write(teksti + NEWLINE);

function argumentti(nimi) {
  const match = process.argv.slice(2)
    .map(arg => new RegExp(`^--${nimi}=(.+)$`).exec(arg))
    .filter(Boolean)
    .pop();
  return match ? match[1].trim() : null;
}

/**
 * Vain GET, ei tunnuksia, ei /api/-polkuja. Kääre pakottaa metodin
 * riippumatta siitä, mitä kutsuja antaa.
 */
async function hae(url, init = {}) {
  if (/\/api\//.test(new URL(url).pathname)) throw new Error(`kielletty polku: ${url}`);
  return fetch(url, { ...init, method: 'GET', credentials: 'omit' });
}

const perusUrl = (argumentti('url') || PRODUCTION_URL).replace(/\/+$/, '');
const aalto = (argumentti('wave') || '').toUpperCase() || null;
const peruutus = (argumentti('rollback-of') || '').toUpperCase() || null;
const sha = argumentti('sha');
const päättele = process.argv.slice(2).includes('--infer');

for (const [nimi, arvo] of [['wave', aalto], ['rollback-of', peruutus]]) {
  if (arvo && arvo !== 'BASE' && !WAVE_IDS.includes(arvo)) {
    out(`  Tuntematon aalto (--${nimi}): ${arvo}`);
    out(`  Sallitut: BASE, ${WAVE_IDS.join(', ')}`);
    process.exit(1);
  }
}
if (sha && !isFullSha(sha)) {
  out(`  --sha vaatii 40-merkkisen SHA:n, annettiin ${sha}`);
  process.exit(1);
}
if (!aalto && !peruutus && !päättele) {
  out('  Anna odotettu tila: --wave=<X>, --rollback-of=<X> tai --infer.');
  out('  (Työpuun aalto EI ole enää oletus: tuotehaaralla se on BASE.)');
  process.exit(1);
}

const git = createGit();
const gitShow = (s, p) => git.showBuffer(s, p);
const preload = (s, p) => git.showMany(s, p);

// ------------------------------------------- tekninen hyväksyntä (kirjaus)

if (process.argv.slice(2).includes('--record-acceptance')) {
  if (!aalto || !sha || peruutus || päättele || argumentti('url')) {
    out('  --record-acceptance vaatii --wave=<X> ja --sha=<40 merkkiä>, eikä salli --url-, --infer- tai --rollback-of-lippua.');
    process.exit(1);
  }
  const { recordTechnicalAcceptance } = await import('../tools/activation/orchestrate.mjs');
  const tiedosto = argumentti('verify-result');
  if (tiedosto && !fs.existsSync(path.resolve(ROOT, tiedosto))) { out(`  --verify-result: tiedostoa ${tiedosto} ei ole`); process.exit(1); }
  const tulos = await recordTechnicalAcceptance(
    { git, fs, root: ROOT, fetchImpl: hae, now: () => new Date() },
    { wave: aalto, sha, inventoryPath: argumentti('inventory'), verifyResult: tiedosto ? fs.readFileSync(path.resolve(ROOT, tiedosto), 'utf8') : null }
  );
  out('');
  out(`  TEKNINEN HYVÄKSYNTÄ (aalto ${aalto}, ${sha})`);
  out('');
  for (const [tunniste, teksti] of Object.entries(tulos.checks)) out(`    OK    ${tunniste}: ${teksti}`);
  for (const ongelma of tulos.problems) out(`    STOP  ${ongelma}`);
  out('');
  out(tulos.ok
    ? `  AUTOMATED_TECHNICAL_ACCEPTANCE kirjattu -> ${tulos.journal.path} (käyttötodennus: LIVE_USE_VALIDATION_PENDING, ei PASS)`
    : '  EI KIRJATTU: vähintään yksi ehto ei täyty.');
  out('');
  process.exit(tulos.ok ? 0 : 1);
}

/** Junan ehdokkaat lukosta + origin/main. */
function ehdokkaat() {
  const lista = new Map();
  const lukko = path.join(ROOT, 'docs/activation/release-train-c-j.json');
  if (fs.existsSync(lukko)) {
    const kartta = JSON.parse(fs.readFileSync(lukko, 'utf8'));
    for (const w of kartta.waves || []) {
      if (isFullSha(w.deployTarget)) lista.set(w.deployTarget, `${w.wave} deployTarget`);
      if (isFullSha(w.waveCommit) && !lista.has(w.waveCommit)) lista.set(w.waveCommit, `${w.wave} aaltocommit`);
    }
  }
  const origin = git.revParse('origin/main');
  if (origin && !lista.has(origin)) lista.set(origin, 'origin/main');
  return lista;
}

out('');
out('  TUOTANNON RESURSSITODENNUS (vain GET)');
out('');
out(`  Kohde:  ${perusUrl}`);

let sormenjäljet = [];
let polut = [];
if (sha) {
  const fp = fingerprintOf(sha, gitShow, preload);
  if (!fp) { out(`  FAIL  commitia ${sha} tai sen sw.js:ää ei löydy paikallisesti`); process.exit(1); }
  polut = Object.keys(fp.files);
} else if (päättele) {
  const kuvaus = ehdokkaat();
  sormenjäljet = [...kuvaus.keys()].map(s => ({ sha: s, label: kuvaus.get(s), ...(fingerprintOf(s, gitShow, preload) || { files: {} }) }));
  polut = fingerprintPaths(sormenjäljet);
}

let tila;
try {
  tila = await readLiveState({ baseUrl: perusUrl, fetchImpl: hae, paths: polut });
} catch (virhe) {
  out(`  FAIL  Sovellusta ei tavoitettu: ${virhe.message}`);
  out('  Jos verkkoa ei ole käytettävissä, tämä ei kerro tuotannosta mitään.');
  process.exit(1);
}

out(`  Tila:   ${tila.state.label}  (matriisi ${tila.wave || '-'}, välimuisti ${tila.cacheVersion || '-'})`);

let ongelmat = [];
if (päättele) {
  const tunnistettu = identifySha(tila, sormenjäljet);
  const nimi = tunnistettu ? sormenjäljet.find(c => c.sha === tunnistettu).label : null;
  out(`  SHA:    ${tunnistettu ? `${tunnistettu} (${nimi})` : 'ei yksiselitteistä ehdokasta (ks. lukko ja origin/main)'}`);
  if (tila.state.state === 'WAVE') {
    ongelmat = verifyLive(tila, { wave: tila.state.wave });
  } else if (tila.state.state === 'ROLLBACK') {
    ongelmat = verifyLive(tila, { rollbackOf: tila.state.rollbackOf });
  } else {
    ongelmat = [`tuotannon tila ei vastaa yhtäkään aaltoa: ${tila.state.label}`];
  }
  if (!tunnistettu) ongelmat.push('tuotannon SHA:ta ei voitu tunnistaa ehdokkaista');
} else {
  const odotus = peruutus ? `aallon ${peruutus} peruutus` : `aalto ${aalto} (${cacheVersionOf(aalto)})`;
  out(`  Odotus: ${odotus}${sha ? `, sormenjälki ${sha}` : ''}`);
  ongelmat = verifyLive(tila, { wave: aalto, rollbackOf: peruutus, sha, gitShow, preload });
}
out('');

const otsikko = päättele ? 'päätelty' : (peruutus ? `ROLLBACK(${peruutus})` : aalto);
if (ongelmat.length === 0) {
  out(`  TUOTANNON RESURSSITODENNUS (${otsikko}): PASS`);
  out('');
  out('  HUOM: tämä todistaa mitä tuotanto TARJOILEE, ei sitä että sovellus');
  out('  toimii selaimessa. Kirjautuminen, istunnon palautuminen ja');
  out('  konsolivirheet on todennettava selaimessa.');
  out('');
  process.exit(0);
}

out(`  TUOTANNON RESURSSITODENNUS (${otsikko}): FAIL (${ongelmat.length})`);
out('');
for (const ongelma of ongelmat) out(`    ${ongelma}`);
out('');
process.exit(1);
