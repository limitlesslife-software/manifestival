// Kesäajan siirtymät.
//
// Nämä testit ajetaan LAPSIPROSESSISSA kiinteällä aikavyöhykkeellä.
// Ilman sitä testi kertoisi vain kehityskoneen aikavyöhykkeestä, ja
// kesäaikaviat ovat nimenomaan niitä, jotka eivät näy siellä missä
// koodi kirjoitetaan.
//
// Suomen siirtymät 2026:
//   kevät  su 29.3.  klo 03 -> 04   (23 tunnin vuorokausi)
//   syksy  su 25.10. klo 04 -> 03   (25 tunnin vuorokausi)
//
// Pisin vuorokausi on se vaarallinen: millisekunteina laskettu
// "+1 päivä" jää edelliselle päivälle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { ROOT, read, readCode, browserModules } from './helpers/sources.mjs';

/**
 * Aja koodinpätkä annetussa aikavyöhykkeessä ja palauta sen JSON-tuloste.
 *
 * Aikavyöhyke luetaan prosessin käynnistyessä, joten sitä ei voi vaihtaa
 * kesken ajon. Lapsiprosessi on ainoa rehellinen tapa testata tämä.
 */
function inTimezone(tz, code) {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    env: { ...process.env, TZ: tz },
    encoding: 'utf8'
  });
  return JSON.parse(output.trim().split('\n').pop());
}

const ZONES = ['Europe/Helsinki', 'UTC', 'America/New_York', 'Asia/Tokyo'];

// --------------------------------------------------- päivälaskenta

test('KRIITTINEN: addDays ei siirry päivää pieleen kesäajan vaihtuessa', () => {
  // Käydään läpi molemmat siirtymäviikot päivä päivältä ja verrataan
  // kalenterilaskua siihen, mitä kalenterin pitäisi sanoa.
  const code = `
    import { addDays, fmtISO, parseISO } from './src/lib/datetime.js';
    const virheet = [];
    for (const kuukausi of [2, 9]) {
      for (let paiva = 20; paiva <= 31; paiva++) {
        const alku = new Date(2026, kuukausi, paiva);
        if (alku.getMonth() !== kuukausi) continue;
        for (let n = 1; n <= 14; n++) {
          const tulos = fmtISO(addDays(alku, n));
          // Riippumaton tarkistus: UTC-kalenteri ei tunne kesäaikaa.
          const odotus = new Date(Date.UTC(2026, kuukausi, paiva + n));
          const odotusIso = odotus.toISOString().slice(0, 10);
          if (tulos !== odotusIso) virheet.push({ alku: fmtISO(alku), n, tulos, odotusIso });
        }
      }
    }
    console.log(JSON.stringify(virheet));
  `;

  for (const tz of ZONES) {
    assert.deepEqual(inTimezone(tz, code), [], 'päivälaskenta petti vyöhykkeessä ' + tz);
  }
});

test('KRIITTINEN: millisekuntilasku EROAA kalenterilaskusta — siksi sitä ei käytetä', () => {
  // Tämä testi todistaa, että vaara on todellinen eikä teoreettinen.
  // Jos tämä joskus lakkaa löytämästä eroa, kaikki kesäaikatestit ovat
  // menettäneet merkityksensä ja se pitää huomata.
  const code = `
    import { addDays, fmtISO } from './src/lib/datetime.js';
    const erot = [];
    for (let paiva = 19; paiva <= 26; paiva++) {
      const alku = new Date(2026, 9, paiva);
      for (const n of [1, 2, 3, 6, 7]) {
        const millisekunteina = fmtISO(new Date(alku.getTime() + n * 86400000));
        const kalenterina = fmtISO(addDays(alku, n));
        if (millisekunteina !== kalenterina) erot.push({ paiva, n, millisekunteina, kalenterina });
      }
    }
    console.log(JSON.stringify(erot));
  `;

  const erot = inTimezone('Europe/Helsinki', code);
  assert.ok(erot.length > 0,
    'millisekuntilasku ei enää eroa kalenterilaskusta — testi on menettänyt merkityksensä');
});

// ------------------------------------------- muistutusten horisontti

