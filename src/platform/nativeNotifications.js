// Natiivi-ilmoitussovitin (Capacitor Local Notifications).
//
// MIKSI PLUGINIA EI IMPORTOIDA NIMELLÄ
// Manifestival ladataan selaimeen natiiveina ES-moduuleina ILMAN
// bundleria. `import { LocalNotifications } from '@capacitor/local-notifications'`
// on paljas moduulitunniste, jota selain ei osaa ratkaista — se kaataisi
// koko sovelluksen webissä, jossa pluginia ei edes tarvita.
//
// Siksi plugin haetaan ajossa globaalista `Capacitor.Plugins`-oliosta, johon
// natiivikuori rekisteröi sen itse. npm-riippuvuus on silti tarpeen: siitä
// `npx cap sync` löytää natiivikoodin ja liittää sen Gradle-käännökseen.
//
// LUPA ON ASYNKRONINEN, KYVYKKYYSKYSELY EI
// Natiivi lupatila luetaan asynkronisesti, mutta capability() on
// synkroninen. Ratkaisu on välimuisti, jota päivitetään vain nimenomaisella
// kutsulla. Välimuisti alkaa arvosta PROMPT eikä koskaan oleta lupaa —
// väärä "granted" johtaisi siihen, että sovellus luulee lähettävänsä
// ilmoituksia joita kukaan ei näe.

import {
  PERMISSION, CAPABILITY, permissionOf, setNativePermission, resetNativePermission
} from './capabilities.js';

/** Kanavan tunniste Androidilla. Luodaan ensimmäisellä käytöllä. */
export const CHANNEL_ID = 'manifestival-reminders';

/**
 * Hae plugin globaalista rekisteristä.
 * @returns {object|null} null jos ei olla natiivikuoressa tai plugin puuttuu
 */
export function plugin() {
  const capacitor = globalThis.Capacitor;
  if (!capacitor || typeof capacitor.isNativePlatform !== 'function') return null;
  if (!capacitor.isNativePlatform()) return null;
  const plugins = capacitor.Plugins;
  return (plugins && plugins.LocalNotifications) || null;
}

/** Onko natiivitoteutus oikeasti käytettävissä tässä kuoressa. */
export function isAvailable() {
  return plugin() !== null;
}

/**
 * Viimeisin tunnettu lupatila ilman odotusta.
 *
 * Välimuisti asuu capabilities.js:ssä, jotta synkroninen capability()-kysely
 * ja tämä sovitin kertovat aina saman totuuden. Kaksi erillistä välimuistia
 * erkanisi väistämättä.
 */
export function cachedPermission() {
  return isAvailable() ? permissionOf(CAPABILITY.NOTIFICATIONS) : PERMISSION.UNSUPPORTED;
}

/** Nollaa välimuisti. Kutsutaan uloskirjautumisessa ja testeissä. */
export function resetPermissionCache() {
  resetNativePermission();
}

/** Capacitorin lupavastaus yhtenäiseksi arvoksi. */
function mapPermission(display) {
  if (display === 'granted') return PERMISSION.GRANTED;
  if (display === 'denied') return PERMISSION.DENIED;
  return PERMISSION.PROMPT;
}

/**
 * Lue lupatila laitteelta ja päivitä välimuisti.
 * EI pyydä lupaa — vain kysyy nykyisen tilan.
 */
export async function refreshPermission() {
  const api = plugin();
  if (!api || typeof api.checkPermissions !== 'function') {
    return PERMISSION.UNSUPPORTED;
  }
  try {
    const result = await api.checkPermissions();
    setNativePermission(mapPermission(result && result.display));
    return cachedPermission();
  } catch {
    return cachedPermission();
  }
}

/**
 * Pyydä lupa. KUTSU VAIN KÄYTTÄJÄN ELEESTÄ.
 * @returns {Promise<{ok:boolean, permission:string, reason:string}>}
 */
