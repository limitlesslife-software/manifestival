// Aktivoinnin esitarkistus: yksi komento ennen tuotantoaktivointia.
//
//   npm run activation:preflight              perustila, kaikki portit kiinni
//   npm run activation:preflight -- --wave=A  aalto A deployvalmiina
//
// AALTOPARAMETRI
//
// Ilman parametria esitarkistus vaatii PERUSTILAN: yksikään kymmenestä
// portista ei ole auki. Se on tarkoituksellinen oletus — se on
// vahtikoira sille, ettei portti pääse auki vahingossa.
//
// Aaltocommitissa portit ovat auki tarkoituksella, ja silloin
// odotettu tila kerrotaan parametrilla. Esitarkistus vaatii TÄSMÄLLEEN
// sen aallon matriisin: yksikin ylimääräinen tai puuttuva portti on
// virhe. Se ei siis hyväksy mitä tahansa lähdekoodin tilaa, vaan
// nimenomaan sitä, jonka operaattori sanoo deployaavansa.
//
// MITÄ TÄMÄ ON
//
// Migraatiot 0001–0008 on ajettu tuotantoon ja RLS-hyväksyntä on läpi.
// Jäljellä on kymmenen porttia, joiden kääntäminen vaihtaa
// muistivaraston oikeaan kantaan. Tämä komento tarkistaa kerralla sen,
// mitä koneellisesti voi tarkistaa ennen kuin porttiin kosketaan.
//
// MITÄ TÄMÄ EI OLE
//
// Tämä EI ota yhteyttä tuotantoon. Se ei aja SQL:ää, ei lue kantaa
// eikä tiedä mitään tuotannon tilasta. Kannan tila todistetaan
// erikseen SQL-editorissa ajettavilla varmistuksilla, ja ne on
// lueteltu ajo-ohjeessa.
//
// Tämä tarkistaa REPOSITORION: että se on siinä tilassa, josta
// aktivointi voidaan aloittaa.
//
// PALUUARVO
// 0 = kaikki tarkistukset läpi
// 1 = vähintään yksi este

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  ALL_GATES, WAVE_IDS, cacheVersionOf, cumulativeGates, describeMatrix
} from '../tools/release/waves.mjs';
import { matrixDifferences, parseCacheVersion, parseStatusDoc } from '../tools/release/state.mjs';
import { isDetachedHead, waveOfCommit } from '../tools/release/lineage.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const NEWLINE = String.fromCharCode(10);

// ---------------------------------------------------------------------
// AALTOPARAMETRI
// ---------------------------------------------------------------------

const aaltoArgumentti = process.argv.slice(2)
  .map(arg => /^--wave=(.+)$/.exec(arg))
  .filter(Boolean)
  .map(match => match[1].trim().toUpperCase())
  .pop();

const ODOTETTU_AALTO = aaltoArgumentti || 'BASE';

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
 * on kelvollinen tila, ei este, ja sen käsittely esteenä oli juuri se
 * virhe joka teki esitarkistuksesta epäluotettavan irrallisella
 * HEADilla -- FAIL, joka näytti samalta kuin oikea porttivika.
 */
function tarkista(osuus, nimi, ehto, selite = '', blocking = true) {
  tulokset.push({ osuus, nimi, ok: Boolean(ehto), selite, blocking });
}

/** Tiedoston sisältö, tai tyhjä jos sitä ei ole. */
function lue(suhteellinen) {
  const täysi = path.join(ROOT, suhteellinen);
  return fs.existsSync(täysi) ? fs.readFileSync(täysi, 'utf8') : '';
}

// =====================================================================
// 1. HAARA JA TYÖPUU
// =====================================================================
//
// Nämä ovat varoituksia eivätkä esteitä: aktivointi voidaan tehdä
// mistä tahansa haarasta, jos niin päätetään. Mutta jos työpuussa on
// committoimattomia muutoksia, deployattu koodi ei ole se jota on
// testattu — ja se on syytä tietää ennen kuin portteja käännetään.

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
  // Git puuttuu tai hakemisto ei ole repositorio. Ei este.
}

