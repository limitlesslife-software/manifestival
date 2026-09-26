// Suunta-näkymä: elämänalueet, viikon kapasiteetti, suunnitelma vs.
// toteuma, havainnot ja viikkokatsaus.
//
// Näkymä ei laske mitään itse: yksi analyzeCurrentWeek()-kutsu per
// renderöinti, ja jokainen osio lukee saman tuloksen. Havainnon
// vakavuus kerrotaan aina TEKSTINÄ (ei vain värillä), ja jokaisella
// havainnolla on "Miksi?"-osio, joka näyttää säännön ja luvut.
//
// Sävy on toteava. Tämä ei ole suorituspisteytys: valmistumisprosenttia
// ei näytetä pääviestinä missään.

import { el, maybe, toggle, setText, focus, setBusy, singleFlight } from '../../ui/dom.js';
import { escapeHtml } from '../../lib/format.js';
import { fmtISO, todayMidnight } from '../../lib/datetime.js';
import { getState, findLifeArea, findTask, findRoutine, findGoal, findProject } from '../state.js';
import { switchTab } from '../navigation.js';
import { CATEGORIES } from '../../domain/categories.js';
import {
  SUGGESTED_AREAS, importanceLabel, formatMinutes, compareLifeAreas, countOf
} from '../../domain/lifeArea.js';
import { weekDates, weekStartOf, capacityWarnings, capacityForWeek } from '../../domain/weeklyCapacity.js';
import { entriesInRange } from '../../domain/timeEntry.js';
import {
  SIGNAL, SEVERITY, SEVERITY_LABELS, QUALITY, TRACKING, buildAttributionIndex, areaForTimeEntry,
  NEGLECT_PLAN_UNKNOWN, isNeglectShortfall
} from '../../domain/alignment.js';
import { estimateCandidates, ESTIMATE_BUCKET_LABELS } from '../../domain/estimateQueue.js';
import { categoryImpact } from '../../domain/alignmentSetup.js';
import {
  explainSignal, REVIEW_QUESTIONS, ADJUSTMENT, REFLECTION_CODES, NON_WRITING_ADJUSTMENTS,
  ADJUSTMENT_NAVIGATION, BASIS_LABELS, timeSourceSplit
} from '../../domain/alignmentReview.js';
import {
  qualityIssues, QUALITY_ACTION, QUALITY_ACTION_LABELS, estimateConfidence, ESTIMATE_CONFIDENCE,
  SPARSE_ESTIMATES_NOTICE, openUnknownCountOf
} from '../../domain/alignmentQuality.js';
import { POLICY_VERSIONS, ESTIMATE_PRESETS } from '../../domain/alignmentPolicy.js';
import { energyDemandLabel } from '../../domain/alignmentItemSettings.js';
import { addDaysIso } from '../../domain/fiTemporal.js';
import { durationOf } from '../../domain/task.js';
import {
  analyzeCurrentWeek, currentProposals, currentWeekStart, alignmentPersistence,
  createLifeArea, editLifeArea, deleteLifeArea, assignGoalToLifeArea,
  saveWeeklyCapacity, logTime, deleteTimeEntry, saveWeeklyReview, applyAdjustment,
  applySelectedAdjustments, previewSelectedAdjustments, compareWithPreviousWeek, recentTrends,
  currentDailyAlignment, explainSignalOptionally, aiExplanationAvailable, pendingTimeEntryCount,
  pendingTimeEntryOperations, isAdjustmentDone, failedTimeEntries, failedTimeEntryOperations,
  retryFailedTimeEntries, discardFailedTimeEntries, analysisLoadProblems, editTimeEntry, clockNow
} from '../alignment.js';
import { saveItemSettings, itemSettingsFor, currentTimer, newOperationId } from '../timeTracking.js';
import { editTask, editRoutine } from '../actions.js';
import { openGeneralLog, openTimerChooser } from './timeLog.js';
import {
  renderDirectionSetup, initDirectionSetup, resetDirectionSetup, openDirectionSetup,
  dismissDirectionSetup, currentLegacySummary, legacyNoticeText
} from './directionSetup.js';

/** Näytettävä viikko (maanantai). null = tämä viikko. Näkymän oma tila. */
let viewWeek = null;
/**
 * Viikko, joka viimeksi PIIRRETTIIN. Tallennukset menevät tälle viikolle,
 * eivät kellon mukaiselle (RACE-06): sunnuntaina 23.55 aloitettu katsaus,
 * joka tallennetaan maanantaina 00.02, kuuluu näkyvissä olleelle viikolle.
 */
let renderedWeek = null;
/** Muokattavan alueen tunniste; null = uusi. */
let editingAreaId = null;
/** Viimeksi näytetyt ehdotukset: painike viittaa tunnisteella. */
let shownProposals = [];
/** Valitut ehdotukset ryhmävahvistusta varten. */
let selectedProposalIds = new Set();
/** Viimeisin esikatselu (valinnoille); valinnan muutos mitätöi sen. */
let lastPreview = null;
/** Työnkulut auki? */
let estimateOpen = false;
/** 'duration' = kestoarviot, 'energy' = kuormittavuusarviot. */
let estimateMode = 'duration';
let unassignedOpen = false;
/** Tällä kertaa ohitetut luokittelemattomat (ei tallenneta: ei nalkutusta, ei päätöstä). */
let skippedUnassigned = new Set();
/**
 * Arviojono (F4). Jono KIINNITETÄÄN avattaessa: uudelleenpiirto (joka
 * tallennuksen jälkeen) ei vaihda järjestystä eikä tuo uutta asiaa juuri
 * napautetun kohdalle. Aktiivinen kortti on jonon ensimmäinen asia, jota
 * ei ole arvioitu tai ohitettu.
 *
 * { scope, weekStart, items, done: Map(avain -> {minutes, previous}),
 *   skipped: Set, saving, armed, customOpen, approximate, overdueAdded }
 */
let estimateQueue = null;
/** Seuraavan kortin painikkeet heräävät vasta tämän jälkeen (kaksoisnapautus). */
export const ESTIMATE_REARM_MS = 300;
/** Toteuma-lista vain alueettomiin kirjauksiin ("Kohdista kirjattu aika"). */
let timeListUnassignedOnly = false;
/** Havaintojen selitykset: `kind:areaId` -> { source, text }. */
let explanations = new Map();
/** Kesken olevat selityshaut: painike pysyy estettynä uudelleenrenderöinnin yli. */
let explainsInFlight = new Set();
/** Viimeisin analyysi (selitys käyttää samaa aineistoa, ei laske uudelleen). */
let lastAnalysis = null;
/** Kasvaa uloskirjautuessa: sen jälkeen valmistuva selitys hylätään. */
let viewGeneration = 0;
/** Kehitys lasketaan vasta pyydettäessä (kahdeksan viikon analyysi). */
let trendsRequested = false;
/** Kuinka monta luokittelematonta/arvioimatonta näytetään kerralla. */
const WORKFLOW_BATCH = 5;

const OPEN_GOAL_STATUSES = new Set(['active', 'paused', 'maintenance']);

function shownWeek() {
  return viewWeek || currentWeekStart();
}

/** Tallennuksen viikko: näkyvissä oleva, ei napautushetken kellon viikko. */
function targetWeek() {
  return renderedWeek || shownWeek();
}

/**
 * Kiinnittikö keskeneräinen syöte näkyvän viikon (markDirty)? Käyttäjän oma
 * selaus (edellinen, seuraava, tämä viikko, ehdotuksen viikko) EI ole
 * luonnoksen kiinnitys, eikä sitä vapauteta tallennuksessa.
 */
let pinnedByDraft = false;

/**
 * Keskeneräinen syöte kiinnittää näkyvän viikon: seuraava piirto (esim.
 * datan päivitys keskiyön jälkeen) ei vaihda viikkoa puoliksi kirjoitetun
 * katsauksen tai kapasiteetin alta.
 */
function markDirty(field) {
  if (!field || !field.dataset) return;
  field.dataset.dirty = '1';
  if (viewWeek === null && renderedWeek) {
    viewWeek = renderedWeek;
    pinnedByDraft = true;
  }
}

const CAPACITY_FIELDS = Object.freeze(['dirCapacityHours', 'dirEnergy', 'dirEnergyBudget']);

/** Kentät, joiden keskeneräinen syöte kiinnittää viikon. */
function draftFieldIds() {
  return [...CAPACITY_FIELDS, 'dirReflection', ...REFLECTION_CODES.map(code => `dirAnswer-${code}`)];
}

/**
 * Tallennus onnistui. Jos viikko oli kiinnitetty vain luonnoksen takia
 * eikä keskeneräistä syötettä ole jäljellä, näkymä seuraa taas kelloa:
 * viikon vaihteen yli auki ollut sovellus ei jää vanhalle viikolle.
 * Vaikuttaa seuraavasta piirrosta alkaen (ei hyppää juuri tallennetun alta).
 */
function releaseDraftPin() {
  if (!pinnedByDraft) return;
  const dirty = draftFieldIds().some(id => {
    const field = maybe(id);
    return Boolean(field && field.dataset && field.dataset.dirty);
  });
  if (dirty) return;
  pinnedByDraft = false;
  viewWeek = null;
}

function clearCapacityDirty() {
  for (const id of CAPACITY_FIELDS) {
    const field = maybe(id);
    if (field) delete field.dataset.dirty;
  }
}

// ---------------------------------------------------------- muotoilu

function shortDate(iso) {
  const [, month, day] = iso.split('-').map(Number);
  return `${day}.${month}.`;
}

function weekLabel(weekStart) {
  const dates = weekDates(weekStart);
  if (dates.length === 0) return '';
  const year = dates[6].slice(0, 4);
  return `${shortDate(dates[0])}–${shortDate(dates[6])}${year}`;
}

function hours(minutes) {
  return Number.isFinite(minutes) ? formatMinutes(minutes) : '–';
}

function toMinutesFromHours(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) ? Math.round(number * 60) : NaN;
}

function toHoursInput(minutes) {
  return Number.isInteger(minutes) ? String(Math.round((minutes / 60) * 100) / 100) : '';
}

/** Virheilmoitus näkyviin tai piiloon. .field-error on oletuksena piilossa. */
function setError(id, message) {
  const node = maybe(id);
  if (!node) return;
  node.textContent = message || '';
  node.style.display = message ? 'block' : 'none';
}

function severityClass(severity) {
  return severity === SEVERITY.STRONG ? 'dir-strong'
    : severity === SEVERITY.ATTENTION ? 'dir-attention' : 'dir-info';
}

// ---------------------------------------------------------- osiot

function persistNoteHtml() {
  const persistence = alignmentPersistence();
  if (Object.values(persistence).every(Boolean)) return '';
  return '<p class="hint"><strong>Huom.</strong> Suunnan tiedot (elämänalueet, kapasiteetti, '
    + 'kirjattu aika ja katsaukset) säilyvät toistaiseksi vain tämän istunnon ajan.</p>';
}

const QUALITY_REASONS = Object.freeze({
  no_areas: 'elämänalueita ei ole määritelty',
  no_targets: 'alueilla ei ole aikatavoitteita',
  no_capacity: 'viikon kapasiteettia ei ole asetettu',
  unestimated_work: 'osalta työstä puuttuu kestoarvio',
  unestimated_completed: 'osalta valmiiksi merkityistä puuttuu kestoarvio',
  unassigned_work: 'osa työstä ei kuulu mihinkään alueeseen',
  no_actual: 'toteutunutta aikaa ei ole kirjattu',
  unassigned_actual: 'osa kirjatusta ajasta ei kuulu mihinkään alueeseen',
  partial_actual: 'aikaa on kirjattu vasta osalta viikosta'
});

const QUALITY_LABELS = Object.freeze({
  [QUALITY.GOOD]: 'Kattava',
  [QUALITY.PARTIAL]: 'Osittainen',
  [QUALITY.WEAK]: 'Vajaa',
  [QUALITY.NONE]: 'Ei aineistoa'
});

function qualityHtml(analysis) {
  const quality = analysis.dataQuality;
  if (quality.level === QUALITY.GOOD) return '';
  const reasons = quality.reasons.map(code => QUALITY_REASONS[code]).filter(Boolean);
  return `<p class="hint dir-quality"><strong>Aineisto: ${escapeHtml(QUALITY_LABELS[quality.level])}.</strong> `
    + `${escapeHtml(reasons.join(', '))}. Havainnot perustuvat vain siihen mitä on tiedossa.</p>`;
}

/**
 * Havainnon avain selitykselle. Sisältää mittareiden tiivisteen: kun
 * luvut muuttuvat, vanha selitys ei enää vastaa havaintoa eikä näy.
 */
function signalKey(signal) {
  const metrics = JSON.stringify(signal.metrics || {});
  let hash = 0;
  for (let i = 0; i < metrics.length; i++) hash = ((hash * 31) + metrics.charCodeAt(i)) >>> 0;
  return `${signal.kind}:${signal.areaId || 'week'}:${hash.toString(36)}`;
}

/** Havainnon luvut suomeksi ("Tekniset luvut"). Tuntematon avain näytetään sellaisenaan. */
const METRIC_LABELS = Object.freeze({
  // "Arvioitu": vain kestoarvion saaneet asiat. Arvioimaton ei ole nolla.
  plannedMinutes: 'Arvioitu suunniteltu (min)',
  availableMinutes: 'Kapasiteetti (min)',
  overageMinutes: 'Ylitys (min)',
  percentOfCapacity: 'Osuus kapasiteetista (%)',
  unknownCount: 'Ilman kestoarviota (kpl)',
  targetMinutes: 'Viikon tavoite (min)',
  expectedByNowMinutes: 'Tavoitteen mukaan tähän mennessä (min)',
  actualMinutes: 'Kirjattu (min)',
  percentOfExpected: 'Kirjattu tavoitteen mukaisesta (%)',
  weekProgressPercent: 'Viikosta kulunut (%)',
  trackedPercent: 'Vertailujakso viikosta (%)',
  trackedFrom: 'Vertailu alkaen',
  trackedDays: 'Kirjauspäiviä',
  percentOfTarget: 'Arvioitu tavoitteesta (%)',
  openUnknownCount: 'Avoimia ilman kestoarviota (kpl)',
  excludedAreaCount: 'Kesken jakson luotuja alueita, ei vertailussa (kpl)',
  comparedTargetsMinutes: 'Vertailtujen alueiden tavoitteet (min)',
  actualTracked: 'Aikaa kirjattu viikolle',
  trackingLevel: 'Kirjaamisen tila',
  direction: 'Suunta',
  desiredPercent: 'Toivottu osuus (%)',
  actualPercent: 'Toteutunut osuus (%)',
  deviationPoints: 'Poikkeama (%-yksikköä)',
  basisMinutes: 'Alueen aika (min)',
  assignedMinutes: 'Alueisiin liitetty aika (min)',
  coveragePercent: 'Alueisiin liitetty osuus (%)',
  incomplete: 'Suuntaa-antava',
  estimateCoveragePercent: 'Arvioitu osuus asioista (%)',
  targetsMinutes: 'Tavoitteet yhteensä (min)',
  differenceMinutes: 'Erotus (min)',
  heavyMinutes: 'Kuormittavaa (min)',
  veryHeavyMinutes: 'Erittäin kuormittavaa (min)',
  energyBudgetMinutes: 'Oma raja (min)',
  percentOfBudget: 'Osuus rajasta (%)',
  unratedCount: 'Ilman kuormittavuusarviota (kpl)',
  unratedMinutes: 'Ilman kuormittavuusarviota (min)',
  timeOverloaded: 'Aikakapasiteetti ylittyy',
  heavySharePercent: 'Kuormittavan osuus (%)',
  energyLevel: 'Oma energia-arvio (1–5)',
  knownMinutes: 'Arvioitu aika (min)'
});

