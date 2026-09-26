// Näkymien välinen navigointi.
//
// Ei tunne näkymien sisältöä — vaihtaa vain aktiivisen näkymän ja kertoo
// siitä tilalle. Näin näkymät voivat importoida tämän ilman syklejä.
//
// PIIRRETÄÄN VAIN NÄKYVÄ NÄYTTÖ (CRIT-01). Aiemmin jokainen tilamuutos
// piirsi kaikki näytöt — myös piilossa olevan Suunnan, joka laski viikon
// analyysit uudelleen — ja yksi lataus teki 52 tilamuutosta. main.js
// rekisteröi kunkin näytön piirtäjät ja aina piirrettävät osat
// (setScreenRenderers). Tilamuutos piirtää ne ja avoimen näytön
// (renderVisible) ja merkitsee muut likaisiksi; likainen näyttö
// piirretään tässä ENNEN kuin se näytetään (switchTab), joten
// vanhentunutta sisältöä ei koskaan näy.

import { getState, setScreen } from './state.js';
import { setDevicePreference } from '../data/preferences.js';

export const SCREENS = Object.freeze([
  'screen-today', 'screen-direction', 'screen-week', 'screen-tasks', 'screen-goals',
  'screen-finance', 'screen-profile'
]);

/** Näyttökohtaiset piirtäjät: { [screenId]: () => void }. main.js asettaa. */
let screenRenderers = {};
/** Joka tilamuutoksessa piirrettävät (esim. ajastinpalkki). */
let alwaysRenderers = [];
/** Saako nyt piirtää (esim. vain kirjautuneena). */
let renderingEnabled = () => true;
/** Näytöt, joiden tila tai aika on muuttunut niiden viimeisen piirron jälkeen. */
const dirtyScreens = new Set(SCREENS);
/** Viimeksi piirretty tila: pelkkä näytön vaihto ei tee muista näytöistä likaisia. */
let lastRenderedState = null;

/**
 * Rekisteröi näyttöjen piirtäjät. Kutsutaan kerran käynnistyksessä.
 * Kaikki näytöt ovat aluksi likaisia.
 *
 * @param {Record<string, () => void>} renderers
 * @param {object} [options]
 * @param {Array<() => void>} [options.always] piirretään joka tilamuutoksessa
 * @param {() => boolean} [options.enabled] false: ei piirretä eikä merkitä
 *   puhtaaksi (uloskirjautuneena)
 */
export function setScreenRenderers(renderers = {}, { always = [], enabled = () => true } = {}) {
  screenRenderers = { ...renderers };
  alwaysRenderers = [...always];
  renderingEnabled = typeof enabled === 'function' ? enabled : () => true;
  lastRenderedState = null;
  markScreensDirty();
}

/**
 * Muuttuiko tilassa muu kuin avoin näyttö? Viittausvertailu riittää:
 * kokoelmia ei mutatoida paikallaan, vaan ne korvataan (state.js).
 */
function contentChanged(previous, next) {
  if (!previous) return true;
  return Object.keys(next).some(key => key !== 'screen' && previous[key] !== next[key]);
}

/**
 * Piirrä tilamuutoksen jälkeen: aina piirrettävät ja avoin näyttö. Jos
 * muukin kuin avoin näyttö muuttui, muut näytöt merkitään likaisiksi.
 */
export function renderVisible(state = getState()) {
  if (!renderingEnabled()) return;
  if (contentChanged(lastRenderedState, state)) markScreensDirty();
  lastRenderedState = state;
  for (const render of alwaysRenderers) render();
  renderScreenIfDirty(state.screen);
}

/**
 * Kaikki näytöt kerralla (kirjautumisen jälkeen): piilossakaan ei jää
 * edellisen istunnon sisältöä odottamaan ensimmäistä avausta.
 */
export function renderEveryScreen(state = getState()) {
  if (!renderingEnabled()) return;
  markScreensDirty();
  renderVisible(state);
  for (const id of SCREENS) renderScreenIfDirty(id);
}

/** Uloskirjautuminen: seuraavan istunnon piirto ei luota edellisen piirtoihin. */
export function forgetRenderedScreens() {
  lastRenderedState = null;
  markScreensDirty();
}

/**
 * Merkitse kaikki näytöt likaisiksi: tila muuttui, aikaa kului tai
 * käyttäjä vaihtui. Seuraava näyttäminen piirtää ne uudelleen.
 */
export function markScreensDirty() {
  for (const id of SCREENS) dirtyScreens.add(id);
}

/** Onko näyttö piirrettävä ennen näyttämistä? */
export function isScreenDirty(screenId) {
  return dirtyScreens.has(screenId);
}

/**
 * Piirrä näyttö, jos se on likainen. Heittävä piirtäjä jättää näytön
 * likaiseksi (seuraava yritys piirtää uudelleen), ja virhe välittyy.
 *
 * @returns {boolean} piirrettiinkö
 */
export function renderScreenIfDirty(screenId) {
  if (!dirtyScreens.has(screenId) || !renderingEnabled()) return false;
  const render = screenRenderers[screenId];
  dirtyScreens.delete(screenId);
  if (typeof render !== 'function') return false;
  try {
    render();
  } catch (error) {
    dirtyScreens.add(screenId);
    throw error;
  }
  return true;
}

/**
 * Vaihda näkymä.
 * @param {string} screenId
 */
export function switchTab(screenId) {
  if (!SCREENS.includes(screenId)) return;

  // Likainen näyttö piirretään ENNEN näyttämistä. Epäonnistunut piirto ei
  // estä vaihtoa: näyttö jää likaiseksi, ja setScreen()-ilmoituksen
  // piirto yrittää uudelleen (virhe kirjautuu state.js:n notify():ssa).
  try {
    renderScreenIfDirty(screenId);
  } catch {
    /* ks. yllä */
  }

  // DOM-päivitys vain jos DOM:ia on: AI-komentokäsittelijät
  // (aiCommandHandlers.js) kutsuvat tätä yksikkötesteissä Node-
  // ympäristössä, jossa document ei ole olemassa. Tilamuutos
  // (setScreen/setDevicePreference) tehdään joka tapauksessa alla.
  if (typeof document !== 'undefined') {
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
  }

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
