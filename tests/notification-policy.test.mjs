// Muistutusten toimituspolitiikka: toimitustapa, rauhoitusaika,
// ohjaustyyli, kooste, kuittaukset ja päiväraja.
//
// Politiikka päättää, KUULUUKO muistutus ja MITEN. Virhe tässä tarkoittaa
// joko puhuvaa puhelinta keskellä yötä tai hiljaista "lähde nyt"
// -muistutusta. Siksi jokainen sääntö testataan erikseen ja koko putki
// ominaisuustesteinä.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveDelivery, topicForType, quietDecision, QUIET_DECISION, QUIET_PASS_TYPES, NIGHT_START_TYPES,
  GUIDANCE_EFFECTS, guidanceEffects, resolveGuidanceStyle, scaleLeadMinutes,
  mergeDigest, isDigestible, digestSlot, DIGEST_BYPASS_TYPES, DIGEST_MAX_TITLES,
  applyAcks, capPerDay, applyNotificationPolicy, DELIVERY_RANK,
  wallClockMinutes, wallClockAt
} from '../src/domain/notificationPolicy.js';
import {
  NOTIFICATION_TYPE, NOTIFICATION_TYPES, LEVEL, createIntent, planNotifications, isQuietTime
} from '../src/domain/notification.js';
import { buildAckLog } from '../src/domain/notificationAck.js';
import {
  DELIVERY, DELIVERIES, REMINDER_TOPIC, REMINDER_TOPICS, DEFAULT_DELIVERY, GUIDANCE_STYLE, GUIDANCE_STYLES
} from '../src/domain/dailyLife.js';
import { readCode } from './helpers/sources.mjs';

const T = NOTIFICATION_TYPE;
const DAY = '2026-09-27';
const QUIET = Object.freeze({ from: '22:00', to: '06:30' });
const T0 = Date.UTC(2026, 8, 27, 5, 0);
const MIN = 60000;

/** Testiaikomus: createIntent, oletuksena vähäinen määräaikavaroitus. */
function intent(over = {}) {
  const value = createIntent({
    type: T.DEADLINE_WARNING, level: LEVEL.REMINDER, date: DAY, time: '12:00', title: 'Asia',
    body: 'Runko', targetId: 'x', ...over
  });
  assert.ok(value, 'testiaikomus kelpaa: ' + JSON.stringify(over));
  return value;
}

