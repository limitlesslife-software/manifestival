// Verkon palautumisen ohjain.
//
// ONGELMA, JONKA TÄMÄ RATKAISEE
// Ennen tätä sovellus ei tehnyt MITÄÄN kun verkko palautui — vain
// bannerin näkyvyys vaihtui. Data jäi siihen tilaan missä se oli
// silloin kun yhteys katkesi, kunnes käyttäjä itse lataisi sivun
// uudelleen. "online"-tapahtuma voi myös laueta useita kertoja
// nopeasti peräkkäin (flapping) tai samaan aikaan kuin sovellus palaa
// etualalle (resume) — kumpikaan ei saa käynnistää useaa rinnakkaista
// täyttä päivitystä.
//
// PÄIVITYSRYÖPPY (CRIT-02). Täysi päivitys on jonon toisto, lähtökorin
// lähetys ja parikymmentä rinnakkaista hakua. Siksi:
//   - paluu etualalle ('resume') ei päivitä, jos edellinen päivitys
//     ALKOI alle MIN_REFRESH_INTERVAL_MS sitten (nopea sovellusten vaihto)
//     — paitsi jos verkon palautumista ei ole vielä katettu (taustalle
//     siirtyminen perui sen ajastetun päivityksen)
//   - verkon palautuminen ('online') päivittää vain, jos yksikään
//     päivitys ei ole alkanut palautumisen jälkeen; kesken olevan
//     päivityksen perään ajetaan yksi kierros vain, jos se alkoi ennen
//     palautumista (eli ehkä ilman verkkoa)
//   - käyttäjän pyyntö ('manual'), skeeman palautuminen ('schema') ja
//     epäonnistuneen latauksen uusinta ('retry') eivät odota väliä.
//
// VASTUUNJAKO
// Tämä moduuli päättää MILLOIN ja KUINKA MONTA KERTAA rinnakkain
// päivitys ajetaan. Se ei tiedä MITÄ päivitys tekee — se saadaan
// `onRefresh`-takaisinkutsuna, jotta ajastus- ja limittäly-logiikka on
// testattavissa ilman oikeaa verkkoa, DOM:ia tai oikeita ajastimia.

import { logFailure } from '../lib/logger.js';

/** Debounce-ikkuna online-tapahtumalle, millisekuntteina. */
export const RECONNECT_DEBOUNCE_MS = 1500;

/** Paluu etualalle ei päivitä, jos edellinen päivitys alkoi tätä lähempänä. */
export const MIN_REFRESH_INTERVAL_MS = 30000;

/**
 * Päivityksen syyt.
 *   resume  sovellus palasi etualalle (rajoitettu vähimmäisvälillä)
 *   online  verkko palasi (vain jos palautumisen jälkeen ei ole päivitetty)
 *   manual  käyttäjä tai kutsuja pyysi nimenomaisesti (oletus)
 *   schema  kannan kyvykkyys nousi: ladattu tieto voi olla vajaa
 *   retry   epäonnistuneen latauksen uusinta (refreshLater)
 */
export const REFRESH_REASON = Object.freeze({
  RESUME: 'resume', ONLINE: 'online', MANUAL: 'manual', SCHEMA: 'schema', RETRY: 'retry'
});

/** Nämä eivät odota vähimmäisväliä. */
const UNTHROTTLED = new Set([REFRESH_REASON.MANUAL, REFRESH_REASON.SCHEMA, REFRESH_REASON.RETRY]);

/**
 * Kesken olevan päivityksen perään ajetaan vielä yksi kierros vain näistä
 * syistä: käynnissä oleva haku on voinut alkaa ilman verkkoa ('online') tai
 * vanhoilla kyvykkyyksillä ('schema'). Muuten käynnissä oleva päivitys on
 * jo tuore, eikä toista täyttä latausta tarvita.
 */
const TRAILING = new Set([REFRESH_REASON.ONLINE, REFRESH_REASON.SCHEMA]);

