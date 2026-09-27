// Suomenkielinen päivä- ja kellonaikajäsennin: laaja korpus.
//
// Pääperiaate: jäsennin joko on YKSISELITTEINEN tai ei väitä mitään.
// Jokainen epäselvä ilmaisu (sama viikonpäivä kuin tänään, 1-6 ilman
// vuorokaudenaikaa, viikonloppu, kaksi eri päivää) tuottaa `null` ja
// epäselvyyslipun -- ei arvausta.
//
// Perusviikko: maanantai 2026-03-02 (kuun 2. päivä, ei kesäajan vaihtoa).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readCode } from './helpers/sources.mjs';
import {
  parseFinnishTemporal, temporalHints, addDaysIso, weekdayOfIso, DATE_ROLE, clockFromParts
} from '../src/domain/fiTemporal.js';

const MON = '2026-03-02';

const hint = (text, today = MON, intent = 'create_task') => temporalHints(text, today, { intent });
const dateOf = (text, today, intent) => hint(text, today, intent).date;
const timeOf = (text, today, intent) => hint(text, today, intent).time;

// ---------------------------------------------------------------- kalenteri

test('viikonpäivän laskenta: tunnetut päivät', () => {
  assert.equal(weekdayOfIso('2026-03-02'), 1);
  assert.equal(weekdayOfIso('2026-03-08'), 7);
  assert.equal(weekdayOfIso('1970-01-01'), 4);
  assert.equal(weekdayOfIso('2028-02-29'), 2);
  assert.equal(weekdayOfIso('2000-01-01'), 6);
});

