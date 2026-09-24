// Horisonttiaikatauluttaja: mille PÄIVILLE työ jaetaan.
//
// =====================================================================
// KAKSI ERI KYSYMYSTÄ, KAKSI ERI MOOTTORIA
// =====================================================================
//
//   MILLE PÄIVÄLLE?   tämä moduuli
//   MIHIN KOHTAAN PÄIVÄÄ?   src/domain/scheduler.js
//
// Olemassa oleva `proposeSchedule` sijoittaa kellonajat yhden päivän
// sisällä ja tekee sen hyvin. Sitä ei kirjoiteta tässä uudelleen: tämä
// moduuli päättää päivän, ja päivän sisäinen sijoitus jää sille
// moottorille joka jo osaa sen.
//
// Kaksi toteutusta samasta sijoituslogiikasta erkanisi ennemmin tai
// myöhemmin, ja toinen niistä rikkoisi "älä siirrä kiinteää" -lupauksen
// ilman että kukaan huomaa.
//
// =====================================================================
// PORTFOLIOTIETOINEN
// =====================================================================
//
// Tehtävät sijoitetaan YHTEEN JONOON kaikkien tavoitteiden kesken, ei
// tavoite kerrallaan. Tavoite kerrallaan optimoiva aikatauluttaja
// tuottaa suunnitelmia, joissa jokainen tavoite on erikseen mahdollinen
// ja kaikki yhdessä mahdottomia — ja se näyttää oikealta jokaisesta
// tavoitenäkymästä katsottuna.
//
// =====================================================================
// EI TÄYTETÄ JOKAISTA MINUUTTIA
// =====================================================================
//
// Kapasiteetti on jo puskuroitu (`capacity.js`), joten tämä moduuli saa
// käyttää sen `usableMinutes`-luvun kokonaan. Puskuri on kertaalleen
// vähennetty eikä sitä vähennetä toistamiseen.

import { isIsoDate, durationOf } from './task.js';
import { priorityWeight } from './priority.js';
import { DEFAULT_TASK_MINUTES } from './scheduler.js';
import { horizonCapacity, DEFAULT_BUFFER_RATIO } from './capacity.js';
import { AUTOMATION_LEVEL, normalizeAutomationLevel, canMoveTo } from './automation.js';

/**
 * Sijoituksen tulos yhdelle tehtävälle.
 *
 * `PLACED`  sai päivän
 * `KEPT`    oli jo kiinteästi paikallaan, ei koskettu
 * `UNPLACED` ei mahtunut mihinkään
 */
export const PLACEMENT = Object.freeze({
  PLACED: 'placed',
  KEPT: 'kept',
  UNPLACED: 'unplaced'
});

/**
 * Jonojärjestys.
 *
 * TÄMÄ ON KOKO PRIORISOINTISÄÄNTÖ YHDESSÄ PAIKASSA:
 *
 *   1. riippuvuudet ensin (topologinen taso)
 *   2. määräpäivä (aikaisempi ensin, päivätön viimeisenä)
 *   3. tavoitteen prioriteetti
 *   4. tehtävän prioriteetti
 *   5. nimi — takaa determinismin
 *
 * Määräpäivä ennen prioriteettia on tietoinen valinta: korkea
 * prioriteetti ilman määräpäivää ei saa syrjäyttää huomenna erääntyvää
 * normaalia työtä. Kiire on tosiasia, prioriteetti on mielipide.
 */
function compareCandidates(a, b) {
  if (a.level !== b.level) return a.level - b.level;

  const aDate = a.task.date || '9999-12-31';
  const bDate = b.task.date || '9999-12-31';
  if (aDate !== bDate) return aDate.localeCompare(bDate);

  if (a.goalWeight !== b.goalWeight) return a.goalWeight - b.goalWeight;

  const byPriority = priorityWeight(a.task.priority) - priorityWeight(b.task.priority);
  if (byPriority !== 0) return byPriority;

  return String(a.task.title ?? '').localeCompare(String(b.task.title ?? ''), 'fi');
}

/**
 * Riippuvuustasot.
 *
 * Taso 0 = ei riippuvuuksia. Taso n = syvin edeltäjä on tasolla n-1.
 * Näin edeltäjä sijoitetaan aina ennen seuraajaansa ilman että
 * sijoitusvaiheen pitää tietää riippuvuuksista mitään.
 *
 * KEHÄ EI KAADA MITÄÄN. Kehässä oleva tehtävä saa tason, jonka se
 * saavuttaa ennen kuin vierailuraja täyttyy — sijoitus jatkuu ja kehä
 * raportoidaan ristiriitana (`conflicts.js`). Kaatuminen olisi huonompi
 * vastaus: käyttäjä ei näkisi suunnitelmaansa lainkaan.
 */
