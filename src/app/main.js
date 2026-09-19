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

import { todayMidnight, startOfWeek } from '../lib/datetime.js';
import { getDevicePreference, clearDevicePreferences } from '../data/preferences.js';
import { subscribe, resetState, setViewDate, setWeekStart, getState } from './state.js';
import { loadUserData, clearLocalUserData } from './actions.js';
import { createReconnectController } from './reconnect.js';
import { initAuth, showAuthGate, hideAuthGate } from './auth.js';
import { initNavigation, restoreLastScreen } from './navigation.js';
import { initVoice } from './voice.js';
import { initSearch, closeSearch } from './search.js';
import { initOnboarding, maybeShowOnboarding } from './onboarding.js';
import { renderToday, initTodayNavigation } from './views/today.js';
import { renderWeek, initWeekNavigation } from './views/week.js';
import { renderTasks, initTaskForm, closeForm } from './views/tasks.js';
import { initRoutineForm, closeRoutineForm } from './views/routines.js';
import { renderGoals, initGoalForm, closeGoalForm } from './views/goals.js';
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
import { initInbox, closeCaptureReview } from './views/inbox.js';
import { initReminderForm, closeReminderForm } from './views/reminders.js';
import { initTravelForms, closeTravelForm, closeLocationRuleForm }
  from './views/travel.js';
import { renderNotices, initNotices, closeNoticeCenter } from './views/notices.js';
import {
  runReminderSweep, runDepartureSweep, pruneNoticeHistory, runReplanCheck
} from './assistantActions.js';
import {
  refreshNotificationPermission, syncNotifications,
  scheduleNotificationResync, cancelScheduledResync
} from './notifications.js';
import { lifecycle, location as platformLocation } from '../platform/index.js';
import { clearToasts } from '../ui/toast.js';
import { maybe } from '../ui/dom.js';

/** Kuinka usein NYT-tila päivitetään ilman sivun uudelleenlatausta. */
const NOW_REFRESH_MS = 30000;

let signedIn = false;

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
  const result = await loadUserData();
  if (result.discarded) return;
  runAssistantSweeps();
}

const reconnect = createReconnectController({ onRefresh: refreshAfterReconnect });

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
      console.warn('Manifestival: service workerin rekisteröinti ei onnistunut', error);
    });
  });
}

