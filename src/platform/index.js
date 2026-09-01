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
  CAPABILITY, CAPABILITIES, PERMISSION,
  capability, isAvailable, isSupported, permissionOf, allCapabilities,
  isNativeShell, platformName
} from './capabilities.js';
import * as notificationPlatform from './notifications.js';

export {
  CAPABILITY, CAPABILITIES, PERMISSION,
  capability, isAvailable, isSupported, permissionOf,
  isNativeShell, platformName
};

const NOT_IMPLEMENTED = Object.freeze({
  supported: false,
  reason: 'Vaatii natiivisovelluksen (ks. docs/ANDROID-STRATEGY.md)'
});

/**
 * Tuotannon osoite. Tarvitaan VAIN natiivikuoressa.
 *
 * Webissä sovellus tarjoillaan samasta originista kuin /api/parse, joten
 * suhteellinen polku riittää. Natiivikuoressa sivu ladataan laitteen omasta
 * tiedostojärjestelmästä (capacitor://localhost), jolloin suhteellinen polku
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
  showNow: notificationPlatform.showNow,
  schedule: notificationPlatform.schedule,
  cancel: notificationPlatform.cancelAll,
  describeSupport: notificationPlatform.describeSupport
});

// ------------------------------------------------------------- sijainti

export const location = Object.freeze({
  capability() {
    const state = capability(CAPABILITY.LOCATION);
    return { supported: state.implemented, reason: state.reason || NOT_IMPLEMENTED.reason };
  },
  /** PLANNED (WP11). */
  async current() {
    return { ok: false, ...NOT_IMPLEMENTED };
  },
  /** PLANNED (WP11). */
  async watchArrival() {
    return { ok: false, ...NOT_IMPLEMENTED };
  }
});

// ----------------------------------------------------------------- puhe

export const speech = Object.freeze({
  capability() {
    const state = capability(CAPABILITY.SPEECH);
    return { supported: state.supported && state.implemented, reason: state.reason };
  },
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
  capability() {
    const state = capability(CAPABILITY.BACKGROUND);
    return { supported: state.implemented, reason: state.reason || NOT_IMPLEMENTED.reason };
  },
  /** PLANNED (WP12). */
  async register() {
    return { ok: false, ...NOT_IMPLEMENTED };
  }
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
