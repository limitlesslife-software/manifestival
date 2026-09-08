// Näkymien välinen navigointi.
//
// Ei tunne näkymien sisältöä — vaihtaa vain aktiivisen näkymän ja kertoo
// siitä tilalle. Näin näkymät voivat importoida tämän ilman syklejä.

import { setScreen } from './state.js';
import { setDevicePreference } from '../data/preferences.js';

export const SCREENS = Object.freeze([
  'screen-today', 'screen-week', 'screen-tasks', 'screen-goals',
  'screen-finance', 'screen-profile'
]);

/**
 * Vaihda näkymä.
 * @param {string} screenId
 */
export function switchTab(screenId) {
  if (!SCREENS.includes(screenId)) return;

  document.querySelectorAll('.tab-btn').forEach(button => {
    const active = button.dataset.screen === screenId;
    button.classList.toggle('active', active);
    // aria-selected kertoo ruudunlukijalle mikä välilehti on auki.
    button.setAttribute('aria-selected', String(active));
    button.setAttribute('tabindex', active ? '0' : '-1');
  });

  document.querySelectorAll('.screen').forEach(screen => {
    const active = screen.id === screenId;
    screen.classList.toggle('active', active);
    // Piilotettu näkymä pois ruudunlukijalta ja sarkainjärjestyksestä.
    screen.setAttribute('aria-hidden', String(!active));
    if (active) screen.removeAttribute('inert');
    else screen.setAttribute('inert', '');
  });

  setScreen(screenId);
  setDevicePreference('lastScreen', screenId);
}

/** Kytke alapalkin välilehdet. Kutsutaan kerran käynnistyksessä. */
export function initNavigation() {
  const buttons = [...document.querySelectorAll('.tab-btn')];

  buttons.forEach(button => {
    button.addEventListener('click', () => switchTab(button.dataset.screen));

    // Nuolinäppäimet liikkuvat välilehtien välillä, kuten tab-listoissa kuuluu.
    button.addEventListener('keydown', event => {
      const index = buttons.indexOf(button);
      let target = null;
      if (event.key === 'ArrowRight') target = buttons[(index + 1) % buttons.length];
      else if (event.key === 'ArrowLeft') target = buttons[(index - 1 + buttons.length) % buttons.length];
      else if (event.key === 'Home') target = buttons[0];
      else if (event.key === 'End') target = buttons[buttons.length - 1];
      if (!target) return;

      event.preventDefault();
      switchTab(target.dataset.screen);
      target.focus();
    });
  });
}

/** Palauta viimeksi avoinna ollut näkymä, jos se on kelvollinen. */
export function restoreLastScreen(preferredScreen) {
  const screen = SCREENS.includes(preferredScreen) ? preferredScreen : 'screen-today';
  switchTab(screen);
}

