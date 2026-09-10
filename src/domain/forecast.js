// Valmistumisennuste.
//
// =====================================================================
// HEIKKOA ENNUSTETTA EI ESITETÄ VARMUUTENA
// =====================================================================
//
// Ennuste on laskelma kahdesta epävarmasta luvusta: kuinka nopeasti työ
// on edennyt tähän asti, ja kuinka paljon aikaa on jäljellä. Kumpikin
// voi olla pielessä, ja niiden tulo voi olla pahasti pielessä.
//
// Siksi jokainen vastaus kantaa mukanaan LAADUN:
//
//   quality: 'good'    tarpeeksi historiaa ja kestoarvioita
//   quality: 'weak'    laskettavissa, mutta ohuella pohjalla
//   quality: 'none'    ei laskettavissa -> tila on INSUFFICIENT_DATA
//
// "At risk" hyvällä laadulla ja "at risk" heikolla laadulla ovat eri
// väitteitä. Käyttöliittymä näyttää eron, koska käyttäjä tekee eri
// päätöksiä niiden perusteella.
//
// =====================================================================
// EI ENNUSTETA ILMAN MÄÄRÄPÄIVÄÄ
// =====================================================================
//
// Määräpäivätön tavoite ei ole myöhässä eikä aikataulussa. Se on
// määräpäivätön. `INSUFFICIENT_DATA` on siihen oikea vastaus, ja se on
// eri asia kuin "aikataulussa".

import { isIsoDate } from './task.js';
import { fmtISO, parseISO, addDays } from '../lib/datetime.js';
import { feasibility, dailyRequirement } from './capacity.js';

/** Ennusteen tila. */
export const FORECAST = Object.freeze({
  /** Nykyvauhdilla ehtii. */
  ON_TRACK: 'on_track',
  /** Ehtii vain jos mikään ei mene pieleen. */
  AT_RISK: 'at_risk',
  /** Ei ehdi nykyvauhdilla. */
  DELAYED: 'delayed',
  /** Ei tarpeeksi tietoa. EI SAMA KUIN "aikataulussa". */
  INSUFFICIENT_DATA: 'insufficient_data'
});

/** Ennusteen laatu. */
export const FORECAST_QUALITY = Object.freeze({
  GOOD: 'good',
  WEAK: 'weak',
  NONE: 'none'
});

const STATE_LABELS = Object.freeze({
  [FORECAST.ON_TRACK]: 'Aikataulussa',
  [FORECAST.AT_RISK]: 'Vaarassa',
  [FORECAST.DELAYED]: 'Myöhässä',
  [FORECAST.INSUFFICIENT_DATA]: 'Ei tarpeeksi tietoa'
});

export function forecastLabel(state) {
  return STATE_LABELS[state] || STATE_LABELS[FORECAST.INSUFFICIENT_DATA];
}

const QUALITY_LABELS = Object.freeze({
  [FORECAST_QUALITY.GOOD]: 'Luotettava',
  [FORECAST_QUALITY.WEAK]: 'Karkea',
  [FORECAST_QUALITY.NONE]: 'Ei laskettavissa'
});

export function forecastQualityLabel(quality) {
  return QUALITY_LABELS[quality] || QUALITY_LABELS[FORECAST_QUALITY.NONE];
}

/**
 * Kuinka täyteen kapasiteetti saa mennä ennen kuin tila on AT_RISK.
 *
 * Sama luku kuin `conflicts.js`:n TIGHT_RATIO, mutta tarkoituksella
 * oma vakionsa: ristiriita ja ennuste ovat eri kysymyksiä, ja niiden
 * rajojen on voitava erota ilman että toisen muuttaminen liikuttaa
 * toista huomaamatta.
 */
export const RISK_RATIO = 0.85;

/** Montako päivää historiaa tarvitaan luotettavaan vauhtiarvioon. */
export const MIN_HISTORY_DAYS = 14;

