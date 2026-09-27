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

/**
 * Kanavan tunniste Androidilla (taso 2, Muistutus). Luodaan ensimmäisellä
 * käytöllä. Tunniste EI SAA muuttua: Android ei salli olemassa olevan
 * kanavan tärkeyden muuttamista, ja asennetuilla laitteilla kanava on jo.
 */
export const CHANNEL_ID = 'manifestival-reminders';

/**
 * Kanava tasoittain (src/domain/notification.js LEVEL 1–4).
 *
 * Androidissa ääni, värinä ja keskeyttävyys ovat KANAVAN ominaisuuksia,
 * eivät yksittäisen ilmoituksen. Ilman erillisiä kanavia "Tieto" ja
 * "Kriittinen" kuulostaisivat laitteella samalta. Tärkeyttä ei voi muuttaa
 * luonnin jälkeen, joten uusi tärkeys tarkoittaa aina uutta tunnistetta.
 */
export const CHANNEL_IDS = Object.freeze({
  1: 'manifestival-info',
  2: CHANNEL_ID,
  3: 'manifestival-action',
  4: 'manifestival-critical'
});

/** Kanavien määritykset. Importance: 2 matala (ei ääntä), 4 korkea, 5 kiireellisin. */
export const CHANNELS = Object.freeze([
  Object.freeze({
    id: CHANNEL_IDS[1],
    name: 'Tiedot',
    description: 'Manifestivalin hiljaiset tiedot ja koosteet',
    importance: 2,
    visibility: 1
  }),
  Object.freeze({
    id: CHANNEL_IDS[2],
    name: 'Muistutukset',
    description: 'Manifestivalin tehtävä- ja rutiinimuistutukset',
    importance: 4,
    visibility: 1
  }),
  Object.freeze({
    id: CHANNEL_IDS[3],
    name: 'Toiminta nyt',
    description: 'Muistutukset, jotka vaativat toimintaa heti, kuten lähtö viiden minuutin päästä',
    importance: 4,
    visibility: 1,
    vibration: true
  }),
  Object.freeze({
    id: CHANNEL_IDS[4],
    name: 'Kriittiset',
    description: 'Lähde nyt -muistutukset ja muut, joissa myöhästymisen riski on suuri',
    importance: 5,
    visibility: 1,
    vibration: true
  })
]);

/**
 * Tyypit, joiden ilmoitus saa herättää laitteen lepotilasta (Doze).
 * Toistettu merkkijonoina: alusta ei saa importata domainia.
 */
const WAKE_FROM_IDLE_TYPES = new Set([
  'departure_prepare', 'departure_leave_in_5', 'departure_leave_now'
]);

/**
 * Kanava aikomukselle. Käyttäjän valitsema hiljainen toimitustapa ohjaa
 * hiljaiselle kanavalle tasosta riippumatta; muuten taso ratkaisee.
 * Tuntematon taso käyttää muistutuskanavaa (sama kuin ennen tasokanavia).
 */
export function channelIdFor(intent) {
  if (intent && intent.delivery === 'silent') return CHANNEL_IDS[1];
  const level = intent && intent.level;
  return Object.hasOwn(CHANNEL_IDS, level) ? CHANNEL_IDS[level] : CHANNEL_ID;
}

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

  // KESÄAJAN AUKKO: kevään siirtymäyönä kello 03.00–03.59 ei ole olemassa
  // (Suomessa 29.3.2026). Date siirtää olemattoman ajan tunnin ETEENPÄIN,
  // jolloin "5 min ennen lähtöä" -muistutus tulisi lähdön JÄLKEEN.
  // Muistutus lasketaan aina taaksepäin myöhemmästä hetkestä, joten oikea
  // tulkinta on aukon jälkeinen aikavyöhyke: siirretään yhtä paljon
  // TAAKSEPÄIN. Muistutus tulee mieluummin ajoissa kuin myöhässä.
  const drift = (at.getHours() * 60 + at.getMinutes()) - (hours * 60 + minutes);
  if (drift !== 0) return new Date(at.getTime() - drift * 60000);
  return at;
}

/** Suurin sallittu ankkurin siirtymä minuutteina (kaksi vuorokautta). */
const MAX_ANCHOR_OFFSET_MINUTES = 2 * 1440;

/**
 * Aikomuksen todellinen ilmoitushetki.
 *
 * Jos aikomuksella on ankkuri { date, time, offsetMinutes }, hetki on
 * ankkurin paikallinen aika + siirtymä TODELLISINA minuutteina. Näin
 * "5 min ennen lähtöä" on viisi oikeaa minuuttia myös kesäajan vaihtoyönä,
 * jolloin seinäkelloaika hyppää tunnin. Muuten intentAt(intent).
 *
 * @returns {Date|null}
 */
export function instantOf(intent) {
  const anchor = intent && intent.anchor;
  if (anchor && typeof anchor === 'object' && Number.isInteger(anchor.offsetMinutes)
    && Math.abs(anchor.offsetMinutes) <= MAX_ANCHOR_OFFSET_MINUTES) {
    const base = intentAt(anchor);
    if (base) return new Date(base.getTime() + anchor.offsetMinutes * 60000);
  }
  return intentAt(intent);
}

/**
 * Tasokanavat, joille Android-ilmoitukset ohjataan. Luonti on idempotentti:
 * olemassa olevan kanavan asetuksia (käyttäjän omia muutoksia) ei ylikirjoiteta.
 */
async function ensureChannel(api) {
  if (typeof api.createChannel !== 'function') return;
  for (const channel of CHANNELS) {
    try {
      await api.createChannel({ ...channel });
    } catch {
      // Kanavan luonti voi epäonnistua vanhemmilla Android-versioilla, joilla
      // kanavia ei ole. Se ei estä ilmoituksen näyttämistä.
    }
  }
}

