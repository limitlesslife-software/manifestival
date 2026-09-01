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
import { loadUserData } from './actions.js';
import { initAuth, showAuthGate, hideAuthGate } from './auth.js';
import { initNavigation, restoreLastScreen } from './navigation.js';
import { initVoice } from './voice.js';
import { initOnboarding, maybeShowOnboarding } from './onboarding.js';
import { renderToday, initTodayNavigation } from './views/today.js';
import { renderWeek, initWeekNavigation } from './views/week.js';
import { renderTasks, initTaskForm, closeForm } from './views/tasks.js';
import { initRoutineForm, closeRoutineForm } from './views/routines.js';
import { renderGoals, initGoalForm, closeGoalForm } from './views/goals.js';
import { renderProfile, initProfileForm, fillProfileForm } from './views/profile.js';
import { renderNotificationSettings } from './views/notificationSettings.js';
import { refreshNotificationPermission, syncNotifications } from './notifications.js';
import { clearPreferences as clearNotificationPreferences } from '../data/notificationPrefsRepo.js';
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
  renderProfile();
  renderNotificationSettings();
}

async function onSignedIn() {
  signedIn = true;
  hideAuthGate();

  // Päivä ja viikko nollataan kirjautuessa: sovellus avautuu aina tähän
  // päivään, ei siihen mihin edellinen istunto jäi.
  setViewDate(todayMidnight());
  setWeekStart(startOfWeek(todayMidnight()));

  restoreLastScreen(getDevicePreference('lastScreen'));

  await loadUserData();
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

  maybeShowOnboarding();
}

function onSignedOut() {
  signedIn = false;
  closeForm();
  closeRoutineForm();
  closeGoalForm();
  clearToasts();
  clearNotificationPreferences();
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
  initProfileForm();
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
  setInterval(() => { if (signedIn) renderToday(); }, NOW_REFRESH_MS);

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
