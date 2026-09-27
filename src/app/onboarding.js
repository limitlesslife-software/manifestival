// Ensikäytön opastus.
//
// Automaattinen esimerkkidata poistettiin WP1:ssä: uuden käyttäjän ei kuulu
// löytää tililtään toisen ihmisen karting-harjoituksia. Tyhjä sovellus on
// kuitenkin huono ensivaikutelma, ellei se kerro mitä tehdä seuraavaksi.
//
// Tämä on tarkoituksella kevyt: kolme korttia, ohitettavissa milloin tahansa,
// näytetään kerran KÄYTTÄJÄÄ kohti tällä laitteella. Ei monivaiheista velhoa.
//
// KÄYTTÄJÄKOHTAINEN, EI LAITEKOHTAINEN (CRIT-06): merkintä oli ennen
// laiteasetus, ja uloskirjautuminen tyhjentää laiteasetukset — opastus
// näkyi siksi jokaisen uloskirjautumisen jälkeen uudelleen. Nyt merkintä
// on käyttäjäkohtainen (src/data/preferences.js USER_DEFAULTS) ja säilyy
// uloskirjautumisen yli; toinen käyttäjä samalla laitteella näkee oman
// opastuksensa.
//
// MODAALI: opastuksen ollessa auki sovellus (#app) on inert eikä
// ruudunlukija näe sitä, sarkain kiertää opastuksen painikkeissa, ja
// sulkeminen palauttaa fokuksen sinne, missä se oli.

import { el, maybe, toggle } from '../ui/dom.js';
import {
  getDevicePreference, setDevicePreference, getUserPreference, setUserPreference
} from '../data/preferences.js';
import { getUser } from '../data/session.js';
import { speechSupported } from './voice.js';

const STEPS = [
  {
    title: 'Tervetuloa Manifestivaliin',
    body: 'Tämä ei ole tehtävälista. Tämä on paikka, jossa päivä, tavoitteet ja palautuminen mahtuvat samaan suunnitelmaan.'
  },
  {
    title: 'Lisää ensimmäinen asia',
    body: 'Paina alhaalta kultaista mikrofonipainiketta ja sano se ääneen — tai kirjoita se Tehtävät-näkymässä. Mikrofonin lupaa kysytään vasta, kun painat painiketta. Tarkistat ehdotuksen ennen tallennusta.',
    // Ilman puheentunnistusta (selain ei tue, tai Android-sovellus ilman
    // puheliitännäistä) sama painike avaa kirjoituskentän. Ei lupausta
    // puheesta, jota ei ole.
    typedBody: 'Paina alhaalta kultaista painiketta ja kirjoita, mitä haluat lisätä — tai lisää se Tehtävät-näkymässä. Tarkistat ehdotuksen ennen tallennusta.'
  },
  {
    title: 'Päivä rakentuu ympärille',
    body: 'Kun kerrot työaikasi, Manifestival laskee herätyksen ja nukkumaanmenon puolestasi. Näet ne heti Tänään-näkymässä.'
  },
  // Arjen käyttöjärjestelmä (aalto K): kaksi VALINNAISTA korttia. Ne vain
  // kertovat, mistä asetukset löytyvät; mitään ei kytketä päälle
  // puolesta, eikä kortin ohittaminen jätä mitään kesken.
  {
    title: 'Oma rytmi, jos haluat',
    body: 'Valinnainen: Profiili → Arki. Kerro unitavoite, aamurutiini ja ateriat, niin herätys, nukkumaanmeno ja muistutukset seuraavat omaa rytmiäsi. Voit jättää tämän myöhemmäksi.',
    optional: true
  },
  {
    title: 'Paikat ja lähtöajat, jos haluat',
    body: 'Valinnainen: Profiili → Paikat. Tallenna usein käytetyt paikat ja oma arviosi matka-ajasta, niin menoille lasketaan lähtöaika ja valmistautuminen. Ilman arviota lähtöaikaa ei arvata.',
    optional: true
  }
];

/** Opastuksen kortit (vain luku). Testit ja ohjeet lukevat tätä. */
export function onboardingSteps() {
  return STEPS.map(step => Object.freeze({ ...step }));
}

let step = 0;
/** Elementti, jossa fokus oli ennen opastusta: sinne palataan. */
let returnFocus = null;
/** Sovelluksen tila ennen opastusta (huoltotila voi jo pitää sen inerttinä). */
let backgroundBefore = null;

function currentUserId() {
  const user = getUser();
  return user && user.id ? String(user.id) : null;
}

function render() {
  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  el('onboardingTitle').textContent = current.title;
  el('onboardingBody').textContent = current.typedBody && !speechSupported()
    ? current.typedBody
    : current.body;

  el('onboardingNext').textContent = isLast ? 'Aloita' : 'Seuraava';

  const dots = el('onboardingDots');
  dots.innerHTML = STEPS
    .map((_, i) => `<span class="onboarding-dot ${i === step ? 'active' : ''}"></span>`)
    .join('');

  el('onboardingCard').setAttribute('aria-label', `Vaihe ${step + 1} / ${STEPS.length}: ${current.title}`);
}

