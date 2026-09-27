// Aktivoinnin esitarkistus: yksi komento ennen tuotantoaktivointia.
//
//   npm run activation:preflight                          perustila (HEAD), kaikki portit kiinni
//   npm run activation:preflight -- --wave=A              aalto A deployvalmiina (HEAD)
//   npm run activation:preflight -- --wave=F --sha=<SHA>  lukittu ehdokas ILMAN checkoutia
//   npm run activation:preflight -- --wave=D --run-tests --run-build
//
// AALTOPARAMETRI
//
// Ilman parametria esitarkistus vaatii PERUSTILAN: yksikään portti ei
// ole auki. Se on tarkoituksellinen oletus — se on vahtikoira sille,
// ettei portti pääse auki vahingossa.
//
// Aaltocommitissa portit ovat auki tarkoituksella, ja silloin
// odotettu tila kerrotaan parametrilla. Esitarkistus vaatii TÄSMÄLLEEN
// sen aallon matriisin: yksikin ylimääräinen tai puuttuva portti on
// virhe.
//
// VAIN LUKEVA OLETUKSENA (ACT-08)
//
// Tarkistukset luetaan commitista `git show`:lla
// (tools/release/preflight-checks.mjs), joten lukitun ehdokkaan voi
// tarkistaa kuittaamatta sitä ulos (--sha). Oletusajo EI aja testejä
// eikä käännä: `build:web` poistaa ja luo dist/-hakemiston, ja
// testipatteristo luo tilapäisiä git-työpuita. Ne ajetaan vain
// lipuilla --run-tests ja --run-build.
//
// MITÄ TÄMÄ EI OLE
//
// Tämä EI ota yhteyttä tuotantoon. Se ei aja SQL:ää, ei lue kantaa
// eikä tiedä mitään tuotannon tilasta. Kannan tila todistetaan
// erikseen (inventaario, esitarkistus- ja varmistus-SQL), ja junan
// kokonaistila: npm run activation:dry-run.
//
// PALUUARVO
// 0 = kaikki tarkistukset läpi
// 1 = vähintään yksi este

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { WAVE_IDS, cacheVersionOf, describeMatrix } from '../tools/release/waves.mjs';
import { currentState, matrixDifferences } from '../tools/release/state.mjs';
import { isDetachedHead, waveOfCommit } from '../tools/release/lineage.mjs';
import { createGit } from '../tools/release/git-layer.mjs';
import { preflightVerdict, repoChecks } from '../tools/release/preflight-checks.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const NEWLINE = String.fromCharCode(10);
const ARGS = process.argv.slice(2);

// ---------------------------------------------------------------------
// AALTOPARAMETRI JA KOHDE
// ---------------------------------------------------------------------

const aaltoArgumentti = ARGS
  .map(arg => /^--wave=(.+)$/.exec(arg))
  .filter(Boolean)
  .map(match => match[1].trim().toUpperCase())
  .pop();

const ODOTETTU_AALTO = aaltoArgumentti || 'BASE';
const TARKISTETTAVA = (ARGS.map(arg => /^--sha=(.+)$/.exec(arg)).filter(Boolean).pop() || [])[1] || 'HEAD';
const AJA_TESTIT = ARGS.includes('--run-tests');
const AJA_KÄÄNNÖS = ARGS.includes('--run-build');

if (ODOTETTU_AALTO !== 'BASE' && !WAVE_IDS.includes(ODOTETTU_AALTO)) {
  process.stdout.write(
    `  Tuntematon aalto: ${ODOTETTU_AALTO}${NEWLINE}`
    + `  Sallitut: BASE, ${WAVE_IDS.join(', ')}${NEWLINE}`);
  process.exit(1);
}

const tulokset = [];

/**
 * Kirjaa yhden tarkistuksen tuloksen.
 *
 * `blocking = false` merkitsee tarkistuksen sellaiseksi, joka ei saa
 * pysäyttää aktivointia epäonnistuessaan -- vain kertoa tilan. Ks.
 * "Haara on tiedossa" alla: haaran NIMEN puuttuminen (irrallinen HEAD)
 * on kelvollinen tila, ei este.
 */
function tarkista(osuus, nimi, ehto, selite = '', blocking = true) {
  tulokset.push({ osuus, nimi, ok: Boolean(ehto), selite, blocking });
}

/** Tiedoston sisältö, tai tyhjä jos sitä ei ole. */
function lue(suhteellinen) {
  const täysi = path.join(ROOT, suhteellinen);
  return fs.existsSync(täysi) ? fs.readFileSync(täysi, 'utf8') : '';
}

const git = createGit({ cwd: ROOT });
const sha = git.revParse(TARKISTETTAVA);
if (!sha) {
  process.stdout.write(`  Committia ${TARKISTETTAVA} ei löydy paikallisesti.${NEWLINE}`);
  process.exit(1);
}
const onHead = TARKISTETTAVA === 'HEAD' || sha === git.revParse('HEAD');

