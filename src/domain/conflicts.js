// Ristiriitojen tunnistus.
//
// =====================================================================
// MAHDOTONTA SUUNNITELMAA EI SAA PIILOTTAA OPTIMISTISEN SANAMUODON TAAKSE
// =====================================================================
//
// Suunnittelija, joka sanoo "tiukka mutta tehtävissä" tilanteessa jossa
// työtä on 18 tuntia ja aikaa 10, ei ole kohtelias vaan epärehellinen.
// Käyttäjä tekee päätöksiä sen lauseen varassa.
//
// Siksi vakavuus on kolmiportainen ja sen raja on määritelty:
//
//   INFO      huomionarvoista, ei estä mitään
//   WARNING   suunnitelma toteutuu vain jos kaikki menee hyvin
//   BLOCKING  suunnitelma ei voi toteutua sellaisenaan
//
// BLOCKING ei estä käyttäjää hyväksymästä suunnitelmaa. Se estää
// järjestelmää väittämästä, että suunnitelma on kunnossa. Päätös on
// käyttäjän; totuus ei ole.

import { isIsoDate, durationOf, overlaps } from './task.js';
import { DEFAULT_TASK_MINUTES } from './scheduler.js';
import { outOfOrderMilestones } from './milestone.js';
import { feasibility, dailyRequirement } from './capacity.js';

/** Ristiriidan vakavuus. */
export const SEVERITY = Object.freeze({
  INFO: 'info',
  WARNING: 'warning',
  BLOCKING: 'blocking'
});

/** Vakavuuden järjestys, vakavin ensin. */
const SEVERITY_ORDER = Object.freeze({
  [SEVERITY.BLOCKING]: 0,
  [SEVERITY.WARNING]: 1,
  [SEVERITY.INFO]: 2
});

/** Ristiriidan laji. Koodi on sopimus, teksti ei. */
export const CONFLICT = Object.freeze({
  /** Kaksi kiinteää sitoumusta samaan aikaan. */
  OVERLAP: 'overlap',
  /** Määräaika on menneisyydessä. */
  DEADLINE_PAST: 'deadline_past',
  /** Työtä on enemmän kuin aikaa. */
  INSUFFICIENT_CAPACITY: 'insufficient_capacity',
  /** Aika riittää vain juuri ja juuri. */
  TIGHT_CAPACITY: 'tight_capacity',
  /** Välitavoitteiden päivät ovat väärässä järjestyksessä. */
  MILESTONE_ORDER: 'milestone_order',
  /** Välitavoite on tavoitteen määräpäivän jälkeen. */
  MILESTONE_AFTER_GOAL: 'milestone_after_goal',
  /** Riippuvuus on ajoitettu ennen edeltäjäänsä. */
  DEPENDENCY_ORDER: 'dependency_order',
  /** Useampi tavoite kilpailee samasta ajasta. */
  PORTFOLIO_OVERCOMMIT: 'portfolio_overcommit',
  /** Päivä on ahdettu täyteen. */
  DAY_OVERLOADED: 'day_overloaded',
  /** Kestoarvio puuttuu monelta tehtävältä. */
  WEAK_ESTIMATES: 'weak_estimates'
});

/**
 * Kuinka täyteen kapasiteetti saa mennä ennen varoitusta.
 *
 * 0,85 tarkoittaa: kun suunniteltu työ vie yli 85 % käytettävissä
 * olevasta ajasta, suunnitelma toteutuu vain jos mikään ei mene
 * pieleen. Se on varoituksen arvoinen tieto, ei este.
 */
export const TIGHT_RATIO = 0.85;

/** Montako tehtävää päivässä on merkki ahtaudesta. */
export const CROWDED_TASKS_PER_DAY = 8;

/** Kuinka suuri osa kestoarvioista saa olla arvattuja ilman huomautusta. */
export const WEAK_ESTIMATE_RATIO = 0.5;

function conflict(code, severity, message, extra = {}) {
  return Object.freeze({ code, severity, message, ...extra });
}

