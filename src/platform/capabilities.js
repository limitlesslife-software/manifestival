// Keskitetty kyvykkyysrekisteri.
//
// ONGELMA, JONKA TÄMÄ RATKAISEE
// Sovellus toimii kolmessa ympäristössä, joilla on eri kyvyt: selain
// työpöydällä, selain puhelimessa ja Capacitor-kuori. Ilman keskitettyä
// mallia jokainen näkymä alkaisi tehdä omia `if (window.Notification)`
// -tarkistuksiaan, ja ominaisuus epäonnistuisi eri tavoin eri paikoissa.
//
// PERIAATTEET
//   1. Kolme erillistä kysymystä — niitä ei saa sekoittaa:
//        supported   voiko tämä alusta tehdä tämän lainkaan?
//        permission  onko käyttäjä antanut luvan?
//        available   voiko tämän tehdä juuri nyt?
//   2. Lupaa EI koskaan pyydetä automaattisesti. Pyyntö vaatii käyttäjän eleen.
//   3. Toteuttamaton kyvykkyys kertoo sen rehellisesti eikä epäonnistu hiljaa.
//   4. Domain ei tunne tätä moduulia eikä Capacitoria.

export const CAPABILITY = Object.freeze({
  NOTIFICATIONS: 'notifications',
  SPEECH: 'speech',
  LOCATION: 'location',
  BACKGROUND: 'background',
  NETWORK: 'network',
  STORAGE: 'storage'
});

export const CAPABILITIES = Object.freeze(Object.values(CAPABILITY));

/** Lupatilat. Yhtenäinen kaikille kyvykkyyksille. */
export const PERMISSION = Object.freeze({
  /** Alusta ei tue tätä lainkaan. */
  UNSUPPORTED: 'unsupported',
  /** Lupaa ei ole vielä kysytty. */
  PROMPT: 'prompt',
  GRANTED: 'granted',
  DENIED: 'denied',
  /** Lupaa ei tarvita. */
  NOT_REQUIRED: 'not_required'
});

