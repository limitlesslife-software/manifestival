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

/**
 * Näkyvä ilmoitus sävyn ja tekstin mukaan -> sen ajastin ja poisto.
 *
 * SAMA VIESTI EI PINOUDU. Yksi verkkokatko tuotti aiemmin kolme tai
 * useamman päällekkäisen ilmoituksen (esim. jokaisesta hylätystä
 * kirjauksesta oma). Näkyvissä jo oleva sama viesti vain pysyy
 * näkyvissä pidempään: sen ajastin alkaa alusta.
 *
 * SAMA VIRHE KUULUTETAAN SILTI UUDELLEEN. Käyttäjä, joka toistaa
 * epäonnistuneen toiminnon, ei muuten kuulisi mitään (role="alert" ei
 * muuttunut). Teksti tyhjennetään ja asetetaan seuraavassa mikrotehtävässä
 * uutena tekstisolmuna; näkyvä ilmoitus ei monistu.
 */
const visible = new Map();

/** Kuuluta näkyvä ilmoitus uudelleen samalla tekstillä. */
function reannounceToast(node, message) {
  node.textContent = '';
  const again = () => {
    if (active.has(node)) node.textContent = message;
  };
  if (typeof queueMicrotask === 'function') queueMicrotask(again);
  else Promise.resolve().then(again);
}

const keyOf = (message, tone) => tone + '\u0000' + message;

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

  const key = keyOf(String(message), tone);
  const existing = visible.get(key);
  if (existing && active.has(existing.node)) {
    clearTimeout(existing.timer);
    existing.timer = setTimeout(existing.remove, Math.max(duration, existing.duration));
    if (tone === 'error') reannounceToast(existing.node, String(message));
    return existing.remove;
  }

  const node = document.createElement('div');
  node.className = 'toast toast-' + tone;
  node.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  node.textContent = message;

  host().appendChild(node);
  active.add(node);

  const entry = { node, timer: null, duration, remove: null };
  entry.remove = () => {
    clearTimeout(entry.timer);
    if (visible.get(key) === entry) visible.delete(key);
    if (!active.has(node)) return;
    active.delete(node);
    node.classList.add('toast-leaving');
    setTimeout(() => node.remove(), 220);
  };
  visible.set(key, entry);

  entry.timer = setTimeout(entry.remove, duration);
  node.addEventListener('click', entry.remove);
  return entry.remove;
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
  for (const entry of visible.values()) clearTimeout(entry.timer);
  visible.clear();
  for (const node of active) node.remove();
  active.clear();
}
