// Rutiinimoottorin testit.
//
// Toistosäännöt ovat klassinen paikka hiljaisille virheille: ne näyttävät
// toimivan tavallisena keskiviikkona ja hajoavat vuodenvaihteessa. Siksi
// rajatapaukset testataan erikseen ja nimenomaisesti.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RECURRENCE, ROUTINE_SCHEDULING, EXCEPTION, MAX_EXPANSION_DAYS, DEFAULT_ROUTINE_MINUTES,
  isoWeekday, isIsoWeekday, normalizeWeekdays, normalizeRoutine, validateRoutine,
  matchesDate, occurrenceId, normalizeException, validateException, findException,
  expandRoutineOccurrences, expandRoutines, nextOccurrence, describeRecurrence,
  weekdayName, weekdayShort
} from '../src/domain/routine.js';
import { parseISO, fmtISO } from '../src/lib/datetime.js';

const routine = (over = {}) => normalizeRoutine({
  id: 'r1', title: 'Lääkkeet', category: 'hyvinvointi', priority: 'normaali',
  durationMinutes: 15, preferredTime: '07:00',
  recurrence: { type: RECURRENCE.DAILY }, active: true, ...over
});

// ------------------------------------------------------- viikonpäivät

test('isoWeekday: maanantai on 1 ja sunnuntai on 7', () => {
  // 31.8.2026 on maanantai, 6.9.2026 sunnuntai.
  assert.equal(isoWeekday(parseISO('2026-08-31')), 1);
  assert.equal(isoWeekday(parseISO('2026-09-06')), 7);
});

test('RAJATAPAUS: sunnuntai ei ole nolla', () => {
  // JS:n getDay() palauttaa sunnuntaille 0. Jos se vuotaisi läpi, sunnuntai
  // ei osuisi mihinkään viikonpäivälistaan.
  const sunday = isoWeekday(parseISO('2026-09-06'));
  assert.notEqual(sunday, 0);
  assert.equal(sunday, 7);
  assert.equal(isIsoWeekday(sunday), true);
});

test('koko viikko kartoittuu arvoihin 1–7 ilman aukkoja', () => {
  const days = [];
  for (let i = 0; i < 7; i++) {
    days.push(isoWeekday(parseISO(fmtISO(new Date(2026, 7, 31 + i)))));
  }
  assert.deepEqual(days, [1, 2, 3, 4, 5, 6, 7]);
});

test('normalizeWeekdays siivoaa, järjestää ja poistaa duplikaatit', () => {
  assert.deepEqual(normalizeWeekdays([5, 1, 5, 3]), [1, 3, 5]);
  assert.deepEqual(normalizeWeekdays([0, 8, -1, 'x', null]), []);
  assert.deepEqual(normalizeWeekdays(['3', 1]), [1, 3], 'merkkijononumerot kelpaavat');
  assert.deepEqual(normalizeWeekdays(null), []);
});

test('viikonpäivien nimet ovat suomeksi', () => {
  assert.equal(weekdayName(1), 'maanantai');
  assert.equal(weekdayName(7), 'sunnuntai');
  assert.equal(weekdayShort(3), 'ke');
  assert.equal(weekdayName(99), '');
});

// -------------------------------------------------------- normalisointi

test('normalizeRoutine antaa oletukset puuttuville arvoille', () => {
  const r = normalizeRoutine({ id: 'x', title: '  Venyttely  ' });
  assert.equal(r.title, 'Venyttely');
  assert.equal(r.recurrence.type, RECURRENCE.DAILY);
  assert.equal(r.durationMinutes, DEFAULT_ROUTINE_MINUTES);
  assert.equal(r.active, true);
  assert.equal(r.category, 'muu');
  assert.equal(r.priority, 'normaali');
});

test('normalizeRoutine hylkää tuntemattoman toistotyypin', () => {
  const r = normalizeRoutine({ id: 'x', title: 'T', recurrence: { type: 'joka-toinen-tiistai' } });
  assert.equal(r.recurrence.type, RECURRENCE.DAILY, 'tuntematon korvautuu turvallisella oletuksella');
});

test('rutiini ilman kellonaikaa on aina joustava', () => {
  const r = routine({ preferredTime: null, scheduling: ROUTINE_SCHEDULING.FIXED });
  assert.equal(r.scheduling, ROUTINE_SCHEDULING.FLEXIBLE,
    'kiinteä sijoitus ei ole mahdollinen ilman kellonaikaa');
});

