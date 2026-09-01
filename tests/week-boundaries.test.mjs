// Viikkosuunnittelun reunatapaukset.
//
// Kalenterikoodi ei mene rikki tavallisessa käytössä. Se menee rikki
// kuukauden vaihteessa, vuoden vaihteessa, karkausvuonna ja silloin kun
// viikko on tyhjä — eli juuri niissä kohdissa, joita ei tule testattua
// käsin. Siksi ne testataan tässä nimenomaisesti.
//
// Kaikki päivämäärät ovat paikallista aikaa. Manifestival käsittelee aikaa
// seinäkelloaikana ilman aikavyöhykkeitä: maanantai on maanantai siellä
// missä käyttäjä on. Testit rakentavat päivät Date-konstruktorilla eivätkä
// merkkijonoista, jotta UTC-tulkinta ei pääse sekoittamaan tulosta.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  weekDays, weekDayIsoList, weekRangeLabel, weekSummary, groupByDate
} from '../src/domain/week.js';
import { startOfWeek, fmtISO, addDays, parseISO } from '../src/lib/datetime.js';
import { normalizeTask } from '../src/domain/task.js';
import { buildWeeklyReview } from '../src/domain/review.js';
import { normalizeGoal } from '../src/domain/goal.js';

/** Paikallinen keskiyö. */
function day(year, month, date) {
  return new Date(year, month - 1, date);
}

function task(id, dateIso, extra = {}) {
  return normalizeTask({
    id, title: 'Tehtävä ' + id, date: dateIso, completed: false, ...extra
  });
}

// ------------------------------------------------------- viikon alku

test('viikko alkaa aina maanantaista', () => {
  // Sunnuntai on viikon VIIMEINEN päivä suomalaisessa kalenterissa.
  // JavaScriptin getDay() palauttaa sunnuntaille 0, mikä on toistuva
  // virhelähde: naiivi toteutus siirtäisi sunnuntain seuraavan viikon alkuun.
  const cases = [
    [day(2026, 3, 9), '2026-03-09'],   // maanantai
    [day(2026, 3, 10), '2026-03-09'],  // tiistai
    [day(2026, 3, 14), '2026-03-09'],  // lauantai
    [day(2026, 3, 15), '2026-03-09'],  // SUNNUNTAI kuuluu samaan viikkoon
    [day(2026, 3, 16), '2026-03-16']   // seuraava maanantai
  ];

  for (const [date, expected] of cases) {
    assert.equal(fmtISO(startOfWeek(date)), expected,
      `${fmtISO(date)} (getDay ${date.getDay()})`);
  }
});

test('viikossa on aina täsmälleen seitsemän peräkkäistä päivää', () => {
  // Ajetaan kahden vuoden jokainen päivä läpi: kesäajan siirtymät osuvat
  // mukaan itsestään eikä niitä tarvitse arvata erikseen.
  let cursor = day(2025, 1, 1);
  const end = day(2027, 1, 1);

  while (cursor < end) {
    const monday = startOfWeek(cursor);
    const days = weekDays(monday);

    assert.equal(days.length, 7, fmtISO(cursor));
    assert.equal(days[0].getDay(), 1, `${fmtISO(cursor)}: ei ala maanantaista`);
    assert.equal(days[6].getDay(), 0, `${fmtISO(cursor)}: ei pääty sunnuntaihin`);

    for (let index = 1; index < 7; index++) {
      const previous = fmtISO(days[index - 1]);
      const current = fmtISO(days[index]);
      assert.equal(current, fmtISO(addDays(parseISO(previous), 1)),
        `${fmtISO(cursor)}: päivä ${index} ei ole edellistä seuraava`);
    }

    const isoList = weekDayIsoList(monday);
    assert.equal(new Set(isoList).size, 7, `${fmtISO(cursor)}: päivä toistuu`);

    cursor = addDays(cursor, 1);
  }
});

// ------------------------------------------------- kuukauden vaihde

test('kuukauden vaihtava viikko pysyy ehjänä', () => {
  // 30.3.2026 on maanantai; viikko ulottuu huhtikuun puolelle.
  const monday = startOfWeek(day(2026, 3, 30));
  const days = weekDayIsoList(monday);

  assert.deepEqual(days, [
    '2026-03-30', '2026-03-31', '2026-04-01',
    '2026-04-02', '2026-04-03', '2026-04-04', '2026-04-05'
  ]);
});

test('31 päivän kuukaudesta 30 päivän kuukauteen ei kadota päivää', () => {
  const monday = startOfWeek(day(2026, 8, 31)); // elokuun viimeinen päivä
  const days = weekDayIsoList(monday);
  assert.equal(days.length, 7);
  assert.ok(days.includes('2026-08-31'));
  assert.ok(days.includes('2026-09-01'));
});

// --------------------------------------------------- vuoden vaihde

