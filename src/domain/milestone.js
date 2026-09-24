// Välitavoitteet.
//
// MIKSI TÄMÄ ON OLEMASSA
//
// Tavoitteella on kaksi rakennetta, ja ne vastaavat eri kysymyksiin:
//
//   PROJEKTI    mitä tehdään        "Julkaisuvalmius"
//   VÄLITAVOITE missä mennään       "Tuote on ominaisuusvalmis"
//
// Projekti on työsäiliö. Välitavoite on TILA, joka joko on saavutettu tai
// ei. Sillä ei ole tehtäviä eikä kestoa — sillä on päivä ja tulos.
//
// Ilman välitavoitteita pitkän tavoitteen edistyminen olisi joko
// "prosenttiosuus tehtävistä" (joka kertoo touhusta, ei etenemisestä) tai
// käsin syötetty luku (joka kertoo arvauksesta). Välitavoite on se
// tarkistuspiste, jonka ohittamisen tai ohittamatta jättämisen voi
// todeta.
//
// ---------------------------------------------------------------
// JÄRJESTYS ON MERKITYKSELLINEN
// ---------------------------------------------------------------
//
// Välitavoitteet ovat JÄRJESTETTY JONO, eivät joukko. "Tuote valmis"
// ennen "Beta testattu" on eri suunnitelma kuin päinvastoin, ja
// mahdoton järjestys on suunnitteluvirhe jonka pitää näkyä.
//
// Järjestys on `orderIndex`, ei `targetDate`: välitavoitteella ei ole
// pakko olla päivää, ja päivätön välitavoite ei saa pudota jonon
// loppuun vain siksi, ettei sille ole vielä päätetty päivää.

import { isIsoDate, MAX_TITLE_LENGTH, MAX_DESCRIPTION_LENGTH } from './task.js';

/**
 * Välitavoitteen tila.
 *
 * Neljä tilaa, ei viittä: välitavoitteella ei ole "arkistoitua" tilaa.
 * Se kuuluu tavoitteelle, ja tavoitteen arkistointi vie sen mukanaan.
 */
export const MILESTONE_STATUS = Object.freeze({
  /** Ei vielä saavutettu. */
  OPEN: 'open',
  /** Saavutettu. */
  REACHED: 'reached',
  /**
   * Jätetty väliin.
   *
   * Eri asia kuin saavutettu. Suunnitelma muuttui niin, ettei tätä enää
   * tarvita — ja se kertoo jotain, jonka poistaminen hävittäisi.
   */
  SKIPPED: 'skipped'
});

export const MILESTONE_STATUSES = Object.freeze(Object.values(MILESTONE_STATUS));

const STATUS_LABELS = Object.freeze({
  [MILESTONE_STATUS.OPEN]: 'Avoin',
  [MILESTONE_STATUS.REACHED]: 'Saavutettu',
  [MILESTONE_STATUS.SKIPPED]: 'Ohitettu'
});

export function milestoneStatusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS[MILESTONE_STATUS.OPEN];
}

/**
 * Miten välitavoitteen saavuttaminen todetaan.
 *
 * MANUAL on oletus ja tarkoituksella: välitavoite on tila, ja tilan
 * toteaminen on käyttäjän asia. Johdettu sääntö on tarjolla silloin kun
 * se on aidosti johdettavissa, mutta se ei saa olla oletus — johdettu
 * "saavutettu" ilman että käyttäjä on samaa mieltä on pahempi kuin
 * kysymys.
 */
export const MILESTONE_RULE = Object.freeze({
  /** Käyttäjä merkitsee saavutetuksi. */
  MANUAL: 'manual',
  /** Kaikki liitetyt projektit valmiita. */
  PROJECTS_DONE: 'projects_done',
  /** Kaikki liitetyt tehtävät valmiita. */
  TASKS_DONE: 'tasks_done'
});

export const MILESTONE_RULES = Object.freeze(Object.values(MILESTONE_RULE));

/** Yhden tavoitteen välitavoitteiden yläraja. */
export const MAX_MILESTONES_PER_GOAL = 20;

function cleanText(value, maxLength) {
  if (value == null) return null;
  const trimmed = String(value).trim().slice(0, maxLength);
  return trimmed === '' ? null : trimmed;
}

/**
 * Normalisoi välitavoite.
 *
 * `goalId` on pakollinen mutta sitä ei pakoteta tässä: normalisointi ei
 * heitä koskaan. Puuttuvan omistajan huomaa `validateMilestone`.
 */
