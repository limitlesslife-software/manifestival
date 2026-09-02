// Keskitetty ilmoitus käyttäjälle.
//
// ONGELMA, JONKA TÄMÄ RATKAISEE
// Aiemmin jokainen epäonnistunut tietokantakutsu päätyi vain
// console.error-lokiin. Käyttöliittymä näytti onnistumista, vaikka tallennus
// epäonnistui — se siis valehteli käyttäjälle ja tieto katosi hiljaa.
//
// PERIAATE
// Käyttäjä näkee aina lyhyen suomenkielisen viestin. Tekninen syy menee
// konsoliin kehittäjää varten. Nämä kaksi eivät koskaan mene sekaisin.

import { logError } from '../lib/result.js';

const CONTAINER_ID = 'toastHost';
const DEFAULT_DURATION_MS = 4200;

/** Jono, jotta useampi ilmoitus ei kasaannu päällekkäin. */
const active = new Set();

function host() {
  let node = document.getElementById(CONTAINER_ID);
  if (!node) {
    node = document.createElement('div');
    node.id = CONTAINER_ID;
    node.className = 'toast-host';
    // aria-live: ruudunlukija kertoo ilmoituksen ilman fokuksen siirtoa.
    node.setAttribute('aria-live', 'polite');
    node.setAttribute('aria-atomic', 'false');
    document.body.appendChild(node);
  }
  return node;
}

function render(message, tone, duration) {
  // Ilmoitus on kertova lisä, ei toiminnon osa. Jos DOM:ia ei ole — Node,
  // testi, service worker — toiminto on silti onnistunut, eikä puuttuva
  // ilmoitus saa kaataa sitä jälkikäteen.
  if (typeof document === 'undefined') return () => {};

  const node = document.createElement('div');
  node.className = 'toast toast-' + tone;
  node.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  node.textContent = message;

  host().appendChild(node);
  active.add(node);

  const remove = () => {
    if (!active.has(node)) return;
    active.delete(node);
    node.classList.add('toast-leaving');
    setTimeout(() => node.remove(), 220);
  };

  const timer = setTimeout(remove, duration);
  node.addEventListener('click', () => { clearTimeout(timer); remove(); });
  return remove;
}

/** Neutraali ilmoitus. */
export function notify(message, duration = DEFAULT_DURATION_MS) {
  return render(message, 'info', duration);
}

/** Onnistuminen. */
export function success(message, duration = DEFAULT_DURATION_MS) {
  return render(message, 'success', duration);
}

/**
 * Virhe käyttäjälle. Diagnostiikka menee konsoliin.
 *
 * @param {import('../lib/result.js').AppError|Error|string} error
 * @param {string} [fallbackMessage] Käytetään, jos virheessä ei ole käyttäjäviestiä.
 */
export function showError(error, fallbackMessage = 'Jokin meni pieleen. Yritä uudelleen.') {
  if (typeof error === 'string') return render(error, 'error', 6000);

  logError(error);
  const message = (error && error.userMessage) || fallbackMessage;
  return render(message, 'error', 6000);
}

/** Poista kaikki näkyvät ilmoitukset. Kutsutaan uloskirjautumisessa. */
export function clearToasts() {
  for (const node of active) node.remove();
  active.clear();
}
