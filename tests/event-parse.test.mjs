// Kalenteritapahtuman luonti puheesta ilman mallia (src/domain/eventParse.js).
//
// Pääperiaate: vain tarpeellinen kysymys, ei koskaan hiljaista arvausta.
// Tärkeä kenttä (päivä, kellonaika, sanottu paikka) on joko selvä tai
// siitä kysytään. Tuhoava lause ei ole koskaan tapahtuma.
//
// Perusviikko: lauantai 2026-09-26 (sama päivä, jona omistaja kokeili
// "Teatteri lauantaina seitsemältä").

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readCode, importsOf } from './helpers/sources.mjs';
import { helsinkiOffset } from './helpers/helsinkiOffset.mjs';
import {
  parseCreateEvent, CREATE_EVENT_INTENT, EVENT_PARSE_CONFIDENCE, EVENT_FIELD, MAX_EVENT_COMMAND_LENGTH
} from '../src/domain/eventParse.js';
import { resolvePlaceText } from '../src/domain/places.js';

const SAT = '2026-09-26';
const MON = '2026-09-28';

const PLACES = Object.freeze([
  Object.freeze({ id: 'p-parturi', name: 'Parturi Kallio', area: 'Kallio' }),
  Object.freeze({ id: 'p-motonet', name: 'Motonet', area: 'Tammisto' }),
  Object.freeze({ id: 'p-hammas', name: 'Hyvä Hammas', area: 'Kamppi' }),
  Object.freeze({ id: 'p-teatteri', name: 'Kaupunginteatteri', area: 'Kallio' }),
  Object.freeze({ id: 'p-teatteri2', name: 'Teatteri Jurkka', area: 'Keskusta' })
]);
const ALIASES = Object.freeze([
  Object.freeze({ id: 'a1', placeId: 'p-parturi', alias: 'parturi', confirmations: 3 })
]);

const parse = (text, today = SAT, extra = {}) => parseCreateEvent(text, { todayIso: today, ...extra });
const withPlaces = (text, today = SAT) =>
  parse(text, today, { places: PLACES, aliases: ALIASES, resolvePlace: resolvePlaceText });

