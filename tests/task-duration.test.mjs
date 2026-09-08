// Tehtävän kesto: yksi totuuden lähde.
//
// TUOTANNOSSA HAVAITTU VIKA
//
// Käyttäjä loi tapahtuman 01:00–02:00 ja lomake näytti kestoksi 30.
// Odotus oli 60.
//
// Vika oli kahdessa kohdassa, ja kumpikin yksin olisi riittänyt:
//
//   1. DOMAIN. `durationOf()` osasi valita välin, mutta tallennettu
//      `durationMinutes` jäi koskemattomaksi. Tehtävällä saattoi siis
//      olla väli 01:00–02:00 ja kesto 30 yhtä aikaa, eikä
//      `validateTask` pitänyt sitä virheenä. Kumpi luku näkyi, riippui
//      siitä kuka kysyi.
//
//   2. LOMAKE. Kestokenttä himmennettiin kun molemmat ajat oli annettu,
//      ja työkaluvihje lupasi että kesto lasketaan ajoista. Laskettua
//      arvoa ei kuitenkaan kirjoitettu kenttään, joten himmennettyyn
//      kenttään jäi näkyviin paikkamerkki `placeholder="30"`.
//
// SÄÄNTÖ, JOTA NÄMÄ TESTIT VARTIOIVAT
//
//   Jos sekä alku- että loppuaika on annettu, kesto ON väli.
//   Muuten kesto on käyttäjän antama arvio.
//   Kahta näkymää samasta luvusta ei saa olla.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTask, durationOf, effectiveEndTime, validateTask }
  from '../src/domain/task.js';
import { toRow, fromRow, TASK_COLUMNS_EXTENDED } from '../src/lib/rows.js';
import { buildDayPlan } from '../src/domain/scheduler.js';
import { read } from './helpers/sources.mjs';

/** Tehtävä, jossa on vain kestoon vaikuttavat kentät. */
function task(overrides) {
  return normalizeTask({
    id: 't-1', title: 'Testi', date: '2026-09-10', ...overrides
  });
}

// =====================================================================
// VÄLI VOITTAA
// =====================================================================

test('KRIITTINEN: 01:00 -> 02:00 on 60 minuuttia', () => {
  // Tämä on se tapaus, jonka käyttäjä raportoi.
  const t = task({ time: '01:00', endTime: '02:00' });

  assert.equal(durationOf(t), 60);
  assert.equal(t.durationMinutes, 60,
    'kestokenttä ei vastaa väliä — lomake näyttäisi eri luvun kuin aikajana');
});

test('01:00 -> 01:30 on 30 minuuttia', () => {
  const t = task({ time: '01:00', endTime: '01:30' });
  assert.equal(durationOf(t), 30);
  assert.equal(t.durationMinutes, 30);
});

test('KRIITTINEN: annettu kesto ei voi olla ristiriidassa välin kanssa', () => {
  // JUURI TÄMÄ oli vika. Aiemmin tämä tehtävä sai jäädä kantaan
  // muodossa `time 01:00, endTime 02:00, durationMinutes 30`, ja
  // lomake näytti 30 samalla kun aikajana piirsi tunnin.
  const t = task({ time: '01:00', endTime: '02:00', durationMinutes: 30 });

  assert.equal(t.durationMinutes, 60,
    'ristiriitainen kesto jäi voimaan');
  assert.equal(durationOf(t), 60);
  assert.equal(durationOf(t), t.durationMinutes,
    'durationOf ja durationMinutes antavat eri vastauksen');
});

test('KRIITTINEN: loppuajan muuttaminen päivittää keston', () => {
  // Muokkauspolku: käyttäjä asettaa ensin 01:00–01:30 ja siirtää sitten
  // lopun kahteen. Jos kesto ei seuraisi mukana, se jäisi
  // kolmeenkymmeneen.
  const eka = task({ time: '01:00', endTime: '01:30' });
  assert.equal(eka.durationMinutes, 30);

  const muokattu = normalizeTask({ ...eka, endTime: '02:00' });
  assert.equal(muokattu.durationMinutes, 60,
    'kesto jäi vanhaan arvoon loppuajan muuttuessa');
  assert.equal(durationOf(muokattu), 60);
});

