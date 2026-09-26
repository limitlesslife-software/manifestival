// Viikkokatsaus, seuraavan viikon muutosehdotukset ja palaute
// suunnittelumoottorille.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa, ei tekoälyä.
//
// =====================================================================
// EHDOTUS EI OLE MUUTOS
// =====================================================================
//
// proposeAdjustments() KUVAA mitä voisi muuttaa. Se ei muuta mitään.
// Jokainen ehdotus viedään käyttöliittymässä vahvistusdialogin läpi
// (src/app/alignment.js applyAdjustment), ja vasta vahvistettu ehdotus
// kirjoittaa. Sama periaate kuin suunnitelmaehdotuksessa (plan.js).
//
// =====================================================================
// TILANNEKUVA ON HISTORIAA
// =====================================================================
//
// buildReviewSnapshot() tallentaa sen, minkä käyttäjä näki: kapasiteetti,
// alueiden tavoitteet, suunniteltu ja toteutunut yhteenveto, havainnot ja
// aineiston laatu. Tehtäviä ei kopioida: vain lukuja ja tunnisteita.
// Versio kasvaa jos muoto muuttuu, ja vanha versio luetaan sellaisenaan.

import { SIGNAL, SEVERITY, RULES, TRACKING, NEGLECT_PLAN_UNKNOWN, isNeglectShortfall } from './alignment.js';
import { formatMinutes, importanceLabel, countOf } from './lifeArea.js';
import { priorityWeight } from './priority.js';
import { REVIEW_RULES, ENERGY_RULES, POLICY_VERSION, policyVersionOf } from './alignmentPolicy.js';

export const SNAPSHOT_VERSION = 2;
export const MAX_REFLECTION_LENGTH = 4000;
export const MAX_PROPOSALS = REVIEW_RULES.MAX_PROPOSALS;
const MAX_PAUSE_PROPOSALS = REVIEW_RULES.MAX_PAUSE_PROPOSALS;

export const ADJUSTMENT = Object.freeze({
  SET_CAPACITY: 'set_capacity',
  POSTPONE_TASKS: 'postpone_tasks',
  CREATE_TASK: 'create_task',
  CHANGE_TARGET: 'change_target',
  PAUSE_GOAL: 'pause_goal',
  /** Ei kirjoita mitään: avaa arvioinnin työnkulun. */
  REQUEST_ESTIMATES: 'request_estimates',
  /** Ei kirjoita mitään: avaa ajan kirjauksen (sääntöversio 3). */
  START_TRACKING: 'start_tracking'
});

/** Ehdotukset, jotka eivät muuta mitään (vain ohjaavat näkymään). */
export const NON_WRITING_ADJUSTMENTS = Object.freeze([ADJUSTMENT.REQUEST_ESTIMATES, ADJUSTMENT.START_TRACKING]);
export const ADJUSTMENT_TYPES = Object.freeze(Object.values(ADJUSTMENT));

/** Mihin ohjaava ehdotus vie (näkymä avaa työnkulun). */
export const ADJUSTMENT_NAVIGATION = Object.freeze({
  [ADJUSTMENT.REQUEST_ESTIMATES]: 'estimate',
  [ADJUSTMENT.START_TRACKING]: 'log_time'
});

/** Havainnon perusta sanoin: näkyy havainnon vieressä, ei vain "Miksi?"-osiossa. */
export const BASIS_LABELS = Object.freeze({
  planned: 'suunnitelman perusteella',
  actual: 'kirjatun ajan perusteella',
  targets: 'tavoitteiden perusteella'
});

function shortDate(iso) {
  if (typeof iso !== 'string') return '';
  const [, month, day] = iso.split('-').map(Number);
  return `${day}.${month}.`;
}

/** Lyhyet nimet kirjatun ajan lähteille (katsauksen "Tiedossa"-rivi). */
export const TIME_SOURCE_SHORT_LABELS = Object.freeze({ timer: 'ajastimella', manual: 'käsin' });

/**
 * Kirjattu aika lähteittäin näyttöä varten: [{source, label, minutes}].
 *
 * Vain näyttöä: minuutteja EI painoteta lähteen varmuuden mukaan
 * (realitySources.js: timer = exact, manual = reported). Seurannan
 * kypsyydessä (alignment.js trackingMaturity) ajastimella ja käsin
 * kirjattu päivä ovat samanarvoisia todisteita siitä, että päivä
 * kirjattiin. Tuntematon lähde ohitetaan.
 */
export function timeSourceSplit(bySource = {}) {
  return Object.keys(bySource || {})
    .filter(source => TIME_SOURCE_SHORT_LABELS[source] && Number.isFinite(bySource[source]) && bySource[source] > 0)
    .sort((a, b) => a.localeCompare(b))
    .map(source => ({ source, label: TIME_SOURCE_SHORT_LABELS[source], minutes: bySource[source] }));
}

/** Katsauksen seitsemän kysymystä. Järjestys on katsauksen järjestys. */
export const REVIEW_QUESTIONS = Object.freeze([
  'Mikä oli tällä viikolla tärkeää?',
  'Mitä suunnittelin?',
  'Mitä oikeasti tapahtui?',
  'Missä kuormitus ylittyi?',
  'Mikä jäi huomiotta?',
  'Missä todellisuus poikkesi tavoitteista?',
  'Mitä muutan ensi viikolla?'
]);

