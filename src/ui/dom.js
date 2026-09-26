// Pienet DOM-apuvälineet.
//
// Tämä kerros ei tunne sovelluksen domainia. Se tarjoaa vain turvallisempia
// tapoja tehdä sitä, mitä koodi teki ennen käsin joka paikassa.

/** Elementti tunnisteella. Heittää selkeän virheen, jos sitä ei ole. */
export function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error('DOM-elementtiä ei löydy: ' + id);
  return node;
}

/** Elementti tunnisteella tai null. Käytetään valinnaisiin osiin. */
export function maybe(id) {
  return document.getElementById(id);
}

/** Lisää tapahtumankuuntelija tunnisteella haettuun elementtiin. */
export function on(id, event, handler, options) {
  el(id).addEventListener(event, handler, options);
}

/** Näytä tai piilota elementti. */
export function toggle(id, visible, display = 'block') {
  const node = maybe(id);
  if (node) node.style.display = visible ? display : 'none';
}

export function show(id, display) { toggle(id, true, display); }
export function hide(id) { toggle(id, false); }

/** Aseta tekstisisältö turvallisesti (ei koskaan tulkita HTML:nä). */
export function setText(id, text) {
  const node = maybe(id);
  if (node) node.textContent = text == null ? '' : String(text);
}

/**
 * Merkitse elementti työn alle olevaksi.
 * Estää tuplaklikkauksen ja kertoo käyttäjälle, että jotain tapahtuu.
 */
export function setBusy(node, busy, busyLabel) {
  if (!node) return;
  node.classList.toggle('is-busy', Boolean(busy));
  if (busy) {
    node.setAttribute('aria-busy', 'true');
    if (busyLabel && node.dataset.idleLabel === undefined) {
      node.dataset.idleLabel = node.textContent;
      node.textContent = busyLabel;
    }
    if (node.tagName === 'BUTTON') node.disabled = true;
  } else {
    node.removeAttribute('aria-busy');
    if (node.dataset.idleLabel !== undefined) {
      node.textContent = node.dataset.idleLabel;
      delete node.dataset.idleLabel;
    }
    if (node.tagName === 'BUTTON') node.disabled = false;
  }
}

/**
 * Kääri asynkroninen toiminto niin, ettei sitä voi käynnistää kahdesti
 * yhtä aikaa. Ratkaisee tuplaklikkauksen, kaksinkertaisen tallennuksen ja
 * vahingossa lähetetyn toisen AI-pyynnön.
 *
 * @param {Function} fn
 * @returns {Function} sama funktio, mutta rinnakkaiset kutsut ohitetaan
 */
export function singleFlight(fn) {
  let running = false;
  return async function guarded(...args) {
    if (running) return undefined;
    running = true;
    try {
      return await fn.apply(this, args);
    } finally {
      running = false;
    }
  };
}

/** Siirrä fokus elementtiin, jos se on olemassa. */
export function focus(id) {
  const node = maybe(id);
  if (node && typeof node.focus === 'function') node.focus();
}

// ------------------------------------------------ uudelleenpiirto ja fokus
//
// Näkymät piirtävät säiliön uudelleen innerHTML:llä jokaisella
// tilamuutoksella. Kaksi sivuvaikutusta korjataan tässä (CRIT-03):
//
//   1. SAMA merkintä kirjoitettiin joka kerta uudelleen. Ruudunlukija
//      saattoi lukea role="alert"/"status"-ilmoituksen uudestaan, ja
//      näppäimistön fokus putosi <body>:yyn, vaikka mikään ei muuttunut.
//      setHtml ei kirjoita identtistä merkintää — ellei DOMia ole välissä
//      muutettu käsin (esim. painike estetty tai sisältö tyhjennetty), jolloin
//      kirjoitus palauttaa piirretyn tilan kuten ennenkin.
//   2. MUUTTUNUT merkintä hävitti fokusoidun ohjaimen. renderHtml palauttaa
//      fokuksen samaan ohjaimeen (vakaa avain: data-focus, id tai
//      data-attribuutit), tai jos ohjain poistui, seuraavan rivin
//      ensimmäiseen ohjaimeen tai osion otsikkoon (tabindex="-1").
//
// Käyttäjän avaama tai sulkema <details> ("Miksi tämä näkyy?") pysyy
// sellaisena uudelleenpiirron yli, kun osioiden määrä ei muuttunut: muuten
// sen sisällä fokusoitu ohjain katoaisi näkyvistä ja fokus putoaisi.

/** Säiliö -> { markup, serialized }: viimeksi kirjoitettu ja sen DOM-muoto. */
const writtenMarkup = new WeakMap();

/** Rivit, joiden järjestyksestä "seuraava rivi" lasketaan. */
const ROW_SELECTOR = '.assist-row, .dir-goal-row, .dir-quality-row, .dir-signal, .dir-today-observation, li, fieldset';
const FOCUSABLE_SELECTOR = 'button, input, select, textarea, summary, a[href], [tabindex]';
/** Piirrosta toiseen vaihtuvat data-attribuutit eivät kuulu ohjaimen avaimeen. */
const VOLATILE_DATA = new Set(['armed', 'dirty', 'idleLabel']);

