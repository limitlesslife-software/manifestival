// Puheen menojäsentimen aukot (src/domain/eventParse.js), puhtaina funktioina:
//
//   1. Otsikon sana tai taivutettu paikka ("parturi", "parturiin", "työpaikalla",
//      "töissä") -> tallennettu paikka: yksi varma liitetään, epävarma
//      ehdotetaan kysymyksenä. Opittava nimitys on sanan perusmuoto.
//   2. "X tällä viikolla" ilman viikonpäivää ja kellonaikaa -> avoin asia
//      (parseOpenEndedTask), ei umpikujakysymystä.
//   3. Kellonaika ilman klo-sanaa päivän perässä ("torstaina 14-15",
//      "maanantaina 18", "perjantaina kaksitoista").

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCreateEvent, parseOpenEndedTask, EVENT_FIELD } from '../src/domain/eventParse.js';
import { resolvePlaceText } from '../src/domain/places.js';

const SAT = '2026-09-26';
const MON = '2026-09-28';

const PLACES = Object.freeze([
  Object.freeze({ id: 'p-parturi', name: 'Parturi Kallio', area: 'Kallio' }),
  Object.freeze({ id: 'home', name: 'Koti', area: 'Vallila' }),
  Object.freeze({ id: 'work', name: 'Työ' }),
  Object.freeze({ id: 'm-espoo', name: 'Motonet Espoo' }),
  Object.freeze({ id: 'm-vantaa', name: 'Motonet Vantaa' })
]);

const parse = (text, today = MON, aliases = []) =>
  parseCreateEvent(text, { todayIso: today, places: PLACES, aliases, resolvePlace: resolvePlaceText });

// ============================================================ paikka

test('otsikon sana, joka osuu osittain tallennettuun paikkaan, ehdotetaan kysymyksenä', () => {
  const result = parse('Lisää parturi ensi tiistaille klo 16');
  assert.equal(result.title, 'Parturi');
  assert.equal(result.placeId, null, 'ei hiljaista liitosta');
  const question = result.ambiguities.find(a => a.field === EVENT_FIELD.PLACE);
  assert.ok(question, 'paikasta kysytään');
  assert.deepEqual([...question.options], ['p-parturi']);
  assert.equal(question.question, 'Tarkoitatko paikkaa Parturi Kallio?');
  assert.equal(question.reason, 'suggested_place');
  assert.equal(result.placeAliasText, 'parturi', 'opittava nimitys on sanottu sana');
  assert.equal(result.placeSaid, false, 'otsikon sana ei ole sanottu sijainti');
  assert.equal(result.placeTitle, 'Parturi');
});

test('taivutettu, pienellä kirjoitettu paikka: kysymys, opittava nimitys on perusmuoto, otsikko ilman paikkaa', () => {
  const result = parse('Lisää hiustenleikkuu parturiin huomenna klo 10');
  const question = result.ambiguities.find(a => a.field === EVENT_FIELD.PLACE);
  assert.deepEqual([...question.options], ['p-parturi']);
  assert.equal(question.reason, 'ambiguous_place');
  assert.equal(result.placeAliasText, 'parturi');
  assert.equal(result.placeSaid, true);
  assert.equal(result.title, 'Hiustenleikkuu parturiin', 'otsikko ennen valintaa ennallaan');
  assert.equal(result.placeTitle, 'Hiustenleikkuu', 'otsikko, jos paikka valitaan');
});

test('kahdesti vahvistettu perusmuoto liittää kaikki taivutukset', () => {
  const aliases = [{ id: 'a1', placeId: 'p-parturi', alias: 'parturi', confirmations: 2 }];
  for (const text of ['Lisää parturi huomenna klo 10', 'Lisää hiustenleikkuu parturiin huomenna klo 10',
    'Lisää parranajo parturissa huomenna klo 10', 'Parturille huomenna klo 10']) {
    const result = parse(text, MON, aliases);
    assert.equal(result.placeId, 'p-parturi', text);
    assert.equal(result.ambiguities.length, 0, text);
  }
});

test('KRIITTINEN: "työpaikalla", "töissä", "töihin", "työhön" -> Työ; otsikosta pois', () => {
  for (const [text, title] of [
    ['palaveri huomenna klo 8 työpaikalla', 'Palaveri'],
    ['Lisää palaveri töissä huomenna klo 9', 'Palaveri'],
    ['Lisää koulutus töihin huomenna klo 12', 'Koulutus'],
    ['Lisää inventaario työhön huomenna klo 14', 'Inventaario'],
    ['Lisää vuoro työpaikalle huomenna klo 7', 'Vuoro']
  ]) {
    const result = parse(text);
    assert.equal(result.placeId, 'work', text);
    assert.equal(result.title, title, text);
    assert.equal(result.placeText === null, false, text);
    assert.deepEqual([...result.ambiguities], [], text);
  }
});

test('useampi ehdokas: kysytään kaikista', () => {
  const result = parse('Lisää renkaat motonetille huomenna klo 10');
  const question = result.ambiguities.find(a => a.field === EVENT_FIELD.PLACE);
  assert.deepEqual([...question.options].sort(), ['m-espoo', 'm-vantaa']);
  assert.equal(result.placeAliasText, 'motonet');
  assert.equal(result.placeTitle, 'Renkaat');
});