const TRACKING_LABELS = Object.freeze({
  [TRACKING.NONE]: 'ei kirjauksia', [TRACKING.EARLY]: 'alkuvaiheessa',
  [TRACKING.PARTIAL]: 'osittainen', [TRACKING.ESTABLISHED]: 'vakiintunut'
});

function metricValue(key, value) {
  if (value === null || value === undefined) return '–';
  if (typeof value === 'boolean') return value ? 'kyllä' : 'ei';
  if (key === 'direction') return value === 'over' ? 'yli toiveen' : value === 'under' ? 'alle toiveen' : String(value);
  if (key === 'trackingLevel') return TRACKING_LABELS[value] || String(value);
  if (key === 'trackedFrom' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return shortDate(value);
  return String(value);
}

/**
 * Havainto: vakavuus sanana, otsikko ja PERUSTA näkyvänä (suunnitelma vai
 * kirjattu aika) — ei vain "Miksi?"-osion sisällä. Säännön tunniste ja
 * luvut ovat omassa "Tekniset luvut" -osiossaan suomenkielisin nimin.
 */
function signalHtml(signal, areas) {
  const text = explainSignal(signal, areas);
  const metrics = Object.entries(signal.metrics || {})
    .map(([key, value]) => `${escapeHtml(METRIC_LABELS[key] || key)}: ${escapeHtml(metricValue(key, value))}`).join(' · ');
  const key = signalKey(signal);
  const explained = explanations.get(key);
  const basis = BASIS_LABELS[signal.basis] || '';
  return `
    <div class="dir-signal ${severityClass(signal.severity)}">
      <div class="dir-signal-head">
        <span class="dir-severity">${escapeHtml(SEVERITY_LABELS[signal.severity])}</span>
        <span class="dir-signal-title">${escapeHtml(text.title)}</span>
        ${basis ? `<span class="assist-tag dir-basis">${escapeHtml(basis)}</span>` : ''}
      </div>
      <div class="dir-signal-text">${escapeHtml(text.text)}</div>
      <details class="dir-why">
        <summary>Miksi tämä näkyy?</summary>
        <p>${escapeHtml(text.why)}</p>
        <details class="dir-why dir-tech">
          <summary>Tekniset luvut</summary>
          <p class="dir-rule">Sääntö: ${escapeHtml(signal.rule)} · perusta: ${escapeHtml(basis || signal.basis)}<br>${metrics}</p>
        </details>
        ${explained
          ? `<div class="dir-explanation" role="status"><strong>${explained.source === 'ai'
              ? 'Tekoälyn selitys (ei päätä mitään puolestasi):' : 'Selitys:'}</strong> ${escapeHtml(explained.text)}</div>`
          : explainButtonHtml(key)}
      </details>
    </div>`;
}

/**
 * Tekoälyselityksen painike. Ei mitään, kun selitys on pois käytöstä
 * (AI_EXPLAIN_ENABLED): deterministinen selitys on jo yllä. Nimi kertoo,
 * että kyse on tekoälystä, ja vihje sen, mitä laitteelta lähtee.
 */
function explainButtonHtml(key) {
  if (!aiExplanationAvailable()) return '';
  const pending = explainsInFlight.has(key);
  return `<button class="assist-btn" type="button" data-explain="${escapeHtml(key)}"${pending ? ' disabled' : ''}>`
    + `${pending ? 'Haetaan selitystä…' : 'Selitä tekoälyllä'}</button>`
    + '<p class="hint">Lähettää vain luvut, ei nimiä eikä otsikoita.</p>';
}

/** Aineiston laatu v2: mitä puuttuu ja mitä sille voi tehdä. Ei moralisointia. */
function qualityActionsHtml(analysis) {
  // Harvan arvioaineiston ilmoitus näkyy jo havaintojen yläpuolella.
  const issues = qualityIssues(analysis).filter(issue => issue.code !== 'sparse_estimates');
  if (issues.length === 0) return '';
  return `<div class="dir-quality-list" role="group" aria-label="Aineiston täydennys">
    ${issues.map(issue => `
      <div class="dir-quality-row">
        <p class="dir-line">${escapeHtml(issue.text)}</p>
        ${issue.action ? `<button class="assist-btn" type="button" data-quality-action="${escapeHtml(issue.action)}">`
          + `${escapeHtml(QUALITY_ACTION_LABELS[issue.action])}</button>` : ''}
      </div>`).join('')}
  </div>`;
}

/**
 * Suunnan kokoelmat, joiden haku epäonnistui. Epäonnistunut haku EI
 * tyhjennä tilaa (actions.js applyLoadResult), mutta ENSIMMÄISELLÄ
 * latauksella tila on tyhjä — ja ilman tätä näkymä sanoisi "elämänalueita
 * ei ole määritelty", vaikka ne ovat tallessa kannassa. Käyttäjä voisi
 * silloin luoda alueet uudelleen tai kirjata aikaa kahteen kertaan.
 */
const ALIGNMENT_DOMAINS = Object.freeze([
  'lifeAreas', 'weeklyCapacities', 'timeEntries', 'alignmentReviews',
  'runningTimers', 'alignmentItemSettings'
]);

export function alignmentLoadProblems(state = getState()) {
  const status = state.dataLoadStatus || {};
  return ALIGNMENT_DOMAINS.filter(domain => status[domain] && status[domain].ok === false);
}

/**
 * Tunnetaanko käyttäjän elämänalueet? Vain onnistuneen haun jälkeen:
 * tyhjä latausstatus ({} uloskirjautumisesta ensimmäiseen lataustulokseen)
 * tarkoittaa "ei vielä tiedossa", ei "ei alueita".
 */
function lifeAreasKnown(state) {
  const status = (state.dataLoadStatus || {}).lifeAreas;
  return Boolean(status) && status.ok !== false && status.lastSuccessAt != null;
}

function loadProblemHtml(problems) {
  if (problems.length === 0) return '';
  return '<p class="hint" role="alert"><strong>Osa Suunnan tiedoista ei latautunut.</strong> '
    + 'Tallennettu tieto on tallessa, mutta tämä näkymä voi olla vajaa. Älä luo alueita '
    + 'tai kirjaa aikaa uudelleen — päivitä, kun yhteys toimii.</p>';
}

/**
 * Havaintojen ja ehdotusten tilalle, kun jonkin analyysin syötteen lataus
 * epäonnistui (ERR-04): vajaista luvuista ei näytetä "alue ei saanut
 * aikaa" -havaintoja eikä ehdoteta muutoksia.
 */
function analysisLoadNoticeHtml() {
  return '<p class="hint dir-load-notice" role="status"><strong>Kaikkia tietoja ei saatu ladattua.</strong> '
    + 'Havaintoja ja ehdotuksia ei näytetä vajailla luvuilla. Tallennettu tieto on tallessa — '
    + 'päivitä, kun yhteys toimii.</p>';
}

/**
 * Harvan arvioaineiston ilmoitus ENSIMMÄISENÄ havaintojen yläpuolella
 * (role=status). Havainnot näkyvät yhä sen alla: sovellus on käytettävä
 * vähälläkin aineistolla.
 */
function sparseNoticeHtml(analysis) {
  if (estimateConfidence(analysis) === ESTIMATE_CONFIDENCE.OK) return '';
  const { estimatedCount = 0, itemCount = 0 } = analysis.planned || {};
  const action = openUnknownCountOf(analysis) > 0
    ? `<button class="assist-btn" type="button" data-quality-action="${escapeHtml(QUALITY_ACTION.ESTIMATE)}">`
      + `${escapeHtml(QUALITY_ACTION_LABELS[QUALITY_ACTION.ESTIMATE])}</button>`
    : '';
  return `<div class="dir-quality-row dir-sparse" role="status">
      <p class="dir-line"><strong>${escapeHtml(SPARSE_ESTIMATES_NOTICE)}</strong>
        Kestoarvio on ${estimatedCount}/${itemCount} tämän viikon asiasta.</p>
      ${action}
    </div>`;
}

function signalsHtml(analysis, areas) {
  if (areas.length === 0) {
    return '<div class="assist-empty">Havainnot alkavat, kun kerrot mikä sinulle on tärkeää. '
      + 'Aloita elämänalueista alempana.</div>';
  }
  const list = analysis.signals.length === 0
    ? '<div class="assist-empty">Ei havaintoja tällä viikolla sen perusteella, mitä on tiedossa.</div>'
    : analysis.signals.map(signal => signalHtml(signal, areas)).join('');
  return sparseNoticeHtml(analysis) + list + qualityHtml(analysis);
}

/** Palkki: suunniteltu vs. kapasiteetti. Tekstivastine on aina näkyvissä. */
function barHtml({ value, max, label }) {
  if (!Number.isFinite(max) || max <= 0) return '';
  const percent = Math.round((value / max) * 100);
  const width = Math.min(100, Math.max(0, percent));
  const over = value > max;
  return `
    <div class="dir-bar${over ? ' is-over' : ''}" role="img" aria-label="${escapeHtml(label)}">
      <div class="dir-bar-fill" style="width:${width}%"></div>
    </div>`;
}

function weekSummaryHtml(analysis) {
  const { planned, actual, capacity } = analysis;
  const parts = [];
  if (capacity.declared) {
    const label = `Suunniteltu ${hours(planned.knownMinutes)}, kapasiteetti ${hours(capacity.availableMinutes)}`;
    parts.push(barHtml({ value: planned.knownMinutes, max: capacity.availableMinutes, label }));
    const remaining = capacity.remainingMinutes;
    parts.push(`<p class="dir-line">${escapeHtml(label)} · `
      + (remaining >= 0 ? `jäljellä ${escapeHtml(hours(remaining))}` : `yli ${escapeHtml(hours(-remaining))}`)
      + '</p>');
  } else {
    parts.push(`<p class="dir-line">Suunniteltu ${escapeHtml(hours(planned.knownMinutes))}. `
      + 'Aseta kapasiteetti alla, niin näet mahtuuko se viikkoon.</p>');
  }
  // Avoimet ilman kestoa (arvioitavissa) ja valmiiksi merkityt ilman kestoa
  // (tieto) erikseen: arviointityönkulku kysyy vain avoimia.
  const openUnknown = openUnknownCountOf(analysis);
  const doneUnknown = Math.max(0, planned.unknownCount - openUnknown);
  if (openUnknown > 0) {
    parts.push(`<p class="dir-line dir-unknown">${countOf(openUnknown, 'asia', 'asiaa')} ilman kestoarviota — `
      + 'niitä ei ole laskettu mukaan (tuntematon ei ole nolla).</p>');
  }
  if (doneUnknown > 0) {
    parts.push(`<p class="dir-line dir-unknown">${countOf(doneUnknown, 'valmiiksi merkitty', 'valmiiksi merkittyä')} `
      + 'ilman arviota (ei lasketa kuormaan).</p>');
  }
  // Rästit eivät kuulu viikon suunnitelmaan (päivätty ennen viikkoa):
  // kerrotaan, ettei tyhjältä näyttävä viikko ole koko totuus (F9).
  const overdue = analysis.weekStart === currentWeekStart() ? currentLegacySummary().overdueOpen : 0;
  if (overdue > 0) {
    parts.push(`<p class="dir-line dir-unknown">${countOf(overdue, 'rästissä oleva avoin tehtävä ei ole',
      'rästissä olevaa avointa tehtävää ei ole')} tämän viikon suunnitelmassa.</p>`);
  }
  parts.push(actual.entryCount > 0
    ? `<p class="dir-line">Kirjattu toteuma ${escapeHtml(hours(actual.minutes))}, ${actual.daysWithEntries} päivänä.</p>`
    : '<p class="dir-line">Toteutunutta aikaa ei ole kirjattu tälle viikolle.</p>');
  if (capacity.energyLevel) {
    parts.push(`<p class="dir-line">Oma energia-arvio: ${capacity.energyLevel}/5.</p>`);
  }
  // Energia on eri asia kuin aika: oma rivinsä, oma rajansa, ei yhteispisteitä.
  const energy = analysis.energy;
  if (energy && (energy.heavyMinutes > 0 || Number.isInteger(energy.budgetMinutes))) {
    const label = Number.isInteger(energy.budgetMinutes)
      ? `Kuormittavaa ${hours(energy.heavyMinutes)}, oma raja ${hours(energy.budgetMinutes)}`
      : `Kuormittavaa ${hours(energy.heavyMinutes)} (rajaa ei asetettu)`;
    if (Number.isInteger(energy.budgetMinutes) && energy.budgetMinutes > 0) {
      parts.push(barHtml({ value: energy.heavyMinutes, max: energy.budgetMinutes, label }));
    }
    parts.push(`<p class="dir-line">${escapeHtml(label)}`
      + (energy.unratedCount > 0 ? ` · ${countOf(energy.unratedCount, 'asia', 'asiaa')} ilman kuormittavuusarviota` : '')
      + '.</p>');
  }
  const pending = pendingTimeEntryCount();
  if (pending > 0) {
    parts.push(`<p class="dir-line">${countOf(pending, 'kirjaus odottaa', 'kirjausta odottaa')} yhteyttä — ne lähetetään, kun yhteys palaa.</p>`);
  }
  parts.push(failedEntriesHtml(failedTimeEntries().length));
  return parts.join('');
}

/**
 * Kirjaukset, joita palvelin ei hyväksynyt toistuvasti (ei verkkovirhe).
 * Ne ovat laitteella tallessa; käyttäjä päättää: uudelleen tai hylkää
 * (hylkäys kysyy vahvistuksen). Sama malli kuin tehtäväjonon
 * epäonnistuneissa (src/app/offlineStatus.js).
 */
function failedEntriesHtml(count) {
  if (count === 0) return '';
  const text = count === 1
    ? '1 kirjaus ei mennyt palvelimelle, vaikka yhteys toimii. Se on tallessa tällä laitteella.'
    : `${count} kirjausta ei mennyt palvelimelle, vaikka yhteys toimii. Ne ovat tallessa tällä laitteella.`;
  return `<p class="dir-line" role="status">${escapeHtml(text)}</p>
    <div class="assist-actions">
      <button class="assist-btn" type="button" data-time-failed="retry">Yritä uudelleen</button>
      <button class="assist-btn danger" type="button" data-time-failed="discard">Hylkää…</button>
    </div>`;
}

/** Epäonnistuneiden kirjausten painikkeet (viikon yhteenvedossa). */
async function onFailedEntriesClick(event) {
  const button = event.target && typeof event.target.closest === 'function'
    ? event.target.closest('[data-time-failed]') : null;
  if (!button) return;
  button.disabled = true;
  try {
    if (button.dataset.timeFailed === 'retry') await retryFailedTimeEntries();
    else if (button.dataset.timeFailed === 'discard') await discardFailedTimeEntries();
  } finally {
    button.disabled = false;
    renderDirection();
  }
}

// ------------------------------------------------ arviointi ja kohdistus

function itemTitle(item) {
  if (item.kind === 'task') return findTask(item.id)?.title || 'Tehtävä';
  return findRoutine(item.routineId)?.title || 'Rutiini';
}

function itemDateLabel(item) {
  return item.date ? shortDate(item.date) : '';
}

/** Kuormittavuuden arviointi: kestolliset asiat, joilta arvio puuttuu. */
function energyRateHtml(analysis) {
  const seenRoutines = new Set();
  const items = analysis.items.filter(item => item.minutes !== null && item.energyDemand == null && !item.completed)
    .filter(item => {
      if (item.kind !== 'routine') return true;
      if (seenRoutines.has(item.routineId)) return false;
      seenRoutines.add(item.routineId);
      return true;
    });
  if (items.length === 0) return '<div class="assist-empty">Kaikilla kestollisilla asioilla on kuormittavuusarvio.</div>';
  const rows = items.slice(0, WORKFLOW_BATCH).map(item => {
    const key = item.kind === 'task' ? `task:${item.id}` : `routine:${item.routineId}`;
    const title = itemTitle(item);
    return `
      <div class="assist-row dir-estimate-row">
        <div class="assist-title">${escapeHtml(title)}</div>
        <div class="assist-meta">${escapeHtml(itemDateLabel(item))} · ${escapeHtml(hours(item.minutes))}</div>
        <div class="dir-presets" role="group" aria-label="Kuormittavuus: ${escapeHtml(title)}">
          ${[1, 2, 3, 4, 5].map(level => `<button class="assist-btn" type="button" data-energy-rate="${escapeHtml(key)}"
            data-level="${level}">${level} — ${escapeHtml(energyDemandLabel(level))}</button>`).join('')}
        </div>
      </div>`;
  }).join('');
  const rest = items.length - Math.min(items.length, WORKFLOW_BATCH);
  return '<p class="hint">Kuormittavuus on oma arviosi. Sitä ei päätellä otsikosta.</p>' + rows
    + (rest > 0 ? `<p class="hint">+ ${countOf(rest, 'asia', 'asiaa')} lisää.</p>` : '');
}

// ------------------------------------------------ arviojono (F4)
//
// Yksi kortti kerrallaan, järjestys src/domain/estimateQueue.js:stä
// (tänään -> muu viikko -> ensi viikko; rästit vain pyydettäessä).
// Painikkeet ovat pois käytöstä tallennuksen ajan ja heräävät seuraavalla
// kortilla vasta ESTIMATE_REARM_MS jälkeen: nopea toinen napautus ei
// arvioi asiaa, jota käyttäjä ei ehtinyt lukea. "Ohita" ei tallenna
// mitään, eikä ohitusta muisteta istunnon yli (ei nalkutusta). Jono ei
// koskaan vaadi arvioimaan kaikkea.

function queueCandidates({ weekStart, includeNextWeek, includeOverdue = false }) {
  const state = getState();
  return estimateCandidates({
    tasks: state.tasks, routines: state.routines, exceptions: state.routineExceptions,
    todayIso: clockNow().todayIso, weekStart, includeNextWeek, includeOverdue
  });
}

function startEstimateQueue({ scope, weekStart, includeNextWeek }) {
  estimateQueue = {
    scope, weekStart, includeNextWeek,
    items: queueCandidates({ weekStart, includeNextWeek }),
    done: new Map(), skipped: new Set(), saving: false, savingKey: null, armed: true,
    customOpen: false, customValue: '', approximate: true, overdueAdded: false, error: ''
  };
  return estimateQueue;
}

/** Aloituksen vaihe 6 (vain tämä viikko) ja työnkulku kiinnittävät kumpikin omansa. */
function ensureEstimateQueue(scope) {
  if (estimateQueue && estimateQueue.scope === scope) return estimateQueue;
  return scope === 'setup'
    ? startEstimateQueue({ scope, weekStart: currentWeekStart(), includeNextWeek: false })
    : startEstimateQueue({ scope, weekStart: shownWeek(), includeNextWeek: true });
}

function overdueForQueue(queue) {
  if (!queue || queue.overdueAdded) return [];
  const known = new Set(queue.items.map(item => item.key));
  return queueCandidates({ weekStart: queue.weekStart, includeNextWeek: false, includeOverdue: true })
    .filter(item => item.bucket === 'overdue' && !known.has(item.key));
}

/** Arvioitu muualla, merkitty valmiiksi tai poistettu -> ei enää jonossa. */
function stillNeedsEstimate(item) {
  if (item.kind === 'task') {
    const task = findTask(item.id);
    return Boolean(task) && !task.completed && !(durationOf(task) > 0);
  }
  const routine = findRoutine(item.routineId);
  return Boolean(routine) && !(Number.isFinite(routine.durationMinutes) && routine.durationMinutes > 0);
}

function activeQueueItem(queue = estimateQueue) {
  if (!queue) return null;
  // Tallennuksen ajan kortti pysyy paikallaan, vaikka tila päivittyi jo.
  if (queue.saving && queue.savingKey) return queue.items.find(item => item.key === queue.savingKey) || null;
  return queue.items.find(item => !queue.done.has(item.key) && !queue.skipped.has(item.key)
    && stillNeedsEstimate(item)) || null;
}

function queueItemTitle(item) {
  return item.kind === 'task' ? (findTask(item.id)?.title || 'Tehtävä') : (findRoutine(item.routineId)?.title || 'Rutiini');
}

function activeQueueCardHtml(item, host, queue) {
  const key = escapeHtml(item.key);
  const title = queueItemTitle(item);
  const blocked = queue.saving || !queue.armed;
  const off = blocked ? ' disabled data-armed="0"' : ' data-armed="1"';
  return `
    <div class="assist-row dir-estimate-row dir-queue-card" data-queue-card="${key}">
      <div class="assist-meta">${escapeHtml(ESTIMATE_BUCKET_LABELS[item.bucket] || '')} · ${escapeHtml(shortDate(item.date))}`
        + `${item.kind === 'routine' ? ' · <span class="routine-tag">RUTIINI</span>' : ''}</div>
      <h3 class="assist-title dir-queue-title" id="dirQueueTitle-${host}" tabindex="-1">${escapeHtml(title)}</h3>
      <div class="dir-presets" role="group" aria-labelledby="dirQueueTitle-${host}">
        ${ESTIMATE_PRESETS.map(minutes => `<button class="assist-btn" type="button" data-queue-estimate="${key}"`
          + ` data-minutes="${minutes}"${off}>${escapeHtml(formatMinutes(minutes))}</button>`).join('')}
        <button class="assist-btn" type="button" data-queue-custom="${key}" aria-expanded="${queue.customOpen ? 'true' : 'false'}"${off}>Muu…</button>
        <button class="assist-btn" type="button" data-queue-skip="${key}"${off}>Ohita</button>
      </div>
      ${queue.customOpen ? `<div class="form-row dir-queue-custom">
        <div>
          <label class="field-label" for="dirQueueCustom-${host}">Kesto minuutteina</label>
          <input type="number" min="1" max="1440" step="1" inputmode="numeric" id="dirQueueCustom-${host}"
            data-queue-input="${key}" value="${escapeHtml(queue.customValue || '')}">
        </div>
        <button class="assist-btn" type="button" data-queue-estimate="${key}" data-minutes="custom"${off}>Tallenna arvio</button>
      </div>` : ''}
      ${item.kind === 'task' ? `<label class="checkbox-row" for="dirQueueApprox-${host}">
        <input type="checkbox" id="dirQueueApprox-${host}" data-queue-approx="1"${queue.approximate ? ' checked' : ''}> Karkea arvio</label>` : ''}
      ${queue.error ? `<p class="field-error dir-setup-error" role="alert">${escapeHtml(queue.error)}</p>` : ''}
    </div>`;
}

/**
 * Arviojonon merkintä. `host` erottaa tunnisteet: 'main' (työnkulku) tai
 * 'setup' (aloituksen vaihe 6).
 */
function estimateQueueHtml(host) {
  const queue = ensureEstimateQueue(host === 'setup' ? 'setup' : 'workflow');
  const total = queue.items.length;
  const doneCount = queue.items.filter(item => queue.done.has(item.key)).length;
  const active = activeQueueItem(queue);
  const overdue = host === 'main' ? overdueForQueue(queue) : [];
  const parts = [];
  if (total > 0) parts.push(`<p class="dir-line dir-queue-progress" role="status">Arvioitu ${doneCount}/${total}</p>`);
  if (total === 0) {
    parts.push(`<div class="assist-empty">${host === 'setup'
      ? 'Tämän viikon avoimilla asioilla on kestoarvio.'
      : 'Tämän ja ensi viikon avoimilla asioilla on kestoarvio.'}</div>`);
  } else if (!active) {
    parts.push('<div class="assist-empty">Jonon asiat on käyty läpi.'
      + (queue.skipped.size > 0 ? ` Ohitit ${countOf(queue.skipped.size, 'asian', 'asiaa')}; voit arvioida ne myöhemmin.` : '')
      + '</div>');
  } else {
    parts.push(activeQueueCardHtml(active, host, queue));
    const upcoming = queue.items.filter(item => item.key !== active.key && !queue.done.has(item.key)
      && !queue.skipped.has(item.key) && stillNeedsEstimate(item)).slice(0, 3);
    if (upcoming.length > 0) {
      parts.push(`<p class="hint">Seuraavaksi: ${upcoming.map(item => escapeHtml(queueItemTitle(item))).join(' · ')}</p>`);
    }
  }
  const done = queue.items.filter(item => queue.done.has(item.key)).slice(-5).reverse();
  if (done.length > 0) {
    parts.push(`<ul class="dir-queue-done" aria-label="Arvioidut">${done.map(item => {
      const title = queueItemTitle(item);
      return `<li><span>${escapeHtml(title)} · ${escapeHtml(formatMinutes(queue.done.get(item.key).minutes))}</span>
        <button class="assist-btn" type="button" data-queue-undo="${escapeHtml(item.key)}"
          aria-label="Kumoa arvio: ${escapeHtml(title)}"${queue.saving ? ' disabled' : ''}>Kumoa</button></li>`;
    }).join('')}</ul>`);
  }
  const actions = [];
  if (overdue.length > 0) {
    actions.push(`<button class="assist-btn" type="button" data-queue-overdue="1">Näytä myös rästit (${overdue.length})</button>`);
  }
  if (host === 'main') actions.push('<button class="assist-btn primary" type="button" data-queue-finish="1">Valmis tältä erää</button>');
  if (actions.length > 0) parts.push(`<div class="assist-actions">${actions.join('')}</div>`);
  return parts.join('');
}

/** Arvio ennen jonoa: "Kumoa" palauttaa sen. */
function previousEstimateOf(item) {
  if (item.kind === 'task') {
    const task = findTask(item.id);
    const settings = itemSettingsFor('task', item.id);
    return { durationMinutes: task ? task.durationMinutes ?? null : null,
      approximate: Boolean(settings && settings.estimateApproximate) };
  }
  const routine = findRoutine(item.routineId);
  return { durationMinutes: routine ? routine.durationMinutes : null, approximate: false };
}

function rearmQueue(queue) {
  queue.armed = false;
  setTimeout(() => {
    if (estimateQueue !== queue) return;
    queue.armed = true;
    if (typeof document !== 'undefined') renderDirection();
  }, ESTIMATE_REARM_MS);
}

function focusQueueTitle() {
  const host = estimateQueue && estimateQueue.scope === 'setup' ? 'setup' : 'main';
  focus(`dirQueueTitle-${host}`);
}

async function saveQueueEstimate(key, minutes) {
  const queue = estimateQueue;
  if (!queue || queue.saving || !queue.armed) return;
  const active = activeQueueItem(queue);
  // Vanhentunut painike (edellinen kortti) ei arvioi seuraavaa asiaa.
  if (!active || active.key !== key) return;
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 1440) {
    queue.error = 'Anna kesto minuutteina, 1–1440.';
    renderDirection();
    return;
  }
  const previous = previousEstimateOf(active);
  queue.saving = true;
  queue.savingKey = key;
  queue.error = '';
  renderDirection();
  let ok = false;
  try {
    ok = await saveEstimate(key, minutes, active.kind === 'task' ? queue.approximate : false);
  } finally {
    queue.saving = false;
    queue.savingKey = null;
  }
  if (estimateQueue !== queue) return;
  if (ok) {
    queue.done.set(key, { minutes, previous });
    queue.customOpen = false;
    queue.customValue = '';
    rearmQueue(queue);
  }
  renderDirection();
  if (ok) focusQueueTitle();
}

