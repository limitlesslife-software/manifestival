// Energiakuorma: onko viikko ajallisesti mahdollinen mutta raskas?
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa, EI TEKOÄLYÄ.
//
// =====================================================================
// AIKA JA ENERGIA OVAT ERI ASIOITA
// =====================================================================
//
// Aikakapasiteetti vastaa kysymykseen "paljonko ehdin". Energiaraja
// vastaa kysymykseen "paljonko KUORMITTAVAA tekemistä jaksan". Viikko
// voi mahtua aikaan ja silti olla liian raskas. Niitä EI yhdistetä
// yhdeksi luvuksi: TIME_OVERLOAD ja ENERGY_OVERLOAD ovat eri havaintoja.
//
// =====================================================================
// MALLI (tarkka)
// =====================================================================
//
// Käyttäjä merkitsee tehtävälle/rutiinille/projektille kuormittavuuden
// 1 kevyt · 2 melko kevyt · 3 keskitaso · 4 kuormittava ·
// 5 erittäin kuormittava. Merkitsemätön on TUNTEMATON.
//
//   kuormittava aika = Σ kesto (min) niistä viikon suunnitelluista
//                      kohteista, joiden kuormittavuus >= 4
//
// Painoja ei ole. "Kuormittavaa aikaa 14 h, jaksat noin 8 h" on
// ymmärrettävä lause; "energiapisteitä 23,5 / 18" ei ole. Erittäin
// kuormittava (5) raportoidaan erikseen, mutta se ei muuta laskua.
//
// Raja on käyttäjän oma: `weekly_capacities.energy_budget_minutes`
// ("kuormittavaa tekemistä enintään X h tällä viikolla"). Sitä ei
// johdeta aikakapasiteetista eikä hyvinvointimerkinnöistä.
//
// ENERGY_OVERLOAD-säännöt (ENERGY_RULES, alignmentPolicy.js):
//
//   energy.heavy_exceeds_budget   raja asetettu ja kuormittava > raja
//                                 -> Huomio; >= 120 % tai raja 0 -> Vahva
//   energy.possible_with_unrated  kuormittava >= 90 % rajasta ja osa
//                                 kestollisesta työstä on ilman
//                                 kuormittavuutta -> Tiedoksi
//   energy.low_energy_heavy_share rajaa ei ole, oma energia-arvio <= 2,
//                                 kuormittavaa >= 50 % tunnetusta
//                                 suunnitellusta ajasta ja >= 2 h
//                                 -> Tiedoksi
//
// Arvioimaton kesto: kohde ilman kestoa ei ole kuormittavaa aikaa
// (tuntematon ei ole nolla, mutta sitä ei voi laskea yhteen). Se näkyy
// ajan havainnoissa jo arvioimattomana.

import { ENERGY_RULES } from './alignmentPolicy.js';

export const ENERGY_SIGNAL = 'energy_overload';

/**
 * Viikon energiakuorma suunnitelluista kohteista.
 *
 * @param {Array} items plannedItems()-tulos, kohteilla `energyDemand` (null = tuntematon)
 */
export function summarizeEnergy(items = []) {
  const byDemand = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let heavyMinutes = 0;
  let veryHeavyMinutes = 0;
  let ratedMinutes = 0;
  let unratedMinutes = 0;
  let unratedCount = 0;
  let heavyCount = 0;
  let knownMinutes = 0;

  for (const item of items || []) {
    if (!item || item.minutes === null || !Number.isFinite(item.minutes)) continue;
    knownMinutes += item.minutes;
    const demand = item.energyDemand;
    if (demand === null || demand === undefined) {
      unratedMinutes += item.minutes;
      unratedCount += 1;
      continue;
    }
    ratedMinutes += item.minutes;
    byDemand[demand] += item.minutes;
    if (demand >= ENERGY_RULES.HEAVY_MIN_DEMAND) {
      heavyMinutes += item.minutes;
      heavyCount += 1;
    }
    if (demand === 5) veryHeavyMinutes += item.minutes;
  }

  return {
    heavyMinutes, veryHeavyMinutes, heavyCount,
    ratedMinutes, unratedMinutes, unratedCount, knownMinutes,
    byDemand,
    heavySharePercent: knownMinutes > 0 ? Math.round((heavyMinutes / knownMinutes) * 100) : null,
    ratedPercent: knownMinutes > 0 ? Math.round((ratedMinutes / knownMinutes) * 100) : null
  };
}