tarkista('haara', 'Työpuu on puhdas', työpuuPuhdas,
  työpuuPuhdas ? '' : 'committoimattomia muutoksia — deployattu koodi ei olisi testattu koodi');

// HUOM. Irrallinen HEAD (detached) ON KELVOLLINEN TILA -- esimerkiksi
// julkaisuautomaatio, joka tarkistaa nimenomaisen commitin eikä
// mitään haaraa. `git branch --show-current` palauttaa silloin
// tyhjän merkkijonon, mikä EI ole itsessään virhe. Tämä tarkistus ei
// siis saa PYSÄYTTÄÄ esitarkistusta pelkästä nimen puuttumisesta --
// se olisi juuri se vika, jota tämä korjaa: FAIL joka näyttää
// samalta kuin oikea porttivirhe, riippumatta siitä oliko matriisi
// oikea. Aallon TUNNISTUS vahvistetaan sen sijaan commitin omasta
// sisällöstä alempana (`waveOfCommit`) -- se toimii identtisesti
// haaralla tai irrallisena.
tarkista('haara', 'HEAD-tila on tunnistettu',
  haara.length > 0 || irrallinen === true,
  haara.length > 0 ? haara : (irrallinen === true ? 'irrallinen HEAD' : 'tuntematon'),
  false);

// =====================================================================
// AALLON TUNNISTUS COMMITISTA -- EI HAARAN NIMESTÄ
// =====================================================================
//
// `--wave=`-parametri (tai BASE-oletus) on operaattorin VÄITE siitä,
// mitä aaltoa tämä commit deployaa. Tämä tarkistus varmistaa väitteen
// KESTÄVÄSTÄ, riippumattomasta lähteestä: jos NYKYINEN commit kantaa
// `Release-Wave:`-trailerin (ks. tools/release/manifest.mjs), sen on
// täsmättävä väitettyyn aaltoon. Tämä toimii TÄSMÄLLEEN SAMOIN
// irrallisella HEADilla kuin haaralla, koska se ei koskaan lue haaran
// nimeä -- vain commitin oman sisällön.
//
// Commit, joka EI kanna trailería (esim. kesken oleva kehitystyö), ei
// ole virhe: silloin tämä tarkistus ei ota kantaa, ja aalto todennetaan
// yhä porttimatriisista alla. AMBIGUITEETTI -- ts. commit väittää yhtä
// ja operaattori toista -- on sitä vastoin AINA este, ei arvaus.
const commitinAalto = waveOfCommit('HEAD', ROOT);
tarkista('haara', 'Commitin oma aaltomerkintä (jos on) täsmää pyydettyyn',
  commitinAalto === null || commitinAalto === ODOTETTU_AALTO,
  commitinAalto === null
    ? 'commitissa ei ole Release-Wave-trailería (tavallista kesken olevassa työssä)'
    : `commit on merkitty aalloksi ${commitinAalto}, esitarkistus ajettiin aallolle ${ODOTETTU_AALTO}`);

// =====================================================================
// 2. PORTIT
// =====================================================================
//
// TÄRKEIN OSUUS. Portin saa avata vasta tuotantoaktivoinnissa aalto
// kerrallaan. Jos lähdekoodissa olisi portti auki ilman että operaattori
// tietää siitä, deploy aktivoisi sen vahingossa — ilman aaltoa, ilman
// varmistusta ja ilman mahdollisuutta perua yhtä porttia kerrallaan.
//
// Tarkistus on KAKSISUUNTAINEN. Se ei kysy vain "onko jokin auki
// liikaa", vaan "onko matriisi täsmälleen se, jonka operaattori sanoo
// deployaavansa". Puuttuva portti on yhtä lailla virhe: aalto, joka
// deployataan vajaana, näyttää onnistuneelta mutta jättää puolet
// ominaisuudesta muistivarastoon.

