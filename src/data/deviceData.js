// Laitteen tila: mitä sovellus tallentaa tämän laitteen selaintallennukseen
// (localStorage) ja mitä sille tapahtuu uloskirjautuessa ja tilin poistossa.
//
// YKSI REKISTERI. tests/account-device-data.test.mjs käy läpi koko src/-
// hakemiston ja vaatii, että (1) jokainen siellä käytetty avainetuliite on
// tässä luettelossa, (2) jokainen selaintallennusta käyttävä moduuli on
// jonkin merkinnän omistaja ja (3) tilin poistossa poistettavat avaimet
// todella poistuvat purgeDeviceDataForUser():lla. Uusi laitteelle tallentava
// moduuli, jota ei lisätä tänne, kaataa testin -- muuten poistetun tilin
// data jäisi laitteelle hiljaa.
//
// ULOSKIRJAUTUMINEN VS. TILIN POISTO
//   Uloskirjautuminen EI poista käyttäjäkohtaisia avaimia (offline-jono,
//   ajastin, lähtökori): lähettämättömät muutokset lähetetään, kun sama
//   käyttäjä kirjautuu takaisin, eikä toinen käyttäjä osu niihin (avain ja
//   sisältö ovat käyttäjäkohtaisia). Laitekohtaiset asetukset tyhjennetään.
//   Tilin poisto poistaa kaiken: tiliä ei ole, eikä kukaan voi enää
//   lähettää sen muutoksia.
//
// Muistissa elävä tila (tilan kokoelmat, repositorioiden muistivarastot,
// sijainti, offline-jonon muistikopio) ei kuulu tänne: se tyhjennetään
// uloskirjautumisen siivouksessa (src/app/main.js onSignedOut).

import { purgeQueue } from './offlineQueueStore.js';
import { purgeTimerData } from './timerStore.js';
import { clearDevicePreferences, purgeUserPreferences } from './preferences.js';
import { clearSchemaCache } from './schemaProbe.js';
import { purgeAckState } from './alarmAckStore.js';
import { purgeOutbox } from './dailyLifeOutboxStore.js';

/** Mitä merkinnälle tapahtuu. */
export const DEVICE_ACTION = Object.freeze({
  /** Säilyy (käyttäjäkohtainen avain, lähetetään kun sama käyttäjä palaa). */
  KEEP: 'keep',
  /** Tyhjennetään kaikilta (laitekohtainen, ei käyttäjää avaimessa). */
  CLEAR: 'clear',
  /** Poistetaan tämän käyttäjän avain. */
  PURGE: 'purge',
  /** Ei pysyvää tilaa, jota tarvitsisi poistaa. */
  NONE: 'none'
});

const entry = fields => Object.freeze(fields);

/**
 * Jokainen tämän sovelluksen selaintallennuksen avain.
 *
 * `prefix` on avaimen alku (käyttäjäkohtaisissa avain on prefix + userId),
 * `owner` moduuli, joka avainta käsittelee, `contains` mitä siinä on.
 */