test('KRIITTINEN: kesto säilyy oikeana tallennuksen ja latauksen yli', () => {
  const luotu = task({ time: '01:00', endTime: '02:00' });
  const ladattu = normalizeTask(fromRow({
    ...toRow(luotu, TASK_COLUMNS_EXTENDED), user_id: 'u-1'
  }));

  assert.equal(ladattu.time, '01:00');
  assert.equal(ladattu.endTime, '02:00');
  assert.equal(ladattu.durationMinutes, 60, 'kesto muuttui kantakierroksella');
  assert.equal(durationOf(ladattu), 60);
});

test('KRIITTINEN: vanha ristiriitainen rivi korjaantuu latauksessa', () => {
  // Kannassa voi olla rivejä, jotka tallennettiin ennen korjausta:
  // väli 60 mutta duration_minutes 30. Lataus normalisoi ne, joten
  // käyttäjä ei näe vanhaa lukua enää missään.
  const ladattu = normalizeTask(fromRow({
    id: 't-vanha', date: '2026-09-10', time: '01:00', end_time: '02:00',
    title: 'Vanha', category: 'muu', completed: false, is_wake: false,
    duration_minutes: 30, user_id: 'u-1'
  }));

  assert.equal(ladattu.durationMinutes, 60,
    'vanha ristiriitainen kesto jäi voimaan latauksessa');
});

test('yön yli menevä väli 23:30 -> 00:30 on 60 minuuttia', () => {
  // Vuorokauden vaihde on tuettu: durationOf laskee kierron.
  const t = task({ time: '23:30', endTime: '00:30' });
  assert.equal(durationOf(t), 60);
  assert.equal(t.durationMinutes, 60);
});

// =====================================================================
// KUN VÄLIÄ EI OLE
// =====================================================================

test('pelkkä kesto ilman loppuaikaa säilyy arviona', () => {
  const t = task({ time: '01:00', durationMinutes: 45 });
  assert.equal(t.endTime, null);
  assert.equal(t.durationMinutes, 45, 'arvio hävisi');
  assert.equal(durationOf(t), 45);
  assert.equal(effectiveEndTime(t), '01:45', 'loppuaika ei johdu kestosta');
});

test('kesto ilman alkuaikaa säilyy arviona', () => {
  const t = task({ durationMinutes: 45 });
  assert.equal(t.time, null);
  assert.equal(t.durationMinutes, 45);
  assert.equal(durationOf(t), 45);
});

test('pelkkä alkuaika ilman loppua tai kestoa ei keksi kestoa', () => {
  const t = task({ time: '01:00' });
  assert.equal(t.durationMinutes, null);
  assert.equal(durationOf(t), null, 'kesto keksittiin tyhjästä');
});

test('loppuajan poistaminen jättää johdetun luvun arvioksi', () => {
  // Käyttäjä poistaa loppuajan. Luku ei katoa, mutta se lakkaa olemasta
  // väli ja muuttuu arvioksi — ja kenttä muuttuu muokattavaksi.
  const välillinen = task({ time: '01:00', endTime: '02:00' });
  const ilmanLoppua = normalizeTask({ ...välillinen, endTime: null });

  assert.equal(ilmanLoppua.endTime, null);
  assert.equal(ilmanLoppua.durationMinutes, 60);
  assert.equal(durationOf(ilmanLoppua), 60);
});

test('sama alku- ja loppuaika ei tuota kestoa eikä läpäise validointia', () => {
  const t = task({ time: '01:00', endTime: '01:00' });

  assert.equal(durationOf(t), null, 'nollan mittainen väli tuotti keston');
  assert.equal(t.durationMinutes, null);

  const tulos = validateTask(t);
  assert.equal(tulos.valid, false);
  assert.ok(tulos.errors.endTime, 'validointi ei huomauta samasta ajasta');
});

