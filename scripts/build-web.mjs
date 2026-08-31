// Kokoaa selainsovelluksen hakemistoon dist/.
//
// MIKSI TÄMÄ ON OLEMASSA
// Web-tuotanto ei tarvitse tätä lainkaan: Vercel tarjoilee tiedostot suoraan
// repon juuresta eikä käännösvaihetta ole. Tämä skripti on Androidia varten.
//
// Capacitor kopioi `webDir`-hakemiston sisällön APK:n assetteihin. Jos webDir
// olisi repon juuri, mukaan menisivät node_modules, tests, docs, supabase ja
// android itse — satoja megatavuja tavaraa, jota sovellus ei käytä ja josta
// osa ei kuulu jaettavaksi.
//
// Tämä skripti kopioi TÄSMÄLLEEN ne tiedostot, jotka selain oikeasti lataa.
// Se ei muunna eikä minifioi mitään: dist/ on bittiverrannollinen kopio.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/** Yksittäiset tiedostot repon juuresta. */
const FILES = [
  'index.html',
  'manifest.json',
  'sw.js',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png'
];

/** Kokonaiset hakemistot. */
const DIRECTORIES = ['src'];

/** Tiedostot, jotka EIVÄT kuulu julkaistavaan pakettiin. */
function isExcluded(relativePath) {
  const name = path.basename(relativePath);
  // package.json src/-hakemistossa on Nodea varten (type: module).
  // Selain ei sitä tarvitse eikä se kuulu APK:hon.
  if (relativePath === path.join('src', 'package.json')) return true;
  return name.startsWith('.');
}

function copyFile(relativePath) {
  const source = path.join(ROOT, relativePath);
  if (!fs.existsSync(source)) {
    throw new Error('Koontiin tarvittava tiedosto puuttuu: ' + relativePath);
  }
  const target = path.join(DIST, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return 1;
}

function copyDirectory(relativeDir) {
  let count = 0;
  const walk = current => {
    const absolute = path.join(ROOT, current);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const relative = path.join(current, entry.name);
      if (isExcluded(relative)) continue;
      if (entry.isDirectory()) walk(relative);
      else count += copyFile(relative);
    }
  };
  walk(relativeDir);
  return count;
}

// Puhdas koonti joka kerta: vanha tiedosto ei saa jäädä kummittelemaan.
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

let copied = 0;
for (const file of FILES) copied += copyFile(file);
for (const dir of DIRECTORIES) copied += copyDirectory(dir);

// Varmistus: entrypoint ja tyylit ovat mukana, muuten APK avautuisi tyhjänä.
for (const required of ['index.html', path.join('src', 'app', 'main.js'), path.join('src', 'styles.css')]) {
  if (!fs.existsSync(path.join(DIST, required))) {
    throw new Error('Koonti epäonnistui: ' + required + ' puuttuu');
  }
}

console.log(`Koonti valmis: dist/ (${copied} tiedostoa)`);
