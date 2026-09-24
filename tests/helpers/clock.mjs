// Jäädytetty kello testeille: suhteelliset päivät ("huomenna") eivät saa
// riippua ajopäivästä.
//
// Käyttää node:testin omaa testikohtaista mockia (t.mock.timers), joka
// palautetaan automaattisesti testin lopussa. Vain Date jäädytetään;
// setTimeout/Promise jatkavat normaalisti, joten async-koodi toimii.
//
// Hetki annetaan PAIKALLISENA seinäkelloaikana ja oletuksena keskipäivällä:
// keskipäivä on kaukana vuorokauden rajasta, joten ajoympäristön
// aikavyöhyke tai kesäaika ei voi siirtää "tänään"-päivää.

/**
 * @param {import('node:test').TestContext} t
 * @param {string} isoDate YYYY-MM-DD (paikallinen päivä)
 * @param {string} [time='12:00'] HH:MM paikallista aikaa
 * @returns {Date} jäädytetty hetki
 */
export function freezeLocalDate(t, isoDate, time = '12:00') {
  const [year, month, day] = isoDate.split('-').map(Number);
  const [hours, minutes] = time.split(':').map(Number);
  const moment = new Date(year, month - 1, day, hours, minutes, 0, 0);
  if (Number.isNaN(moment.getTime())) throw new Error('freezeLocalDate: virheellinen hetki ' + isoDate + ' ' + time);
  t.mock.timers.enable({ apis: ['Date'], now: moment.getTime() });
  return moment;
}