/** Renderöi kaikki näkymät. Kutsutaan tilamuutoksesta. */
function renderAll() {
  if (!signedIn) return;
  renderToday();
  renderWeek();
  renderTasks();
  renderGoals();
  renderProjects();
  renderFinance();
  renderProfile();
  renderNotificationSettings();
  renderNotices();
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
function runAssistantSweeps() {
  Promise.all([
    runReminderSweep(),
    runDepartureSweep(),
    runReplanCheck(),
    pruneNoticeHistory()
  ]).catch(error => {
    console.warn('Manifestival: halytyskierros ei onnistunut', error);
  });
}

async function onSignedIn() {
  signedIn = true;
  hideAuthGate();

  // Päivä ja viikko nollataan kirjautuessa: sovellus avautuu aina tähän
  // päivään, ei siihen mihin edellinen istunto jäi.
  setViewDate(todayMidnight());
  setWeekStart(startOfWeek(todayMidnight()));

  restoreLastScreen(getDevicePreference('lastScreen'));

  // Lataus voi kestää, ja käyttäjä ehtii sinä aikana kirjautua ulos tai
  // vaihtaa tiliä. Silloin loadUserData hylkää vastauksen — eikä tämän
  // kirjautumisen jatko saa enää piirtää eikä ajastaa mitään. Toinen,
  // uudempi onSignedIn on jo ottanut vastuun näkymästä.
  const loaded = await loadUserData();
  if (loaded.discarded) return;

  fillProfileForm();

  // Lupatila luetaan ENNEN ensimmäistä renderöintiä, jotta asetusnäkymä
  // kertoo heti totuuden. Tämä EI pyydä lupaa — se vain kysyy nykyisen
  // tilan, joka natiivikuoressa on luettavissa vain asynkronisesti.
  await refreshNotificationPermission();

  renderAll();

  // Muistutukset synkronoidaan vasta kun data on ladattu. Jos käyttäjä ei
  // ole kytkenyt niitä päälle, tämä peruu aiemmin ajastetut eikä tee muuta.
  syncNotifications().catch(error => {
    console.warn('Manifestival: muistutusten synkronointi ei onnistunut', error);
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

  maybeShowOnboarding();
}

function onSignedOut() {
  signedIn = false;
  cancelScheduledResync();
  reconnect.cancelPending();
  lastNotifiableRefs = { tasks: null, routines: null, routineExceptions: null, travelPlans: null };
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

  // Muistissa oleva sijainti unohtuu uloskirjautuessa (ei koskaan levylle).
  platformLocation.forget();

  // Nollaa myös kesken olevan kuvan luennan ja tyhjentää
  // tiedostovalitsimen. Seuraava käyttäjä samalla selaimella ei saa
  // löytää edellisen kuittia mistään.
  resetTransactionViews();

  // Suunnittelu: tyhjentää tavoitetekstin ja idempotenssiavaimet.
  // Avain viittaa ehdotukseen, joka ei sekään elä uloskirjautumisen
  // yli — jäänyt avain estäisi seuraavaa käyttäjää tallentamasta.
  resetPlanning();
  clearIdempotencyKeys();
  clearToasts();

  // Tyhjentää myös repositorioiden muistivarastot. Ilman tätä seuraava
  // käyttäjä näkisi edellisen rutiinit ja tavoitteet samalla selaimella.
  clearLocalUserData();
  clearDevicePreferences();
  resetState();
  showAuthGate();
}

async function start() {
  // 1. Tapahtumakytkennät tehdään TASAN KERRAN. Näkymien uudelleenrenderöinti
  //    korvaa vain listojen sisällön, joten kuuntelijat eivät kasaannu.
  initNavigation();
  initTodayNavigation();
  initWeekNavigation();
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
  initInbox();
  initReminderForm();
  initTravelForms();
  initNotices();
  initVoice();
  initSearch();
  initOnboarding();

  // 2. Näkymät seuraavat tilaa.
  subscribe(renderAll);
  subscribe(watchNotifiableChanges);

  // 3. Istunnon palautus.
  const session = await initAuth({ onSignedIn, onSignedOut });

  const splash = maybe('authSplash');
  if (splash) splash.classList.add('done');

  if (!session || !session.user) showAuthGate();

  // 4. NYT/MYÖHÄSSÄ/ETUAJASSA pysyy ajan tasalla ilman sivun päivitystä.
  setInterval(() => {
    if (!signedIn) return;
    renderToday();
    runAssistantSweeps();
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
  // bindLifecycle kytkee molemmat.
  lifecycle.bind({
    onResume: () => {
      if (!signedIn) return;
      renderToday();
      runAssistantSweeps();
      syncNotifications().catch(error => {
        console.warn('Manifestival: muistutusten synkronointi paluulla ei onnistunut', error);
      });
      // Sovellus on voinut olla taustalla pitkään: data on voinut vanhentua
      // (esim. muokattu toisella laitteella). refreshNow() on limitelty
      // reconnect.js:ssä, joten tämä ei koskaan käynnisty rinnakkain
      // samanaikaisen online-palautuksen kanssa.
      reconnect.refreshNow();
    },
    onPause: () => {
      reconnect.cancelPending();
    }
  });

  // 5. Service worker: sovelluskuori toimii offline.
  //    Rekisteröinti tehdään vasta käynnistyksen jälkeen, jottei se hidasta
  //    ensimmäistä maalausta. Epäonnistuminen ei ole virhe — sovellus toimii
  //    ilman sitäkin, vain ilman offline-tukea.
  registerServiceWorker();

  // 6. Verkon tilan ilmaisu. Palvelinta vaativat toiminnot eivät saa
  //    valehdella onnistuneensa, joten offline-tila kerrotaan näkyvästi.
  const updateOnlineState = () => {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    document.body.classList.toggle('is-offline', offline);
    const banner = maybe('offlineBanner');
    if (banner) banner.style.display = offline ? 'block' : 'none';
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
}

start().catch(error => {
  console.error('Manifestival: käynnistys epäonnistui', error);
  const splash = maybe('authSplash');
  if (splash) {
    splash.innerHTML = '<div class="startup-error">Sovelluksen käynnistys ei onnistunut. Päivitä sivu.</div>';
  }
});
