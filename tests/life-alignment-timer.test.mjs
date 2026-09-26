// Suunta 2: ajastimen domain — aikaleimat totuutena, keskiyö, kesäaika,
// vuoden vaihde, karkausvuosi, aikavyöhyke ja kaksoispysäytys.
//
// AIKAVYÖHYKE ON KIINNITETTY: process.env.TZ = 'Europe/Helsinki'. Node
// ajaa jokaisen testitiedoston omassa prosessissaan, joten asetus ei vuoda
// muihin testeihin. Kesäajan vaihdokset 2026: 29.3. klo 03 -> 04 ja
// 25.10. klo 04 -> 03. Kellonajat annetaan AINA eksplisiittisinä
// aikaleimoina; testi ei lue oikeaa kelloa.

process.env.TZ = 'Europe/Helsinki';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  startTimer, pauseTimer, resumeTimer, stopTimer, timerStatus, formatElapsed,
  normalizeTimer, validateTimer, timerTargetFields, LOCAL_CALENDAR, TIMER_TARGET, hasStopPlan
} from '../src/domain/timer.js';
import { TIMER_RULES } from '../src/domain/alignmentPolicy.js';
import { weekStartOf } from '../src/domain/weeklyCapacity.js';
import { MAX_ENTRY_MINUTES, validateTimeEntry, normalizeTimeEntry, OPERATION } from '../src/domain/timeEntry.js';

const MIN = 60 * 1000;
/** Paikallinen hetki Helsingin ajassa. */
const local = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

function started(atMs, target = { kind: 'none' }, id = 'tmr1') {
  const result = startTimer({ id, target, nowMs: atMs });
  assert.equal(result.ok, true, result.message);
  return result.timer;
}

// ================================================================ PERUSTA

test('aikavyöhyke on kiinnitetty testissä (Helsinki, +3 kesällä)', () => {
  assert.equal(new Date(local(2026, 7, 1, 12)).getTimezoneOffset(), -180);
  assert.equal(new Date(local(2026, 1, 1, 12)).getTimezoneOffset(), -120);
});

test('kulunut aika johdetaan aikaleimoista, ei laskurista', () => {
  const t0 = local(2026, 9, 21, 9, 0);
  const timer = started(t0);
  assert.equal(timerStatus(timer, t0 + 25 * MIN).elapsedSeconds, 25 * 60);
  // Sama ajastin, eri "nyt": tulos riippuu vain aikaleimoista.
  assert.equal(timerStatus(timer, t0 + 90 * MIN).elapsedSeconds, 90 * 60);
  assert.equal(timerStatus(timer, t0 + 90 * MIN).state, 'running');
});

test('tauko pysäyttää kuluneen ajan, jatko ei laske taukoa', () => {
  const t0 = local(2026, 9, 21, 9, 0);
  let timer = started(t0);
  timer = pauseTimer(timer, t0 + 25 * MIN);
  assert.equal(timerStatus(timer, t0 + 60 * MIN).elapsedSeconds, 25 * 60, 'tauolla aika ei kulu');
  assert.equal(timerStatus(timer, t0 + 60 * MIN).state, 'paused');
  timer = resumeTimer(timer, t0 + 60 * MIN);
  assert.equal(timer.pausedSeconds, 35 * 60);
  assert.equal(timerStatus(timer, t0 + 70 * MIN).elapsedSeconds, 35 * 60);
});

test('tauko ja jatko ovat idempotentteja (kaksoisnapautus)', () => {
  const t0 = local(2026, 9, 21, 9, 0);
  const paused = pauseTimer(started(t0), t0 + 10 * MIN);
  assert.equal(pauseTimer(paused, t0 + 20 * MIN), paused, 'toinen tauko ei siirrä tauon alkua');
  const resumed = resumeTimer(paused, t0 + 30 * MIN);
  assert.equal(resumeTimer(resumed, t0 + 40 * MIN), resumed);
});