test('muistutushorisontti lasketaan kalenterissa, ei millisekunteina', () => {
  // TAUSTA: horisontin loppupaiva laskettiin aiemmin muodossa
  //
  //     new Date(from.getTime() + n * 86400000)
  //
  // Se tuottaa syksyn 25-tuntisen vuorokauden yli ERI paivan kuin
  // kalenteri (todistettu yllaolevassa testissa). Kayttajalle nakyvaa
  // eroa ei onnistuttu rakentamaan nykyisella kolmen paivan
  // horisontilla, joten korjaus on luonteeltaan ennakoiva: se poistaa
  // ansan ennen kuin horisonttia kasvatetaan.
  //
  // Tama testi vartioi juuri sita - ettei millisekuntilasku palaa.
  //
  // Yksi muistutusputki: planUpcoming ja ajastus kayttavat samaa
  // suunnitelmaa (alarmSync.dailyLifeReminderPlan), jonka horisontti on
  // alarmSync.horizonDates -> dailyLifeModel.shiftIso -> addDays.
  const source = readCode('src/app/notifications.js'); // kommentit pois
  const upcoming = source.slice(source.indexOf('export function planUpcoming'));
  assert.equal(/getTime\(\)\s*[+-]/.test(upcoming), false,
    'horisontti lasketaan taas millisekunteina — kesäajan yli se menee pieleen');

  const sync = readCode('src/app/alarmSync.js');
  const horizon = sync.slice(sync.indexOf('export function horizonDates'), sync.indexOf('export function intentMoment'));
  assert.equal(/getTime\(\)\s*[+-]/.test(horizon), false,
    'horisontti lasketaan taas millisekunteina — kesäajan yli se menee pieleen');
  assert.ok(horizon.includes('shiftIso('), 'horisontti ei käytä kalenterilaskentaa');
  const model = readCode('src/app/dailyLifeModel.js');
  const shift = model.slice(model.indexOf('export function shiftIso'));
  assert.ok(shift.slice(0, 200).includes('addDays('), 'horisontti ei käytä kalenterilaskentaa');
  const legacy = sync.slice(sync.indexOf('export function legacyReminderIntents'));
  assert.equal(/getTime\(\)\s*[+-]/.test(legacy.slice(0, 2000)), false);
});

test('yksikään moduuli ei LISÄÄ päiviä millisekunteina', () => {
  // Ero on olennainen, ja siksi tämä testi kohdistuu vain toiseen:
  //
  //   LISÄÄMINEN  getTime() + n * 86400000   RIKKI kesäajan yli
  //   EROTUS      Math.round((a - b) / 86400000)   kestää
  //
  // Erotus kestää, koska 25-tuntinen vuorokausi on 1,041 päivää ja
  // pyöristyy yhteen. Neljä domain-moduulia laskee eron juuri näin, ja
  // se on tarkistettu oikeaksi — niitä ei pidä muuttaa turhaan.
  //
  // Lisääminen sen sijaan laskeutuu edelliselle päivälle.
  const rikkovat = [];

  for (const file of browserModules()) {
    const source = readCode(file);
    for (const match of source.matchAll(/getTime\(\)\s*\+[^;\n]*8640/g)) {
      rikkovat.push(`${file}: ${match[0].trim().slice(0, 60)}`);
    }
  }

  assert.deepEqual(rikkovat, [],
    'päivän lisäys millisekunteina — käytä addDays():a: ' + rikkovat.join(', '));
});

test('päivämääräkenttä ei siirry päivää muissakaan vyöhykkeissä', () => {
  // Pelkkä päivämäärä on kalenterikäsite, ei hetki. Se ei saa muuttua
  // vyöhykkeen mukana kummassakaan suunnassa.
  const code = `
    import { fmtISO, parseISO } from './src/lib/datetime.js';
    const virheet = [];
    for (const iso of ['2026-01-01', '2026-03-29', '2026-06-15',
                       '2026-10-25', '2026-12-31', '2028-02-29']) {
      const takaisin = fmtISO(parseISO(iso));
      if (takaisin !== iso) virheet.push({ iso, takaisin });
    }
    console.log(JSON.stringify(virheet));
  `;

  for (const tz of [...ZONES, 'Pacific/Kiritimati', 'Pacific/Niue']) {
    assert.deepEqual(inTimezone(tz, code), [],
      'päivämäärä muuttui vyöhykkeessä ' + tz);
  }
});

test('keskiyön ja vuorokauden rajat kestävät vyöhykevaihdon', () => {
  const code = `
    import { fmtISO, parseISO, addDays, startOfWeek, sameDay } from './src/lib/datetime.js';
    const virheet = [];

    // Keskiyö plus yksi päivä on aina seuraava kalenteripäivä.
    for (const iso of ['2026-03-28', '2026-03-29', '2026-10-24', '2026-10-25']) {
      const seuraava = fmtISO(addDays(parseISO(iso), 1));
      const odotus = new Date(Date.UTC(
        Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + 1
      )).toISOString().slice(0, 10);
      if (seuraava !== odotus) virheet.push({ iso, seuraava, odotus });
    }

    // Viikon alku on aina maanantai, myös siirtymäviikolla.
    for (const iso of ['2026-03-29', '2026-10-25']) {
      const alku = startOfWeek(parseISO(iso));
      if (alku.getDay() !== 1) virheet.push({ iso, viikonpaiva: alku.getDay() });
      if (alku.getHours() !== 0) virheet.push({ iso, tunti: alku.getHours() });
    }

    console.log(JSON.stringify(virheet));
  `;

  for (const tz of ZONES) {
    assert.deepEqual(inTimezone(tz, code), [], 'vuorokauden raja petti vyöhykkeessä ' + tz);
  }
});
