// Puhuttujen muistutusten lauseet.
//
// Puhe kuuluu koko huoneeseen. Siksi testit vartioivat kolmea asiaa:
// lause on lyhyt ja luonnollista suomea, siihen ei koskaan päädy
// käyttäjän kirjoittamaa tekstiä, ja sävy vaihtuu tyylin mukaan ilman
// että sisältö (aika, minuutit) muuttuu.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  spokenPhrase, spokenTime, spokenMinutesFromNow, numberWords, wordingForStyle,
  PHRASE_KINDS, MAX_SPOKEN_LENGTH, PHRASE_REPEAT_LEAVE_NOW, DEFAULT_LEAVE_SOON_MINUTES
} from '../src/domain/spokenPhrases.js';
import { NOTIFICATION_TYPE, NOTIFICATION_TYPES } from '../src/domain/notification.js';
import { GUIDANCE_STYLE, GUIDANCE_STYLES, HABIT_KIND } from '../src/domain/dailyLife.js';
import { readCode } from './helpers/sources.mjs';

const T = NOTIFICATION_TYPE;
const FULL_CONTEXT = Object.freeze({
  minutes: 5, time: '06:05', bedtime: '23:00', wake: '06:30', firstLeave: '07:40',
  habitKind: HABIT_KIND.NICOTINE, count: 3
});

// ------------------------------------------------------------ vaaditut lauseet

test('lähtöketjun lauseet ovat täsmälleen sovitut (oletustyyli rauhallinen)', () => {
  assert.equal(spokenPhrase(T.DEPARTURE_PREPARE), 'Valmistaudu lähtöön.');
  assert.equal(spokenPhrase(T.DEPARTURE_LEAVE_IN_5, { minutes: 5 }), 'Viiden minuutin päästä pitää lähteä.');
  assert.equal(spokenPhrase(T.DEPARTURE_LEAVE_IN_5), 'Viiden minuutin päästä pitää lähteä.',
    'oletus on viisi minuuttia');
  assert.equal(DEFAULT_LEAVE_SOON_MINUTES, 5);
  assert.equal(spokenPhrase(T.DEPARTURE_LEAVE_NOW),
    'Nyt kannattaa lähteä, jotta olet hyvissä ajoin paikalla.');
});

test('ateria, tapa, uni ja illan kooste: sovitut perusmuodot', () => {
  assert.equal(spokenPhrase(T.MEAL), 'Nyt on hyvä aika aloittaa ruoan valmistus.');
  assert.equal(spokenPhrase(T.MEAL, { prep: false }), 'Nyt on hyvä aika syödä.');
  assert.equal(spokenPhrase(T.HABIT, { habitKind: HABIT_KIND.NICOTINE }),
    'Seuraava suunniteltu nikotiiniaika on nyt.');
  assert.equal(spokenPhrase(T.HABIT, { habitKind: HABIT_KIND.GENERIC }), 'Seuraava suunniteltu aika on nyt.');
  assert.equal(spokenPhrase(T.HABIT), 'Seuraava suunniteltu aika on nyt.',
    'tuntematon tapa ei paljasta nikotiinia');
  assert.equal(spokenPhrase(T.WIND_DOWN), 'On hyvä hetki alkaa rauhoittua illaksi.');
  assert.equal(spokenPhrase(T.BEDTIME), 'Nyt on hyvä aika mennä nukkumaan.');
  assert.equal(spokenPhrase(T.EVENING_BEFORE, { firstLeave: '07:40' }),
    'Huomenna ensimmäinen lähtö on kello 7.40.');
  assert.equal(spokenPhrase(T.EVENING_BEFORE, { firstLeave: null }), 'Huomenna ei ole sovittuja lähtöjä.');
  assert.equal(spokenPhrase(T.MORNING_BRIEF, { firstLeave: '08:15' }),
    'Hyvää huomenta. Tänään ensimmäinen lähtö on kello 8.15.');
});

// ------------------------------------------------------------ luvut

test('kellonaika sanotaan suomalaisittain: piste, ei etunollaa', () => {
  assert.equal(spokenTime('06:05'), '6.05');
  assert.equal(spokenTime('00:30'), '0.30');
  assert.equal(spokenTime('23:00'), '23.00');
  assert.equal(spokenTime('12:59'), '12.59');
  for (const bad of ['6:05', '24:00', '12:60', '', null, undefined, 605, '06.05', ' 06:05']) {
    assert.equal(spokenTime(bad), null, String(bad));
  }
});

