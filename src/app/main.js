// Sovelluksen käynnistys.
//
// Tämä on ainoa tiedosto, jonka index.html lataa. Se kytkee kerrokset
// yhteen mutta ei sisällä liiketoimintalogiikkaa itse.
//
// Elinkaari:
//   1. kytke tapahtumat kerran (init*)
//   2. tilaa tilamuutokset -> näkymät päivittyvät automaattisesti
//   3. palauta istunto
//        - kirjautunut   -> lataa data, näytä sovellus
//        - kirjautumaton -> näytä kirjautumisportti

import { getDevicePreference, clearDevicePreferences } from '../data/preferences.js';
import { subscribe, resetState, resetDatesToToday, getState, batch } from './state.js';
import { loadUserData, clearLocalUserData } from './actions.js';
import { renderTimerBar, initTimeLog, closeTimeLogDialog } from './views/timeLog.js';
import { restoreLocalTimer, initTimerCrossTabSync, stopTimerCrossTabSync, resetTimerSync } from './timerState.js';
import {
  flushTimeOutbox, retryTimeOutbox, pendingTimeEntryCount, beginDataLoad, keepWritesSince,
  resetAlignmentSession
} from './alignment.js';
import { createReconnectController, REFRESH_REASON } from './reconnect.js';
import { initAuth, showAuthGate, hideAuthGate } from './auth.js';
import {
  initNavigation, restoreLastScreen, setScreenRenderers, markScreensDirty, renderVisible,
  renderEveryScreen, forgetRenderedScreens
} from './navigation.js';
import { initVoice, resetVoice } from './voice.js';
import { initSearch, closeSearch } from './search.js';
import { initOnboarding, maybeShowOnboarding } from './onboarding.js';
import { renderToday, initTodayNavigation } from './views/today.js';
import { resetTodayDailyLife } from './views/todayDailyLife.js';
import { renderWeek, initWeekNavigation } from './views/week.js';
import { initCalendar, renderCalendar, resetCalendarView } from './views/calendar.js';
import { renderTasks, initTaskForm, closeForm } from './views/tasks.js';
import { initRoutineForm, closeRoutineForm } from './views/routines.js';
import { renderGoals, initGoalForm, closeGoalForm, refreshGoalPicker } from './views/goals.js';
import { renderProjects, initProjectForm, closeProjectForm } from './views/projects.js';
import {
  renderFinance, initFinanceForms,
  closeBillForm, closeExpenseForm, closeSavingsForm, closeSavingsTransferForm
} from './views/finance.js';
import {
  initTransactionForms, resetTransactionViews
} from './views/transactions.js';
import { initInvestmentForms, closeInvestmentForm } from './views/investments.js';
import { initGoalDetail, closeMilestoneForm } from './views/goalDetail.js';
import { initPlanning, resetPlanning } from './views/planning.js';
import { clearIdempotencyKeys } from './planning.js';
import { renderProfile, initProfileForm, fillProfileForm } from './views/profile.js';
import { renderNotificationSettings } from './views/notificationSettings.js';
// Arjen käyttöjärjestelmä (aalto K): profiilin osiot ja niiden näkymät.
import { renderProfileSegments, initProfileSegments } from './views/profileSegments.js';
import { renderDailySettings, initDailySettings, resetDailySettings } from './views/dailySettings.js';
import { renderGuidanceSettings, initGuidanceSettings, resetGuidanceSettings } from './views/guidanceSettings.js';
import { renderWellbeingHub, initWellbeingHub, resetWellbeingHub } from './views/wellbeingHub.js';
import { renderPlacesSettings, initPlacesSettings, resetPlacesSettings } from './views/placesSettings.js';
import { runEventDepartureSweep, resetDepartureWatch } from './departureWatch.js';
import { runDailyLifeNotices } from './dailyLifeNotices.js';
import { resetDailyLifeActions } from './dailyLifeActions.js';
// Arjen herätykset, laitteen kuittaukset ja lähtökori (aalto K, rooli W).
import {
  activateAlarmSync, resetAlarmSync, syncAlarms, scheduleAlarmSync, alarmRelevantChanged, alarmDayRolled
} from './alarmSync.js';
import {
  activateAlarmEvents, consumeAlarmEvents, resetAlarmEvents, acknowledgeRecordedDepartures
} from './alarmEvents.js';
import {
  activateDailyLifeOutbox, deactivateDailyLifeOutbox, replayDailyLifeOutbox, overlayDailyLifeOutbox,
  dailyLifeOutboxStatus
} from './dailyLifeOutbox.js';
import { initInbox, closeCaptureReview, renderInbox } from './views/inbox.js';
import { initReminderForm, closeReminderForm } from './views/reminders.js';
import { initTravelForms, closeTravelForm, closeLocationRuleForm }
  from './views/travel.js';
