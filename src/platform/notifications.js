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
import * as native from './nativeNotifications.js';

/**
 * Kaksi toteutusta saman rajapinnan takana.
 *
 *   natiivikuori + liitännäinen  -> Capacitor Local Notifications, ajastus toimii
 *   selain                       -> Notification API, vain etualalla
 *
 * Kutsuja ei valitse kumpaa käytetään. Se on koko tämän kerroksen tarkoitus:
 * domain suunnittelee muistutukset kerran, ja sama suunnitelma toteutuu
 * kummallakin alustalla niin hyvin kuin alusta pystyy.
 */
const NATIVE_PENDING = 'Ilmoitusliitännäistä ei ole rekisteröity tähän kuoreen';

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
    if (!native.isAvailable()) {
      return { ok: false, permission: PERMISSION.UNSUPPORTED, reason: NATIVE_PENDING };
    }
    return native.requestPermission();
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

  if (isNativeShell()) return native.showNow(intent);

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
  const list = Array.isArray(intents) ? intents : [];

  if (isNativeShell() && native.isAvailable()) return native.schedule(list);

  return {
    ok: false,
    planned: true,
    scheduled: 0,
    requested: list.length,
    reason: isNativeShell()
      ? NATIVE_PENDING
      : 'Ajastetut muistutukset vaativat Android-sovelluksen — selain ei pysty tähän luotettavasti'
  };
}

/** Peru ajastetut ilmoitukset. */
export async function cancelAll() {
  if (isNativeShell() && native.isAvailable()) return native.cancelAll();
  return { ok: false, planned: true, cancelled: 0, reason: NATIVE_PENDING };
}

/**
 * Lue lupatila laitteelta ja päivitä välimuisti.
 *
 * Natiivikuoressa lupatila on luettavissa vain asynkronisesti. Sovelluksen
 * on kutsuttava tätä kerran käynnistyksessä, jotta asetusnäkymä näyttää
 * oikean tilan. Tämä EI pyydä lupaa — se vain kysyy nykyisen tilan.
 */
export async function refreshPermission() {
  if (isNativeShell() && native.isAvailable()) return native.refreshPermission();
  return permission();
}

/**
 * Montako ilmoitusta on tällä hetkellä ajastettuna laitteelle.
 *
 * Vain natiivikuoressa tarkoittaa jotain: selaimessa ei ole laiteajastusta,
 * joten vastaus on aina 0 — se ei ole virhe, vaan totuus.
 */
export async function pendingCount() {
  if (isNativeShell() && native.isAvailable()) return native.pendingCount();
  return 0;
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
  if (isNativeShell() && native.isAvailable()) {
    return {
      level: 'scheduled',
      text: 'Muistutukset toimivat myös sovelluksen ollessa suljettuna.'
    };
  }

  return {
    level: 'foreground',
    text: 'Ilmoitukset toimivat sovelluksen ollessa auki. Muistutukset suljetusta sovelluksesta vaativat Android-sovelluksen.'
  };
}