/** Deterministinen sekoitus (ei Math.randomia). */
function shuffled(list, seed) {
  const out = [...list];
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// =====================================================================
// SEINÄKELLOAIKA
// =====================================================================

test('seinäkelloaika: keskiyö, kuukausi, vuosi ja karkauspäivä', () => {
  const cases = [
    ['2026-12-31', '23:58', 5, '2027-01-01', '00:03'],
    ['2026-09-30', '23:59', 1, '2026-10-01', '00:00'],
    ['2028-02-28', '23:30', 60, '2028-02-29', '00:30'],
    ['2027-02-28', '23:30', 60, '2027-03-01', '00:30'],
    ['2026-01-01', '00:02', -5, '2025-12-31', '23:57'],
    ['2026-03-29', '02:59', 1, '2026-03-29', '03:00'],
    ['2026-10-25', '03:30', 60, '2026-10-25', '04:30']
  ];
  for (const [date, time, delta, expectedDate, expectedTime] of cases) {
    const abs = wallClockMinutes(date, time);
    assert.deepEqual({ ...wallClockAt(abs + delta) }, { date: expectedDate, time: expectedTime },
      `${date} ${time} ${delta >= 0 ? '+' : ''}${delta}`);
  }
  assert.equal(wallClockMinutes('2026-02-30', '12:00'), null);
  assert.equal(wallClockMinutes(DAY, '24:00'), null);
  assert.equal(wallClockAt(1.5), null);
  // Kesäaika ei vaikuta seinäkelloon: vuorokausi on aina 1440 minuuttia.
  assert.equal(wallClockMinutes('2026-03-30', '00:00') - wallClockMinutes('2026-03-29', '00:00'), 1440);
  assert.equal(wallClockMinutes('2026-10-26', '00:00') - wallClockMinutes('2026-10-25', '00:00'), 1440);
});

// =====================================================================
// TOIMITUSTAPA
// =====================================================================

test('toimitustapa: käyttäjän valinta voittaa oletuksen', () => {
  const settings = { delivery: { departure: DELIVERY.VIBRATE }, speechEnabled: false };
  const own = resolveDelivery({ topic: REMINDER_TOPIC.DEPARTURE, level: LEVEL.ACTION, settings });
  assert.equal(own.delivery, DELIVERY.VIBRATE);
  assert.equal(own.source, 'setting');
  const fallback = resolveDelivery({ topic: REMINDER_TOPIC.MEAL, level: LEVEL.REMINDER, settings });
  assert.equal(fallback.delivery, DEFAULT_DELIVERY.meal);
  assert.equal(fallback.source, 'default');
});

test('toimitustapa: kelvoton valinta ohitetaan, oletus pätee', () => {
  for (const bad of ['huuto', 5, null, {}, ['sound']]) {
    const result = resolveDelivery({ topic: REMINDER_TOPIC.DEPARTURE, level: LEVEL.ACTION,
      settings: { delivery: { departure: bad } } });
    assert.equal(result.delivery, DEFAULT_DELIVERY.departure, String(bad));
  }
  const proto = resolveDelivery({ topic: REMINDER_TOPIC.DEPARTURE, level: LEVEL.ACTION,
    settings: { delivery: Object.create({ departure: DELIVERY.SILENT }) } });
  assert.equal(proto.delivery, DEFAULT_DELIVERY.departure, 'perityt kentät eivät ole käyttäjän valintoja');
});

test('toimitustapa: aiheeton muistutus saa tason oletuksen', () => {
  assert.equal(resolveDelivery({ level: LEVEL.INFO }).delivery, DELIVERY.SILENT);
  assert.equal(resolveDelivery({ level: LEVEL.REMINDER }).delivery, DELIVERY.VIBRATE);
  assert.equal(resolveDelivery({ level: LEVEL.ACTION }).delivery, DELIVERY.SOUND);
  assert.equal(resolveDelivery({ level: LEVEL.CRITICAL }).delivery, DELIVERY.SOUND);
  assert.equal(resolveDelivery({ level: 99 }).delivery, DELIVERY.SILENT, 'tuntematon taso on hiljaisin');
  assert.equal(resolveDelivery({ type: T.TASK_REMINDER, level: LEVEL.REMINDER }).topic, null);
});

test('taso rajaa voimakkuuden: tieto on aina hiljainen, voimistuva hälytys vain kriittiselle', () => {
  const settings = { speechEnabled: true, delivery: { deadline: DELIVERY.CRITICAL_ESCALATION } };
  const at = level => resolveDelivery({ topic: REMINDER_TOPIC.DEADLINE, level, settings }).delivery;
  assert.equal(at(LEVEL.INFO), DELIVERY.SILENT);
  assert.equal(at(LEVEL.REMINDER), DELIVERY.SOUND_AND_SPEECH);
  assert.equal(at(LEVEL.ACTION), DELIVERY.SOUND_AND_SPEECH);
  assert.equal(at(LEVEL.CRITICAL), DELIVERY.CRITICAL_ESCALATION);
});

test('PUHE VAIN LUVALLA: ilman speechEnabled puhe vaihtuu ääneksi', () => {
  for (const chosen of [DELIVERY.SPEECH, DELIVERY.SOUND_AND_SPEECH]) {
    for (const speechEnabled of [false, undefined, 'true', 1]) {
      const result = resolveDelivery({ topic: REMINDER_TOPIC.DEPARTURE, level: LEVEL.CRITICAL,
        settings: { speechEnabled, delivery: { departure: chosen } } });
      assert.equal(result.speak, false, `${chosen}/${String(speechEnabled)}`);
      assert.equal(result.delivery, DELIVERY.SOUND);
    }
    const allowed = resolveDelivery({ topic: REMINDER_TOPIC.DEPARTURE, level: LEVEL.CRITICAL,
      settings: { speechEnabled: true, delivery: { departure: chosen } } });
    assert.equal(allowed.speak, true);
    assert.equal(allowed.delivery, chosen);
  }
  const escalation = resolveDelivery({ topic: REMINDER_TOPIC.DEPARTURE, level: LEVEL.CRITICAL,
    settings: { delivery: { departure: DELIVERY.CRITICAL_ESCALATION } } });
  assert.equal(escalation.delivery, DELIVERY.CRITICAL_ESCALATION, 'hälytys säilyy');
  assert.equal(escalation.speak, false, 'mutta ei puhu ilman lupaa');
});

test('oletukset eivät koskaan puhu (puhe on aina käyttäjän oma valinta)', () => {
  for (const topic of REMINDER_TOPICS) {
    for (const level of Object.values(LEVEL)) {
      const result = resolveDelivery({ topic, level, settings: { speechEnabled: true } });
      assert.equal(result.speak, false, `${topic}/${level}`);
    }
  }
});

test('rauhoitusaika: vain kriittinen, lähtö ja aamun kooste läpäisevät', () => {
  const at = (over) => resolveDelivery({ time: '23:30', quietHours: QUIET, level: LEVEL.REMINDER, ...over });
  assert.equal(at({ level: LEVEL.CRITICAL, type: T.TASK_REMINDER }).allowed, true);
  for (const type of QUIET_PASS_TYPES) assert.equal(at({ type }).allowed, true, type);
  assert.equal(at({ topic: REMINDER_TOPIC.DEPARTURE, type: 'jokin' }).allowed, true);
  for (const type of [T.TASK_REMINDER, T.ROUTINE_REMINDER, T.MEAL, T.HABIT, T.DEADLINE_WARNING,
    T.EVENING_BEFORE, T.DAILY_PLAN, T.DIGEST]) {
    const result = at({ type, level: LEVEL.ACTION });
    assert.equal(result.allowed, false, type);
    assert.equal(result.quiet, true);
    assert.match(result.reason, /Rauhoitusaika/);
  }
  const outside = resolveDelivery({ time: '12:00', quietHours: QUIET, level: LEVEL.REMINDER, type: T.MEAL });
  assert.equal(outside.allowed, true);
  assert.equal(outside.quiet, false);
});

test('rauhoitusaika: oman yön alku (iltarauhoittuminen, nukkumaanmeno) tulee valitulla tavalla, myös puheena', () => {
  // SÄÄNTÖ (NIGHT_START_TYPES): rauhoitusaika suojaa käyttäjän yötä, ja nämä
  // kaksi aloittavat sen. Oletus 22.00–06.30 ja nukkumaan 22.30: valittu
  // "Puhe" ei saa hiljentyä.
  const settings = { speechEnabled: true, delivery: { bedtime: DELIVERY.SOUND_AND_SPEECH } };
  for (const type of [T.WIND_DOWN, T.BEDTIME]) {
    const inside = resolveDelivery({ type, level: LEVEL.REMINDER, time: '22:30', quietHours: QUIET, settings });
    assert.equal(inside.allowed, true, type);
    assert.equal(inside.quiet, true);
    assert.equal(inside.delivery, DELIVERY.SOUND_AND_SPEECH);
    assert.equal(inside.speak, true);
    assert.match(inside.reason, /oman yösi/);
    const before = resolveDelivery({ type, level: LEVEL.REMINDER, time: '21:30', quietHours: QUIET, settings });
    assert.equal(before.delivery, DELIVERY.SOUND_AND_SPEECH);
    assert.equal(before.speak, true);
    assert.equal(quietDecision({ type, topic: REMINDER_TOPIC.BEDTIME, level: 2, time: '23:00' }, QUIET),
      QUIET_DECISION.PASS);
  }
  assert.deepEqual([...NIGHT_START_TYPES], [T.WIND_DOWN, T.BEDTIME]);
  // Puhe edelleen vain luvalla: ilman lupaa ääni, ei puhetta.
  const noSpeech = resolveDelivery({ type: T.BEDTIME, level: LEVEL.REMINDER, time: '22:30', quietHours: QUIET,
    settings: { speechEnabled: false, delivery: { bedtime: DELIVERY.SPEECH } } });
  assert.equal(noSpeech.speak, false);
  // Muu nukkumaanmenon aiheen muistutus näkyy rauhoitusaikana äänettömästi.
  assert.equal(quietDecision({ type: 'jokin', topic: REMINDER_TOPIC.BEDTIME, level: 2, time: '23:00' }, QUIET),
    QUIET_DECISION.SILENT);
});

test('rauhoitusaika: rajat ja kelvottomat arvot', () => {
  const at = time => quietDecision({ type: T.MEAL, level: LEVEL.REMINDER, time }, QUIET);
  assert.equal(at('22:00'), QUIET_DECISION.DROP, 'alku kuuluu');
  assert.equal(at('06:29'), QUIET_DECISION.DROP);
  assert.equal(at('06:30'), QUIET_DECISION.PASS, 'loppu ei kuulu');
  assert.equal(at('21:59'), QUIET_DECISION.PASS);
  assert.equal(quietDecision({ type: T.MEAL, level: 2, time: '23:00' }, { from: '22:00', to: '22:00' }),
    QUIET_DECISION.PASS, 'nollan mittainen rauhoitus ei ole rauhoitus');
  assert.equal(quietDecision(null, QUIET), QUIET_DECISION.PASS);
  assert.equal(quietDecision({ time: 'x' }, QUIET), QUIET_DECISION.PASS);
});

test('aihe tyypistä: jokainen tyyppi on kartoitettu, arvot ovat tunnettuja aiheita', () => {
  for (const type of NOTIFICATION_TYPES) {
    const topic = topicForType(type);
    assert.ok(topic === null || REMINDER_TOPICS.includes(topic), `${type} -> ${topic}`);
  }
  assert.equal(topicForType(T.DEPARTURE_PREPARE), REMINDER_TOPIC.PREPARATION);
  assert.equal(topicForType(T.DEPARTURE_LEAVE_NOW), REMINDER_TOPIC.DEPARTURE);
  assert.equal(topicForType('__proto__'), null);
  assert.equal(topicForType(undefined), null);
});

test('toimitustapojen voimakkuus kattaa kaikki toimitustavat', () => {
  assert.deepEqual(Object.keys(DELIVERY_RANK).sort(), [...DELIVERIES].sort());
});

test('resolveDelivery ei heitä roskasta ja palauttaa jäädytetyn tuloksen', () => {
  const hostile = {};
  Object.defineProperty(hostile, 'delivery', { get() { throw new Error('x'); } });
  for (const input of [undefined, null, 5, 'x', [], {}, { settings: 'x' }, { settings: { delivery: 5 } },
    { level: '4' }, { quietHours: 'x', time: '23:00' }]) {
    assert.doesNotThrow(() => resolveDelivery(input));
    assert.ok(Object.isFrozen(resolveDelivery(input)));
  }
});

// =====================================================================
// OHJAUSTYYLI
// =====================================================================

test('ohjaustyyli: kolme tyyliä, tuntematon on rauhallinen', () => {
  assert.deepEqual(Object.keys(GUIDANCE_EFFECTS).sort(), [...GUIDANCE_STYLES].sort());
  assert.equal(guidanceEffects('x'), GUIDANCE_EFFECTS[GUIDANCE_STYLE.CALM]);
  assert.equal(resolveGuidanceStyle(null, { guidanceStyle: GUIDANCE_STYLE.BRISK }), GUIDANCE_STYLE.BRISK);
  assert.equal(resolveGuidanceStyle(GUIDANCE_STYLE.ACTIVE, { guidanceStyle: GUIDANCE_STYLE.BRISK }),
    GUIDANCE_STYLE.ACTIVE, 'annettu tyyli ohittaa asetuksen');
  assert.equal(resolveGuidanceStyle('x', null), GUIDANCE_STYLE.CALM);
  for (const effects of Object.values(GUIDANCE_EFFECTS)) {
    assert.ok(Object.isFrozen(effects));
    assert.ok(effects.leadMultiplier >= 1, 'tyyli ei koskaan lyhennä ennakkoa');
    assert.ok(effects.repeat >= 0 && effects.repeat <= 2, 'toistoja korkeintaan pari');
  }
  assert.equal(GUIDANCE_EFFECTS[GUIDANCE_STYLE.CALM].repeat, 0, 'rauhallinen ei toista');
});

test('TURVA: ohjaustyyli vaikuttaa vain ennakkoon, toistoon ja sanamuotoon', () => {
  const allowedKeys = ['leadMultiplier', 'repeat', 'repeatAfterMinutes', 'style', 'wording'];
  for (const effects of Object.values(GUIDANCE_EFFECTS)) {
    assert.deepEqual(Object.keys(effects).sort(), allowedKeys);
  }
  // Sama syöte eri tyyleillä: toimitustapa, puheen lupa ja rauhoitusaika pysyvät.
  const intents = [
    intent({ type: T.MEAL, targetId: 'm', time: '23:00' }),
    intent({ type: T.DEPARTURE_LEAVE_NOW, level: LEVEL.CRITICAL, targetId: 'd', time: '05:00' }),
    intent({ type: T.HABIT, targetId: 'h', time: '14:00' })
  ];
  const outcomes = GUIDANCE_STYLES.map(style => applyNotificationPolicy(intents, {
    settings: { speechEnabled: false, guidanceStyle: style }, preferences: { quietHours: QUIET }
  }).map(i => [i.id, i.time, i.delivery, i.speech]));
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.deepEqual(outcomes[0], outcomes[2]);
});

test('pehmeä ennakko: tuntematon pysyy tuntemattomana, ei koskaan lyhene', () => {
  assert.equal(scaleLeadMinutes(10, GUIDANCE_STYLE.CALM), 10);
  assert.equal(scaleLeadMinutes(10, GUIDANCE_STYLE.BRISK), 10);
  assert.equal(scaleLeadMinutes(10, GUIDANCE_STYLE.ACTIVE), 15);
  assert.equal(scaleLeadMinutes(200, GUIDANCE_STYLE.ACTIVE), 240, 'yläraja');
  assert.equal(scaleLeadMinutes(0, GUIDANCE_STYLE.ACTIVE), 0);
  assert.equal(scaleLeadMinutes(null, GUIDANCE_STYLE.ACTIVE), null, 'tuntematon ei ole nolla');
  assert.equal(scaleLeadMinutes(undefined, GUIDANCE_STYLE.ACTIVE), null);
  assert.equal(scaleLeadMinutes(-5, GUIDANCE_STYLE.ACTIVE), null);
  assert.equal(scaleLeadMinutes(300, GUIDANCE_STYLE.ACTIVE, 240), 300, 'raja ei lyhennä annettua');
});

// =====================================================================
// KOOSTE
// =====================================================================

const minor = [
  intent({ type: T.DAILY_PLAN, level: LEVEL.INFO, time: '07:30', title: 'Päivän suunnitelma', targetId: DAY }),
  intent({ type: T.DEADLINE_WARNING, level: LEVEL.REMINDER, time: '07:30', title: 'Maksa lasku', targetId: 't1',
    delivery: DELIVERY.SOUND }),
  intent({ type: T.EVENING_REVIEW, level: LEVEL.INFO, time: '21:00', title: 'Päivän katsaus', targetId: DAY,
    delivery: DELIVERY.SILENT })
];
const anchored = [
  intent({ type: T.TASK_REMINDER, level: LEVEL.REMINDER, time: '09:50', title: 'Kokous', targetId: 'k' }),
  intent({ type: T.MEAL, level: LEVEL.REMINDER, time: '16:30', title: 'Päivällinen', targetId: 'm' }),
  intent({ type: T.DEPARTURE_PREPARE, level: LEVEL.REMINDER, time: '07:40', title: 'Valmistaudu', targetId: 'd' }),
  intent({ type: T.DEPARTURE_LEAVE_NOW, level: LEVEL.CRITICAL, time: '08:15', title: 'Lähde', targetId: 'd' }),
  intent({ type: T.DEADLINE_WARNING, level: LEVEL.ACTION, time: '07:30', title: 'Tänään', targetId: 't2' })
];

test('kooste pois päältä: mitään ei yhdistetä', () => {
  const result = mergeDigest([...minor, ...anchored], { digestEnabled: false });
  assert.equal(result.length, minor.length + anchored.length);
  assert.equal(result.some(i => i.type === T.DIGEST), false);
  assert.equal(mergeDigest(minor, { digestEnabled: 'true' }).some(i => i.type === T.DIGEST), false,
    'vain arvo true kytkee koosteen');
});

test('kooste yhdistää vähäiset yhdeksi päivää kohden; hetkeen sidotut ja tärkeät ohittavat', () => {
  const result = mergeDigest([...minor, ...anchored], { digestEnabled: true, digestTime: '18:00' });
  const digests = result.filter(i => i.type === T.DIGEST);
  assert.equal(digests.length, 1);
  const [digest] = digests;
  assert.equal(digest.time, '18:00');
  assert.equal(digest.date, DAY);
  assert.equal(digest.level, LEVEL.REMINDER, 'koosteen taso on jäsenten korkein');
  assert.equal(digest.mergedCount, 3);
  assert.deepEqual([...digest.mergedIds].sort(), minor.map(i => i.id).sort());
  assert.equal(digest.delivery, DELIVERY.SOUND, 'voimakkain jäsenen toimitustapa');
  assert.match(digest.body, /^3 pientä asiaa: /);
  assert.match(digest.body, /Maksa lasku/);
  for (const kept of anchored) assert.ok(result.some(i => i.id === kept.id), kept.type + ' ohitti koosteen');
  for (const merged of minor) assert.equal(result.some(i => i.id === merged.id), false);
  assert.ok(Object.isFrozen(result) && result.every(Object.isFrozen));
  assert.ok(Object.isFrozen(digest.mergedIds));
});

test('kooste: jokainen päivä saa omansa', () => {
  const tomorrow = intent({ type: T.DAILY_PLAN, level: LEVEL.INFO, date: '2026-09-28', targetId: '2026-09-28' });
  const result = mergeDigest([...minor, tomorrow], { digestEnabled: true });
  assert.deepEqual(result.filter(i => i.type === T.DIGEST).map(i => i.date), [DAY, '2026-09-28']);
});

test('kooste ei koskaan osu rauhoitusaikaan', () => {
  assert.equal(digestSlot('23:00', QUIET), '21:59');
  assert.equal(digestSlot('18:00', QUIET), '18:00');
  assert.equal(digestSlot('03:00', { from: '00:00', to: '06:00' }), '06:00', 'keskiyöstä alkava: rauhoituksen loppuun');
  assert.equal(digestSlot('x', null), '18:00', 'kelvoton aika: oletus');
  const result = mergeDigest(minor, { digestEnabled: true, digestTime: '23:30', quietHours: QUIET });
  const digest = result.find(i => i.type === T.DIGEST);
  assert.equal(isQuietTime(digest.time, QUIET), false);
});

test('koosteen kuittausavain muuttuu, kun sisältö muuttuu; tunniste pysyy', () => {
  const first = mergeDigest(minor, { digestEnabled: true }).find(i => i.type === T.DIGEST);
  const more = mergeDigest([...minor, intent({ type: T.DEADLINE_WARNING, targetId: 't9', title: 'Uusi' })],
    { digestEnabled: true }).find(i => i.type === T.DIGEST);
  assert.equal(first.id, more.id, 'sama tunniste: laite korvaa koosteen');
  assert.notEqual(first.ackKey, more.ackKey, 'uusi sisältö: kuitattu kooste ei piilota uutta asiaa');
});

test('kooste luettelee enintään viisi otsikkoa', () => {
  const many = Array.from({ length: 9 }, (_, i) => intent({ targetId: 'm' + i, title: 'Asia ' + i }));
  const digest = mergeDigest(many, { digestEnabled: true }).find(i => i.type === T.DIGEST);
  assert.equal(digest.body.split(',').length, DIGEST_MAX_TITLES);
  assert.match(digest.body, /ja 4 muuta\.$/);
  const single = mergeDigest([many[0]], { digestEnabled: true }).find(i => i.type === T.DIGEST);
  assert.match(single.body, /^Yksi pieni asia: /);
});

test('kooste puhuu vain, jos jokin jäsen olisi puhunut', () => {
  const silent = mergeDigest(minor, { digestEnabled: true }).find(i => i.type === T.DIGEST);
  assert.equal(silent.speech, null);
  const spoken = mergeDigest([...minor, intent({ targetId: 's', speech: 'Sinulla on lähestyvä määräaika.' })],
    { digestEnabled: true }).find(i => i.type === T.DIGEST);
  assert.equal(spoken.speech, 'Sinulla on neljä pientä muistutusta.');
});

test('isDigestible: ohitettavat tyypit ja torkutetut', () => {
  for (const type of DIGEST_BYPASS_TYPES) {
    assert.equal(isDigestible(intent({ type, level: LEVEL.INFO, targetId: type })), false, type);
  }
  assert.equal(isDigestible({ ...intent(), snoozed: true }), false);
  assert.equal(isDigestible(intent({ level: LEVEL.ACTION })), false);
  assert.equal(isDigestible(intent({ level: LEVEL.INFO })), true);
  assert.equal(isDigestible(null), false);
});

test('kooste on deterministinen ja ei muuta syötettä', () => {
  const input = [...minor, ...anchored];
  const snapshot = JSON.stringify(input);
  const expected = JSON.stringify(mergeDigest(input, { digestEnabled: true }));
  for (let seed = 1; seed <= 10; seed++) {
    assert.equal(JSON.stringify(mergeDigest(shuffled(input, seed), { digestEnabled: true })), expected);
  }
  assert.equal(JSON.stringify(input), snapshot);
});

// =====================================================================
// KUITTAUKSET
// =====================================================================

test('kuitattu ja hylätty poistuvat; näytetty ja avattu säilyvät', () => {
  const a = intent({ targetId: 'a' });
  const b = intent({ targetId: 'b' });
  const c = intent({ targetId: 'c' });
  const d = intent({ targetId: 'd' });
  const log = buildAckLog([
    { type: 'acknowledged', key: a.ackKey, atMs: T0 },
    { type: 'dismissed', key: b.ackKey, atMs: T0 },
    { type: 'delivered', key: c.ackKey, atMs: T0 },
    { type: 'opened', key: d.ackKey, atMs: T0 }
  ]);
  assert.deepEqual(applyAcks([a, b, c, d], log).map(i => i.targetId), ['c', 'd']);
});

test('KRIITTINEN: kuitattu "lähde nyt" ei palaa, vaikka lähtöaika muuttuisi', () => {
  const before = intent({ type: T.DEPARTURE_LEAVE_NOW, level: LEVEL.CRITICAL, targetId: 'e1', time: '08:15' });
  const moved = intent({ type: T.DEPARTURE_LEAVE_NOW, level: LEVEL.CRITICAL, targetId: 'e1', time: '08:05' });
  assert.equal(before.ackKey, moved.ackKey);
  const log = buildAckLog([{ type: 'acknowledged', key: before.ackKey, atMs: T0 }]);
  assert.deepEqual([...applyAcks([moved], log)], []);
});

test('toisto jakaa kuittausavaimen: kuittaus poistaa myös toiston', () => {
  const base = intent({ type: T.DEPARTURE_LEAVE_NOW, level: LEVEL.CRITICAL, targetId: 'e1', time: '08:15' });
  const repeat = intent({ type: T.DEPARTURE_LEAVE_NOW, level: LEVEL.CRITICAL, targetId: 'e1', time: '08:18',
    id: base.id + ':toisto1', ackKey: base.ackKey });
  const log = buildAckLog([{ type: 'acknowledged', key: base.ackKey, atMs: T0 }]);
  assert.deepEqual([...applyAcks([base, repeat], log)], []);
  assert.equal(applyAcks([base, repeat], buildAckLog([])).length, 2);
});

test('torkku paikallisella ajalla: aiemmat pois, yksi korvaava torkun loppuun', () => {
  const base = intent({ type: T.MEAL, targetId: 'm1', time: '16:30', title: 'Päivällinen', extra: { mealId: 'm1' } });
  const log = buildAckLog([{ type: 'snoozed', key: base.ackKey, atMs: T0, untilMs: T0 + 15 * MIN,
    untilLocal: { date: DAY, time: '16:45' } }]);
  const result = applyAcks([base], log, { nowMs: T0 });
  assert.equal(result.length, 1);
  const [replacement] = result;
  assert.equal(replacement.id, base.id + ':torkku');
  assert.equal(replacement.time, '16:45');
  assert.equal(replacement.ackKey, base.ackKey, 'sama avain: kuittaus koskee myös korvaajaa');
  assert.equal(replacement.snoozed, true);
  assert.equal(replacement.mealId, 'm1', 'lisätiedot säilyvät');
  assert.equal(replacement.anchor, null, 'torkku on seinäkelloaikaa');
  assert.ok(Object.isFrozen(replacement));

  // Torkun jälkeen oleva saman avaimen muistutus säilyy.
  const later = intent({ type: T.MEAL, targetId: 'm1', time: '17:00', id: base.id + ':myohempi', ackKey: base.ackKey });
  assert.deepEqual(applyAcks([base, later], log).map(i => i.time), ['16:45', '17:00']);
});

test('torkku keskiyön yli: korvaaja seuraavalle päivälle', () => {
  const base = intent({ type: T.HABIT, targetId: 'h', time: '23:55' });
  const log = buildAckLog([{ type: 'snoozed', key: base.ackKey, atMs: T0, untilMs: T0 + 10 * MIN,
    untilLocal: { date: '2026-09-28', time: '00:05' } }]);
  const [replacement] = applyAcks([base], log);
  assert.deepEqual([replacement.date, replacement.time], ['2026-09-28', '00:05']);
});

test('torkku ilman paikallista aikaa: pidätetään torkun ajan, sitten vapautetaan', () => {
  const base = intent({ targetId: 'z' });
  const log = buildAckLog([{ type: 'snoozed', key: base.ackKey, atMs: T0, untilMs: T0 + 10 * MIN }]);
  assert.equal(applyAcks([base], log, { nowMs: T0 + 5 * MIN }).length, 0);
  assert.equal(applyAcks([base], log, { nowMs: T0 + 11 * MIN }).length, 1);
  assert.equal(applyAcks([base], log).length, 1, 'ilman nykyhetkeä ei voi päätellä torkkua');
});

test('koosteen kaikki jäsenet käsitelty: kooste poistuu', () => {
  const digest = mergeDigest(minor, { digestEnabled: true }).find(i => i.type === T.DIGEST);
  const log = buildAckLog(minor.map(m => ({ type: 'acknowledged', key: m.ackKey, atMs: T0 })));
  assert.deepEqual([...applyAcks([digest], log)], []);
  const partial = buildAckLog([{ type: 'acknowledged', key: minor[0].ackKey, atMs: T0 }]);
  assert.equal(applyAcks([digest], partial).length, 1);
});

test('applyAcks: roskaloki ei poista mitään eikä heitä', () => {
  const list = [intent({ targetId: 'a' }), intent({ targetId: 'b' })];
  for (const log of [undefined, null, 'x', { entries: 5 }, { entries: [{ key: 7 }] }]) {
    assert.doesNotThrow(() => applyAcks(list, log));
    assert.equal(applyAcks(list, log).length, 2);
  }
  assert.deepEqual([...applyAcks('ei lista', null)], []);
});

// =====================================================================
// PÄIVÄRAJA
// =====================================================================

test('päiväraja säilyttää tärkeimmät ja palauttaa aikajärjestyksessä', () => {
  const list = [
    intent({ targetId: 'i1', level: LEVEL.INFO, time: '08:00' }),
    intent({ targetId: 'r1', level: LEVEL.REMINDER, time: '09:00' }),
    intent({ targetId: 'a1', level: LEVEL.ACTION, time: '10:00' }),
    intent({ targetId: 'r2', level: LEVEL.REMINDER, time: '07:00' }),
    intent({ targetId: 'c1', level: LEVEL.CRITICAL, time: '11:00' })
  ];
  const kept = capPerDay(list, 3);
  assert.deepEqual(kept.map(i => i.targetId), ['r2', 'a1', 'c1']);
});

test('KRIITTISTÄ EI KARSITA: kriittiset säilyvät vaikka raja ylittyisi', () => {
  const list = Array.from({ length: 4 }, (_, i) =>
    intent({ targetId: 'c' + i, level: LEVEL.CRITICAL, time: `${String(8 + i).padStart(2, '0')}:00` }));
  list.push(intent({ targetId: 'r', level: LEVEL.REMINDER, time: '07:00' }));
  const kept = capPerDay(list, 2);
  assert.equal(kept.filter(i => i.level === LEVEL.CRITICAL).length, 4);
  assert.equal(kept.some(i => i.targetId === 'r'), false);
});

test('päiväraja on päiväkohtainen', () => {
  const list = [
    intent({ targetId: 'a', date: DAY }), intent({ targetId: 'b', date: DAY, time: '13:00' }),
    intent({ targetId: 'c', date: '2026-09-28' }), intent({ targetId: 'd', date: '2026-09-28', time: '13:00' })
  ];
  assert.equal(capPerDay(list, 1).length, 2);
  assert.equal(capPerDay(list, 'x').length, 4, 'kelvoton raja: oletus 12');
});

// =====================================================================
// KOKO PUTKI
// =====================================================================

test('putki: perinteiset aikomukset saavat aiheen, toimitustavan ja kuittausavaimen', () => {
  const legacy = planNotifications({
    tasks: [{ id: 't1', title: 'Kokous', date: DAY, time: '14:00', completed: false }],
    dateIso: DAY, todayIso: DAY, preferences: { enabled: true }
  });
  const result = applyNotificationPolicy(legacy, { settings: {}, preferences: { enabled: true } });
  const daily = result.find(i => i.type === T.DAILY_PLAN);
  assert.equal(daily.topic, REMINDER_TOPIC.MORNING);
  assert.equal(daily.delivery, DELIVERY.SILENT);
  const task = result.find(i => i.type === T.TASK_REMINDER);
  assert.equal(task.topic, null);
  assert.equal(task.delivery, DELIVERY.VIBRATE);
  assert.equal(task.ackKey, task.id);
  assert.equal(task.speech, null);
  assert.ok(result.every(Object.isFrozen));
  assert.ok(legacy.every(i => !Object.isFrozen(i) && i.topic === null), 'syötettä ei muutettu');
});

test('putki: puhe syntyy vain luvalla ja valitulle aiheelle', () => {
  const list = [intent({ type: T.DEADLINE_WARNING, level: LEVEL.REMINDER, targetId: 'dl', time: '12:00' })];
  const off = applyNotificationPolicy(list, { settings: { delivery: { deadline: DELIVERY.SPEECH } } });
  assert.equal(off[0].speech, null);
  const on = applyNotificationPolicy(list, {
    settings: { speechEnabled: true, delivery: { deadline: DELIVERY.SPEECH } }
  });
  assert.equal(on[0].speech, 'Sinulla on lähestyvä määräaika.');
});

test('putki: rauhoitusaika pudottaa, mutta kooste pelastaa vähäiset', () => {
  const night = intent({ type: T.DEADLINE_WARNING, level: LEVEL.REMINDER, targetId: 'yo', time: '23:30' });
  const leave = intent({ type: T.DEPARTURE_LEAVE_NOW, level: LEVEL.CRITICAL, targetId: 'd', time: '05:10' });
  const meal = intent({ type: T.MEAL, level: LEVEL.REMINDER, targetId: 'm', time: '23:00' });

  const noDigest = applyNotificationPolicy([night, leave, meal], { preferences: { quietHours: QUIET } });
  assert.deepEqual(noDigest.map(i => i.targetId), ['d']);

  const withDigest = applyNotificationPolicy([night, leave, meal], {
    settings: { digestEnabled: true, digestTime: '18:00' }, preferences: { quietHours: QUIET }
  });
  assert.deepEqual(withDigest.map(i => i.type), [T.DEPARTURE_LEAVE_NOW, T.DIGEST]);
  assert.deepEqual([...withDigest[1].mergedIds], [night.id], 'yöllinen vähäinen siirtyi koosteeseen');
});

test('putki: kuittaus, torkku ja päiväraja yhdessä', () => {
  const list = Array.from({ length: 8 }, (_, i) =>
    intent({ type: T.TASK_REMINDER, targetId: 't' + i, time: `1${i}:00`, level: LEVEL.REMINDER }));
  const log = buildAckLog([
    { type: 'acknowledged', key: list[0].ackKey, atMs: T0 },
    { type: 'snoozed', key: list[1].ackKey, atMs: T0, untilMs: T0 + 30 * MIN, untilLocal: { date: DAY, time: '11:30' } }
  ]);
  const result = applyNotificationPolicy(list, { ackLog: log, preferences: { maxPerDay: 5 }, nowMs: T0 });
  assert.equal(result.length, 5);
  assert.equal(result.some(i => i.targetId === 't0'), false);
  assert.equal(result[0].id, list[1].id + ':torkku');
  assert.equal(result[0].time, '11:30');
});

test('OMINAISUUS: putken takuut satunnaisilla syötteillä', () => {
  let seed = 12345;
  const next = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed; };
  const types = NOTIFICATION_TYPES.filter(t => t !== T.DIGEST);
  for (let round = 0; round < 150; round++) {
    const count = next() % 30;
    const list = [];
    for (let i = 0; i < count; i++) {
      const hour = String(next() % 24).padStart(2, '0');
      const minute = String(next() % 60).padStart(2, '0');
      const level = 1 + (next() % 4);
      list.push(intent({ type: types[next() % types.length], level, time: `${hour}:${minute}`,
        targetId: 'r' + round + '-' + i, date: next() % 3 === 0 ? '2026-09-28' : DAY }));
    }
    const acked = list.filter(() => next() % 5 === 0);
    const log = buildAckLog(acked.map(i => ({ type: 'acknowledged', key: i.ackKey, atMs: T0 })));
    const maxPerDay = 1 + (next() % 10);
    const digestEnabled = next() % 2 === 0;
    const settings = { digestEnabled, digestTime: next() % 2 ? '23:15' : '18:00', speechEnabled: next() % 2 === 0,
      delivery: { departure: DELIVERY.SOUND_AND_SPEECH, meal: DELIVERY.SPEECH } };
    const result = applyNotificationPolicy(list, { settings, ackLog: log, preferences: { quietHours: QUIET, maxPerDay } });

    const handled = new Set(acked.map(i => i.ackKey));
    const perDay = new Map();
    for (const item of result) {
      assert.equal(handled.has(item.ackKey), false, 'kuitattu palasi');
      if (isQuietTime(item.time, QUIET)) {
        const passes = item.level === LEVEL.CRITICAL || QUIET_PASS_TYPES.includes(item.type)
          || item.topic === REMINDER_TOPIC.DEPARTURE || item.topic === REMINDER_TOPIC.BEDTIME;
        assert.ok(passes, `${item.type}/${item.level} klo ${item.time} rauhoitusaikana`);
        // Oman yön alku (NIGHT_START_TYPES) tulee valitulla tavalla; muu
        // nukkumaanmenon aiheen muistutus äänettömänä.
        if (item.topic === REMINDER_TOPIC.BEDTIME && item.level !== LEVEL.CRITICAL
          && !NIGHT_START_TYPES.includes(item.type)) {
          assert.equal(item.delivery, DELIVERY.SILENT, 'nukkumaanmeno rauhoitusaikana on äänetön');
        }
        assert.notEqual(item.type, T.DIGEST, 'kooste rauhoitusaikana');
      }
      if (!settings.speechEnabled) assert.equal(item.speech, null, 'puhe ilman lupaa');
      if (item.speech) assert.ok(item.speech.length <= 120);
      if (item.level === LEVEL.INFO) assert.equal(item.delivery, DELIVERY.SILENT);
      if (item.level !== LEVEL.CRITICAL) perDay.set(item.date, (perDay.get(item.date) || 0) + 1);
      assert.ok(DELIVERIES.includes(item.delivery), 'toimitustapa päätetty');
    }
    for (const [date, n] of perDay) assert.ok(n <= maxPerDay, `${date}: ${n} > ${maxPerDay}`);
    if (!digestEnabled) assert.equal(result.some(i => i.type === T.DIGEST), false);
    for (let i = 1; i < result.length; i++) {
      const a = result[i - 1];
      const b = result[i];
      assert.ok(a.date < b.date || (a.date === b.date && a.atMinutes <= b.atMinutes), 'aikajärjestys');
    }
    const again = applyNotificationPolicy(shuffled(list, round + 1), { settings, ackLog: log, preferences: { quietHours: QUIET, maxPerDay } });
    assert.deepEqual(again.map(i => i.id), result.map(i => i.id), 'järjestyksestä riippumaton');
  }
});