import { renderNotices, initNotices, closeNoticeCenter } from './views/notices.js';
import {
  renderDirection, renderTodayDirection, initDirection, closeAreaForm, resetDirectionView
} from './views/direction.js';
import { resetAppliedAdjustments } from './alignment.js';
import {
  runReminderSweep, runDepartureSweep, pruneNoticeHistory, runReplanCheck
} from './assistantActions.js';
import {
  refreshNotificationPermission, syncNotifications,
  scheduleNotificationResync, cancelScheduledResync, cancelDeviceNotifications
} from './notifications.js';
import { lifecycle, location as platformLocation, speech } from '../platform/index.js';
import { logFailure, LOG_LEVEL } from '../lib/logger.js';
import { clearToasts } from '../ui/toast.js';
import { closeConfirmDialogs } from '../ui/confirm.js';
import { maybe } from '../ui/dom.js';
import { getUser, sessionSnapshot, isSameSession } from '../data/session.js';
import { offline, setSyncedHandler, isOnlineNow } from './offline.js';
import { initOfflineStatus, refreshSyncStatus } from './offlineStatus.js';
import { ensureSchemaCompatibility, SCHEMA_PROBE_TIMEOUT_MS } from '../data/schemaProbe.js';
import { initSchemaStatus, setSchemaStatusActive } from './schemaStatus.js';
import { installGlobalErrorHandlers, showStartupFailure } from './globalErrors.js';

/** Kuinka usein NYT-tila päivitetään ilman sivun uudelleenlatausta. */
const NOW_REFRESH_MS = 30000;

/** Ensimmäinen lataus epäonnistui verkossa ollessa: yksi uusi yritys näin pian. */
const FIRST_LOAD_RETRY_MS = 10000;

let signedIn = false;

/**
 * Odottavien muutosten lähetys käynnissä (kirjautuminen tai verkon
 * palautuminen). Sillä aikaa synkronoinnin jälkeistä latausta
 * (setSyncedHandler) ei tehdä erikseen: kutsuja lataa kerran lähetyksen
 * jälkeen. Laskuri, koska kaksi lähetystä voi olla käynnissä yhtä aikaa.
 */
let sendingPending = 0;

/**
 * LÄHETÄ ENSIN, LATAA VASTA SITTEN: lataus korvaisi muuten paikallisen tilan
 * ennen kuin odottavat offline-muutokset ovat lähteneet (overlay kattaa
 * näkymän, mutta palvelimen tila on oikea vasta lähetyksen jälkeen).
 *
 * Odottaa myös toisen käynnistämän toiston ja lähetyksen loppuun
 * (waitForCurrent, flushTimeOutbox on yksi kerrallaan): muuten lataus
 * saattoi alkaa, kun edellinen lähetys oli vielä kesken (F11).
 */
async function sendPending() {
  sendingPending += 1;
  try {
    await offline.replay({ waitForCurrent: true });
    // Suunnan lähettämättömät aikakirjaukset (vain aikakirjaukset; uusinta
    // on idempotentti operaatiotunnisteen ansiosta).
    await flushTimeOutbox();
    // Arjen lähtökori (menot, tapakirjaukset): sama periaate, yksi lähetys kerrallaan.
    await replayDailyLifeOutbox();
  } catch (error) {
    logFailure('offline.replay_failed', error);
  } finally {
    sendingPending -= 1;
  }
}

/**
 * Lataa käyttäjän data. Latauksen aikana valmistuneet tallennukset
 * palautetaan tilaan (keepWritesSince): ennen lähetystä haettu lista ei
 * piilota juuri lähetettyä aikakirjausta, katsausta tai kapasiteettia.
 *
 * EI KIRJAA päivityksen alkua ohjaimelle: alku kirjataan ennen
 * lähetysvaihetta (ohjaimen oma runRefresh, onSignedIn, synkronoinnin
 * jälkeinen lataus). Latauksen alussa kirjattu alku sai lähetyksen aikana
 * palanneen verkon näyttämään katetulta, eikä jonoa lähetetty uudelleen.
 */
async function loadFresh() {
  const mark = beginDataLoad();
  const result = await loadUserData();
  // Palautetut tallennukset yhtenä ilmoituksena (loadUserData on jo yksi).
  // Lähtökorin odottavat menot ja kirjaukset pysyvät näkyvissä latauksen yli.
  if (!result.discarded) batch(() => { keepWritesSince(mark); overlayDailyLifeOutbox(); });
  return result;
}

/** Jäikö jokin kokoelma lataamatta (dataLoadStatus)? */
function hasLoadFailures() {
  return Object.values(getState().dataLoadStatus || {}).some(status => status && status.ok === false);
}