// =====================================================================
// 1. HAARA JA TYÖPUU
// =====================================================================

let haara = '';
let työpuuPuhdas = false;
let irrallinen = null;
try {
  haara = execFileSync('git', ['branch', '--show-current'],
    { cwd: ROOT, encoding: 'utf8' }).trim();
  const tila = execFileSync('git', ['status', '--porcelain'],
    { cwd: ROOT, encoding: 'utf8' }).trim();
  työpuuPuhdas = tila.length === 0;
  irrallinen = isDetachedHead(ROOT);
} catch {
  // Git puuttuu tai hakemisto ei ole repositorio.
}

if (onHead) {
  tarkista('haara', 'Työpuu on puhdas', työpuuPuhdas,
    työpuuPuhdas ? '' : 'committoimattomia muutoksia — deployattu koodi ei olisi testattu koodi');
} else {
  tarkista('haara', 'Tarkistetaan lukittu commit ilman checkoutia', true, sha, false);
}

// HUOM. Irrallinen HEAD (detached) ON KELVOLLINEN TILA -- esimerkiksi
// julkaisuautomaatio, joka tarkistaa nimenomaisen commitin eikä
// mitään haaraa. Tämä tarkistus ei siis saa PYSÄYTTÄÄ esitarkistusta
// pelkästä nimen puuttumisesta. Aallon TUNNISTUS vahvistetaan commitin
// omasta sisällöstä alempana (`waveOfCommit`).
tarkista('haara', 'HEAD-tila on tunnistettu',
  haara.length > 0 || irrallinen === true,
  haara.length > 0 ? haara : (irrallinen === true ? 'irrallinen HEAD' : 'tuntematon'),
  false);

// =====================================================================
// AALLON TUNNISTUS COMMITISTA -- EI HAARAN NIMESTÄ
// =====================================================================
//
// `--wave=`-parametri on operaattorin VÄITE. Jos commit kantaa
// `Release-Wave:`-trailerin (A–K, ks. RELEASE_WAVE_TRAILER), sen on
// täsmättävä. Commit ilman traileria ei ole virhe (deploykohteen kärki
// on usein dokumentti- tai työkalucommit aaltocommitin jälkeen).
// AMBIGUITEETTI on sitä vastoin AINA este.
const commitinAalto = onHead ? waveOfCommit('HEAD', ROOT) : waveOfCommit(sha, ROOT);
tarkista('haara', 'Commitin oma aaltomerkintä (jos on) täsmää pyydettyyn',
  commitinAalto === null || commitinAalto === ODOTETTU_AALTO,
  commitinAalto === null
    ? 'commitissa ei ole Release-Wave-trailería (tavallista kesken olevassa työssä)'
    : `commit on merkitty aalloksi ${commitinAalto}, esitarkistus ajettiin aallolle ${ODOTETTU_AALTO}`);

// =====================================================================
// 2. COMMITIN TARKISTUKSET (git show): portit, välimuisti, sarakeportit,
//    tilannedokumentti, migraatio- ja SQL-tiedostot, salaisuudet
// =====================================================================

let sqlRef = null;
try {
  const lukko = JSON.parse(lue('docs/activation/release-train-c-j.json'));
  sqlRef = lukko && lukko.sqlSource ? lukko.sqlSource.sha : null;
} catch { /* ei lukkoa: migraatioaallon SQL-tarkistus epäonnistuu alla */ }

for (const r of repoChecks({ ref: sha, wave: ODOTETTU_AALTO, gitShow: git.show, gitGrep: git.grep, sqlRef, preload: git.showMany })) {
  tarkista(r.section, r.name, r.ok, r.detail, r.blocking);
}

// Työpuu erikseen, kun tarkistetaan HEAD: committoimaton muutos
// schema.js:ssä tai sw.js:ssä ei näy git show'lla.
if (onHead) {
  const tila = currentState();
  const erot = tila.gates ? matrixDifferences(tila.gates, ODOTETTU_AALTO) : ['porttilohkoa ei voitu lukea'];
  tarkista('työpuu', `Työpuun porttimatriisi vastaa aaltoa ${ODOTETTU_AALTO}`, erot.length === 0,
    erot.length ? erot.join('; ') : describeMatrix(tila.gates));
  tarkista('työpuu', `Työpuun CACHE_VERSION vastaa aaltoa ${ODOTETTU_AALTO}`,
    tila.cacheVersion === cacheVersionOf(ODOTETTU_AALTO),
    `${tila.cacheVersion || 'lukematon'} (odotettiin ${cacheVersionOf(ODOTETTU_AALTO)})`);
}

// =====================================================================
// 3. AUTOMAATTITESTIT JA KÄÄNNÖS — vain erillisillä lipuilla
// =====================================================================