const schemaLähde = lue('src/data/schema.js');
const PORTIT = [...ALL_GATES];

const tablesLohko = schemaLähde.slice(schemaLähde.indexOf('export const TABLES'),
                                     schemaLähde.indexOf('export function hasTable'));

const kaikkiMääritelty = PORTIT.every(p =>
  new RegExp(`\\b${p}:\\s*(true|false)`).test(tablesLohko));

tarkista('portit', 'Kaikki kymmenen porttia ovat määriteltyjä', kaikkiMääritelty, '');

const portit = {};
for (const portti of PORTIT) {
  portit[portti] = new RegExp(`\\b${portti}:\\s*true`).test(tablesLohko);
}

const auki = PORTIT.filter(p => portit[p]);
const erot = kaikkiMääritelty ? matrixDifferences(portit, ODOTETTU_AALTO) : ['porttilohkoa ei voitu lukea'];

tarkista('portit', `Porttimatriisi vastaa aaltoa ${ODOTETTU_AALTO}`,
  erot.length === 0,
  erot.length ? erot.join('; ') : describeMatrix(portit));

// Aallon OMAT portit erikseen. Kumulatiivinen matriisi menisi läpi
// myös silloin, kun tämän aallon portit ovat auki mutta jokin aiempi
// on sulkeutunut ja jokin myöhempi avautunut vahingossa — summa
// täsmäisi mutta joukko ei. Siksi molemmat tarkistetaan.
if (ODOTETTU_AALTO !== 'BASE') {
  const kumulatiivinen = cumulativeGates(ODOTETTU_AALTO);
  tarkista('portit', `Aallon ${ODOTETTU_AALTO} portit ovat auki`,
    kumulatiivinen.every(p => portit[p] === true),
    kumulatiivinen.filter(p => !portit[p]).join(', ') || `${kumulatiivinen.length} porttia auki`);

  tarkista('portit', 'Myöhempien aaltojen portit ovat yhä kiinni',
    PORTIT.filter(p => !kumulatiivinen.includes(p)).every(p => portit[p] === false),
    PORTIT.filter(p => !kumulatiivinen.includes(p) && portit[p]).join(', ')
      || 'ei ennenaikaisia portteja');
} else {
  tarkista('portit', 'Yksikään aktivointiportti ei ole auki lähdekoodissa',
    auki.length === 0,
    auki.length ? `AUKI: ${auki.join(', ')}` : 'kaikki kymmenen kiinni');
}

// -----------------------------------------------------------------
// VÄLIMUISTIVERSIO JA TILANNEDOKUMENTTI
// -----------------------------------------------------------------
//
// Portti ei ole ainoa asia, jonka aaltocommit muuttaa. Ilman
// välimuistiversion nostoa selain ei koskaan huomaa uutta service
// workeria eikä hae `schema.js`:ää uudelleen — deploy menisi läpi,
// mutta osa käyttäjistä jäisi vanhaan porttitilaan ilman että kukaan
// huomaa. Ja tilannedokumentti on se, jonka varassa operaattori tekee
// päätöksiä; väärä tila siinä on vaarallisempi kuin puuttuva.

const swVersio = parseCacheVersion(lue('sw.js'));
tarkista('portit', `CACHE_VERSION vastaa aaltoa ${ODOTETTU_AALTO}`,
  swVersio === cacheVersionOf(ODOTETTU_AALTO),
  swVersio === cacheVersionOf(ODOTETTU_AALTO)
    ? swVersio
    : `sw.js on ${swVersio || 'lukematon'}, odotettiin ${cacheVersionOf(ODOTETTU_AALTO)}`);

const dokumentinPortit = parseStatusDoc(lue('docs/PRODUCTION-STATUS.md'));
const dokumenttiErot = dokumentinPortit
  ? PORTIT.filter(p => dokumentinPortit[p] !== portit[p])
  : ['porttitaulukkoa ei voitu lukea'];
