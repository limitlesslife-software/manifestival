// Pretest-koukku: paikkaa vanhentuneet Android-assetit automaattisesti
// ennen kuin testit ajetaan.
//
// MIKSI TÄMÄ ON OLEMASSA
//
// `tests/android.test.mjs` ("SÄÄNTÖ: Android-assetit tulevat koonnista,
// niitä ei muokata käsin") vaatii, että
// `android/app/src/main/assets/public/index.html` on TÄSMÄLLEEN sama
// kuin repon juuren `index.html` (rivinvaihdot normalisoituna). Se on
// OIKEA vaatimus -- APK ei saa koskaan poiketa siitä mitä web-sovellus
// oikeasti on, eikä sitä pidä lieventää.
//
// `android/app/src/main/assets/public` on kuitenkin GITIGNORATTU
// (`android/.gitignore`: "app/src/main/assets/public") -- Capacitorin
// generoima hakemisto, ei committoitu. Se syntyy vain kun joku on
// ajanut `npm run sync:android` PAIKALLISESSA työpuussa, esim. Android-
// koontia varten.
//
// TÄSTÄ SYNTYY TÄSMÄLLEEN SE TILANNE, JOTA TÄMÄ SKRIPTI KORJAA:
// kehittäjä synkronoi kerran, jatkaa web-lähteen muokkaamista, ja ajaa
// `npm test` synkronoimatta uudelleen. `tests/android.test.mjs` kaataa
// silloin TÄSMÄLLEEN yhden testin -- oikeutetusti, sisältö ON
// eronnut -- mutta testiajon KOKONAISTULOKSESSA (esim. "1688/1689
// PASS") tuo yksi FAIL on erottamattomissa oikeasta regressiosta,
// jos kukaan ei avaa sen viestiä erikseen. Juuri se oli ongelma.
//
// EI KOSKE FRESSIÄ KLOONIA. Jos `assets/public`-hakemistoa ei ole
// (kukaan ei ole koskaan synkronoinut tässä työpuussa), tämä skripti
// ei tee mitään eikä hitaudu mitään: `npm test` pysyy nopeana ja
// verkottomana oletuksena, eikä kenelle tahansa aleta pakkovaatia
// Android-työkaluja.
//
// MITÄ TÄMÄ TEKEE
//
// package.json:n "pretest" ajaa tämän automaattisesti aina kun
// testit käynnistetään `npm test`:llä (npm:n oma pretest/test-elinkaari
// -- ei tarvitse mitään erillistä kytkintä). Jos assetit ovat olemassa
// ja vanhentuneet, tämä ajaa `npm run sync:android`:in valmiiksi ja
// kertoo siitä näkyvästi ENNEN testejä, jolloin `tests/android.test.mjs`
// näkee jo ajantasaisen tilan ja menee läpi. Jos synkronointi ITSE
// epäonnistuu (esim. koonti rikki), koko `npm test` pysähtyy TÄHÄN,
// selvällä ja erillisellä syyllä -- ei piiloon 1600+ muun testin
// joukkoon yhtenä hukkuvana FAILina.
//
// MITÄ TÄMÄ EI TEE
//
// Ei löysennä `tests/android.test.mjs`:n vaatimusta yhtään: testi
// vertailee yhä tavalleen tarkasti. Tämä vain varmistaa, ettei sen
// eteen tarvitse enää ajaa erillistä komentoa käsin ennen `npm test`iä
// niissä työpuissa, joissa Android on joskus synkronoitu.
//
// PALUUARVO
// 0 = ei tehtävää, tai synkronointi onnistui
// 1 = synkronointi epäonnistui -- testejä ei ajeta

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS_INDEX = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'public', 'index.html');
const SOURCE_INDEX = path.join(ROOT, 'index.html');

// Sama rivinvaihtonormalisointi kuin tests/android.test.mjs:ssä --
// haaranvaihto kirjoittaa työpuun tiedostot alustan mukaisin
// rivinvaihdoin, ja se ei saa näyttää vanhentumiselta.
const CR = String.fromCharCode(13);
const withoutCR = text => text.split(CR).join('');

if (!fs.existsSync(ASSETS_INDEX)) {
  // Ei koskaan synkronoitu tässä työpuussa. Ei tehtävää.
  process.exit(0);
}

const shipped = withoutCR(fs.readFileSync(ASSETS_INDEX, 'utf8'));
const source = withoutCR(fs.readFileSync(SOURCE_INDEX, 'utf8'));

if (shipped === source) {
  // Ajan tasalla. Ei tehtävää.
  process.exit(0);
}

console.log('');
console.log('  PRETEST: Android-assetit ovat vanhentuneet (web-lähde on');
console.log('  muuttunut edellisen "npm run sync:android" -ajon jälkeen).');
console.log('  Synkronoidaan automaattisesti ennen testejä...');
console.log('');

try {
  execFileSync('npm', ['run', 'sync:android'], { cwd: ROOT, stdio: 'inherit', shell: true });
} catch {
  console.error('');
  console.error('  PRETEST EPÄONNISTUI: "npm run sync:android" ei mennyt läpi.');
  console.error('  Testejä EI ajettu -- tämä ei ole testiregressio, vaan');
  console.error('  synkronointivaiheen virhe. Katso yllä oleva tuloste.');
  console.error('');
  process.exit(1);
}

console.log('  PRETEST: Android-assetit synkronoitu. Jatketaan testeihin.');
console.log('');
process.exit(0);