export function normalizeMilestone(input = {}) {
  const status = MILESTONE_STATUSES.includes(input.status)
    ? input.status
    : MILESTONE_STATUS.OPEN;

  const rule = MILESTONE_RULES.includes(input.rule)
    ? input.rule
    : MILESTONE_RULE.MANUAL;

  const orderIndex = Number(input.orderIndex);

  return {
    id: input.id != null ? String(input.id) : null,
    /** Tavoite, jolle tämä kuuluu. Välitavoite ei elä ilman tavoitetta. */
    goalId: input.goalId != null ? String(input.goalId) : null,

    title: String(input.title ?? '').trim().slice(0, MAX_TITLE_LENGTH),
    description: cleanText(input.description, MAX_DESCRIPTION_LENGTH),

    /** Päivä johon mennessä tämä pitäisi saavuttaa. Vapaaehtoinen. */
    targetDate: isIsoDate(input.targetDate) ? input.targetDate : null,

    status,

    /**
     * Paikka jonossa. Kokonaisluku, ei välttämättä tiheä: poistaminen
     * jättää aukon, ja aukon täyttäminen olisi kirjoitus jokaiseen
     * riviin ilman että kukaan hyötyy siitä.
     */
    orderIndex: Number.isFinite(orderIndex) ? Math.trunc(orderIndex) : 0,

    rule,

    /** Milloin saavutettiin. Vain REACHED-tilassa merkityksellinen. */
    reachedDate: isIsoDate(input.reachedDate) ? input.reachedDate : null,

    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

export function validateMilestone(milestone) {
  const errors = {};

  const title = String(milestone.title ?? '').trim();
  if (!title) errors.title = 'Anna välitavoitteelle nimi.';

  if (!milestone.goalId) errors.goalId = 'Välitavoite kuuluu aina tavoitteelle.';

  if (!MILESTONE_STATUSES.includes(milestone.status)) {
    errors.status = 'Tuntematon tila.';
  }
  if (!MILESTONE_RULES.includes(milestone.rule)) {
    errors.rule = 'Tuntematon sääntö.';
  }

  if (milestone.targetDate != null && !isIsoDate(milestone.targetDate)) {
    errors.targetDate = 'Tavoitepäivä ei kelpaa.';
  }

  // SAAVUTETTU ILMAN PÄIVÄÄ ON TIETO JOKA EI KERRO MILLOIN.
  //
  // Sama sääntö kuin maksetulla laskulla (src/domain/finance.js): tila ja
  // sen päivä kulkevat yhdessä tai eivät lainkaan.
  if (milestone.status === MILESTONE_STATUS.REACHED && !milestone.reachedDate) {
    errors.reachedDate = 'Merkitse milloin välitavoite saavutettiin.';
  }
  if (milestone.status !== MILESTONE_STATUS.REACHED && milestone.reachedDate) {
    errors.reachedDate = 'Vain saavutetulla välitavoitteella on saavutuspäivä.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

// =====================================================================
// JONO
// =====================================================================

/** Yhden tavoitteen välitavoitteet järjestyksessä. */
export function milestonesForGoal(milestones, goalId) {
  if (!goalId || !Array.isArray(milestones)) return [];
  return milestones
    .filter(milestone => milestone && milestone.goalId === goalId)
    .sort(compareMilestones);
}

/**
 * Jonojärjestys: orderIndex, sitten päivä, sitten nimi.
 *
 * Päivä on toissijainen eikä ensisijainen: päivätön välitavoite ei saa
 * pudota jonon loppuun vain siksi, ettei sille ole vielä päätetty
 * päivää. Nimi viimeisenä takaa determinismin.
 */
export function compareMilestones(a, b) {
  const byOrder = (a.orderIndex ?? 0) - (b.orderIndex ?? 0);
  if (byOrder !== 0) return byOrder;

  const aDate = a.targetDate || '9999-12-31';
  const bDate = b.targetDate || '9999-12-31';
  if (aDate !== bDate) return aDate.localeCompare(bDate);

  return String(a.title ?? '').localeCompare(String(b.title ?? ''), 'fi');
}

/**
 * Seuraava järjestysnumero tavoitteen jonossa.
 *
 * Suurin käytössä oleva plus yksi. EI määrä: poistetun välitavoitteen
 * jälkeen määrä olisi pienempi kuin suurin indeksi, ja uusi rivi saisi
 * jo varatun paikan.
 */
export function nextOrderIndex(milestones, goalId) {
  const existing = milestonesForGoal(milestones, goalId);
  if (existing.length === 0) return 0;
  return Math.max(...existing.map(m => m.orderIndex ?? 0)) + 1;
}

/**
 * Siirrä välitavoite jonossa ylös tai alas.
 *
 * Palauttaa UUDET välitavoitteet uusine indekseineen — ei mutatoi.
 * Indeksit kirjoitetaan uudelleen tiheiksi vain tässä, koska juuri tässä
 * käyttäjä on ilmaissut kiinnostuksensa järjestykseen.
 */
export function reorderMilestone(milestones, goalId, milestoneId, direction) {
  const queue = milestonesForGoal(milestones, goalId);
  const index = queue.findIndex(m => m.id === milestoneId);
  if (index === -1) return [];

  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= queue.length) return [];

  const reordered = [...queue];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];

  return reordered.map((milestone, position) => ({ ...milestone, orderIndex: position }));
}

// =====================================================================
// TILA JA EDISTYMINEN
// =====================================================================

/** Onko välitavoite yhä avoin? */
export function isOpenMilestone(milestone) {
  return Boolean(milestone) && milestone.status === MILESTONE_STATUS.OPEN;
}

/**
 * Onko välitavoite myöhässä?
 *
 * Vain avoin voi olla myöhässä. Ohitettu ei ole myöhässä — se on
 * päätös, ei laiminlyönti.
 */
export function isMilestoneOverdue(milestone, todayIso) {
  if (!isOpenMilestone(milestone)) return false;
  if (!milestone.targetDate || !isIsoDate(todayIso)) return false;
  return milestone.targetDate < todayIso;
}

/**
 * Seuraava saavuttamaton välitavoite.
 *
 * Tämä on se, jota kohti työ etenee juuri nyt. Käyttöliittymä näyttää
 * sen, koska "seuraava tarkistuspiste" on ymmärrettävämpi kuin lista
 * kahdestatoista tulevasta.
 */
export function nextMilestone(milestones, goalId) {
  return milestonesForGoal(milestones, goalId).find(isOpenMilestone) || null;
}

/**
 * Onko jono mahdoton?
 *
 * Jonon päivien on kasvettava. Jos kolmas välitavoite on aikaisemmin
 * kuin toinen, suunnitelma väittää että kolmas saavutetaan ennen
 * toista — ja se on suunnitteluvirhe, ei makuasia.
 *
 * Päivättömät välitavoitteet ohitetaan: ne eivät väitä mitään.
 * Saavutetut ohitetaan myös, koska mennyt järjestys on jo tapahtunut.
 *
 * @returns {Array<{after: object, before: object}>} rikkovat parit
 */
export function outOfOrderMilestones(milestones, goalId) {
  const dated = milestonesForGoal(milestones, goalId)
    .filter(m => m.targetDate && m.status !== MILESTONE_STATUS.REACHED);

  const breaks = [];
  for (let i = 1; i < dated.length; i++) {
    if (dated[i].targetDate < dated[i - 1].targetDate) {
      breaks.push({ after: dated[i], before: dated[i - 1] });
    }
  }
  return breaks;
}

/**
 * Välitavoitteiden edistyminen.
 *
 * OHITETTU EI OLE SAAVUTETTU EIKÄ AVOIN. Se poistetaan nimittäjästä
 * kokonaan: suunnitelmasta pudotettu tarkistuspiste ei saa laskea
 * edistymistä eikä nostaa sitä.
 *
 * Tavoite ilman välitavoitteita palauttaa `known: false` — ei nollaa.
 * Tyhjä joukko ei ole nolla prosenttia vaan tuntematon, ja nolla
 * näyttäisi siltä kuin mitään ei olisi tehty.
 */
export function milestoneProgress(milestones, goalId) {
  const queue = milestonesForGoal(milestones, goalId);
  const counted = queue.filter(m => m.status !== MILESTONE_STATUS.SKIPPED);
  const reached = counted.filter(m => m.status === MILESTONE_STATUS.REACHED);

  if (counted.length === 0) {
    return {
      known: false,
      percent: null,
      reached: 0,
      total: 0,
      skipped: queue.length
    };
  }

  return {
    known: true,
    percent: Math.round((reached.length / counted.length) * 100),
    reached: reached.length,
    total: counted.length,
    skipped: queue.length - counted.length
  };
}

/**
 * Onko välitavoitteen johdettu sääntö täyttynyt?
 *
 * Palauttaa `null` kun sääntöä ei voi arvioida: MANUAL-sääntö ei ole
 * johdettavissa, eikä tyhjä joukko täytä sääntöä. Tyhjän joukon
 * pitäminen "täyttyneenä" merkitsisi jokaisen liittämättömän
 * välitavoitteen saavutetuksi heti.
 */
export function ruleSatisfied(milestone, { projects = [], tasks = [] } = {}) {
  if (!milestone || milestone.rule === MILESTONE_RULE.MANUAL) return null;

  if (milestone.rule === MILESTONE_RULE.PROJECTS_DONE) {
    const linked = projects.filter(p => p && p.milestoneId === milestone.id);
    if (linked.length === 0) return null;
    return linked.every(p => p.status === 'completed');
  }

  if (milestone.rule === MILESTONE_RULE.TASKS_DONE) {
    const linked = tasks.filter(t => t && t.milestoneId === milestone.id);
    if (linked.length === 0) return null;
    return linked.every(t => t.completed);
  }

  return null;
}

/**
 * Merkitse saavutetuksi.
 *
 * Tila ja päivä kulkevat yhdessä — `validateMilestone` vaatii sen, ja
 * tämä on se paikka, jossa pari muodostetaan oikein.
 */
export function markReached(milestone, dateIso) {
  if (!milestone) return null;
  return normalizeMilestone({
    ...milestone,
    status: MILESTONE_STATUS.REACHED,
    reachedDate: dateIso
  });
}

/** Palauta avoimeksi. Saavutuspäivä poistuu mukana. */
export function markOpen(milestone) {
  if (!milestone) return null;
  return normalizeMilestone({
    ...milestone,
    status: MILESTONE_STATUS.OPEN,
    reachedDate: null
  });
}

/** Ohita. Päätös, ei laiminlyönti. */
export function markSkipped(milestone) {
  if (!milestone) return null;
  return normalizeMilestone({
    ...milestone,
    status: MILESTONE_STATUS.SKIPPED,
    reachedDate: null
  });
}