test('putki: kuitattu kooste ei palaa; torkutettu kooste siirtyy', () => {
  const settings = { digestEnabled: true, digestTime: '18:00' };
  const [digest] = applyNotificationPolicy(minor, { settings }).filter(i => i.type === T.DIGEST);
  assert.ok(digest);

  const acked = buildAckLog([{ type: 'acknowledged', key: digest.ackKey, atMs: T0 }]);
  assert.equal(applyNotificationPolicy(minor, { settings, ackLog: acked }).some(i => i.type === T.DIGEST), false,
    'pelkän koosteen kuittaus riittää');

  const snoozed = buildAckLog([{ type: 'snoozed', key: digest.ackKey, atMs: T0, untilMs: T0 + 60 * MIN,
    untilLocal: { date: DAY, time: '19:00' } }]);
  const moved = applyNotificationPolicy(minor, { settings, ackLog: snoozed }).filter(i => i.type === T.DIGEST);
  assert.deepEqual(moved.map(i => [i.id, i.time]), [[digest.id + ':torkku', '19:00']]);
  assert.deepEqual([...moved[0].mergedAckKeys], [...digest.mergedAckKeys], 'torkku säilyttää jäsenet');

  // Uusi asia samalle päivälle: uusi kooste, vaikka edellinen on kuitattu.
  const extra = intent({ type: T.DEADLINE_WARNING, targetId: 'uusi', title: 'Uusi asia' });
  assert.equal(applyNotificationPolicy([...minor, extra], { settings, ackLog: acked })
    .some(i => i.type === T.DIGEST), true);
});

