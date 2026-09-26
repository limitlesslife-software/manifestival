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

/**
 * Yksi ainoa teksti natiivivaatimukselle.
 *
 * Vietynä siksi, ettei sama lause eläisi kahtena kopiona kahdessa
 * tiedostossa — silloin ne erkanisivat ensimmäisessä muutoksessa.
 */
export const NATIVE_REQUIRED = 'Vaatii natiivisovelluksen (ks. docs/ANDROID-STRATEGY.md)';

// --------------------------------------------------------- tarkistimet

/**
 * Natiiviliitännäisen tila luetaan globaalista Capacitor-rekisteristä.
 *
 * Tätä ei importoida nativeNotifications.js:stä, koska se importoi tämän —
 * vastakkainen suunta olisi sykli, jonka arkkitehtuuritesti hylkäisi.
 * Tarkistus on niin pieni, että sen toistaminen on halvempaa.
 */
function nativeNotificationsPlugin() {
  const capacitor = globalThis.Capacitor;
  if (!capacitor || typeof capacitor.isNativePlatform !== 'function') return null;
  if (!capacitor.isNativePlatform()) return null;
  const plugins = capacitor.Plugins;
  return (plugins && plugins.LocalNotifications) || null;
}

/**
 * Natiivin lupatilan välimuisti.
 *
 * Selaimessa lupatila on luettavissa synkronisesti (`Notification.permission`),
 * natiivikuoressa vain asynkronisesti. Koska capability() on synkroninen,
 * natiivitila pidetään täällä ja natiivisovitin työntää sen tänne
 * nimenomaisesta kutsusta.
 *
 * Alkuarvo on PROMPT eikä koskaan GRANTED: väärä "lupa on" saisi sovelluksen
 * luulemaan lähettävänsä ilmoituksia, joita kukaan ei näe.
 */
let nativePermissionState = PERMISSION.PROMPT;

/** Päivitä natiivin lupatilan välimuisti. Kutsuu vain natiivisovitin. */
export function setNativePermission(state) {
  const allowed = [PERMISSION.PROMPT, PERMISSION.GRANTED, PERMISSION.DENIED];
  nativePermissionState = allowed.includes(state) ? state : PERMISSION.PROMPT;
}

/** Nollaa natiivin lupavälimuisti. Uloskirjautuminen ja testit. */
export function resetNativePermission() {
  nativePermissionState = PERMISSION.PROMPT;
}

/**
 * Sijaintiluvan tila. Rikas tila (not_requested, prompt, granted, denied,
 * blocked, error, unsupported) elää src/platform/geolocation.js:ssä; sieltä
 * se työnnetään tänne, koska capability() on synkroninen eikä tämä
 * moduuli saa tuoda geolocation.js:ää (se tuo tämän -- sykli).
 *
 * Alkuarvo on "ei pyydetty", ei koskaan "myönnetty".
 */
const LOCATION_STATES = Object.freeze(['unsupported', 'not_requested', 'prompt', 'granted', 'denied', 'blocked', 'error']);
let locationPermissionState = 'not_requested';

/** Päivitä sijaintiluvan välimuisti. Kutsuu vain geolocation.js. */
export function setLocationPermissionState(state) {
  locationPermissionState = LOCATION_STATES.includes(state) ? state : 'error';
}

/**
 * Natiivisijainti Android-sovelluksessa: POIS KÄYTÖSTÄ.
 *
 * Mikään toteutettu ominaisuus ei käytä sijaintia: matka ja lähtöaika
 * toimivat paikannimillä ja käyttäjän antamalla kestolla, eikä
 * paikkamuistutuksia arvioida. Siksi Android-manifesti ei julista
 * sijaintilupaa lainkaan, ja tämä lippu pitää JS-puolen samassa linjassa:
 * natiivikuoressa sijaintisovitinta ei valita, Profiili näyttää vain syyn
 * eikä "Salli sijainti" -painiketta, jonka pyyntö kaatuisi puuttuvaan
 * manifestilupaan.
 *
 * Selaimen (PWA) kertahaku ei tarvitse manifestilupaa, joten se säilyy.
 *
 * JOS TÄMÄ KÄÄNNETÄÄN TODEKSI, manifestiin on lisättävä likimääräinen
 * sijaintilupa ja android.hardware.location required="false"
 * (tests/android.test.mjs vartioi molempia).
 */
export const NATIVE_LOCATION_ENABLED = false;

function locationSupport() {
  if (isNativeShell()) {
    if (!NATIVE_LOCATION_ENABLED) {
      return {
        supported: true,
        reason: 'Mikään toiminto ei vielä tarvitse sijaintia, joten sovellus ei pyydä sijaintilupaa.',
        implemented: false
      };
    }
    const plugins = globalThis.Capacitor && globalThis.Capacitor.Plugins;
    const available = Boolean(plugins && plugins.Geolocation);
    return {
      supported: true,
      reason: available ? '' : 'Sijaintiliitännäistä ei ole rekisteröity tähän kuoreen',
      implemented: available
    };
  }
  const geolocation = typeof navigator !== 'undefined' ? navigator.geolocation : null;
  if (geolocation && typeof geolocation.getCurrentPosition === 'function') {
    return { supported: true, reason: '', implemented: true };
  }
  return {
    supported: false,
    reason: 'Selain ei tue sijaintia. ' + NATIVE_REQUIRED,
    implemented: false
  };
}