test('kellonajallinen rutiini on oletuksena kiinteä', () => {
  assert.equal(routine().scheduling, ROUTINE_SCHEDULING.FIXED);
  assert.equal(routine({ scheduling: ROUTINE_SCHEDULING.FLEXIBLE }).scheduling,
    ROUTINE_SCHEDULING.FLEXIBLE, 'joustavuuden voi valita nimenomaisesti');
});

test('kesto rajataan vuorokauteen', () => {
  assert.equal(normalizeRoutine({ id: 'x', title: 'T', durationMinutes: 5000 }).durationMinutes, 1440);
  assert.equal(normalizeRoutine({ id: 'x', title: 'T', durationMinutes: -5 }).durationMinutes, DEFAULT_ROUTINE_MINUTES);
});

// ------------------------------------------------------------ validointi

test('validateRoutine vaatii nimen ja toistotavan', () => {
  assert.equal(validateRoutine(routine()).valid, true);
  assert.ok(validateRoutine(routine({ title: '   ' })).errors.title);
});

test('viikoittainen rutiini vaatii täsmälleen yhden viikonpäivän', () => {
  const none = routine({ recurrence: { type: RECURRENCE.WEEKLY, weekdays: [] } });
  const two = routine({ recurrence: { type: RECURRENCE.WEEKLY, weekdays: [1, 3] } });
  const one = routine({ recurrence: { type: RECURRENCE.WEEKLY, weekdays: [3] } });
  assert.ok(validateRoutine(none).errors.weekdays);
  assert.ok(validateRoutine(two).errors.weekdays);
  assert.equal(validateRoutine(one).valid, true);
});

test('mukautettu toisto vaatii vähintään yhden viikonpäivän', () => {
  assert.ok(validateRoutine(routine({ recurrence: { type: RECURRENCE.CUSTOM_WEEKDAYS, weekdays: [] } })).errors.weekdays);
  assert.equal(validateRoutine(routine({ recurrence: { type: RECURRENCE.CUSTOM_WEEKDAYS, weekdays: [2, 4] } })).valid, true);
});

test('tulevat toistotyypit hylätään ymmärrettävästi', () => {
  // Malli on laajennettava, mutta toteuttamaton tyyppi ei saa mennä läpi.
  const r = { ...routine(), recurrence: { type: 'monthly', weekdays: [] } };
  const { valid, errors } = validateRoutine(r);
  assert.equal(valid, false);
  assert.match(errors.recurrence, /ei vielä tueta/i);
});

test('loppupäivä ei voi olla ennen alkupäivää', () => {
  const r = routine({ startDate: '2026-09-10', endDate: '2026-09-01' });
  assert.ok(validateRoutine(r).errors.endDate);
});

// ------------------------------------------------------------- osuminen

test('DAILY osuu joka päivä', () => {
  const r = routine();
  for (const date of ['2026-08-31', '2026-09-05', '2026-09-06']) {
    assert.equal(matchesDate(r, date), true, date);
  }
});

test('WEEKDAYS osuu vain arkipäiviin', () => {
  const r = routine({ recurrence: { type: RECURRENCE.WEEKDAYS } });
  assert.equal(matchesDate(r, '2026-08-31'), true, 'maanantai');
  assert.equal(matchesDate(r, '2026-09-04'), true, 'perjantai');
  assert.equal(matchesDate(r, '2026-09-05'), false, 'lauantai');
  assert.equal(matchesDate(r, '2026-09-06'), false, 'sunnuntai');
});

test('CUSTOM_WEEKDAYS osuu vain valittuihin päiviin', () => {
  const r = routine({ recurrence: { type: RECURRENCE.CUSTOM_WEEKDAYS, weekdays: [2, 4, 7] } });
  assert.equal(matchesDate(r, '2026-09-01'), true, 'tiistai');
  assert.equal(matchesDate(r, '2026-09-03'), true, 'torstai');
  assert.equal(matchesDate(r, '2026-09-06'), true, 'sunnuntai');
  assert.equal(matchesDate(r, '2026-09-02'), false, 'keskiviikko');
});

test('deaktivoitu rutiini ei osu koskaan', () => {
  assert.equal(matchesDate(routine({ active: false }), '2026-09-01'), false);
});

test('alku- ja loppupäivä rajaavat osumisen', () => {
  const r = routine({ startDate: '2026-09-02', endDate: '2026-09-04' });
  assert.equal(matchesDate(r, '2026-09-01'), false, 'ennen alkua');
  assert.equal(matchesDate(r, '2026-09-02'), true, 'alkupäivä kuuluu mukaan');
  assert.equal(matchesDate(r, '2026-09-04'), true, 'loppupäivä kuuluu mukaan');
  assert.equal(matchesDate(r, '2026-09-05'), false, 'lopun jälkeen');
});