// ---------------------------------------------------------- selitykset

function areaName(areasById, id) {
  const area = id ? areasById.get(id) : null;
  return area ? area.name : 'Alue';
}

/**
 * Havainnon selitys suomeksi. Deterministinen: sama havainto tuottaa aina
 * saman lauseen. Sävy on toteava, ei moralisoiva.
 *
 * @returns {{title: string, text: string, why: string}}
 */
export function explainSignal(signal, areas = []) {
  const byId = new Map((areas || []).map(area => [area.id, area]));
  const m = signal.metrics || {};
  const name = areaName(byId, signal.areaId);

  switch (signal.kind) {
    case SIGNAL.OVERLOAD:
      if (signal.rule === 'overload.possible_with_unestimated') {
        return {
          title: 'Kuormitus voi ylittyä',
          text: `Arvioitu työ vie ${formatMinutes(m.plannedMinutes)} kapasiteetistasi `
            + `${formatMinutes(m.availableMinutes)}, ja lisäksi ${countOf(m.unknownCount, 'asia', 'asiaa')} on arvioimatta.`,
          why: `Tunnettu työ on vähintään ${Math.round(RULES.OVERLOAD_POSSIBLE_RATIO * 100)} % `
            + 'kapasiteetista ja osa työstä on ilman kestoarviota.'
        };
      }
      return {
        title: 'Kuormitus ylittää kapasiteetin',
        text: `Suunniteltu työ ${formatMinutes(m.plannedMinutes)} on ${formatMinutes(m.overageMinutes)} yli `
          + `viikon kapasiteetin ${formatMinutes(m.availableMinutes)}`
          + (m.percentOfCapacity !== null ? ` (${m.percentOfCapacity} % kapasiteetista).` : '.')
          + (m.unknownCount > 0 ? ` Lisäksi ${countOf(m.unknownCount, 'asia', 'asiaa')} on arvioimatta.` : ''),
        why: 'Arvioitujen kestojen summa on suurempi kuin itse asettamasi viikon kapasiteetti. '
          + `Vahva, kun ylitys on vähintään ${Math.round((RULES.OVERLOAD_STRONG_RATIO - 1) * 100)} %.`
      };

    case SIGNAL.NEGLECT:
      if (signal.basis === 'actual') {
        // Vertailu alkoi kesken viikon (ensimmäinen kirjaus tai alueen
        // luonti): sanotaan mistä, koska sitä edeltävät päivät ovat tuntemattomia.
        const partialWindow = Number.isFinite(m.trackedPercent) && Number.isFinite(m.weekProgressPercent)
          && m.trackedPercent < m.weekProgressPercent && m.trackedFrom;
        const windowPercent = Number.isFinite(m.trackedPercent) ? m.trackedPercent : m.weekProgressPercent;
        return {
          title: `${name} jäämässä huomiotta`,
          text: `${name}: kirjattu ${formatMinutes(m.actualMinutes)}, vaikka tavoitteesi mukaan tähän mennessä `
            + `olisi kertynyt noin ${formatMinutes(m.expectedByNowMinutes)} `
            + `(viikon tavoite ${formatMinutes(m.targetMinutes)}`
            + (partialWindow ? `, vertailu ${shortDate(m.trackedFrom)} alkaen` : '') + ').',
          why: `Alue on sinulle ${importanceLabel(byId.get(signal.areaId)?.importance).toLowerCase() || 'tärkeä'}, `
            + `ja kirjattu aika on alle ${Math.round(RULES.NEGLECT_RATIO * 100)} % siitä, mitä `
            + `${windowPercent} % viikosta vastaa.`
            + (partialWindow ? ` Vertailu alkaa ${shortDate(m.trackedFrom)}: sitä edeltävät päivät ovat tuntemattomia, eivät nollaa.` : '')
        };
      }
      if (signal.rule === NEGLECT_PLAN_UNKNOWN) {
        // Avoimet asiat ilman kestoa (vanhassa tilannekuvassa vain unknownCount).
        const open = Number.isInteger(m.openUnknownCount) ? m.openUnknownCount : m.unknownCount;
        return {
          title: `${name}: suunnitelman kesto ei vielä tiedossa`,
          text: `${name}: ${countOf(open, 'asia', 'asiaa')} ilman kestoarviota, joten suunnitelman aika `
            + `ei ole vielä tiedossa; arvioitua ${formatMinutes(m.plannedMinutes)}, tavoite ${formatMinutes(m.targetMinutes)}. `
            + 'Riittääkö aika, selviää, kun asiat on arvioitu.',
          why: 'Tärkeä alue, jonka suunnitelmasta osa on ilman kestoa. Tuntematon ei ole nolla, joten vajetta ei väitetä.'
        };
      }
      // Valmiiksi merkityt ilman kestoa ovat tieto, eivät "arvioi"-kehotus:
      // arviointi ei kysy niitä (vanhassa tilannekuvassa ei erottelua).
      const completedUnknown = Number.isInteger(m.openUnknownCount)
        ? Math.max(0, (m.unknownCount || 0) - m.openUnknownCount) : 0;
      const openUnknown = Math.max(0, (m.unknownCount || 0) - completedUnknown);
      return {
        title: `${name}: suunnitelmassa vähän aikaa`,
        text: `Tämän viikon suunnitelmassa ${name} saa ${formatMinutes(m.plannedMinutes)}, `
          + `tavoitteesi on ${formatMinutes(m.targetMinutes)}.`
          + (openUnknown > 0 ? ` (${countOf(openUnknown, 'asia', 'asiaa')} ilman kestoa.)` : '')
          + (completedUnknown > 0
            ? ` Tiedoksi: ${countOf(completedUnknown, 'valmiiksi merkitty', 'valmiiksi merkittyä')} ilman kestoa ei ole mukana.`
            : ''),
        why: `Tärkeä alue, jolle suunniteltu aika on alle ${Math.round(RULES.NEGLECT_RATIO * 100)} % `
          + 'viikkotavoitteesta. Suunnitelma on vielä muutettavissa.'
      };

    case SIGNAL.MISALIGNMENT: {
      const planned = signal.basis !== 'actual';
      const estimateLimited = planned && Number.isFinite(m.estimateCoveragePercent)
        && m.estimateCoveragePercent < Math.round(RULES.PLAN_FULL_ESTIMATE_COVERAGE * 100);
      const title = m.direction === 'over'
        ? `${name} vie ${planned ? 'suunnitelmassa ' : ''}enemmän kuin halusit`
        : `${name} saa ${planned ? 'suunnitelmassa ' : ''}vähemmän kuin halusit`;
      return {
        title,
        // Toteumassa osuus on KIRJATUSTA ajasta, ei eletystä ajasta.
        text: `${name} sai ${m.actualPercent} % ${planned ? 'suunnitellusta ajastasi' : 'kirjatusta ajastasi'}, `
          + `vaikka tavoite oli ${m.desiredPercent} %.`
          + (estimateLimited
            ? ` Vain ${m.estimateCoveragePercent} % suunnitelluista asioista on arvioitu, joten tämä on suuntaa-antava.`
            : m.incomplete ? ' Aineisto on vajaa, joten tämä on suuntaa-antava.' : ''),
        why: `Osuus poikkeaa toivomastasi jakaumasta vähintään ${RULES.MISALIGNMENT_POINTS} prosenttiyksikköä. `
          + 'Toivottu jakauma lasketaan alueiden viikkotavoitteista.'
          + (m.excludedAreaCount > 0
            ? ` Vertailusta puuttuu ${countOf(m.excludedAreaCount, 'kesken jakson luotu alue', 'kesken jakson luotua aluetta')}: `
              + `${m.excludedAreaCount === 1 ? 'sen' : 'niiden'} aiemmat päivät ovat tuntemattomia, joten jakauma `
              + 'lasketaan alueista, jotka olivat olemassa koko jakson.'
            : '')
      };
    }

    case SIGNAL.ENERGY_OVERLOAD: {
      const timeNote = m.timeOverloaded
        ? 'Myös aikakapasiteetti ylittyy.'
        : 'Aikaa näyttäisi olevan riittävästi, mutta suunniteltu viikko on energiakuormaltaan raskas.';
      if (signal.rule === 'energy.low_energy_heavy_share') {
        return {
          title: 'Raskas viikko matalalla energialla',
          text: `Arvioit viikon energiasi tasolle ${m.energyLevel}/5, ja ${m.heavySharePercent} % suunnitellusta `
            + `ajasta (${formatMinutes(m.heavyMinutes)}) on merkitty kuormittavaksi.`,
          why: `Oma energia-arviosi on enintään ${ENERGY_RULES.LOW_ENERGY_LEVEL}, ja vähintään `
            + `${Math.round(ENERGY_RULES.LOW_ENERGY_HEAVY_SHARE * 100)} % tunnetusta ajasta on kuormittavaa. `
            + 'Aseta kuormittavan ajan raja, niin vertailu on tarkempi. Aika ja energia ovat eri asioita.'
        };
      }
      if (signal.rule === 'energy.possible_with_unrated') {
        return {
          title: 'Energiaraja voi ylittyä',
          text: `Kuormittavaa tekemistä on ${formatMinutes(m.heavyMinutes)} rajastasi ${formatMinutes(m.energyBudgetMinutes)}, `
            + `ja ${countOf(m.unratedCount, 'asia', 'asiaa')} on ilman kuormittavuusarviota.`,
          why: `Kuormittavaa on vähintään ${Math.round(ENERGY_RULES.OVERLOAD_POSSIBLE_RATIO * 100)} % omasta rajastasi, `
            + 'ja osa työstä on arvioimatta.'
        };
      }
      return {
        title: 'Viikko on energiakuormaltaan raskas',
        text: `${timeNote} Kuormittavaa tekemistä on ${formatMinutes(m.heavyMinutes)}, `
          + `oma rajasi on ${formatMinutes(m.energyBudgetMinutes)} (yli ${formatMinutes(m.overageMinutes)}).`,
        why: `Kuormittavaksi (4) tai erittäin kuormittavaksi (5) merkityn työn kesto ylittää itse asettamasi rajan. `
          + `Vahva, kun ylitys on vähintään ${Math.round((ENERGY_RULES.OVERLOAD_STRONG_RATIO - 1) * 100)} %. `
          + 'Tämä on eri havainto kuin aikakuormitus.'
      };
    }

    case SIGNAL.TARGET_TENSION:
      return {
        title: 'Tavoitteet eivät mahdu viikkoon',
        text: `Alueiden aikatavoitteet ovat yhteensä ${formatMinutes(m.targetsMinutes)}, `
          + `kapasiteettisi ${formatMinutes(m.availableMinutes)}.`,
        why: 'Tärkeys ja kapasiteetti ovat eri asioita: kaikki voi olla tärkeää, mutta viikkoon mahtuu '
          + 'rajallisesti. Kumpaakaan ei muuteta puolestasi.'
      };

    default:
      return { title: 'Havainto', text: '', why: '' };
  }
}