/** Montako valmista tehtävää tarvitaan luotettavaan vauhtiarvioon. */
export const MIN_COMPLETED_TASKS = 3;

/**
 * Kuinka suuri osa kestoarvioista saa olla arvattuja, jotta ennuste on
 * yhä hyvälaatuinen.
 */
export const MAX_ESTIMATE_RATIO = 0.5;

function insufficient(reason) {
  return Object.freeze({
    state: FORECAST.INSUFFICIENT_DATA,
    quality: FORECAST_QUALITY.NONE,
    reason,
    requiredMinutes: null,
    availableMinutes: null,
    ratio: null,
    perDayMinutes: null,
    projectedDoneDate: null,
    velocityPerWeek: null
  });
}

/**
 * Toteutunut vauhti: valmiita tehtäviä viikossa.
 *
 * Lasketaan VALMISTUMISPÄIVÄSTÄ, ei luontipäivästä. Tehtävä, joka
 * luotiin kuukausi sitten ja tehtiin eilen, kertoo eilisen vauhdista.
 *
 * Palauttaa `null` kun historiaa ei ole tarpeeksi. Yhdestä valmiista
 * tehtävästä laskettu vauhti on arvaus, joka esiintyy mittauksena.
 */
export function velocity(tasks = [], todayIso, windowDays = MIN_HISTORY_DAYS) {
  if (!isIsoDate(todayIso)) return null;

  const fromIso = fmtISO(addDays(parseISO(todayIso), -Math.abs(windowDays)));

  const completed = tasks.filter(task =>
    task && task.completed && task.date && task.date >= fromIso && task.date <= todayIso);

  if (completed.length < MIN_COMPLETED_TASKS) return null;

  const weeks = Math.max(1, windowDays / 7);
  return Math.round((completed.length / weeks) * 10) / 10;
}

/**
 * Valmistumisennuste.
 *
 * @param {object} input
 * @param {object} input.goal
 * @param {object} input.remaining  remainingWork(...)
 * @param {object} input.capacity   capacityUntil(...) tai null
 * @param {Array}  [input.tasks]    vauhdin laskentaan
 * @param {string} input.todayIso
 */