test('luvut sanoina perusmuodossa ja genetiivissä', () => {
  const nominative = { 0: 'nolla', 1: 'yksi', 5: 'viisi', 10: 'kymmenen', 11: 'yksitoista', 15: 'viisitoista',
    20: 'kaksikymmentä', 25: 'kaksikymmentäviisi', 99: 'yhdeksänkymmentäyhdeksän' };
  const genitive = { 1: 'yhden', 2: 'kahden', 5: 'viiden', 7: 'seitsemän', 10: 'kymmenen', 11: 'yhdentoista',
    12: 'kahdentoista', 20: 'kahdenkymmenen', 25: 'kahdenkymmenenviiden', 30: 'kolmenkymmenen',
    45: 'neljänkymmenenviiden' };
  for (const [n, word] of Object.entries(nominative)) assert.equal(numberWords(Number(n)), word, n);
  for (const [n, word] of Object.entries(genitive)) assert.equal(numberWords(Number(n), 'genitive'), word, n);
  assert.equal(numberWords(120), '120', 'yli 99: numeroina');
  for (const bad of [-1, 1.5, NaN, '5', null]) assert.equal(numberWords(bad), null, String(bad));
});

test('minuutit luonnollisesti: "minuutin päästä", "viiden minuutin päästä"', () => {
  assert.equal(spokenMinutesFromNow(1), 'minuutin päästä');
  assert.equal(spokenMinutesFromNow(5), 'viiden minuutin päästä');
  assert.equal(spokenMinutesFromNow(15), 'viidentoista minuutin päästä');
  assert.equal(spokenMinutesFromNow(0), null, 'nolla minuuttia ei ole "päästä"');
  assert.equal(spokenMinutesFromNow(null), null, 'tuntematon ei ole nolla');
  assert.equal(spokenPhrase(T.DEPARTURE_LEAVE_IN_5, { minutes: 10 }), 'Kymmenen minuutin päästä pitää lähteä.');
  assert.equal(spokenPhrase(T.DEPARTURE_LEAVE_IN_5, { minutes: 0 }), null,
    'mahdoton minuuttimäärä: ei lausetta, ei arvausta');
});

// ------------------------------------------------------------ sävy

