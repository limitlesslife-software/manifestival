// Tuotannon staattisten resurssien todennus deployn jälkeen.
//
//   npm run production:verify-assets              (aalto päätellään lähteestä)
//   npm run production:verify-assets -- --wave=A
//   npm run production:verify-assets -- --url=https://oma.esikatselu.example
//
// MITÄ TÄMÄ TEKEE
//
// Hakee tuotannosta ne tiedostot, joista deployn tila voidaan lukea, ja
// vertaa niitä odotettuun aaltoon. Perusdeployssa juuri tämä paljasti,
// että v12 ja porttimatriisi olivat oikeasti perillä — ei se, että
// push meni läpi.
//
// MITÄ TÄMÄ EI TEE, EIKÄ SAA TEHDÄ
//
//   - ei kirjautumista, ei tunnuksia, ei evästeitä
//   - ei POST/PUT/PATCH/DELETE-pyyntöjä, vain GET
//   - ei /api/-kutsuja (ne maksavat ja koskevat AI-rajapintaan)
//   - ei Supabase-kutsuja
//   - ei kirjoituksia mihinkään
//
// Tämä lukee vain julkisia staattisia tiedostoja, jotka kuka tahansa
// selain hakee sivua avatessaan.
//
// MIKSI TÄMÄ EI OLE YKSIKKÖTESTI
//
// Tämä ottaa yhteyttä verkkoon. Yksikkötesti, joka vaatii verkon, on
// epäluotettava eikä kerro koodista mitään — se kaatuu lentokoneessa.
// Siksi tämä on erillinen komento, jonka operaattori ajaa deployn
// jälkeen. `tests/`-puussa todennetaan vain, että tämä skripti on
// olemassa ja että se on vain lukeva.
//
// PALUUARVO
// 0 = tuotanto vastaa odotettua aaltoa
// 1 = vähintään yksi poikkeama

import process from 'node:process';

import { ALL_GATES, WAVE_IDS, cacheVersionOf, expectedMatrix } from '../tools/release/waves.mjs';
import { currentState, parseCacheVersion, parseGates } from '../tools/release/state.mjs';

const NEWLINE = String.fromCharCode(10);
const out = teksti => process.stdout.write(teksti + NEWLINE);

const OLETUS_URL = 'https://manifestival-ten.vercel.app';

/** Odotetut turvaotsakkeet. Nämä tulevat vercel.jsonista. */
const OTSAKKEET = Object.freeze([
  ['x-frame-options', 'DENY'],
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'strict-origin-when-cross-origin']
]);

function argumentti(nimi) {
  const match = process.argv.slice(2)
    .map(arg => new RegExp(`^--${nimi}=(.+)$`).exec(arg))
    .filter(Boolean)
    .pop();
  return match ? match[1].trim() : null;
}

const perusUrl = (argumentti('url') || OLETUS_URL).replace(/\/+$/, '');
const pyydettyAalto = (argumentti('wave') || '').toUpperCase() || null;

if (pyydettyAalto && pyydettyAalto !== 'BASE' && !WAVE_IDS.includes(pyydettyAalto)) {
  out(`  Tuntematon aalto: ${pyydettyAalto}`);
  out(`  Sallitut: BASE, ${WAVE_IDS.join(', ')}`);
  process.exit(1);
}

// Ilman nimettyä aaltoa käytetään sitä, jota TYÖPUU vastaa. Se on
// oikea oletus deployn jälkeen: juuri se tila on tarkoitus olla
// tuotannossa.
const paikallinen = currentState();
const aalto = pyydettyAalto || paikallinen.wave;

if (!aalto) {
  out('  Paikallinen porttimatriisi ei vastaa yhtäkään aaltoa, eikä aaltoa annettu.');
  out('  Anna aalto: --wave=A');
  process.exit(1);
}

const tulokset = [];
function tarkista(nimi, ehto, selite = '') {
  tulokset.push({ nimi, ok: Boolean(ehto), selite });
}

/** Yksi GET. Palauttaa statuksen, otsakkeet ja tekstin. */
async function hae(polku) {
  const vastaus = await fetch(perusUrl + polku, {
    method: 'GET',
    redirect: 'follow',
    headers: { 'cache-control': 'no-cache' }
  });
  return {
    status: vastaus.status,
    headers: vastaus.headers,
    text: await vastaus.text()
  };
}

out('');
out('  TUOTANNON RESURSSITODENNUS');
out('');
out(`  Kohde:  ${perusUrl}`);
out(`  Aalto:  ${aalto}${pyydettyAalto ? '' : '  (päätelty työpuusta)'}`);
out('');

