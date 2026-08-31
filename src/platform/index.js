// Alustasovittimet.
//
// MIKSI TÄMÄ ON OLEMASSA JO NYT
// Manifestivalin arvokkaimmat myöhemmät ominaisuudet — muistutukset oikeaan
// aikaan, lähtöajan ennakointi, puhekomento lukitulla puhelimella — eivät ole
// selaimen tavoitettavissa. Ne vaativat natiivikerroksen (ks.
// docs/ANDROID-STRATEGY.md).
//
// Jos sovelluslogiikka kutsuisi suoraan selaimen rajapintoja, natiiviversio
// vaatisi ydinsovelluksen uudelleenkirjoituksen. Siksi kaikki alustariippuvuus
// kulkee näiden sovittimien läpi jo nyt, vaikka toteutus on toistaiseksi vain
// web.
//
// TILA
//   notifications  web-toteutus OSITTAIN, natiivi PLANNED
//   location       PLANNED — rajapinta määritelty, ei toteutusta
//   speech         web-toteutus TOIMII (selaimen puheentunnistus)
//   background     PLANNED — selain ei pysty tähän lainkaan
//
// Sovittimet EIVÄT tee mitään ilman käyttäjän lupaa, ja jokainen kertoo
// rehellisesti, onko toiminto tuettu tällä alustalla. Kutsuja voi näin
// piilottaa ominaisuuden sen sijaan että se epäonnistuisi hiljaa.

/**
 * @typedef {object} Capability
 * @property {boolean} supported  Onko toiminto käytettävissä tällä alustalla
 * @property {string}  reason     Miksi ei, jos ei ole
 */

const NOT_IMPLEMENTED = Object.freeze({
  supported: false,
  reason: 'Vaatii natiivisovelluksen (ks. docs/ANDROID-STRATEGY.md)'
});

/** Ajetaanko natiivikuoren sisällä. Capacitor asettaa tämän globaalin. */
export function isNativeShell() {
  const cap = globalThis.Capacitor;
  return Boolean(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
}

/** Alustan nimi lokitusta ja ominaisuusvalintaa varten. */
export function platformName() {
  const cap = globalThis.Capacitor;
  if (cap && typeof cap.getPlatform === 'function') return cap.getPlatform();
  return 'web';
}

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
  /** @returns {Capability} */
  capability() {
    if (typeof Notification === 'undefined') {
      return { supported: false, reason: 'Selain ei tue ilmoituksia' };
    }
    return { supported: true, reason: '' };
  },

  /** Onko lupa jo myönnetty. */
  permission() {
    if (typeof Notification === 'undefined') return 'unsupported';
    return Notification.permission;
  },

  /**
   * Pyydä lupa. Kutsutaan VAIN käyttäjän eleestä — selaimet hylkäävät
   * muuten pyynnön ja käyttäjä menettää mahdollisuuden sanoa kyllä.
   * @returns {Promise<boolean>}
   */
  async requestPermission() {
    if (typeof Notification === 'undefined') return false;
    try {
      const result = await Notification.requestPermission();
      return result === 'granted';
    } catch {
      return false;
    }
  },

  /**
   * Ajastettu muistutus.
   *
   * TILA: PLANNED. Selaimen setTimeout ei selviä välilehden sulkemisesta
   * eikä puhelimen lukituksesta, joten luotettava ajastus vaatii
   * natiivikerroksen. Rajapinta on tässä, jotta kutsupaikkaa ei tarvitse
   * myöhemmin muuttaa.
   */
  async schedule() {
    return { ok: false, ...NOT_IMPLEMENTED };
  },

  /** Peru ajastettu muistutus. PLANNED. */
  async cancel() {
    return { ok: false, ...NOT_IMPLEMENTED };
  }
});

// ------------------------------------------------------------- sijainti

export const location = Object.freeze({
  /** @returns {Capability} */
  capability() {
    return { supported: false, reason: NOT_IMPLEMENTED.reason };
  },

  /**
   * Nykyinen sijainti. PLANNED.
   * Selaimen geolocation toimisi etualalla, mutta lähtöajan ennakointi vaatii
   * taustaseurannan, johon selain ei pysty.
   */
  async current() {
    return { ok: false, ...NOT_IMPLEMENTED };
  },

  /** Paikkaan sidottu muistutus. PLANNED. */
  async watchArrival() {
    return { ok: false, ...NOT_IMPLEMENTED };
  }
});

// --------------------------------------------------------------- puhe

export const speech = Object.freeze({
  /** @returns {Capability} */
  capability() {
    const ctor = typeof window !== 'undefined'
      ? (window.SpeechRecognition || window.webkitSpeechRecognition)
      : null;
    if (!ctor) {
      return {
        supported: false,
        reason: 'Selain ei tue puheentunnistusta — käytä kirjoituskenttää'
      };
    }
    return { supported: true, reason: '' };
  },

  /**
   * Toimiiko puhekomento sovelluksen ollessa suljettuna.
   * Selaimessa ei koskaan. Tämä on yksi natiivikerroksen tärkeimmistä syistä.
   */
  supportsBackgroundCapture() {
    return isNativeShell();
  }
});

// -------------------------------------------------------- taustatoiminta

export const background = Object.freeze({
  /** @returns {Capability} */
  capability() {
    return { supported: false, reason: NOT_IMPLEMENTED.reason };
  },

  /** Rekisteröi taustatehtävä. PLANNED. */
  async register() {
    return { ok: false, ...NOT_IMPLEMENTED };
  }
});

// ----------------------------------------------------- yhteenveto

/**
 * Kaikkien sovittimien tila yhtenä oliona.
 * Käyttöliittymä voi näyttää tämän asetuksissa, jotta käyttäjä tietää mitä
 * tällä alustalla oikeasti voi tehdä.
 */
export function capabilities() {
  return {
    platform: platformName(),
    native: isNativeShell(),
    notifications: notifications.capability(),
    location: location.capability(),
    speech: speech.capability(),
    background: background.capability()
  };
}
