// Muistutusten orkestrointi.
//
// TÄMÄ ON AINOA PAIKKA, JOSSA DOMAIN JA ALUSTA KOHTAAVAT.
//
//   src/domain/notification.js   päättää MITÄ ja MILLOIN   (puhdas)
//   tämä moduuli                 päättää MILLOIN SYNKRONOIDAAN
//   src/platform/notifications   päättää MITEN             (alustakohtainen)
//
// Domain ei tiedä Capacitorista eikä selaimen Notification-rajapinnasta.
// Alusta ei tiedä tehtävistä eikä rutiineista. Kumpikin on testattavissa
// yksin, ja tämä kerros on ohut tarkoituksella.
//
// KAKSI SÄÄNTÖÄ, JOTKA EIVÄT JOUSTA
//   1. Lupaa ei pyydetä automaattisesti. Vain käyttäjän eleestä.
//   2. Mitään ei ajasteta ennen kuin käyttäjä on kytkenyt muistutukset
//      päälle JA lupa on myönnetty.

import { fmtISO, todayMidnight, addDays } from '../lib/datetime.js';
import { planRange, summarizeIntents, normalizePreferences } from '../domain/notification.js';
import { expandRoutines } from '../domain/routine.js';
import { notifications as platformNotifications, PERMISSION } from '../platform/index.js';
import { getState, setNotificationPreferences } from './state.js';
import { savePreferences, isPersistent } from '../data/notificationPrefsRepo.js';
import { sessionSnapshot, isSameSession } from '../data/session.js';
import { showError, notify } from '../ui/toast.js';
import { logFailure } from '../lib/logger.js';

/**
 * Kuinka monta päivää eteenpäin muistutukset ajastetaan.
 *
 * Androidin ajastettujen ilmoitusten määrä on rajallinen, ja pitkä horisontti
 * vanhenisi joka tapauksessa: suunnitelma muuttuu. Kolme päivää kattaa
 * tavallisen käytön ja synkronointi tehdään uudelleen joka avauksella.
 */
export const SYNC_HORIZON_DAYS = 3;

/** Estä päällekkäinen synkronointi. Kaksi rinnakkaista ajoa kahdentaisi työn. */
let syncing = false;

/**
 * Viimeisimmän synkronoinnin tulos.
 *
 * Palautetaan kutsujalle, mutta EI viedä erillisenä kyselyfunktiona: mikään
 * näkymä ei sitä lue, ja viemätön rajapinta olisi lupaus jota kukaan ei
 * lunasta. Jos synkronoinnin tila joskus halutaan näkyviin, se lisätään
 * silloin — ei varmuuden vuoksi etukäteen.
 */
let lastSync = { at: null, scheduled: 0, planned: 0, reason: '' };

/**
 * Suunnittele muistutukset nykytilasta.
 *
 * PUHDAS LASKENTA — ei kosketa alustaan. Käyttöliittymä voi näyttää tämän
 * esikatseluna ("tänään 5 muistutusta") ilman että mitään ajastetaan.
 *
 * @param {Date} [from] mistä päivästä alkaen
 * @returns {{intents:Array, summary:object}}
 */
export function planUpcoming(from = todayMidnight()) {
  const state = getState();
  const preferences = normalizePreferences(state.notificationPreferences);
  const fromIso = fmtISO(from);
  const todayIso = fmtISO(todayMidnight());

  // Rutiiniesiintymät koko horisontille kerralla — ne eivät ole tallennettuja.
  // KALENTERILASKU, ei millisekunteja. Kesaajan paattyessa vuorokausi on
  // 25 tuntia, joten from.getTime() + n * 86400000 laskeutuu edelliselle
  // paivalle - ja horisontin viimeisen paivan rutiinit jaisivat kerran
  // vuodessa hiljaa ilman muistutusta.
  const toDate = addDays(from, SYNC_HORIZON_DAYS - 1);
  const routineOccurrences = expandRoutines({
    routines: state.routines,
    from: fromIso,
    to: fmtISO(toDate),
    exceptions: state.routineExceptions
  });

  const intents = planRange({
    tasks: state.tasks,
    routineOccurrences,
    travelPlans: state.travelPlans,
    from: fromIso,
    days: SYNC_HORIZON_DAYS,
    todayIso,
    preferences
  });

  return { intents, summary: summarizeIntents(intents) };
}

/**
 * Synkronoi muistutukset laitteelle.
 *
 * EI pyydä lupaa. Jos lupaa ei ole, kertoo sen eikä ajasta mitään.
 *
 * @returns {Promise<{ok:boolean, scheduled:number, planned:number, reason:string}>}
 */