let juuri;
try {
  juuri = await hae('/');
} catch (virhe) {
  out(`  FAIL  Sovellusta ei tavoitettu: ${virhe.message}`);
  out('');
  out('  Jos verkkoa ei ole käytettävissä, tämä ei kerro tuotannosta mitään.');
  process.exit(1);
}

tarkista('Sovellus vastaa HTTP 200', juuri.status === 200, `status ${juuri.status}`);

for (const [otsake, odotettu] of OTSAKKEET) {
  const arvo = juuri.headers.get(otsake);
  tarkista(`Turvaotsake ${otsake}`, arvo === odotettu,
    arvo === odotettu ? arvo : `on ${arvo || 'puuttuu'}, odotettiin ${odotettu}`);
}

// ---------------------------------------------------------------- sw.js

const sw = await hae('/sw.js');
tarkista('sw.js vastaa HTTP 200', sw.status === 200, `status ${sw.status}`);

const versio = parseCacheVersion(sw.text);
tarkista(`CACHE_VERSION on ${cacheVersionOf(aalto)}`,
  versio === cacheVersionOf(aalto),
  versio ? `tuotannossa ${versio}` : 'versiota ei löytynyt');

// ------------------------------------------------------------ schema.js

const schema = await hae('/src/data/schema.js');
tarkista('schema.js vastaa HTTP 200', schema.status === 200, `status ${schema.status}`);

// allowMissing: tuotannossa oleva commit voi olla VANHEMPI kuin tämä
// työkalu (esim. tuotanto aallossa C, työkalu tuntee aallot C–J). Portti,
// jota tuotannon commit ei tunne, on kiinni — sama tulkinta kuin
// julkaisumanifestissa. Ilman tätä uudempi haara ei voinut todentaa
// vanhempaa tuotantoa lainkaan ("porttilohkoa ei voitu jäsentää").
// Tuntematon YLIMÄÄRÄINEN portti kaatuu yhä (parseGates palauttaa null).
const portit = parseGates(schema.text, { allowMissing: true });
tarkista('schema.js:n porttilohko on luettavissa', Boolean(portit),
  portit ? '' : 'porttilohkoa ei voitu jäsentää');

if (portit) {
  const odotettu = expectedMatrix(aalto);
  for (const portti of ALL_GATES) {
    tarkista(`portti ${portti}`, portit[portti] === odotettu[portti],
      `tuotannossa ${portit[portti] ? 'auki' : 'kiinni'}`
      + `, odotettu ${odotettu[portti] ? 'auki' : 'kiinni'}`);
  }
}

tarkista('TASK_EXTENDED_FIELDS on yhä aktivoitu',
  /export const TASK_EXTENDED_FIELDS = true/.test(schema.text), '');

// ------------------------------------------------- moduulien tunnusmerkit
//
// Kaksi korjausta, jotka menivät tuotantoon perusdeployssa. Jos
// tuotannossa on vanhempi moduuli, kumpikin puuttuu — ja kumpikin
// aiheuttaisi vääriä rivejä kantaan heti kun portit avataan.

const wellbeing = await hae('/src/domain/wellbeing.js');
tarkista('wellbeing.js: tyhjä arvo ei muutu nollaksi',
  wellbeing.status === 200 && /TYHJÄ EI OLE NOLLA/.test(wellbeing.text),
  wellbeing.status === 200 ? '' : `status ${wellbeing.status}`);

const collections = await hae('/src/data/collectionsRepo.js');
tarkista('collectionsRepo.js: aikaleima jätetään pois kun sitä ei ole',
  collections.status === 200 && /occurred_at: entry\.timestamp/.test(collections.text),
  collections.status === 200 ? '' : `status ${collections.status}`);

// ------------------------------------------------------------- raportti

const leveys = Math.max(...tulokset.map(t => t.nimi.length)) + 2;
for (const { nimi, ok, selite } of tulokset) {
  out(`    ${ok ? 'PASS' : 'FAIL'}  ${nimi.padEnd(leveys)}${selite}`);
}
out('');

const esteet = tulokset.filter(t => !t.ok);
if (esteet.length === 0) {
  out(`  TUOTANNON RESURSSITODENNUS (${aalto}): PASS (${tulokset.length} tarkistusta)`);
  out('');
  out('  HUOM: tämä todistaa mitä tuotanto TARJOILEE, ei sitä että sovellus');
  out('  toimii selaimessa. Kirjautuminen, istunnon palautuminen ja');
  out('  konsolivirheet on todennettava selaimessa.');
  out('');
  process.exit(0);
}

out(`  TUOTANNON RESURSSITODENNUS (${aalto}): FAIL (${esteet.length}/${tulokset.length})`);
out('');
for (const este of esteet) out(`    ${este.nimi} — ${este.selite}`);
out('');
process.exit(1);
