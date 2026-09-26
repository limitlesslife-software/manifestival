// Navigointilinkki (src/domain/navigationLink.js).
//
// PERIAATE: linkki kootaan aina kiinteästä alusta ja koodatusta, siivotusta
// tekstistä. Sallittuja muotoja on täsmälleen kaksi; kaikki muu -- myös
// tekoälyn ehdottama "valmis" linkki -- hylätään.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readCode } from './helpers/sources.mjs';
import {
  buildNavigationTarget, googleMapsUrl, androidNavigationIntent, navigationLinks, isAllowedNavigationUrl,
  sanitizeNavigationText, MAX_NAVIGATION_TEXT
} from '../src/domain/navigationLink.js';

const WEB = 'https://www.google.com/maps/dir/?api=1&destination=';

// ------------------------------------------------------------ kohde

test('kohde: osoite ensin, muuten paikan nimi; kulkutapa tunnetuista', () => {
  assert.deepEqual({ ...buildNavigationTarget({ address: 'Fleminginkatu 1, Helsinki', placeName: 'Parturi Kallio', mode: 'walking' }) },
    { query: 'Fleminginkatu 1, Helsinki', label: 'Parturi Kallio', mode: 'walking' });
  assert.deepEqual({ ...buildNavigationTarget({ placeName: 'Parturi Kallio' }) },
    { query: 'Parturi Kallio', label: 'Parturi Kallio', mode: 'driving' });
  assert.equal(buildNavigationTarget({ address: 'X', mode: 'teleport' }).mode, 'driving');
  assert.equal(Object.isFrozen(buildNavigationTarget({ address: 'X' })), true);
  for (const bad of [null, undefined, 'x', 5, [], {}, { address: '   ' }, { address: 5, placeName: {} },
    { address: 'javascript:' }, { address: 'https://evil.example/x' }, { address: '\u{202E}\u{200B}' }]) {
    assert.equal(buildNavigationTarget(bad), null, JSON.stringify(bad));
  }
  // Skeema poistetaan; jäljelle jää vaaratonta tekstiä, joka koodataan linkkiin.
  assert.equal(buildNavigationTarget({ address: 'javascript:alert(1)' }).query, 'alert(1)');
});

test('siivous: ohjausmerkit, suuntaohjaimet, osoitteet ja skeemat pois, pituus enintään 200', () => {
  assert.equal(sanitizeNavigationText('  Fleminginkatu\t1\r\nHelsinki  '), 'Fleminginkatu 1 Helsinki');
  assert.equal(sanitizeNavigationText('Koti\u{202E}ikkis'), 'Kotiikkis', 'RTL-ohitus pois');
  assert.equal(sanitizeNavigationText('Ko\u{200B}ti\u{FEFF}'), 'Koti');
  assert.equal(sanitizeNavigationText('Katu 1 https://evil.example/x?y=1 Helsinki'), 'Katu 1 Helsinki');
  assert.equal(sanitizeNavigationText('www.evil.example Katu 2'), 'Katu 2');
  assert.equal(sanitizeNavigationText('javascript:alert(1)'), 'alert(1)');
  assert.equal(sanitizeNavigationText('JaVaScRiPt :alert(1)'), 'alert(1)');
  assert.equal(sanitizeNavigationText('javajavascript:script:alert(1)'), 'alert(1)', 'sisäkkäinen skeema');
  assert.equal(sanitizeNavigationText('java\u{0}script:x'), 'x', 'NUL ei piilota skeemaa');
  assert.equal(sanitizeNavigationText('data:text/html,<b>x</b>'), 'text/html, b x /b');
  assert.equal(sanitizeNavigationText('intent://scan/#Intent;scheme=zxing;end'), null);
  assert.equal(sanitizeNavigationText('Hotel: Kämp, Pohjoisesplanadi 29'), 'Hotel: Kämp, Pohjoisesplanadi 29', '"Hotel:" ei ole tel-skeema');
  assert.equal(sanitizeNavigationText('50% alennus, Kauppa 3'), '50% alennus, Kauppa 3');
  assert.equal(sanitizeNavigationText('Café Ääkkönen'), 'Café Ääkkönen');
  const long = sanitizeNavigationText('å'.repeat(5000));
  assert.equal(Array.from(long).length, MAX_NAVIGATION_TEXT);
  const emoji = sanitizeNavigationText('🏠'.repeat(300));
  assert.equal(Array.from(emoji).length, MAX_NAVIGATION_TEXT, 'katkaisu ei halkaise merkkiparia');
  assert.equal(sanitizeNavigationText('\u{D800}Koti'), 'Koti', 'pariton sijaismerkki pois');
});

