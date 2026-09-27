// Asetusten perusta.
//
// Asetukset jaetaan kahteen selvästi eri asiaan:
//
//   LAITEKOHTAISET (tässä tiedostossa)
//     Elävät selaimen localStoragessa. Koskevat vain tätä laitetta eivätkä
//     seuraa käyttäjää mukana. Esim. mikä välilehti oli auki viimeksi.
//     Näiden katoaminen ei ole tietohäviö.
//
//   TILIKOHTAISET (myöhemmin profile-tauluun)
//     Seuraavat käyttäjää laitteesta toiseen: kieli, ilmoitusasetukset,
//     AI-preferenssit, suunnittelun oletukset. Nämä vaativat migraation,
//     joten tässä on toistaiseksi vain muoto ja oletukset — ks. ACCOUNT_DEFAULTS.
//
// localStorage voi heittää poikkeuksen (yksityinen ikkuna, estetty
// evästeasetus), joten jokainen käyttö on suojattu. Asetusten puuttuminen ei
// koskaan saa kaataa sovellusta.

const STORAGE_PREFIX = 'manifestival:';

/** Laitekohtaisten asetusten oletukset. */
export const DEVICE_DEFAULTS = Object.freeze({
  /**
   * VANHA laitekohtainen merkintä ensikäytön opastuksesta. Luetaan vain
   * siirtymässä (src/app/onboarding.js): merkintä on nyt käyttäjäkohtainen
   * (USER_DEFAULTS), koska tämä tyhjeni jokaisessa uloskirjautumisessa.
   */
  onboardingCompleted: false,
  /** Mikä välilehti oli viimeksi auki. */
  lastScreen: 'screen-today',

  /**
   * Automaatiotaso: mitä suunnittelija saa tehdä kysymättä.
   *
   * LAITEKOHTAINEN EIKÄ TILIKOHTAINEN — toistaiseksi.
   *
   * Tilikohtainen olisi oikeampi (asetus koskee käyttäjää, ei laitetta),
   * mutta se vaatii sarakkeen `profile`-tauluun eli migraation 0010.
   * Laitekohtainen toimii tänään ja EPÄONNISTUU TURVALLISESTI: uusi
   * laite alkaa tasolta 1, eli varovaisimmasta.
   *
   * Väärä suunta olisi ollut jättää asetus kokonaan pois kunnes
   * migraatio on ajettu — silloin käyttäjä ei voisi valita lainkaan, ja
   * valitsematta jättäminen on itsessään valinta.
   *
   * Ks. src/domain/automation.js ja migraatio 0010.
   */
  automationLevel: 1,

  /**
   * Kysytäänkö tehtävän valmistuessa "Kirjataanko käytetty aika?".
   * Laitekohtainen: käyttäjä voi mykistää kysymyksen dialogista.
   */
  askTimeOnComplete: true
});

/**
 * Tilikohtaisten asetusten oletukset.
 *
 * TILA: PLANNED. Muoto on määritelty, mutta näitä ei vielä tallenneta
 * mihinkään — se vaatii migraation profile-tauluun. Rakenne on tässä, jotta
 * myöhempi toteutus ei vaadi käyttöliittymän uudelleenkirjoitusta.
 */
export const ACCOUNT_DEFAULTS = Object.freeze({
  language: 'fi',
  notifications: Object.freeze({
    enabled: false,
    dailyPlanReminder: null,
    departureAlerts: false
  }),
  planning: Object.freeze({
    autoScheduleSuggestions: true,
    weekStartsOn: 'monday',
    /** Ks. DEVICE_DEFAULTS.automationLevel — tämä on sen tilikohtainen koti. */
    automationLevel: 1,
    /** Osuus vapaasta ajasta, joka jätetään suunnittelematta. */
    planningBufferRatio: 0.25
  }),
  ai: Object.freeze({
    voiceInputEnabled: true,
    autoAcceptHighConfidence: false
  })
});