/**
 * Päivitä data verkon palautuessa tai sovelluksen palatessa etualalle.
 *
 * EI KUTSU renderAll():ia SUORAAN. loadUserData() kirjoittaa uudet
 * kokoelmat tilaan setX()-toiminnoilla, ja tila on tilattu (subscribe)
 * jo käynnistyksessä — sama automaattinen renderöinti joka tapahtuu
 * kirjautuessa hoitaa myös tämän, eikä näytä tai käyttäjän sijaintia
 * näkymässä tarvitse koskea erikseen.
 */
async function refreshAfterReconnect() {
  if (!signedIn) return;
  const session = sessionSnapshot();
  // Offline-käynnistyksessä skeemaa ei tarkistettu: tarkista ennen toistoa,
  // jotta jono ja lähtökori eivät lähde kannalle, joka on käännöstä jäljessä.
  try {
    await ensureSchemaCompatibility({ onlyIfUnverified: true, timeoutMs: SCHEMA_PROBE_TIMEOUT_MS });
  } catch (error) {
    logFailure('schema.check_failed', error);
  }
  if (!signedIn || !isSameSession(session)) return;
  await sendPending();
  // Uloskirjautuminen lähetyksen aikana: ei ladata kenenkään nimissä.
  if (!signedIn || !isSameSession(session)) return;
  const result = await loadFresh();
  if (result.discarded) return;
  runAssistantSweeps();
}

// Offline-tilassa käynnistynyt sovellus: ensimmäinen "online" käynnistää
// lähetyksen ja latauksen (F7). Ennen tätä ohjain luuli olleensa verkossa.
const reconnect = createReconnectController({ onRefresh: refreshAfterReconnect, initialOnline: isOnlineNow() });

/**
 * Rekisteröi service worker.
 *
 * Ei koskaan kaada sovellusta: jos rekisteröinti epäonnistuu (ei HTTPS:ää,
 * selain ei tue, käyttäjä estänyt), sovellus toimii normaalisti ilman
 * offline-tukea.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Rekisteröinti odottaa load-tapahtumaa, jottei se kilpaile sovelluksen
  // omien latausten kanssa.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(error => {
      logFailure('sw.register_failed', error);
    });
  });
}

/**
 * Näyttöjen piirtäjät. Näyttö piirretään vain näkyvänä (renderAll) tai
 * juuri ennen näyttämistä (navigation.js switchTab) — ei jokaisesta
 * tilamuutoksesta piilossa (CRIT-01).
 *
 * Ryhmässä on kaikki, mitä näytön DOM:issa näkyy, myös toisen moduulin
 * täyttämä osa: tehtävälomakkeen tavoitevalikko (refreshGoalPicker) ja
 * päivänäkymän kirjauksen tarkistuskortti (renderInbox).
 */
const SCREEN_RENDERERS = Object.freeze({
  'screen-today': () => { renderToday(); renderInbox(); renderNotices(); },
  'screen-direction': () => { renderDirection(); },
  'screen-week': () => { renderWeek(); renderCalendar(); },
  'screen-tasks': () => { renderTasks(); refreshGoalPicker(); },
  'screen-goals': () => { renderGoals(); renderProjects(); },
  'screen-finance': () => { renderFinance(); },
  'screen-profile': () => {
    renderProfileSegments(); renderProfile(); renderNotificationSettings();
    renderDailySettings(); renderGuidanceSettings();
    renderWellbeingHub(maybe('profileWellbeingSection')); renderPlacesSettings(maybe('profilePlacesSection'));
  }
});

/** Joka tilamuutoksessa: ajastinpalkki ja päivän Suunta-kortti (kevyt, välimuistista). */
const ALWAYS_RENDERED = Object.freeze([renderTimerBar, renderTodayDirection]);

/**
 * Piirrä tilamuutoksen jälkeen. Kutsutaan tilamuutoksesta (subscribe).
 *
 * VAIN NÄKYVÄ PIIRRETÄÄN HETI: ajastinpalkki, päivän Suunta-kortti ja avoin
 * näyttö (navigation.js renderVisible). Muut merkitään likaisiksi, ja
 * switchTab piirtää likaisen näytön ennen kuin näyttää sen. Aiemmin jokainen
 * tilamuutos piirsi kaikki näytöt, myös piilossa olevan Suunnan
 * viikkoanalyyseineen (CRIT-01).
 */
function renderAll() {
  if (!signedIn) return;
  renderVisible();
}

/**
 * Viimeksi nähdyt viittaukset ajastukseen vaikuttaviin kokoelmiin.
 *
 * Viittausvertailu (ei syväkopiointi) riittää: jokainen tilaa muuttava
 * toiminto (src/app/actions.js) korvaa taulukon uudella, koskaan ei
 * mutatoida paikallaan. Sama viittaus tarkoittaa siis varmasti samaa
 * sisältöä.
 */