export function forecastGoal({
  goal,
  remaining = null,
  capacity = null,
  tasks = [],
  todayIso
} = {}) {
  if (!goal) return insufficient('Tavoitetta ei ole.');

  if (!goal.targetDate) {
    return insufficient(
      'Tavoitteella ei ole määräpäivää, joten aikataulusta ei voi sanoa mitään.');
  }

  if (!isIsoDate(todayIso)) return insufficient('Päivämäärä puuttuu.');

  if (goal.targetDate < todayIso) {
    return Object.freeze({
      state: FORECAST.DELAYED,
      quality: FORECAST_QUALITY.GOOD,
      reason: `Määräpäivä ${goal.targetDate} on mennyt eikä tavoitetta ole merkitty `
        + 'saavutetuksi.',
      requiredMinutes: remaining?.minutes ?? null,
      availableMinutes: 0,
      ratio: Infinity,
      perDayMinutes: null,
      projectedDoneDate: null,
      velocityPerWeek: velocity(tasks, todayIso)
    });
  }

  if (!remaining || !capacity) {
    return insufficient('Työmäärää tai käytettävissä olevaa aikaa ei voitu laskea.');
  }

  // Ei jäljellä olevaa työtä: tavoite on tehtäviensä osalta valmis.
  //
  // Tämä EI tarkoita että tavoite on saavutettu — sen toteaa käyttäjä.
  // Se tarkoittaa, ettei aikataulu ole enää este.
  if (remaining.minutes === 0) {
    return Object.freeze({
      state: FORECAST.ON_TRACK,
      quality: FORECAST_QUALITY.GOOD,
      reason: 'Kaikki liitetty työ on tehty. Aikataulu ei ole este.',
      requiredMinutes: 0,
      availableMinutes: capacity.totalUsableMinutes,
      ratio: 0,
      perDayMinutes: 0,
      projectedDoneDate: todayIso,
      velocityPerWeek: velocity(tasks, todayIso)
    });
  }

  const fit = feasibility({ remaining, capacity });
  const perDay = dailyRequirement(fit.requiredMinutes, capacity.dayCount);
  const speed = velocity(tasks, todayIso);

  // LAATU ENNEN TILAA.
  //
  // Heikko pohja ei muuta vastausta, mutta se muuttaa sitä, kuinka
  // vahvasti vastaus esitetään.
  const weak = speed === null || remaining.estimateRatio > MAX_ESTIMATE_RATIO;
  const quality = weak ? FORECAST_QUALITY.WEAK : FORECAST_QUALITY.GOOD;

  let state;
  let reason;

  if (!fit.feasible) {
    state = FORECAST.DELAYED;
    reason = `Jäljellä on noin ${hours(fit.requiredMinutes)} työtä, mutta määräpäivään `
      + `${goal.targetDate} mennessä suunniteltavaa aikaa on ${hours(fit.availableMinutes)}.`;
  } else if (fit.ratio >= RISK_RATIO) {
    state = FORECAST.AT_RISK;
    reason = `Työ vie noin ${Math.round(fit.ratio * 100)} % käytettävissä olevasta ajasta `
      + `(${perDay} min päivässä). Aikataulu pitää vain jos mikään ei mene pieleen.`;
  } else {
    state = FORECAST.ON_TRACK;
    reason = `Jäljellä ${hours(fit.requiredMinutes)}, aikaa ${hours(fit.availableMinutes)}. `
      + `Se on noin ${perDay} min päivässä.`;
  }

  if (weak) {
    reason += remaining.estimateRatio > MAX_ESTIMATE_RATIO
      ? ` Arvio on karkea: ${remaining.estimatedCount}/${remaining.taskCount} tehtävältä `
        + 'puuttuu kestoarvio.'
      : ' Arvio on karkea: valmiita tehtäviä ei ole tarpeeksi vauhdin laskemiseen.';
  }

  return Object.freeze({
    state,
    quality,
    reason,
    requiredMinutes: fit.requiredMinutes,
    availableMinutes: fit.availableMinutes,
    ratio: fit.ratio,
    perDayMinutes: perDay,
    projectedDoneDate: projectDoneDate({ remaining, capacity, todayIso }),
    velocityPerWeek: speed
  });
}

/**
 * Milloin työ olisi valmis, jos kapasiteetti käytetään täysin?
 *
 * Kuluttaa päiväkohtaista kapasiteettia järjestyksessä, kunnes työ
 * loppuu. Palauttaa `null` jos horisontti loppuu ensin — ja se on
 * oikea vastaus: emme tiedä, koska emme laskeneet niin pitkälle.
 */
export function projectDoneDate({ remaining, capacity, todayIso }) {
  if (!remaining || !capacity || !isIsoDate(todayIso)) return null;

  let left = remaining.minutes;
  if (left <= 0) return todayIso;

  for (const day of capacity.days) {
    if (day.dateIso < todayIso) continue;
    left -= day.usableMinutes;
    if (left <= 0) return day.dateIso;
  }

  return null;
}

