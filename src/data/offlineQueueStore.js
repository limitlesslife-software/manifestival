// Offline-jonon tallennus: yksi avain per käyttäjä.
//
// MITÄ TÄNNE TALLENTUU: vain lähettämättömät tehtävämuutokset (kentät,
// jotka domain/offlineQueue.js sallii). Ei tokeneita, ei avaimia, ei
// sähköpostia, ei user_id:tä sisällössä. Käyttäjän oma tehtävätieto on
// kuitenkin sisältöä: se on laitteella kunnes se on lähetetty tai
// käyttäjä hylkää sen. Siksi:
//
//   - avain on käyttäjäkohtainen (userId), joten toisen käyttäjän jono
//     ei koskaan osu tämän käyttäjän lukuun -- ja parseQueue tarkistaa
//     userId:n vielä sisällöstäkin
//   - tilin poisto tyhjentää jonon (purge)
//   - tallennus voi epäonnistua (yksityinen ikkuna, kiintiö): silloin
//     jono elää vain muistissa ja `persistent: false` kerrotaan
//     käyttäjälle -- ei väitetä säilyvän jos se ei säily

const PREFIX = 'manifestival.offlineQueue.v1.';
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Varamuisti, kun localStorage ei ole käytettävissä. */
const memory = new Map();

function storage() {
  try {
    return typeof globalThis !== 'undefined' && globalThis.localStorage ? globalThis.localStorage : null;
  } catch {
    return null;
  }
}

export function queueKey(userId) {
  const id = userId == null ? '' : String(userId);
  return USER_ID_PATTERN.test(id) ? PREFIX + id : null;
}

/** Lue tallennettu teksti. null jos ei ole tai avain on kelvoton. */
export function loadQueueText(userId) {
  const key = queueKey(userId);
  if (!key) return null;
  // Muistikopio ENSIN (F12): se on olemassa vain, kun viimeisin tallennus
  // ei mennyt localStorageen (kiintiö, yksityinen tila). Silloin
  // localStorageen jäänyt teksti on VANHEMPI jono, ja sen lukeminen
  // palauttaisi jo lähetetyt tai hävittäisi uudet operaatiot.
  if (memory.has(key)) return memory.get(key);
  try {
    const store = storage();
    if (store) return store.getItem(key);
  } catch { /* ei luettavissa */ }
  return null;
}

/** @returns {{ok:boolean, persistent:boolean}} */
export function saveQueueText(userId, text) {
  const key = queueKey(userId);
  if (!key) return { ok: false, persistent: false };
  try {
    const store = storage();
    if (store) {
      store.setItem(key, text);
      memory.delete(key);
      return { ok: true, persistent: true };
    }
  } catch { /* kiintiö tai yksityinen tila */ }
  memory.set(key, text);
  return { ok: true, persistent: false };
}

/** Poista käyttäjän jono. Tilin poisto ja käyttäjän oma hylkäys. */
export function purgeQueue(userId) {
  const key = queueKey(userId);
  if (!key) return;
  memory.delete(key);
  try {
    const store = storage();
    if (store) store.removeItem(key);
  } catch { /* ei mitään poistettavaa */ }
}

/** Testejä varten. */
export function resetQueueStoreForTests() {
  memory.clear();
}