export const DEVICE_STORAGE = Object.freeze([
  entry({
    prefix: 'manifestival.offlineQueue.v1.',
    owner: 'src/data/offlineQueueStore.js',
    contains: 'Lähettämättömät tehtävämuutokset (kentät, ei tokeneita)',
    onSignOut: DEVICE_ACTION.KEEP,
    onDelete: DEVICE_ACTION.PURGE
  }),
  entry({
    prefix: 'manifestival.timer.v1.',
    owner: 'src/data/timerStore.js',
    contains: 'Käynnissä olevan ajastimen aikaleimat ja kohteen tunniste',
    onSignOut: DEVICE_ACTION.KEEP,
    onDelete: DEVICE_ACTION.PURGE
  }),
  entry({
    prefix: 'manifestival.timeOutbox.v1.',
    owner: 'src/data/timerStore.js',
    contains: 'Lähettämättömät aikakirjaukset (myös muistiinpano)',
    onSignOut: DEVICE_ACTION.KEEP,
    onDelete: DEVICE_ACTION.PURGE
  }),
  entry({
    prefix: 'manifestival.timerTombstones.v1.',
    owner: 'src/data/timerStore.js',
    contains: 'Poistettujen ajastimien tunnisteet',
    onSignOut: DEVICE_ACTION.KEEP,
    onDelete: DEVICE_ACTION.PURGE
  }),
  entry({
    prefix: 'manifestival.timerPending.v1.',
    owner: 'src/data/timerStore.js',
    contains: 'Kirjaamattomat ajastimet, jotka jäivät odottamaan toisen laitteen ajastimen vuoksi',
    onSignOut: DEVICE_ACTION.KEEP,
    onDelete: DEVICE_ACTION.PURGE
  }),
  entry({
    prefix: 'manifestival.alarmAcks.v1.',
    owner: 'src/data/alarmAckStore.js',
    contains: 'Herätysten ja puhuttujen muistutusten kuittaukset, torkut ja hylkäykset (avain ja '
      + 'aikaleimat) sekä laitteelle ajastettujen merkintöjen tunnisteet (menon ja paikan tunniste, '
      + 'päivä, lähtöaika). Ei otsikoita, osoitteita eikä sijaintia',
    // Uloskirjautuminen perii laitteen herätykset: kuittauksilla ei ole enää kohdetta.
    onSignOut: DEVICE_ACTION.CLEAR,
    onDelete: DEVICE_ACTION.PURGE
  }),
  entry({
    prefix: 'manifestival.dailyLifeOutbox.v1.',
    owner: 'src/data/dailyLifeOutboxStore.js',
    contains: 'Lähettämättömät menojen tallennukset ja tapakirjaukset (kentät, ei tokeneita). '
      + 'Lähetetään, kun sama käyttäjä on taas verkossa',
    onSignOut: DEVICE_ACTION.KEEP,
    onDelete: DEVICE_ACTION.PURGE
  }),
  entry({
    prefix: 'manifestival:',
    owner: 'src/data/preferences.js',
    contains: 'Laitekohtaiset asetukset (DEVICE_DEFAULTS)',
    onSignOut: DEVICE_ACTION.CLEAR,
    onDelete: DEVICE_ACTION.CLEAR
  }),
  entry({
    prefix: 'manifestival.userPrefs.v1.',
    owner: 'src/data/preferences.js',
    contains: 'Käyttäjäkohtaiset liput (USER_DEFAULTS): ensikäytön opastus nähty, '
      + 'Suunnan aloituksen ohitetut vaiheet. Ei käyttäjän kirjoittamaa tekstiä',
    onSignOut: DEVICE_ACTION.KEEP,
    onDelete: DEVICE_ACTION.PURGE
  }),
  entry({
    prefix: 'manifestival.schemaCompat.v1.',
    owner: 'src/data/schemaProbe.js',
    contains: 'Viimeisimmän skeematarkistuksen tulos tälle käännökselle ja palvelimelle '
      + '(migraatiotunnisteet, ei käyttäjän dataa eikä käyttäjätunnusta)',
    onSignOut: DEVICE_ACTION.KEEP,
    onDelete: DEVICE_ACTION.CLEAR
  }),
  entry({
    prefix: '__manifestival_probe__',
    owner: 'src/platform/capabilities.js',
    contains: 'Tallennuskokeilu: kirjoitetaan ja poistetaan heti',
    onSignOut: DEVICE_ACTION.NONE,
    onDelete: DEVICE_ACTION.NONE
  }),
  entry({
    prefix: 'manifestival.authNote.v1',
    owner: 'src/data/deviceData.js',
    contains: 'Kirjautumisportin kertaluonteinen viesti tilin poiston tuloksesta (vakioteksti, '
      + 'ei käyttäjän dataa eikä käyttäjätunnusta). Kirjoitetaan vain uloskirjautumisen '
      + 'varapolulla ennen uudelleenlatausta (saveAuthNote); kirjautumisportti lukee ja '
      + 'poistaa sen heti (takeAuthNote)',
    onSignOut: DEVICE_ACTION.NONE,
    onDelete: DEVICE_ACTION.NONE
  }),
  entry({
    prefix: 'sb-',
    owner: 'src/data/deviceData.js',
    contains: 'Kirjautumisistunto (supabase-js:n oma avain sb-<projekti>-auth-token). '
      + 'supabase-js kirjoittaa ja poistaa sen; tämä moduuli poistaa sen vain, '
      + 'jos uloskirjautuminen epäonnistuu (clearAuthSession)',
    onSignOut: DEVICE_ACTION.CLEAR,
    onDelete: DEVICE_ACTION.CLEAR
  })
]);