test('vuoden vaihtava viikko pysyy ehjänä', () => {
  // 28.12.2026 on maanantai; viikko jatkuu vuoteen 2027.
  const monday = startOfWeek(day(2026, 12, 28));
  const days = weekDayIsoList(monday);

  assert.deepEqual(days, [
    '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31',
    '2027-01-01', '2027-01-02', '2027-01-03'
  ]);
});

test('vuodenvaihteen viikon otsikko kertoo molemmat vuodet', () => {
  const crossing = weekRangeLabel(startOfWeek(day(2026, 12, 28)));
  assert.equal(crossing, '28.12.2026 – 3.1.2027');

  // Tavallinen viikko pysyy lyhyenä: vuosiluku on siinä pelkkää kohinaa.
  const ordinary = weekRangeLabel(startOfWeek(day(2026, 3, 9)));
  assert.equal(ordinary, '9.3. – 15.3.');
  assert.equal(/2026/.test(ordinary), false);
});

// ------------------------------------------------------ karkausvuosi

test('karkausvuoden 29. helmikuuta kuuluu viikkoonsa', () => {
  // 2028 on karkausvuosi. 29.2.2028 on tiistai.
  const target = day(2028, 2, 29);
  assert.equal(target.getDate(), 29, 'testipäivä ei ole 29.2. — tarkista vuosi');

  const days = weekDayIsoList(startOfWeek(target));
  assert.ok(days.includes('2028-02-29'), 'karkauspäivä katosi viikosta');
  assert.ok(days.includes('2028-03-01'));
  assert.equal(days.length, 7);
});

test('ei-karkausvuonna helmikuu päättyy 28. päivään', () => {
  // 2026 ei ole karkausvuosi: 28.2. on lauantai ja 1.3. sunnuntai.
  const days = weekDayIsoList(startOfWeek(day(2026, 2, 28)));
  assert.ok(days.includes('2026-02-28'));
  assert.equal(days.includes('2026-02-29'), false, 'olematon päivä ilmestyi');
  assert.ok(days.includes('2026-03-01'));
});

test('karkausvuoden viikkojen määrä säilyy', () => {
  // Vuoden jokainen päivä kuuluu johonkin viikkoon, eikä yksikään päivä saa
  // kuulua kahteen.
  const seen = new Map();
  let cursor = day(2028, 1, 1);
  const end = day(2029, 1, 1);

  while (cursor < end) {
    const iso = fmtISO(cursor);
    const monday = fmtISO(startOfWeek(cursor));
    assert.equal(seen.has(iso), false, `${iso} käsitelty kahdesti`);
    seen.set(iso, monday);
    cursor = addDays(cursor, 1);
  }

  assert.equal(seen.size, 366, 'karkausvuodessa pitää olla 366 päivää');
});

// ------------------------------------------------------- tyhjä viikko

test('tyhjä viikko ei kaadu eikä keksi lukuja', () => {
  const monday = startOfWeek(day(2026, 3, 9));
  const summary = weekSummary(monday, []);

  assert.equal(summary.length, 7);
  for (const dayEntry of summary) {
    assert.equal(dayEntry.total, 0);
    assert.equal(dayEntry.completed, 0);
    assert.equal(dayEntry.hasHighPriority, false);
  }
});

test('tyhjän viikon katsaus on nollia eikä NaN', () => {
  const review = buildWeeklyReview({
    tasks: [], goals: [], weekStartIso: '2026-03-09', todayIso: '2026-03-09'
  });

  assert.equal(review.stats.planned, 0);
  assert.equal(review.stats.completed, 0);
  assert.equal(review.stats.open, 0);
  assert.equal(review.stats.overdue, 0);
  // Valmistumisaste on tarkoituksella null eikä 0: nollasta tehtävästä ei
  // ole olemassa prosenttiosuutta, ja 0 % väittäisi että kaikki jäi tekemättä.
  // Olennaista on ettei se ole NaN, joka vuotaisi käyttöliittymään asti.
  assert.equal(review.stats.completionRate, null);
  assert.equal(Number.isNaN(review.stats.completionRate), false);
  assert.equal(review.days.length, 7);
});

test('groupByDate tyhjällä listalla palauttaa tyhjän ryhmittelyn', () => {
  // groupByDate palauttaa Mapin. Object.keys(map) on AINA tyhjä, joten
  // aiempi muotoilu olisi mennyt läpi vaikka ryhmittely olisi rikki.
  const groups = groupByDate([]);
  assert.ok(groups instanceof Map);
  assert.equal(groups.size, 0);

  const withTasks = groupByDate([task('t1', '2026-03-10')]);
  assert.equal(withTasks.size, 1);
  assert.equal(withTasks.get('2026-03-10').length, 1);
});

// --------------------------------------------------- kuormitettu viikko