// ---------------------------------------------------------- tilannekuva

/**
 * Tiivis, versioitu tilannekuva viikosta. Ei tehtävien otsikoita, ei
 * muistiinpanoja: vain luvut, alueiden nimet ja tunnisteet.
 */
export function buildReviewSnapshot(analysis) {
  const energy = analysis.energy || null;
  return {
    version: SNAPSHOT_VERSION,
    // Millä säännöillä havainnot syntyivät. Kynnysten virittäminen
    // myöhemmin ei muuta tämän katsauksen merkitystä.
    policyVersion: analysis.policyVersion || POLICY_VERSION,
    weekStart: analysis.weekStart,
    capacity: {
      availableMinutes: analysis.capacity.availableMinutes,
      energyLevel: analysis.capacity.energyLevel,
      energyBudgetMinutes: analysis.capacity.energyBudgetMinutes ?? null
    },
    energy: energy ? {
      heavyMinutes: energy.heavyMinutes, veryHeavyMinutes: energy.veryHeavyMinutes,
      unratedMinutes: energy.unratedMinutes, ratedPercent: energy.ratedPercent
    } : null,
    areas: analysis.areas.map(area => ({
      id: area.id, name: area.name, importance: area.importance, active: area.active,
      targetMinutes: area.targetMinutes, desiredPercent: area.desiredPercent,
      plannedMinutes: area.plannedMinutes, plannedUnknown: area.plannedUnknown,
      actualMinutes: area.actualMinutes, actualPercent: area.actualPercent
    })),
    planned: { ...analysis.planned },
    actual: { ...analysis.actual, entryDates: [...(analysis.actual.entryDates || [])] },
    // Versio 3: seurannan kypsyys (mistä vertailu alkoi, montako päivää kirjattiin).
    tracking: analysis.tracking ? { ...analysis.tracking } : null,
    unassigned: { ...analysis.unassigned },
    signals: analysis.signals.map(signal => ({
      kind: signal.kind, severity: signal.severity, areaId: signal.areaId,
      basis: signal.basis, rule: signal.rule, metrics: { ...signal.metrics }
    })),
    dataQuality: { ...analysis.dataQuality, reasons: [...analysis.dataQuality.reasons] }
  };
}

