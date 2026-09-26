// Toteuman lähteet: yksi rajapinta nykyisille ja tuleville lähteille.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa.
//
// =====================================================================
// MIKSI
// =====================================================================
//
// Suunta vertaa sitä mitä käyttäjä sanoi haluavansa siihen mitä
// tapahtui. "Mitä tapahtui" tulee tänään kahdesta lähteestä (käsin
// kirjattu aika ja ajastin). Myöhemmin lähteitä voi olla lisää:
// kalenteri, aktiivisuus, talous, hyvinvointi. Jokainen lähde tuottaa
// saman muotoisia FAKTOJA, jotta havaintomoottori ei tiedä lähteestä
// mitään eikä yksikään lähde voi ohittaa sen sääntöjä.
//
// Jokainen fakta kertoo:
//
//   source        mistä (manual, timer, calendar, activity, finance, wellbeing)
//   period        mihin aikaan (päivä tai aikaväli)
//   resource      mikä resurssi (time, money, energy, activity)
//   quantity      paljonko (yksikkö resurssin mukaan)
//   confidence    kuinka varma (exact | reported | estimated | inferred)
//   completeness  kattaako lähde jakson kokonaan (complete | partial | unknown)
//   target        mihin se kohdistuu (alue, tavoite, tehtävä, projekti, rutiini)
//
// =====================================================================
// TÄNÄÄN TOTEUTETTU / TULEVA
// =====================================================================
//
//   manual     TOTEUTETTU  time_entries.source = 'manual'
//   timer      TOTEUTETTU  time_entries.source = 'timer' (0013)
//   calendar   TULEVA      vain rajapinta; ei integraatiota
//   activity   TULEVA      vain rajapinta
//   finance    TULEVA      Talous 2.0 on auktoritatiivinen; EI omaa taulua
//   wellbeing  TULEVA      voi ehdottaa, ei koskaan kirjoita kapasiteettia
//
// RAJA, JOTA EI YLITETÄ: mikään lähde ei muuta kapasiteettia, tärkeyttä
// eikä tavoitteita. Lähde tuottaa faktoja; käyttäjä päättää.

export const REALITY_RESOURCE = Object.freeze({
  TIME: 'time', MONEY: 'money', ENERGY: 'energy', ACTIVITY: 'activity'
});

export const REALITY_CONFIDENCE = Object.freeze({
  /** Laskettu aikaleimoista (ajastin). */
  EXACT: 'exact',
  /** Käyttäjä kertoi itse (käsin kirjattu). */
  REPORTED: 'reported',
  /** Arvio (esim. kalenterivaraus, joka ei välttämättä toteutunut). */
  ESTIMATED: 'estimated',
  /** Päätelty toisesta signaalista. Ei koskaan havainnon ainoa peruste. */
  INFERRED: 'inferred'
});

export const REALITY_COMPLETENESS = Object.freeze({
  COMPLETE: 'complete', PARTIAL: 'partial', UNKNOWN: 'unknown'
});

export const SOURCE_STATUS = Object.freeze({ IMPLEMENTED: 'implemented', FUTURE: 'future' });

/**
 * Lähteiden rekisteri. `resources`: mitä resursseja lähde voi tuottaa.
 * `writesCapacity` on AINA false: tämä on tarkoituksellinen raja.
 */
export const REALITY_SOURCES = Object.freeze({
  manual: Object.freeze({
    status: SOURCE_STATUS.IMPLEMENTED, resources: Object.freeze(['time']),
    confidence: REALITY_CONFIDENCE.REPORTED, writesCapacity: false,
    label: 'Käsin kirjattu aika'
  }),
  timer: Object.freeze({
    status: SOURCE_STATUS.IMPLEMENTED, resources: Object.freeze(['time']),
    confidence: REALITY_CONFIDENCE.EXACT, writesCapacity: false,
    label: 'Ajastin'
  }),
  calendar: Object.freeze({
    status: SOURCE_STATUS.FUTURE, resources: Object.freeze(['time']),
    confidence: REALITY_CONFIDENCE.ESTIMATED, writesCapacity: false,
    label: 'Kalenteri (tuleva)'
  }),
  activity: Object.freeze({
    status: SOURCE_STATUS.FUTURE, resources: Object.freeze(['activity', 'energy']),
    confidence: REALITY_CONFIDENCE.INFERRED, writesCapacity: false,
    label: 'Aktiivisuus (tuleva)'
  }),
  finance: Object.freeze({
    status: SOURCE_STATUS.FUTURE, resources: Object.freeze(['money']),
    confidence: REALITY_CONFIDENCE.REPORTED, writesCapacity: false,
    label: 'Talous (tuleva; Talous 2.0 on auktoritatiivinen)'
  }),
  wellbeing: Object.freeze({
    status: SOURCE_STATUS.FUTURE, resources: Object.freeze(['energy']),
    confidence: REALITY_CONFIDENCE.REPORTED, writesCapacity: false,
    label: 'Hyvinvointi (tuleva; vain ehdotus)'
  })
});

/**
 * Yksi fakta. Kelvoton palauttaa nullin: lähde ei voi tuottaa puolikasta
 * faktaa, joka näyttäisi oikealta.
 */