// ------------------------------------------------------------ laajennus

test('päivittäinen rutiini laajenee jokaiselle päivälle', () => {
  const items = expandRoutineOccurrences({ routine: routine(), from: '2026-08-31', to: '2026-09-06' });
  assert.equal(items.length, 7);
  assert.deepEqual(items.map(i => i.date), [
    '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03',
    '2026-09-04', '2026-09-05', '2026-09-06'
  ]);
});

test('arkirutiini laajenee viidelle päivälle viikossa', () => {
  const r = routine({ recurrence: { type: RECURRENCE.WEEKDAYS } });
  const items = expandRoutineOccurrences({ routine: r, from: '2026-08-31', to: '2026-09-06' });
  assert.equal(items.length, 5);
  assert.equal(items.every(i => i.date <= '2026-09-04'), true);
});

test('RAJATAPAUS: laajennus kuukauden vaihteen yli', () => {
  const items = expandRoutineOccurrences({ routine: routine(), from: '2026-08-30', to: '2026-09-02' });
  assert.deepEqual(items.map(i => i.date), ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
});

test('RAJATAPAUS: laajennus vuodenvaihteen yli', () => {
  const items = expandRoutineOccurrences({ routine: routine(), from: '2026-12-30', to: '2027-01-02' });
  assert.deepEqual(items.map(i => i.date), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
});

test('RAJATAPAUS: karkauspäivä sisältyy laajennukseen', () => {
  // 2028 on karkausvuosi, 29.2.2028 on tiistai.
  const items = expandRoutineOccurrences({ routine: routine(), from: '2028-02-27', to: '2028-03-01' });
  assert.deepEqual(items.map(i => i.date), ['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01']);
});

test('RAJATAPAUS: karkauspäivä osuu oikeaan viikonpäivään', () => {
  const r = routine({ recurrence: { type: RECURRENCE.CUSTOM_WEEKDAYS, weekdays: [2] } });
  const items = expandRoutineOccurrences({ routine: r, from: '2028-02-27', to: '2028-03-01' });
  assert.deepEqual(items.map(i => i.date), ['2028-02-29'], 'karkauspäivä on tiistai');
});

test('laajennus on molemmista päistä inklusiivinen', () => {
  const items = expandRoutineOccurrences({ routine: routine(), from: '2026-09-01', to: '2026-09-01' });
  assert.equal(items.length, 1);
  assert.equal(items[0].date, '2026-09-01');
});

test('käänteinen aikaväli tuottaa tyhjän tuloksen', () => {
  assert.deepEqual(expandRoutineOccurrences({ routine: routine(), from: '2026-09-05', to: '2026-09-01' }), []);
});

test('kelvoton aikaväli tuottaa tyhjän tuloksen eikä kaadu', () => {
  assert.deepEqual(expandRoutineOccurrences({ routine: routine(), from: 'roska', to: '2026-09-01' }), []);
  assert.deepEqual(expandRoutineOccurrences({ routine: null, from: '2026-09-01', to: '2026-09-02' }), []);
});

test('deaktivoitu rutiini ei laajene lainkaan', () => {
  assert.deepEqual(expandRoutineOccurrences({ routine: routine({ active: false }), from: '2026-08-31', to: '2026-09-06' }), []);
});

test('TAKUU: laajennus ei koskaan ylitä enimmäisikkunaa', () => {
  const items = expandRoutineOccurrences({ routine: routine(), from: '2026-01-01', to: '2030-01-01' });
  assert.ok(items.length <= MAX_EXPANSION_DAYS,
    'laajennus tuotti ' + items.length + ' esiintymää — suojaraja pettää');
});

test('esiintymä perii rutiinin kentät ja laskee loppuajan', () => {
  const [item] = expandRoutineOccurrences({ routine: routine(), from: '2026-09-01', to: '2026-09-01' });
  assert.equal(item.title, 'Lääkkeet');
  assert.equal(item.time, '07:00');
  assert.equal(item.endTime, '07:15', '07:00 + 15 min');
  assert.equal(item.category, 'hyvinvointi');
  assert.equal(item.isRoutine, true);
  assert.equal(item.routineId, 'r1');
});

test('kellonajaton rutiini tuottaa aikataulutettavan esiintymän', () => {
  const [item] = expandRoutineOccurrences({
    routine: routine({ preferredTime: null }), from: '2026-09-01', to: '2026-09-01'
  });
  assert.equal(item.time, null);
  assert.equal(item.endTime, null);
  assert.equal(item.scheduling, ROUTINE_SCHEDULING.FLEXIBLE);
});

// -------------------------------------------------------- tunnisteet

test('TAKUU: esiintymän tunniste on deterministinen', () => {
  assert.equal(occurrenceId('r1', '2026-09-01'), occurrenceId('r1', '2026-09-01'));
  assert.equal(occurrenceId('r1', '2026-09-01'), 'routine:r1:2026-09-01');
});

test('TAKUU: laajennus ei tuota kahta samaa tunnistetta', () => {
  const routines = [
    routine({ id: 'a' }),
    routine({ id: 'b', recurrence: { type: RECURRENCE.WEEKDAYS } }),
    routine({ id: 'c', recurrence: { type: RECURRENCE.CUSTOM_WEEKDAYS, weekdays: [1, 3, 5] } })
  ];
  const items = expandRoutines({ routines, from: '2026-01-01', to: '2026-03-31' });
  const ids = items.map(i => i.id);
  assert.equal(new Set(ids).size, ids.length,
    'duplikaattitunnisteita: ' + (ids.length - new Set(ids).size));
});

test('eri rutiinit eivät jaa tunnistetta samana päivänä', () => {
  assert.notEqual(occurrenceId('r1', '2026-09-01'), occurrenceId('r2', '2026-09-01'));
});

// -------------------------------------------------------- poikkeukset

test('SKIP jättää yhden esiintymän pois muita koskematta', () => {
  const exceptions = [normalizeException({ routineId: 'r1', date: '2026-09-02', type: EXCEPTION.SKIP })];
  const items = expandRoutineOccurrences({ routine: routine(), from: '2026-09-01', to: '2026-09-03', exceptions });
  assert.deepEqual(items.map(i => i.date), ['2026-09-01', '2026-09-03']);
});

test('RESCHEDULE siirtää yhden esiintymän kellonaikaa', () => {
  const exceptions = [normalizeException({
    routineId: 'r1', date: '2026-09-02', type: EXCEPTION.RESCHEDULE, time: '15:00'
  })];
  const items = expandRoutineOccurrences({ routine: routine(), from: '2026-09-01', to: '2026-09-03', exceptions });
  assert.equal(items[0].time, '07:00', 'muut päivät ennallaan');
  assert.equal(items[1].time, '15:00', 'siirretty päivä');
  assert.equal(items[1].endTime, '15:15');
  assert.equal(items[1].exceptionApplied, EXCEPTION.RESCHEDULE);
  assert.equal(items[2].time, '07:00', 'seuraava päivä ennallaan');
});

test('OVERRIDE muuttaa yhden esiintymän kenttiä', () => {
  const exceptions = [normalizeException({
    routineId: 'r1', date: '2026-09-02', type: EXCEPTION.OVERRIDE,
    title: 'Lääkkeet (tuplaannos)', durationMinutes: 30, note: 'lääkärin ohje'
  })];
  const items = expandRoutineOccurrences({ routine: routine(), from: '2026-09-01', to: '2026-09-03', exceptions });
  assert.equal(items[1].title, 'Lääkkeet (tuplaannos)');
  assert.equal(items[1].durationMinutes, 30);
  assert.equal(items[1].endTime, '07:30');
  assert.equal(items[1].note, 'lääkärin ohje');
  assert.equal(items[0].title, 'Lääkkeet', 'muut päivät ennallaan');
});

test('poikkeus koskee vain omaa rutiiniaan', () => {
  const exceptions = [normalizeException({ routineId: 'toinen', date: '2026-09-02', type: EXCEPTION.SKIP })];
  const items = expandRoutineOccurrences({ routine: routine(), from: '2026-09-01', to: '2026-09-03', exceptions });
  assert.equal(items.length, 3, 'toisen rutiinin poikkeus ei saa vaikuttaa');
});

test('findException löytää oikean poikkeuksen', () => {
  const exceptions = [
    normalizeException({ routineId: 'r1', date: '2026-09-01', type: EXCEPTION.SKIP }),
    normalizeException({ routineId: 'r1', date: '2026-09-02', type: EXCEPTION.SKIP })
  ];
  assert.equal(findException(exceptions, 'r1', '2026-09-02').date, '2026-09-02');
  assert.equal(findException(exceptions, 'r1', '2026-09-03'), null);
  assert.equal(findException(null, 'r1', '2026-09-01'), null);
});

test('validateException vaatii siirrolle kellonajan', () => {
  const withoutTime = normalizeException({ routineId: 'r1', date: '2026-09-01', type: EXCEPTION.RESCHEDULE });
  assert.equal(validateException(withoutTime).valid, false);

  const withTime = normalizeException({ routineId: 'r1', date: '2026-09-01', type: EXCEPTION.RESCHEDULE, time: '10:00' });
  assert.equal(validateException(withTime).valid, true);
});

test('validateException vaatii rutiinin ja päivän', () => {
  assert.ok(validateException(normalizeException({ date: '2026-09-01' })).errors.routineId);
  assert.ok(validateException(normalizeException({ routineId: 'r1' })).errors.date);
});

// ------------------------------------------------------ monta rutiinia

test('expandRoutines järjestää esiintymät päivän ja ajan mukaan', () => {
  const routines = [
    routine({ id: 'ilta', title: 'Ilta', preferredTime: '21:00' }),
    routine({ id: 'aamu', title: 'Aamu', preferredTime: '07:00' })
  ];
  const items = expandRoutines({ routines, from: '2026-09-01', to: '2026-09-02' });
  assert.deepEqual(items.map(i => `${i.date} ${i.time}`), [
    '2026-09-01 07:00', '2026-09-01 21:00',
    '2026-09-02 07:00', '2026-09-02 21:00'
  ]);
});

test('ajattomat esiintymät tulevat ajallisten jälkeen', () => {
  const routines = [
    routine({ id: 'joustava', preferredTime: null }),
    routine({ id: 'kiintea', preferredTime: '09:00' })
  ];
  const items = expandRoutines({ routines, from: '2026-09-01', to: '2026-09-01' });
  assert.equal(items[0].routineId, 'kiintea');
  assert.equal(items[1].routineId, 'joustava');
});

test('TAKUU: laajennus on deterministinen syötteen järjestyksestä riippumatta', () => {
  const routines = [
    routine({ id: 'a', preferredTime: '08:00' }),
    routine({ id: 'b', preferredTime: '08:00' }),
    routine({ id: 'c', recurrence: { type: RECURRENCE.WEEKDAYS }, preferredTime: '12:00' })
  ];
  const first = expandRoutines({ routines, from: '2026-09-01', to: '2026-09-07' });
  const second = expandRoutines({ routines: [...routines].reverse(), from: '2026-09-01', to: '2026-09-07' });
  assert.deepEqual(first.map(i => i.id), second.map(i => i.id));
});

test('tyhjä rutiinilista tuottaa tyhjän tuloksen', () => {
  assert.deepEqual(expandRoutines({ routines: [], from: '2026-09-01', to: '2026-09-07' }), []);
  assert.deepEqual(expandRoutines({ routines: null, from: '2026-09-01', to: '2026-09-07' }), []);
});

// ------------------------------------------------------ seuraava esiintymä

test('nextOccurrence löytää seuraavan esiintymän', () => {
  const r = routine({ recurrence: { type: RECURRENCE.CUSTOM_WEEKDAYS, weekdays: [3] } });
  const next = nextOccurrence({ routine: r, fromDate: '2026-09-01' });
  assert.equal(next.date, '2026-09-02', 'seuraava keskiviikko');
});

test('nextOccurrence ottaa huomioon ohitetun esiintymän', () => {
  const exceptions = [normalizeException({ routineId: 'r1', date: '2026-09-01', type: EXCEPTION.SKIP })];
  const next = nextOccurrence({ routine: routine(), fromDate: '2026-09-01', exceptions });
  assert.equal(next.date, '2026-09-02');
});

test('nextOccurrence palauttaa null päättyneelle rutiinille', () => {
  const r = routine({ endDate: '2026-08-01' });
  assert.equal(nextOccurrence({ routine: r, fromDate: '2026-09-01' }), null);
  assert.equal(nextOccurrence({ routine: routine({ active: false }), fromDate: '2026-09-01' }), null);
});

// ---------------------------------------------------------- kuvaukset

test('describeRecurrence kuvaa toiston ymmärrettävästi', () => {
  assert.equal(describeRecurrence(routine()), 'Joka päivä');
  assert.equal(describeRecurrence(routine({ recurrence: { type: RECURRENCE.WEEKDAYS } })), 'Arkisin ma–pe');
  assert.equal(describeRecurrence(routine({ recurrence: { type: RECURRENCE.WEEKLY, weekdays: [3] } })), 'Joka keskiviikko');
  assert.equal(describeRecurrence(routine({ recurrence: { type: RECURRENCE.CUSTOM_WEEKDAYS, weekdays: [1, 3, 5] } })), 'ma, ke, pe');
});
