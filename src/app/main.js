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
import { subscribe, resetState, setViewDate, setWeekStart } from './state.js';
import { loadUserData, clearLocalUserData } from './actions.js';
import { initAuth, showAuthGate, hideAuthGate } from './auth.js';
import { initNavigation, restoreLastScreen } from './navigation.js';
import { initVoice } from './voice.js';
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
import { refreshNotificationPermission, syncNotifications } from './notifications.js';
import { clearToasts } from '../ui/toast.js';
import { maybe } from '../ui/dom.js';

/** Kuinka usein NYT-tila päivitetään ilman sivun uudelleenlatausta. */
const NOW_REFRESH_MS = 30000;

let signedIn = false;

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
  initOnboarding();

  // 2. Näkymät seuraavat tilaa.
  subscribe(renderAll);

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

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && signedIn) renderToday();
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
  window.addEventListener('online', updateOnlineState);
  window.addEventListener('offline', updateOnlineState);
  updateOnlineState();
}

start().catch(error => {
  console.error('Manifestival: käynnistys epäonnistui', error);
  const splash = maybe('authSplash');
  if (splash) {
    splash.innerHTML = '<div class="startup-error">Sovelluksen käynnistys ei onnistunut. Päivitä sivu.</div>';
  }
});