/** Ilmoituksen lisätiedot: tunnisteet kuittausta ja napautusta varten. */
function extraFor(intent) {
  const extra = { intentId: intent.id, type: intent.type };
  if (typeof intent.ackKey === 'string' && intent.ackKey) extra.ackKey = intent.ackKey;
  if (typeof intent.speech === 'string' && intent.speech) extra.speech = intent.speech;
  return extra;
}

/**
 * Ajasta aikomukset laitteelle.
 *
 * Menneet ajankohdat pudotetaan: laite näyttäisi ne heti, mikä tuottaisi
 * ilmoitusryöpyn joka kerta kun sovellus avataan.
 *
 * TARKKA HÄLYTYS VAIN NIMENOMAISESTI
 * Liitännäinen (8.3+) olettaa jokaiselle ilmoitukselle tarkan hälytyksen
 * (isExactNotification: true). Jos lupaa tarkkoihin hälytyksiin ei ole
 * (Android 12+, uusilla asennuksilla oletus Android 14+), liitännäinen avaa
 * "Hälytykset ja muistutukset" -asetusnäkymän KESKEN ajastuksen — myös
 * käynnistyksessä ja sovellukseen palatessa, ilman käyttäjän elettä. Se
 * rikkoo säännön "lupa vain käyttäjän eleestä". Siksi tarkka hälytys
 * pyydetään vain, kun kutsuja antaa exactAllowed: true (lupa tiedetään
 * myönnetyksi tai kutsu tulee käyttäjän eleestä). Oletuksena ajastus on
 * epätarkka, eikä asetusnäkymää koskaan avata.
 *
 * @param {Array} intents domain/notification.js:n tuottamat aikomukset
 * @param {Date}  now     nykyhetki — annetaan parametrina testattavuuden vuoksi
 * @param {object} [options]
 * @param {boolean} [options.exactAllowed] vain arvo true pyytää tarkan hälytyksen
 */
export async function schedule(intents = [], now = new Date(), options = {}) {
  const list = Array.isArray(intents) ? intents : [];
  const exact = Boolean(options) && options.exactAllowed === true;
  const api = plugin();
  if (!api || typeof api.schedule !== 'function') {
    return { ok: false, planned: true, scheduled: 0, requested: list.length,
      reason: 'Natiivi-ilmoitukset eivät ole käytettävissä' };
  }
  if (cachedPermission() !== PERMISSION.GRANTED) {
    return { ok: false, scheduled: 0, requested: list.length,
      reason: 'Ilmoituslupa puuttuu' };
  }

  await ensureChannel(api);

  const notifications = [];
  for (const intent of list) {
    if (!intent || typeof intent !== 'object') continue;
    const at = instantOf(intent);
    if (!at || at.getTime() <= now.getTime()) continue;
    notifications.push({
      id: numericId(intent.id),
      title: intent.title,
      body: intent.body,
      channelId: channelIdFor(intent),
      // Lähtömuistutus saa herättää laitteen lepotilasta (Doze): myöhästynyt
      // lähtöilmoitus on vahinko, ei mukavuushaitta. Laitehyväksyntä kesken.
      // Sama koskee lähtöketjua (valmistaudu, 5 min, nyt).
      schedule: {
        at,
        allowWhileIdle: intent.level >= 4 || intent.type === 'departure_reminder' || WAKE_FROM_IDLE_TYPES.has(intent.type)
      },
      isExactNotification: exact,
      extra: extraFor(intent)
    });
  }

  if (notifications.length === 0) {
    return { ok: true, scheduled: 0, requested: list.length, reason: '', exact, inexactFallback: false };
  }

  try {
    const result = await api.schedule({ notifications });
    // Liitännäinen kertoo varoituksella, jos tarkka hälytys vaihtui
    // epätarkaksi (lupa puuttui). Tieto välitetään eteenpäin, ei piiloteta.
    const inexactFallback = Boolean(result && result.warning);
    return { ok: true, scheduled: notifications.length, requested: list.length, reason: '',
      exact: exact && !inexactFallback, inexactFallback };
  } catch {
    return { ok: false, scheduled: 0, requested: list.length,
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

/**
 * Poista ilmoitusalueelta tämän sovelluksen jo toimitetut ilmoitukset.
 *
 * cancelAll() koskee vain ODOTTAVIA. Jo näytetty muistutus jää
 * ilmoitusalueelle tehtävän otsikkoineen, kunnes käyttäjä pyyhkii sen --
 * myös uloskirjautumisen ja tilin poiston jälkeen. Siksi erillinen kutsu.
 * Ei kutsuta tavallisessa uudelleenajastuksessa: se pyyhkisi käyttäjän
 * lukemattomat muistutukset joka kerta.
 */
export async function removeAllDelivered() {
  const api = plugin();
  if (!api || typeof api.removeAllDeliveredNotifications !== 'function') {
    return { ok: false, reason: 'Natiivi-ilmoitukset eivät ole käytettävissä' };
  }
  try {
    await api.removeAllDeliveredNotifications();
    return { ok: true, reason: '' };
  } catch {
    return { ok: false, reason: 'Toimitettujen ilmoitusten poisto ei onnistunut' };
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
        channelId: channelIdFor(intent),
        // Muutama sekunti eteenpäin: osa Android-versioista jättää menneeseen
        // ajastetun ilmoituksen näyttämättä kokonaan.
        schedule: { at: new Date(now.getTime() + 1000) },
        // Heti näytettävä ei tarvitse tarkkaa hälytystä — eikä saa avata
        // hälytysasetuksia (ks. schedule).
        isExactNotification: false,
        extra: extraFor(intent)
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