test('kaksi ajastinta ei käynnisty', () => {
  const t0 = local(2026, 9, 21, 9, 0);
  const first = started(t0);
  const second = startTimer({ id: 'tmr2', target: {}, nowMs: t0 + MIN, existing: first });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'timer.already_running');
});

test('tulevaisuuden aloitus hylätään; pieni kellojen ero sallitaan', () => {
  const now = local(2026, 9, 21, 9, 0);
  const future = startTimer({ id: 'x', nowMs: now, startedAtMs: now + TIMER_RULES.MAX_FUTURE_SKEW_MS + 1000 });
  assert.equal(future.ok, false);
  assert.equal(future.code, 'timer.future_start');
  const skew = startTimer({ id: 'y', nowMs: now, startedAtMs: now + 60 * 1000 });
  assert.equal(skew.ok, true);
});

test('kello taaksepäin: kulunut aika ei ole negatiivinen eikä sitä kirjata', () => {
  const t0 = local(2026, 9, 21, 9, 0);
  const timer = started(t0);
  const status = timerStatus(timer, t0 - 5 * MIN);
  assert.equal(status.elapsedSeconds, 0);
  assert.equal(status.clockSkew, true);
  const stop = stopTimer(timer, t0 - 5 * MIN);
  assert.equal(stop.tooShort, true);
  assert.deepEqual(stop.entries, []);
});

test('nollakesto ei tuota roskakirjausta; puoli minuuttia pyöristyy minuutiksi', () => {
  const t0 = local(2026, 9, 21, 9, 0);
  assert.equal(stopTimer(started(t0), t0 + 20 * 1000).tooShort, true);
  const half = stopTimer(started(t0), t0 + 40 * 1000);
  assert.equal(half.tooShort, false);
  assert.equal(half.entries.length, 1);
  assert.equal(half.entries[0].minutes, 1);
});

test('pysäytys tuottaa ajastinkirjauksen kohteineen ja deterministisellä tunnisteella', () => {
  const t0 = local(2026, 9, 21, 9, 0);
  const timer = { ...started(t0, { kind: 'task', id: 'task-1' }), note: null };
  const a = stopTimer(timer, t0 + 45 * MIN);
  const b = stopTimer(timer, t0 + 45 * MIN);
  assert.equal(a.entries.length, 1);
  assert.equal(a.entries[0].minutes, 45);
  assert.equal(a.entries[0].source, 'timer');
  assert.equal(a.entries[0].taskId, 'task-1');
  assert.equal(a.entries[0].entryDate, '2026-09-21');
  assert.equal(a.entries[0].operationId, OPERATION.timer('tmr1'));
  assert.deepEqual(a.entries.map(e => e.operationId), b.entries.map(e => e.operationId),
    'sama pysäytys = sama operaatio: uusinta ei tuota toista riviä');
  const entry = normalizeTimeEntry({ ...a.entries[0], id: 'e1' });
  assert.equal(validateTimeEntry(entry).valid, true);
  assert.ok(Date.parse(entry.endedAt) >= Date.parse(entry.startedAt));
});

test('unohtunut ajastin (> 12 h) pyydetään tarkistamaan; korjattu kesto kirjataan', () => {
  const t0 = local(2026, 9, 21, 8, 0);
  const timer = started(t0);
  const stop = stopTimer(timer, t0 + 13 * 60 * MIN);
  assert.equal(stop.needsReview, true);
  const fixed = stopTimer(timer, t0 + 13 * 60 * MIN, { overrideMinutes: 90 });
  assert.equal(fixed.needsReview, false);
  assert.equal(fixed.totalMinutes, 90);
  assert.equal(fixed.entries[0].minutes, 90);
});

// ================================================================ KESKIYÖ JA VIIKKO