/** Sovellus opastuksen alla: pois fokuksesta ja ruudunlukijalta, ja takaisin. */
function setBackgroundInert(on) {
  const app = maybe('app');
  if (!app) return;
  if (on) {
    if (backgroundBefore === null) {
      backgroundBefore = { inert: Boolean(app.inert), hidden: app.getAttribute('aria-hidden') };
    }
    app.inert = true;
    app.setAttribute('aria-hidden', 'true');
    return;
  }
  if (backgroundBefore === null) return;
  app.inert = backgroundBefore.inert;
  if (backgroundBefore.hidden === null) app.removeAttribute('aria-hidden');
  else app.setAttribute('aria-hidden', backgroundBefore.hidden);
  backgroundBefore = null;
}

function isShown() {
  const overlay = maybe('onboarding');
  return Boolean(overlay) && overlay.getAttribute('aria-hidden') === 'false';
}

/** Sulje opastus ilman merkintää (ja palauta sovellus käyttöön). */
function hideOverlay() {
  const wasShown = isShown();
  toggle('onboarding', false, 'flex');
  const overlay = maybe('onboarding');
  if (overlay) overlay.setAttribute('aria-hidden', 'true');
  setBackgroundInert(false);
  if (wasShown) restoreFocus();
}

function restoreFocus() {
  const target = returnFocus;
  returnFocus = null;
  const usable = target && target !== document.body && typeof target.focus === 'function'
    && target.isConnected !== false
    && !(typeof target.closest === 'function' && target.closest('#authGate, #onboarding'));
  if (usable) {
    target.focus();
    return;
  }
  // Kirjautumisen jälkeen fokus oli kirjautumislomakkeessa, joka on nyt
  // piilossa: avoimen välilehden painike on luonteva paluukohta.
  const tab = typeof document.querySelector === 'function'
    ? document.querySelector('.tab-btn[aria-selected="true"]') : null;
  if (tab && typeof tab.focus === 'function') tab.focus();
}

/** Sulje opastus ja merkitse se nähdyksi tälle käyttäjälle. */
export function finishOnboarding() {
  const userId = currentUserId();
  if (userId) setUserPreference(userId, 'onboardingCompleted', true);
  else setDevicePreference('onboardingCompleted', true);
  hideOverlay();
}

/** Näytä opastus alusta. */
export function showOnboarding() {
  step = 0;
  render();
  if (!isShown()) returnFocus = document.activeElement || null;
  toggle('onboarding', true, 'flex');
  const overlay = maybe('onboarding');
  if (overlay) overlay.setAttribute('aria-hidden', 'false');
  setBackgroundInert(true);
  el('onboardingNext').focus();
}

/** Onko tämä käyttäjä jo nähnyt opastuksen tällä laitteella? */
export function onboardingDone(userId = currentUserId()) {
  if (userId) return getUserPreference(userId, 'onboardingCompleted') === true;
  return getDevicePreference('onboardingCompleted') === true;
}

/**
 * Näytä opastus, jos tämä käyttäjä ei ole vielä nähnyt sitä.
 * @returns {boolean} näytettiinkö
 */
export function maybeShowOnboarding() {
  const userId = currentUserId();
  if (onboardingDone(userId)) {
    // Edellisen käyttäjän kesken jäänyt opastus ei jää tämän päälle.
    if (isShown()) hideOverlay();
    return false;
  }
  // Siirtymä: vanha laitekohtainen merkintä on yhä laitteella vain, jos
  // uloskirjautumista ei ole ollut välissä — sama käyttäjä on siis nähnyt
  // opastuksen. Merkintä siirretään käyttäjälle.
  if (userId && getDevicePreference('onboardingCompleted') === true) {
    setUserPreference(userId, 'onboardingCompleted', true);
    if (isShown()) hideOverlay();
    return false;
  }
  showOnboarding();
  return true;
}

/** Sarkain kiertää opastuksen painikkeissa (fokusloukku). */
function trapFocus(event) {
  if (event.key !== 'Tab') return;
  const nodes = ['onboardingSkip', 'onboardingNext'].map(maybe).filter(node => node && !node.disabled);
  if (nodes.length === 0) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !nodes.includes(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !nodes.includes(active))) {
    event.preventDefault();
    first.focus();
  }
}

/** Kytke opastuksen tapahtumat. */
export function initOnboarding() {
  el('onboardingNext').addEventListener('click', () => {
    if (step === STEPS.length - 1) finishOnboarding();
    else { step += 1; render(); }
  });

  el('onboardingSkip').addEventListener('click', finishOnboarding);

  el('onboarding').addEventListener('keydown', event => {
    if (event.key === 'Escape') finishOnboarding();
    else trapFocus(event);
  });
}