// ------------------------------------------------------------ linkit

test('Google Maps -linkki: täsmälleen sallittu muoto, koodattu kohde, kulkutapa', () => {
  assert.equal(googleMapsUrl({ address: 'Fleminginkatu 1, Helsinki' }),
    `${WEB}Fleminginkatu%201%2C%20Helsinki&travelmode=driving`);
  assert.equal(googleMapsUrl({ address: 'X', mode: 'transit' }), `${WEB}X&travelmode=transit`);
  assert.equal(googleMapsUrl({ address: 'X', mode: 'walking' }), `${WEB}X&travelmode=walking`);
  assert.equal(googleMapsUrl({ address: 'X', mode: 'cycling' }), `${WEB}X&travelmode=bicycling`);
  assert.equal(googleMapsUrl({ address: 'X', mode: 'other' }), `${WEB}X&travelmode=driving`);
  assert.equal(googleMapsUrl({ address: 'Katu 1 & 2#osa?x=y' }), `${WEB}Katu%201%20%26%202%23osa%3Fx%3Dy&travelmode=driving`,
    'erikoismerkit eivät lisää parametreja');
  assert.equal(googleMapsUrl({}), null);
  assert.equal(googleMapsUrl(null), null);
});

test('Androidin navigointi: google.navigation, julkisilla ei navigointitilaa', () => {
  assert.equal(androidNavigationIntent({ address: 'Fleminginkatu 1' }), 'google.navigation:q=Fleminginkatu%201&mode=d');
  assert.equal(androidNavigationIntent({ address: 'X', mode: 'walking' }), 'google.navigation:q=X&mode=w');
  assert.equal(androidNavigationIntent({ address: 'X', mode: 'cycling' }), 'google.navigation:q=X&mode=b');
  assert.equal(androidNavigationIntent({ address: 'X', mode: 'other' }), 'google.navigation:q=X&mode=d');
  assert.equal(androidNavigationIntent({ address: 'X', mode: 'transit' }), null);
  assert.equal(androidNavigationIntent({}), null);
});

test('navigationLinks: kaikki kerralla, ja valmis kohde siivotaan uudelleen', () => {
  const links = navigationLinks({ address: 'Katu 1', placeName: 'Sali', mode: 'walking' });
  assert.deepEqual([links.webUrl, links.androidIntent], [`${WEB}Katu%201&travelmode=walking`, 'google.navigation:q=Katu%201&mode=w']);
  assert.equal(Object.isFrozen(links), true);
  // Käsin rakennettu "kohde" ei ohita siivousta.
  assert.equal(googleMapsUrl({ query: 'javascript:alert(1)\nKatu', mode: 'driving' }), `${WEB}alert(1)%20Katu&travelmode=driving`);
  assert.deepEqual(navigationLinks(null), { target: null, webUrl: null, androidIntent: null });
});

// ------------------------------------------------------------ sallittu lista

test('sallittu lista hyväksyy tämän moduulin tuottamat linkit (sumea kierros)', () => {
  const samples = ['Fleminginkatu 1, Helsinki', 'Café Ääkkönen', '50% alennus', "O'Learys, Tampere", '東京駅',
    'Katu 1 & 2#osa?x=y', '🏠 Koti', 'a'.repeat(400), 'Hotel: Kämp'];
  for (const text of samples) {
    for (const mode of ['driving', 'transit', 'walking', 'cycling', 'other']) {
      const web = googleMapsUrl({ address: text, mode });
      assert.equal(isAllowedNavigationUrl(web), true, web);
      const android = androidNavigationIntent({ address: text, mode });
      if (android) assert.equal(isAllowedNavigationUrl(android), true, android);
    }
  }
});