/**
 * Valinnaiset pohdintakysymykset (katsaus v2, osio "Miksi?"). Käyttäjä
 * voi ohittaa jokaisen. Vastaukset ovat käyttäjän sisältöä: niitä ei
 * lähetetä tekoälylle eikä kirjata lokiin.
 */
export const REFLECTION_PROMPTS = Object.freeze([
  Object.freeze({ code: 'took_longer', text: 'Mikä vei enemmän aikaa kuin odotit?' }),
  Object.freeze({ code: 'too_little', text: 'Mikä jäi liian vähälle?' }),
  Object.freeze({ code: 'unplanned_important', text: 'Mikä tuntui tärkeältä mutta ei näkynyt suunnitelmassa?' }),
  Object.freeze({ code: 'most_draining', text: 'Mikä kuormitti eniten?' }),
  Object.freeze({ code: 'drop_next_week', text: 'Kannattaako jotain jättää ensi viikolla tekemättä?' })
]);
export const REFLECTION_CODES = Object.freeze(REFLECTION_PROMPTS.map(prompt => prompt.code));
export const MAX_REFLECTION_ANSWER_LENGTH = 1000;

/** Vain tunnetut kysymykset, tyhjät pois, pituus rajattu. */
export function normalizeReflectionAnswers(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const code of REFLECTION_CODES) {
    const value = input[code];
    if (value === null || value === undefined) continue;
    const text = String(value).trim().slice(0, MAX_REFLECTION_ANSWER_LENGTH);
    if (text) out[code] = text;
  }
  return out;
}