let lastNotifiableRefs = { tasks: null, routines: null, routineExceptions: null, travelPlans: null };

/**
 * Pyydä muistutusten uudelleensynkronointi, kun ajastukseen vaikuttava
 * tila muuttuu.
 *
 * TÄMÄ ON AINOA PAIKKA JOKA VAHTII SITÄ. Ilman tätä laitteelle ajastetut
 * ilmoitukset synkronoituisivat vain kirjautuessa, ja tehtävän muokkaus
 * tai poisto kesken istunnon jättäisi vanhentuneen ilmoituksen elämään
 * laitteelle seuraavaan kirjautumiseen asti.
 */
function watchNotifiableChanges() {
  if (!signedIn) return;
  const state = getState();
  const changed = state.tasks !== lastNotifiableRefs.tasks
    || state.routines !== lastNotifiableRefs.routines
    || state.routineExceptions !== lastNotifiableRefs.routineExceptions
    // Matkasuunnitelman muutos siirtää lähtömuistutuksen aikaa: sama
    // tunniste, uusi aika -> uudelleenajastus korvaa vanhan.
    || state.travelPlans !== lastNotifiableRefs.travelPlans;

  lastNotifiableRefs = {
    tasks: state.tasks,
    routines: state.routines,
    routineExceptions: state.routineExceptions,
    travelPlans: state.travelPlans
  };

  if (changed) scheduleNotificationResync();
}

/**
 * Muistutus-, lahto- ja karsintakierros.
 *
 * EI KAADA MITAAN. Verkkovirhe halytyskierroksella ei saa estaa
 * sovelluksen kayttoa: kierros yritetaan uudelleen kolmenkymmenen
 * sekunnin paasta, ja siihen asti kayttoliittyma toimii normaalisti.
 */
// ================================================================
// ARJEN HERÄTYKSET, LAITTEEN KUITTAUKSET JA LÄHTÖKORI (aalto K, rooli W)
// ================================================================
//
// Kaikki laitteelle menevä (herätykset, puhutut muistutukset) lasketaan
// src/app/alarmSync.js:ssä; tavalliset ilmoitukset ajastaa edelleen
// notifications.js samasta jaosta. Näiden kytkentä on koottu tähän:
//   kirjautuminen  -> startDailyLifeDevice (kori, kuittausmuisti, ajastus sallittu)
//   latauksen jälkeen ja etualalle palatessa -> refreshDailyLifeDevice
//                    (laitteen kuittaukset ENSIN, sitten ajastus)
//   tilamuutos     -> watchDailyLifeChanges (viive 2 s, sama kuin muistutuksissa)
//   kellon tikki   -> päivän vaihtuessa uusi päivä ajastetaan
//   uloskirjautuminen -> stopDailyLifeDevice (laitteen herätykset perutaan)

/** Herätykset ja tavalliset muistutukset uudelleen (viiveellä, peräkkäiset yhdistyvät). */
function requestDailyLifeResync() {
  scheduleAlarmSync();
  scheduleNotificationResync();
}

/** Kirjautuminen: käyttäjän lähtökori ja kuittausmuisti käyttöön. */
function startDailyLifeDevice(userId) {
  activateDailyLifeOutbox(userId);
  activateAlarmSync(userId);
  activateAlarmEvents(userId, { changed: requestDailyLifeResync });
}

/** Laitteen kuittaukset ensin, sitten ajastus: kuitattua ei ajasteta uudelleen. */
async function refreshDailyLifeDevice() {
  await consumeAlarmEvents();
  if (!signedIn) return;
  await syncAlarms();
}

/**
 * Tilamuutos, joka voi siirtää herätystä tai arjen muistutusta. Sovelluksessa
 * kirjattu lähtö ("Lähdin nyt") kuittaa saman menon lähtöketjun ennen
 * uudelleenajastusta: lähteneelle ei soi "Lähde nyt".
 */
function watchDailyLifeChanges() {
  if (!signedIn) return;
  const state = getState();
  if (!alarmRelevantChanged(state)) return;
  acknowledgeRecordedDepartures(state.commuteObservations);
  requestDailyLifeResync();
}

/** Uloskirjautuminen: laitteen herätykset pois, kuittausmuisti pois, kori muistista. */
function stopDailyLifeDevice() {
  resetAlarmSync().catch(() => {});
  resetAlarmEvents();
  deactivateDailyLifeOutbox();
}

function runAssistantSweeps() {
  Promise.all([
    runReminderSweep(),
    runDepartureSweep(),
    // Kalenterin menojen lähdöt ja arjen huomautukset (aalto K).
    runEventDepartureSweep(),
    runDailyLifeNotices(),
    runReplanCheck(),
    pruneNoticeHistory()
  ]).catch(error => {
    logFailure('assistant.sweep_failed', error);
  });
}