export async function syncNotifications() {
  if (syncing) return { ok: false, scheduled: 0, planned: 0, reason: 'Synkronointi on jo käynnissä' };
  syncing = true;

  // Ajastettavat muistutukset lasketaan tämän käyttäjän tehtävistä, mutta
  // ajastus tapahtuu vasta kahden odotuksen jälkeen. Istunto otetaan
  // talteen heti, jotta tiedetään KENELLE nämä muistutukset kuuluvat.
  const startedIn = sessionSnapshot();

  try {
    const preferences = normalizePreferences(getState().notificationPreferences);

    // Pois kytketty tarkoittaa pois kytkettyä: aiemmin ajastetut perutaan,
    // jottei laitteelle jää muistutuksia, joita käyttäjä ei enää halua.
    if (!preferences.enabled) {
      await platformNotifications.cancel();
      lastSync = { at: Date.now(), scheduled: 0, planned: 0, reason: 'Muistutukset ovat pois päältä' };
      return { ok: true, ...lastSync };
    }

    const state = platformNotifications.capability();
    if (!state.supported) {
      lastSync = { at: Date.now(), scheduled: 0, planned: 0, reason: state.reason };
      return { ok: false, ...lastSync };
    }
    if (state.permission !== PERMISSION.GRANTED) {
      lastSync = { at: Date.now(), scheduled: 0, planned: 0, reason: 'Ilmoituslupa puuttuu' };
      return { ok: false, ...lastSync };
    }

    const { intents } = planUpcoming();

    // Vanhat perutaan ennen uusien ajastusta. Ilman tätä poistetun tehtävän
    // muistutus jäisi elämään laitteelle: käyttäjää muistutettaisiin
    // asiasta, jota ei enää ole.
    await platformNotifications.cancel();

    // ISTUNTO ENSIN, asetukset vasta sen jälkeen.
    //
    // Aiemmin tässä tarkistettiin vain, ovatko muistutukset yhä päällä.
    // Se ei riitä: tilinvaihdossa asetukset palautuvat hetkeksi
    // oletukseen, mutta heti kun UUDEN käyttäjän asetukset latautuvat
    // päällä olevina, tarkistus menee läpi — ja EDELLISEN käyttäjän
    // tehtävien otsikot ajastetaan laitteelle uuden käyttäjän istunnossa.
    //
    // Asetus on väärä kysymys. Oikea kysymys on, kuuluvatko nämä
    // muistutukset yhä sille käyttäjälle, jolle ne laskettiin.
    if (!isSameSession(startedIn)) {
      lastSync = { at: Date.now(), scheduled: 0, planned: 0,
        reason: 'Istunto vaihtui kesken synkronoinnin' };
      return { ok: true, ...lastSync };
    }

    if (!normalizePreferences(getState().notificationPreferences).enabled) {
      lastSync = { at: Date.now(), scheduled: 0, planned: 0,
        reason: 'Muistutukset kytkettiin pois kesken synkronoinnin' };
      return { ok: true, ...lastSync };
    }

    const result = await platformNotifications.schedule(intents);
    lastSync = {
      at: Date.now(),
      scheduled: result.scheduled || 0,
      planned: intents.length,
      reason: result.reason || ''
    };
    return { ok: Boolean(result.ok), ...lastSync };
  } finally {
    syncing = false;
  }
}

/**
 * Kytke muistutukset päälle käyttäjän eleestä.
 *
 * TÄMÄ ON AINOA POLKU, JOSSA LUPA KYSYTÄÄN. Kutsu vain painikkeen
 * käsittelijästä — ei koskaan käynnistyksestä.
 */
export async function enableNotifications() {
  const support = platformNotifications.capability();
  if (!support.supported) {
    showError(support.reason || 'Ilmoitukset eivät ole käytettävissä tällä alustalla.');
    return { ok: false, reason: support.reason };
  }

  if (support.permission !== PERMISSION.GRANTED) {
    const granted = await platformNotifications.requestPermissionDetailed();
    if (!granted.ok) {
      showError(granted.reason || 'Ilmoituslupaa ei annettu.');
      return { ok: false, reason: granted.reason };
    }
  }

  const result = await updatePreferences({ enabled: true });
  if (!result.ok) return result;

  await syncNotifications();
  return { ok: true };
}

/** Kytke muistutukset pois ja peru ajastetut. */
export async function disableNotifications() {
  const result = await updatePreferences({ enabled: false });
  if (!result.ok) return result;
  await platformNotifications.cancel();
  return { ok: true };
}

/**
 * Päivitä asetuksia ja synkronoi uudelleen.
 *
 * Optimistinen päivitys peruutuksella: käyttöliittymä reagoi heti, mutta
 * epäonnistunut tallennus palauttaa aiemman tilan eikä jätä valehtelevaa
 * kytkintä päälle.
 */
