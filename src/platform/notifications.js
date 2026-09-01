// Ilmoitusten alustasovitin.
//
// VASTUUNJAKO
//   src/domain/notification.js  päättää MITÄ ja MILLOIN  (puhdas, testattava)
//   tämä moduuli                päättää MITEN            (alustakohtainen)
//
// Sama suunnitelma toteutuu eri tavoin: selaimessa etualalla, natiivikuoressa
// järjestelmän ajastimella. Domain ei tiedä kummastakaan.
//
// LUPAA EI KOSKAAN PYYDETÄ AUTOMAATTISESTI
// Selain hylkää käyttäjän eleen ulkopuolella tehdyn lupapyynnön, ja pahempaa:
// käyttäjä menettää mahdollisuuden sanoa kyllä myöhemmin. Lupa kysytään vain
// kun käyttäjä on nimenomaisesti kytkenyt ilmoitukset päälle.

import { CAPABILITY, capability, isNativeShell, PERMISSION } from './capabilities.js';

/**
 * Natiivitoteutuksen tila.
 *
 * PLANNED (WP12): @capacitor/local-notifications integroidaan tähän.
 * Liitännäistä ei ole vielä asennettu, koska sen testaaminen vaatii
 * fyysisen laitteen — eikä laitetta käytetä tässä vaiheessa.
 *
 * Rajapinta on kuitenkin lukittu nyt, jotta natiivitoteutus on myöhemmin
 * pelkkä tämän tiedoston laajennus eikä sovelluksen uudelleenkirjoitus.
 */
const NATIVE_PENDING = 'Natiivi-ilmoitukset otetaan käyttöön WP12:ssa';

/** Onko ilmoitukset ylipäätään mahdollisia tällä alustalla. */
export function support() {
  return capability(CAPABILITY.NOTIFICATIONS);
}

/** Nykyinen lupatila. Ei koskaan pyydä lupaa. */
export function permission() {
  return support().permission;
}

/**
 * Pyydä ilmoituslupa.
 *
 * KUTSU VAIN KÄYTTÄJÄN ELEESTÄ. Kutsuminen käynnistyksessä on virhe.
 *
 * @returns {Promise<{ok:boolean, permission:string, reason:string}>}
 */
export async function requestPermission() {
  const state = support();

  if (!state.supported) {
    return { ok: false, permission: PERMISSION.UNSUPPORTED, reason: state.reason };
  }

  if (isNativeShell()) {
    return { ok: false, permission: PERMISSION.PROMPT, reason: NATIVE_PENDING };
  }

  if (typeof Notification === 'undefined') {
    return { ok: false, permission: PERMISSION.UNSUPPORTED, reason: 'Selain ei tue ilmoituksia' };
  }

  try {
    const result = await Notification.requestPermission();
    const mapped = result === 'granted'
      ? PERMISSION.GRANTED
      : result === 'denied' ? PERMISSION.DENIED : PERMISSION.PROMPT;
    return {
      ok: mapped === PERMISSION.GRANTED,
      permission: mapped,
      reason: mapped === PERMISSION.DENIED ? 'Ilmoitukset on estetty selaimen asetuksista' : ''
    };
  } catch {
    return { ok: false, permission: PERMISSION.PROMPT, reason: 'Lupaa ei voitu kysyä' };
  }
}

/**
 * Näytä ilmoitus HETI.
 *
 * Tämä on ainoa asia, jonka selain pystyy tekemään luotettavasti: näyttämään
 * ilmoituksen silloin kun sivu on auki. Ajastettu muistutus suljetusta
 * sovelluksesta vaatii natiivikerroksen.
 *
 * @param {object} intent domain/notification.js:n tuottama aikomus
 */
export async function showNow(intent) {
  const state = support();
  if (!state.available) {
    return { ok: false, reason: state.reason || 'Ilmoitukset eivät ole käytettävissä' };
  }

  try {
    // eslint-disable-next-line no-new
    new Notification(intent.title, {
      body: intent.body,
      tag: intent.id,
      silent: intent.channel === 'silent'
    });
    return { ok: true, reason: '' };
  } catch {
    return { ok: false, reason: 'Ilmoitusta ei voitu näyttää' };
  }
}

/**
 * Ajasta ilmoitukset etukäteen.
 *
 * TILA: PLANNED (WP12).
 *
 * Selaimessa tämä ei ole toteutettavissa luotettavasti: `setTimeout` ei
 * selviä välilehden sulkemisesta, ja Web Push vaatisi palvelinpuolen
 * push-palvelun. Sen sijaan että toteuttaisimme jotain, joka toimii vain
 * silloin kun sovellus sattuu olemaan auki, kerromme rehellisesti ettei
 * tätä vielä ole.
 *
 * @returns {Promise<{ok:false, reason:string, planned:true}>}
 */
export async function schedule(intents = []) {
  return {
    ok: false,
    planned: true,
    scheduled: 0,
    requested: Array.isArray(intents) ? intents.length : 0,
    reason: isNativeShell()
      ? NATIVE_PENDING
      : 'Ajastetut muistutukset vaativat natiivisovelluksen — selain ei pysty tähän luotettavasti'
  };
}

/** Peru ajastetut ilmoitukset. PLANNED yhdessä schedule():n kanssa. */
export async function cancelAll() {
  return { ok: false, planned: true, reason: NATIVE_PENDING };
}

/**
 * Yhteenveto käyttöliittymälle.
 * Kertoo mitä ilmoituksista voi juuri nyt odottaa — ei lupaa liikoja.
 */
export function describeSupport() {
  const state = support();

  if (!state.supported) {
    return { level: 'none', text: state.reason || 'Ilmoitukset eivät ole käytettävissä' };
  }
  if (state.permission === PERMISSION.DENIED) {
    return { level: 'blocked', text: 'Ilmoitukset on estetty selaimen asetuksista' };
  }
  if (state.permission !== PERMISSION.GRANTED) {
    return { level: 'prompt', text: 'Ilmoitukset vaativat luvan' };
  }
  return {
    level: 'foreground',
    text: 'Ilmoitukset toimivat sovelluksen ollessa auki. Muistutukset suljetusta sovelluksesta vaativat Android-sovelluksen.'
  };
}