/**
 * Järjestä ristiriidat vakavimmasta lievimpään.
 *
 * Deterministinen: saman vakavuuden sisällä koodin ja viestin mukaan.
 * Käyttöliittymä näyttää nämä listana, eikä lista saa hyppiä
 * renderöintien välillä.
 */
export function sortConflicts(conflicts = []) {
  return [...conflicts].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const byCode = String(a.code).localeCompare(String(b.code));
    if (byCode !== 0) return byCode;
    return String(a.message).localeCompare(String(b.message), 'fi');
  });
}

/** Onko joukossa estävä ristiriita? */
export function hasBlocking(conflicts = []) {
  return conflicts.some(c => c && c.severity === SEVERITY.BLOCKING);
}

/** Vakavin vakavuus joukossa, tai null. */
export function worstSeverity(conflicts = []) {
  if (!conflicts.length) return null;
  return sortConflicts(conflicts)[0].severity;
}

// =====================================================================
// PÄÄLLEKKÄISYYS
// =====================================================================

/**
 * Kaksi kiinteää sitoumusta samaan aikaan.
 *
 * VAIN KIINTEÄT lasketaan. Joustava työ, joka osuu päällekkäin, on
 * sijoitusvirhe jonka aikatauluttaja korjaa — kiinteä päällekkäisyys
 * on käyttäjän oma ristiriita, jota kukaan muu ei voi ratkaista.
 */
export function detectOverlaps(tasks = []) {
  const timed = tasks
    .filter(task => task && task.time && !task.completed
      && task.schedulingState !== 'auto')
    .sort((a, b) => String(a.date).localeCompare(String(b.date))
      || String(a.time).localeCompare(String(b.time)));

  const found = [];

  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      if (timed[i].date !== timed[j].date) break;
      if (!overlaps(timed[i], timed[j])) continue;

      found.push(conflict(
        CONFLICT.OVERLAP,
        SEVERITY.BLOCKING,
        `"${timed[i].title}" ja "${timed[j].title}" ovat samaan aikaan `
        + `${timed[i].date} klo ${timed[i].time}.`,
        { taskIds: [timed[i].id, timed[j].id], dateIso: timed[i].date }
      ));
    }
  }

  return found;
}

// =====================================================================
// MÄÄRÄAIKA JA KAPASITEETTI
// =====================================================================

/**
 * Riittääkö aika tavoitteen työhön?
 *
 * @param {object} input
 * @param {object} input.goal
 * @param {object} input.remaining  remainingWork(...)
 * @param {object} input.capacity   horizonCapacity(...) tai null
 * @param {string} input.todayIso
 */
export function detectCapacityConflicts({ goal, remaining, capacity, todayIso } = {}) {
  const found = [];
  if (!goal) return found;

  const name = goal.title || 'Tavoite';

  if (goal.targetDate && isIsoDate(todayIso) && goal.targetDate < todayIso) {
    found.push(conflict(
      CONFLICT.DEADLINE_PAST,
      SEVERITY.BLOCKING,
      `Tavoitteen "${name}" määräpäivä ${goal.targetDate} on mennyt.`,
      { goalId: goal.id }
    ));
    // Menneelle määräpäivälle ei lasketa kapasiteettia: kysymys "ehtiikö"
    // ei ole enää voimassa, ja siihen vastaaminen olisi harhaanjohtavaa.
    return found;
  }

  if (!remaining || !capacity) return found;

  const fit = feasibility({ remaining, capacity });
  if (fit.feasible === null) return found;

  if (!fit.feasible) {
    const perDay = dailyRequirement(fit.requiredMinutes, capacity.dayCount);
    found.push(conflict(
      CONFLICT.INSUFFICIENT_CAPACITY,
      SEVERITY.BLOCKING,
      `Tavoite "${name}" ei mahdu: jäljellä on noin ${hours(fit.requiredMinutes)} työtä `
      + `ja määräpäivään mennessä suunniteltavaa aikaa ${hours(fit.availableMinutes)}.`
      + (perDay ? ` Se olisi ${perDay} min joka päivä.` : ''),
      {
        goalId: goal.id,
        requiredMinutes: fit.requiredMinutes,
        availableMinutes: fit.availableMinutes,
        ratio: fit.ratio
      }
    ));
  } else if (fit.ratio >= TIGHT_RATIO) {
    found.push(conflict(
      CONFLICT.TIGHT_CAPACITY,
      SEVERITY.WARNING,
      `Tavoite "${name}" on tiukka: työ vie noin ${Math.round(fit.ratio * 100)} % `
      + 'käytettävissä olevasta ajasta. Suunnitelma toteutuu vain jos mikään ei mene pieleen.',
      { goalId: goal.id, ratio: fit.ratio }
    ));
  }

  // Heikko arviopohja ei ole ristiriita vaan epävarmuus. Se kerrotaan,
  // koska yllä olevat luvut nojaavat siihen.
  if (remaining.taskCount > 0 && remaining.estimateRatio > WEAK_ESTIMATE_RATIO) {
    found.push(conflict(
      CONFLICT.WEAK_ESTIMATES,
      SEVERITY.INFO,
      `${remaining.estimatedCount}/${remaining.taskCount} tehtävältä puuttuu kestoarvio, `
      + 'joten yllä olevat aika-arviot ovat karkeita.',
      { goalId: goal.id }
    ));
  }

  return found;
}