export function dependencyLevels(tasks = []) {
  const byId = new Map(tasks.filter(Boolean).map(task => [task.id, task]));
  const levels = new Map();
  const visiting = new Set();

  const levelOf = (task, depth) => {
    if (!task) return 0;
    if (levels.has(task.id)) return levels.get(task.id);
    // Kehäsuoja: syvyys ei voi ylittää tehtävien määrää.
    if (depth > byId.size || visiting.has(task.id)) return 0;

    visiting.add(task.id);
    let level = 0;
    for (const dependencyId of task.dependsOn || []) {
      const dependency = byId.get(String(dependencyId));
      if (!dependency || dependency.completed) continue;
      level = Math.max(level, levelOf(dependency, depth + 1) + 1);
    }
    visiting.delete(task.id);

    levels.set(task.id, level);
    return level;
  };

  for (const task of tasks) if (task) levelOf(task, 0);
  return levels;
}

/**
 * Jaa työ päiville.
 *
 * @param {object} input
 * @param {Array}  input.tasks       kaikki tehtävät
 * @param {Array}  [input.goals]     tavoitteet prioriteettia varten
 * @param {object} [input.profile]
 * @param {string} input.fromIso
 * @param {string} input.toIso
 * @param {Array}  [input.routines]
 * @param {Array}  [input.exceptions]
 * @param {number} [input.automationLevel]
 * @param {number} [input.bufferRatio]
 * @returns {{placements: Array, unplaced: Array, days: Array, moves: Array}}
 */
export function planHorizon({
  tasks = [],
  goals = [],
  profile,
  fromIso,
  toIso,
  routines = [],
  exceptions = [],
  automationLevel = AUTOMATION_LEVEL.SUGGEST_ONLY,
  bufferRatio = DEFAULT_BUFFER_RATIO
} = {}) {
  const level = normalizeAutomationLevel(automationLevel);

  if (!isIsoDate(fromIso) || !isIsoDate(toIso) || toIso < fromIso) {
    return { placements: [], unplaced: [], days: [], moves: [] };
  }

  const capacity = horizonCapacity({
    tasks, profile, fromIso, toIso, routines, exceptions, bufferRatio
  });

  // Kulutettava kopio. Alkuperäistä ei muteta.
  const days = capacity.days.map(day => ({
    dateIso: day.dateIso,
    remainingMinutes: day.usableMinutes,
    usableMinutes: day.usableMinutes,
    placed: []
  }));

  const goalPriority = new Map(
    goals.filter(Boolean).map(goal => [goal.id, priorityWeight(goal.priority)]));

  const levels = dependencyLevels(tasks);

  // EHDOKKAAT: keskeneräiset ja SIIRRETTÄVISSÄ OLEVAT.
  //
  // Kiinteä työ on jo laskettu kapasiteettiin varattuna aikana. Se ei
  // ole ehdokas — se on maasto, jonka läpi muu työ kiertää.
  const candidates = tasks
    .filter(task => task && !task.completed && isMovable(task))
    .map(task => ({
      task,
      level: levels.get(task.id) ?? 0,
      goalWeight: goalPriority.get(task.goalId) ?? 99,
      needed: durationOf(task) ?? task.durationMinutes ?? DEFAULT_TASK_MINUTES
    }))
    .sort(compareCandidates);

  const placements = [];
  const unplaced = [];
  const moves = [];

  // Riippuvuuden sijoituspäivä: seuraaja ei saa mennä sitä ennen.
  const placedDate = new Map();

  for (const candidate of candidates) {
    const task = candidate.task;

    // AIKAISIN SALLITTU PÄIVÄ: horisontin alku tai edeltäjän päivä.
    let earliest = fromIso;
    for (const dependencyId of task.dependsOn || []) {
      const date = placedDate.get(String(dependencyId));
      if (date && date > earliest) earliest = date;
    }

    // MYÖHÄISIN SALLITTU PÄIVÄ: tehtävän oma määräpäivä.
    //
    // Määräpäivän jälkeen sijoittaminen olisi ehdotus, joka rikkoo sen
    // mitä käyttäjä pyysi. Ennemmin `unplaced` ja näkyvä ristiriita.
    const latest = task.date && task.date <= toIso ? task.date : toIso;

    const dayIndex = days.findIndex(day =>
      day.dateIso >= earliest
      && day.dateIso <= latest
      && day.remainingMinutes >= candidate.needed);

    if (dayIndex === -1) {
      unplaced.push({
        task,
        reason: buildUnplacedReason(task, candidate, earliest, latest)
      });
      continue;
    }

    const day = days[dayIndex];
    day.remainingMinutes -= candidate.needed;
    day.placed.push(task.id);
    placedDate.set(task.id, day.dateIso);

    const kept = task.date === day.dateIso;

    placements.push({
      taskId: task.id,
      title: task.title,
      fromDateIso: task.date || null,
      toDateIso: day.dateIso,
      minutes: candidate.needed,
      result: kept ? PLACEMENT.KEPT : PLACEMENT.PLACED,
      goalId: task.goalId || null,
      reason: buildPlacementReason(task, candidate, day, kept)
    });

    // SIIRTO ON ERI ASIA KUIN SIJOITUS.
    //
    // Sijoitus antaa päivättömälle tehtävälle päivän. Siirto muuttaa
    // olemassa olevaa päivää, ja vain siirto tarvitsee automaatiotason
    // luvan.
    if (task.date && !kept) {
      moves.push({
        taskId: task.id,
        title: task.title,
        fromDateIso: task.date,
        toDateIso: day.dateIso,
        allowed: canMoveTo(level, task.date, day.dateIso, { horizonEndIso: toIso }),
        reason: buildPlacementReason(task, candidate, day, false)
      });
    }
  }

  return { placements, unplaced, days, moves, capacity };
}