async function undoQueueEstimate(key) {
  const queue = estimateQueue;
  const record = queue && queue.done.get(key);
  if (!record || queue.saving) return;
  const { kind, id } = splitKey(key);
  queue.saving = true;
  renderDirection();
  let ok = false;
  try {
    if (kind === 'task') {
      const result = await editTask(id, { durationMinutes: record.previous.durationMinutes ?? null });
      ok = Boolean(result && result.ok);
      if (ok) await saveItemSettings('task', id, { estimateApproximate: Boolean(record.previous.approximate) });
    } else {
      const result = await editRoutine(id, { durationMinutes: record.previous.durationMinutes });
      ok = Boolean(result && result.ok);
    }
  } finally {
    queue.saving = false;
  }
  if (estimateQueue !== queue) return;
  if (ok) queue.done.delete(key);
  renderDirection();
}

function closeEstimateWorkflow() {
  estimateOpen = false;
  estimateQueue = null;
  renderDirection();
  focus('dirOpenEstimate');
}

/**
 * Arviojonon tapahtumat (työnkulku ja aloitus). Palauttaa true, jos
 * tapahtuma kuului jonolle.
 */
function handleQueueEvent(type, event) {
  const target = event && event.target;
  if (!target || typeof target.closest !== 'function') return false;
  const queue = estimateQueue;
  if (type === 'click') {
    const button = target.closest('[data-queue-estimate], [data-queue-skip], [data-queue-custom], '
      + '[data-queue-undo], [data-queue-finish], [data-queue-overdue]');
    if (!button) return false;
    if (!queue || button.disabled) return true;
    const data = button.dataset;
    if (data.queueFinish) {
      if (queue.scope === 'workflow') closeEstimateWorkflow();
    } else if (data.queueOverdue) {
      queue.items.push(...overdueForQueue(queue));
      queue.overdueAdded = true;
      renderDirection();
    } else if (data.queueUndo) {
      undoQueueEstimate(data.queueUndo);
    } else if (data.queueSkip) {
      const active = activeQueueItem(queue);
      if (queue.saving || !queue.armed || !active || active.key !== data.queueSkip) return true;
      queue.skipped.add(active.key);
      queue.customOpen = false;
      queue.customValue = '';
      queue.error = '';
      rearmQueue(queue);
      renderDirection();
      focusQueueTitle();
    } else if (data.queueCustom) {
      queue.customOpen = !queue.customOpen;
      renderDirection();
      if (queue.customOpen) focus(`dirQueueCustom-${queue.scope === 'setup' ? 'setup' : 'main'}`);
    } else if (data.queueEstimate) {
      const minutes = data.minutes === 'custom'
        ? Math.round(Number(String(queue.customValue || '').replace(',', '.')))
        : Number(data.minutes);
      saveQueueEstimate(data.queueEstimate, minutes);
    }
    return true;
  }
  if (type === 'change' && target.closest('[data-queue-approx]')) {
    if (queue) queue.approximate = Boolean(target.checked);
    return true;
  }
  if (type === 'input' && target.closest('[data-queue-input]')) {
    if (queue) queue.customValue = target.value;
    return true;
  }
  if (type === 'keydown' && event.key === 'Enter' && target.closest('[data-queue-input]')) {
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (queue) {
      queue.customValue = target.value;
      saveQueueEstimate(target.dataset.queueInput, Math.round(Number(String(target.value).replace(',', '.'))));
    }
    return true;
  }
  return false;
}

/** Tekeminen-näkymän laskuri: sama oletusjono kuin Suunnan arvioinnissa. */
export function estimateQueueCount() {
  return queueCandidates({ weekStart: currentWeekStart(), includeNextWeek: true }).length;
}

/** Avaa arviojono toisesta näkymästä (Tekeminen, Tänään): tämän päivän viikko. */
export function openEstimateQueue() {
  switchTab('screen-direction');
  openWorkflow('estimate', 'duration', { weekStart: currentWeekStart() });
}

function goalOptionsForAssign() {
  const state = getState();
  const areas = new Map(state.lifeAreas.map(area => [area.id, area]));
  return state.goals.filter(goal => OPEN_GOAL_STATUSES.has(goal.status) && goal.lifeAreaId && areas.has(goal.lifeAreaId))
    .sort((a, b) => a.title.localeCompare(b.title, 'fi'))
    .map(goal => `<option value="${escapeHtml(goal.id)}">${escapeHtml(goal.title)} (${escapeHtml(areas.get(goal.lifeAreaId).name)})</option>`)
    .join('');
}