export async function updatePreferences(changes) {
  const previous = getState().notificationPreferences;
  const next = normalizePreferences({ ...previous, ...changes });

  setNotificationPreferences(next);

  const result = await savePreferences(next);
  if (!result.ok) {
    setNotificationPreferences(previous); // peruutus
    showError(result.error);
    return { ok: false };
  }

  if (!isPersistent()) {
    // Rehellisyys ennen mukavuutta: käyttäjän on tiedettävä, ettei asetus
    // säily. Ks. docs/PRODUCTION-ACTIVATION.md.
    notify('Muistutusasetukset eivät vielä säily sivun latauksen yli.');
  }

  return { ok: true, preferences: next };
}

/**
 * Kuinka kauan odotetaan ennen synkronointia, kun tila muuttuu.
 *
 * Tehtävän tai rutiinin muokkaus laukaisee useita peräkkäisiä
 * tilamuutoksia (optimistinen päivitys, sitten palvelimen vastaus).
 * Ilman viivettä jokainen niistä ajastaisi laitteelle oman pyyntönsä.
 * Viive kokoaa ne yhdeksi kierrokseksi.
 */
export const RESYNC_DEBOUNCE_MS = 2000;

let resyncTimer = null;

/**
 * Pyydä synkronointi viiveellä.
 *
 * KUTSUTAAN KUN AJASTUKSEEN VAIKUTTAVA TILA MUUTTUU: tehtävä tai rutiini
 * luodaan, muokataan, valmistuu tai poistetaan. Ilman tätä laitteelle
 * ajastetut ilmoitukset synkronoitaisiin vain kirjautuessa, ja väliin
 * jäänyt muokkaus jättäisi vanhentuneen ilmoituksen elämään laitteelle
 * seuraavaan kirjautumiseen asti.
 */
export function scheduleNotificationResync() {
  if (resyncTimer) clearTimeout(resyncTimer);
  resyncTimer = setTimeout(() => {
    resyncTimer = null;
    syncNotifications().catch(error => {
      logFailure('notifications.resync_failed', error);
    });
  }, RESYNC_DEBOUNCE_MS);
}

/** Peruuta odottava viivästetty synkronointi. Uloskirjautuminen. */
export function cancelScheduledResync() {
  if (resyncTimer) {
    clearTimeout(resyncTimer);
    resyncTimer = null;
  }
}

/** Kuinka kauan tilin poisto enintään odottaa laitteen muistutusten peruutusta. */
export const DEVICE_CANCEL_TIMEOUT_MS = 3000;

/**
 * Peru laitteen muistutukset kokonaan: ajastetut JA ilmoitusalueelle jo
 * toimitetut. Uloskirjautuminen ja tilin poisto.
 *
 * MIKSI: natiivikuoressa ajastetut ilmoitukset elävät käyttöjärjestelmässä
 * sovelluksesta riippumatta, ja niissä on tehtävien otsikot. Ilman tätä
 * edellisen käyttäjän -- tai poistetun tilin -- muistutukset laukeaisivat
 * vielä uloskirjautumisen jälkeen. Seuraava kirjautuminen ajastaa omansa
 * uudelleen (syncNotifications).
 *
 * EI KOSKAAN HEITÄ. Selaimessa tämä ei tee mitään (laiteajastusta ei ole).
 * `timeoutMs` rajaa odotuksen: tilin poisto odottaa peruutusta ennen
 * uloskirjautumista, mutta jumiin jäänyt natiivikutsu ei saa estää sitä.
 *
 * @returns {Promise<{timedOut:boolean, cancelled:number, deliveredRemoved:boolean}>}
 */
export async function cancelDeviceNotifications({ timeoutMs = DEVICE_CANCEL_TIMEOUT_MS } = {}) {
  cancelScheduledResync();
  const settle = task => Promise.resolve().then(task).catch(() => null);
  const work = Promise.all([
    settle(() => platformNotifications.cancel()),
    settle(() => platformNotifications.removeAllDelivered())
  ]).then(([cancelled, delivered]) => ({
    timedOut: false,
    cancelled: (cancelled && cancelled.cancelled) || 0,
    deliveredRemoved: Boolean(delivered && delivered.ok)
  }));

  let timer = null;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({ timedOut: true, cancelled: 0, deliveredRemoved: false }), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Lue lupatila laitteelta käynnistyksessä.
 *
 * EI pyydä lupaa — natiivikuoressa lupatila on luettavissa vain
 * asynkronisesti, ja asetusnäkymän on näytettävä oikea tila heti.
 */
export async function refreshNotificationPermission() {
  try {
    return await platformNotifications.refreshPermission();
  } catch {
    return PERMISSION.PROMPT;
  }
}