function hours(minutes) {
  const n = Number(minutes) || 0;
  if (n < 60) return `${n} min`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

// =====================================================================
// VÄLITAVOITTEET JA RIIPPUVUUDET
// =====================================================================

/** Välitavoitteiden järjestys ja suhde tavoitteen määräpäivään. */
export function detectMilestoneConflicts({ goal, milestones = [] } = {}) {
  const found = [];
  if (!goal) return found;

  for (const { after, before } of outOfOrderMilestones(milestones, goal.id)) {
    found.push(conflict(
      CONFLICT.MILESTONE_ORDER,
      SEVERITY.BLOCKING,
      `Välitavoite "${after.title}" (${after.targetDate}) on jonossa myöhemmin `
      + `kuin "${before.title}" (${before.targetDate}), mutta sen päivä on aikaisempi.`,
      { goalId: goal.id, milestoneIds: [before.id, after.id] }
    ));
  }

  if (goal.targetDate) {
    const late = milestones.filter(m =>
      m && m.goalId === goal.id
      && m.status === 'open'
      && m.targetDate
      && m.targetDate > goal.targetDate);

    for (const milestone of late) {
      found.push(conflict(
        CONFLICT.MILESTONE_AFTER_GOAL,
        SEVERITY.WARNING,
        `Välitavoite "${milestone.title}" (${milestone.targetDate}) on tavoitteen `
        + `määräpäivän ${goal.targetDate} jälkeen.`,
        { goalId: goal.id, milestoneIds: [milestone.id] }
      ));
    }
  }

  return found;
}

/**
 * Riippuvuudet: edeltäjä ei saa olla seuraajansa jälkeen.
 *
 * Riippuvuus luetaan tehtävän `dependsOn`-listasta. Se on
 * SOVELLUSTASON käsite eikä kannassa: nykyinen skeema ei tunne
 * riippuvuuksia, ja niiden lisääminen on migraatiokysymys. Ks.
 * docs/GOAL-TO-ACTION.md.
 *
 * Puuttuva edeltäjä ohitetaan hiljaa: se on eri vika, ja siitä
 * huomauttaminen tässä sekoittaisi kaksi asiaa.
 */
export function detectDependencyConflicts(tasks = []) {
  const byId = new Map(tasks.filter(Boolean).map(task => [task.id, task]));
  const found = [];

  for (const task of tasks) {
    if (!task || !Array.isArray(task.dependsOn) || task.dependsOn.length === 0) continue;
    if (!task.date) continue;

    for (const dependencyId of task.dependsOn) {
      const dependency = byId.get(String(dependencyId));
      if (!dependency || !dependency.date) continue;
      if (dependency.completed) continue;

      if (dependency.date > task.date) {
        found.push(conflict(
          CONFLICT.DEPENDENCY_ORDER,
          SEVERITY.BLOCKING,
          `"${task.title}" (${task.date}) on ajoitettu ennen kuin "${dependency.title}" `
          + `(${dependency.date}) on tehty.`,
          { taskIds: [dependency.id, task.id] }
        ));
      }
    }
  }

  return found;
}

// =====================================================================
// PORTFOLIO
// =====================================================================

/**
 * Kilpailevatko useat tavoitteet samasta ajasta?
 *
 * TÄMÄ ON SE VIKA, JONKA TAVOITEKOHTAINEN TARKISTUS EI LÖYDÄ.
 *
 * Jokainen tavoite voi olla erikseen täysin mahdollinen ja kaikki
 * yhdessä silti mahdottomia. Aikatauluttaja, joka optimoi tavoitteet
 * yksi kerrallaan, tuottaa juuri sellaisen suunnitelman — ja se
 * näyttää oikealta jokaisesta tavoitenäkymästä katsottuna.
 *
 * @param {Array<{goal:object, remaining:object}>} entries
 * @param {object} capacity  koko horisontin kapasiteetti
 */
export function detectPortfolioConflicts(entries = [], capacity = null) {
  if (!capacity || entries.length < 2) return [];

  const totalRequired = entries.reduce(
    (total, entry) => total + (entry.remaining?.minutes || 0), 0);

  const available = capacity.totalUsableMinutes;
  if (available <= 0 || totalRequired <= available) return [];

  const names = entries
    .map(entry => entry.goal?.title)
    .filter(Boolean)
    .slice(0, 3)
    .join(', ');

  return [conflict(
    CONFLICT.PORTFOLIO_OVERCOMMIT,
    SEVERITY.BLOCKING,
    `${entries.length} tavoitetta vaativat yhteensä noin ${hours(totalRequired)}, `
    + `mutta suunniteltavaa aikaa on ${hours(available)}. `
    + `Erikseen jokainen voi olla mahdollinen — yhdessä ne eivät ole. (${names})`,
    {
      goalIds: entries.map(entry => entry.goal?.id).filter(Boolean),
      requiredMinutes: totalRequired,
      availableMinutes: available
    }
  )];
}

/** Yksittäisen päivän ahtaus. */
export function detectDayOverload(capacityDays = []) {
  const found = [];

  for (const day of capacityDays) {
    if (!day) continue;
    const planned = day.counts.fixed + day.counts.flexible + day.counts.routines;

    if (day.usableMinutes === 0 && planned >= CROWDED_TASKS_PER_DAY) {
      found.push(conflict(
        CONFLICT.DAY_OVERLOADED,
        SEVERITY.WARNING,
        `${day.dateIso}: ${planned} asiaa eikä vapaata aikaa jäljellä.`,
        { dateIso: day.dateIso }
      ));
    }
  }

  return found;
}

// =====================================================================
// KOKOAVA
// =====================================================================

/**
 * Kaikki ristiriidat yhdessä, vakavimmasta lievimpään.
 *
 * Tämä on se funktio, jota käyttöliittymä kutsuu. Osien erillisyys on
 * testejä ja uudelleenkäyttöä varten — kutsujan ei tarvitse tietää
 * montako tarkistusta on olemassa.
 */
export function detectAllConflicts({
  goal = null,
  goals = [],
  milestones = [],
  tasks = [],
  remaining = null,
  capacity = null,
  portfolioEntries = [],
  todayIso = null
} = {}) {
  const found = [
    ...detectOverlaps(tasks),
    ...detectDependencyConflicts(tasks),
    ...detectDayOverload(capacity?.days || [])
  ];

  if (goal) {
    found.push(...detectCapacityConflicts({ goal, remaining, capacity, todayIso }));
    found.push(...detectMilestoneConflicts({ goal, milestones }));
  }

  if (portfolioEntries.length > 1) {
    found.push(...detectPortfolioConflicts(portfolioEntries, capacity));
  }

  void goals;
  return sortConflicts(found);
}