/**
 * @param {object} options
 * @param {() => Promise<void>} options.onRefresh kutsutaan enintään yhden
 *   kerran rinnakkain; jos se heittää tai hylkää, virhe kirjautuu mutta ei
 *   kaada kutsujaa.
 * @param {number} [options.debounceMs]
 * @param {number} [options.minIntervalMs] ks. MIN_REFRESH_INTERVAL_MS
 * @param {boolean} [options.initialOnline] verkon tila käynnistyshetkellä
 *   (navigator.onLine). Offline-tilassa käynnistynyt sovellus ei muuten
 *   reagoinut ensimmäiseen "online"-tapahtumaan lainkaan (F7): ohjain luuli
 *   olleensa koko ajan verkossa, eikä lähetystä tai latausta tehty.
 * @param {() => number} [options.now] kello (ms) testejä varten
 * @param {typeof setTimeout} [options.setTimeoutFn] testeja varten
 * @param {typeof clearTimeout} [options.clearTimeoutFn] testeja varten
 */
export function createReconnectController({
  onRefresh,
  debounceMs = RECONNECT_DEBOUNCE_MS,
  minIntervalMs = MIN_REFRESH_INTERVAL_MS,
  initialOnline = true,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  let online = initialOnline !== false;
  let timer = null;
  let refreshing = false;
  /** Kesken olevan päivityksen perään ajettavan kierroksen syy (tai null). */
  let trailingReason = null;
  /** Milloin viimeisin päivitys (tai vastaava täysi lataus) ALKOI (ms). */
  let lastStartedAt = null;
  // Järjestys tapahtumalaskurilla, ei kellolla: sama millisekunti ei saa
  // tehdä epäselväksi, alkoiko päivitys ennen verkon palautumista vai sen jälkeen.
  let eventSeq = 0;
  let lastStartSeq = 0;
  /** Viimeisimmän offline -> online -siirtymän järjestysnumero (0 = ei koskaan). */
  let onlineSeq = 0;

  function noteStart() {
    lastStartedAt = now();
    eventSeq += 1;
    lastStartSeq = eventSeq;
  }

  function startedSinceOnline() {
    return onlineSeq > 0 && lastStartSeq > onlineSeq;
  }

  /**
   * Onko verkko palannut ilman, että yksikään päivitys on alkanut sen
   * jälkeen? Näin käy, kun taustalle siirtyminen (cancelPending) perui
   * odottavan online-päivityksen.
   */
  function onlineUncovered() {
    return online && onlineSeq > 0 && !startedSinceOnline();
  }

  /**
   * Onko viimeisimmästä päivityksen alusta alle vähimmäisväli? Kello voi
   * hypätä taaksepäin (käyttäjä tai verkkoaika korjaa sitä): negatiivinen
   * kulunut aika on vanhentunut ikkuna, ei "juuri äsken".
   */
  function withinMinInterval() {
    if (lastStartedAt === null) return false;
    const elapsed = now() - lastStartedAt;
    return elapsed >= 0 && elapsed < minIntervalMs;
  }

  /**
   * @param {string} reason REFRESH_REASON
   * @returns {'started'|'queued'|'skipped'}
   */
  function runRefresh(reason) {
    // Paluu etualalle kattaa verkon palautumisen, jonka ajastettu päivitys
    // peruttiin taustalle siirryttäessä: se ajetaan kuten 'online' eikä
    // odota vähimmäisväliä. Muuten jonossa olevat muutokset lähtisivät
    // vasta seuraavalla paluulla yli MIN_REFRESH_INTERVAL_MS:n päästä.
    if (reason === REFRESH_REASON.RESUME && onlineUncovered()) reason = REFRESH_REASON.ONLINE;

    // Verkon palautuminen on jo katettu, jos päivitys alkoi sen jälkeen
    // (esim. paluu etualalle debounce-ikkunan aikana).
    if (reason === REFRESH_REASON.ONLINE && startedSinceOnline()) return 'skipped';

    // KOLMANNEN PÄÄLLEKKÄISEN KUTSUN ESTO. Jos päivitys on jo käynnissä,
    // uusi pyyntö ei käynnistä toista rinnakkaista Promise.all-vyöryä.
    // Vain TRAILING-syy merkitsee, että kun nykyinen päättyy, ajetaan
    // vielä yksi kierros; muut ovat jo käynnissä olevan katteena.
    if (refreshing) {
      if (TRAILING.has(reason)) {
        trailingReason = reason;
        return 'queued';
      }
      return 'skipped';
    }

    // Nopea sovellusten vaihto ei lataa kaikkea joka paluulla.
    if (reason !== REFRESH_REASON.ONLINE && !UNTHROTTLED.has(reason) && withinMinInterval()) {
      return 'skipped';
    }

    refreshing = true;
    noteStart();
    Promise.resolve()
      .then(() => onRefresh())
      .catch(error => {
        logFailure('reconnect.refresh_failed', error);
      })
      .then(() => {
        refreshing = false;
        if (trailingReason) {
          const next = trailingReason;
          trailingReason = null;
          runRefresh(next);
        }
      });
    return 'started';
  }

  function scheduleDebouncedRefresh(delayMs, reason) {
    if (timer) clearTimeoutFn(timer);
    timer = setTimeoutFn(() => {
      timer = null;
      runRefresh(reason);
    }, delayMs);
  }

  return {
    /**
     * Kutsu kun selain/laite ilmoittaa olevansa verkossa.
     * Käynnistää päivityksen debouncella VAIN offline->online-siirtymässä
     * — toistuva "online" samalla tilalla (esim. kaksi kuuntelijaa) ei saa
     * käynnistää uutta ajastinta jokaisella kutsulla.
     */
    notifyOnline() {
      const wasOffline = !online;
      online = true;
      if (wasOffline) {
        eventSeq += 1;
        onlineSeq = eventSeq;
        scheduleDebouncedRefresh(debounceMs, REFRESH_REASON.ONLINE);
      }
    },

    /**
     * Kutsu kun selain/laite ilmoittaa olevansa offline.
     * Peruuttaa odottavan ajastetun päivityksen — sitä ei ole mieltä
     * yrittää verkotta, ja seuraava "online" ajastaa uuden.
     */
    notifyOffline() {
      online = false;
      if (timer) {
        clearTimeoutFn(timer);
        timer = null;
      }
    },

    /**
     * Pyydä välitön päivitys. Sama limittäly kuin online-siirtymässä: ei
     * rinnakkaisia kutsuja. Paluu etualalle ({ reason: 'resume' }) ohitetaan,
     * jos edellinen päivitys alkoi alle MIN_REFRESH_INTERVAL_MS sitten.
     *
     * @param {{reason?: string}} [options] REFRESH_REASON (oletus 'manual')
     * @returns {'started'|'queued'|'skipped'}
     */
    refreshNow({ reason = REFRESH_REASON.MANUAL } = {}) {
      return runRefresh(reason);
    },

    /**
     * Yksi viivästetty päivitys (esim. ensimmäinen lataus epäonnistui,
     * vaikka laite on verkossa). Ei kasaudu: odottava ajastus korvataan,
     * offline-ilmoitus ja cancelPending() peruvat sen. Offline-tilassa
     * ei ajasteta — seuraava "online" hoitaa päivityksen.
     */
    refreshLater(delayMs) {
      if (!online) return;
      scheduleDebouncedRefresh(Math.max(0, Number(delayMs) || 0), REFRESH_REASON.RETRY);
    },

    /**
     * Täysi lataus alkoi ohjaimen ohi (kirjautuminen, synkronoinnin
     * jälkeinen lataus): paluu etualalle heti perään ei lataa toista kertaa.
     * Kutsu ENNEN lähetysvaihetta, ei vasta latauksen alussa.
     *
     * Ohjaimen oman päivityksen aikana ei tee mitään: runRefresh kirjasi
     * alun jo ennen lähetysvaihetta. Latauksen alussa kirjattu uusi alku
     * saisi lähetyksen aikana palanneen verkon näyttämään katetulta, ja
     * jonossa olevat muutokset jäisivät lähettämättä seuraavaan paluuseen asti.
     */
    noteRefreshStarted() {
      if (refreshing) return;
      noteStart();
    },

    /** Peruuta odottava ajastettu päivitys ilman tilan muutosta. Uloskirjautuminen. */
    cancelPending() {
      if (timer) {
        clearTimeoutFn(timer);
        timer = null;
      }
    },

    // Testejä ja diagnostiikkaa varten.
    isOnline: () => online,
    isRefreshing: () => refreshing,
    lastRefreshStartedAt: () => lastStartedAt
  };
}
