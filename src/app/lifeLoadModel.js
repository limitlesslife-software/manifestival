// Elämän kuorma sovelluskerrokselle: YKSI tulos, monta lukijaa.
//
// Tänään (Rauhallinen tänään), avustajan NYT/SEURAAVA, Tallessa-näkymä,
// sunnuntain nollaus ja ilmoitukset kysyvät saman asian: mikä on tänään
// fokuksessa ja mikä on tallessa. Tämä moduuli kokoaa puhtaan moottorin
// (src/domain/lifeLoad.js computeLifeLoad) syötteet tilasta ja muistaa
// tuloksen niin kauan kuin tila ja päivä pysyvät samoina: kaksi näkymää ei
// voi saada eri vastausta, eikä raskasta laskentaa tehdä joka piirrossa.
//
// Kapasiteetti tulee kapasiteettijarrusta (src/app/capacityBrake.js
// loadCapacity): uni, kiinteät menot, matkat, suojattu aika, loma, puskuri,
// viikon vähimmäisvapaa-aika ja unen vaje on varattu ennen fokusta.
//
// Ei DOM:ia eikä kirjoituksia.

import { computeLifeLoad } from '../domain/lifeLoad.js';
import { loadCapacity } from './capacityBrake.js';
import { weeklyPlanFor } from '../domain/weeklyPlan.js';
import { weekStartOf } from '../domain/weeklyCapacity.js';
import { entryForDate } from '../domain/wellbeing.js';
import { isIsoDate } from '../domain/task.js';
import { logEvent } from '../lib/logger.js';

let cache = null;

/** Vain testeille: unohda muistettu tulos. */
export function resetLifeLoadCache() {
  cache = null;
}

/**
 * Tämän päivän elämän kuorma tilasta.
 *
 * @param {object} state getState()
 * @param {{todayIso:string, nowMinutes?:number|null}} options
 * @returns {Readonly<object>|null}
 */
export function lifeLoadFor(state, { todayIso, nowMinutes = null } = {}) {
  if (!state || !isIsoDate(todayIso)) return null;
  if (cache && cache.state === state && cache.todayIso === todayIso) return cache.load;
  let capacity = null;
  try {
    capacity = loadCapacity(state, { todayIso, nowMinutes });
  } catch {
    // Kapasiteetin laskennan vika ei saa tyhjentää fokusta: ilman lukua
    // fokus rajataan vain määrään (enintään kolme).
    logEvent('lifeLoad.capacity_failed', { code: 'capacity' });
  }
  const entry = entryForDate(state.wellbeing || [], todayIso);
  const load = computeLifeLoad({
    tasks: state.tasks,
    bills: state.bills,
    goals: state.goals,
    projects: state.projects,
    lifeAreas: state.lifeAreas,
    weeklyPlan: weeklyPlanFor(state.weeklyPlans, weekStartOf(todayIso)),
    todayIso,
    capacity,
    energy: entry && Number.isInteger(entry.energy) ? { level: entry.energy } : null
  });
  const result = Object.freeze({ ...load, vacation: Boolean(capacity && capacity.vacation), capacityDay: capacity ? capacity.today : null });
  cache = { state, todayIso, load: result };
  return result;
}

/** Tämän päivän fokuksen tehtävätunnisteet (muut näkymät välttävät kaksoisesiintymisen). */
export function focusTaskIds(load) {
  return new Set((load ? load.now : []).filter(entry => entry.kind === 'task').map(entry => entry.id));
}