test('paikan nimi yhdyssanan osana ei ole ehdotus; tunnistamaton sija ei ole paikka', () => {
  for (const text of ['Lisää työpalaveri huomenna klo 10', 'Lisää kotisiivous huomenna klo 10',
    'Lisää työhaastattelu huomenna klo 13', 'Lisää hammaslääkäri keskustassa huomenna klo 10']) {
    const result = parse(text);
    assert.equal(result.placeId, null, text);
    assert.equal(result.ambiguities.some(a => a.field === EVENT_FIELD.PLACE), false, text);
  }
  assert.equal(parse('Lisää hammaslääkäri keskustassa huomenna klo 10').title, 'Hammaslääkäri keskustassa');
});

// ============================================================ avoin asia

test('KRIITTINEN: "tällä viikolla" ilman päivää ja aikaa ei ole meno vaan avoin asia', () => {
  const text = 'Minun pitää käydä Motonetissä tällä viikolla';
  assert.equal(parseCreateEvent(text, { todayIso: MON }), null, 'ei umpikujakysymystä menona');
  const task = parseOpenEndedTask(text, { todayIso: MON });
  assert.deepEqual({ ...task }, {
    intent: 'create_open_task', title: 'Käydä Motonetissä', deadline: '2026-10-04', weekStart: '2026-09-28', week: 'this'
  });
  assert.ok(Object.isFrozen(task));
});

test('avoin asia: ensi viikko, verbi, täytesanat ja sunnuntai', () => {
  assert.deepEqual({ ...parseOpenEndedTask('Lisää renkaanvaihto ensi viikolla', { todayIso: MON }) }, {
    intent: 'create_open_task', title: 'Renkaanvaihto', deadline: '2026-10-11', weekStart: '2026-10-05', week: 'next'
  });
  assert.equal(parseOpenEndedTask('Mun täytyy hoitaa verot tämän viikon aikana', { todayIso: MON }).title, 'Hoitaa verot');
  assert.equal(parseOpenEndedTask('Pitää soittaa äidille tällä viikolla', { todayIso: '2026-10-04' }).deadline, '2026-10-04');
});

test('avoin asia ei vie menoja, kysymyksiä, tuhoavia eikä muiden komentojen lauseita', () => {
  for (const text of ['Kokous ensi viikolla klo 10', 'Lisää kalenteriin palaveri tällä viikolla', 'Poista parturi tällä viikolla',
    'Mitä on tällä viikolla?', 'Siirrä palaveri ensi viikolle', 'Lisää tehtävä pestä auto ensi viikolla', 'Käy Motonetissä',
    'Parturi torstaina tällä viikolla', 'tällä viikolla', 'Lisää ensi viikolla']) {
    assert.equal(parseOpenEndedTask(text, { todayIso: MON }), null, text);
  }
  for (const bad of [null, 5, {}, '']) assert.equal(parseOpenEndedTask(bad, { todayIso: MON }), null);
  assert.equal(parseOpenEndedTask('Lisää renkaanvaihto ensi viikolla', { todayIso: 'eilen' }), null);
});

test('viikon päivä kysytään vaihtoehtoina, kun menolla on kellonaika', () => {
  const next = parseCreateEvent('Kokous ensi viikolla klo 10', { todayIso: SAT });
  const question = next.ambiguities.find(a => a.field === EVENT_FIELD.DATE);
  assert.deepEqual([...question.options], ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
  const thisWeek = parseCreateEvent('Palaveri tällä viikolla klo 14', { todayIso: SAT });
  assert.deepEqual([...thisWeek.ambiguities[0].options], ['2026-09-26', '2026-09-27'], 'vain jäljellä olevat päivät');
});

// ============================================================ kellonaika ilman klo-sanaa

test('kellonaika ilman klo-sanaa päivän perässä: väli, tunti ja tuntisana', () => {
  for (const [text, title, time, endTime] of [
    ['Lisää palaveri torstaina 14-15', 'Palaveri', '14:00', '15:00'],
    ['Lisää sali tiistaina 18', 'Sali', '18:00', null],
    ['lisää lounas perjantaina kaksitoista', 'Lounas', '12:00', null],
    ['Lisää sali huomenna 18.', 'Sali', '18:00', null],
    ['Lisää sali huomenna 18 kestää tunnin', 'Sali', '18:00', '19:00'],
    ['Lisää lenkki huomenna 7 aamulla', 'Lenkki', '07:00', null]
  ]) {
    const result = parseCreateEvent(text, { todayIso: MON });
    assert.equal(result.title, title, text);
    assert.equal(result.time, time, text);
    assert.equal(result.endTime, endTime, text);
    assert.deepEqual([...result.ambiguities], [], text);
  }
});

test('kellonaika ilman klo-sanaa: 1-11 kysytään (klo 7 vai 19), muu luku ei ole kellonaika', () => {
  const seven = parseCreateEvent('Lisää teatteri lauantaina seitsemän', { todayIso: MON });
  assert.deepEqual([...seven.ambiguities[0].options], ['07:00', '19:00']);
  assert.equal(seven.title, 'Teatteri');
  const digit = parseCreateEvent('Lisää sali torstaina 7', { todayIso: MON });
  assert.deepEqual([...digit.ambiguities[0].options], ['07:00', '19:00']);
  const range = parseCreateEvent('Lisää palaveri torstaina 9-10', { todayIso: MON });
  assert.equal(range.durationMinutes, 60);
  assert.deepEqual([...range.ambiguities[0].options], ['09:00', '21:00']);

  for (const text of ['Lisää juhlat lauantaina 18 hengelle', 'Lisää kokous huomenna 2 tuntia', 'Lisää sali maanantaina 25',
    'Lisää palaveri 18 huomenna']) {
    const result = parseCreateEvent(text, { todayIso: MON });
    assert.equal(result.time, null, text);
    assert.equal(result.ambiguities.some(a => a.field === EVENT_FIELD.TIME), false, text);
  }
});