async function onSignedIn() {
  signedIn = true;
  const session = sessionSnapshot();
  hideAuthGate();

  // Käyttäjän oma odottava jono ladataan ENNEN ensimmäistä latausta, jotta
  // sen muutokset näkyvät heti (overlay) eikä toisen käyttäjän jono
  // koskaan osu tähän (avain on käyttäjäkohtainen).
  const current = getUser();
  offline.activate(current && current.id ? current.id : null);
  // Arjen lähtökori ja laitteen kuittausmuisti samalla periaatteella (rooli W).
  startDailyLifeDevice(current && current.id ? String(current.id) : null);

  // Käyttäjän oma ajastin laitteelta ENNEN latausta: uudelleenlataus ei
  // hukkaa kulunutta aikaa, eikä toisen käyttäjän ajastin osu tähän
  // (avain ja sisältö ovat käyttäjäkohtaisia).
  restoreLocalTimer();
  // Toisen välilehden käynnistys ja pysäytys näkyvät tässäkin heti: kaksi
  // välilehteä ei käynnistä rinnakkaisia ajastimia eikä pyyhi toistensa kopiota.
  initTimerCrossTabSync();

  // SKEEMATARKISTUS ENNEN ENSIMMÄISTÄ LATAUSTA: vain lukeva, aikarajattu,
  // offline-tilassa ei yhtään pyyntöä (välimuisti tai käännösaikaiset
  // portit). Jos kanta on sovellusta jäljessä, portit lasketaan ennen kuin
  // mitään kirjoitetaan. Ks. src/data/schemaProbe.js.
  setSchemaStatusActive(true);
  const probeSession = sessionSnapshot();
  await ensureSchemaCompatibility({ timeoutMs: SCHEMA_PROBE_TIMEOUT_MS });
  if (!signedIn || !isSameSession(probeSession)) return;

  // Päivä, viikko ja Kalenterin päivä nollataan kirjautuessa: sovellus
  // avautuu aina tähän päivään, ei siihen mihin edellinen istunto jäi
  // (ks. state.js resetDatesToToday: Kalenterin päivä jäi aiemmin pois).
  resetDatesToToday();

  restoreLastScreen(getDevicePreference('lastScreen'));

  // Kirjautumisen aikana odottaneet muutokset lähetetään ENNEN ensimmäistä
  // latausta (F11). Aiemmin lataus ja lähetys kulkivat rinnakkain: ennen
  // lähetystä haettu lista korvasi tilan, ja juuri lähetetty kirjaus katosi
  // näkyvistä seuraavaan lataukseen asti. Tyhjällä jonolla ei odoteta.
  //
  // Täysi päivitys alkaa TÄSTÄ, lähetysvaiheesta (CRIT-02): paluu etualalle
  // heti perään ei lataa uudelleen, mutta lähetyksen aikana palannut verkko
  // ajaa vielä oman kierroksensa.
  reconnect.noteRefreshStarted();
  if (offline.status().total > 0 || pendingTimeEntryCount() > 0 || dailyLifeOutboxStatus().total > 0) {
    await sendPending();
  }
  if (!isSameSession(session)) return;

  // Lataus voi kestää, ja käyttäjä ehtii sinä aikana kirjautua ulos tai
  // vaihtaa tiliä. Silloin loadUserData hylkää vastauksen — eikä tämän
  // kirjautumisen jatko saa enää piirtää eikä ajastaa mitään. Toinen,
  // uudempi onSignedIn on jo ottanut vastuun näkymästä.
  const loaded = await loadFresh();
  if (loaded.discarded) return;

  // Ensimmäinen lataus epäonnistui, vaikka laite on verkossa (esim.
  // hetkellinen palvelinvirhe): yksi uusi yritys hetken päästä. Ilman tätä
  // näkymä jäi vajaaksi seuraavaan paluuseen tai verkkotapahtumaan asti.
  if (isOnlineNow() && hasLoadFailures()) reconnect.refreshLater(FIRST_LOAD_RETRY_MS);

  fillProfileForm();

  // Lupatila luetaan ENNEN ensimmäistä renderöintiä, jotta asetusnäkymä
  // kertoo heti totuuden. Tämä EI pyydä lupaa — se vain kysyy nykyisen
  // tilan, joka natiivikuoressa on luettavissa vain asynkronisesti.
  await refreshNotificationPermission();

  renderEveryScreen();

  // Muistutukset synkronoidaan vasta kun data on ladattu. Jos käyttäjä ei
  // ole kytkenyt niitä päälle, tämä peruu aiemmin ajastetut eikä tee muuta.
  syncNotifications().catch(error => {
    logFailure('notifications.sync_failed', error);
  });

  // HALYTYSKIERROS AJETAAN KUN SOVELLUS ON AUKI.
  //
  // Tama EI OLE AJASTIN suljetulle sovellukselle. Taustaheratysta ei
  // ole eika sita voi luvata ilman laitehyvaksyntaa. Kierros on siksi
  // tassa: kirjautumisen jalkeen ja `NOW_REFRESH_MS` valein.
  //
  // Kaksoiskappaleiden esto on kolminkertainen (istunnon avaimet,
  // tilan avaintarkistus, kannan `notices_key_unique`), joten kierros
  // voidaan ajaa niin usein kuin halutaan.
  runAssistantSweeps();

  // Herätykset ja puhutut muistutukset laitteelle, kun data on ladattu
  // (rooli W). Selaimessa tämä ei ajasta mitään: herätystä ei teeskennellä.
  refreshDailyLifeDevice().catch(error => {
    logFailure('alarm.refresh_failed', error);
  });

  maybeShowOnboarding();
}