test('keskiyön ylittävä ajastus jaetaan päiville paikallisen keskiyön kohdalta', () => {
  // Sunnuntai 20.9. klo 23.30 -> maanantai 21.9. klo 00.45: eri viikot.
  const timer = started(local(2026, 9, 20, 23, 30));
  const stop = stopTimer(timer, local(2026, 9, 21, 0, 45));
  assert.deepEqual(stop.entries.map(e => [e.entryDate, e.minutes]), [['2026-09-20', 30], ['2026-09-21', 45]]);
  assert.equal(weekStartOf(stop.entries[0].entryDate), '2026-09-14');
  assert.equal(weekStartOf(stop.entries[1].entryDate), '2026-09-21', 'maanantain aika menee uudelle viikolle');
  // Ensimmäinen osa on aina `timer:<id>` osien määrästä riippumatta.
  assert.deepEqual(stop.entries.map(e => e.operationId), ['timer:tmr1', 'timer:tmr1.1']);
});

test('tauot jaetaan päiville suhteessa, ja osien summa on tasan kokonaiskesto', () => {
  let timer = started(local(2026, 9, 20, 23, 0));
  timer = pauseTimer(timer, local(2026, 9, 20, 23, 50));
  timer = resumeTimer(timer, local(2026, 9, 21, 0, 20)); // 30 min tauko
  const stop = stopTimer(timer, local(2026, 9, 21, 1, 7));
  const total = stop.entries.reduce((s, e) => s + e.minutes, 0);
  assert.equal(stop.totalMinutes, 127 - 30);
  assert.equal(total, stop.totalMinutes, 'pyöristys ei hukkaa eikä lisää minuutteja');
});

test('vuoden vaihde: kaksi päivää, sama ISO-viikko', () => {
  const stop = stopTimer(started(local(2026, 12, 31, 23, 0)), local(2027, 1, 1, 1, 0));
  assert.deepEqual(stop.entries.map(e => [e.entryDate, e.minutes]), [['2026-12-31', 60], ['2027-01-01', 60]]);
  assert.equal(weekStartOf('2027-01-01'), '2026-12-28', 'ISO-viikko alkaa edellisen vuoden puolella');
  assert.equal(weekStartOf('2026-12-31'), weekStartOf('2027-01-01'));
});

test('karkauspäivä: 28.2. -> 29.2.2028', () => {
  const stop = stopTimer(started(local(2028, 2, 28, 23, 30)), local(2028, 2, 29, 0, 30));
  assert.deepEqual(stop.entries.map(e => e.entryDate), ['2028-02-28', '2028-02-29']);
  assert.equal(weekStartOf('2028-02-29'), '2028-02-28');
});

// ================================================================ KESÄAIKA

test('kesäaikaan siirtyminen: seinäkello 02.30 -> 04.30 on tunti, ei kaksi', () => {
  const start = local(2026, 3, 29, 2, 30);
  const end = local(2026, 3, 29, 4, 30);
  assert.equal((end - start) / MIN, 60);
  const stop = stopTimer(started(start), end);
  assert.equal(stop.totalMinutes, 60);
  assert.deepEqual(stop.entries.map(e => [e.entryDate, e.minutes]), [['2026-03-29', 60]]);
});

test('kesäajan päättyminen: seinäkello 02.30 -> 04.30 on kolme tuntia', () => {
  const start = local(2026, 10, 25, 2, 30);
  const end = local(2026, 10, 25, 4, 30);
  assert.equal((end - start) / MIN, 180);
  const stop = stopTimer(started(start), end);
  assert.equal(stop.totalMinutes, 180);
  assert.equal(stop.entries[0].entryDate, '2026-10-25');
});

