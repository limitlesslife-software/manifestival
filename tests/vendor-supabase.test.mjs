// S1: supabase-js omasta originista.
//
// Aiemmin index.html latasi supabase-js:n jsDelivrista (versioalue @2, ei
// tiivistettä). Service worker ei välimuistita vieraita origineja, joten
// offline-kylmäkäynnistys kaatui getClient()-kutsuun ("supabase-js ei ole
// ladattu") ennen kuin ajastin tai lähtökori ehti näkyviin. Nämä testit
// lukitsevat korjauksen: paketti on repossa, lukittuna versioon ja
// tiivisteeseen, sovelluskuoressa ja Android-koonnissa.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { ROOT, read, readCode } from './helpers/sources.mjs';

const html = read('index.html');
const VENDOR = /<script src="\.\/(vendor\/supabase-js-(\d+\.\d+\.\d+)\.min\.js)"><\/script>/.exec(html);

test('S1 KRIITTINEN: index.html ei lataa yhtään skriptiä vieraasta originista', () => {
  const external = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)]
    .map(match => match[1])
    .filter(src => /^(https?:)?\/\//i.test(src));
  assert.deepEqual(external, [], 'käynnistys riippuisi verkosta: ' + external.join(', '));
});

test('S1: supabase-js ladataan omasta originista ennen sovelluksen moduulia', () => {
  assert.ok(VENDOR, 'vendor/supabase-js-<versio>.min.js -skriptitagi puuttuu');
  assert.ok(html.indexOf(VENDOR[0]) < html.indexOf('<script type="module" src="./src/app/main.js">'),
    'globalThis.supabase pitää olla määritelty ennen main.js:ää');
  assert.ok(fs.existsSync(path.join(ROOT, VENDOR[1])), VENDOR[1] + ' puuttuu');
});

test('S1: toimitettu tiedosto on lukittu versioon ja tiivisteeseen (docs/DEPLOYMENT.md)', () => {
  const bytes = fs.readFileSync(path.join(ROOT, VENDOR[1]));
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const deployment = read('docs/DEPLOYMENT.md');
  assert.ok(deployment.includes('`' + sha256 + '`'),
    `tiedoston SHA-256 ${sha256} ei vastaa dokumentoitua — tiedosto muuttui tai dokumentti vanheni`);
  assert.ok(deployment.includes(`**${VENDOR[2]}**`), 'dokumentti ei kerro versiota ' + VENDOR[2]);
  assert.equal(bytes.includes(13), false, 'CRLF-muunnos muutti tiedostoa (vendor/.gitattributes)');
  assert.match(read('vendor/.gitattributes'), /^\* -text$/m);
});

test('S1: tiedosto on UMD-koonti, joka määrittää globalThis.supabase.createClient', () => {
  const source = read(VENDOR[1]);
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: VENDOR[1] });
  assert.equal(typeof sandbox.supabase, 'object');
  assert.equal(typeof sandbox.supabase.createClient, 'function');
});

test('S1: sovelluskuori ja Android-koonti sisältävät paketin', () => {
  const sw = read('sw.js');
  assert.ok(sw.includes(`'/${VENDOR[1]}'`), 'sw.js SHELL ei esilataa supabase-js:ää — offline-kylmäkäynnistys kaatuisi');
  const build = readCode('scripts/build-web.mjs');
  assert.match(build, /const DIRECTORIES = \[[^\]]*'vendor'[^\]]*\]/, 'Android-koonti ei kopioi vendor/-hakemistoa');
  assert.ok(fs.existsSync(path.join(ROOT, 'vendor', 'supabase-js-LICENSE.txt')), 'MIT-lisenssi kulkee paketin mukana');
});

test('S1: client.js lukee edelleen globaalin supabasen (ei ES-importtia CDN:stä)', () => {
  const client = readCode('src/data/client.js');
  assert.match(client, /globalThis\.supabase/);
  assert.equal(/https?:\/\//.test(client.replace(/SUPABASE_URL/g, '')), false);
});