function onSignedOut() {
  signedIn = false;
  setSchemaStatusActive(false);
  cancelScheduledResync();
  // Laitteelle ajastetut ja jo toimitetut muistutukset (tehtävien otsikot)
  // eivät saa laueta uloskirjautumisen jälkeen. Ei odoteta: uloskirjautuminen
  // ei saa jäädä natiivikutsun varaan, ja funktio ei koskaan heitä.
  cancelDeviceNotifications().catch(() => {});
  reconnect.cancelPending();
  lastNotifiableRefs = { tasks: null, routines: null, routineExceptions: null, travelPlans: null };
  // Seuraavan istunnon ensimmäinen piirto ei luota edellisen piirtoihin.
  forgetRenderedScreens();
  closeForm();
  closeRoutineForm();
  closeGoalForm();
  closeProjectForm();
  closeBillForm();
  closeExpenseForm();
  closeSavingsForm();
  closeSavingsTransferForm();
  closeInvestmentForm();
  closeMilestoneForm();
  closeReminderForm();
  closeTravelForm();
  closeLocationRuleForm();

  // Kesken oleva kirjaus ja ilmoituskeskuksen tila eivat saa vuotaa
  // seuraavalle kayttajalle samalla selaimella. Kirjauskentta voi
  // sisaltaa mita tahansa, mita edellinen kayttaja oli kirjoittamassa.
  closeCaptureReview();
  closeNoticeCenter();
  closeSearch();
  // Puhepaneelin tarkistettava sanelu säilyy piilotuksen yli; seuraava
  // käyttäjä ei saa nähdä sitä eikä lähettää sitä omilla tunnuksillaan.
  resetVoice();

  // Muistissa oleva sijainti unohtuu uloskirjautuessa (ei koskaan levylle).
  platformLocation.forget();

  // Offline-jono vapautetaan muistista; tallennus säilyy käyttäjäkohtaisella
  // avaimella eikä koskaan lähetetä toisen käyttäjän tilillä.
  offline.deactivate();
  // Laitteen herätykset ja puhutut muistutukset perutaan, kuittausmuisti
  // tyhjennetään ja arjen lähtökori vapautetaan muistista (rooli W).
  stopDailyLifeDevice();

  // Nollaa myös kesken olevan kuvan luennan ja tyhjentää
  // tiedostovalitsimen. Seuraava käyttäjä samalla selaimella ei saa
  // löytää edellisen kuittia mistään.
  resetTransactionViews();

  // Suunnittelu: tyhjentää tavoitetekstin ja idempotenssiavaimet.
  // Avain viittaa ehdotukseen, joka ei sekään elä uloskirjautumisen
  // yli — jäänyt avain estäisi seuraavaa käyttäjää tallentamasta.
  resetPlanning();
  // Arjen näkymien luonnokset ja muistissa olevat lähdöt eivät vuoda
  // seuraavalle käyttäjälle.
  resetDailySettings();
  resetGuidanceSettings();
  resetWellbeingHub();
  resetPlacesSettings();
  resetDepartureWatch();
  resetDailyLifeActions();
  // Tänään-korttien avoin valitsin, keskeytyksen esikatselu ja aamuvalinta.
  resetTodayDailyLife();
  closeAreaForm();
  closeTimeLogDialog();
  stopTimerCrossTabSync();
  // Edellisen käyttäjän avoin vahvistus (esim. "Pysäytetäänkö ja
  // kirjataanko ...") ei jää kirjautumisportin päälle, eikä sen myöhempi
  // hyväksyntä käynnistä mitään uudessa istunnossa (RACE-14).
  closeConfirmDialogs();
  // Ajastimen kannan kirjoitusjono alusta: edellisen käyttäjän jonotetut
  // työt eivät lähde seuraavan tokenilla (ne ohitetaan), eikä jumiin
  // jäänyt pyyntö pidättele seuraavan käyttäjän kirjoituksia.
  resetTimerSync();
  resetDirectionView();
  resetCalendarView();
  resetAppliedAdjustments();
  resetAlignmentSession();
  clearIdempotencyKeys();
  clearToasts();

  // Tyhjentää myös repositorioiden muistivarastot. Ilman tätä seuraava
  // käyttäjä näkisi edellisen rutiinit ja tavoitteet samalla selaimella.
  clearLocalUserData();
  clearDevicePreferences();
  resetState();
  // Profiilin kentät (ikä, paino, pituus, uni) kirjoittaa vain
  // fillProfileForm, ja kirjautuessa vasta latauksen jälkeen. Nollatusta
  // tilasta täytetty lomake on oletuksissa: seuraava käyttäjä ei näe
  // edellisen terveystietoja, eikä "Tallenna" kirjoita niitä hänelle.
  fillProfileForm();
  showAuthGate();
}