/**
 * Aja npm-skripti package.jsonista suoraan nodella (Windowsilla `npm`
 * on .cmd-shimi, jota Node 20+ ei käynnistä ilman shelliä).
 */
function ajaSkripti(nimi) {
  const skriptit = JSON.parse(lue('package.json')).scripts || {};
  const komento = skriptit[nimi];
  if (!komento) return { ok: false, tuloste: `skriptia ${nimi} ei ole package.jsonissa` };

  let tuloste = '';
  for (const osa of komento.split('&&').map(o => o.trim())) {
    const paloja = osa.split(/\s+/);
    if (paloja[0] !== 'node') {
      return { ok: false, tuloste: `skriptia ${nimi} ei voi ajaa turvallisesti: ${osa}` };
    }
    try {
      tuloste += execFileSync(process.execPath, paloja.slice(1),
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (virhe) {
      return { ok: false, tuloste: tuloste + String(virhe.stdout || '') + String(virhe.stderr || '') };
    }
  }
  return { ok: true, tuloste };
}

if (AJA_TESTIT && onHead) {
  const testit = ajaSkripti('test');
  const testiRivi = (testit.tuloste.match(/pass (\d+)/) || [])[1];
  const testiFail = (testit.tuloste.match(/fail (\d+)/) || [])[1];
  tarkista('testit', 'Automaattitestit menevat lapi', testit.ok,
    testiRivi ? `${testiRivi} lapi, ${testiFail} hylattya` : '');

  const check = ajaSkripti('check');
  tarkista('testit', 'Palvelinpaan syntaksitarkistus menee lapi', check.ok,
    check.ok ? '' : check.tuloste.split(NEWLINE)[0]);

  const smoke = ajaSkripti('smoke');
  tarkista('testit', 'Savutesti menee lapi', smoke.ok,
    (smoke.tuloste.match(/SMOKE TEST: \w+ \([^)]*\)/) || [''])[0]);
} else {
  tarkista('testit', 'Automaattitestit', false,
    onHead ? 'ei ajettu (anna --run-tests)' : 'ei ajettu: --sha-tila ei aja testejä (kuittaa ehdokas ulos omaan työpuuhunsa)', false);
}

if (AJA_KÄÄNNÖS && onHead) {
  const build = ajaSkripti('build:web');
  tarkista('testit', 'Web-kaannos onnistuu', build.ok,
    build.ok ? '' : build.tuloste.split(NEWLINE).slice(-2)[0]);
} else {
  tarkista('testit', 'Web-käännös', false, 'ei ajettu (anna --run-build; kirjoittaa dist/-hakemiston)', false);
}

// =====================================================================
// RAPORTTI
// =====================================================================

const leveys = Math.max(...tulokset.map(t => t.nimi.length)) + 2;
let edellinen = '';
process.stdout.write(`${NEWLINE}  Kohde: ${sha}${onHead ? ' (HEAD)' : ''}  aalto ${ODOTETTU_AALTO}${NEWLINE}`);
for (const { osuus, nimi, ok, selite, blocking } of tulokset) {
  if (osuus !== edellinen) {
    process.stdout.write(`${NEWLINE}  ${osuus.toUpperCase()}${NEWLINE}`);
    edellinen = osuus;
  }
  const merkki = ok ? 'PASS' : (blocking === false ? 'WARN' : 'FAIL');
  process.stdout.write(`    ${merkki}  ${nimi.padEnd(leveys)}${selite}${NEWLINE}`);
}

const esteet = tulokset.filter(t => !t.ok && t.blocking !== false);
const testitAjettu = AJA_TESTIT && onHead;
const käännösAjettu = AJA_KÄÄNNÖS && onHead;
const päätös = preflightVerdict({
  wave: ODOTETTU_AALTO, total: tulokset.length, blocking: esteet.length, testsRun: testitAjettu, buildRun: käännösAjettu
});
process.stdout.write(NEWLINE);

if (esteet.length === 0) {
  process.stdout.write(
    `  ${päätös}${NEWLINE}${NEWLINE}`
    + `  Commit ${sha.slice(0, 7)} on siina tilassa, josta aalto ${ODOTETTU_AALTO} voidaan deployata.${NEWLINE}`
    + (testitAjettu && käännösAjettu ? '' : `  HUOM: PASS koskee commitin tiedostoja; testejä/koontia ei ajettu tässä ajossa.${NEWLINE}`)
    + `  Kannan tila todistetaan erikseen: npm run activation:dry-run${NEWLINE}`);
  process.exit(0);
}

process.stdout.write(`  ${päätös}${NEWLINE}${NEWLINE}`);
for (const este of esteet) {
  process.stdout.write(`    ${este.osuus}: ${este.nimi}${este.selite ? ` — ${este.selite}` : ''}${NEWLINE}`);
}
process.stdout.write(`${NEWLINE}  Aktivointia EI aloiteta ennen kuin jokainen este on selvitetty.${NEWLINE}`);
process.exit(1);