function locationPermission() {
  if (!locationSupport().supported) return PERMISSION.UNSUPPORTED;
  if (locationPermissionState === 'granted') return PERMISSION.GRANTED;
  if (locationPermissionState === 'denied' || locationPermissionState === 'blocked') return PERMISSION.DENIED;
  return PERMISSION.PROMPT;
}

function notificationsSupport() {
  if (isNativeShell()) {
    // Android tukee ilmoituksia aina. Toteutus riippuu siitä, onko Local
    // Notifications -liitännäinen rekisteröity tähän kuoreen.
    const available = nativeNotificationsPlugin() !== null;
    return {
      supported: true,
      reason: available ? '' : 'Ilmoitusliitännäistä ei ole rekisteröity tähän kuoreen',
      implemented: available
    };
  }
  if (typeof Notification === 'undefined') {
    return { supported: false, reason: 'Selain ei tue ilmoituksia', implemented: false };
  }
  return { supported: true, reason: '', implemented: true };
}

function notificationsPermission() {
  if (isNativeShell()) {
    if (!nativeNotificationsPlugin()) return PERMISSION.UNSUPPORTED;
    return nativePermissionState;
  }
  if (typeof Notification === 'undefined') return PERMISSION.UNSUPPORTED;
  const value = Notification.permission;
  if (value === 'granted') return PERMISSION.GRANTED;
  if (value === 'denied') return PERMISSION.DENIED;
  return PERMISSION.PROMPT;
}

/**
 * Android-sovelluksen oma puheliitännäinen (android/app/src/main/java/
 * fi/limitlesslife/manifestival/SpeechPlugin.java, @CapacitorPlugin-nimi).
 *
 * Nimi on tässä eikä speech.js:ssä samasta syystä kuin ilmoitusliitännäisen
 * tarkistus yllä: speech.js tuo tämän moduulin, joten vastakkainen suunta
 * olisi sykli. tests/android.test.mjs vertaa nimeä Java-annotaatioon.
 */
export const NATIVE_SPEECH_PLUGIN = 'ManifestivalSpeech';

/** Puheliitännäinen natiivikuoresta, tai null. Ei kutsu liitännäistä. */
export function nativeSpeechPlugin() {
  if (!isNativeShell()) return null;
  const plugins = globalThis.Capacitor.Plugins;
  const plugin = plugins && plugins[NATIVE_SPEECH_PLUGIN];
  return plugin && typeof plugin.listen === 'function' ? plugin : null;
}

/**
 * Mikrofoniluvan välimuisti. Sama periaate kuin ilmoitusluvassa:
 * capability() on synkroninen, luku laitteelta asynkroninen, joten
 * src/platform/speech.js työntää viimeksi nähdyn tilan tänne.
 * Alkuarvo on PROMPT, ei koskaan GRANTED.
 */
let speechPermissionState = PERMISSION.PROMPT;

/** Päivitä mikrofoniluvan välimuisti. Kutsuu vain speech.js. */
export function setSpeechPermissionState(state) {
  const allowed = [PERMISSION.PROMPT, PERMISSION.GRANTED, PERMISSION.DENIED];
  speechPermissionState = allowed.includes(state) ? state : PERMISSION.PROMPT;
}

/** Nollaa mikrofoniluvan välimuisti. Testit. */
export function resetSpeechPermissionState() {
  speechPermissionState = PERMISSION.PROMPT;
}

function speechSupport() {
  if (isNativeShell()) {
    // WebView'n SpeechRecognitionia EI lasketa tueksi: Capacitor hylkää sen
    // mikrofonipyynnön, ja virhe näyttäisi selaimen virheeltä. Android-
    // sovelluksessa puhe kulkee vain omalla liitännäisellä.
    const plugin = nativeSpeechPlugin();
    return {
      supported: true,
      reason: plugin ? '' : 'Puheentunnistus ei ole käytettävissä tässä Android-sovelluksen versiossa. Kirjoita komento.',
      implemented: Boolean(plugin)
    };
  }
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

/** Lupaa ei voi olla "kysymättä", jos kuuntelu ei ole edes mahdollista. */
function speechPermission() {
  const support = speechSupport();
  if (!support.supported || !support.implemented) return PERMISSION.UNSUPPORTED;
  return speechPermissionState;
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
    plannedNote: 'Ajastetut muistutukset toimivat vain Android-sovelluksessa'
  },
  [CAPABILITY.SPEECH]: {
    label: 'Puheentunnistus',
    support: speechSupport,
    permission: speechPermission,
    // Näkyy vain, kun alusta tukee puhetta mutta tämä versio ei sitä
    // toteuta (Android-kuori ilman puheliitännäistä). Ei lupausta
    // taustakuuntelusta: sitä ei ole eikä tule.
    plannedNote: 'Vaatii sovellusversion, jossa on puheliitännäinen. Kirjoittaminen toimii aina.'
  },
  [CAPABILITY.LOCATION]: {
    label: 'Sijainti',
    support: locationSupport,
    permission: locationPermission,
    plannedNote: 'Ei käytössä tässä sovellusversiossa (ei taustaseurantaa)'
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

/** Tukeeko alusta kyvykkyyttä lainkaan — riippumatta luvasta tai toteutuksesta. */
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