function queryAll(root, selector) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  return [...root.querySelectorAll(selector)];
}

function attributeValue(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

/** Ohjaimen avain valitsimena; null, jos vakaata avainta ei ole. */
function focusKey(node) {
  const data = node.dataset || {};
  if (data.focus) return `[data-focus="${attributeValue(data.focus)}"]`;
  if (node.id) return `[id="${attributeValue(node.id)}"]`;
  const parts = Object.keys(data).filter(key => !VOLATILE_DATA.has(key))
    .map(key => `[data-${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}="${attributeValue(data[key])}"]`);
  return parts.length > 0 ? String(node.tagName || '').toLowerCase() + parts.join('') : null;
}

function canFocus(node) {
  if (!node || typeof node.focus !== 'function' || node.disabled || node.hidden) return false;
  return !(typeof node.closest === 'function' && node.closest('[hidden], [inert]'));
}

function contains(container, node) {
  return Boolean(node) && node !== container && typeof container.contains === 'function' && container.contains(node);
}

/**
 * Kirjoita säiliön merkintä, ellei se ole sama kuin viimeksi.
 * @returns {boolean} kirjoitettiinko
 */
export function setHtml(container, html) {
  if (!container) return false;
  const markup = String(html ?? '');
  const previous = writtenMarkup.get(container);
  if (previous && previous.markup === markup && container.innerHTML === previous.serialized) return false;
  const openBefore = queryAll(container, 'details').map(node => Boolean(node.open));
  container.innerHTML = markup;
  const detailsAfter = queryAll(container, 'details');
  if (openBefore.length > 0 && detailsAfter.length === openBefore.length) {
    detailsAfter.forEach((node, index) => { if (Boolean(node.open) !== openBefore[index]) node.open = openBefore[index]; });
  }
  writtenMarkup.set(container, { markup, serialized: container.innerHTML });
  return true;
}

/**
 * Fokuksen tila ennen uudelleenpiirtoa, jos fokus on säiliön sisällä.
 * @returns {object|null}
 */
export function captureFocus(container) {
  if (!container || typeof document === 'undefined') return null;
  const active = document.activeElement;
  if (!contains(container, active)) return null;
  const row = typeof active.closest === 'function' ? active.closest(ROW_SELECTOR) : null;
  return {
    key: focusKey(active),
    tag: active.tagName,
    controlIndex: queryAll(container, FOCUSABLE_SELECTOR).indexOf(active),
    rowIndex: contains(container, row) ? queryAll(container, ROW_SELECTOR).indexOf(row) : -1
  };
}

function querySafe(container, selector) {
  try {
    return container.querySelector(selector);
  } catch {
    return null;
  }
}

function fallbackTarget(fallback) {
  for (const entry of fallback) {
    const node = typeof entry === 'string' ? maybe(entry) : entry;
    if (!node || typeof node.focus !== 'function' || !canFocus(node)) continue;
    // Otsikko ei ole sarkainjärjestyksessä, mutta siihen voi siirtää fokuksen.
    if (typeof node.hasAttribute === 'function' && !node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
    return node;
  }
  return null;
}

/**
 * Palauta fokus uudelleenpiirron jälkeen: sama ohjain -> saman (tai
 * seuraavan) rivin ensimmäinen ohjain -> ensimmäinen löytyvä varaotsikko.
 * Jos sama ohjain on yhä olemassa mutta estetty (tallennus kesken), fokus
 * menee otsikkoon: seuraavan rivin ohjain olisi eri asia kuin käyttäjä valitsi.
 *
 * @param {Element} container
 * @param {object|null} state        captureFocus()-tulos
 * @param {object} [options]
 * @param {Array<string|Element>} [options.fallback] otsikoiden tunnisteet
 * @returns {Element|null} fokusoitu elementti
 */
export function restoreFocus(container, state, { fallback = [] } = {}) {
  if (!container || !state || typeof container.querySelector !== 'function') return null;
  let target = null;
  let busy = false;
  if (state.key) {
    const same = querySafe(container, state.key);
    if (canFocus(same)) target = same;
    else if (same) busy = true;
  } else if (state.controlIndex >= 0) {
    const candidate = queryAll(container, FOCUSABLE_SELECTOR)[state.controlIndex];
    if (candidate && candidate.tagName === state.tag && canFocus(candidate)) target = candidate;
  }
  if (!target && !busy && state.rowIndex >= 0) {
    for (const row of queryAll(container, ROW_SELECTOR).slice(state.rowIndex)) {
      target = queryAll(row, FOCUSABLE_SELECTOR).find(canFocus) || null;
      if (target) break;
    }
  }
  if (!target) target = fallbackTarget(fallback);
  if (target) target.focus();
  return target;
}

/**
 * Piirrä säiliö: identtistä merkintää ei kirjoiteta, ja muuttuneen
 * merkinnän jälkeen fokus palautetaan (ks. restoreFocus).
 * @returns {boolean} kirjoitettiinko
 */
export function renderHtml(container, html, options = {}) {
  if (!container) return false;
  const state = captureFocus(container);
  if (!setHtml(container, html)) return false;
  if (state) restoreFocus(container, state, options);
  return true;
}