tarkista('portit', 'PRODUCTION-STATUS.md vastaa lähdekoodia',
  dokumenttiErot.length === 0,
  dokumenttiErot.length ? `eroavat: ${dokumenttiErot.join(', ')}` : '');

// TASK_EXTENDED_FIELDS on jo tuotannossa aktivoitu. Sen on pysyttävä
// totena: takaisin epätodeksi vaihtaminen lopettaisi kuvauksen,
// keston ja prioriteetin tallentamisen ilman että kukaan huomaisi.
tarkista('portit', 'TASK_EXTENDED_FIELDS on yhä aktivoitu',
  /export const TASK_EXTENDED_FIELDS = true/.test(schemaLähde),
  'migraatio 0002 on ajettu ja lippu käännetty tuotannossa');

// =====================================================================
// 3. MIGRAATIOT JA VARMISTUKSET
// =====================================================================
//
// Aktivointi nojaa siihen, että kannassa on täsmälleen se rakenne,
// jonka nämä tiedostot kuvaavat. Jos tiedosto puuttuu, aktivoinnin
// jälkeistä tilaa ei voi todentaa.

for (const numero of ['0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008']) {
  const migraatio = fs.existsSync(path.join(ROOT, 'supabase/migrations'))
    ? fs.readdirSync(path.join(ROOT, 'supabase/migrations'))
        .find(n => n.startsWith(numero))
    : null;
  tarkista('migraatiot', `Migraatio ${numero} on repositoriossa`,
    Boolean(migraatio), migraatio || 'PUUTTUU');
}

const VARMISTUKSET = [
  'supabase/acceptance/precheck_0003_0008_auth_final.sql',
  'supabase/acceptance/verify_0003_0008_post_acceptance_final.sql',
  'supabase/verify/verify_0004_0008_final.sql',
  'docs/MIGRATIONS-0004-0008-PRODUCTION-RUNBOOK.md',
  'docs/ACTIVATION-0003-0008-RUNBOOK.md',
  'docs/PRODUCTION-STATUS.md'
];
for (const tiedosto of VARMISTUKSET) {
  tarkista('varmistukset', `${path.basename(tiedosto)} on olemassa`,
    lue(tiedosto).length > 0, tiedosto);
}

// =====================================================================
// 4. SALAISUUDET JA ASIAKASNIPPU
// =====================================================================
//
// Selaimeen menevä koodi on julkista. service_role ohittaa RLS:n
// kokonaan, ja AI-avain on maksullinen ja väärinkäytettävissä.
// Kumpikaan ei saa päätyä lähdepuuhun eikä nippuun.

const selaimenTiedostot = [];
(function kerää(hakemisto) {
  const täysi = path.join(ROOT, hakemisto);
  if (!fs.existsSync(täysi)) return;
  for (const merkintä of fs.readdirSync(täysi, { withFileTypes: true })) {
    const polku = `${hakemisto}/${merkintä.name}`;
    if (merkintä.isDirectory()) kerää(polku);
    else if (merkintä.name.endsWith('.js')) selaimenTiedostot.push(polku);
  }
})('src');

const selaimenKoodi = selaimenTiedostot.map(lue).join(NEWLINE);

tarkista('salaisuudet', 'service_role ei esiinny selaimen koodissa',
  !/service_role/i.test(selaimenKoodi), '');
tarkista('salaisuudet', 'Anthropic-avainta ei ole selaimen koodissa',
  !/sk-ant-[A-Za-z0-9_-]{10,}/.test(selaimenKoodi), '');
tarkista('salaisuudet', 'service_role ei esiinny työkaluissa',
  !/service_role/i.test(lue('tools/rls-acceptance/acceptance.js')
    + lue('tools/rls-acceptance/main.js')), '');

// Koko seurattu puu: avain ei saa olla missään committoituna.
let seuratut = [];
try {
  seuratut = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split(NEWLINE).filter(Boolean);
} catch { /* ei git-repo */ }