function mappedCategoryOptions() {
  return getState().lifeAreas.filter(area => area.categoryKey && area.active)
    .sort(compareLifeAreas)
    .map(area => {
      const label = CATEGORIES.find(c => c.key === area.categoryKey)?.label || area.categoryKey;
      return `<option value="${escapeHtml(area.categoryKey)}">${escapeHtml(label)} → ${escapeHtml(area.name)}</option>`;
    }).join('');
}

/** Luokittelemattomat yksi kerrallaan: liitä, kytke kategoria tai jätä tarkoituksella. */
function unassignedHtml(analysis) {
  // Ilman alueita ei ole mihin liittää (F3). Pysyvää "jätä ilman aluetta"
  // -valintaa ei tarjota ennen kuin käyttäjä on edes voinut valita alueen.
  if (!getState().lifeAreas.some(area => area.active)) {
    return '<div class="assist-empty">Luo ensin elämänalue, niin voit liittää tekemistä siihen.</div>'
      + `<div class="assist-actions"><button class="assist-btn primary" type="button" data-quality-action="${QUALITY_ACTION.ADD_AREAS}">`
      + `${escapeHtml(QUALITY_ACTION_LABELS[QUALITY_ACTION.ADD_AREAS])}</button></div>`;
  }
  const seenRoutines = new Set();
  // Valmiiksi merkitty tehtävä ei ole enää kohdistettavaa tekemistä (F3).
  const items = analysis.items.filter(item => !item.areaId && !item.optedOut && !item.completed).filter(item => {
    const key = item.kind === 'task' ? `task:${item.id}` : `routine:${item.routineId}`;
    if (skippedUnassigned.has(key)) return false;
    if (item.kind !== 'routine') return true;
    if (seenRoutines.has(item.routineId)) return false;
    seenRoutines.add(item.routineId);
    return true;
  });
  if (items.length === 0) {
    return '<div class="assist-empty">Ei kohdistamattomia asioita tällä viikolla.</div>';
  }
  const goals = goalOptionsForAssign();
  const categories = mappedCategoryOptions();
  const intro = `<p class="dir-line">${escapeHtml(items.length === 1
    ? 'Sinulla on 1 asia, jota ei ole liitetty elämänalueeseen.'
    : `Sinulla on ${items.length} asiaa, joita ei ole liitetty elämänalueeseen.`)}</p>`;
  const rows = items.slice(0, WORKFLOW_BATCH).map(item => {
    const key = item.kind === 'task' ? `task:${item.id}` : `routine:${item.routineId}`;
    const title = itemTitle(item);
    const offerCategory = Boolean(categories) && item.kind === 'task';
    // Pysyvä opt-out vain, kun liittäminen olisi ollut mahdollista: muuten
    // käyttäjä päättäisi "ei koskaan" ennen kuin vaihtoehtoja on (F3).
    const canAssign = Boolean(goals) || offerCategory;
    return `
      <div class="assist-row dir-assign-row">
        <div class="assist-title">${escapeHtml(title)}${item.kind === 'routine' ? ' <span class="routine-tag">RUTIINI</span>' : ''}</div>
        <div class="assist-meta">${escapeHtml(itemDateLabel(item))}${item.minutes ? ` · ${escapeHtml(hours(item.minutes))}` : ''}</div>
        ${goals ? `<label class="field-label" for="dirAssignGoal-${escapeHtml(key)}">Liitä tavoitteeseen</label>
          <select id="dirAssignGoal-${escapeHtml(key)}" data-assign-goal="${escapeHtml(key)}">
            <option value="">Valitse tavoite</option>${goals}</select>` : ''}
        ${offerCategory ? `<label class="field-label" for="dirAssignCat-${escapeHtml(key)}">Tai kategoria, joka kuuluu alueeseen</label>
          <select id="dirAssignCat-${escapeHtml(key)}" data-assign-category="${escapeHtml(key)}">
            <option value="">Valitse kategoria</option>${categories}</select>` : ''}
        ${canAssign ? '' : '<p class="hint">Liitä ensin jokin tavoite alueeseen tai kytke alueeseen kategoria, niin voit liittää tämän.</p>'}
        <div class="assist-actions">
          ${canAssign ? `<button class="assist-btn" type="button" data-assign-optout="${escapeHtml(key)}">Jätä tarkoituksella ilman aluetta</button>` : ''}
          <button class="assist-btn" type="button" data-assign-skip="${escapeHtml(key)}">Ohita nyt</button>
        </div>
      </div>`;
  }).join('');
  return intro + rows;
}

function suggestionsHtml(areas) {
  if (areas.length > 0) return '';
  const chips = SUGGESTED_AREAS.map(suggestion =>
    `<button class="assist-btn" type="button" data-area-suggest="${escapeHtml(suggestion.name)}"`
    + ` data-category="${escapeHtml(suggestion.categoryKey || '')}">+ ${escapeHtml(suggestion.name)}</button>`).join('');
  // Vanha data kuitataan (F9): luvut, ei ehdotuksia eikä automaattista liittämistä.
  const legacy = legacyNoticeText(currentLegacySummary());
  return `<p class="hint">Mitkä elämäsi alueet ovat sinulle tärkeitä? Valitse valmis nimi tai kirjoita oma. `
    + 'Mitään ei luoda ennen kuin tallennat.</p>'
    + (legacy ? `<p class="dir-line dir-legacy">${escapeHtml(legacy)}</p>` : '')
    + `<div class="assist-actions dir-chips">${chips}</div>`;
}

function areaRowHtml(area, row) {
  const target = Number.isInteger(area.targetMinutesPerWeek)
    ? `tavoite ${escapeHtml(hours(area.targetMinutesPerWeek))}/vko` : 'ei aikatavoitetta';
  const desired = row && row.desiredPercent !== null ? ` (${row.desiredPercent} % tavoitteista)` : '';
  const plannedLine = row
    ? `Suunniteltu ${escapeHtml(hours(row.plannedMinutes))}`
      + (row.plannedUnknown > 0 ? ` + ${row.plannedUnknown} arvioimatonta` : '')
      + ` · toteuma ${escapeHtml(hours(row.actualMinutes))}`
    : '';
  const bar = row && Number.isInteger(area.targetMinutesPerWeek) && area.targetMinutesPerWeek > 0
    ? barHtml({
      value: row.actualMinutes > 0 ? row.actualMinutes : row.plannedMinutes,
      max: area.targetMinutesPerWeek,
      label: `${area.name}: ${row.actualMinutes > 0 ? 'toteuma' : 'suunniteltu'} `
        + `${hours(row.actualMinutes > 0 ? row.actualMinutes : row.plannedMinutes)} / tavoite ${hours(area.targetMinutesPerWeek)}`
    })
    : '';
  const category = area.categoryKey
    ? ` · kategoria ${escapeHtml(CATEGORIES.find(c => c.key === area.categoryKey)?.label || area.categoryKey)}` : '';
  return `
    <div class="assist-row${area.active ? '' : ' is-closed'}">
      <div class="assist-title">${escapeHtml(area.name)}${area.active ? '' : ' (pois käytöstä)'}</div>
      <div class="assist-meta">
        <span class="assist-tag">${escapeHtml(importanceLabel(area.importance))}</span>
        ${target}${escapeHtml(desired)}${category}
      </div>
      ${plannedLine ? `<div class="assist-reason">${plannedLine}</div>` : ''}
      ${bar}
      <div class="assist-actions">
        <button class="assist-btn" type="button" data-area-edit="${escapeHtml(area.id)}">Muokkaa</button>
      </div>
    </div>`;
}

function areasHtml(areas, analysis) {
  const rows = new Map(analysis.areas.map(row => [row.id, row]));
  return [...areas].sort(compareLifeAreas).map(area => areaRowHtml(area, rows.get(area.id))).join('');
}

function areaOptions(areas, selected, emptyLabel) {
  return `<option value="">${escapeHtml(emptyLabel)}</option>`
    + [...areas].sort(compareLifeAreas).map(area =>
      `<option value="${escapeHtml(area.id)}"${area.id === selected ? ' selected' : ''}>`
      + `${escapeHtml(area.name)}${area.active ? '' : ' (pois käytöstä)'}</option>`).join('');
}

function goalsHtml(areas, goals) {
  const open = goals.filter(goal => OPEN_GOAL_STATUSES.has(goal.status));
  if (open.length === 0) {
    return '<div class="assist-empty">Ei avoimia tavoitteita. Tavoitteet luodaan Tavoitteet-välilehdellä.</div>';
  }
  const areaIds = new Set(areas.map(area => area.id));
  const unassigned = open.filter(goal => !goal.lifeAreaId || !areaIds.has(goal.lifeAreaId));
  const groups = [];
  if (unassigned.length > 0) {
    groups.push({ title: 'Ei elämänaluetta', hint: 'Valitse alue, niin tavoitteen työ näkyy oikeassa paikassa.', goals: unassigned });
  }
  for (const area of [...areas].sort(compareLifeAreas)) {
    const inArea = open.filter(goal => goal.lifeAreaId === area.id);
    if (inArea.length > 0) groups.push({ title: area.name, hint: '', goals: inArea });
  }
  return groups.map(group => `
    <div class="dir-goal-group">
      <h3 class="dir-subtitle">${escapeHtml(group.title)}</h3>
      ${group.hint ? `<p class="hint">${escapeHtml(group.hint)}</p>` : ''}
      ${group.goals.map(goal => `
        <div class="dir-goal-row">
          <label class="field-label" for="dirGoalArea-${escapeHtml(goal.id)}">${escapeHtml(goal.title)}</label>
          <select id="dirGoalArea-${escapeHtml(goal.id)}" data-goal-area="${escapeHtml(goal.id)}">
            ${areaOptions(areas, goal.lifeAreaId, 'Ei elämänaluetta')}
          </select>
        </div>`).join('')}
    </div>`).join('');
}

/** Kirjauksen kohde sanoin: alue, tehtävä, rutiini, projekti tai tavoite. */
function entryTargetLabel(entry, byId) {
  if (entry.lifeAreaId && byId.has(entry.lifeAreaId)) return byId.get(entry.lifeAreaId).name;
  if (entry.taskId && findTask(entry.taskId)) return findTask(entry.taskId).title;
  if (entry.routineId && findRoutine(entry.routineId)) return findRoutine(entry.routineId).title;
  if (entry.projectId && findProject(entry.projectId)) return findProject(entry.projectId).name;
  if (entry.goalId && findGoal(entry.goalId)) return findGoal(entry.goalId).title;
  return 'Ei aluetta';
}

function timeListHtml(entries, areas) {
  const state = getState();
  const byId = new Map(areas.map(area => [area.id, area]));
  // Laitteen lähtökorissa odottavat merkitään: ne eivät ole vielä kannassa.
  const pending = pendingTimeEntryOperations();
  const failed = failedTimeEntryOperations();
  const tag = entry => (failed.has(entry.operationId)
    ? ' · <span class="assist-tag">Lähetys epäonnistui</span>'
    : pending.has(entry.operationId) ? ' · <span class="assist-tag">Odottaa lähetystä</span>' : '');
  // Alue päätellään samalla säännöllä kuin analyysissa: kirjaus, jonka
  // tehtävä kuuluu alueeseen kategorian kautta, EI ole alueeton (F6).
  const index = buildAttributionIndex({
    areas: state.lifeAreas, goals: state.goals, projects: state.projects, routines: state.routines
  });
  const tasksById = new Map(state.tasks.map(task => [task.id, task]));
  const activeAreas = areas.filter(area => area.active);
  const unassigned = entry => !areaForTimeEntry(entry, index, tasksById).areaId;
  const shown = timeListUnassignedOnly ? entries.filter(unassigned) : entries;
  const filterNote = timeListUnassignedOnly
    ? `<div class="dir-quality-row"><p class="dir-line">Näytetään vain kirjaukset ilman aluetta (${shown.length}).</p>
        <button class="assist-btn" type="button" data-time-show-all="1">Näytä kaikki kirjaukset</button></div>`
    : '';
  if (shown.length === 0) {
    return timeListUnassignedOnly ? filterNote + '<div class="assist-empty">Kaikki tämän viikon kirjaukset kuuluvat alueeseen.</div>' : '';
  }
  return filterNote + [...shown].sort((a, b) => b.entryDate.localeCompare(a.entryDate)).map(entry => {
    // Odottava tai epäonnistunut kirjaus ei ole kannassa: siihen ei voi vielä liittää aluetta.
    const waiting = pending.has(entry.operationId) || failed.has(entry.operationId);
    const label = `${shortDate(entry.entryDate)} ${hours(entry.minutes)}`;
    // Liitä alueeseen: vain alueettomille, ja vasta kun kirjaus on kannassa.
    const assign = unassigned(entry) && activeAreas.length > 0 && !waiting
      ? `<div class="dir-time-assign">
          <label class="field-label" for="dirTimeAssign-${escapeHtml(entry.id)}">Liitä alueeseen (${escapeHtml(label)})</label>
          <select id="dirTimeAssign-${escapeHtml(entry.id)}" data-time-area="${escapeHtml(entry.id)}">
            ${areaOptions(activeAreas, null, 'Valitse alue')}</select>
        </div>`
      : '';
    return `
    <div class="assist-row">
      <div class="assist-meta">
        ${escapeHtml(shortDate(entry.entryDate))} · ${escapeHtml(hours(entry.minutes))}
        · ${escapeHtml(entryTargetLabel(entry, byId))}
        · ${entry.source === 'timer' ? 'Ajastin' : 'Käsin'}${tag(entry)}
      </div>
      ${entry.note ? `<div class="assist-reason">${escapeHtml(entry.note)}</div>` : ''}
      ${assign}
      <div class="assist-actions">
        <button class="assist-btn danger" type="button" data-time-delete="${escapeHtml(entry.id)}"
          aria-label="Poista kirjaus ${escapeHtml(label)}">Poista</button>
      </div>
    </div>`;
  }).join('');
}

function signalsOfKind(analysis, kind, areas) {
  return analysis.signals.filter(signal => signal.kind === kind)
    .map(signal => explainSignal(signal, areas).text);
}

/** Montako viikon päivää on tähän mennessä alkanut (0–7). */
function daysSoFar(analysis) {
  const progress = analysis.progress || {};
  if (progress.state === 'after') return 7;
  if (progress.state !== 'during') return 0;
  return Math.min(7, Math.floor(progress.elapsedDays || 0) + 1);
}

/**
 * Katsauksen ensimmäinen rivi: mikä viikosta tiedetään, mikä ei, ja mitä
 * ei kirjattu. Kirjaamaton päivä ja arvioimaton asia ovat tuntemattomia,
 * eivät nollaa — tämä sanotaan ennen yhtäkään johtopäätöstä.
 */