/**
 * Tilin poisto: poista laitteelta kaikki poistetun käyttäjän tallennettu
 * data ja laitekohtaiset asetukset.
 *
 * Kutsutaan vasta, kun palvelin on vahvistanut poiston. Tuntematon tai
 * kelvoton tunniste ei poista mitään käyttäjäkohtaista (avainfunktiot
 * hylkäävät sen), mutta asetukset tyhjennetään silti.
 */
export function purgeDeviceDataForUser(userId) {
  purgeQueue(userId);
  purgeAckState(userId);
  purgeOutbox(userId);
  purgeTimerData(userId);
  purgeUserPreferences(userId);
  clearDevicePreferences();
  clearSchemaCache();
}

/** supabase-js v2:n istuntoavain (+ PKCE-vahvistin) ja v1:n vanha avain. */
const AUTH_SESSION_KEY = /^(?:sb-[A-Za-z0-9-]+-auth-token(?:-code-verifier)?|supabase\.auth\.token)$/;

function storage() {
  try {
    return typeof globalThis !== 'undefined' && globalThis.localStorage ? globalThis.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Poista kirjautumisistunto laitteelta ilman palvelinta.
 *
 * VAIN VARAPOLKU. Tavallisesti supabase-js poistaa istunnon itse
 * uloskirjautuessa. Jos se epäonnistuu (verkkovirhe tilin poiston jälkeen),
 * istunto jäisi laitteelle ja uudelleenlataus palauttaisi poistetun tilin
 * istunnon. Palauttaa poistettujen avainten määrän; ei koskaan heitä.
 */
export function clearAuthSession() {
  const store = storage();
  if (!store) return 0;
  const keys = [];
  try {
    for (let index = 0; index < store.length; index++) {
      const key = store.key(index);
      if (typeof key === 'string' && AUTH_SESSION_KEY.test(key)) keys.push(key);
    }
  } catch {
    return 0;
  }
  let removed = 0;
  for (const key of keys) {
    try {
      store.removeItem(key);
      removed += 1;
    } catch { /* yksittäisen avaimen poiston epäonnistuminen ei estä muita */ }
  }
  return removed;
}

/** Kirjautumisportin kertaluonteinen viesti (ks. DEVICE_STORAGE). */
const AUTH_NOTE_KEY = 'manifestival.authNote.v1';
/** Viestit ovat sovelluksen omia vakiolauseita; pidempi arvo ei ole meidän. */
const AUTH_NOTE_MAX_LENGTH = 500;

/**
 * Säilytä kirjautumisportin viesti sivun uudelleenlatauksen yli.
 *
 * VAIN VARAPOLKU. Tilin poiston jälkeen epäonnistunut uloskirjautuminen
 * siivoaa laitteen itse ja lataa sivun uudelleen, mikä hävittäisi
 * muistissa jonottavan viestin ("tili on poistettu" / "jälkitarkistus jäi
 * kesken"). Viestissä ei ole käyttäjän dataa eikä tunnistetta. Palauttaa
 * true, jos tallennus onnistui; ei koskaan heitä.
 */
export function saveAuthNote(message) {
  const store = storage();
  if (!store || typeof message !== 'string' || !message || message.length > AUTH_NOTE_MAX_LENGTH) return false;
  try {
    store.setItem(AUTH_NOTE_KEY, message);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lue ja poista kirjautumisportin viesti (kertaluonteinen). Palauttaa
 * tekstin tai null; ei koskaan heitä. Kelvoton arvo poistetaan näyttämättä.
 */
export function takeAuthNote() {
  const store = storage();
  if (!store) return null;
  let value = null;
  try {
    value = store.getItem(AUTH_NOTE_KEY);
  } catch {
    return null;
  }
  if (value == null) return null;
  try {
    store.removeItem(AUTH_NOTE_KEY);
  } catch { /* näytetään silti; seuraava portti yrittää poistaa uudelleen */ }
  return typeof value === 'string' && value && value.length <= AUTH_NOTE_MAX_LENGTH ? value : null;
}