test('putki: duplikaatit poistuvat deterministisesti', () => {
  const a = intent({ targetId: 'same', title: 'A' });
  const b = intent({ targetId: 'same', title: 'B' });
  const first = applyNotificationPolicy([a, b]);
  const second = applyNotificationPolicy([b, a]);
  assert.equal(first.length, 1);
  assert.deepEqual(first, second);
});

test('putki: roskasyöte ei heitä', () => {
  const hostile = {};
  Object.defineProperty(hostile, 'settings', { get() { throw new Error('x'); } });
  for (const input of [undefined, null, 'x', 5, [null, 1, 'a', {}, [], { id: 'x' }],
    [{ id: 'x', date: DAY, time: '25:00', level: 2 }], [{ id: 'x', date: DAY, time: '12:00', level: 7 }]]) {
    assert.doesNotThrow(() => applyNotificationPolicy(input, { settings: 'x', preferences: 5, ackLog: 'y' }));
    assert.deepEqual([...applyNotificationPolicy(input)], []);
  }
  assert.doesNotThrow(() => mergeDigest([null], null));
  assert.doesNotThrow(() => capPerDay(undefined, undefined));
});

test('SUORITUSKYKY: kymmenientuhansien aikomusten putki on lähes lineaarinen', () => {
  const build = n => Array.from({ length: n }, (_, i) => intent({
    type: [T.TASK_REMINDER, T.DEADLINE_WARNING, T.MEAL, T.DEPARTURE_LEAVE_NOW][i % 4],
    level: 1 + (i % 4), targetId: 'p' + i, time: `${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
    date: `2026-09-${String(10 + (i % 14)).padStart(2, '0')}`
  }));
  const log = buildAckLog(Array.from({ length: 400 }, (_, i) => ({ type: 'acknowledged', key: `task_reminder:p${i * 4}:x`, atMs: T0 })));
  const time = list => {
    const started = performance.now();
    applyNotificationPolicy(list, { settings: { digestEnabled: true, speechEnabled: true }, ackLog: log, preferences: { maxPerDay: 50 } });
    return performance.now() - started;
  };
  time(build(1000)); // lämmittely
  const small = time(build(4000));
  const large = time(build(16000));
  assert.ok(large < 4000, `16 000 aikomusta kesti ${Math.round(large)} ms`);
  assert.ok(large < small * 12 + 50, `kasvu ei ole lähes lineaarista: ${Math.round(small)} -> ${Math.round(large)} ms`);
});

test('PUHTAUS: politiikka ei lue kelloa eikä koske alustaan', () => {
  const source = readCode('src/domain/notificationPolicy.js');
  for (const forbidden of ['Date.now(', 'new Date(', 'Math.random', 'localStorage', 'console.', 'Capacitor']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
