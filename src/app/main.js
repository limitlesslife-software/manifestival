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
import { renderProfile, initProfileForm, fillProfileForm } from './views/profile.js';
import { clearToasts } from '../ui/toast.js';
import { maybe } from '../ui/dom.js';

/** Kuinka usein NYT-tila päivitetään ilman sivun uudelleenlatausta. */
const NOW_REFRESH_MS = 30000;

let signedIn = false;

/** Renderöi kaikki näkymät. Kutsutaan tilamuutoksesta. */
function renderAll() {
  if (!signedIn) return;
  renderToday();
  renderWeek();
  renderTasks();
  renderProfile();
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
  renderAll();

  maybeShowOnboarding();
}

function onSignedOut() {
  signedIn = false;
  closeForm();
  clearToasts();
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

  // 5. Verkon tilan ilmaisu. Palvelinta vaativat toiminnot eivät saa
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