test('kelvoton kesto hylätään eikä muutu nollaksi', () => {
  for (const arvo of [0, -30, 'abc', null, undefined, NaN]) {
    const t = task({ durationMinutes: arvo });
    assert.equal(t.durationMinutes, null, `arvo ${String(arvo)} ei hylätty`);
  }
});

// =====================================================================
// AIKATAULUMOOTTORI KÄYTTÄÄ SAMAA LUKUA
// =====================================================================

test('KRIITTINEN: aikajana varaa saman ajan kuin lomake näyttää', () => {
  // Ristiriidan näkyvin seuraus oli, että aikajana piirsi tunnin
  // mittaisen lohkon samalla kun lomake väitti kolmeakymmentä.
  const t = task({ time: '01:00', endTime: '02:00', durationMinutes: 30 });
  const plan = buildDayPlan({ tasks: [t], profile: {}, dateIso: '2026-09-10' });
  const aikajanalla = plan.timeline.find(item => item.id === t.id);

  assert.ok(aikajanalla, 'tehtävä ei päätynyt aikajanalle');
  assert.equal(aikajanalla.durationMinutes, 60);
  assert.equal(durationOf(aikajanalla), 60);
});

// =====================================================================
// LOMAKE
// =====================================================================
//
// Lomake on DOM-koodia eikä sitä voi ajaa tässä ympäristössä ilman
// selainta. Sen sopimus tarkistetaan siksi lähdekoodista: juuri se
// puuttuva rivi — lasketun arvon kirjoittaminen kenttään — oli vian
// toinen puolisko.

test('KRIITTINEN: lomake kirjoittaa lasketun keston kenttään', () => {
  const koodi = read('src/app/views/tasks.js');

  const alku = koodi.indexOf('function syncDurationField');
  assert.ok(alku > -1, 'syncDurationField puuttuu');
  const runko = koodi.slice(alku, koodi.indexOf(NEWLINE + '}', alku));

  assert.ok(runko.includes('durationOf('),
    'kestokenttää ei johdeta välistä');
  assert.ok(/input\.value\s*=/.test(runko),
    'laskettua arvoa ei kirjoiteta kenttään — juuri tämä rivi puuttui');
  assert.ok(runko.includes('input.disabled = hasRange'),
    'kenttää ei lukita silloin kun se on johdettu');
});

test('KRIITTINEN: lomakkeen avaus synkronoi kestokentän', () => {
  // Ilman tätä kutsua avattu lomake näyttäisi vanhan arvon tai
  // paikkamerkin, vaikka väli kertoisi muuta.
  const koodi = read('src/app/views/tasks.js');
  const alku = koodi.indexOf('function fillForm');
  const runko = koodi.slice(alku, koodi.indexOf(NEWLINE + '}', alku));

  assert.ok(runko.includes('syncDurationField()'),
    'fillForm ei synkronoi kestokenttää');
});

test('KRIITTINEN: kestokentän paikkamerkki ei ole luku', () => {
  // `placeholder="30"` näkyi himmennetyssä kentässä ja luettiin
  // arvoksi. Paikkamerkki saa ehdottaa, mutta se ei saa näyttää
  // lasketulta tulokselta.
  const html = read('index.html');
  const rivi = html.split(NEWLINE).find(r => r.includes('id="afDuration"'));
  assert.ok(rivi, 'kestokenttää ei löytynyt');

  const paikkamerkki = /placeholder="([^"]*)"/.exec(rivi);
  assert.ok(paikkamerkki, 'paikkamerkki puuttuu');
  assert.equal(/^\d+$/.test(paikkamerkki[1]), false,
    `paikkamerkki "${paikkamerkki[1]}" on pelkkä luku ja voi näyttää arvolta`);
});

const NEWLINE = String.fromCharCode(10);