function knownUnknownHtml(analysis, areas = []) {
  const { planned, actual } = analysis;
  const split = timeSourceSplit(actual.bySource || {})
    .map(part => `${part.label} ${hours(part.minutes)}`).join(', ');
  const known = [
    planned.itemCount > 0
      ? `arvioitua työtä ${hours(planned.knownMinutes)} (kestoarvio ${planned.estimatedCount}/${planned.itemCount} asialla)`
      : 'ei suunniteltuja asioita',
    actual.entryCount > 0
      ? `kirjattu ${hours(actual.minutes)} ${actual.daysWithEntries} päivänä${split ? ` (${split})` : ''}`
      : null
  ].filter(Boolean).join('; ');
  // Tärkeät alueet, joiden suunnitelmasta puuttuu kesto (`neglect.plan_unknown`):
  // ne ovat tuntemattomia, eivät "huomiotta jääneitä".
  const areaOrder = new Map([...areas].sort((a, b) => b.importance - a.importance || compareLifeAreas(a, b))
    .map((area, index) => [area.id, index]));
  const planUnknownNames = analysis.signals
    .filter(signal => signal.kind === SIGNAL.NEGLECT && signal.rule === NEGLECT_PLAN_UNKNOWN && areaOrder.has(signal.areaId))
    .sort((a, b) => areaOrder.get(a.areaId) - areaOrder.get(b.areaId))
    .map(signal => areas.find(area => area.id === signal.areaId).name);
  const planUnknown = planUnknownNames.length > 0
    ? ` ${planUnknownNames.length} alueen suunnitelmasta puuttuu kesto (${planUnknownNames.join(', ')}).` : '';
  const unknown = (planned.unknownCount > 0
    ? `${countOf(planned.unknownCount, 'asia', 'asiaa')} ilman kestoarviota, joten kokonaiskuormaa ei tiedetä.`
    : planned.itemCount > 0 ? 'Kaikilla suunnitelluilla asioilla on kestoarvio.' : '–') + planUnknown;
  const so = daysSoFar(analysis);
  const loggedDays = (actual.entryDates || []).length || actual.daysWithEntries || 0;
  const notLogged = Math.max(0, so - loggedDays);
  const unlogged = actual.entryCount === 0
    ? (so > 0 ? 'Tälle viikolle ei ole kirjattu aikaa — toteuma on tuntematon, ei nolla.' : '–')
    : notLogged === 1
      ? '1 päivä ilman kirjauksia — tuntematon, ei nolla.'
      : notLogged > 1
        ? `${notLogged} päivää ilman kirjauksia — tuntemattomia, eivät nollaa.`
        : 'Jokaiselle päivälle on kirjauksia.';
  return `
    <div class="dir-review-section dir-known">
      <dl class="dir-review">
        <dt>Tiedossa</dt><dd>${escapeHtml(known.charAt(0).toUpperCase() + known.slice(1))}.</dd>
        <dt>Ei tiedossa</dt><dd>${escapeHtml(unknown)}</dd>
        <dt>Ei kirjattu</dt><dd>${escapeHtml(unlogged)}</dd>
      </dl>
    </div>`;
}

/**
 * Katsaus v2: SUUNTA · SUUNNITELMA · TOTEUMA · POIKKEAMAT. "Miksi?" on
 * lomakkeen pohdintakysymyksissä ja "Ensi viikko" ehdotuksissa.
 * Ensimmäisen version seitsemän kysymystä säilyvät kunkin osion alla.
 * Versio 3: alussa "Tiedossa / Ei tiedossa / Ei kirjattu", ja osittain
 * kirjatun viikon toteuma sanotaan kirjattuna, ei elettynä aikana.
 */
function reviewHtml(analysis, areas) {
  const active = [...areas].filter(area => area.active)
    .sort((a, b) => b.importance - a.importance || compareLifeAreas(a, b));
  const tracking = analysis.tracking || null;
  const trackingEstablished = !tracking || tracking.level === TRACKING.ESTABLISHED;
  const loggingStarted = tracking && tracking.firstEntryDate && tracking.firstEntryDate >= analysis.weekStart
    ? ` (kirjaukset alkoivat ${shortDate(tracking.firstEntryDate)})` : '';
  const unknownCount = analysis.planned.unknownCount;
  const answers = [
    active.length === 0 ? 'Elämänalueita ei ole määritelty.'
      : active.map(area => `${area.name}: ${importanceLabel(area.importance).toLowerCase()}`
        + (Number.isInteger(area.targetMinutesPerWeek) ? `, tavoite ${hours(area.targetMinutesPerWeek)}` : '')).join(' · '),
    `Arvioitua työtä ${hours(analysis.planned.knownMinutes)}`
      + (unknownCount > 0 ? `, lisäksi ${unknownCount} ilman arviota` : '')
      + (analysis.capacity.declared ? `; kapasiteetti ${hours(analysis.capacity.availableMinutes)}.` : '; kapasiteettia ei asetettu.'),
    analysis.actual.entryCount === 0
      ? 'Aikaa ei kirjattu, joten toteumaa ei voi arvioida.'
      : trackingEstablished
        ? `Kirjattu ${hours(analysis.actual.minutes)} (${analysis.actual.daysWithEntries} päivää).`
        // Osittain kirjattu viikko: kirjattu aika ei ole eletty aika.
        : `Kirjattu ${hours(analysis.actual.minutes)} ${analysis.actual.daysWithEntries} päivänä${loggingStarted}. `
          + 'Päivät ilman kirjauksia ovat tuntemattomia, eivät nollaa.',
    signalsOfKind(analysis, SIGNAL.OVERLOAD, areas).join(' ')
      || (!analysis.capacity.declared ? 'Ei arvioitavissa ilman kapasiteettia.'
        : unknownCount > 0
          ? `Arvioitu työ (${hours(analysis.planned.knownMinutes)}) mahtui kapasiteettiin `
            + `(${hours(analysis.capacity.availableMinutes)}); ${countOf(unknownCount, 'asia', 'asiaa')} ilman arviota, `
            + 'joten kokonaiskuormaa ei tiedetä.'
          : 'Suunnitelma mahtui kapasiteettiin.'),
    // Vain todetut vajeet: alue, jonka suunnitelmasta puuttuu kesto, on
    // "Ei tiedossa" -rivillä, ei huomiotta jääneenä.
    analysis.signals.filter(isNeglectShortfall).map(signal => explainSignal(signal, areas).text).join(' ')
      || (trackingEstablished ? 'Yksikään tärkeä alue ei jäänyt selvästi vajaaksi.'
        : 'Yksikään tärkeä alue ei jäänyt selvästi vajaaksi sen perusteella, mitä on tiedossa.'),
    [...signalsOfKind(analysis, SIGNAL.MISALIGNMENT, areas), ...signalsOfKind(analysis, SIGNAL.TARGET_TENSION, areas)].join(' ')
      || 'Ei merkittäviä poikkeamia toivomastasi jakaumasta sen perusteella, mitä on tiedossa.'
  ];
  const energyLine = analysis.energy && (analysis.energy.heavyMinutes > 0 || Number.isInteger(analysis.energy.budgetMinutes))
    ? `Kuormittavaa ${hours(analysis.energy.heavyMinutes)}`
      + (Number.isInteger(analysis.energy.budgetMinutes) ? `, oma raja ${hours(analysis.energy.budgetMinutes)}.` : '.')
    : null;
  const energySignals = signalsOfKind(analysis, SIGNAL.ENERGY_OVERLOAD, areas).join(' ');
  const sections = [
    { title: 'Suunta', lead: 'Mitä sanoin tärkeäksi?', rows: [[REVIEW_QUESTIONS[0], answers[0]]] },
    { title: 'Suunnitelma', lead: 'Mitä aioin?', rows: [[REVIEW_QUESTIONS[1], answers[1]]] },
    { title: 'Toteuma', lead: 'Mitä oikeasti tapahtui?', rows: [[REVIEW_QUESTIONS[2], answers[2]]] },
    {
      title: 'Poikkeamat', lead: 'Missä suunnitelma ja todellisuus erosivat?',
      rows: [
        [REVIEW_QUESTIONS[3], answers[3]],
        ['Kuormittiko viikko enemmän kuin jaksoin?', energySignals || energyLine || 'Kuormittavuutta ei ole arvioitu.'],
        [REVIEW_QUESTIONS[4], answers[4]],
        [REVIEW_QUESTIONS[5], answers[5]]
      ]
    }
  ];
  return knownUnknownHtml(analysis, areas) + sections.map(section => `
    <div class="dir-review-section">
      <h3 class="dir-subtitle">${escapeHtml(section.title)} <span class="dir-review-lead">— ${escapeHtml(section.lead)}</span></h3>
      <dl class="dir-review">${section.rows.map(([question, answer]) =>
        `<dt>${escapeHtml(question)}</dt><dd>${escapeHtml(answer)}</dd>`).join('')}</dl>
    </div>`).join('');
}

/** Edellinen viikko vs. tämä: vain havaittavat erot, ei trendejä yhdestä viikosta. */
function compareHtml(comparison) {
  if (!comparison || !comparison.available) {
    return `<p class="hint">${escapeHtml((comparison && comparison.notes[0]) || 'Edellisestä viikosta ei ole vertailtavaa.')}</p>`;
  }
  const lines = comparison.lines.map(line => `<li>${escapeHtml(line.text)}</li>`).join('');
  const areas = comparison.areas.filter(area => Number.isFinite(area.delta) && area.delta !== 0)
    .map(area => `<li>${escapeHtml(area.name)}: ${escapeHtml(hours(area.before))} → ${escapeHtml(hours(area.after))}</li>`).join('');
  return `<details class="dir-history" open>
    <summary>Verrattuna edelliseen viikkoon</summary>
    ${lines ? `<ul>${lines}</ul>` : ''}
    ${areas ? `<p class="dir-line">Alueittain (${comparison.basis === 'actual' ? 'kirjattu' : 'suunniteltu'}):</p><ul>${areas}</ul>` : ''}
    ${comparison.notes.map(note => `<p class="hint">${escapeHtml(note)}</p>`).join('')}
    <p class="hint">Yksi viikko ei ole suunta: tämä kertoo vain erot.</p>
  </details>`;
}

function previewHtml(preview) {
  if (!preview) return '';
  const row = (label, before, after) => `<tr><th scope="row">${escapeHtml(label)}</th>`
    + `<td>${escapeHtml(before)}</td><td>${escapeHtml(after)}</td></tr>`;
  const areaNames = new Map(preview.after.areas.map(area => [area.id, area]));
  const areaRows = preview.before.areas.map(area => {
    const next = areaNames.get(area.id) || area;
    return row(area.name,
      `${hours(area.plannedMinutes)} / tavoite ${hours(area.targetMinutes)}`,
      `${hours(next.plannedMinutes)} / tavoite ${hours(next.targetMinutes)}`);
  }).join('');
  return `
    <div class="dir-preview">
      <table class="dir-preview-table">
        <caption>Ensi viikko ennen ja jälkeen valittujen muutosten</caption>
        <thead><tr><th scope="col">Mitä</th><th scope="col">Nyt</th><th scope="col">Muutosten jälkeen</th></tr></thead>
        <tbody>
          ${row('Suunniteltu', hours(preview.before.plannedMinutes), hours(preview.after.plannedMinutes))}
          ${row('Kapasiteetti', hours(preview.before.capacityMinutes), hours(preview.after.capacityMinutes))}
          ${row('Havaintoja', String(preview.before.signals), String(preview.after.signals))}
          ${areaRows}
        </tbody>
      </table>
      <ul>${preview.effects.map(effect => `<li>${escapeHtml(effect.text)}</li>`).join('')}</ul>
      <p class="hint">Mitään ei ole vielä muutettu.</p>
    </div>`;
}

function trendsHtml(trends) {
  if (!trendsRequested) {
    return '<button class="assist-btn" type="button" id="dirShowTrends" data-show-trends="1">Näytä viikkojen kehitys</button>';
  }
  if (!trends) return '';
  const rows = trends.rows.map(row => `<tr>
      <th scope="row">${escapeHtml(weekLabel(row.weekStart))}${row.origin === 'snapshot' ? ' *' : ''}</th>
      <td>${escapeHtml(hours(row.capacityMinutes))}</td>
      <td>${escapeHtml(hours(row.plannedMinutes))}</td>
      <td>${escapeHtml(row.actualMinutes === null ? '–' : hours(row.actualMinutes))}</td>
      <td>${row.timeOverloaded ? 'Kyllä' : 'Ei'}</td>
    </tr>`).join('');
  return `
    <ul class="dir-trend-statements">${trends.statements.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
    ${rows ? `<table class="dir-preview-table">
      <caption>Viikot (* = tallennettu katsaus, jonka luvut eivät muutu)</caption>
      <thead><tr><th scope="col">Viikko</th><th scope="col">Kapasiteetti</th><th scope="col">Suunniteltu</th>
        <th scope="col">Kirjattu</th><th scope="col">Ylitys</th></tr></thead>
      <tbody>${rows}</tbody></table>` : ''}`;
}

/**
 * Ehdotuksen kentän virhe ja käyttäjän kirjoittama arvo (ERR-12): virhe
 * näkyy kentän vieressä, eikä uudelleenpiirto korvaa kirjoitettua arvoa
 * ehdotuksen omalla arvolla. Tunniste -> teksti.
 */
const proposalErrors = new Map();
const proposalDrafts = new Map();
const HOURS_HINT = 'Anna tunnit, esim. 5 tai 2,5.';
const NAVIGATION_LABELS = Object.freeze({ estimate: 'Avaa arviointi', log_time: 'Kirjaa aikaa' });

function proposalErrorHtml(proposal) {
  const error = proposalErrors.get(proposal.id);
  if (!error) return '';
  return `<p class="field-error" id="dirAdjErr-${escapeHtml(proposal.id)}" role="alert" style="display:block">`
    + `${escapeHtml(error)}</p>`;
}

function proposalField(proposal, label, minutes) {
  const id = `dirAdj-${proposal.id}`;
  const error = proposalErrors.get(proposal.id);
  const value = proposalDrafts.has(proposal.id) ? proposalDrafts.get(proposal.id) : toHoursInput(minutes);
  return `<label class="field-label" for="${escapeHtml(id)}">${escapeHtml(label)}</label>`
    + `<input type="number" min="0" max="168" step="0.5" id="${escapeHtml(id)}"`
    + ` data-adjust-value="${escapeHtml(proposal.id)}" value="${escapeHtml(value)}"`
    + (error ? ` aria-invalid="true" aria-describedby="dirAdjErr-${escapeHtml(proposal.id)}"` : '') + '>';
}

function proposalInput(proposal) {
  if (proposal.type === ADJUSTMENT.CHANGE_TARGET) {
    return proposalField(proposal, 'Uusi tavoite tunteina', proposal.payload.to);
  }
  if (proposal.type === ADJUSTMENT.SET_CAPACITY) {
    return proposalField(proposal, 'Ensi viikon kapasiteetti tunteina', proposal.payload.availableMinutes);
  }
  return '';
}

function proposalsHtml(proposals, weekStart) {
  if (proposals.length === 0) {
    return '<div class="assist-empty">Ei ehdotuksia. Voit silti kirjata pohdintasi.</div>';
  }
  return proposals.map(proposal => {
    const navigating = NON_WRITING_ADJUSTMENTS.includes(proposal.type);
    // Jo toteutettu (myös aiemmalla käynnillä: tallennettu katsaus tai
    // olemassa oleva tehtävä) ei tarjoa samaa muutosta uudelleen.
    if (!navigating && isAdjustmentDone(proposal, weekStart)) {
      return `
    <div class="assist-row is-closed">
      <div class="assist-title">${escapeHtml(proposal.label)}</div>
      <div class="assist-meta"><span class="assist-tag">Tehty</span></div>
    </div>`;
    }
    return `
    <div class="assist-row">
      ${navigating ? '' : `<label class="checkbox-row" for="dirSel-${escapeHtml(proposal.id)}">
        <input type="checkbox" id="dirSel-${escapeHtml(proposal.id)}" data-adjust-select="${escapeHtml(proposal.id)}"
          ${selectedProposalIds.has(proposal.id) ? 'checked' : ''}> Valitse</label>`}
      <div class="assist-title">${escapeHtml(proposal.label)}</div>
      ${proposal.detail ? `<div class="assist-reason">${escapeHtml(proposal.detail)}</div>` : ''}
      ${proposalInput(proposal)}
      ${proposalErrorHtml(proposal)}
      <div class="assist-actions">
        <button class="assist-btn${navigating ? '' : ' primary'}" type="button" data-adjust="${escapeHtml(proposal.id)}">`
          + `${navigating ? escapeHtml(NAVIGATION_LABELS[ADJUSTMENT_NAVIGATION[proposal.type]] || 'Avaa') : 'Tee muutos…'}</button>
      </div>
    </div>`;
  }).join('');
}