test('addDaysIso: kuukauden, vuoden ja karkauspäivän raja', () => {
  assert.equal(addDaysIso('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysIso('2027-02-28', 1), '2027-03-01');
  assert.equal(addDaysIso('2028-02-28', 1), '2028-02-29');
  assert.equal(addDaysIso('2028-02-29', 1), '2028-03-01');
  assert.equal(addDaysIso('2026-03-01', -1), '2026-02-28');
});

// ----------------------------------------------------- suhteelliset päivät

test('tänään, huomenna, ylihuomenna ja niiden taivutukset', () => {
  for (const [text, expected] of [
    ['tänään', '2026-03-02'],
    ['Huomenna', '2026-03-03'], ['HUOMENNA', '2026-03-03'], ['huomiseksi', '2026-03-03'], ['huomiseen mennessä', '2026-03-03'],
    ['ylihuomenna', '2026-03-04'], ['ylihuomiseksi', '2026-03-04'], ['ylihuomiselle', '2026-03-04']
  ]) assert.equal(dateOf(text), expected, text);
});

test('viittaukset olemassa olevaan (huomiselta, huomisen) eivät ole kohde luontikomennossa', () => {
  assert.equal(dateOf('huomiselta'), null);
  assert.equal(dateOf('huomisen palaveri'), null);
  const parsed = parseFinnishTemporal('siirrä huomiselta', MON).dates;
  assert.equal(parsed[0].role, DATE_ROLE.REFERENCE);
  assert.equal(parsed[0].iso, '2026-03-03');
});

test('näyttökomennossa viittausrooli kelpaa: "näytä huomisen päivä"', () => {
  assert.equal(dateOf('näytä huomisen päivä', MON, 'show_day_plan'), '2026-03-03');
  assert.equal(dateOf('näytä huomisen päivä', MON, 'create_task'), null);
});

test('huomenta (tervehdys) ei ole huomenna', () => {
  assert.equal(dateOf('hyvää huomenta'), null);
  assert.equal(dateOf('huomiota vaativa asia'), null);
});

// -------------------------------------------------------------- viikonpäivät

test('viikonpäivät maanantailta: seuraava esiintymä, kaikki taivutukset', () => {
  for (const [text, expected] of [
    ['tiistaina', '2026-03-03'], ['keskiviikkona', '2026-03-04'], ['torstaiksi', '2026-03-05'],
    ['perjantaina', '2026-03-06'], ['lauantaille', '2026-03-07'], ['sunnuntaiksi', '2026-03-08'],
    ['sunnuntaille', '2026-03-08'], ['Perjantaina', '2026-03-06']
  ]) assert.equal(dateOf(text), expected, text);
});

test('KRIITTINEN: sama viikonpäivä kuin tänään on epäselvä (tänään vai viikon päästä)', () => {
  const result = hint('maanantaina');
  assert.equal(result.date, null);
  assert.equal(result.dateAmbiguous, true);
  assert.equal(hint('maanantaiksi').dateAmbiguous, true);
  assert.equal(hint('maanantaina', '2026-03-06').dateAmbiguous, false, 'perjantaina maanantai on selvä');
  assert.equal(dateOf('maanantaina', '2026-03-06'), '2026-03-09');
});

test('"ensi" tarkoittaa seuraavaa esiintymää tämän päivän jälkeen (sama päivä = viikon päästä)', () => {
  assert.equal(dateOf('ensi maanantaina'), '2026-03-09');
  assert.equal(dateOf('ensi perjantaina'), '2026-03-06');
  assert.equal(dateOf('ensi sunnuntaina'), '2026-03-08');
  assert.equal(dateOf('ensi perjantaina', '2026-03-06'), '2026-03-13');
});

test('"ensi viikon perjantaina" ja "tämän viikon perjantaina"', () => {
  assert.equal(dateOf('ensi viikon perjantaina'), '2026-03-13');
  assert.equal(dateOf('ensi viikon maanantaina'), '2026-03-09');
  assert.equal(dateOf('ensi viikon sunnuntaina'), '2026-03-15');
  assert.equal(dateOf('tämän viikon perjantaina'), '2026-03-06');
  assert.equal(dateOf('tämän viikon maanantaina'), '2026-03-02', 'tämä päivä ei ole mennyt');
});

test('tämän viikon jo mennyt päivä on epäselvä', () => {
  const result = hint('tämän viikon maanantaina', '2026-03-04');
  assert.equal(result.date, null);
  assert.equal(result.dateAmbiguous, true);
});

test('viikonpäivät perjantailta ja sunnuntailta', () => {
  const FRI = '2026-03-06';
  const SUN = '2026-03-08';
  assert.equal(hint('perjantaina', FRI).dateAmbiguous, true);
  assert.equal(dateOf('lauantaina', FRI), '2026-03-07');
  assert.equal(dateOf('maanantaina', FRI), '2026-03-09');
  assert.equal(hint('sunnuntaina', SUN).dateAmbiguous, true);
  assert.equal(dateOf('maanantaina', SUN), '2026-03-09');
  assert.equal(dateOf('ensi sunnuntaina', SUN), '2026-03-15');
});

test('viikonloppu ja "ensi viikolla" luontikomennossa eivät nimeä yhtä päivää', () => {
  for (const text of ['viikonloppuna', 'viikonloppuna siivous', 'ensi viikolla', 'tällä viikolla']) {
    const result = hint(text);
    assert.equal(result.date, null, text);
    assert.equal(result.dateAmbiguous, true, text);
  }
});

test('"ensi viikko" ja "tämä viikko" näyttökomennolle: viikon maanantai', () => {
  assert.equal(dateOf('Näytä ensi viikko', MON, 'show_week_plan'), '2026-03-09');
  assert.equal(dateOf('näytä tämä viikko', MON, 'show_week_plan'), '2026-03-02');
  assert.equal(dateOf('näytä ensi viikon suunnitelma', MON, 'show_week_plan'), '2026-03-09');
  assert.equal(dateOf('näytä ensi viikko', '2026-03-08', 'show_week_plan'), '2026-03-09', 'sunnuntaina ensi viikko alkaa huomenna');
});

// -------------------------------------------------------------- kuun loppu

test('kuun lopussa: kuukauden viimeinen päivä (myös karkausvuosi ja vuodenvaihde)', () => {
  assert.equal(dateOf('kuun lopussa'), '2026-03-31');
  assert.equal(dateOf('kuun lopussa', '2026-04-10'), '2026-04-30');
  assert.equal(dateOf('kuun lopussa', '2028-02-10'), '2028-02-29');
  assert.equal(dateOf('kuun lopussa', '2027-02-10'), '2027-02-28');
  assert.equal(dateOf('kuun lopussa', '2026-12-15'), '2026-12-31');
  assert.equal(dateOf('kuun loppuun mennessä'), '2026-03-31');
});

// --------------------------------------------------------- numeeriset päivät

test('numeeriset päivät: 30.9., 30.9.2026 ja ISO', () => {
  assert.equal(dateOf('deadline 30.9.'), '2026-09-30');
  assert.equal(dateOf('deadline 30.9.2026'), '2026-09-30');
  assert.equal(dateOf('päivälle 2026-09-25'), '2026-09-25');
  assert.equal(dateOf('5.10.2026'), '2026-10-05');
});

test('numeerinen päivä ilman vuotta: mennyt päivä siirtyy ensi vuoteen, tämä päivä säilyy', () => {
  assert.equal(dateOf('1.3.'), '2027-03-01');
  assert.equal(dateOf('2.3.'), '2026-03-02');
  assert.equal(dateOf('3.3.'), '2026-03-03');
});

test('mahdoton numeerinen päivä on epäselvä, ei keksitty', () => {
  for (const text of ['31.2.', '30.2.2026', '32.1.', '0.5.', '15.13.']) {
    const result = hint(text);
    assert.equal(result.date, null, text);
    assert.equal(result.dateAmbiguous, true, text);
  }
});

test('kellonaika ei tulkita päiväyksenä: "klo 8.10." ja "klo 8.30 huomenna"', () => {
  assert.equal(dateOf('klo 8.10.'), null);
  assert.equal(timeOf('klo 8.10.'), '08:10');
  assert.equal(dateOf('klo 8.30 huomenna'), '2026-03-03');
  assert.equal(timeOf('klo 8.30 huomenna'), '08:30');
});

// ----------------------------------------------------------- useita päiviä

test('siirto: "huomiselta sunnuntaille" -> kohde on sunnuntai, lähde ohitetaan', () => {
  assert.equal(dateOf('Siirrä auton pesu huomiselta sunnuntaille', MON, 'reschedule_task'), '2026-03-08');
  assert.equal(dateOf('siirrä huomisen palaveri perjantaille', MON, 'reschedule_task'), '2026-03-06');
  assert.equal(dateOf('siirrä perjantaista lauantaiksi', MON, 'reschedule_task'), '2026-03-07', 'perjantaista = lähde, lauantaiksi = kohde');
});

test('kaksi eri kohdepäivää on epäselvä', () => {
  for (const text of ['huomenna ja ylihuomenna', 'perjantaina tai lauantaina', 'huomenna mutta ensi maanantaina']) {
    const result = hint(text);
    assert.equal(result.date, null, text);
    assert.equal(result.dateAmbiguous, true, text);
  }
  assert.equal(dateOf('huomenna, siis huomenna'), '2026-03-03', 'sama päivä kahdesti on yksi päivä');
});

// --------------------------------------------------------------- kellonajat

test('klo-muodot: klo 8, kello 8, klo 8:30, klo 8.30, klo 14', () => {
  for (const [text, expected] of [
    ['klo 8', '08:00'], ['kello 8', '08:00'], ['Klo 8', '08:00'], ['klo 8:30', '08:30'], ['klo 8.30', '08:30'],
    ['klo 14', '14:00'], ['klo 14.45', '14:45'], ['klo 12', '12:00'], ['klo 0:15', '00:15'], ['klo 23:59', '23:59'],
    ['klo 07', '07:00'], ['klo 9', '09:00'], ['8:30', '08:30'], ['soita 17:45', '17:45']
  ]) assert.equal(timeOf(text), expected, text);
});

test('KRIITTINEN: klo 1-6 ilman vuorokaudenaikaa on epäselvä', () => {
  for (const text of ['klo 1', 'klo 2', 'klo 3', 'klo 4:30', 'klo 5', 'klo 6']) {
    const result = hint(text);
    assert.equal(result.time, null, text);
    assert.equal(result.timeAmbiguous, true, text);
  }
  assert.equal(timeOf('klo 7'), '07:00', '7 on aamu');
});

test('vuorokaudenaika ratkaisee: iltapäivällä klo 3 = 15:00, illalla klo 8 = 20:00', () => {
  for (const [text, expected] of [
    ['iltapäivällä klo 3', '15:00'], ['klo 3 iltapäivällä', '15:00'], ['illalla klo 8', '20:00'], ['klo 8 illalla', '20:00'],
    ['illalla klo 11', '23:00'], ['aamulla klo 8', '08:00'], ['aamulla klo 6', '06:00'], ['yöllä klo 2', '02:00'],
    ['yöllä klo 11', '23:00'], ['iltapäivällä klo 12', '12:00']
  ]) assert.equal(timeOf(text), expected, text);
});

test('KRIITTINEN: kaksitoista yöllä on keskiyö, ei keskipäivä (puoli yksi yöllä = 00:30)', () => {
  for (const [text, expected] of [
    ['soita äidille huomenna puoli yksi yöllä', '00:30'], ['lääke klo 12 yöllä', '00:00'],
    ['varttia vaille yksi yöllä herätys', '00:45'], ['kahdeltatoista yöllä huomenna', '00:00'],
    ['viittä yli kaksitoista yöllä', '00:05'], ['yöllä klo 12.15', '00:15']
  ]) {
    const result = hint(text);
    assert.equal(result.time, expected, text);
    assert.equal(result.timeAmbiguous, false, text);
  }
  assert.equal(clockFromParts(12, 30, 'yöllä').time, '00:30');
});

test('kaksitoista illalla ei ole keskipäivä: jäsennin ei väitä aikaa (keskiyö kuuluisi seuraavalle päivälle)', () => {
  for (const text of ['illalla klo 12', 'klo 12 illalla', 'puoli yksi illalla']) {
    const result = hint(text);
    assert.equal(result.time, null, text);
    assert.equal(result.timeAmbiguous, true, text);
  }
});

test('ristiriitainen vuorokaudenaika on epäselvä', () => {
  for (const text of ['aamulla klo 15', 'aamulla ja illalla klo 8', 'illalla klo 25']) {
    assert.equal(hint(text).time, null, text);
    assert.equal(hint(text).timeAmbiguous, true, text);
  }
});

test('mahdoton kellonaika on epäselvä', () => {
  for (const text of ['klo 25', 'klo 24', 'klo 8:75', 'klo 99']) {
    assert.equal(hint(text).time, null, text);
    assert.equal(hint(text).timeAmbiguous, true, text);
  }
});

test('KRIITTINEN: puoli yhdeksältä = 08:30 (ei 09:30)', () => {
  for (const [text, expected] of [
    ['puoli yhdeksältä', '08:30'], ['puoli yhdeksän', '08:30'], ['puoli yhdeksään', '08:30'], ['puoli yhdeksäksi', '08:30'],
    ['puoli kymmeneltä', '09:30'], ['puoli kymmenen', '09:30'], ['puoli yhdeltä', '12:30'], ['puoli yksi', '12:30'],
    ['puoli kaksitoista', '11:30'], ['puoli kahdentoista', '11:30'], ['puoli 9', '08:30'], ['puoli kahdeksan', '07:30'],
    ['puoli yhdentoista', '10:30']
  ]) assert.equal(timeOf(text), expected, text);
});

test('puoli + pieni tunti on epäselvä ilman vuorokaudenaikaa, selvä sen kanssa', () => {
  for (const text of ['puoli kolme', 'puoli neljä', 'puoli viisi', 'puoli kaksi', 'puoli seitsemältä', 'puoli seitsemän']) {
    assert.equal(hint(text).timeAmbiguous, true, text);
  }
  assert.equal(timeOf('puoli kolme iltapäivällä'), '14:30');
  assert.equal(timeOf('puoli kaksi iltapäivällä'), '13:30');
  assert.equal(timeOf('illalla puoli kahdeksan'), '19:30');
  assert.equal(timeOf('illalla puoli yhdeksän'), '20:30');
});

test('varttia vaille / yli ja viittä, kymmentä', () => {
  for (const [text, expected] of [
    ['varttia vaille yhdeksän', '08:45'], ['vartin yli kahdeksan', '08:15'], ['varttia yli kahdeksan', '08:15'],
    ['viittä vaille kymmenen', '09:55'], ['viittä yli kahdeksan', '08:05'], ['kymmentä vaille yhdeksän', '08:50'],
    ['kymmentä yli kahdeksan', '08:10'], ['varttia vaille yksi', '12:45'], ['varttia yli yksitoista', '11:15'],
    ['varttia vaille kaksitoista', '11:45']
  ]) assert.equal(timeOf(text), expected, text);
  assert.equal(hint('varttia vaille kolme').timeAmbiguous, true);
  assert.equal(timeOf('varttia vaille kolme iltapäivällä'), '14:45');
  assert.equal(timeOf('varttia yli neljä illalla'), '16:15');
});

test('pelkkä vuorokaudenaika ilman kellonaikaa ei tuota kellonaikaa', () => {
  for (const text of ['aamulla', 'illalla', 'iltapäivällä', 'yöllä', 'huomenna aamulla']) {
    assert.equal(hint(text).time, null, text);
    assert.equal(hint(text).timeAmbiguous, false, text);
  }
});

test('kaksi eri kellonaikaa on epäselvä, sama kahdesti ei', () => {
  assert.equal(hint('klo 8 ja klo 9').timeAmbiguous, true);
  assert.equal(hint('klo 8 tai puoli yhdeksän').timeAmbiguous, true);
  assert.equal(timeOf('klo 8, siis klo 8'), '08:00');
  assert.equal(timeOf('klo 8 ja puoli yhdeksän'), null);
});

// ----------------------------------------------------------- yhdistelmät

test('täydet lauseet: päivä + kellonaika', () => {
  const cases = [
    ['Muistuta minua huomenna klo 8 soittamaan asiakkaalle', '2026-03-03', '08:00'],
    ['Muistuta perjantaina puoli yhdeksältä hakemaan paketti', '2026-03-06', '08:30'],
    ['Lisää tehtävä pestä auto huomenna', '2026-03-03', null],
    ['Muistuta ylihuomenna kello 17.15 hakemaan lapset', '2026-03-04', '17:15'],
    ['Palaveri ensi maanantaina klo 10', '2026-03-09', '10:00'],
    ['Hammaslääkäri 5.3. klo 9:30', '2026-03-05', '09:30'],
    ['Kokous torstaina varttia vaille kymmenen', '2026-03-05', '09:45'],
    ['Soita äidille kuun lopussa', '2026-03-31', null],
    ['Osta maitoa', null, null],
    ['Siivous viikonloppuna', null, null]
  ];
  for (const [text, date, time] of cases) {
    const result = hint(text);
    assert.equal(result.date, date, text);
    assert.equal(result.time, time, text);
  }
});

test('kuukauden ja vuoden vaihde päivämäärälaskennassa', () => {
  assert.equal(dateOf('huomenna', '2026-12-31'), '2027-01-01');
  assert.equal(dateOf('ylihuomenna', '2026-12-30'), '2027-01-01');
  assert.equal(dateOf('1.1.', '2026-12-30'), '2027-01-01');
  assert.equal(dateOf('huomenna', '2028-02-28'), '2028-02-29');
  assert.equal(dateOf('ylihuomenna', '2028-02-28'), '2028-03-01');
  assert.equal(dateOf('huomenna', '2027-02-28'), '2027-03-01');
});

test('kesäajan vaihtopäivät: kalenteripäivät eivät heilahda (2026-03-29, 2026-10-25)', () => {
  assert.equal(dateOf('huomenna', '2026-03-28'), '2026-03-29');
  assert.equal(dateOf('ylihuomenna', '2026-03-28'), '2026-03-30');
  assert.equal(dateOf('huomenna', '2026-03-29'), '2026-03-30');
  assert.equal(dateOf('huomenna', '2026-10-24'), '2026-10-25');
  assert.equal(dateOf('ylihuomenna', '2026-10-24'), '2026-10-26');
  assert.equal(dateOf('maanantaina', '2026-10-25'), '2026-10-26');
  assert.equal(dateOf('ensi viikon maanantaina', '2026-03-25'), '2026-03-30');
});

// -------------------------------------------------- rikkinäinen syöte

test('rikkinäinen syöte ei kaada eikä keksi mitään', () => {
  for (const bad of [null, undefined, 5, {}, [], '', '   ']) {
    assert.deepEqual(temporalHints(bad, MON), { date: null, time: null, dateAmbiguous: false, timeAmbiguous: false });
  }
  for (const today of [null, undefined, '', 'eilen', '2026-13-45', 5]) {
    assert.deepEqual(temporalHints('huomenna klo 8', today), { date: null, time: null, dateAmbiguous: false, timeAmbiguous: false });
  }
  assert.deepEqual(parseFinnishTemporal(null, MON), { dates: [], times: [] });
});

test('erikoismerkit ja pitkä teksti eivät aiheuta virhettä tai jumia', () => {
  const noise = 'ä'.repeat(20000) + ' huomenna ' + '9'.repeat(20000);
  const started = Date.now();
  assert.equal(dateOf(noise), '2026-03-03');
  assert.ok(Date.now() - started < 1500, 'liian hidas: ' + (Date.now() - started) + ' ms');
  assert.equal(dateOf('HUOMENNA!!! 🎉 klo 8???'), '2026-03-03');
  assert.equal(timeOf('HUOMENNA!!! 🎉 klo 8???'), '08:00');
});

test('yhdistetty ja hajotettu Unicode (ä, ö) vastaavat toisiaan', () => {
  const composed = 'iltapäivällä klo 3';
  const decomposed = composed.normalize('NFD');
  assert.equal(timeOf(decomposed), timeOf(composed));
  assert.equal(timeOf(decomposed), '15:00');
});

// ------------------------------------------------- determinismi ja puhtaus

test('determinismi: sama syöte, sama tulos; syötteitä ei mutatoida', () => {
  const text = 'Muistuta perjantaina puoli yhdeksältä hakemaan paketti';
  const first = JSON.stringify(parseFinnishTemporal(text, MON));
  for (let i = 0; i < 500; i += 1) assert.equal(JSON.stringify(parseFinnishTemporal(text, MON)), first);
});

test('KRIITTINEN: jäsennin ei lue kelloa eikä satunnaisuutta', () => {
  const source = readCode('src/domain/fiTemporal.js');
  for (const forbidden of ['Date.now', 'new Date()', 'Math.random', 'performance.now', 'fetch(', 'localStorage']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

// ================================================ pelkät tuntisanat (lisäys)
//
// "lauantaina seitsemältä", "klo seitsemän": 1-11 ilman vuorokaudenaikaa
// on epäselvä (07 vai 19), ja jäsennin kertoo molemmat vaihtoehdot.
// 12-23 on selvä. Muualla kuin klo-sanan perässä tai päivän/vuoro-
// kaudenajan vieressä tuntisana ei ole kellonaika.

const timesOf = (text, today = MON) => parseFinnishTemporal(text, today).times;

test('KRIITTINEN: "lauantaina seitsemältä" on epäselvä: klo 7 vai klo 19', () => {
  const result = hint('Teatteri lauantaina seitsemältä');
  assert.equal(result.date, '2026-03-07');
  assert.equal(result.time, null);
  assert.equal(result.timeAmbiguous, true);
  const [entry] = timesOf('Teatteri lauantaina seitsemältä');
  assert.deepEqual(entry.options, ['07:00', '19:00']);
  assert.equal(entry.reason, 'ambiguous_hour_word');
  assert.equal(entry.expr, 'seitsemältä');
});

test('klo + tuntisana: 1-11 epäselvä, 12-23 selvä', () => {
  for (const [text, options] of [
    ['klo seitsemän', ['07:00', '19:00']], ['kello kahdeksalta', ['08:00', '20:00']], ['klo yksi', ['01:00', '13:00']],
    ['klo yksitoista', ['11:00', '23:00']], ['kello kymmeneltä', ['10:00', '22:00']], ['klo yhdeksään', ['09:00', '21:00']]
  ]) {
    assert.equal(hint(text).timeAmbiguous, true, text);
    assert.deepEqual(timesOf(text)[0].options, options, text);
  }
  for (const [text, expected] of [
    ['klo kaksitoista', '12:00'], ['klo kolmetoista', '13:00'], ['kello viisitoista', '15:00'], ['klo seitsemäntoista', '17:00'],
    ['klo kaksikymmentä', '20:00'], ['klo kaksikymmentäkolme', '23:00'], ['kello kahdeltatoista', '12:00']
  ]) assert.equal(timeOf(text), expected, text);
});

test('vuorokaudenaika ratkaisee tuntisanan', () => {
  for (const [text, expected] of [
    ['lauantaina illalla seitsemältä', '19:00'], ['klo seitsemän illalla', '19:00'], ['aamulla kahdeksalta', '08:00'],
    ['kahdeksalta aamulla', '08:00'], ['iltapäivällä kolmelta', '15:00'], ['illalla yhdeksältä', '21:00'],
    ['illalla yhdeltätoista', '23:00'], ['yöllä kahdelta', '02:00'], ['huomenna aamulla seitsemältä', '07:00']
  ]) assert.equal(timeOf(text), expected, text);
  assert.equal(hint('aamulla kolmeltatoista').timeAmbiguous, true, 'aamu ja 13 ovat ristiriidassa');
});

test('päivän vieressä ablatiivi on kellonaika, muualla ei', () => {
  assert.equal(hint('huomenna kolmeltatoista').time, '13:00');
  assert.equal(hint('seitsemältä huomenna').timeAmbiguous, true, 'päivä voi olla myös perässä');
  assert.equal(hint('perjantaina, kahdeksalta').timeAmbiguous, true);
  assert.equal(hint('5.3. yhdeksältä').timeAmbiguous, true);
  for (const text of ['osta seitsemän munaa', 'yhdeltä asiakkaalta tuli palaute', 'lainaa kahdelta ystävältä', 'seitsemältä',
    'seitsemän veljestä', 'kello on paljon']) {
    const result = hint(text);
    assert.equal(result.time, null, text);
    assert.equal(result.timeAmbiguous, false, text);
    assert.deepEqual(timesOf(text), [], text);
  }
});

test('vanhat säännöt ennallaan: puoli, vaille/yli ja numerot', () => {
  assert.equal(timeOf('perjantaina puoli yhdeksältä'), '08:30');
  assert.equal(timeOf('Muistuta perjantaina puoli yhdeksältä hakemaan paketti'), '08:30');
  assert.equal(timeOf('torstaina varttia vaille kymmenen'), '09:45');
  assert.equal(timeOf('klo 7'), '07:00', 'numero 7 on edelleen aamu');
  assert.equal(timeOf('klo 12'), '12:00');
  assert.equal(hint('puoli kolmetoista').timeAmbiguous, false, 'ei uutta tulkintaa puoli-säännölle');
  assert.equal(hint('puoli kolmetoista').time, null);
  // Numeroiden epäselvät tunnit kertovat nyt myös vaihtoehdot.
  assert.deepEqual(timesOf('klo 5')[0].options, ['05:00', '17:00']);
  assert.deepEqual(timesOf('klo 4:30')[0].options, ['04:30', '16:30']);
});

test('ilmausten kohdat: start/end osoittavat pienaakkostetun tekstin ilmaukseen', () => {
  const text = 'Lisää PARTURI ensi tiistaille klo 16 ja teatteri lauantaina seitsemältä';
  const lower = text.toLocaleLowerCase('fi');
  const { dates, times } = parseFinnishTemporal(text, MON);
  for (const entry of [...dates, ...times]) {
    assert.equal(lower.slice(entry.start, entry.end), entry.expr, entry.expr);
  }
  assert.deepEqual(dates.map(d => d.expr), ['ensi tiistaille', 'lauantaina']);
  assert.deepEqual(times.map(t => t.expr), ['klo 16', 'seitsemältä']);
});

test('clockFromParts: samat kellosäännöt muille jäsentimille', () => {
  assert.deepEqual(clockFromParts(9, 30, 'huomenna'), { time: '09:30', ambiguous: false, reason: '' });
  assert.equal(clockFromParts(7, 0, 'illalla').time, '19:00');
  assert.deepEqual(clockFromParts(5, 0, '').options, ['05:00', '17:00']);
  assert.equal(clockFromParts(25, 0, '').reason, 'invalid');
  assert.equal(clockFromParts(8, 75).ambiguous, true);
  assert.equal(clockFromParts(8, 0, null).time, '08:00');
});

test('kesäajan vaihtopäivät ja vuodenvaihde tuntisanoilla', () => {
  assert.equal(dateOf('huomenna seitsemältä', '2026-03-28'), '2026-03-29');
  assert.equal(hint('huomenna seitsemältä', '2026-03-28').timeAmbiguous, true);
  assert.equal(timeOf('huomenna illalla seitsemältä', '2026-10-24'), '19:00');
  assert.equal(dateOf('huomenna illalla seitsemältä', '2026-10-24'), '2026-10-25');
  assert.equal(dateOf('huomenna klo kolmetoista', '2026-12-31'), '2027-01-01');
  assert.equal(timeOf('huomenna klo kolmetoista', '2026-12-31'), '13:00');
});

test('suorituskyky: tuntisanojen toisto 40 000 merkissä pysyy nopeana', () => {
  const texts = [
    'seitsemältä '.repeat(3500),
    'lauantaina seitsemältä '.repeat(1800),
    'klo seitsemän '.repeat(3000),
    'huomenna illalla yhdeltätoista '.repeat(1300)
  ];
  for (const text of texts) {
    const started = Date.now();
    temporalHints(text, MON);
    assert.ok(Date.now() - started < 1500, 'liian hidas: ' + (Date.now() - started) + ' ms');
  }
});

test('tuntisanat: determinismi', () => {
  const text = 'Teatteri lauantaina seitsemältä, klo kolmetoista tai illalla yhdeksältä';
  const first = JSON.stringify(parseFinnishTemporal(text, MON));
  for (let i = 0; i < 200; i += 1) assert.equal(JSON.stringify(parseFinnishTemporal(text, MON)), first);
});