const avaimellisia = seuratut.filter(tiedosto => {
  if (!/\.(js|mjs|json|md|sql|html|txt|yml|yaml)$/i.test(tiedosto)) return false;
  return /sk-ant-[A-Za-z0-9_-]{10,}/.test(lue(tiedosto));
});
tarkista('salaisuudet', 'Yhdessäkään seuratussa tiedostossa ei ole AI-avainta',
  avaimellisia.length === 0,
  avaimellisia.length ? avaimellisia.join(', ') : `${seuratut.length} tiedostoa tarkistettu`);

// =====================================================================
// 5. AUTOMAATTITESTIT
// =====================================================================
//
// Nämä ajetaan viimeisenä, koska ne kestävät pisimpään ja koska
// nopeammat tarkistukset kertovat samat asiat aikaisemmin.

/**
 * Aja npm-skripti package.jsonista.
 *
 * MIKSI SUORAAN NODELLA EIKA npm:lla
 *
 * Node 20+ kieltaytyy kaynnistamasta .cmd-shimia ilman shellia
 * (spawnSync npm.cmd EINVAL), ja Windowsilla `npm` ON shimi. Ilman
 * tata esitarkistus raportoi jokaisen npm-skriptin epaonnistuneeksi,
 * vaikka ne menivat lapi suoraan ajettuna -- eli se olisi valehdellut
 * estetta.
 *
 * Komento luetaan package.jsonista, jotta esitarkistus ei erkane
 * oikeista skripteista. `node <tiedosto>` -muotoiset ajetaan suoraan
 * nykyisella tulkilla; muut jaetaan &&-osiin ja ajetaan samoin.
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

const build = ajaSkripti('build:web');
tarkista('testit', 'Web-kaannos onnistuu', build.ok,
  build.ok ? '' : build.tuloste.split(NEWLINE).slice(-2)[0]);

// =====================================================================
// RAPORTTI
// =====================================================================

const leveys = Math.max(...tulokset.map(t => t.nimi.length)) + 2;
let edellinen = '';
for (const { osuus, nimi, ok, selite, blocking } of tulokset) {
  if (osuus !== edellinen) {
    process.stdout.write(`${NEWLINE}  ${osuus.toUpperCase()}${NEWLINE}`);
    edellinen = osuus;
  }
  // WARN: tarkistus epäonnistui mutta on merkitty ei-estäväksi -- tila
  // kerrotaan silti näkyvästi, mutta se ei pysäytä aktivointia.
  const merkki = ok ? 'PASS' : (blocking === false ? 'WARN' : 'FAIL');
  process.stdout.write(`    ${merkki}  ${nimi.padEnd(leveys)}${selite}${NEWLINE}`);
}

const esteet = tulokset.filter(t => !t.ok && t.blocking !== false);
process.stdout.write(NEWLINE);

if (esteet.length === 0) {
  process.stdout.write(
    `  AKTIVOINNIN ESITARKISTUS (${ODOTETTU_AALTO}): PASS`
    + ` (${tulokset.length} tarkistusta)${NEWLINE}${NEWLINE}`
    + `  Repositorio on siina tilassa, josta aalto ${ODOTETTU_AALTO} voidaan deployata.${NEWLINE}`
    + `  Kannan tila todistetaan erikseen: ks. docs/ACTIVATION-0003-0008-RUNBOOK.md${NEWLINE}`);
  process.exit(0);
}

process.stdout.write(
  `  AKTIVOINNIN ESITARKISTUS (${ODOTETTU_AALTO}): FAIL`
  + ` (${esteet.length}/${tulokset.length} estetta)${NEWLINE}${NEWLINE}`);
for (const este of esteet) {
  process.stdout.write(`    ${este.osuus}: ${este.nimi}${este.selite ? ` — ${este.selite}` : ''}${NEWLINE}`);
}
process.stdout.write(`${NEWLINE}  Aktivointia EI aloiteta ennen kuin jokainen este on selvitetty.${NEWLINE}`);
process.exit(1);