test('25 tunnin päivä pilkotaan kahteen kirjaukseen (kirjaus enintään 24 h)', () => {
  const start = local(2026, 10, 25, 0, 0);
  const end = local(2026, 10, 26, 0, 0);
  assert.equal((end - start) / MIN, 1500);
  const stop = stopTimer(started(start), end, { overrideMinutes: 1500 });
  assert.deepEqual(stop.entries.map(e => [e.entryDate, e.minutes]), [['2026-10-25', MAX_ENTRY_MINUTES], ['2026-10-25', 60]]);
  for (const entry of stop.entries) {
    assert.equal(validateTimeEntry(normalizeTimeEntry({ ...entry, id: 'x' })).valid, true);
  }
  assert.equal(new Set(stop.entries.map(e => e.operationId)).size, 2);
});

test('keskiyö rakennetaan kalenterista, ei lisäämällä 24 h', () => {
  // Kesäajan alkamispäivä on 23 h: seuraava keskiyö on 23 h päässä.
  const midnight = local(2026, 3, 29, 0, 0);
  assert.equal((LOCAL_CALENDAR.nextMidnight(midnight) - midnight) / MIN, 23 * 60);
});

// ================================================================ AIKAVYÖHYKE

test('aikavyöhykkeen vaihto ei muuta kestoa; päivä tulee pysäytyshetken kalenterista', () => {
  const start = Date.UTC(2026, 8, 21, 20, 0); // 23.00 Helsinki
  const end = Date.UTC(2026, 8, 21, 22, 0);   // 01.00 Helsinki (22.9.)
  const tokyo = {
    // UTC+9 kiinteä kalenteri (ei kesäaikaa)
    dateOf(ms) { return new Date(ms + 9 * 3600000).toISOString().slice(0, 10); },
    nextMidnight(ms) {
      const shifted = new Date(ms + 9 * 3600000);
      return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1) - 9 * 3600000;
    }
  };
  const timer = started(start);
  const helsinki = stopTimer(timer, end);
  const inTokyo = stopTimer(timer, end, { calendar: tokyo });
  assert.equal(helsinki.totalMinutes, 120);
  assert.equal(inTokyo.totalMinutes, 120, 'kesto on sama kaikissa vyöhykkeissä');
  assert.deepEqual(helsinki.entries.map(e => e.entryDate), ['2026-09-21', '2026-09-22']);
  assert.deepEqual(inTokyo.entries.map(e => e.entryDate), ['2026-09-22']);
});

// ================================================================ MALLI

test('normalisointi ja validointi: kohde, tauko ja kelvoton syöte', () => {
  const timer = normalizeTimer({ id: 1, targetKind: 'bogus', startedAt: '2026-09-21T06:00:00Z', pausedSeconds: -5 });
  assert.equal(timer.targetKind, TIMER_TARGET.NONE);
  assert.equal(timer.pausedSeconds, 0);
  assert.equal(normalizeTimer({ pausedSeconds: 10 ** 9 }).pausedSeconds, 7 * 24 * 3600);
  // Poistettu kohde (kanta nollasi sarakkeen): ajastin putoaa yleiseksi
  // eikä juutu näkymättömiin. Uutta ajastinta ilman kohdetta ei aloiteta.
  const orphan = normalizeTimer({ id: 'a', startedAt: '2026-09-21T06:00:00Z', targetKind: 'task', taskId: null });
  assert.equal(orphan.targetKind, TIMER_TARGET.NONE);
  assert.equal(validateTimer(orphan).valid, true);
  assert.equal(startTimer({ id: 'b', target: { kind: 'task' }, nowMs: Date.now() }).ok, false);
  const fields = timerTargetFields({ kind: 'routine', id: 'r1', occurrenceDate: '2026-09-21' });
  assert.equal(fields.routineId, 'r1');
  assert.equal(fields.occurrenceDate, '2026-09-21');
  assert.equal(timerTargetFields({ kind: 'none', lifeAreaId: 'a1' }).lifeAreaId, 'a1');
});

test('näytön muoto: h:mm, ei negatiivista', () => {
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(65 * 60), '1:05');
  assert.equal(formatElapsed(-10), '0:00');
});

