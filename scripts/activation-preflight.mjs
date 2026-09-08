// Aktivoinnin esitarkistus: yksi komento ennen tuotantoaktivointia.
//
//   npm run activation:preflight
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

const ROOT = path.resolve(import.meta.dirname, '..');
const NEWLINE = String.fromCharCode(10);

const tulokset = [];

/** Kirjaa yhden tarkistuksen tuloksen. */
function tarkista(osuus, nimi, ehto, selite = '') {
  tulokset.push({ osuus, nimi, ok: Boolean(ehto), selite });
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
try {
  haara = execFileSync('git', ['branch', '--show-current'],
    { cwd: ROOT, encoding: 'utf8' }).trim();
  const tila = execFileSync('git', ['status', '--porcelain'],
    { cwd: ROOT, encoding: 'utf8' }).trim();
  työpuuPuhdas = tila.length === 0;
} catch {
  // Git puuttuu tai hakemisto ei ole repositorio. Ei este.
}

tarkista('haara', 'Työpuu on puhdas', työpuuPuhdas,
  työpuuPuhdas ? '' : 'committoimattomia muutoksia — deployattu koodi ei olisi testattu koodi');
tarkista('haara', 'Haara on tiedossa', haara.length > 0, haara);

// =====================================================================
// 2. PORTIT
// =====================================================================
//
// TÄRKEIN OSUUS. Portin saa avata vasta tuotantoaktivoinnissa aalto
// kerrallaan. Jos lähdekoodissa on jo auki oleva portti, deploy
// aktivoisi sen vahingossa — ilman aaltoa, ilman varmistusta ja ilman
// mahdollisuutta perua yhtä porttia kerrallaan.

const schemaLähde = lue('src/data/schema.js');
const PORTIT = ['routines', 'routineExceptions', 'goals', 'projects',
                'notificationPreferences', 'wellbeing',
                'bills', 'recurringExpenses', 'savingsGoals', 'aiAudit'];

const tablesLohko = schemaLähde.slice(schemaLähde.indexOf('export const TABLES'),
                                     schemaLähde.indexOf('export function hasTable'));

const auki = PORTIT.filter(portti =>
  new RegExp(`\\b${portti}:\\s*true`).test(tablesLohko));

tarkista('portit', 'Yksikään aktivointiportti ei ole auki lähdekoodissa',
  auki.length === 0,
  auki.length ? `AUKI: ${auki.join(', ')}` : 'kaikki kymmenen kiinni');

tarkista('portit', 'Kaikki kymmenen porttia ovat määriteltyjä',
  PORTIT.every(p => new RegExp(`\\b${p}:\\s*(true|false)`).test(tablesLohko)),
  '');

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
for (const { osuus, nimi, ok, selite } of tulokset) {
  if (osuus !== edellinen) {
    process.stdout.write(`${NEWLINE}  ${osuus.toUpperCase()}${NEWLINE}`);
    edellinen = osuus;
  }
  const merkki = ok ? 'PASS' : 'FAIL';
  process.stdout.write(`    ${merkki}  ${nimi.padEnd(leveys)}${selite}${NEWLINE}`);
}

const esteet = tulokset.filter(t => !t.ok);
process.stdout.write(NEWLINE);

if (esteet.length === 0) {
  process.stdout.write(
    `  AKTIVOINNIN ESITARKISTUS: PASS (${tulokset.length} tarkistusta)${NEWLINE}${NEWLINE}`
    + `  Repositorio on siina tilassa, josta aktivointi voidaan aloittaa.${NEWLINE}`
    + `  Kannan tila todistetaan erikseen: ks. docs/ACTIVATION-0003-0008-RUNBOOK.md${NEWLINE}`);
  process.exit(0);
}

process.stdout.write(
  `  AKTIVOINNIN ESITARKISTUS: FAIL (${esteet.length}/${tulokset.length} estetta)${NEWLINE}${NEWLINE}`);
for (const este of esteet) {
  process.stdout.write(`    ${este.osuus}: ${este.nimi}${este.selite ? ` — ${este.selite}` : ''}${NEWLINE}`);
}
process.stdout.write(`${NEWLINE}  Aktivointia EI aloiteta ennen kuin jokainen este on selvitetty.${NEWLINE}`);
process.exit(1);