export async function requestPermission() {
  const api = plugin();
  if (!api || typeof api.requestPermissions !== 'function') {
    return { ok: false, permission: PERMISSION.UNSUPPORTED, reason: 'Natiivi-ilmoitukset eivät ole käytettävissä' };
  }
  try {
    const result = await api.requestPermissions();
    setNativePermission(mapPermission(result && result.display));
    const state = cachedPermission();
    return {
      ok: state === PERMISSION.GRANTED,
      permission: state,
      reason: state === PERMISSION.DENIED
        ? 'Ilmoitukset on estetty laitteen asetuksista'
        : ''
    };
  } catch {
    return { ok: false, permission: cachedPermission(), reason: 'Lupaa ei voitu kysyä' };
  }
}

/**
 * Vakaa numeerinen tunniste merkkijonosta.
 *
 * Capacitor vaatii ilmoitukselle 32-bittisen kokonaisluvun, mutta domainin
 * tunniste on merkkijono ('task_reminder:t1:2026-01-05'). Muunnoksen on
 * oltava DETERMINISTINEN: sama muistutus saa aina saman numeron, jolloin
 * uudelleenajastus KORVAA aiemman eikä luo rinnakkaista kopiota.
 *
 * FNV-1a, rajattu positiiviseksi 31-bittiseksi luvuksi.
 */