function storage() {
  try {
    if (typeof globalThis === 'undefined' || !globalThis.localStorage) return null;
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/** Lue laitekohtainen asetus. Palauttaa oletuksen, jos lukeminen ei onnistu. */
export function getDevicePreference(key) {
  const fallback = DEVICE_DEFAULTS[key];
  const store = storage();
  if (!store) return fallback;
  try {
    const raw = store.getItem(STORAGE_PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Kirjoita laitekohtainen asetus. Epäonnistuminen ei ole virhe. */
export function setDevicePreference(key, value) {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}


// ------------------------------------------------ käyttäjäkohtaiset merkinnät
//
// Muutama laitteen muistama asia koskee KÄYTTÄJÄÄ eikä laitetta: onko hän
// nähnyt ensikäytön opastuksen ja mitkä Suunnan aloituksen vaiheet hän on
// itse ohittanut. Laitekohtaisina ne tyhjenivät jokaisessa
// uloskirjautumisessa (opastus näkyi taas, CRIT-06), ja toinen käyttäjä
// samalla laitteella olisi perinyt ne. Siksi avain on käyttäjäkohtainen:
//
//   manifestival.userPrefs.v1.<käyttäjätunnus>
//
// Uloskirjautuminen SÄILYTTÄÄ merkinnän (kuten lähtökorin), tilin poisto
// POISTAA sen (purgeUserPreferences, src/data/deviceData.js). Sisältö on
// lippuja, vaiheiden nimiä ja yksi oma luku (harkinnanvarainen
// kuukausiraja sentteinä ja valuuttakoodi) — ei käyttäjän kirjoittamaa
// vapaata tekstiä.

const USER_PREFIX = 'manifestival.userPrefs.v1.';
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Käyttäjäkohtaisten merkintöjen oletukset. Vain nämä avaimet kelpaavat. */
export const USER_DEFAULTS = Object.freeze({
  /** Onko tämä käyttäjä nähnyt ensikäytön opastuksen tällä laitteella. */
  onboardingCompleted: false,
  /**
   * Suunnan aloitus: käyttäjän ohittamat vaiheet ja tieto siitä, että
   * aloitus on kertaalleen käyty loppuun. Vaiheen valmius päätellään
   * tiedoista (src/domain/alignmentSetup.js), ei tästä.
   */
  suuntaSetup: Object.freeze({ skipped: Object.freeze([]), completed: false }),
  /** Profiilin Aloitusasetukset-lista piilotettu (views/setupChecklist.js). Tila tulee tiedoista. */
  setupChecklistHidden: false,
  /**
   * Oma harkinnanvarainen kuukausiraja (harrastukset, ostokset, viihde):
   * { minor, currency } tai null = ei asetettu. Vertailukohta
   * moneyAlignment.discretionaryStatus-laskulle (Talous → Budjetti ja
   * viikkokatsauksen Arki-osio).
   *
   * LAITTEELLA EIKÄ TILILLÄ — toistaiseksi. Tilikohtainen koti olisi
   * life_settings-sarake, joka vaatii migraation; sama perustelu kuin
   * DEVICE_DEFAULTS.automationLevel: raja toimii tänään, ja uusi laite
   * EPÄONNISTUU TURVALLISESTI (ei rajaa = ei vertailua). Lukija
   * tarkistaa muodon (src/app/views/discretionaryLimit.js).
   */
  discretionaryLimit: null
});

function userKey(userId) {
  const id = userId == null ? '' : String(userId);
  return USER_ID_PATTERN.test(id) ? USER_PREFIX + id : null;
}

function readUserRecord(store, key) {
  try {
    const raw = store.getItem(key);
    const parsed = raw === null ? null : JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Lue käyttäjäkohtainen merkintä. Tuntematon käyttäjä tai virhe -> oletus. */
export function getUserPreference(userId, key) {
  const fallback = USER_DEFAULTS[key];
  const store = storage();
  const storageKey = userKey(userId);
  if (!store || !storageKey || !Object.prototype.hasOwnProperty.call(USER_DEFAULTS, key)) return fallback;
  const record = readUserRecord(store, storageKey);
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : fallback;
}

/** Kirjoita käyttäjäkohtainen merkintä. Epäonnistuminen ei ole virhe. */
export function setUserPreference(userId, key, value) {
  const store = storage();
  const storageKey = userKey(userId);
  if (!store || !storageKey || !Object.prototype.hasOwnProperty.call(USER_DEFAULTS, key)) return false;
  try {
    const record = readUserRecord(store, storageKey);
    record[key] = value;
    store.setItem(storageKey, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** Tilin poisto: tämän käyttäjän merkinnät pois. Muiden merkinnät säilyvät. */
export function purgeUserPreferences(userId) {
  const store = storage();
  const storageKey = userKey(userId);
  if (!store || !storageKey) return;
  try {
    store.removeItem(storageKey);
  } catch {
    // Poiston epäonnistuminen ei kaada tilin poiston siivousta.
  }
}

/**
 * Tyhjennä laitekohtaiset asetukset.
 * Kutsutaan uloskirjautumisessa, jotta seuraava käyttäjä samalla laitteella
 * ei peri edellisen tilaa. Käyttäjäkohtaiset merkinnät (yllä) säilyvät.
 */
export function clearDevicePreferences() {
  const store = storage();
  if (!store) return;
  for (const key of Object.keys(DEVICE_DEFAULTS)) {
    try {
      store.removeItem(STORAGE_PREFIX + key);
    } catch {
      // Yksittäisen avaimen poiston epäonnistuminen ei estä muita.
    }
  }
}