function hours(minutes) {
  const n = Number(minutes) || 0;
  if (n < 60) return `${n} min`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

// =====================================================================
// KORJAAVAT TOIMET
// =====================================================================

/** Korjaavan toimen laji. */
export const CORRECTION = Object.freeze({
  REDUCE_SCOPE: 'reduce_scope',
  MOVE_DEADLINE: 'move_deadline',
  INCREASE_ALLOCATION: 'increase_allocation',
  SPLIT_TASK: 'split_task',
  PAUSE_OTHER_GOAL: 'pause_other_goal',
  RESCHEDULE_FLEXIBLE: 'reschedule_flexible',
  ADD_ESTIMATES: 'add_estimates'
});

/**
 * Ehdota korjaavia toimia.
 *
 * NÄMÄ OVAT EHDOTUKSIA. Yksikään ei toteudu itsestään, eikä tavoitetta
 * luovuteta automaattisesti — luovuttaminen on päätös, ja päätös on
 * käyttäjän.
 *
 * Järjestys on tarkoituksellinen: vähiten tuhoava ensin. Määräpäivän
 * siirtäminen ennen laajuuden karsimista tarkoittaisi, että järjestelmä
 * pitää aikataulua tärkeämpänä kuin sisältöä.
 *
 * @returns {Array<{code:string, message:string, severity:string}>}
 */
export function suggestCorrections({ goal, forecast, remaining, capacity, otherGoals = [] } = {}) {
  const suggestions = [];
  if (!goal || !forecast) return suggestions;

  if (forecast.state === FORECAST.ON_TRACK) {
    if (forecast.quality === FORECAST_QUALITY.WEAK && remaining?.estimatedCount > 0) {
      suggestions.push({
        code: CORRECTION.ADD_ESTIMATES,
        message: `Lisää kestoarvio ${remaining.estimatedCount} tehtävälle, niin ennuste `
          + 'tarkentuu.'
      });
    }
    return suggestions;
  }

  if (forecast.state === FORECAST.INSUFFICIENT_DATA) {
    if (!goal.targetDate) {
      suggestions.push({
        code: CORRECTION.MOVE_DEADLINE,
        message: 'Aseta tavoitteelle määräpäivä, niin aikataulusta voi sanoa jotain.'
      });
    }
    if (remaining?.estimatedCount > 0) {
      suggestions.push({
        code: CORRECTION.ADD_ESTIMATES,
        message: 'Lisää kestoarvioita, niin työmäärän voi laskea.'
      });
    }
    return suggestions;
  }

  // AT_RISK tai DELAYED.

  suggestions.push({
    code: CORRECTION.RESCHEDULE_FLEXIBLE,
    message: 'Siirrä joustavaa työtä väljemmille päiville.'
  });

  suggestions.push({
    code: CORRECTION.REDUCE_SCOPE,
    message: 'Karsi laajuutta: siirrä vähemmän tärkeät tehtävät tavoitteen ulkopuolelle.'
  });

  if (remaining && remaining.taskCount > 0) {
    const average = Math.round(remaining.minutes / remaining.taskCount);
    if (average >= 120) {
      suggestions.push({
        code: CORRECTION.SPLIT_TASK,
        message: `Tehtävät ovat keskimäärin ${average} min. Pilko isoimmat, niin ne `
          + 'mahtuvat lyhyempiin väleihin.'
      });
    }
  }

  const competing = otherGoals.filter(other =>
    other && other.id !== goal.id && other.status === 'active');

  if (competing.length > 0) {
    suggestions.push({
      code: CORRECTION.PAUSE_OTHER_GOAL,
      message: `${competing.length} muuta tavoitetta kilpailee samasta ajasta. `
        + 'Harkitse jonkin niistä siirtämistä tauolle.'
    });
  }

  if (capacity && forecast.requiredMinutes !== null) {
    suggestions.push({
      code: CORRECTION.INCREASE_ALLOCATION,
      message: forecast.perDayMinutes
        ? `Varaa tavoitteelle noin ${forecast.perDayMinutes} min päivässä.`
        : 'Varaa tavoitteelle enemmän aikaa viikossa.'
    });
  }

  // MÄÄRÄPÄIVÄN SIIRTO ON VIIMEINEN.
  //
  // Se on tehokkain ja tuhoavin: se tekee ongelmasta näkymättömän
  // muuttamatta mitään todellista.
  suggestions.push({
    code: CORRECTION.MOVE_DEADLINE,
    message: forecast.projectedDoneDate
      ? `Siirrä määräpäivä. Nykyisellä kapasiteetilla työ olisi valmis `
        + `${forecast.projectedDoneDate}.`
      : 'Siirrä määräpäivää.'
  });

  return suggestions;
}