export function numericId(stringId) {
  const text = String(stringId ?? '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  // Nolla on Capacitorilla varattu arvo, joten se siirretään pois.
  return (hash >>> 1) || 1;
}

/**
 * Muunna domainin aikomus laitteen aikaleimaksi.
 *
 * Domain käsittelee aikaa seinäkelloaikana ilman aikavyöhykettä: klo 07:30
 * tarkoittaa puoli kahdeksaa siellä missä käyttäjä on. Muunnos paikalliseksi
 * Date-olioksi kuuluu siksi tänne, ei domainiin.
 *
 * @returns {Date|null} null jos aikomuksessa ei ole kelvollista aikaa
 */
export function intentAt(intent) {
  if (!intent || typeof intent.date !== 'string' || typeof intent.time !== 'string') return null;
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(intent.date);
  const timeParts = /^(\d{2}):(\d{2})$/.exec(intent.time);
  if (!dateParts || !timeParts) return null;

  // Lukualue on tarkistettava erikseen: Date VIERITTÄÄ yli menevät arvot
  // seuraavaan yksikköön. '25:00' muuttuisi hiljaa SEURAAVAN PÄIVÄN kello
  // yhdeksi ja '19:99' ajaksi 20:39 — muistutus tulisi vääränä päivänä
  // ilman että mikään kertoisi virheestä.
  const hours = Number(timeParts[1]);
  const minutes = Number(timeParts[2]);
  if (hours > 23 || minutes > 59) return null;

  const month = Number(dateParts[2]);
  const day = Number(dateParts[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const at = new Date(
    Number(dateParts[1]), month - 1, day, hours, minutes, 0, 0
  );
  if (Number.isNaN(at.getTime())) return null;

  // Viimeinen varmistus: helmikuun 31. vierittyisi maaliskuuksi.
  if (at.getMonth() !== month - 1 || at.getDate() !== day) return null;
  return at;
}

/** Kanava, jolle Android-ilmoitukset ohjataan. Luonti on idempotentti. */
async function ensureChannel(api) {
  if (typeof api.createChannel !== 'function') return;
  try {
    await api.createChannel({
      id: CHANNEL_ID,
      name: 'Muistutukset',
      description: 'Manifestivalin tehtävä- ja rutiinimuistutukset',
      importance: 4,
      visibility: 1
    });
  } catch {
    // Kanavan luonti voi epäonnistua vanhemmilla Android-versioilla, joilla
    // kanavia ei ole. Se ei estä ilmoituksen näyttämistä.
  }
}

/**
 * Ajasta aikomukset laitteelle.
 *
 * Menneet ajankohdat pudotetaan: laite näyttäisi ne heti, mikä tuottaisi
 * ilmoitusryöpyn joka kerta kun sovellus avataan.
 *
 * @param {Array} intents domain/notification.js:n tuottamat aikomukset
 * @param {Date}  now     nykyhetki — annetaan parametrina testattavuuden vuoksi
 */
export async function schedule(intents = [], now = new Date()) {
  const api = plugin();
  if (!api || typeof api.schedule !== 'function') {
    return { ok: false, planned: true, scheduled: 0, requested: intents.length,
      reason: 'Natiivi-ilmoitukset eivät ole käytettävissä' };
  }
  if (cachedPermission() !== PERMISSION.GRANTED) {
    return { ok: false, scheduled: 0, requested: intents.length,
      reason: 'Ilmoituslupa puuttuu' };
  }

  await ensureChannel(api);

  const notifications = [];
  for (const intent of intents) {
    const at = intentAt(intent);
    if (!at || at.getTime() <= now.getTime()) continue;
    notifications.push({
      id: numericId(intent.id),
      title: intent.title,
      body: intent.body,
      channelId: CHANNEL_ID,
      // Lähtömuistutus saa herättää laitteen lepotilasta (Doze): myöhästynyt
      // lähtöilmoitus on vahinko, ei mukavuushaitta. Laitehyväksyntä kesken.
      schedule: { at, allowWhileIdle: intent.level >= 4 || intent.type === 'departure_reminder' },
      extra: { intentId: intent.id, type: intent.type }
    });
  }

  if (notifications.length === 0) {
    return { ok: true, scheduled: 0, requested: intents.length, reason: '' };
  }

  try {
    await api.schedule({ notifications });
    return { ok: true, scheduled: notifications.length, requested: intents.length, reason: '' };
  } catch {
    return { ok: false, scheduled: 0, requested: intents.length,
      reason: 'Muistutusten ajastus ei onnistunut' };
  }
}

/** Peru kaikki tämän sovelluksen ajastetut ilmoitukset. */
export async function cancelAll() {
  const api = plugin();
  if (!api || typeof api.getPending !== 'function' || typeof api.cancel !== 'function') {
    return { ok: false, cancelled: 0, reason: 'Natiivi-ilmoitukset eivät ole käytettävissä' };
  }
  try {
    const pending = await api.getPending();
    const list = (pending && pending.notifications) || [];
    if (list.length === 0) return { ok: true, cancelled: 0, reason: '' };
    await api.cancel({ notifications: list.map(item => ({ id: item.id })) });
    return { ok: true, cancelled: list.length, reason: '' };
  } catch {
    return { ok: false, cancelled: 0, reason: 'Peruutus ei onnistunut' };
  }
}

/** Näytä ilmoitus heti. Käytetään testaukseen ja välittömiin viesteihin. */
export async function showNow(intent, now = new Date()) {
  const api = plugin();
  if (!api || typeof api.schedule !== 'function') {
    return { ok: false, reason: 'Natiivi-ilmoitukset eivät ole käytettävissä' };
  }
  if (cachedPermission() !== PERMISSION.GRANTED) {
    return { ok: false, reason: 'Ilmoituslupa puuttuu' };
  }

  await ensureChannel(api);
  try {
    await api.schedule({
      notifications: [{
        id: numericId(intent.id),
        title: intent.title,
        body: intent.body,
        channelId: CHANNEL_ID,
        // Muutama sekunti eteenpäin: osa Android-versioista jättää menneeseen
        // ajastetun ilmoituksen näyttämättä kokonaan.
        schedule: { at: new Date(now.getTime() + 1000) },
        extra: { intentId: intent.id, type: intent.type }
      }]
    });
    return { ok: true, reason: '' };
  } catch {
    return { ok: false, reason: 'Ilmoitusta ei voitu näyttää' };
  }
}

/** Montako ilmoitusta on tällä hetkellä ajastettuna. */
export async function pendingCount() {
  const api = plugin();
  if (!api || typeof api.getPending !== 'function') return 0;
  try {
    const pending = await api.getPending();
    return ((pending && pending.notifications) || []).length;
  } catch {
    return 0;
  }
}