/**
 * Onko tehtävä siirrettävissä?
 *
 * Sama sääntö kuin `isMovableByScheduler` (src/domain/task.js), mutta
 * PÄIVÄTASOLLA: tehtävä, jolla ei ole kellonaikaa mutta on päivä, on
 * siirrettävissä toiselle päivälle vaikkei se ole kellonajan suhteen
 * "ajastettu".
 *
 * Kellonajan asettaminen on se ele, joka kiinnittää. Pelkkä päivä ei
 * ole lupaus tunnista.
 */
export function isMovable(task) {
  if (!task || task.completed) return false;
  if (task.isWake) return false;
  // Kellonaika + manuaalinen tila = käyttäjän oma päätös. Koskematon.
  if (task.time && task.schedulingState !== 'auto') return false;
  return true;
}

function buildPlacementReason(task, candidate, day, kept) {
  const parts = [];

  if (kept) {
    parts.push('Pysyy paikallaan');
  } else if (task.date) {
    parts.push(`Siirretään ${task.date} → ${day.dateIso}`);
  } else {
    parts.push(`Ehdotettu päivä ${day.dateIso}`);
  }

  if (candidate.level > 0) {
    parts.push('odottaa edeltävää tehtävää');
  }

  if (task.date && task.date < day.dateIso) {
    parts.push('aikaisemmilla päivillä ei ollut tilaa');
  }

  parts.push(`vie ${candidate.needed} min, päivässä oli ${day.usableMinutes} min tilaa`);

  return parts.join(', ') + '.';
}

function buildUnplacedReason(task, candidate, earliest, latest) {
  if (latest < earliest) {
    return `Ei sijoitettavissa: edeltävä tehtävä valmistuu vasta ${earliest}, `
      + `mutta määräpäivä on ${latest}.`;
  }
  if (task.date && task.date < earliest) {
    return `Ei sijoitettavissa: määräpäivä ${task.date} on ennen kuin edeltävä `
      + `tehtävä ehtii valmistua (${earliest}).`;
  }
  return `Ei sijoitettavissa: tarvitsee ${candidate.needed} min, eikä välillä `
    + `${earliest}–${latest} ole päivää jossa olisi niin paljon vapaata.`;
}

/**
 * Kuinka täyteen horisontti menisi?
 *
 * Käytetään yhteenvedossa ja perusteluissa. `ratio` yli 1 ei voi
 * syntyä, koska sijoitus ei ylitä kapasiteettia — sen sijaan
 * ylimääräinen työ näkyy `unplaced`-listassa, ja juuri se on
 * rehellinen tapa kertoa ettei kaikki mahdu.
 */
export function summarizeHorizon(result) {
  if (!result) return null;

  const totalUsable = result.days.reduce((sum, day) => sum + day.usableMinutes, 0);
  const totalPlaced = result.placements.reduce((sum, p) => sum + p.minutes, 0);

  return {
    dayCount: result.days.length,
    placedCount: result.placements.length,
    keptCount: result.placements.filter(p => p.result === PLACEMENT.KEPT).length,
    movedCount: result.moves.length,
    unplacedCount: result.unplaced.length,
    totalUsableMinutes: totalUsable,
    totalPlacedMinutes: totalPlaced,
    ratio: totalUsable === 0 ? null : Math.round((totalPlaced / totalUsable) * 100) / 100,
    /** Päivät joilla ei ole enää tilaa. */
    fullDays: result.days.filter(day => day.remainingMinutes === 0
      && day.usableMinutes > 0).length
  };
}