function historyHtml(reviews) {
  const past = [...reviews].sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  if (past.length === 0) return '<div class="assist-empty">Ei tallennettuja katsauksia.</div>';
  return past.map(review => {
    const snapshot = review.snapshot || {};
    const signals = Array.isArray(snapshot.signals) ? snapshot.signals.length : 0;
    const areas = Array.isArray(snapshot.areas) ? snapshot.areas : [];
    const rows = areas.filter(area => area.active).map(area =>
      `<li>${escapeHtml(area.name)}: tavoite ${escapeHtml(area.desiredPercent === null || area.desiredPercent === undefined ? '–' : area.desiredPercent + ' %')}, `
      + `toteuma ${escapeHtml(area.actualPercent === null || area.actualPercent === undefined ? '–' : area.actualPercent + ' %')}</li>`).join('');
    const version = review.policyVersion || 1;
    const answers = review.reflectionAnswers || {};
    const answered = REFLECTION_CODES.filter(code => answers[code]).length;
    // Versio 3: osittain kirjatun viikon toteumaprosentit eivät kuvaa koko
    // viikkoa. Vanhassa tilannekuvassa tasoa ei ole, eikä sitä arvata.
    const trackingLevel = snapshot.dataQuality && snapshot.dataQuality.trackingLevel;
    const trackingReason = snapshot.dataQuality && snapshot.dataQuality.trackingReason;
    const loggedDays = snapshot.actual && Number.isInteger(snapshot.actual.daysWithEntries) ? snapshot.actual.daysWithEntries : 0;
    // Syy sanotaan: joka päivä vähän kirjannut viikko ei ole "vain 7 päivänä".
    const caveat = !trackingLevel || trackingLevel === TRACKING.ESTABLISHED ? ''
      : trackingLevel === TRACKING.NONE ? ' (ei kirjauksia)'
        : trackingReason === 'share' ? ' (toteumaa ei verrattu: vähän kirjattua aikaa)'
          : trackingReason === 'no_reference' ? ' (toteumaa ei verrattu: ei kapasiteettia eikä tavoitteita)'
            : ` (kirjauksia vain ${loggedDays} päivänä)`;
    return `
      <details class="dir-history">
        <summary>Viikko ${escapeHtml(weekLabel(review.weekStart))} · ${signals} havaintoa${escapeHtml(caveat)}</summary>
        <p class="hint">Säännöt: ${escapeHtml(POLICY_VERSIONS[version] || `versio ${version}`)}.
          Tallennettua katsausta ei lasketa uudelleen.</p>
        ${answered > 0 ? `<p class="dir-line">Vastattuja pohdintakysymyksiä: ${answered}</p>` : ''}
        ${snapshot.capacity && Number.isInteger(snapshot.capacity.availableMinutes)
          ? `<p class="dir-line">Kapasiteetti ${escapeHtml(hours(snapshot.capacity.availableMinutes))}</p>` : ''}
        ${rows ? `<ul>${rows}</ul>` : ''}
        ${review.reflection ? `<p class="assist-reason">${escapeHtml(review.reflection)}</p>` : ''}
        ${review.adjustments.length ? `<p class="dir-line">Valitut muutokset: ${review.adjustments.length}</p>` : ''}
      </details>`;
  }).join('');
}

// ------------------------------------------------------ renderöinti

export function renderDirection() {
  if (!maybe('screen-direction')) return;
  const state = getState();
  const week = shownWeek();
  const analysis = analyzeCurrentWeek(week);
  const areas = state.lifeAreas;

  lastAnalysis = analysis;
  renderedWeek = analysis.weekStart;

  setText('dirWeekLabel', weekLabel(analysis.weekStart));
  toggle('dirThisWeek', analysis.weekStart !== currentWeekStart());
  const problems = alignmentLoadProblems(state);
  const areasUnknown = problems.includes('lifeAreas') && areas.length === 0;
  // Jokin analyysin syöte (myös tehtävät, tavoitteet, rutiinit) jäi
  // lataamatta: havainnot, laatu ja ehdotukset korvataan ilmoituksella.
  const incomplete = analysisLoadProblems(state).length > 0;
  el('dirPersistNote').innerHTML = loadProblemHtml(problems) + persistNoteHtml();
  // Aloitus (F2) ensin. Tuntematon ei ole nolla: jos Suunnan tietoja ei
  // saatu ladattua (tai lataus on kesken eikä alueita vielä tunneta),
  // aloitusta ei näytetä — alueet voivat olla kannassa. Myös tyhjä
  // latausstatus ({} ennen ensimmäistä lataustulosta) on tuntematon: muuten
  // palaava käyttäjä näki joka kylmäkäynnistyksessä "Vaihe 1/7".
  const loadStatus = state.dataLoadStatus || {};
  // Aloituksen vaiheet luetaan myös tehtävistä ja tavoitteista.
  const setupSourcesFailed = ['tasks', 'goals'].some(domain => loadStatus[domain] && loadStatus[domain].ok === false);
  const setupActive = renderDirectionSetup({
    unknown: problems.length > 0 || !lifeAreasKnown(state) || setupSourcesFailed, queueHtml: estimateQueueHtml
  });
  // Ei tyhjän tilan kehotusta ("aloita elämänalueista"), kun alueita ei
  // saatu ladattua: niitä voi olla kannassa.
  el('dirSignals').innerHTML = incomplete ? analysisLoadNoticeHtml() : areasUnknown ? '' : signalsHtml(analysis, areas);
  const quality = maybe('dirQuality');
  if (quality) quality.innerHTML = areas.length > 0 && !incomplete ? qualityActionsHtml(analysis) : '';
  el('dirWeekSummary').innerHTML = weekSummaryHtml(analysis);
  const startTimer = maybe('dirStartTimer');
  if (startTimer) {
    startTimer.textContent = currentTimer() ? 'Ajastin käynnissä' : 'Aloita ajanseuranta';
    startTimer.disabled = Boolean(currentTimer());
  }

  const estimateSection = maybe('dirEstimateSection');
  if (estimateSection) {
    estimateSection.hidden = !estimateOpen;
    // Aloituksen ollessa auki osio on piilossa, ja jono kuuluu aloitukselle.
    if (estimateOpen && !setupActive) {
      el('dirEstimate').innerHTML = estimateMode === 'energy' ? energyRateHtml(analysis) : estimateQueueHtml('main');
    }
  }
  const unassignedSection = maybe('dirUnassignedSection');
  if (unassignedSection) {
    unassignedSection.hidden = !unassignedOpen;
    if (unassignedOpen) el('dirUnassigned').innerHTML = unassignedHtml(analysis);
  }
  el('dirAreaSuggestions').innerHTML = areasUnknown ? '' : suggestionsHtml(areas);
  el('dirAreasList').innerHTML = areasHtml(areas, analysis);
  el('dirGoalsList').innerHTML = goalsHtml(areas, state.goals);

  const dates = weekDates(analysis.weekStart);
  el('dirTimeList').innerHTML = timeListHtml(entriesInRange(state.timeEntries, dates[0], dates[6]), areas);
  const timeArea = el('dirTimeArea');
  const chosenArea = timeArea.value;
  timeArea.innerHTML = areaOptions(areas.filter(area => area.active), chosenArea, 'Ei aluetta');

  // Lomakkeen arvoja ei ylikirjoiteta kesken kirjoittamisen — eikä
  // tallentamatonta arvoa senkään jälkeen, kun fokus on siirtynyt muualle
  // (RACE-13: datan päivitys piirtää näkymän uudelleen).
  const capacity = capacityForWeek(state.weeklyCapacities, analysis.weekStart);
  const untouched = field => document.activeElement !== field && !field.dataset.dirty;
  const hoursInput = el('dirCapacityHours');
  if (untouched(hoursInput)) hoursInput.value = capacity ? toHoursInput(capacity.availableMinutes) : '';
  const energy = el('dirEnergy');
  if (untouched(energy)) energy.value = capacity && capacity.energyLevel ? String(capacity.energyLevel) : '';
  const budget = maybe('dirEnergyBudget');
  if (budget && untouched(budget)) {
    budget.value = capacity && Number.isInteger(capacity.energyBudgetMinutes) ? toHoursInput(capacity.energyBudgetMinutes) : '';
  }
  const timeDate = el('dirTimeDate');
  if (!timeDate.value || !dates.includes(timeDate.value)) {
    const today = fmtISO(todayMidnight());
    timeDate.value = dates.includes(today) ? today : dates[0];
  }

  el('dirReview').innerHTML = incomplete ? analysisLoadNoticeHtml() : reviewHtml(analysis, areas);
  const compare = maybe('dirReviewCompare');
  if (compare) {
    compare.innerHTML = areas.length > 0 && !incomplete
      ? compareHtml(compareWithPreviousWeek(analysis.weekStart, { analysis })) : '';
  }
  const existingReview = state.alignmentReviews.find(review => review.weekStart === analysis.weekStart);
  const reflection = el('dirReflection');
  if (document.activeElement !== reflection && existingReview && !reflection.dataset.dirty) {
    reflection.value = existingReview.reflection || '';
  }
  // Pohdintakysymykset: täytetään tallennetusta, jos käyttäjä ei ole kirjoittamassa.
  for (const code of REFLECTION_CODES) {
    const field = maybe(`dirAnswer-${code}`);
    if (!field || document.activeElement === field || field.dataset.dirty) continue;
    field.value = existingReview && existingReview.reflectionAnswers ? existingReview.reflectionAnswers[code] || '' : '';
  }
  shownProposals = incomplete ? [] : currentProposals(analysis);
  const ids = new Set(shownProposals.map(proposal => proposal.id));
  selectedProposalIds = new Set([...selectedProposalIds].filter(id => ids.has(id)));
  for (const map of [proposalErrors, proposalDrafts]) {
    for (const id of [...map.keys()]) if (!ids.has(id)) map.delete(id);
  }
  el('dirProposals').innerHTML = incomplete ? analysisLoadNoticeHtml() : proposalsHtml(shownProposals, analysis.weekStart);
  // Esikatselu kuvaa sen tilan, jossa se laskettiin. Mikä tahansa muutos
  // (toisessa näkymässä tai tallennuksen jälkeen) mitätöi sen.
  if (lastPreview && lastPreview.stateRef !== state) lastPreview = null;
  const preview = maybe('dirProposalPreview');
  if (preview) preview.innerHTML = previewHtml(lastPreview);
  const apply = maybe('dirApplySelected');
  if (apply) apply.disabled = !lastPreview || selectedProposalIds.size === 0;
  el('dirReviewHistory').innerHTML = historyHtml(state.alignmentReviews);
  const trends = maybe('dirTrends');
  if (trends) trends.innerHTML = trendsHtml(trendsRequested ? recentTrends(analysis.weekStart) : null);
}

/**
 * Päivänäkymän kevyt kortti: yksi havainto, ei kaavioita.
 */
export function renderTodayDirection() {
  const container = maybe('todayDirection');
  if (!container) return;
  const state = getState();
  if (state.lifeAreas.length === 0 && alignmentLoadProblems(state).includes('lifeAreas')) {
    container.innerHTML = `<div class="dir-today">
      <div class="dir-today-title">Suunta</div>
      <p class="dir-line" role="status">Suunnan tietoja ei voitu ladata. Ne ovat tallessa — päivitä, kun yhteys toimii.</p></div>`;
    return;
  }
  if (state.lifeAreas.length === 0 && !lifeAreasKnown(state)) {
    // Lataus kesken: tuntematon ei ole "ei alueita", joten ei "Aloita Suunta" -kehotusta.
    container.innerHTML = `<div class="dir-today">
      <div class="dir-today-title">Suunta</div>
      <p class="dir-line" role="status">Ladataan…</p></div>`;
    return;
  }
  if (state.lifeAreas.length === 0) {
    // "Aloita Suunta" avaa aloituksen vaiheesta 1 (F2).
    container.innerHTML = `<div class="dir-today">
      <div class="dir-today-title">Suunta</div>
      <p class="dir-line">Kerro mikä elämässäsi on tärkeää, niin näet elääkö viikko sen mukaan.</p>
      <button class="assist-btn primary" type="button" data-open-setup="1">Aloita Suunta</button></div>`;
    return;
  }
  // Jokin analyysin syöte jäi lataamatta: vajaista luvuista ei tehdä
  // havaintoja ("alue ei saanut aikaa", kun kirjaukset puuttuvat).
  if (analysisLoadProblems(state).length > 0) {
    container.innerHTML = `<div class="dir-today">
      <div class="dir-today-title">Suunta</div>
      <p class="dir-line" role="status">Kaikkia tietoja ei saatu ladattua, joten havaintoja ei näytetä vajailla luvuilla. `
        + `Päivitä, kun yhteys toimii.</p>
      <div class="assist-actions">
        <button class="assist-btn" type="button" data-open-direction="1">Avaa Suunta</button>
      </div></div>`;
    return;
  }
  // Päivän havainnot: enintään muutama, deterministisessä järjestyksessä,
  // ja jokainen kertoo miksi juuri se näytetään. Ei kaavioita.
  const { analysis, daily } = currentDailyAlignment();
  const lines = [...daily.status];
  const shownUnassigned = daily.observations.some(observation => observation.code === 'unassigned');
  const open = analysis.dataQuality.unassignedPlannedCount;
  if (!shownUnassigned && open > 0) {
    lines.push(open === 1
      ? '1 viikon asia ei kuulu mihinkään alueeseen.'
      : `${open} viikon asiaa ei kuulu mihinkään alueeseen.`);
  }
  // Harva arvioaineisto: ensimmäinen rivi, toimenpide mukana. Sama
  // toimenpide ei toistu havainnon alla.
  const notice = daily.notice
    ? `<div class="dir-today-notice" role="status">
        <p class="dir-line"><strong>${escapeHtml(daily.notice)}</strong></p>
        ${daily.noticeAction ? `<button class="assist-btn" type="button" data-today-action="${escapeHtml(daily.noticeAction)}">`
          + `${escapeHtml(QUALITY_ACTION_LABELS[QUALITY_ACTION.ESTIMATE])}</button>` : ''}
      </div>`
    : '';
  const ACTION_LABELS = { open_unassigned: 'Kohdista', open_estimate: 'Arvioi', open_direction: 'Avaa Suunta' };
  const observations = daily.observations.map(observation => {
    const basis = observation.signal ? BASIS_LABELS[observation.signal.basis] : '';
    const action = observation.action && observation.action !== 'open_direction'
      && !(daily.noticeAction && observation.action === daily.noticeAction) ? observation.action : null;
    return `
    <div class="dir-today-observation ${severityClass(observation.severity)}">
      <p class="dir-line">${observation.primary ? '<strong>Tänään kannattaa huomata:</strong> ' : ''}`
        + `${escapeHtml(SEVERITY_LABELS[observation.severity])}: ${escapeHtml(observation.title)}.`
        + `${basis ? ` <span class="assist-tag dir-basis">${escapeHtml(basis)}</span>` : ''}</p>
      <details class="dir-why">
        <summary>Miksi tämä?</summary>
        <p>${escapeHtml(observation.text)}</p>
        <p class="hint">${escapeHtml(observation.why)}</p>
      </details>
      ${action
        ? `<button class="assist-btn" type="button" data-today-action="${escapeHtml(action)}">${escapeHtml(ACTION_LABELS[action])}</button>` : ''}
    </div>`;
  }).join('');
  if (lines.length === 0 && !observations && !notice) lines.push('Ei havaintoja tällä viikolla.');
  container.innerHTML = `<div class="dir-today">
    <div class="dir-today-title">Suunta</div>
    ${notice}
    ${lines.map(line => `<p class="dir-line">${escapeHtml(line)}</p>`).join('')}
    ${observations}
    ${daily.hiddenCount > 0 ? `<p class="hint">${countOf(daily.hiddenCount, 'muu havainto', 'muuta havaintoa')} Suunnassa.</p>` : ''}
    <div class="assist-actions">
      <button class="assist-btn" type="button" data-today-action="log_time">Kirjaa aikaa</button>
      <button class="assist-btn" type="button" data-open-direction="1">Avaa Suunta</button>
    </div></div>`;
}