/**
 * ENERGY_OVERLOAD-havainnot. Erillään aikakuormituksesta; `timeOverloaded`
 * kertoo vain selitykselle, onko aika JO ylittynyt ("aikaa näyttäisi
 * olevan riittävästi, mutta ...").
 *
 * @param {object} args
 * @param {object} args.energy       summarizeEnergy()-tulos
 * @param {object|null} args.capacity viikon kapasiteetti (energyBudgetMinutes, energyLevel)
 * @param {boolean} args.timeOverloaded
 */
export function energySignals({ energy, capacity, timeOverloaded = false }) {
  if (!energy || !capacity) return [];
  const budget = capacity.energyBudgetMinutes;
  const base = {
    kind: ENERGY_SIGNAL, areaId: null, basis: 'planned'
  };

  if (Number.isInteger(budget) && budget >= 0) {
    const metrics = {
      heavyMinutes: energy.heavyMinutes,
      veryHeavyMinutes: energy.veryHeavyMinutes,
      energyBudgetMinutes: budget,
      overageMinutes: Math.max(0, energy.heavyMinutes - budget),
      percentOfBudget: budget > 0 ? Math.round((energy.heavyMinutes / budget) * 100) : null,
      unratedCount: energy.unratedCount,
      unratedMinutes: energy.unratedMinutes,
      timeOverloaded: Boolean(timeOverloaded)
    };
    if (energy.heavyMinutes > budget) {
      const strong = budget === 0 || energy.heavyMinutes >= budget * ENERGY_RULES.OVERLOAD_STRONG_RATIO;
      return [{ ...base, severity: strong ? 'strong' : 'attention', rule: 'energy.heavy_exceeds_budget', metrics }];
    }
    if (energy.unratedCount > 0 && budget > 0
        && energy.heavyMinutes >= budget * ENERGY_RULES.OVERLOAD_POSSIBLE_RATIO) {
      return [{ ...base, severity: 'info', rule: 'energy.possible_with_unrated', metrics }];
    }
    return [];
  }

  // Ei rajaa: vain käyttäjän oma matala energia-arvio yhdessä raskaan
  // suunnitelman kanssa. Tiedoksi, koska rajaa ei ole sanottu.
  const level = capacity.energyLevel;
  if (Number.isInteger(level) && level <= ENERGY_RULES.LOW_ENERGY_LEVEL
      && energy.knownMinutes > 0
      && energy.heavyMinutes >= ENERGY_RULES.LOW_ENERGY_MIN_HEAVY_MINUTES
      && energy.heavyMinutes / energy.knownMinutes >= ENERGY_RULES.LOW_ENERGY_HEAVY_SHARE) {
    return [{
      ...base, severity: 'info', rule: 'energy.low_energy_heavy_share',
      metrics: {
        heavyMinutes: energy.heavyMinutes, knownMinutes: energy.knownMinutes,
        heavySharePercent: energy.heavySharePercent, energyLevel: level,
        timeOverloaded: Boolean(timeOverloaded)
      }
    }];
  }
  return [];
}

/**
 * Toteutunut kuormittava aika: kirjaukset, joiden kohteella on
 * kuormittavuus >= 4. Vain kuvaava (katsaus); ei havaintoa.
 */
export function actualHeavyMinutes(entries = [], demandOfEntry = () => null) {
  let minutes = 0;
  let rated = 0;
  for (const entry of entries || []) {
    if (!entry || !Number.isInteger(entry.minutes) || entry.minutes <= 0) continue;
    const demand = demandOfEntry(entry);
    if (demand === null || demand === undefined) continue;
    rated += entry.minutes;
    if (demand >= ENERGY_RULES.HEAVY_MIN_DEMAND) minutes += entry.minutes;
  }
  return { heavyMinutes: minutes, ratedMinutes: rated };
}
