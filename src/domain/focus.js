// Päivän tärkeimmät — "mihin keskityn tänään".
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa.
//
// MIKSI TÄMÄ EI OLE TIETOKANTAKENTTÄ
// Olisi helppoa lisätä tehtävälle `isFocus`-lippu ja antaa käyttäjän merkitä
// kolme asiaa päivässä. Se olisi kuitenkin yksi ylläpidettävä asia lisää:
// käyttäjän pitäisi muistaa päivittää se joka aamu, ja unohdettu lippu
// vanhentuisi hiljaa.
//
// Fokus JOHDETAAN tiedosta, joka on jo olemassa: kiireellisyydestä,
// prioriteetista, aikataulusta ja tavoiteyhteydestä. Käyttäjä on jo kertonut
// mikä on tärkeää — sitä ei tarvitse kysyä uudelleen.
//
// PISTEYTYS (dokumentoitu, jotta siitä voi olla eri mieltä)
//
//   Myöhässä                       +100   lupaus on jo rikottu
//   Määräaika tänään                +60
//   Määräaika huomenna              +35
//   Määräaika lähipäivinä           +20
//   Korkea prioriteetti             +40
//   Matala prioriteetti             −15
//   Aikataulutettu tälle päivälle   +25   käyttäjä on jo varannut ajan
//   Liittyy tavoitteeseen           +15   vie pidempää kaarta eteenpäin
//   Liittyy projektiin              +5
//
// Tasapisteissä ratkaisee kellonaika ja lopuksi nimi — tulos on aina
// deterministinen.

import {
  isOverdue, deadlineUrgency, URGENCY, compareForDay
} from './task.js';

/** Montako asiaa nostetaan oletuksena. Kolme on se määrä, jonka ihminen muistaa. */
export const DEFAULT_FOCUS_LIMIT = 3;

export const FOCUS_SCORE = Object.freeze({
  OVERDUE: 100,
  DEADLINE_TODAY: 60,
  DEADLINE_TOMORROW: 35,
  DEADLINE_SOON: 20,
  PRIORITY_HIGH: 40,
  PRIORITY_LOW: -15,
  SCHEDULED_TODAY: 25,
  HAS_GOAL: 15,
  HAS_PROJECT: 5
});

/**
 * Yhden tehtävän fokuspisteet ja perustelut.
 *
 * @returns {{score:number, reasons:string[]}}
 */
export function scoreTask(task, { dateIso, todayIso }) {
  if (!task || task.completed) return { score: 0, reasons: [] };

  const reference = todayIso || dateIso;
  const reasons = [];
  let score = 0;

  if (isOverdue(task, reference)) {
    score += FOCUS_SCORE.OVERDUE;
    reasons.push('Myöhässä');
  } else {
    const urgency = deadlineUrgency(task, reference);
    if (urgency === URGENCY.TODAY) {
      score += FOCUS_SCORE.DEADLINE_TODAY;
      reasons.push('Määräaika tänään');
    } else if (urgency === URGENCY.TOMORROW) {
      score += FOCUS_SCORE.DEADLINE_TOMORROW;
      reasons.push('Määräaika huomenna');
    } else if (urgency === URGENCY.SOON) {
      score += FOCUS_SCORE.DEADLINE_SOON;
      reasons.push('Määräaika lähipäivinä');
    }
  }

  if (task.priority === 'korkea') {
    score += FOCUS_SCORE.PRIORITY_HIGH;
    reasons.push('Tärkeä');
  } else if (task.priority === 'matala') {
    score += FOCUS_SCORE.PRIORITY_LOW;
  }

  if (task.date === dateIso && task.time) {
    score += FOCUS_SCORE.SCHEDULED_TODAY;
    reasons.push(`Aikataulussa klo ${task.time}`);
  }

  if (task.goalId) {
    score += FOCUS_SCORE.HAS_GOAL;
    reasons.push('Vie tavoitetta eteenpäin');
  }

  if (task.projectId) score += FOCUS_SCORE.HAS_PROJECT;

  return { score, reasons };
}

/**
 * Päivän tärkeimmät tehtävät.
 *
 * TAKUUT:
 *  - Deterministinen: sama syöte, sama tulos ja sama järjestys
 *  - Valmiita tehtäviä ei koskaan nosteta
 *  - Palauttaa enintään `limit` kappaletta
 *  - Jokaisella on perustelu — ilman sitä nosto olisi mielivaltainen
 *
 * Ehdolla ovat tälle päivälle aikataulutetut sekä kaikki myöhässä olevat ja
 * pian erääntyvät riippumatta siitä, mille päivälle ne on merkitty. Muuten
 * seuraavan viikon määräaika jäisi huomaamatta.
 *
 * @returns {Array<{task:object, score:number, reasons:string[]}>}
 */
export function todayFocus({ tasks = [], dateIso, todayIso = null, limit = DEFAULT_FOCUS_LIMIT } = {}) {
  const reference = todayIso || dateIso;

  const candidates = tasks.filter(task => {
    if (task.completed) return false;
    if (task.date === dateIso) return true;
    if (isOverdue(task, reference)) return true;
    const urgency = deadlineUrgency(task, reference);
    return urgency === URGENCY.TODAY || urgency === URGENCY.TOMORROW || urgency === URGENCY.SOON;
  });

  const scored = candidates
    .map(task => ({ task, ...scoreTask(task, { dateIso, todayIso: reference }) }))
    .filter(entry => entry.score > 0);

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return compareForDay(a.task, b.task);
  });

  return scored.slice(0, Math.max(0, limit));
}

/**
 * Järjestä ANNETTU joukko tehtäviä tärkeysjärjestykseen.
 *
 * Ero todayFocus-funktioon: tämä ei suodata ehdokkaita päivän perusteella
 * vaan pisteyttää kaiken mitä sille annetaan. Käytetään silloin, kun joukko
 * on jo rajattu muualla — esimerkiksi viikkokatsauksessa, jossa nostetaan
 * seuraavan viikon tärkeimmät koko viikolta eikä yhdeltä päivältä.
 *
 * @returns {Array<{task:object, score:number, reasons:string[]}>}
 */
export function rankTasks({ tasks = [], dateIso, todayIso = null, limit = DEFAULT_FOCUS_LIMIT } = {}) {
  const reference = todayIso || dateIso;

  const scored = tasks
    .filter(task => task && !task.completed)
    .map(task => ({ task, ...scoreTask(task, { dateIso: task.date || dateIso, todayIso: reference }) }))
    .filter(entry => entry.score > 0);

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.task.date !== b.task.date) {
      return String(a.task.date ?? '').localeCompare(String(b.task.date ?? ''));
    }
    return compareForDay(a.task, b.task);
  });

  return scored.slice(0, Math.max(0, limit));
}

/**
 * Lyhyt yhteenveto fokuksesta käyttöliittymälle.
 * Kertoo myös, jos mitään ei nouse — tyhjä päivä on tulos sekin.
 */
export function describeFocus(entries) {
  if (!entries || entries.length === 0) {
    return { count: 0, text: 'Ei erityisen kiireellistä. Hyvä päivä edetä isommassa asiassa.' };
  }
  return {
    count: entries.length,
    text: entries.length === 1
      ? 'Yksi asia nousee yli muiden.'
      : `${entries.length} asiaa nousee yli muiden.`
  };
}