// ------------------------------------------------------ lomakkeet

function fillCategorySelect(selected) {
  const select = el('dirAreaCategory');
  const taken = new Set(getState().lifeAreas
    .filter(area => area.id !== editingAreaId && area.categoryKey).map(area => area.categoryKey));
  select.innerHTML = '<option value="">Ei kategoriaa</option>'
    + CATEGORIES.map(category => `<option value="${escapeHtml(category.key)}"`
      + `${category.key === selected ? ' selected' : ''}${taken.has(category.key) ? ' disabled' : ''}>`
      + `${escapeHtml(category.label)}${taken.has(category.key) ? ' (käytössä)' : ''}</option>`).join('');
}

function clearAreaErrors() {
  for (const id of ['dirAreaNameError', 'dirAreaImportanceError', 'dirAreaTargetError', 'dirAreaCategoryError']) {
    setError(id, '');
  }
}

/**
 * Kategorian vaikutus näkyviin ENNEN tallennusta (F9): kytkentä tuo
 * alueeseen kaikki kategorian tehtävät, joilla ei ole tavoitteen kautta
 * omaa aluetta. Ehdotuksen esivalitsema kategoria ei saa yllättää.
 */
function renderCategoryImpact() {
  const node = maybe('dirAreaCategoryImpact');
  if (!node) return;
  const key = maybe('dirAreaCategory') ? el('dirAreaCategory').value : '';
  if (!key) {
    node.textContent = '';
    return;
  }
  const state = getState();
  const impact = categoryImpact(state.tasks, state.routines, key, {
    goals: state.goals, projects: state.projects, areas: state.lifeAreas, todayIso: clockNow().todayIso
  });
  const label = CATEGORIES.find(c => c.key === key)?.label || key;
  node.textContent = `Kategoria ${label}: ${countOf(impact.tasks, 'avoin tehtävä', 'avointa tehtävää')}`
    + ` (${impact.thisWeek} tällä viikolla)`
    + (impact.routines > 0 ? ` ja ${countOf(impact.routines, 'rutiini', 'rutiinia')}` : '')
    + ' lasketaan tähän alueeseen.';
}

export function openAreaForm(id = null, prefill = {}) {
  const area = id ? findLifeArea(id) : null;
  editingAreaId = area ? area.id : null;
  clearAreaErrors();
  setText('dirAreaFormTitle', area ? 'Muokkaa elämänaluetta' : 'Uusi elämänalue');
  el('dirAreaName').value = area ? area.name : (prefill.name || '');
  // Uudella alueella ei ole valmiiksi valittua tärkeyttä (F7).
  el('dirAreaImportance').value = area ? String(area.importance) : '';
  el('dirAreaTarget').value = area ? toHoursInput(area.targetMinutesPerWeek) : '';
  fillCategorySelect(area ? area.categoryKey : (prefill.categoryKey || ''));
  renderCategoryImpact();
  el('dirAreaDescription').value = area && area.description ? area.description : '';
  el('dirAreaActive').checked = area ? area.active : true;
  toggle('dirAreaDelete', Boolean(area));
  toggle('dirAreaForm', true);
  toggle('dirAddArea', false);
  focus('dirAreaName');
}

export function closeAreaForm() {
  editingAreaId = null;
  clearAreaErrors();
  toggle('dirAreaForm', false);
  toggle('dirAddArea', true);
}

async function submitAreaForm() {
  clearAreaErrors();
  if (el('dirAreaImportance').value === '') {
    setError('dirAreaImportanceError', 'Valitse kuinka tärkeä alue on.');
    focus('dirAreaImportance');
    return;
  }
  const target = toMinutesFromHours(el('dirAreaTarget').value);
  if (Number.isNaN(target)) {
    setError('dirAreaTargetError', 'Anna tavoite tunteina, esim. 5 tai 2,5.');
    return;
  }
  const values = {
    name: el('dirAreaName').value,
    importance: Number(el('dirAreaImportance').value),
    targetMinutesPerWeek: target,
    categoryKey: el('dirAreaCategory').value || null,
    description: el('dirAreaDescription').value || null,
    active: el('dirAreaActive').checked
  };
  const result = editingAreaId ? await editLifeArea(editingAreaId, values) : await createLifeArea(values);
  if (!result.ok) {
    const errors = result.errors || {};
    if (errors.name) setError('dirAreaNameError', errors.name);
    if (errors.importance) setError('dirAreaImportanceError', errors.importance);
    if (errors.targetMinutesPerWeek) setError('dirAreaTargetError', errors.targetMinutesPerWeek);
    if (errors.categoryKey) setError('dirAreaCategoryError', errors.categoryKey);
    return;
  }
  closeAreaForm();
  focus('dirAddArea');
}

async function submitCapacity() {
  setError('dirCapacityError', '');
  setText('dirCapacityWarning', '');
  const minutes = toMinutesFromHours(el('dirCapacityHours').value);
  if (minutes === null || Number.isNaN(minutes)) {
    setError('dirCapacityError', 'Anna tunnit, esim. 25.');
    return;
  }
  const energyValue = el('dirEnergy').value;
  setError('dirEnergyBudgetError', '');
  const budgetField = maybe('dirEnergyBudget');
  const budget = budgetField ? toMinutesFromHours(budgetField.value) : null;
  if (Number.isNaN(budget)) {
    setError('dirEnergyBudgetError', 'Anna tunnit, esim. 8, tai jätä tyhjäksi.');
    return;
  }
  const week = targetWeek();
  const result = await saveWeeklyCapacity({
    weekStart: week, availableMinutes: minutes, energyLevel: energyValue ? Number(energyValue) : null,
    energyBudgetMinutes: budget
  });
  if (!result.ok) {
    if (result.errors && result.errors.availableMinutes) setError('dirCapacityError', result.errors.availableMinutes);
    if (result.errors && result.errors.energyBudgetMinutes) setError('dirEnergyBudgetError', result.errors.energyBudgetMinutes);
    return;
  }
  clearCapacityDirty();
  releaseDraftPin();
  const previousWeek = addDaysIso(week, -7);
  const state = getState();
  const previousActual = entriesInRange(state.timeEntries, previousWeek, addDaysIso(previousWeek, 6))
    .reduce((sum, entry) => sum + entry.minutes, 0);
  const warnings = capacityWarnings(result.capacity, { previousActualMinutes: previousActual || null });
  if (warnings.includes('unrealistic')) {
    setText('dirCapacityWarning', 'Tallennettu. Yli 60 tuntia suunniteltavaa aikaa viikossa on harvoin realistista.');
  } else if (warnings.includes('above_previous_actual')) {
    setText('dirCapacityWarning', 'Tallennettu. Arvio on yli kaksinkertainen edellisen viikon kirjattuun toteumaan.');
  }
}

// Yksi kirjaus per lomakkeen täyttö. Kaksoisnapautus (tai uusinta
// verkkovirheen jälkeen) käyttää SAMAA operaatiotunnistetta, jolloin
// logTime ja kannan uniikkiavain (user_id, operation_id) tekevät siitä
// yhden rivin. Tunniste vaihtuu vasta onnistuneen kirjauksen jälkeen.
let timeFormOperation = null;
let timeSubmitting = false;

export function resetTimeFormForTests() {
  timeFormOperation = null;
  timeSubmitting = false;
}

async function submitTime() {
  if (timeSubmitting) return;
  timeSubmitting = true;
  const button = maybe('dirTimeSave');
  if (button) button.disabled = true;
  try {
    setError('dirTimeDateError', '');
    setError('dirTimeMinutesError', '');
    if (!timeFormOperation) timeFormOperation = newOperationId();
    const result = await logTime({
      entryDate: el('dirTimeDate').value || null,
      minutes: Number(el('dirTimeMinutes').value),
      lifeAreaId: el('dirTimeArea').value || null,
      note: el('dirTimeNote').value || null,
      operationId: timeFormOperation
    });
    if (!result.ok) {
      const errors = result.errors || {};
      if (errors.entryDate) setError('dirTimeDateError', errors.entryDate);
      if (errors.minutes) setError('dirTimeMinutesError', errors.minutes);
      return;
    }
    timeFormOperation = null;
    el('dirTimeMinutes').value = '';
    el('dirTimeNote').value = '';
  } finally {
    timeSubmitting = false;
    if (button) button.disabled = false;
  }
}

async function submitReview() {
  const status = el('dirReviewStatus');
  status.textContent = '';
  const reflection = el('dirReflection');
  const reflectionAnswers = {};
  for (const code of REFLECTION_CODES) {
    const field = maybe(`dirAnswer-${code}`);
    if (field && field.value) reflectionAnswers[code] = field.value;
  }
  const result = await saveWeeklyReview({
    weekStart: targetWeek(), reflection: reflection.value || null, reflectionAnswers
  });
  if (result.code === 'incomplete_data') {
    // Mitään ei tallennettu; kentät (ja niiden "kesken"-merkintä) säilyvät.
    status.textContent = 'Kaikkia tietoja ei saatu ladattua, joten katsausta ei tallennettu vajailla luvuilla. '
      + 'Pohdintasi on yhä kentässä – päivitä, kun yhteys toimii.';
    return;
  }
  if (result.ok) {
    delete reflection.dataset.dirty;
    for (const code of REFLECTION_CODES) {
      const field = maybe(`dirAnswer-${code}`);
      if (field) delete field.dataset.dirty;
    }
    releaseDraftPin();
    status.textContent = 'Viikkokatsaus tallennettu.';
  }
}

/**
 * Yksi tallennus kerrallaan (RACE-04, RACE-15): rinnakkainen napautus
 * ohitetaan ja painike on pois käytöstä vastaukseen asti — sama malli
 * kuin aikakirjauksessa (submitTime). Ennen tätä toinen napautus
 * ensimmäisen ollessa kesken muuttui UPDATEksi riville, jota kannassa ei
 * vielä ollut, ja näkymä saattoi ilmoittaa "tallennettu" turhaan.
 */
function guardedSave(buttonId, save) {
  return singleFlight(async () => {
    const button = maybe(buttonId);
    setBusy(button, true);
    if (button) button.disabled = true;
    try {
      return await save();
    } finally {
      setBusy(button, false);
      if (button) button.disabled = false;
    }
  });
}

const saveAreaFormOnce = guardedSave('dirAreaSave', submitAreaForm);
const saveCapacityOnce = guardedSave('dirCapacitySave', submitCapacity);
const saveReviewOnce = guardedSave('dirReviewSave', submitReview);
const deleteAreaOnce = singleFlight(async () => {
  if (!editingAreaId) return;
  if (await deleteLifeArea(editingAreaId)) closeAreaForm();
});

// ------------------------------------------------ uudet toiminnot (v2)

/**
 * Ehdotuksen kentän arvo: { overrides } tai { error } (tyhjä tai ei luku).
 * Arvoalueen (0–168 h) tarkistaa sovelluskerros samoilla säännöillä kuin
 * tallennus (adjustmentErrors), ja sen virhe näytetään samaan paikkaan.
 */
function readProposalInput(proposal) {
  const input = el('dirProposals').querySelector(`[data-adjust-value="${CSS.escape(proposal.id)}"]`);
  if (!input) return { overrides: {} };
  const raw = input.value;
  const minutes = toMinutesFromHours(raw);
  if (minutes === null || Number.isNaN(minutes)) return { error: HOURS_HINT, raw };
  if (proposal.type === ADJUSTMENT.CHANGE_TARGET) return { overrides: { to: minutes }, raw };
  if (proposal.type === ADJUSTMENT.SET_CAPACITY) return { overrides: { availableMinutes: minutes }, raw };
  return { overrides: {}, raw };
}

function firstError(errors) {
  const values = Object.values(errors || {}).filter(Boolean);
  return values.length > 0 ? String(values[0]) : 'Muutosta ei saatu tehtyä. Yritä uudelleen.';
}

/** Kirjoitetut arvot talteen ennen uudelleenpiirtoa: virhe ei pyyhi käyttäjän syötettä. */
function keepProposalDrafts() {
  const container = maybe('dirProposals');
  if (!container) return;
  for (const proposal of shownProposals) {
    const input = container.querySelector(`[data-adjust-value="${CSS.escape(proposal.id)}"]`);
    if (input) proposalDrafts.set(proposal.id, input.value);
  }
}

function showProposalErrors(entries) {
  keepProposalDrafts();
  for (const { id, message, raw } of entries) {
    proposalErrors.set(id, message);
    if (raw !== undefined) proposalDrafts.set(id, raw);
  }
  const container = maybe('dirProposals');
  if (container) container.innerHTML = proposalsHtml(shownProposals, targetWeek());
  if (entries.length > 0) focus(`dirAdj-${entries[0].id}`);
}

function clearProposalError(id) {
  proposalErrors.delete(id);
  proposalDrafts.delete(id);
}

function selectedProposals() {
  return shownProposals.filter(proposal => selectedProposalIds.has(proposal.id));
}

function collectOverrides(proposals) {
  const overrides = {};
  const invalid = [];
  for (const proposal of proposals) {
    const read = readProposalInput(proposal);
    if (read.error) invalid.push({ id: proposal.id, message: read.error, raw: read.raw });
    else overrides[proposal.id] = read.overrides;
  }
  if (invalid.length > 0) {
    showProposalErrors(invalid);
    return null;
  }
  return overrides;
}

function onPreviewSelected() {
  const proposals = selectedProposals();
  if (proposals.length === 0) {
    lastPreview = null;
    const node = maybe('dirProposalPreview');
    if (node) node.innerHTML = '<p class="hint">Valitse ensin yksi tai useampi ehdotus.</p>';
    return;
  }
  const overrides = collectOverrides(proposals);
  if (!overrides) return;
  const preview = previewSelectedAdjustments(targetWeek(), proposals, overrides);
  lastPreview = { ...preview, stateRef: getState(), ids: proposals.map(p => p.id), overrides };
  renderDirection();
}

async function onApplySelected() {
  if (!lastPreview) return;
  const proposals = shownProposals.filter(proposal => lastPreview.ids.includes(proposal.id));
  const week = targetWeek();
  const result = await applySelectedAdjustments(proposals, {
    overrides: lastPreview.overrides, preview: lastPreview, weekStart: week
  });
  if (result.cancelled) return;
  if (result.invalid && result.invalid.length > 0) {
    // Kelvoton arvo: mitään ei tehty eikä kysytty. Virhe kentän viereen ja
    // nimetty yhteenveto esikatselun kohdalle.
    showProposalErrors(result.invalid.map(entry => ({ id: entry.id, message: firstError(entry.errors) })));
    const node = maybe('dirProposalPreview');
    if (node) {
      node.innerHTML = `<p class="field-error" role="alert" style="display:block">Tarkista arvot ennen vahvistusta: `
        + `${escapeHtml(result.invalid.map(entry => entry.label).join('; '))}. Mitään ei muutettu.</p>`;
    }
    lastPreview = null;
    return;
  }
  for (const entry of result.failed || []) proposalErrors.set(entry.id, firstError(entry.errors));
  const existing = getState().alignmentReviews.find(review => review.weekStart === week);
  const appliedIds = (result.results || []).filter(entry => entry.applied).map(entry => entry.id);
  for (const id of appliedIds) clearProposalError(id);
  if (existing && appliedIds.length > 0) {
    await saveWeeklyReview({ weekStart: week, reflection: existing.reflection, adjustments: appliedIds });
  }
  selectedProposalIds = new Set();
  lastPreview = null;
  renderDirection();
}

