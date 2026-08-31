// Regressiotestit puhtaille päivämäärä- ja aikafunktioille.
//
// Nämä funktiot ohjaavat Manifestivalin automaattista herätys- ja
// nukkumaanmenolaskentaa. Ne olivat aiemmin index.html:n sisällä eikä niitä
// voinut testata lainkaan.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fmtISO, parseISO, addDays, startOfWeek, sameDay, todayMidnight,
  sortByTime, loadClass, subtractMinutes, addMinutes
} from '../src/lib/datetime.js';

test('fmtISO täyttää kuukauden ja päivän nollilla', () => {
  assert.equal(fmtISO(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(fmtISO(new Date(2026, 11, 31)), '2026-12-31');
});

test('fmtISO käyttää paikallista aikavyöhykettä, ei UTC:tä', () => {
  // Klo 23:30 paikallista aikaa. UTC-pohjainen toteutus liukuisi
  // seuraavaan päivään positiivisilla aikavyöhykkeillä (esim. Suomi).
  const lateEvening = new Date(2026, 6, 30, 23, 30, 0);
  assert.equal(fmtISO(lateEvening), '2026-07-30');
});

test('parseISO ja fmtISO ovat toistensa käänteisfunktiot', () => {
  for (const iso of ['2026-01-01', '2026-02-28', '2026-08-31', '2026-12-31']) {
    assert.equal(fmtISO(parseISO(iso)), iso);
  }
});

test('parseISO palauttaa paikallisen keskiyön', () => {
  const d = parseISO('2026-08-31');
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 7); // elokuu
  assert.equal(d.getDate(), 31);
});

test('addDays ei mutatoi syötettä ja ylittää kuukauden rajan', () => {
  const original = new Date(2026, 7, 31); // 31.8.2026
  const moved = addDays(original, 1);
  assert.equal(fmtISO(original), '2026-08-31', 'alkuperäinen ei saa muuttua');
  assert.equal(fmtISO(moved), '2026-09-01');
  assert.equal(fmtISO(addDays(original, -1)), '2026-08-30');
});

test('addDays ylittää vuodenvaihteen', () => {
  assert.equal(fmtISO(addDays(new Date(2026, 11, 31), 1)), '2027-01-01');
});

test('startOfWeek palauttaa aina maanantain', () => {
  // Käydään läpi kokonainen viikko: jokaisen päivän pitää palauttaa sama maanantai.
  const mondays = new Set();
  for (let i = 0; i < 7; i++) {
    const d = addDays(new Date(2026, 7, 31), i); // ma 31.8. -> su 6.9.
    const ws = startOfWeek(d);
    assert.equal(ws.getDay(), 1, 'startOfWeek palautti päivän ' + ws.getDay() + ', odotettiin maanantaita (1)');
    mondays.add(fmtISO(ws));
  }
  assert.equal(mondays.size, 1, 'saman viikon päivien pitää palauttaa sama maanantai');
});

test('startOfWeek käsittelee sunnuntain viikon viimeisenä päivänä', () => {
  // Sunnuntai on JS:ssä getDay() === 0. Naiivi toteutus hyppäisi väärään suuntaan.
  const sunday = new Date(2026, 8, 6);
  assert.equal(sunday.getDay(), 0, 'testin ennakkoehto: 6.9.2026 on sunnuntai');
  const ws = startOfWeek(sunday);
  assert.equal(ws.getDay(), 1);
  assert.equal(fmtISO(ws), '2026-08-31', 'sunnuntain viikon pitää alkaa edellisestä maanantaista');
});

test('startOfWeek nollaa kellonajan', () => {
  const ws = startOfWeek(new Date(2026, 7, 31, 17, 45, 30));
  assert.equal(ws.getHours(), 0);
  assert.equal(ws.getMinutes(), 0);
  assert.equal(ws.getSeconds(), 0);
});

test('sameDay vertaa kalenteripäivää eikä kellonaikaa', () => {
  assert.equal(sameDay(new Date(2026, 7, 31, 0, 1), new Date(2026, 7, 31, 23, 59)), true);
  assert.equal(sameDay(new Date(2026, 7, 31, 23, 59), new Date(2026, 8, 1, 0, 1)), false);
});

test('todayMidnight palauttaa kuluvan päivän keskiyön', () => {
  const t = todayMidnight();
  assert.equal(t.getHours(), 0);
  assert.equal(t.getMinutes(), 0);
  assert.equal(t.getSeconds(), 0);
  assert.equal(t.getMilliseconds(), 0);
  assert.equal(fmtISO(t), fmtISO(new Date()));
});

test('sortByTime järjestää ajan mukaan ja siirtää ajattomat loppuun', () => {
  const items = [
    { title: 'ei aikaa', time: null },
    { title: 'ilta', time: '21:30' },
    { title: 'aamu', time: '05:30' },
    { title: 'ei aikaa 2', time: null },
    { title: 'keskipäivä', time: '12:00' }
  ];
  const sorted = [...items].sort(sortByTime).map(i => i.title);
  assert.deepEqual(sorted.slice(0, 3), ['aamu', 'keskipäivä', 'ilta']);
  assert.deepEqual(sorted.slice(3).sort(), ['ei aikaa', 'ei aikaa 2']);
});

test('loadClass antaa kuormitusluokan merkintöjen määrästä', () => {
  assert.equal(loadClass(0), null, 'tyhjä päivä ei ole kuormitettu');
  assert.equal(loadClass(1), 'sage');
  assert.equal(loadClass(3), 'sage', 'raja: 3 on vielä kevyt');
  assert.equal(loadClass(4), 'gold', 'raja: 4 on jo kohtalainen');
  assert.equal(loadClass(7), 'gold', 'raja: 7 on vielä kohtalainen');
  assert.equal(loadClass(8), 'clay', 'raja: 8 on raskas');
  assert.equal(loadClass(50), 'clay');
});

test('subtractMinutes vähentää minuutteja saman vuorokauden sisällä', () => {
  assert.equal(subtractMinutes('07:00', 90), '05:30');
  assert.equal(subtractMinutes('12:00', 0), '12:00');
  assert.equal(subtractMinutes('07:00', 30), '06:30');
});

test('subtractMinutes kiertää keskiyön yli taaksepäin', () => {
  // Tämä on nukkumaanmenoajan laskennan kriittisin tapaus: herätys 05:30,
  // unitavoite 8 h -> nukkumaanmeno edellisen päivän puolella klo 21:30.
  assert.equal(subtractMinutes('05:30', 8 * 60), '21:30');
  assert.equal(subtractMinutes('00:30', 60), '23:30');
  assert.equal(subtractMinutes('00:00', 1), '23:59');
});

test('subtractMinutes kestää yli vuorokauden mittaiset arvot', () => {
  assert.equal(subtractMinutes('12:00', 1440), '12:00', 'täysi vuorokausi palaa samaan aikaan');
  assert.equal(subtractMinutes('12:00', 1500), '11:00', 'vuorokausi + 60 min');
});

test('addMinutes lisää minuutteja ja kiertää keskiyön yli eteenpäin', () => {
  assert.equal(addMinutes('05:30', 60), '06:30');
  assert.equal(addMinutes('23:30', 60), '00:30');
  assert.equal(addMinutes('23:59', 1), '00:00');
});

test('addMinutes ja subtractMinutes ovat toistensa käänteisoperaatiot', () => {
  for (const time of ['00:00', '05:30', '12:00', '23:59']) {
    for (const mins of [1, 45, 480, 1439]) {
      assert.equal(subtractMinutes(addMinutes(time, mins), mins), time,
        'epäonnistui: ' + time + ' +/- ' + mins);
    }
  }
});

test('aikatulos on aina muotoa HH:MM', () => {
  const pattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const mins of [0, 7, 61, 599, 1439, 2880]) {
    assert.match(subtractMinutes('13:37', mins), pattern);
    assert.match(addMinutes('13:37', mins), pattern);
  }
});
