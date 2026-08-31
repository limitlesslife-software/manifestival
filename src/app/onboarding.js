// Ensikäytön opastus.
//
// Automaattinen esimerkkidata poistettiin WP1:ssä: uuden käyttäjän ei kuulu
// löytää tililtään toisen ihmisen karting-harjoituksia. Tyhjä sovellus on
// kuitenkin huono ensivaikutelma, ellei se kerro mitä tehdä seuraavaksi.
//
// Tämä on tarkoituksella kevyt: kolme korttia, ohitettavissa milloin tahansa,
// näytetään kerran laitetta kohti. Ei monivaiheista velhoa.

import { el, maybe, toggle } from '../ui/dom.js';
import { getDevicePreference, setDevicePreference } from '../data/preferences.js';
import { speechSupported } from './voice.js';

const STEPS = [
  {
    title: 'Tervetuloa Manifestivaliin',
    body: 'Tämä ei ole tehtävälista. Tämä on paikka, jossa päivä, tavoitteet ja palautuminen mahtuvat samaan suunnitelmaan.'
  },
  {
    title: 'Lisää ensimmäinen asia',
    body: 'Paina alhaalta kultaista mikrofonipainiketta ja sano se ääneen — tai kirjoita se Tehtävät-näkymässä. Tarkistat ehdotuksen ennen tallennusta.'
  },
  {
    title: 'Päivä rakentuu ympärille',
    body: 'Kun kerrot työaikasi, Manifestival laskee herätyksen ja nukkumaanmenon puolestasi. Näet ne heti Tänään-näkymässä.'
  }
];

let step = 0;

function render() {
  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  el('onboardingTitle').textContent = current.title;
  el('onboardingBody').textContent = speechSupported() || step !== 1
    ? current.body
    : current.body.replace('sano se ääneen — tai kirjoita', 'kirjoita');

  el('onboardingNext').textContent = isLast ? 'Aloita' : 'Seuraava';

  const dots = el('onboardingDots');
  dots.innerHTML = STEPS
    .map((_, i) => `<span class="onboarding-dot ${i === step ? 'active' : ''}"></span>`)
    .join('');

  el('onboardingCard').setAttribute('aria-label', `Vaihe ${step + 1} / ${STEPS.length}: ${current.title}`);
}

/** Sulje opastus ja merkitse se nähdyksi tällä laitteella. */
export function finishOnboarding() {
  setDevicePreference('onboardingCompleted', true);
  toggle('onboarding', false, 'flex');
  const overlay = maybe('onboarding');
  if (overlay) overlay.setAttribute('aria-hidden', 'true');
}

/** Näytä opastus alusta. */
export function showOnboarding() {
  step = 0;
  render();
  toggle('onboarding', true, 'flex');
  const overlay = maybe('onboarding');
  if (overlay) overlay.setAttribute('aria-hidden', 'false');
  el('onboardingNext').focus();
}

/**
 * Näytä opastus, jos sitä ei ole vielä nähty tällä laitteella.
 * @returns {boolean} näytettiinkö
 */
export function maybeShowOnboarding() {
  if (getDevicePreference('onboardingCompleted')) return false;
  showOnboarding();
  return true;
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
  });
}