async function start() {
  // 0. Odottamaton virhe (käsittelemätön lupaus, poikkeus) näkyy käyttäjälle
  //    yhtenä kiinteänä viestinä eikä kaadu hiljaa (src/app/globalErrors.js).
  installGlobalErrorHandlers();

  // 1. Tapahtumakytkennät tehdään TASAN KERRAN. Näkymien uudelleenrenderöinti
  //    korvaa vain listojen sisällön, joten kuuntelijat eivät kasaannu.
  initNavigation();
  initTodayNavigation();
  initWeekNavigation();
  initCalendar();
  initTaskForm();
  initRoutineForm();
  initGoalForm();
  initProjectForm();
  initFinanceForms();
  initTransactionForms();
  initInvestmentForms();
  initGoalDetail();
  initPlanning();
  initProfileForm();
  initProfileSegments();
  initDailySettings();
  initGuidanceSettings();
  initWellbeingHub(maybe('profileWellbeingSection'));
  initPlacesSettings(maybe('profilePlacesSection'));
  initInbox();
  initReminderForm();
  initTravelForms();
  initNotices();
  initDirection();
  initTimeLog();
  initVoice();
  initSearch();
  initOnboarding();

  // 2. Näkymät seuraavat tilaa: avoin näyttö heti, muut ennen näyttämistä.
  setScreenRenderers(SCREEN_RENDERERS, { always: ALWAYS_RENDERED, enabled: () => signedIn });
  subscribe(renderAll);
  subscribe(watchNotifiableChanges);
  // Herätyksiin ja arjen muistutuksiin vaikuttavat kokoelmat (rooli W).
  subscribe(watchDailyLifeChanges);
  // Skeematarkistuksen tila (rajoitettu / huoltokatko) ENNEN istunnon
  // palautusta: palautettu istunto ajaa tarkistuksen jo initAuthin aikana.
  // Palautuminen lähettää odottavat muutokset ja lataa tiedot samalla
  // polulla kuin verkon palautuminen. Kannan tukea odottaneet osat
  // herätetään ENSIN: muuten ne lähtisivät vasta odotusajan (60 s) jälkeen.
  initSchemaStatus({
    onRecovered: () => {
      offline.wakeSchemaPending();
      reconnect.refreshNow({ reason: REFRESH_REASON.SCHEMA });
    }
  });

  // 3. Istunnon palautus.
  const session = await initAuth({ onSignedIn, onSignedOut });

  const splash = maybe('authSplash');
  if (splash) splash.classList.add('done');

  if (!session || !session.user) showAuthGate();

  // 4. NYT/MYÖHÄSSÄ/ETUAJASSA pysyy ajan tasalla ilman sivun päivitystä.
  setInterval(() => {
    if (!signedIn) return;
    // Aika kului: piilossa olevat näytöt (esim. "tänään"-korostus, rästit)
    // piirretään uudelleen, kun ne seuraavan kerran avataan.
    markScreensDirty();
    renderToday();
    runAssistantSweeps();
    // Päivä vaihtui sovelluksen ollessa auki: herätysten ja muistutusten
    // kolmen päivän ikkuna siirtyy (rooli W).
    if (alarmDayRolled()) requestDailyLifeResync();
    // Lähettämättömät aikakirjaukset uudelleen (F16): heikko kenttä tai
    // kirjautumissivu ei välttämättä koskaan laukaise offline/online-
    // tapahtumaa. Tyhjällä korilla ei tehdä mitään; epäonnistuminen
    // harventaa yrityksiä (retryTimeOutbox), eikä lähetyksiä ole rinnakkain.
    if (isOnlineNow()) {
      retryTimeOutbox().catch(error => {
        logFailure('alignment.time_outbox_retry_failed', error);
      });
    }
  }, NOW_REFRESH_MS);

  // Paluu etualalle: sama kolmikko kuin ajastimessa, mutta heti eikä
  // vasta seuraavassa NOW_REFRESH_MS-kierroksessa. Sovellus on voinut
  // olla taustalla kauemmin kuin yksi kierros, ja käyttäjä odottaa
  // ajantasaista tilaa heti kun hän palaa.
  //
  // KÄYTTÄÄ platform/lifecycle.js:ÄÄ EIKÄ OMAA visibilitychange-KUUNTELIJAA.
  // Natiivikuoressa `document.visibilitychange` ei ole luotettava korvike
  // käyttöjärjestelmän omalle resume/pause-tapahtumalle (ks. lifecycle.js:n
  // kommentti); web-kuori saa silti visibilitychange-varajärjestelmän, koska
  // bindLifecycle kytkee molemmat — ja yhdistää ne: yksi paluu on yksi
  // onResume-kutsu (lifecycle.js RESUME_DEDUP_MS).
  lifecycle.bind({
    onResume: () => {
      if (!signedIn) return;
      markScreensDirty();
      renderToday();
      runAssistantSweeps();
      syncNotifications().catch(error => {
        logFailure('notifications.resume_sync_failed', error);
      });
      // Sovelluksen ollessa kiinni kirjatut kuittaukset ja "Lähdin"-painallukset
      // ensin, sitten herätykset uudelleen (rooli W).
      refreshDailyLifeDevice().catch(error => {
        logFailure('alarm.resume_refresh_failed', error);
      });
      // Sovellus on voinut olla taustalla pitkään: data on voinut vanhentua
      // (esim. muokattu toisella laitteella). refreshNow() on limitelty
      // reconnect.js:ssä, joten tämä ei koskaan käynnisty rinnakkain
      // samanaikaisen online-palautuksen kanssa — eikä lataa uudelleen, jos
      // edellinen päivitys alkoi alle MIN_REFRESH_INTERVAL_MS sitten.
      reconnect.refreshNow({ reason: REFRESH_REASON.RESUME });
    },
    onPause: () => {
      reconnect.cancelPending();
      // EI TAUSTAMIKROFONIA: sovelluksen siirtyminen taustalle katkaisee
      // puheohjauksen ja sanelun kuuntelun. Natiivissa pause-tapahtuma tulee
      // App-liitännäiseltä myös silloin, kun visibilitychange ei laukea.
      // (Androidin oma lupadialogi ei katkaise: ks. src/platform/speech.js.)
      speech.cancelActiveListening({ reason: 'pause' });
    }
  });

  // 5. Service worker: sovelluskuori toimii offline.
  //    Rekisteröinti tehdään vasta käynnistyksen jälkeen, jottei se hidasta
  //    ensimmäistä maalausta. Epäonnistuminen ei ole virhe — sovellus toimii
  //    ilman sitäkin, vain ilman offline-tukea.
  registerServiceWorker();

  // Offline-jonon tila näkyviin, ja synkronoinnin jälkeinen uudelleenlataus.
  initOfflineStatus();
  setSyncedHandler(() => {
    if (!signedIn || sendingPending > 0) return;
    // Lähetys on jo tehty: täysi lataus alkaa nyt (CRIT-02). Ohjaimen oman
    // päivityksen aikana tämä ei tee mitään (reconnect.noteRefreshStarted).
    reconnect.noteRefreshStarted();
    loadFresh().catch(error => {
      logFailure('data.reload_after_sync_failed', error);
    });
  });

  // 6. Verkon tilan ilmaisu. Palvelinta vaativat toiminnot eivät saa
  //    valehdella onnistuneensa, joten offline-tila kerrotaan näkyvästi.
  const updateOnlineState = () => {
    const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    document.body.classList.toggle('is-offline', isOffline);
    const banner = maybe('offlineBanner');
    if (banner) banner.style.display = isOffline ? 'block' : 'none';
    refreshSyncStatus();
  };
  window.addEventListener('online', () => {
    updateOnlineState();
    reconnect.notifyOnline();
  });
  window.addEventListener('offline', () => {
    updateOnlineState();
    reconnect.notifyOffline();
  });
  updateOnlineState();
  // Kuuntelijat kytketään vasta istunnon palautuksen jälkeen: sillä välin
  // muuttunut verkon tila välitetään ohjaimelle nyt (F7). Offline -> online
  // käynnistyksen aikana ajastaa lähetyksen ja latauksen.
  if (isOnlineNow()) reconnect.notifyOnline();
  else reconnect.notifyOffline();
}

start().catch(error => {
  // Teksti riippuu verkosta ja alustasta: natiivissa ei ole sivua päivitettäväksi.
  showStartupFailure(error, { splash: maybe('authSplash') });
});
