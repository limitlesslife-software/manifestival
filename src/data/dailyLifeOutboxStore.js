// Arjen lähtökorin tallennus: yksi avain per käyttäjä.
//
// MITÄ TÄNNE TALLENTUU: vain lähettämättömät menojen tallennukset ja
// tapakirjaukset (kentät, jotka src/domain/dailyLifeOutbox.js sallii). Ei
// tokeneita, ei avaimia, ei sähköpostia, ei user_id:tä sisällössä. Sama
// periaate kuin tehtävien offline-jonossa (src/data/offlineQueueStore.js):
//
//   - avain on käyttäjäkohtainen, ja parseOutbox tarkistaa käyttäjän vielä
//     sisällöstäkin: toisen käyttäjän kori ei koskaan lähde tällä tilillä
//   - uloskirjautuminen EI poista koria: sama käyttäjä lähettää sen, kun
//     hän palaa (kukaan muu ei osu siihen)
//   - tilin poisto poistaa korin (purgeOutbox)
//   - tallennus voi epäonnistua (yksityinen ikkuna, kiintiö): silloin kori
//     elää vain muistissa, eikä väitetä sen säilyvän

const PREFIX = 'manifestival.dailyLifeOutbox.v1.';
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

export function outboxKey(userId) {
  const id = userId == null ? '' : String(userId);
  return USER_ID_PATTERN.test(id) ? PREFIX + id : null;
}

/** Lue tallennettu teksti. null, jos ei ole tai avain on kelvoton. */
export function loadOutboxText(userId) {
  const key = outboxKey(userId);
  if (!key) return null;
  // Muistikopio ensin: se on olemassa vain, kun viimeisin tallennus ei
  // mennyt localStorageen, jolloin sinne jäänyt teksti on vanhempi.
  if (memory.has(key)) return memory.get(key);
  try {
    const store = storage();
    if (store) return store.getItem(key);
  } catch { /* ei luettavissa */ }
  return null;
}

/** @returns {{ok:boolean, persistent:boolean}} */
export function saveOutboxText(userId, text) {
  const key = outboxKey(userId);
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

/** Poista käyttäjän kori. Tilin poisto. */
export function purgeOutbox(userId) {
  const key = outboxKey(userId);
  if (!key) return;
  memory.delete(key);
  try {
    const store = storage();
    if (store) store.removeItem(key);
  } catch { /* ei mitään poistettavaa */ }
}

/** Testejä varten. */
export function resetOutboxStoreForTests() {
  memory.clear();
}