function assertDeepFrozen(value, path = 'tulos') {
  if (value && typeof value === 'object') {
    assert.ok(Object.isFrozen(value), `${path} ei ole jäädytetty`);
    for (const key of Object.keys(value)) assertDeepFrozen(value[key], `${path}.${key}`);
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// ============================================================ esimerkit

test('"Lisää parturi ensi tiistaille klo 16" -> Parturi, ensi tiistai, 16.00', () => {
  const result = parse('Lisää parturi ensi tiistaille klo 16');
  assert.equal(result.intent, CREATE_EVENT_INTENT);
  assert.equal(result.title, 'Parturi');
  assert.equal(result.date, '2026-09-29');
  assert.equal(result.time, '16:00');
  assert.deepEqual([...result.missing], []);
  assert.deepEqual([...result.ambiguities], []);
  assert.equal(result.confidence, EVENT_PARSE_CONFIDENCE.HIGH);
  assert.equal(result.placeMatch, null, 'ilman tunnistinta paikkaa ei arvata');
});

test('KRIITTINEN: "Teatteri lauantaina seitsemältä" kysyy: klo 7 vai klo 19?', () => {
  // Maanantaina lauantai on selvä: vain kellonaika kysytään (vain tarpeellinen kysymys).
  const monday = parse('Teatteri lauantaina seitsemältä', MON);
  assert.equal(monday.title, 'Teatteri');
  assert.equal(monday.date, '2026-10-03');
  assert.equal(monday.time, null);
  assert.equal(monday.ambiguities.length, 1);
  assert.deepEqual({ ...monday.ambiguities[0], options: [...monday.ambiguities[0].options] }, {
    field: EVENT_FIELD.TIME, options: ['07:00', '19:00'], question: 'Tarkoitatko klo 7 vai klo 19?', reason: 'ambiguous_hour_word'
  });
  assert.deepEqual([...monday.missing], [], 'kysytty kenttä ei ole "puuttuva"');
  assert.equal(monday.confidence, EVENT_PARSE_CONFIDENCE.LOW);

  // Lauantaina myös päivä on kaksitulkintainen: tänään vai viikon päästä.
  const saturday = parse('Teatteri lauantaina seitsemältä', SAT);
  assert.equal(saturday.date, null);
  assert.deepEqual(saturday.ambiguities.map(a => a.field), ['date', 'time']);
  assert.deepEqual([...saturday.ambiguities[0].options], ['2026-09-26', '2026-10-03']);
  assert.equal(saturday.ambiguities[0].question, 'Tarkoitatko tänään (la 26.9.) vai viikon päästä (la 3.10.)?');

  // Vuorokaudenaika ratkaisee: ei kysymystä.
  const evening = parse('Teatteri lauantaina illalla seitsemältä', MON);
  assert.equal(evening.time, '19:00');
  assert.deepEqual([...evening.ambiguities], []);
});

test('"Hammaslääkäri huomenna 9.30 kestää tunnin" -> 9.30-10.30', () => {
  const result = parse('Hammaslääkäri huomenna 9.30 kestää tunnin');
  assert.equal(result.title, 'Hammaslääkäri');
  assert.equal(result.date, '2026-09-27');
  assert.equal(result.time, '09:30');
  assert.equal(result.durationMinutes, 60);
  assert.equal(result.endTime, '10:30');
  assert.deepEqual([...result.ambiguities], []);
  assert.equal(result.confidence, EVENT_PARSE_CONFIDENCE.MEDIUM, 'ilman luontiverbiä varmuus on keskitaso');
});

// ============================================================ ei hiljaista arvausta

test('KRIITTINEN: puuttuva päivä tai aika ei täyty itsestään', () => {
  const noDate = parse('Lisää kalenteriin hammaslääkäri klo 9');
  assert.equal(noDate.date, null, 'ei oletusta tälle päivälle');
  assert.deepEqual([...noDate.missing], ['date']);
  const noTime = parse('Lisää parturi ensi tiistaille');
  assert.equal(noTime.time, null);
  assert.deepEqual([...noTime.missing], ['time']);
  const neither = parse('Lisää kalenteriin parturi');
  assert.deepEqual([...neither.missing], ['date', 'time']);
  const noTitle = parse('Lisää huomenna klo 16');
  assert.equal(noTitle.title, null);
  assert.deepEqual([...noTitle.missing], ['title']);
  assert.equal(noTitle.confidence, EVENT_PARSE_CONFIDENCE.LOW);
});

test('KRIITTINEN: epäselvä tunti kysytään, ei arvata', () => {
  for (const [text, options] of [
    ['Lisää sali huomenna klo 5', ['05:00', '17:00']], ['Lisää palaveri huomenna kello kahdeksalta', ['08:00', '20:00']],
    ['Lisää juhlat lauantaina klo seitsemän', ['07:00', '19:00']], ['Kokous huomenna 5.30', ['05:30', '17:30']]
  ]) {
    const result = parse(text, MON);
    assert.equal(result.time, null, text);
    const question = result.ambiguities.find(a => a.field === 'time');
    assert.deepEqual([...question.options], options, text);
    assert.match(question.question, /^Tarkoitatko klo \S+ vai klo \S+\?$/, text);
  }
});

test('ristiriitainen tai mahdoton kellonaika kysytään ilman vaihtoehtoja', () => {
  const conflict = parse('Lisää lenkki huomenna aamulla klo 15');
  assert.equal(conflict.time, null);
  assert.deepEqual([...conflict.ambiguities[0].options], []);
  assert.match(conflict.ambiguities[0].question, /vuorokaudenaika/);
  const invalid = parse('Lisää lenkki huomenna klo 25');
  assert.equal(invalid.time, null);
  assert.match(invalid.ambiguities[0].question, /ei ole kelvollinen/);
});

test('kaksi eri aikaa kysytään; sama aika kahdesti ja "klo 19 eli seitsemältä" ovat yksi', () => {
  const two = parse('Palaveri huomenna klo 8 ja klo 9');
  assert.deepEqual([...two.ambiguities[0].options], ['08:00', '09:00']);
  assert.equal(two.ambiguities[0].question, 'Mihin aikaan tapahtuma alkaa: klo 8 vai klo 9?');
  assert.equal(parse('Palaveri huomenna klo 8, siis klo 8').time, '08:00');
  const same = parse('Teatteri huomenna klo 19 eli seitsemältä');
  assert.equal(same.time, '19:00');
  assert.deepEqual([...same.ambiguities], []);
});

// ============================================================ päivät

test('päivän epäselvyydet: viikonloppu, ensi viikko, kaksi päivää, mennyt päivä, mahdoton päivä', () => {
  const weekend = parse('Siivous viikonloppuna klo 12', MON);
  assert.deepEqual([...weekend.ambiguities[0].options], ['2026-10-03', '2026-10-04']);
  assert.equal(weekend.ambiguities[0].question, 'Kumpana päivänä: la 3.10. vai su 4.10.?');

  const weekendSat = parse('Siivous viikonloppuna klo 12', SAT);
  assert.deepEqual([...weekendSat.ambiguities[0].options], ['2026-09-26', '2026-09-27']);

  const weekOnly = parse('Kokous ensi viikolla klo 10');
  assert.equal(weekOnly.date, null);
  assert.equal(weekOnly.ambiguities[0].question, 'Minä päivänä ensi viikolla?');
  assert.equal(weekOnly.time, '10:00', 'selvä kellonaika säilyy');

  const two = parse('Palaveri huomenna tai ylihuomenna klo 10');
  assert.deepEqual([...two.ambiguities[0].options], ['2026-09-27', '2026-09-28']);

  const past = parse('Juhlat 1.1.2020 klo 18');
  assert.equal(past.date, null);
  assert.deepEqual([...past.ambiguities[0].options], ['2020-01-01']);
  assert.equal(past.ambiguities[0].question, 'Päivä ke 1.1.2020 on jo mennyt. Lisätäänkö silti?');

  const impossible = parse('Juhlat 31.2. klo 18');
  assert.equal(impossible.date, null);
  assert.equal(impossible.ambiguities[0].field, 'date');

  const pastThisWeek = parse('Palaveri tämän viikon maanantaina klo 10', '2026-09-30');
  assert.deepEqual([...pastThisWeek.ambiguities[0].options], ['2026-10-05']);
});

test('päivät kuukauden, vuoden ja karkauspäivän vaihteessa', () => {
  assert.equal(parse('Juhlat huomenna klo 18', '2026-12-31').date, '2027-01-01');
  assert.equal(parse('Juhlat 2.1. klo 18', '2026-12-30').date, '2027-01-02');
  assert.equal(parse('Juhlat huomenna klo 18', '2028-02-28').date, '2028-02-29');
  assert.equal(parse('Palaveri ensi maanantaina klo 9', '2026-12-29').date, '2027-01-04');
});

test('"huomisen palaveri" nimeää päivän, kun muuta päivää ei ole', () => {
  const result = parse('Lisää huomisen palaveri klo 10');
  assert.equal(result.date, '2026-09-27');
  assert.equal(result.title, 'Palaveri');
});

// ============================================================ välit ja kestot

test('kellonaikavälit: klo 16-17, 16.00–17.30, klo 9.30-11, yli keskiyön', () => {
  for (const [text, time, endTime, duration] of [
    ['Lisää palaveri huomenna klo 16-17', '16:00', '17:00', 60],
    ['Lisää palaveri huomenna 16.00–17.30', '16:00', '17:30', 90],
    ['Lisää palaveri huomenna klo 9.30-11', '09:30', '11:00', 90],
    ['Lisää juhlat huomenna klo 22-01', '22:00', '01:00', 180],
    ['Lisää hammaslääkäri torstaina klo 7-9 illalla', '19:00', '21:00', 120],
    ['Lisää palaveri huomenna klo 16 - 17', '16:00', '17:00', 60]
  ]) {
    const result = parse(text, MON);
    assert.equal(result.time, time, text);
    assert.equal(result.endTime, endTime, text);
    assert.equal(result.durationMinutes, duration, text);
    assert.deepEqual([...result.ambiguities], [], text);
  }
});

test('välin alku epäselvä: kesto tiedetään, loppu ja alku kysytään', () => {
  const result = parse('Lisää sali huomenna klo 5-7');
  assert.equal(result.time, null);
  assert.equal(result.endTime, null);
  assert.equal(result.durationMinutes, 120);
  assert.deepEqual([...result.ambiguities[0].options], ['05:00', '17:00']);
  // Numero 7 on vanhan säännön mukaan aamu: väli on selvä.
  assert.equal(parse('Lisää sali huomenna klo 7-9').endTime, '09:00');
});

test('sanottu paikka, jonka nimi sopii osittain: kysytään nimellä', () => {
  const result = withPlaces('Tarkastus Hammas-klinikalla huomenna klo 10');
  const direct = withPlaces('Palaveri Hammassa huomenna klo 10');
  for (const r of [result, direct]) assert.equal(r.placeId, null);
  const question = direct.ambiguities.find(a => a.field === EVENT_FIELD.PLACE);
  assert.ok(question);
  assert.deepEqual([...question.options], ['p-hammas']);
  assert.equal(question.question, 'Tarkoitatko paikkaa Hyvä Hammas?');
});

test('ISO-päivä ei ole kellonaikaväli', () => {
  const result = parse('Lisää juhlat 2026-10-10 klo 18');
  assert.equal(result.date, '2026-10-10');
  assert.equal(result.time, '18:00');
  assert.equal(result.endTime, null);
});

test('kestot: kestää puoli tuntia, 1,5 tuntia, "45 min", ristiriita välin kanssa kysytään', () => {
  assert.equal(parse('Lisää tapaaminen huomenna klo 10 kestää puoli tuntia').endTime, '10:30');
  assert.equal(parse('Lisää elokuva huomenna klo 18 kesto 1,5 tuntia').endTime, '19:30');
  const run = parse('Lenkki huomenna klo 7 45 min');
  assert.equal(run.durationMinutes, 45);
  assert.equal(run.endTime, '07:45');
  const conflict = parse('Lisää palaveri huomenna klo 16-17 kestää 2 tuntia');
  assert.equal(conflict.durationMinutes, null);
  assert.equal(conflict.endTime, null);
  assert.deepEqual([...conflict.ambiguities[0].options], [60, 120]);
  assert.equal(conflict.ambiguities[0].question, 'Kuinka kauan tapahtuma kestää: 1 h vai 2 h?');
});

test('epämääräinen kesto jää auki ilman kysymystä; "tunnin päästä" ei ole kesto', () => {
  const vague = parse('Lisää talkoot lauantaina klo 10 kestää pari tuntia', MON);
  assert.equal(vague.durationMinutes, null);
  assert.deepEqual([...vague.ambiguities], []);
  assert.ok(vague.notes.some(note => /Kesto/.test(note)));

  assert.equal(parse('Palaveri tunnin päästä'), null, 'ilman ajankohtaa ei tapahtumaa');
  const relative = parse('Lisää palaveri tänään tunnin päästä');
  assert.equal(relative.durationMinutes, null);
  assert.equal(relative.time, null);
  assert.deepEqual([...relative.missing], ['time']);
  assert.equal(relative.title, 'Palaveri');
  assert.ok(relative.notes.some(note => /tunnin päästä/.test(note)));
});

test('koko päivän tapahtuma ei kaipaa kellonaikaa', () => {
  const result = parse('Mökki lauantaina koko päivän', MON);
  assert.equal(result.allDay, true);
  assert.equal(result.title, 'Mökki');
  assert.deepEqual([...result.missing], []);
});

// ============================================================ otsikko

test('otsikko: täytesanat pois, sisäiset sanat ja kirjoitusasu säilyvät', () => {
  for (const [text, title] of [
    ['Mulla on hammaslääkäri huomenna klo 9', 'Hammaslääkäri'],
    ['Lisää Matin ja Liisan häät lauantaille klo 15', 'Matin ja Liisan häät'],
    ['Lisää kalenteriin iPhone-huolto huomenna klo 12', 'IPhone-huolto'],
    ['Merkitse kalenteriin Kela-asiointi huomenna klo 10', 'Kela-asiointi'],
    ['lisää uusi tapahtuma joogatunti huomenna illalla klo 6', 'Joogatunti']
  ]) {
    const result = parse(text, MON);
    assert.equal(result.title, title, text);
  }
});

test('ilman verbiä pitkä lause ei ole tapahtuma', () => {
  assert.equal(parse('Minä ajattelin että voisimme ehkä mennä sinne jonnekin huomenna klo 10'), null);
});

// ============================================================ paikka

test('paikka: otsikko on opittu paikka -> liitetään varmasti', () => {
  const result = withPlaces('Lisää parturi ensi tiistaille klo 16');
  assert.equal(result.placeMatch.status, 'learned');
  assert.equal(result.placeId, 'p-parturi');
  assert.equal(result.title, 'Parturi');
  assert.deepEqual([...result.ambiguities], []);
});

test('paikka: sijamuoto ("Motonetilla") on sanottu paikka, joka ei kuulu otsikkoon', () => {
  const result = withPlaces('Renkaat Motonetilla torstaina klo 12', MON);
  assert.equal(result.title, 'Renkaat');
  assert.equal(result.placeText, 'Motonetilla');
  assert.equal(result.placeId, 'p-motonet');
  const lower = withPlaces('Lisää renkaanvaihto motonetille torstaina klo 12', MON);
  assert.equal(lower.placeId, 'p-motonet', 'pieni alkukirjain, mutta varma tallennettu paikka');
  assert.equal(lower.title, 'Renkaanvaihto');
  const only = withPlaces('Lisää Motonetille torstaina klo 12', MON);
  assert.equal(only.title, 'Motonet', 'pelkkä paikka otsikkona: paikan nimi');
});

test('KRIITTINEN: sanottu mutta epävarma paikka kysytään, ei arvata', () => {
  const result = withPlaces('Esitys Teatterissa lauantaina klo 19', MON);
  assert.equal(result.placeId, null);
  assert.equal(result.placeText, 'Teatterissa');
  const question = result.ambiguities.find(a => a.field === EVENT_FIELD.PLACE);
  assert.ok(question, 'kysymys paikasta');
  assert.deepEqual([...question.options].sort(), ['p-teatteri', 'p-teatteri2']);
  assert.match(question.question, /^Mikä paikka: /);
});

test('paikka, jota ei ole tallennettu: teksti talteen, ei kysymystä eikä arvausta', () => {
  const result = withPlaces('Palaveri Kampissa huomenna klo 10');
  assert.equal(result.placeText, 'Kampissa');
  assert.equal(result.placeId, null);
  assert.equal(result.placeMatch.status, 'none', 'alueen perusteella ei ehdoteta toista paikkaa');
  assert.deepEqual([...result.ambiguities], []);
  assert.equal(result.title, 'Palaveri Kampissa', 'tunnistamaton sija jää otsikkoon');
});

test('ilman tunnistinta: sanottu paikka talteen, placeMatch null, otsikko ehjä', () => {
  const result = parse('Palaveri Kampissa huomenna klo 10');
  assert.equal(result.placeText, 'Kampissa');
  assert.equal(result.placeMatch, null);
  assert.equal(result.placeId, null);
  assert.equal(result.title, 'Palaveri Kampissa');
});

test('henkilön nimi sijamuodossa ei katoa otsikosta ("Liisalle")', () => {
  const result = withPlaces('Lisää Liisalle synttärilahja huomenna klo 17');
  assert.equal(result.title, 'Liisalle synttärilahja');
  assert.equal(result.placeId, null);
  assert.deepEqual([...result.ambiguities], []);
});

test('tunnistin saa paikat ja opitut nimet; heittävä tai outo tunnistin ei kaada', () => {
  const seen = [];
  const spy = (text, context) => {
    seen.push(context);
    return { status: 'none', place: null, candidates: [], confidence: 'none', reason: '' };
  };
  parse('Lisää parturi huomenna klo 10', SAT, { places: PLACES, aliases: ALIASES, resolvePlace: spy });
  assert.ok(seen.length > 0);
  assert.equal(seen[0].places, PLACES);
  assert.equal(seen[0].aliases, ALIASES);

  for (const resolvePlace of [
    () => { throw new Error('boom'); }, () => null, () => 5, () => ({ status: 7 }),
    () => ({ status: 'exact', place: { id: 5 } }), () => ({ status: 'ambiguous', candidates: 'x' })
  ]) {
    assert.doesNotThrow(() => parse('Lisää parturi Kampissa huomenna klo 10', SAT, { resolvePlace }));
    const result = parse('Lisää parturi Kampissa huomenna klo 10', SAT, { resolvePlace });
    assert.equal(result.date, '2026-09-27');
    assert.equal(result.placeId, null);
  }
});

// ============================================================ kesäaika

test('KRIITTINEN: kevään vaihtoyön olematon aika kysytään (ei hiljaista siirtoa)', () => {
  const result = parse('Lisää lento huomenna yöllä klo 3.30', '2026-03-28', { offsetMinutesFn: helsinkiOffset });
  assert.equal(result.date, '2026-03-29');
  assert.equal(result.time, null);
  const question = result.ambiguities[0];
  assert.equal(question.reason, 'dst_gap');
  assert.deepEqual([...question.options], ['04:00']);
  assert.equal(question.question, 'Kello 3.30 jää sinä yönä pois, kun kellot siirtyvät eteenpäin. Sopiiko klo 4?');
});

test('syksyn vaihtoyön toistuva tunti kysytään; muut ajat vaihtopäivinä ovat selviä', () => {
  const repeat = parse('Lisää lento huomenna yöllä klo 3.30', '2026-10-24', { offsetMinutesFn: helsinkiOffset });
  assert.equal(repeat.time, null);
  assert.equal(repeat.ambiguities[0].reason, 'dst_repeat');
  for (const today of ['2026-03-28', '2026-10-24']) {
    const normal = parse('Lisää palaveri huomenna klo 10', today, { offsetMinutesFn: helsinkiOffset });
    assert.equal(normal.time, '10:00', today);
    assert.deepEqual([...normal.ambiguities], [], today);
  }
  // Ilman aikavyöhykefunktiota ei tarkisteta eikä arvata.
  assert.equal(parse('Lisää lento huomenna yöllä klo 3.30', '2026-03-28').time, '03:30');
  const throwing = parse('Lisää lento huomenna yöllä klo 3.30', '2026-03-28', { offsetMinutesFn: () => { throw new Error('x'); } });
  assert.equal(throwing.time, '03:30');
});

// ============================================================ ei tapahtuma

test('KRIITTINEN: tuhoava lause ei ole koskaan tapahtuma', () => {
  for (const text of ['Poista parturi huomenna klo 16', 'Peru teatteri lauantaina', 'Peruuta hammaslääkäri huomenna klo 9',
    'Lisää ja poista palaveri huomenna klo 10', 'Tyhjennä huominen kalenteri', 'Kumoa lisäys huomenna klo 8']) {
    assert.equal(parse(text), null, text);
  }
});

test('muut komennot, kysymykset ja keskeytykset eivät ole tapahtumia', () => {
  for (const text of ['Siirrä parturi perjantaille', 'Muistuta huomenna klo 8 soittamaan', 'Lisää tehtävä pestä auto huomenna',
    'Näytä huominen', 'Olen 10 min myöhässä', 'Milloin on hammaslääkäri?', 'Merkitse auton pesu tehdyksi huomenna',
    'Siirrä loput huomiselle', 'Osta maitoa', 'Lisää maito kauppalistaan', 'Lisää parturi', 'Lisää projekti huomenna',
    'Mitä huomenna klo 10?', 'Huomenna klo 8', 'En ehdi lenkille nyt', 'Etsi parturi huomenna']) {
    assert.equal(parse(text), null, text);
  }
});

// ============================================================ laatu

test('tulos on syvästi jäädytetty ja deterministinen', () => {
  const text = 'Lisää parturi ensi tiistaille klo 16-17';
  const first = withPlaces(text);
  assertDeepFrozen(first);
  assertDeepFrozen(withPlaces('Teatteri lauantaina seitsemältä'));
  const json = JSON.stringify(first);
  for (let i = 0; i < 100; i += 1) assert.equal(JSON.stringify(withPlaces(text)), json);
});

test('syötteitä ei muuteta: jäädytetyt paikat, opitut nimet ja asetukset kelpaavat', () => {
  const places = deepFreeze(JSON.parse(JSON.stringify(PLACES)));
  const aliases = deepFreeze(JSON.parse(JSON.stringify(ALIASES)));
  const options = deepFreeze({ todayIso: SAT, places, aliases, resolvePlace: resolvePlaceText });
  const before = JSON.stringify({ places, aliases });
  assert.doesNotThrow(() => parseCreateEvent('Lisää parturi Motonetilla ensi tiistaille klo 16', options));
  assert.equal(JSON.stringify({ places, aliases }), before);
});

test('järjestys ei vaikuta: sekoitetut paikat antavat saman tuloksen', () => {
  const text = 'Esitys Teatterissa lauantaina klo 19';
  const base = JSON.stringify(parse(text, MON, { places: PLACES, aliases: ALIASES, resolvePlace: resolvePlaceText }));
  const shuffled = [PLACES[3], PLACES[0], PLACES[4], PLACES[2], PLACES[1]];
  assert.equal(JSON.stringify(parse(text, MON, { places: shuffled, aliases: ALIASES, resolvePlace: resolvePlaceText })), base);
});

test('roskasyöte ei koskaan kaada', () => {
  const texts = [null, undefined, 0, NaN, true, {}, [], () => 1, Symbol('s'), '', '   ', '?', '🎉🎉', '\u0000klo 8',
    'klo', 'klo klo klo', '---', '1-2-3-4', '99.99', 'lisää', 'Lisää 🎉 huomenna klo 8', '31.31.3131 klo 99'];
  for (const text of texts) {
    for (const options of [undefined, null, 5, 'x', [], {}, { todayIso: SAT }, { todayIso: '2026-02-30' },
      { todayIso: SAT, places: 'x', aliases: 5, resolvePlace: 'nope', offsetMinutesFn: 7 }]) {
      assert.doesNotThrow(() => parseCreateEvent(text, options), `${String(text)} / ${JSON.stringify(options)}`);
    }
  }
  assert.equal(parseCreateEvent('Lisää parturi huomenna klo 8', { todayIso: 'eilen' }), null, 'ilman tätä päivää ei arvata');
  const emoji = parse('Lisää 🎉 huomenna klo 8');
  assert.equal(emoji.title, null, 'pelkkä kuvake ei ole otsikko');
  assert.deepEqual([...emoji.missing], ['title']);
});

test('pituusraja ja suorituskyky', () => {
  assert.equal(MAX_EVENT_COMMAND_LENGTH, 300);
  assert.equal(parse('Lisää parturi huomenna klo 16 ' + 'x'.repeat(400)), null);
  const started = performance.now();
  for (const text of ['klo 8-9 '.repeat(5000), 'seitsemältä '.repeat(4000), 'ä'.repeat(40000)]) assert.equal(parse(text), null);
  for (let i = 0; i < 500; i += 1) withPlaces('Lisää parturi Motonetilla ensi tiistaille klo 16-17 kestää tunnin');
  assert.ok(performance.now() - started < 3000, `liian hidas: ${Math.round(performance.now() - started)} ms`);
});

test('PUHTAUS: ei kelloa, arpaa, DOMia, verkkoa eikä lokia; paikat tulevat parametrina', () => {
  const file = 'src/domain/eventParse.js';
  const code = readCode(file);
  for (const token of ['Date.now(', 'Math.random', 'crypto.randomUUID', 'performance.now', 'document.', 'window.',
    'localStorage', 'sessionStorage', 'fetch(', 'console.']) {
    assert.equal(code.includes(token), false, token);
  }
  assert.equal(/new Date\(\s*\)/.test(code), false);
  const imports = importsOf(file);
  for (const dependency of imports) assert.ok(dependency.startsWith('src/domain/'), dependency);
  for (const forbidden of ['src/domain/places.js', 'src/domain/savedPlace.js', 'src/domain/calendarEvent.js', 'src/domain/lifeSettings.js']) {
    assert.equal(imports.includes(forbidden), false, `${file} ei saa tuoda ${forbidden}`);
  }
});