test('aikaväli ei voi loppua ennen alkua eikä olla puolikas', () => {
  const base = { id: 'e', entryDate: '2026-09-21', minutes: 10 };
  assert.equal(validateTimeEntry(normalizeTimeEntry({ ...base, startedAt: '2026-09-21T10:00:00Z' })).valid, false);
  assert.equal(validateTimeEntry(normalizeTimeEntry({
    ...base, startedAt: '2026-09-21T10:00:00Z', endedAt: '2026-09-21T09:00:00Z'
  })).valid, false);
  // Esiintymän päivä ilman rutiinia: normalisointi pudottaa sen (rutiini
  // poistui, kanta nollasi routine_id:n), ja raaka syöte hylätään.
  assert.equal(normalizeTimeEntry({ ...base, occurrenceDate: '2026-09-21' }).occurrenceDate, null);
  assert.equal(validateTimeEntry({ ...normalizeTimeEntry(base), occurrenceDate: '2026-09-21' }).valid, false,
    'esiintymän päivä ilman rutiinia');
});

// ================================================================ KATSELMOINNIN LÖYDÖKSET

test('REGRESSIO: yli viikon tauko ei muutu työajaksi (kulunut aika säilyy tarkasti)', () => {
  const t0 = local(2026, 9, 1, 9, 0);
  let timer = started(t0);
  timer = pauseTimer(timer, t0 + 60 * MIN);
  timer = resumeTimer(timer, t0 + 60 * MIN + 10 * 24 * 60 * MIN);
  assert.ok(timer.pausedSeconds <= 7 * 24 * 3600, 'kannan raja pitää');
  const stop = stopTimer(timer, t0 + 61 * MIN + 10 * 24 * 60 * MIN);
  assert.equal(stop.totalMinutes, 61);
  assert.equal(stop.needsReview, false);
});

test('REGRESSIO: sama ajastin pysäytettynä yhtenä tai jaettuna jakaa ensimmäisen operaation', () => {
  const timer = started(local(2026, 9, 20, 22, 0), { kind: 'none' }, 'X');
  const before = stopTimer(timer, local(2026, 9, 20, 23, 50));
  const after = stopTimer(timer, local(2026, 9, 21, 0, 30));
  assert.equal(before.entries.length, 1);
  assert.equal(after.entries.length, 2);
  assert.equal(before.entries[0].operationId, after.entries[0].operationId,
    'kanta hylkää toisen pysäytyksen ensimmäisen osan (23505)');
});

test('REGRESSIO (RACE-01): pysäytyssuunnitelma normalisoituu ja tuottaa samat osat myös laitteelta luettuna', () => {
  const plain = started(local(2026, 9, 20, 23, 30), { kind: 'none' }, 'P');
  assert.equal('stopAtMs' in plain, false, 'tavallisella ajastimella ei ole suunnitelmaa');
  assert.equal(hasStopPlan(plain), false);
  const at = local(2026, 9, 21, 0, 45);
  const planned = normalizeTimer({
    ...plain, stopAtMs: String(at), overrideMinutes: 1.5, loggedOperationIds: ['timer:P', 'timer:P', 5, '']
  });
  assert.equal(planned.stopAtMs, at);
  assert.equal(planned.overrideMinutes, null, 'vain kokonaisluku kelpaa korjatuksi kestoksi');
  assert.deepEqual(planned.loggedOperationIds, ['timer:P']);
  assert.equal(hasStopPlan(planned), true);
  // Laitteen kautta kulkenut kopio (JSON) laskee täsmälleen samat osat.
  const restored = normalizeTimer(JSON.parse(JSON.stringify(planned)));
  const a = stopTimer(planned, planned.stopAtMs);
  const b = stopTimer(restored, restored.stopAtMs);
  assert.deepEqual(b.entries.map(e => [e.operationId, e.entryDate, e.minutes]),
    a.entries.map(e => [e.operationId, e.entryDate, e.minutes]));
  assert.deepEqual(a.entries.map(e => e.minutes), [30, 45]);
});