test('raskaasti kuormitettu viikko lasketaan oikein', () => {
  const monday = startOfWeek(day(2026, 3, 9));
  const days = weekDayIsoList(monday);

  const tasks = [];
  for (const [index, dateIso] of days.entries()) {
    // Maanantaina 1, tiistaina 2, ... sunnuntaina 7 tehtävää.
    for (let n = 0; n <= index; n++) {
      // Korkean prioriteetin tehtävä jätetään AVOIMEKSI: valmis tehtävä ei
      // saa liputtaa päivää kiireiseksi, ja juuri sitä hasHighPriority
      // tarkoittaa.
      tasks.push(task(`${dateIso}-${n}`, dateIso, {
        completed: n !== 0 && n % 2 === 0,
        priority: n === 0 ? 'korkea' : 'normaali'
      }));
    }
  }

  const summary = weekSummary(monday, tasks);

  assert.equal(summary.length, 7);
  for (const [index, dayEntry] of summary.entries()) {
    assert.equal(dayEntry.total, index + 1, `päivä ${index}`);
    assert.ok(dayEntry.hasHighPriority, 'korkea prioriteetti pitäisi näkyä');
    assert.ok(dayEntry.completed <= dayEntry.total);
  }

  const total = summary.reduce((sum, dayEntry) => sum + dayEntry.total, 0);
  assert.equal(total, tasks.length, 'tehtäviä katosi tai monistui');
});

test('viikon ulkopuoliset tehtävät eivät vuoda yhteenvetoon', () => {
  const monday = startOfWeek(day(2026, 3, 9));
  const summary = weekSummary(monday, [
    task('edellinen', '2026-03-08'),  // sunnuntai ennen
    task('sisalla', '2026-03-11'),
    task('seuraava', '2026-03-16')    // maanantai jälkeen
  ]);

  const total = summary.reduce((sum, dayEntry) => sum + dayEntry.total, 0);
  assert.equal(total, 1, 'vain viikon oma tehtävä saa näkyä');
});

test('katsaus ei kadota eikä monista viikon tehtäviä', () => {
  const days = weekDayIsoList(startOfWeek(day(2026, 3, 9)));
  const tasks = days.flatMap((dateIso, index) => [
    task(`a${index}`, dateIso, { completed: true }),
    task(`b${index}`, dateIso, { completed: false })
  ]);

  const review = buildWeeklyReview({
    tasks, goals: [], weekStartIso: '2026-03-09', todayIso: '2026-03-09'
  });

  assert.equal(review.stats.planned, 14);
  assert.equal(review.stats.completed, 7);
  assert.equal(review.stats.open, 7);
  assert.equal(review.stats.completed + review.stats.open, review.stats.planned);
});

test('viikkokatsaus laskee myös vanhat rästit, ei vain tämän viikon', () => {
  // Rästi kolmen viikon takaa on yhä rästi. Jos katsaus rajaisi sen pois,
  // se antaisi liian ruusuisen kuvan juuri silloin kun sitä eniten tarvitaan.
  const review = buildWeeklyReview({
    tasks: [
      task('vanha', '2026-02-16'),
      task('tama', '2026-03-10')
    ],
    goals: [],
    weekStartIso: '2026-03-09',
    todayIso: '2026-03-12'
  });

  assert.ok(review.stats.overdue >= 1, 'vanha rästi puuttuu katsauksesta');
});

test('tavoitteiden eteneminen näkyy viikkokatsauksessa', () => {
  const goal = normalizeGoal({
    id: 'g1', title: 'Julkaise', status: 'active', progressMode: 'task_based'
  });
  const tasks = [
    task('t1', '2026-03-10', { goalId: 'g1', completed: true }),
    task('t2', '2026-03-11', { goalId: 'g1', completed: false })
  ];

  const review = buildWeeklyReview({
    tasks, goals: [goal], weekStartIso: '2026-03-09', todayIso: '2026-03-12'
  });

  assert.equal(review.goalProgress.length, 1);
  assert.equal(review.goalProgress[0].progress.percent, 50);
});

// ------------------------------------------------------ determinismi

test('viikkokatsaus on deterministinen', () => {
  const tasks = weekDayIsoList(startOfWeek(day(2026, 3, 9)))
    .map((dateIso, index) => task('t' + index, dateIso));

  const first = buildWeeklyReview({
    tasks, goals: [], weekStartIso: '2026-03-09', todayIso: '2026-03-09'
  });
  const second = buildWeeklyReview({
    tasks, goals: [], weekStartIso: '2026-03-09', todayIso: '2026-03-09'
  });

  assert.deepEqual(second, first);
});

test('viikon aloituspäivä normalisoidaan maanantaiksi myös katsauksessa', () => {
  // Käyttöliittymä antaa aina maanantain, mutta katsaus ei saa luottaa
  // siihen: keskellä viikkoa annettu päivä tuottaisi väärän seitsikon.
  const fromSunday = buildWeeklyReview({
    tasks: [], goals: [], weekStartIso: '2026-03-15', todayIso: '2026-03-15'
  });
  const fromMonday = buildWeeklyReview({
    tasks: [], goals: [], weekStartIso: '2026-03-09', todayIso: '2026-03-15'
  });

  assert.deepEqual(fromSunday.days.map(d => d.dateIso),
    fromMonday.days.map(d => d.dateIso));
});