test('jokaisella lajilla ja tyylillä on lause, ja se mahtuu 120 merkkiin', () => {
  for (const kind of PHRASE_KINDS) {
    for (const style of GUIDANCE_STYLES) {
      for (const context of [{}, FULL_CONTEXT, { ...FULL_CONTEXT, prep: false, firstLeave: null, habitKind: null }]) {
        const text = spokenPhrase(kind, { ...context, style });
        if (kind === T.DIGEST && context.count === undefined) {
          assert.equal(text, null, 'kooste ilman määrää ei puhu');
          continue;
        }
        assert.equal(typeof text, 'string', `${kind}/${style}`);
        assert.ok(text.length > 0 && text.length <= MAX_SPOKEN_LENGTH, `${kind}/${style}: ${text.length}`);
        assert.match(text, /^[A-ZÅÄÖ]/, 'lause alkaa isolla');
        assert.match(text, /[.!]$/, 'lause päättyy välimerkkiin');
        assert.doesNotMatch(text, /\d{2}:\d{2}/, 'ei koneellista kellonaikaa');
        // Sanarajat: "Sinulla" sisältää merkkijonon "null".
        assert.doesNotMatch(text, /\bundefined\b|\bnull\b|\bNaN\b|\[object/, 'ei vuotaneita arvoja');
      }
    }
  }
});

test('tyylit eroavat sanamuodoltaan, mutta aika ja minuutit pysyvät samoina', () => {
  for (const kind of [T.DEPARTURE_PREPARE, T.DEPARTURE_LEAVE_IN_5, T.DEPARTURE_LEAVE_NOW, T.MEAL,
    T.WIND_DOWN, T.BEDTIME, T.HABIT, T.EVENING_BEFORE, T.DIGEST]) {
    const texts = GUIDANCE_STYLES.map(style => spokenPhrase(kind, { ...FULL_CONTEXT, style }));
    assert.equal(new Set(texts).size, 3, `${kind}: tyylit eivät eroa: ${texts.join(' | ')}`);
  }
  const brisk = spokenPhrase(T.DEPARTURE_LEAVE_IN_5, { style: GUIDANCE_STYLE.BRISK, minutes: 5 });
  const active = spokenPhrase(T.DEPARTURE_LEAVE_IN_5, { style: GUIDANCE_STYLE.ACTIVE, minutes: 5 });
  assert.match(brisk, /viiden minuutin/);
  assert.match(active, /Viiden minuutin/);
  assert.ok(brisk.length < active.length, 'napakka on lyhyempi kuin aktiivinen');
  for (const style of GUIDANCE_STYLES) {
    const evening = spokenPhrase(T.EVENING_BEFORE, { style, firstLeave: '07:40' });
    assert.match(evening, /7\.40/, `${style}: aika säilyy`);
  }
});

test('tuntematon tyyli on rauhallinen', () => {
  assert.equal(wordingForStyle('huutava'), GUIDANCE_STYLE.CALM);
  assert.equal(wordingForStyle(undefined), GUIDANCE_STYLE.CALM);
  assert.equal(spokenPhrase(T.DEPARTURE_PREPARE, { style: 'x' }), spokenPhrase(T.DEPARTURE_PREPARE));
});

test('toisto on oma lyhyt lauseensa', () => {
  assert.equal(spokenPhrase(PHRASE_REPEAT_LEAVE_NOW), 'Muistutus: nyt on lähdön aika.');
});

test('kooste: yksikkö ja monikko oikein', () => {
  assert.equal(spokenPhrase(T.DIGEST, { count: 1 }), 'Sinulla on yksi pieni muistutus.');
  assert.equal(spokenPhrase(T.DIGEST, { count: 3 }), 'Sinulla on kolme pientä muistutusta.');
  assert.equal(spokenPhrase(T.DIGEST, { count: 21 }), 'Sinulla on kaksikymmentäyksi pientä muistutusta.');
  assert.equal(spokenPhrase(T.DIGEST, { count: 1, style: GUIDANCE_STYLE.BRISK }), 'Yksi muistutus.');
  assert.equal(spokenPhrase(T.DIGEST, { count: 0 }), null);
  assert.equal(spokenPhrase(T.DIGEST, { count: 100 }), null);
});

// ------------------------------------------------------------ yksityisyys

test('YKSITYISYYS: vapaa teksti ei koskaan päädy puheeseen', () => {
  const secret = 'Psykiatri Salainen katu 5 muistiinpano';
  const context = {
    ...FULL_CONTEXT, title: secret, placeName: secret, note: secret, name: secret, body: secret,
    time: secret, firstLeave: secret, bedtime: secret, wake: secret, habitKind: secret
  };
  for (const kind of PHRASE_KINDS) {
    for (const style of GUIDANCE_STYLES) {
      const text = spokenPhrase(kind, { ...context, style }) || '';
      for (const word of ['Psykiatri', 'Salainen', 'katu', 'muistiinpano']) {
        assert.equal(text.includes(word), false, `${kind}/${style} vuoti: ${text}`);
      }
    }
  }
});

test('YKSITYISYYS: tuntematon tapa ei kerro nikotiinista', () => {
  for (const style of GUIDANCE_STYLES) {
    assert.doesNotMatch(spokenPhrase(T.HABIT, { style, habitKind: 'generic' }), /nikotiini/i);
  }
});

test('SÄVY: ei syyllistämistä, ei käskyhuutoja, ei terveysväitteitä', () => {
  const forbidden = /epäonnist|retkahd|huono|laiska|myöhästyit|pitäisi hävetä|terveys|sairau|lääk|unettomuus|parantaa/i;
  for (const kind of PHRASE_KINDS) {
    for (const style of GUIDANCE_STYLES) {
      for (const context of [FULL_CONTEXT, { ...FULL_CONTEXT, prep: false, firstLeave: null }]) {
        const text = spokenPhrase(kind, { ...context, style });
        if (!text) continue;
        assert.doesNotMatch(text, forbidden, `${kind}/${style}: ${text}`);
        assert.equal((text.match(/!/g) || []).length <= 1, true, 'korkeintaan yksi huutomerkki');
      }
    }
  }
});

// ------------------------------------------------------------ kestävyys

test('lajit vastaavat ilmoitustyyppejä (paitsi toisto)', () => {
  for (const kind of PHRASE_KINDS) {
    if (kind === PHRASE_REPEAT_LEAVE_NOW) continue;
    assert.ok(NOTIFICATION_TYPES.includes(kind), kind);
  }
  assert.ok(Object.isFrozen(PHRASE_KINDS));
});

test('roskasyöte ei koskaan heitä', () => {
  const hostile = {};
  Object.defineProperty(hostile, 'time', { get() { throw new Error('getteri'); } });
  const inputs = [undefined, null, 0, 'x', [], {}, { style: {} }, { minutes: 'viisi' }, { minutes: 1e9 },
    { count: -1 }, { count: 1.5 }, hostile, Object.create(null)];
  for (const kind of [...PHRASE_KINDS, 'tuntematon', '', null, 42, '__proto__', 'constructor', 'toString']) {
    for (const context of inputs) {
      assert.doesNotThrow(() => spokenPhrase(kind, context), `${String(kind)}`);
    }
  }
  assert.equal(spokenPhrase('tuntematon'), null);
  assert.equal(spokenPhrase('__proto__'), null);
  assert.equal(spokenPhrase('constructor'), null);
  assert.equal(spokenPhrase(T.DEPARTURE_PREPARE, hostile), null, 'heittävä konteksti: ei lausetta');
});

test('deterministinen ja syötettä muuttamaton', () => {
  const context = { ...FULL_CONTEXT, style: GUIDANCE_STYLE.ACTIVE };
  const snapshot = JSON.stringify(context);
  const first = PHRASE_KINDS.map(kind => spokenPhrase(kind, context));
  const second = PHRASE_KINDS.map(kind => spokenPhrase(kind, context));
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(context), snapshot);
});

test('PUHTAUS: moduuli ei puhu itse eikä koske alustaan', () => {
  const source = readCode('src/domain/spokenPhrases.js');
  for (const forbidden of ['speechSynthesis', 'SpeechSynthesis', 'Capacitor', 'Date.now(', 'new Date(', 'console.']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
