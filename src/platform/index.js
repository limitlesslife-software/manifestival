// Alustasovittimet — julkinen rajapinta.
//
// MIKSI TÄMÄ KERROS ON OLEMASSA
// Manifestivalin arvokkaimmat myöhemmät ominaisuudet — muistutukset oikeaan
// aikaan, lähtöajan ennakointi, puhekomento lukitulla puhelimella — eivät ole
// selaimen tavoitettavissa. Ne vaativat natiivikerroksen
// (ks. docs/ANDROID-STRATEGY.md).
//
// Jos sovelluslogiikka kutsuisi suoraan selaimen rajapintoja, natiiviversio
// vaatisi ydinsovelluksen uudelleenkirjoituksen. Siksi kaikki alustariippuvuus
// kulkee näiden sovittimien läpi jo nyt.
//
// Domain EI tunne tätä kerrosta. Kerrosjärjestys on testattu invariantti.

import {
  CAPABILITY, CAPABILITIES, PERMISSION, NATIVE_REQUIRED,
  capability, isAvailable, isSupported, permissionOf, allCapabilities,
  isNativeShell, platformName
} from './capabilities.js';
import * as notificationPlatform from './notifications.js';
import { bindLifecycle, isNativeLifecycleAvailable } from './lifecycle.js';
import * as geolocation from './geolocation.js';

export {
  CAPABILITY, CAPABILITIES, PERMISSION, NATIVE_REQUIRED,
  capability, isAvailable, isSupported, permissionOf, allCapabilities,
  isNativeShell, platformName
};

/**
 * KOLME ERI KYSYMYSTÄ — NIITÄ EI SAA SEKOITTAA
 *
 *   supported    alusta pystyy tähän
 *   implemented  Manifestival on toteuttanut tämän
 *   permission   käyttäjä on antanut luvan
 *   available    kaikki edellä on kunnossa juuri nyt
 *
 * Jokainen sovitin palauttaa `capability()`-rekisterimerkinnän SELLAISENAAN.
 * Aiemmin sovittimet kirjoittivat `supported: state.implemented`, jolloin
 * Android-kuori väitti ettei laite tue sijaintia — vaikka se tukee, eikä
 * puute ollut laitteessa vaan sovelluksessa. Kutsuja erottelee itse.
 *
 * Vastaus tähän kysymykseen EI koskaan pyydä lupaa. Lupa kysytään vain
 * käyttäjän omasta eleestä, ks. notifications.requestPermission.
 */
const NOT_IMPLEMENTED = Object.freeze({
  supported: false,
  reason: NATIVE_REQUIRED
});

/**
 * Tuotannon osoite. Tarvitaan VAIN natiivikuoressa.
 *
 * Webissä sovellus tarjoillaan samasta originista kuin /api/parse, joten
 * suhteellinen polku riittää. Natiivikuoressa sivu ladataan laitteen omasta
 * tiedostojärjestelmästä (Android: https://localhost, api/_cors.js), jolloin suhteellinen polku
 * osuisi paikalliseen kuoreen eikä koskaan palvelimeen — puheohjaus
 * lakkaisi toimimasta hiljaa.
 */
export const PRODUCTION_ORIGIN = 'https://manifestival-ten.vercel.app';

/**
 * Palvelinpäätepisteen osoite tällä alustalla.
 * @param {string} path esim. '/api/parse'
 */
export function apiUrl(path) {
  return isNativeShell() ? PRODUCTION_ORIGIN + path : path;
}

// --------------------------------------------------------- ilmoitukset

export const notifications = Object.freeze({
  capability: () => notificationPlatform.support(),
  permission: () => notificationPlatform.permission(),
  requestPermission: async () => {
    const result = await notificationPlatform.requestPermission();
    return result.ok;
  },
  requestPermissionDetailed: notificationPlatform.requestPermission,
  /** Lue lupatila laitteelta. EI pyydä lupaa. */
  refreshPermission: notificationPlatform.refreshPermission,
  showNow: notificationPlatform.showNow,
  schedule: notificationPlatform.schedule,
  cancel: notificationPlatform.cancelAll,
  describeSupport: notificationPlatform.describeSupport,
  /** Montako ilmoitusta on tällä hetkellä ajastettuna laitteelle. */
  pendingCount: notificationPlatform.pendingCount
});

// ------------------------------------------------------------- sijainti

export const location = Object.freeze({
  capability: () => capability(CAPABILITY.LOCATION),
  /** Rikas lupatila (not_requested, prompt, granted, denied, blocked, ...). Synkroninen, ei pyydä lupaa. */
  permissionState: geolocation.locationPermissionState,
  describePermission: geolocation.describeLocationState,
  /** Lue lupatila laitteelta. EI pyydä lupaa. */
  refreshPermission: geolocation.checkLocationPermission,
  /** Pyydä lupa. VAIN käyttäjän omasta eleestä. */
  requestPermission: geolocation.requestLocationPermission,
  /**
   * Hae sijainti kerran (etualalla). Ei taustaseurantaa, ei historiaa;
   * koordinaatit vain muistissa. Ks. src/platform/geolocation.js.
   */
  current: geolocation.getCurrentLocation,
  cached: geolocation.getCachedLocation,
  /** Unohda muistissa oleva sijainti. Uloskirjautuminen. */
  forget: geolocation.clearLocationCache,
  /** Geoaidat ja taustaseuranta: EI TOTEUTETTU eikä luvattu. */
  async watchArrival() {
    return { ok: false, ...NOT_IMPLEMENTED };
  }
});

// ----------------------------------------------------------------- puhe

export const speech = Object.freeze({
  capability: () => capability(CAPABILITY.SPEECH),
  /**
   * Toimiiko puhekomento sovelluksen ollessa suljettuna.
   * Selaimessa ei koskaan. Tämä on yksi natiivikerroksen tärkeimmistä syistä.
   */
  supportsBackgroundCapture() {
    return isNativeShell();
  }
});

// ------------------------------------------------------- taustatoiminta

export const background = Object.freeze({
  capability: () => capability(CAPABILITY.BACKGROUND),
  /** PLANNED (WP12). */
  async register() {
    return { ok: false, ...NOT_IMPLEMENTED };
  }
});

// -------------------------------------------------------- elinkaari

/**
 * Sovelluksen etu-/taustatilan kuuntelu.
 *
 * Ei ole oma kyvykkyys `capabilities()`-mielessä — tämä on sisäistä
 * putkitusta, ei käyttäjän lupaa vaativa ominaisuus. Natiivissa
 * Capacitorin App-liitännäinen antaa oikean tapahtuman; selaimessa
 * ainoa vastine on `visibilitychange`, joka kytketään aina mukaan.
 */
export const lifecycle = Object.freeze({
  isNativeAvailable: isNativeLifecycleAvailable,
  /** Kytke kerran käynnistyksessä. Toinen kutsu ei tee mitään. */
  bind: bindLifecycle
});

// ---------------------------------------------------------- yhteenveto

/**
 * Kaikkien sovittimien tila yhtenä oliona.
 * Käyttöliittymä näyttää tämän asetuksissa, jotta käyttäjä tietää mitä
 * tällä alustalla oikeasti voi tehdä.
 */
export function capabilities() {
  const registry = allCapabilities();
  return {
    platform: registry.platform,
    native: registry.native,
    registry: registry.items,
    notifications: notifications.capability(),
    location: location.capability(),
    speech: speech.capability(),
    background: background.capability()
  };
}