export function realityFact(input = {}) {
  const source = REALITY_SOURCES[input.source] ? input.source : null;
  const resource = Object.values(REALITY_RESOURCE).includes(input.resource) ? input.resource : null;
  const quantity = Number(input.quantity);
  if (!source || !resource || !Number.isFinite(quantity) || quantity < 0) return null;
  if (!REALITY_SOURCES[source].resources.includes(resource)) return null;
  const period = input.period || {};
  if (typeof period.date !== 'string' && !(period.from && period.to)) return null;
  return Object.freeze({
    source, resource, quantity,
    unit: resource === REALITY_RESOURCE.TIME ? 'minutes' : resource === REALITY_RESOURCE.MONEY ? 'cents' : 'level',
    period: Object.freeze({ date: period.date || null, from: period.from || null, to: period.to || null }),
    confidence: Object.values(REALITY_CONFIDENCE).includes(input.confidence)
      ? input.confidence : REALITY_SOURCES[source].confidence,
    completeness: Object.values(REALITY_COMPLETENESS).includes(input.completeness)
      ? input.completeness : REALITY_COMPLETENESS.UNKNOWN,
    target: Object.freeze({
      lifeAreaId: input.target?.lifeAreaId || null, goalId: input.target?.goalId || null,
      taskId: input.target?.taskId || null, projectId: input.target?.projectId || null,
      routineId: input.target?.routineId || null
    })
  });
}

/** Sovitin: aikakirjaukset (manual/timer) -> faktat. */
export const timeEntryAdapter = Object.freeze({
  sources: Object.freeze(['manual', 'timer']),
  toFacts(entries = []) {
    return (entries || []).map(entry => realityFact({
      source: entry.source === 'timer' ? 'timer' : 'manual',
      resource: REALITY_RESOURCE.TIME,
      quantity: entry.minutes,
      period: entry.startedAt && entry.endedAt
        ? { date: entry.entryDate, from: entry.startedAt, to: entry.endedAt }
        : { date: entry.entryDate },
      completeness: REALITY_COMPLETENESS.PARTIAL,
      target: entry
    })).filter(Boolean);
  }
});

/**
 * Tulevan lähteen sovitin: rajapinta ilman toteutusta. Palauttaa tyhjän,
 * eikä teeskentele tuottavansa mitään.
 */
export function futureAdapter(source) {
  if (!REALITY_SOURCES[source] || REALITY_SOURCES[source].status !== SOURCE_STATUS.FUTURE) {
    throw new Error(`Ei tuleva lähde: ${source}`);
  }
  return Object.freeze({ sources: Object.freeze([source]), implemented: false, toFacts: () => [] });
}

/** Faktojen yhteenveto lähteittäin ja resursseittain. */
export function summarizeFacts(facts = []) {
  const bySource = {};
  for (const fact of facts || []) {
    if (!fact) continue;
    const key = `${fact.source}:${fact.resource}`;
    bySource[key] = (bySource[key] || 0) + fact.quantity;
  }
  return bySource;
}

// =====================================================================
// RAHA (tuleva): vain tyypit. Talous 2.0 on auktoritatiivinen.
// =====================================================================

/**
 * Rahan kapasiteetti viikolle/kuukaudelle. EI omaa taulua: arvot
 * johdetaan tulevaisuudessa Talous 2.0:n budjetista (transactions,
 * budget.js). Tämä on vain muoto, jolla Suunta voisi niitä lukea.
 *
 * @typedef {object} MoneyCapacity
 * @property {string} period      'YYYY-MM' tai viikon maanantai
 * @property {number|null} availableCents
 * @property {number|null} committedCents  laskut ja toistuvat menot
 * @property {'finance'} source
 */
export function moneyCapacityShape(input = {}) {
  const cents = value => (Number.isInteger(value) ? value : null);
  return Object.freeze({
    period: typeof input.period === 'string' ? input.period : null,
    availableCents: cents(input.availableCents),
    committedCents: cents(input.committedCents),
    source: 'finance'
  });
}

// =====================================================================
// HYVINVOINTI (tuleva): voi EHDOTTAA, ei koskaan kirjoita.
// =====================================================================

/**
 * Kapasiteettiehdotus hyvinvointimerkinnöistä.
 *
 * RAJA: palauttaa vain ehdotuksen (`applies: false`). Se ei muuta
 * kapasiteettia, eikä sitä kutsuta ollenkaan ilman käyttäjän
 * nimenomaista suostumusta (`optIn`). Mielialaa tai stressiä ei muuteta
 * automaattisesti kapasiteetiksi.
 *
 * @param {object} args
 * @param {boolean} args.optIn          käyttäjän oma valinta; oletus false
 * @param {Array}   args.entries        hyvinvointimerkinnät (energy 1–5)
 * @param {object|null} args.capacity   nykyinen viikkokapasiteetti
 * @returns {null | {suggestedEnergyLevel: number, basis: string, applies: false}}
 */
export function suggestEnergyFromWellbeing({ optIn = false, entries = [], capacity = null } = {}) {
  if (optIn !== true) return null;
  const energies = (entries || []).map(entry => Number(entry && entry.energy))
    .filter(value => Number.isInteger(value) && value >= 1 && value <= 5);
  if (energies.length < 3) return null;
  const average = energies.reduce((a, b) => a + b, 0) / energies.length;
  const suggested = Math.min(5, Math.max(1, Math.round(average)));
  if (capacity && capacity.energyLevel === suggested) return null;
  return Object.freeze({
    suggestedEnergyLevel: suggested,
    basis: `${energies.length} hyvinvointimerkinnän keskiarvo`,
    applies: false
  });
}
