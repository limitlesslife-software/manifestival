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

/** Kunnioittaako käyttäjä liikkeen vähentämistä. */
export function prefersReducedMotion() {
  try {
    return typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