/** Tallenna kestoarvio. Palauttaa, onnistuiko (jono etenee vain onnistuessa). */
async function saveEstimate(key, minutes, approximate) {
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (kind === 'task') {
    const result = await editTask(id, { durationMinutes: minutes });
    if (result && result.ok) await saveItemSettings('task', id, { estimateApproximate: Boolean(approximate) });
    return Boolean(result && result.ok);
  }
  if (kind === 'routine') {
    const result = await editRoutine(id, { durationMinutes: minutes });
    return Boolean(result && result.ok);
  }
  return false;
}

async function onEstimateClick(event) {
  const rate = event.target.closest('[data-energy-rate]');
  if (rate) {
    const { kind, id } = splitKey(rate.dataset.energyRate);
    rate.disabled = true;
    await saveItemSettings(kind, id, { energyDemand: Number(rate.dataset.level) });
    return;
  }
  handleQueueEvent('click', event);
}

function splitKey(key) {
  const index = key.indexOf(':');
  return { kind: key.slice(0, index), id: key.slice(index + 1) };
}

async function onAssignChange(event) {
  const goalSelect = event.target.closest('[data-assign-goal]');
  if (goalSelect && goalSelect.value) {
    const { kind, id } = splitKey(goalSelect.dataset.assignGoal);
    if (kind === 'task') await editTask(id, { goalId: goalSelect.value });
    if (kind === 'routine') await editRoutine(id, { goalId: goalSelect.value });
    return;
  }
  const categorySelect = event.target.closest('[data-assign-category]');
  if (categorySelect && categorySelect.value) {
    const { kind, id } = splitKey(categorySelect.dataset.assignCategory);
    if (kind === 'task') await editTask(id, { category: categorySelect.value });
  }
}

async function onAssignClick(event) {
  const optOut = event.target.closest('[data-assign-optout]');
  if (optOut) {
    const { kind, id } = splitKey(optOut.dataset.assignOptout);
    optOut.disabled = true;
    await saveItemSettings(kind, id, { alignmentOptOut: true });
    return;
  }
  const skip = event.target.closest('[data-assign-skip]');
  if (skip) {
    skippedUnassigned.add(skip.dataset.assignSkip);
    renderDirection();
  }
}

function openWorkflow(which, mode = 'duration', { weekStart = null } = {}) {
  if (which === 'estimate') {
    estimateOpen = true;
    estimateMode = mode;
    // Jono kiinnitetään avattaessa (F4): järjestys ei muutu piirrosta toiseen.
    if (mode === 'duration') startEstimateQueue({ scope: 'workflow', weekStart: weekStart || shownWeek(), includeNextWeek: true });
  }
  if (which === 'assign') unassignedOpen = true;
  // Käyttäjä pyysi tiettyä työkalua: aloitus väistyy tämän istunnon ajaksi,
  // muuten avattu osio jäisi aloituksen alle piiloon.
  dismissDirectionSetup();
  renderDirection();
  const target = which === 'estimate' ? 'dirEstimateTitle' : 'dirUnassignedTitle';
  const node = maybe(target);
  if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * "Kohdista kirjattu aika" (F6): toteumalista näyttää vain alueettomat
 * kirjaukset, ja fokus siirtyy ensimmäiseen aluevalintaan. Aiemmin
 * toimenpide avasi suunniteltujen asioiden listan, jossa kirjattua aikaa
 * ei ollut lainkaan.
 */
function showUnassignedTime() {
  timeListUnassignedOnly = true;
  renderDirection();
  const title = maybe('dirActualTitle');
  if (title && typeof title.scrollIntoView === 'function') title.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const list = maybe('dirTimeList');
  const first = list && typeof list.querySelector === 'function' ? list.querySelector('[data-time-area]') : null;
  if (first && typeof first.focus === 'function') first.focus();
}

function onQualityAction(action) {
  switch (action) {
    case QUALITY_ACTION.ESTIMATE: openWorkflow('estimate'); break;
    case QUALITY_ACTION.ASSIGN: openWorkflow('assign'); break;
    case QUALITY_ACTION.ASSIGN_TIME: showUnassignedTime(); break;
    case QUALITY_ACTION.LOG_TIME: openGeneralLog(); break;
    case QUALITY_ACTION.ADD_AREAS:
      // Ilman yhtään aluetta aloitus on oikea paikka (vaihe 1); muuten lomake.
      if (getState().lifeAreas.some(area => area.active)) openAreaForm(null);
      else openDirectionSetup();
      break;
    case QUALITY_ACTION.SET_CAPACITY: focus('dirCapacityHours'); break;
    case QUALITY_ACTION.SET_TARGETS: {
      const first = [...getState().lifeAreas].sort(compareLifeAreas).find(area => area.active);
      if (first) openAreaForm(first.id);
      break;
    }
    case QUALITY_ACTION.RATE_ENERGY: openWorkflow('estimate', 'energy'); break;
    default: break;
  }
}

async function onExplain(key) {
  // Sama haku on jo kesken: toinen napautus ei lähetä toista pyyntöä.
  if (!lastAnalysis || explainsInFlight.has(key)) return;
  const signal = lastAnalysis.signals.find(entry => signalKey(entry) === key);
  if (!signal) return;
  const generation = viewGeneration;
  explainsInFlight.add(key);
  let result;
  try {
    result = await explainSignalOptionally(signal, lastAnalysis);
  } finally {
    // Uloskirjautuminen on jo tyhjentänyt joukon (resetDirectionView).
    if (generation === viewGeneration) explainsInFlight.delete(key);
  }
  // Käyttäjä kirjautui ulos (tai vaihtui) odotuksen aikana: selitys ei
  // kuulu seuraavalle käyttäjälle.
  if (generation !== viewGeneration) return;
  explanations.set(key, { source: result.source, text: result.text });
  renderDirection();
}

async function onProposalClick(event) {
  const button = event.target.closest('[data-adjust]');
  if (!button) return;
  const proposal = shownProposals.find(entry => entry.id === button.dataset.adjust);
  if (!proposal) return;
  // Tyhjä tai kelvoton arvo ei enää ohitu hiljaa (ERR-12): virhe kentän viereen.
  const read = readProposalInput(proposal);
  if (read.error) {
    showProposalErrors([{ id: proposal.id, message: read.error, raw: read.raw }]);
    return;
  }
  const week = targetWeek();
  const result = await applyAdjustment(proposal, { overrides: read.overrides, weekStart: week });
  if (result.navigate === 'estimate') {
    // Ehdotus koskee ensi viikkoa: näytetään se viikko, jonka asiat arvioidaan.
    if (proposal.payload && proposal.payload.weekStart) {
      viewWeek = weekStartOf(proposal.payload.weekStart);
      pinnedByDraft = false;
    }
    openWorkflow('estimate');
    return;
  }
  if (result.navigate === 'log_time') {
    openGeneralLog();
    return;
  }
  if (result.errors) {
    showProposalErrors([{ id: proposal.id, message: firstError(result.errors), raw: read.raw }]);
    return;
  }
  if (result.applied || result.duplicate) clearProposalError(proposal.id);
  if (result.applied) {
    const state = getState();
    const existing = state.alignmentReviews.find(review => review.weekStart === week);
    // Valittu muutos kirjataan katsaukseen, jos katsaus on jo tallennettu.
    if (existing) {
      await saveWeeklyReview({ weekStart: week, reflection: existing.reflection, adjustments: [proposal.id] });
    }
  }
}

// ------------------------------------------------------ tapahtumat

function goToWeek(offsetDays) {
  viewWeek = weekStartOf(addDaysIso(shownWeek(), offsetDays));
  // Käyttäjän oma valinta: tallennus ei palauta näkymää tähän viikkoon.
  pinnedByDraft = false;
  explanations = new Map();
  lastPreview = null;
  // Kapasiteettikentät näyttävät valitun viikon arvot, eivät edellisen luonnosta.
  clearCapacityDirty();
  renderDirection();
}

export function initDirection() {
  const prev = maybe('dirPrev');
  if (!prev) return;
  prev.addEventListener('click', () => goToWeek(-7));
  el('dirNext').addEventListener('click', () => goToWeek(7));
  el('dirThisWeek').addEventListener('click', () => {
    viewWeek = null;
    pinnedByDraft = false;
    clearCapacityDirty();
    renderDirection();
  });

  el('dirCapacitySave').addEventListener('click', saveCapacityOnce);
  for (const id of CAPACITY_FIELDS) {
    const field = maybe(id);
    if (!field) continue;
    field.addEventListener('input', event => markDirty(event.target || field));
    field.addEventListener('change', event => markDirty(event.target || field));
  }
  el('dirAddArea').addEventListener('click', () => openAreaForm(null));
  el('dirAreaCancel').addEventListener('click', closeAreaForm);
  el('dirAreaSave').addEventListener('click', saveAreaFormOnce);
  el('dirAreaDelete').addEventListener('click', deleteAreaOnce);
  el('dirAreaForm').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeAreaForm(); }
  });

  el('dirAreaSuggestions').addEventListener('click', event => {
    const chip = event.target.closest('[data-area-suggest]');
    if (chip) openAreaForm(null, { name: chip.dataset.areaSuggest, categoryKey: chip.dataset.category || null });
  });
  el('dirAreasList').addEventListener('click', event => {
    const edit = event.target.closest('[data-area-edit]');
    if (edit) openAreaForm(edit.dataset.areaEdit);
  });
  el('dirGoalsList').addEventListener('change', event => {
    const select = event.target.closest('[data-goal-area]');
    if (select) assignGoalToLifeArea(select.dataset.goalArea, select.value || null);
  });

  el('dirTimeSave').addEventListener('click', submitTime);
  el('dirTimeList').addEventListener('click', event => {
    const remove = event.target.closest('[data-time-delete]');
    if (remove) deleteTimeEntry(remove.dataset.timeDelete);
    if (event.target.closest('[data-time-show-all]')) {
      timeListUnassignedOnly = false;
      renderDirection();
    }
  });
  // Kirjatun ajan alue jälkikäteen (F6).
  el('dirTimeList').addEventListener('change', event => {
    const select = event.target.closest('[data-time-area]');
    if (select && select.value) editTimeEntry(select.dataset.timeArea, { lifeAreaId: select.value });
  });
  const category = maybe('dirAreaCategory');
  if (category) category.addEventListener('change', renderCategoryImpact);

  el('dirReflection').addEventListener('input', event => markDirty(event.target));
  el('dirProposals').addEventListener('click', onProposalClick);
  el('dirReviewSave').addEventListener('click', saveReviewOnce);

  // --- Suunta 2 ---
  const on = (id, type, handler) => { const node = maybe(id); if (node) node.addEventListener(type, handler); };
  // Ajanseuranta kysyy alueen ennen käynnistystä (F6); "Ei aluetta" on sallittu.
  on('dirStartTimer', 'click', () => openTimerChooser());
  on('dirQuickLog', 'click', () => openGeneralLog());
  on('dirOpenEstimate', 'click', () => openWorkflow('estimate'));
  on('dirOpenUnassigned', 'click', () => openWorkflow('assign'));
  on('dirTimePresets', 'click', event => {
    const preset = event.target.closest('[data-preset-minutes]');
    if (preset) el('dirTimeMinutes').value = preset.dataset.presetMinutes;
  });
  on('dirWeekSummary', 'click', onFailedEntriesClick);
  on('dirEstimate', 'click', onEstimateClick);
  for (const type of ['change', 'input', 'keydown']) on('dirEstimate', type, event => handleQueueEvent(type, event));
  on('dirUnassigned', 'change', onAssignChange);
  on('dirUnassigned', 'click', onAssignClick);
  on('dirUnassigned', 'click', event => {
    // "Luo ensin elämänalue" (F3): sama toimenpide kuin laatulistassa.
    const button = event.target.closest('[data-quality-action]');
    if (button) onQualityAction(button.dataset.qualityAction);
  });
  initDirectionSetup({ rerender: renderDirection, queueEvent: handleQueueEvent });
  on('dirQuality', 'click', event => {
    const button = event.target.closest('[data-quality-action]');
    if (button) onQualityAction(button.dataset.qualityAction);
  });
  on('dirSignals', 'click', event => {
    // Harvan arvioaineiston ilmoituksen toimenpide ("Arvioi tehtäviä").
    const quality = event.target.closest('[data-quality-action]');
    if (quality) {
      onQualityAction(quality.dataset.qualityAction);
      return;
    }
    const button = event.target.closest('[data-explain]');
    if (!button) return;
    button.disabled = true;
    button.textContent = 'Haetaan selitystä…';
    onExplain(button.dataset.explain);
  });
  on('dirProposals', 'change', event => {
    const box = event.target.closest('[data-adjust-select]');
    if (!box) return;
    if (box.checked) selectedProposalIds.add(box.dataset.adjustSelect);
    else selectedProposalIds.delete(box.dataset.adjustSelect);
    // Valinnan muutos mitätöi esikatselun: vahvistettava on se mikä esikatseltiin.
    lastPreview = null;
    const preview = maybe('dirProposalPreview');
    if (preview) preview.innerHTML = '';
    const apply = maybe('dirApplySelected');
    if (apply) apply.disabled = true;
  });
  on('dirPreviewSelected', 'click', onPreviewSelected);
  on('dirApplySelected', 'click', onApplySelected);
  on('dirTrends', 'click', event => {
    if (event.target.closest('[data-show-trends]')) {
      trendsRequested = true;
      renderDirection();
    }
  });
  on('dirReflectionPrompts', 'input', event => markDirty(event.target));

  const today = maybe('todayDirection');
  if (today) {
    today.addEventListener('click', event => {
      if (event.target.closest('[data-open-setup]')) {
        switchTab('screen-direction');
        openDirectionSetup();
        return;
      }
      if (event.target.closest('[data-open-direction]')) {
        switchTab('screen-direction');
        return;
      }
      const action = event.target.closest('[data-today-action]');
      if (!action) return;
      switch (action.dataset.todayAction) {
        case 'log_time': openGeneralLog(); break;
        case 'open_unassigned': switchTab('screen-direction'); openWorkflow('assign'); break;
        case 'open_estimate': openEstimateQueue(); break;
        default: switchTab('screen-direction');
      }
    });
  }
}

/** Uloskirjautuminen: näkymän oma tila pois. */
export function resetDirectionView() {
  viewGeneration += 1;
  viewWeek = null;
  pinnedByDraft = false;
  editingAreaId = null;
  shownProposals = [];
  selectedProposalIds = new Set();
  lastPreview = null;
  estimateOpen = false;
  estimateMode = 'duration';
  estimateQueue = null;
  timeListUnassignedOnly = false;
  resetDirectionSetup();
  unassignedOpen = false;
  skippedUnassigned = new Set();
  explanations = new Map();
  explainsInFlight = new Set();
  lastAnalysis = null;
  trendsRequested = false;
  renderedWeek = null;
  // Kesken jäänyt kirjaus on uusi kirjaus seuraavalle käyttäjälle.
  timeFormOperation = null;
  // Kentät tyhjiksi: seuraava käyttäjä ei näe edellisen tekstiä, eikä
  // voi tallentaa sitä omaan katsaukseensa (RACE-14, F15). Kentät ovat
  // index.html:ssä pysyviä, joten tila ei nollaudu itsestään.
  if (typeof document !== 'undefined') {
    const fields = [
      'dirReflection', 'dirTimeNote', 'dirTimeMinutes', 'dirTimeDate', 'dirTimeArea',
      ...CAPACITY_FIELDS, ...REFLECTION_CODES.map(code => `dirAnswer-${code}`)
    ];
    for (const id of fields) {
      const field = maybe(id);
      if (field) { field.value = ''; delete field.dataset.dirty; }
    }
    for (const id of ['dirTimeDateError', 'dirTimeMinutesError', 'dirCapacityError', 'dirEnergyBudgetError']) {
      setError(id, '');
    }
    setText('dirCapacityWarning', '');
    setText('dirReviewStatus', '');
  }
}