export function normalizeAlignmentReview(input = {}) {
  const reflection = input.reflection == null
    ? null
    : String(input.reflection).trim().slice(0, MAX_REFLECTION_LENGTH) || null;
  const version = Number(input.snapshotVersion);
  const snapshot = input.snapshot && typeof input.snapshot === 'object' && !Array.isArray(input.snapshot)
    ? input.snapshot : {};
  const policy = Number(input.policyVersion);
  return {
    id: input.id != null ? String(input.id) : null,
    weekStart: typeof input.weekStart === 'string' ? input.weekStart : null,
    snapshotVersion: Number.isInteger(version) && version >= 1 ? version : SNAPSHOT_VERSION,
    snapshot,
    // Sääntöversio: nimenomainen kenttä, tai tilannekuvasta, tai 1
    // (ensimmäisen version katsaus ei tiennyt versiostaan).
    policyVersion: Number.isInteger(policy) && policy >= 1 ? policy : policyVersionOf(snapshot),
    reflection,
    reflectionAnswers: normalizeReflectionAnswers(input.reflectionAnswers),
    adjustments: Array.isArray(input.adjustments) ? input.adjustments : [],
    completedAt: input.completedAt ?? null,
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

export function validateAlignmentReview(review) {
  const errors = {};
  if (!review || !review.weekStart) errors.weekStart = 'Viikko puuttuu.';
  if (!review || !review.snapshot || review.snapshot.version === undefined) {
    errors.snapshot = 'Tilannekuva puuttuu.';
  }
  if (review && review.reflection && review.reflection.length > MAX_REFLECTION_LENGTH) {
    errors.reflection = `Pohdinta voi olla enintään ${MAX_REFLECTION_LENGTH} merkkiä.`;
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

// ------------------------------------------------------------ ehdotukset

function roundToQuarter(minutes) {
  return Math.max(0, Math.round(minutes / 15) * 15);
}

/** Havainnot lajeittain. Tiedoksi-tason havainto ehdottaa muutosta vain pyydettäessä. */
function signalsOf(analysis, kind, { includeInfo = false } = {}) {
  return analysis.signals.filter(signal =>
    signal.kind === kind && (includeInfo || signal.severity !== SEVERITY.INFO));
}

/**
 * Seuraavan viikon muutosehdotukset havaintojen perusteella.
 *
 * @param {object} analysis   tämän viikon analyzeWeek()-tulos
 * @param {object} context
 * @param {Array}  context.areas
 * @param {Array}  context.goals
 * @param {Array}  context.tasks
 * @param {object|null} [context.nextWeekAnalysis]  seuraavan viikon analyysi
 * @param {object|null} [context.nextCapacity]      seuraavan viikon kapasiteetti
 * @returns {Array<object>} ehdotukset; mitään ei ole muutettu
 */
export function proposeAdjustments(analysis, {
  areas = [], goals = [], tasks = [], nextWeekAnalysis = null, nextCapacity = null,
  recentAnalyses = []
} = {}) {
  const proposals = new Map();
  const add = proposal => { if (!proposals.has(proposal.id)) proposals.set(proposal.id, proposal); };
  const areasById = new Map(areas.map(area => [area.id, area]));
  const next = analysis.nextWeekStart;
  const targetsTotal = areas
    .filter(area => area.active && area.targetMinutesPerWeek > 0)
    .reduce((sum, area) => sum + area.targetMinutesPerWeek, 0);

  // 1. Kapasiteetti ensi viikolle, jos sitä ei ole asetettu. Jos viikko on
  //    päättynyt ja kirjattu toteuma poikkesi arviosta selvästi, ehdotus
  //    perustuu toteumaan — mutta arvo on käyttäjän muokattavissa, ja
  //    sanamuoto on kysymys, ei korjaus. Versio 3: vain kun kirjaaminen
  //    oli vakiintunut ja kattoi lähes koko viikon; muuten kirjattu aika
  //    kertoo kirjaamisesta, ei kapasiteetista.
  const tracking = analysis.tracking || null;
  const trackedWeek = Boolean(tracking) && tracking.level === TRACKING.ESTABLISHED
    && tracking.windowFraction >= REVIEW_RULES.CAPACITY_MIN_TRACKED_FRACTION;
  if (!nextCapacity) {
    const declared = analysis.capacity.availableMinutes;
    const actual = analysis.actual.minutes;
    const deviates = analysis.capacity.declared && analysis.progress.state === 'after'
      && analysis.actual.entryCount > 0 && declared > 0 && trackedWeek
      && Math.abs(actual - declared) >= REVIEW_RULES.CAPACITY_DEVIATION_MIN_MINUTES
      && Math.abs(actual - declared) / declared >= REVIEW_RULES.CAPACITY_DEVIATION_RATIO;
    const suggestion = deviates ? Math.round(actual / 30) * 30 : declared;
    add({
      id: `${ADJUSTMENT.SET_CAPACITY}:${next}`,
      type: ADJUSTMENT.SET_CAPACITY,
      reason: deviates ? { kind: 'capacity_deviation' } : null,
      label: deviates
        ? (actual < declared ? 'Pienennetäänkö ensi viikon kapasiteettioletusta?' : 'Kasvatetaanko ensi viikon kapasiteettioletusta?')
        : 'Aseta ensi viikon kapasiteetti',
      detail: deviates
        ? `Arvioit ehtiväsi ${formatMinutes(declared)}, ja kirjasit ${formatMinutes(actual)}. `
          + 'Voit pitää arviosi tai käyttää kirjattua aikaa lähtökohtana — valitse itse.'
        : analysis.capacity.declared
          ? `Tämän viikon arvio oli ${formatMinutes(declared)}.`
          : 'Ilman kapasiteettia kuormitusta ei voi arvioida.',
      payload: { weekStart: next, availableMinutes: suggestion }
    });
  }

  // 1b. Arvioimaton työ: ei kirjoita mitään, avaa arvioinnin.
  const unestimatedNext = nextWeekAnalysis ? nextWeekAnalysis.planned.unknownCount : 0;
  if (unestimatedNext > 0) {
    add({
      id: `${ADJUSTMENT.REQUEST_ESTIMATES}:${next}`,
      type: ADJUSTMENT.REQUEST_ESTIMATES,
      reason: { kind: 'data_quality' },
      label: `Arvioi ensi viikon ${countOf(unestimatedNext, 'asia', 'asiaa')}`,
      detail: 'Ilman kestoa näitä ei lasketa kuormaan. Karkea arvio riittää.',
      payload: { weekStart: next, count: unestimatedNext }
    });
  }

  // 1c. Kirjaaminen alkoi mutta ei vakiintunut (early/partial): ei
  //     kirjoita mitään, avaa ajan kirjauksen. Vasta kun viikosta on
  //     kulunut riittävästi, muuten ehdotus näkyisi jokaisen viikon
  //     alussa. Kokonaan kirjaamattomasta viikosta kertoo jo aineiston
  //     laatu ("Et ole vielä kirjannut…"); joka viikko toistuva kehotus
  //     olisi nalkutusta, eikä ajan kirjaaminen ole pakollista.
  if (tracking && (tracking.level === TRACKING.EARLY || tracking.level === TRACKING.PARTIAL)
      && targetsTotal > 0 && analysis.progress.fraction >= RULES.NEGLECT_MIN_PROGRESS) {
    add({
      id: `${ADJUSTMENT.START_TRACKING}:${next}`,
      type: ADJUSTMENT.START_TRACKING,
      reason: { kind: 'data_quality' },
      label: 'Kirjaa aikaa koko ensi viikon, niin katsaus voi verrata toteumaa tavoitteisiin',
      detail: `Tällä viikolla aikaa kirjattiin ${analysis.actual.daysWithEntries} päivänä. `
        + 'Kirjaamattomat päivät ovat tuntemattomia, eivät nollaa.',
      payload: { weekStart: next }
    });
  }

  const overloaded = analysis.signals.some(signal =>
    signal.kind === SIGNAL.OVERLOAD && signal.severity !== SEVERITY.INFO);

  // 2. Ensi viikon kuorman keventäminen: siirrä vähiten tärkeitä viikolla
  //    eteenpäin. Tehtävällä on aina päivä (validateTask), joten
  //    "ilman päivää" ei ole vaihtoehto: tehtävä siirtyy, se ei katoa.
  const cap = nextCapacity ? nextCapacity.availableMinutes : analysis.capacity.availableMinutes;
  if (nextWeekAnalysis && Number.isInteger(cap) && nextWeekAnalysis.planned.knownMinutes > cap) {
    const excess = nextWeekAnalysis.planned.knownMinutes - cap;
    const tasksById = new Map(tasks.map(task => [task.id, task]));
    const candidates = nextWeekAnalysis.items
      .filter(item => item.kind === 'task' && !item.completed && item.minutes !== null)
      .map(item => ({ item, task: tasksById.get(item.id), area: areasById.get(item.areaId) }))
      .filter(entry => entry.task && !entry.task.completed)
      .sort((a, b) =>
        // Liittämätön ensin, sitten vähiten tärkeä alue, sitten matalin prioriteetti.
        (a.area ? a.area.importance : 0) - (b.area ? b.area.importance : 0)
        || priorityWeight(b.task.priority) - priorityWeight(a.task.priority)
        || (b.item.date || '').localeCompare(a.item.date || '')
        || a.item.id.localeCompare(b.item.id));
    const chosen = [];
    let freed = 0;
    for (const entry of candidates) {
      if (freed >= excess) break;
      chosen.push(entry.item.id);
      freed += entry.item.minutes;
    }
    if (chosen.length > 0) {
      add({
        id: `${ADJUSTMENT.POSTPONE_TASKS}:${next}`,
        type: ADJUSTMENT.POSTPONE_TASKS,
        reason: { kind: SIGNAL.OVERLOAD },
        label: `Kevennä ensi viikkoa: siirrä ${countOf(chosen.length, 'tehtävä', 'tehtävää')} viikolla eteenpäin`,
        detail: `Ensi viikon suunnitelma ylittää kapasiteetin ${formatMinutes(excess)}. `
          + 'Tehtävät säilyvät; ne siirtyvät samalle viikonpäivälle viikkoa myöhemmin.',
        payload: { taskIds: chosen, freedMinutes: freed, days: 7 }
      });
    }
  }

  // 3. Kuormituksessa: keskeytä vähiten tärkeiden alueiden tavoitteita.
  if (overloaded) {
    const pausable = goals
      .filter(goal => goal && goal.status === 'active' && goal.lifeAreaId)
      .map(goal => ({ goal, area: areasById.get(goal.lifeAreaId) }))
      .filter(entry => entry.area && entry.area.importance <= 2)
      .sort((a, b) => a.area.importance - b.area.importance
        || priorityWeight(b.goal.priority) - priorityWeight(a.goal.priority)
        || a.goal.id.localeCompare(b.goal.id))
      .slice(0, MAX_PAUSE_PROPOSALS);
    for (const { goal, area } of pausable) {
      add({
        id: `${ADJUSTMENT.PAUSE_GOAL}:${goal.id}`,
        type: ADJUSTMENT.PAUSE_GOAL,
        reason: { kind: SIGNAL.OVERLOAD, areaId: area.id },
        label: `Keskeytä tavoite "${goal.title}"`,
        detail: `Alue ${area.name} on sinulle ${importanceLabel(area.importance).toLowerCase()}. `
          + 'Keskeytetty tavoite ei katoa; sen voi jatkaa milloin tahansa.',
        payload: { goalId: goal.id }
      });
    }
  }

  // 4. Huomiotta jäävä alue: varaa aikaa TAI muuta tavoitetta.
  // Suunnitelmaan perustuva huomiotta jääminen on tiedoksi-tasoa, mutta
  // juuri silloin ajan varaaminen on vielä helppoa: siksi mukaan.
  // `plan_unknown` ei ole vaje (kestot puuttuvat), joten siitä ei ehdoteta.
  for (const signal of signalsOf(analysis, SIGNAL.NEGLECT, { includeInfo: true })) {
    const area = areasById.get(signal.areaId);
    if (!area || !isNeglectShortfall(signal)) continue;
    const goal = goals
      .filter(entry => entry && entry.lifeAreaId === area.id && entry.status === 'active')
      .sort((a, b) => priorityWeight(a.priority) - priorityWeight(b.priority) || a.id.localeCompare(b.id))[0];
    const block = Math.min(REVIEW_RULES.RESERVE_BLOCK_MINUTES,
      area.targetMinutesPerWeek || REVIEW_RULES.RESERVE_BLOCK_MINUTES);
    add({
      id: `${ADJUSTMENT.CREATE_TASK}:${area.id}`,
      type: ADJUSTMENT.CREATE_TASK,
      reason: { kind: SIGNAL.NEGLECT, areaId: area.id },
      label: `Varaa aikaa: ${area.name}`,
      detail: `Uusi ${formatMinutes(block)} varaus ensi viikolle`
        + (goal ? ` tavoitteeseen "${goal.title}".` : '.'),
      payload: {
        title: `Aikaa: ${area.name}`, date: next, durationMinutes: block,
        goalId: goal ? goal.id : null, category: area.categoryKey || null, areaId: area.id
      }
    });

    // Tavoitteen muutos vain vakiintuneesta toteumasta (versio 3): osittain
    // kirjatun viikon "tahti" tai suunnitelman minuutit eivät kerro, mitä
    // alue saa. Ehdotettu arvo on vähintään mielekkään tavoitteen alaraja;
    // 0 tarkoittaisi "ei nyt" ja hiljentäisi alueen pysyvästi.
    if (signal.basis !== 'actual' || !tracking || tracking.level !== TRACKING.ESTABLISHED) continue;
    const m = signal.metrics;
    const fraction = m.targetMinutes > 0 && Number.isFinite(m.expectedByNowMinutes)
      ? m.expectedByNowMinutes / m.targetMinutes : analysis.progress.fraction;
    const observed = roundToQuarter((m.actualMinutes || 0) / Math.max(fraction, 1 / 7));
    if (observed < area.targetMinutesPerWeek && observed >= RULES.NEGLECT_MIN_TARGET_MINUTES) {
      add({
        id: `${ADJUSTMENT.CHANGE_TARGET}:${area.id}`,
        type: ADJUSTMENT.CHANGE_TARGET,
        reason: { kind: SIGNAL.NEGLECT, areaId: area.id },
        label: `${area.name}: pidetäänkö tavoite vai muutetaanko suunnitelmaa?`,
        detail: `Tavoitteesi on ${formatMinutes(area.targetMinutesPerWeek)}; tämän viikon tahdilla `
          + `${formatMinutes(observed)}. Tavoite voi olla juuri oikea — silloin varaa aikaa. `
          + 'Jos haluat muuttaa tavoitetta, valitse uusi arvo itse.',
        payload: { areaId: area.id, from: area.targetMinutesPerWeek, to: observed }
      });
    }
  }

  // 5. Jakauman poikkeama: päivitä tavoite TAI jätä ennalleen. Vain
  //    ehdotus tavoitteen muuttamisesta; ajan siirto tapahtuu kohdissa 2 ja 4.
  for (const signal of signalsOf(analysis, SIGNAL.MISALIGNMENT)) {
    const area = areasById.get(signal.areaId);
    if (!area || !area.active || !Number.isInteger(area.targetMinutesPerWeek)) continue;
    // Suuntaa-antavasta (vajaa aineisto, arvioimatonta työtä) ei ehdoteta
    // tavoitteen muutosta.
    if (signal.metrics.incomplete) continue;
    // Tavoite, jolla toivottu osuus vastaisi toteutunutta, kun muiden
    // alueiden tavoitteet pysyvät ennallaan: osuus x tavoitteiden summa
    // (vain vertailussa mukana olleiden alueiden, jos osa luotiin kesken).
    const share = (signal.metrics.basisMinutes || 0) / Math.max(signal.metrics.assignedMinutes || 1, 1);
    const suggested = roundToQuarter(share * (signal.metrics.comparedTargetsMinutes || targetsTotal));
    if (suggested === area.targetMinutesPerWeek) continue;
    // Alle mielekkään tavoitteen alarajan ei esitäytetä: 0 tai 15 min
    // tarkoittaisi käytännössä "ei nyt" ja hiljentäisi alueen.
    if (suggested < RULES.NEGLECT_MIN_TARGET_MINUTES) continue;
    add({
      id: `${ADJUSTMENT.CHANGE_TARGET}:${area.id}`,
      type: ADJUSTMENT.CHANGE_TARGET,
      reason: { kind: SIGNAL.MISALIGNMENT, areaId: area.id },
      label: `${area.name}: pidetäänkö tavoite vai muutetaanko suunnitelmaa?`,
      detail: `Toteutunut osuus ${signal.metrics.actualPercent} %, toiveesi ${signal.metrics.desiredPercent} %. `
        + 'Jos toiveesi on yhä sama, muuta suunnitelmaa; jos todellisuus kuvaa haluamaasi paremmin, '
        + 'voit päivittää tavoitteen. Kumpikin on sinun päätöksesi.',
      payload: { areaId: area.id, from: area.targetMinutesPerWeek, to: suggested }
    });
  }

  // 6. Hiljainen tavoite: ei suunniteltua eikä kirjattua aikaa useaan
  //    viikkoon, ja alue on vähemmän tärkeä tai tavoitteen prioriteetti
  //    matala. Keskeytys on ehdotus; tavoite ei katoa.
  const recentWeeks = [analysis, ...(recentAnalyses || [])].filter(Boolean);
  if (recentWeeks.length >= REVIEW_RULES.INACTIVE_GOAL_WEEKS) {
    const touched = new Set();
    const goalsById = new Map(goals.filter(Boolean).map(goal => [goal.id, goal]));
    for (const week of recentWeeks.slice(0, REVIEW_RULES.INACTIVE_GOAL_WEEKS)) {
      for (const item of week.items || []) if (item.goalId) touched.add(item.goalId);
      for (const goalId of week.activeGoalIds || []) touched.add(goalId);
    }
    // Ylätavoite on aktiivinen, jos sen alatavoite on.
    for (const goalId of [...touched]) {
      let parent = goalsById.get(goalId)?.parentGoalId;
      const seen = new Set();
      while (parent && !seen.has(parent)) { seen.add(parent); touched.add(parent); parent = goalsById.get(parent)?.parentGoalId; }
    }
    const quiet = goals
      .filter(goal => goal && goal.status === 'active' && !touched.has(goal.id))
      .map(goal => ({ goal, area: areasById.get(goal.lifeAreaId) || null }))
      .filter(({ goal, area }) => (area && area.importance <= 3) || goal.priority === 'matala')
      .sort((a, b) => (a.area ? a.area.importance : 0) - (b.area ? b.area.importance : 0)
        || a.goal.id.localeCompare(b.goal.id))
      .slice(0, MAX_PAUSE_PROPOSALS);
    for (const { goal } of quiet) {
      add({
        id: `${ADJUSTMENT.PAUSE_GOAL}:${goal.id}`,
        type: ADJUSTMENT.PAUSE_GOAL,
        reason: { kind: 'inactive_goal' },
        label: `Keskeytetäänkö hiljainen tavoite "${goal.title}"?`,
        detail: `Tavoitteelle ei ole suunniteltu eikä kirjattu aikaa ${REVIEW_RULES.INACTIVE_GOAL_WEEKS} viikkoon. `
          + 'Keskeytys vapauttaa sen mielestä; tavoite ei katoa ja sen voi jatkaa milloin tahansa.',
        payload: { goalId: goal.id }
      });
    }
  }

  return [...proposals.values()].slice(0, MAX_PROPOSALS);
}

// ------------------------------------------------ palaute suunnittelulle

/**
 * Suunnan palaute Tavoitteesta tekemiseksi -moottorille.
 *
 * Vain luvut ja tunnisteet; ei muuta mitään. `capHours` rajaa suunnittelun
 * olettaman viikon vapaan ajan (planSchema.buildPlanningContext), kun
 * käyttäjä on itse sanonut ehtivänsä vähemmän — tai kun viikko ylittyi.
 */
export function planningFeedback(analysis, { nextCapacity = null } = {}) {
  if (!analysis) return null;
  const overload = analysis.signals.find(signal => signal.kind === SIGNAL.OVERLOAD
    && signal.severity !== SEVERITY.INFO);
  const declared = nextCapacity && Number.isInteger(nextCapacity.availableMinutes)
    ? nextCapacity.availableMinutes
    : analysis.capacity.availableMinutes;
  // Painotettavat: todetut vajeet (ei `plan_unknown`: kestot puuttuvat).
  // Sama alue ei voi olla kummassakin listassa.
  const prioritizeAreaIds = analysis.signals.filter(isNeglectShortfall).map(signal => signal.areaId);
  const prioritized = new Set(prioritizeAreaIds);
  return {
    overloaded: Boolean(overload),
    capHours: Number.isInteger(declared) ? Math.floor(declared / 60) : null,
    reduceByMinutes: overload ? overload.metrics.overageMinutes : 0,
    prioritizeAreaIds,
    deprioritizeAreaIds: analysis.signals
      .filter(signal => signal.kind === SIGNAL.MISALIGNMENT && signal.metrics.direction === 'over')
      .map(signal => signal.areaId)
      .filter(areaId => !prioritized.has(areaId))
  };
}
