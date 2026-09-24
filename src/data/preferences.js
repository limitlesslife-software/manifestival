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
  /** Onko ensikäytön opastus nähty tällä laitteella. */
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
  automationLevel: 1
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


/**
 * Tyhjennä laitekohtaiset asetukset.
 * Kutsutaan uloskirjautumisessa, jotta seuraava käyttäjä samalla laitteella
 * ei peri edellisen tilaa.
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