/** Ajetaanko natiivikuoren sisällä. */
export function isNativeShell() {
  const cap = globalThis.Capacitor;
  return Boolean(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
}

export function platformName() {
  const cap = globalThis.Capacitor;
  if (cap && typeof cap.getPlatform === 'function') return cap.getPlatform();
  return 'web';
}

const NATIVE_REQUIRED = 'Vaatii natiivisovelluksen (ks. docs/ANDROID-STRATEGY.md)';

// --------------------------------------------------------- tarkistimet

function notificationsSupport() {
  if (isNativeShell()) {
    return { supported: true, reason: '', implemented: false };
  }
  if (typeof Notification === 'undefined') {
    return { supported: false, reason: 'Selain ei tue ilmoituksia', implemented: false };
  }
  return { supported: true, reason: '', implemented: true };
}

function notificationsPermission() {
  if (typeof Notification === 'undefined') return PERMISSION.UNSUPPORTED;
  const value = Notification.permission;
  if (value === 'granted') return PERMISSION.GRANTED;
  if (value === 'denied') return PERMISSION.DENIED;
  return PERMISSION.PROMPT;
}

function speechSupport() {
  const ctor = typeof globalThis !== 'undefined'
    ? (globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition)
    : null;
  if (!ctor) {
    return {
      supported: false,
      reason: 'Selain ei tue puheentunnistusta — käytä kirjoituskenttää',
      implemented: false
    };
  }
  return { supported: true, reason: '', implemented: true };
}

function networkSupport() {
  return { supported: true, reason: '', implemented: true };
}

function networkAvailable() {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine !== false;
}

function storageSupport() {
  try {
    if (typeof globalThis === 'undefined' || !globalThis.localStorage) {
      return { supported: false, reason: 'Selaintallennus ei ole käytettävissä', implemented: false };
    }
    // Yksityinen ikkuna voi heittää vasta kirjoitettaessa.
    const probe = '__manifestival_probe__';
    globalThis.localStorage.setItem(probe, '1');
    globalThis.localStorage.removeItem(probe);
    return { supported: true, reason: '', implemented: true };
  } catch {
    return { supported: false, reason: 'Selain estää tallennuksen', implemented: false };
  }
}

/**
 * Kyvykkyysrekisteri.
 *
 * Jokainen merkintä kertoo, onko kyvykkyys alustan tukema JA onko se
 * tässä sovelluksessa toteutettu. Ero on olennainen: Android tukee
 * taustasijaintia, mutta Manifestival ei sitä vielä käytä.
 */
const REGISTRY = Object.freeze({
  [CAPABILITY.NOTIFICATIONS]: {
    label: 'Ilmoitukset',
    support: notificationsSupport,
    permission: notificationsPermission,
    plannedNote: 'Ajastetut muistutukset vaativat natiivikerroksen (WP12)'
  },
  [CAPABILITY.SPEECH]: {
    label: 'Puheentunnistus',
    support: speechSupport,
    permission: () => PERMISSION.PROMPT,
    plannedNote: 'Taustakuuntelu vaatii natiivikerroksen (WP12)'
  },
  [CAPABILITY.LOCATION]: {
    label: 'Sijainti',
    support: () => ({ supported: isNativeShell(), reason: NATIVE_REQUIRED, implemented: false }),
    permission: () => PERMISSION.UNSUPPORTED,
    plannedNote: 'Lähtöajan ennakointi (WP11)'
  },
  [CAPABILITY.BACKGROUND]: {
    label: 'Taustatoiminta',
    support: () => ({ supported: isNativeShell(), reason: NATIVE_REQUIRED, implemented: false }),
    permission: () => PERMISSION.UNSUPPORTED,
    plannedNote: 'Taustatehtävät (WP12)'
  },
  [CAPABILITY.NETWORK]: {
    label: 'Verkkoyhteys',
    support: networkSupport,
    permission: () => PERMISSION.NOT_REQUIRED,
    available: networkAvailable
  },
  [CAPABILITY.STORAGE]: {
    label: 'Laitetallennus',
    support: storageSupport,
    permission: () => PERMISSION.NOT_REQUIRED
  }
});

/**
 * Yhden kyvykkyyden tila.
 *
 * @returns {{name:string,label:string,supported:boolean,implemented:boolean,
 *            permission:string,available:boolean,reason:string,plannedNote:string}}
 */
export function capability(name) {
  const entry = REGISTRY[name];
  if (!entry) {
    return {
      name,
      label: name,
      supported: false,
      implemented: false,
      permission: PERMISSION.UNSUPPORTED,
      available: false,
      reason: 'Tuntematon kyvykkyys',
      plannedNote: ''
    };
  }

  const support = entry.support();
  const permission = entry.permission();
  const extraAvailable = entry.available ? entry.available() : true;

  return {
    name,
    label: entry.label,
    supported: support.supported,
    implemented: support.implemented,
    permission,
    // Käytettävissä juuri nyt: tuettu, toteutettu, lupa kunnossa ja
    // mahdollinen lisäehto (esim. verkkoyhteys) täyttyy.
    available: support.supported
      && support.implemented
      && extraAvailable
      && (permission === PERMISSION.GRANTED || permission === PERMISSION.NOT_REQUIRED),
    reason: support.reason || '',
    plannedNote: entry.plannedNote || ''
  };
}

/** Onko kyvykkyys käytettävissä juuri nyt. */
export function isAvailable(name) {
  return capability(name).available;
}

/** Onko alusta tukee kyvykkyyttä lainkaan. */
export function isSupported(name) {
  return capability(name).supported;
}

/** Lupatila. */
export function permissionOf(name) {
  return capability(name).permission;
}

/** Kaikkien kyvykkyyksien tila. Käyttöliittymä näyttää tämän asetuksissa. */
export function allCapabilities() {
  const result = { platform: platformName(), native: isNativeShell(), items: {} };
  for (const name of CAPABILITIES) result.items[name] = capability(name);
  return result;
}