test('KRIITTINEN: sallittu lista hylkää kaiken muun, myös tekoälyn tuottaman linkin', () => {
  const rejected = [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    ' javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'intent://maps.google.com/#Intent;scheme=https;package=com.evil;end',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'http://www.google.com/maps/dir/?api=1&destination=X&travelmode=driving',
    'https://www.google.com.evil.example/maps/dir/?api=1&destination=X&travelmode=driving',
    'https://www.google.com@evil.example/maps/dir/?api=1&destination=X&travelmode=driving',
    'https://evil.example/https://www.google.com/maps/dir/?api=1&destination=X&travelmode=driving',
    'https://www.google.com:8443/maps/dir/?api=1&destination=X&travelmode=driving',
    'https://WWW.GOOGLE.COM/maps/dir/?api=1&destination=X&travelmode=driving',
    'https://google.com/maps/dir/?api=1&destination=X&travelmode=driving',
    'https://maps.google.com/maps/dir/?api=1&destination=X&travelmode=driving',
    'https://www.google.com/maps/place/?api=1&destination=X&travelmode=driving',
    'https://www.google.com/maps/dir/?api=1&destination=X&travelmode=driving&redirect=https%3A%2F%2Fevil',
    'https://www.google.com/maps/dir/?api=1&destination=X&travelmode=driving#frag',
    'https://www.google.com/maps/dir/?api=1&destination=X&travelmode=flying',
    'https://www.google.com/maps/dir/?api=1&destination=&travelmode=driving',
    'https://www.google.com/maps/dir/?api=1&destination=X Y&travelmode=driving',
    'https://www.google.com/maps/dir/?api=1&destination=X&travelmode=driving\n',
    'https://www.google.com/maps/dir/?api=1&destination=X%0A&travelmode=driving',
    'https://www.google.com/maps/dir/?api=1&destination=X%0D%0ASet-Cookie:x&travelmode=driving',
    'https://www.google.com/maps/dir/?api=1&destination=%E2%80%AEKoti&travelmode=driving',
    'https://www.google.com/maps/dir/?api=1&destination=javascript%3Aalert(1)&travelmode=driving',
    'https://www.google.com/maps/dir/?api=1&destination=%ZZ&travelmode=driving',
    'https://www.google.com/maps/dir/?api=1&destination=%C3&travelmode=driving',
    'https://www.google.com/maps/dir/?api=1&destination=x%2fy&travelmode=driving',
    'https:\\\\www.google.com/maps/dir/?api=1&destination=X&travelmode=driving',
    'https://www.google.com/maps/dir/?api=1&destination=' + 'a'.repeat(3000) + '&travelmode=driving',
    'google.navigation:q=X&mode=t',
    'google.navigation:q=X',
    'google.navigation:q=X&mode=d&extra=1',
    'google.navigation:q=%0Aevil&mode=d',
    'GOOGLE.NAVIGATION:q=X&mode=d',
    'geo:0,0?q=X',
    'tel:+358401234567',
    'sms:+358401234567',
    'market://details?id=com.evil',
    '',
    '   '
  ];
  for (const url of rejected) assert.equal(isAllowedNavigationUrl(url), false, url);
  for (const bad of [null, undefined, 5, {}, [], () => 'x', new String(WEB + 'X&travelmode=driving')]) {
    assert.equal(isAllowedNavigationUrl(bad), false);
  }
});

test('injektio ei pääse linkkiin: rivinvaihto, CRLF, RTL, skeemat ja pitkä syöte päätyvät koodatuksi tekstiksi', () => {
  const attacks = [
    'Katu 1\r\nLocation: https://evil.example',
    'Koti\u{202E}lmth.exe',
    'javascript:alert(document.cookie)',
    'data:text/html,<script>alert(1)</script>',
    'intent://evil#Intent;end',
    '"><img src=x onerror=alert(1)>',
    '&travelmode=flying&destination=evil',
    '#', '?', '%0A', 'x'.repeat(100000)
  ];
  for (const attack of attacks) {
    const url = googleMapsUrl({ address: attack });
    if (url === null) continue;
    assert.equal(url.startsWith(WEB), true);
    assert.equal(isAllowedNavigationUrl(url), true, url);
    assert.equal(/[\s<>"]/.test(url), false, url);
    assert.equal(/javascript|intent:|data:|https?%3A/i.test(url), false, url);
    assert.equal((url.match(/&travelmode=/g) || []).length, 1, 'yksi kulkutapa');
    assert.ok(url.length < 2048);
    const decoded = decodeURIComponent(url.slice(WEB.length, url.lastIndexOf('&travelmode=')));
    assert.equal(/[\u{0}-\u{1F}\u{7F}\u{202A}-\u{202E}]/u.test(decoded), false, 'ei ohjausmerkkejä');
  }
});

test('deterministinen eikä muuta syötettä', () => {
  const input = { address: 'Katu 1', placeName: 'Sali', mode: 'walking' };
  const snapshot = structuredClone(input);
  const first = googleMapsUrl(input);
  for (let i = 0; i < 100; i += 1) assert.equal(googleMapsUrl(input), first);
  assert.deepEqual(input, snapshot);
  assert.equal(Object.isFrozen(input), false);
});

test('navigointimoduuli ei avaa mitään itse eikä tunne koordinaatteja', () => {
  const code = readCode('src/domain/navigationLink.js');
  assert.equal(/window\.|location\.|open\(|fetch\(|Capacitor/.test(code), false);
  assert.equal(/\b(latitude|longitude|lat|lng|coords)\b/.test(code), false);
});
