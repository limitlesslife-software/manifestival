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
// VASTUUNJAKO
// Tämä moduuli päättää MILLOIN ja KUINKA MONTA KERTAA rinnakkain
// päivitys ajetaan. Se ei tiedä MITÄ päivitys tekee — se saadaan
// `onRefresh`-takaisinkutsuna, jotta ajastus- ja limittäly-logiikka on
// testattavissa ilman oikeaa verkkoa, DOM:ia tai oikeita ajastimia.

/** Debounce-ikkuna online-tapahtumalle, millisekuntteina. */
export const RECONNECT_DEBOUNCE_MS = 1500;

/**
 * @param {object} options
 * @param {() => Promise<void>} options.onRefresh kutsutaan enintään yhden
 *   kerran rinnakkain; jos se heittää tai hylkää, virhe kirjautuu mutta ei
 *   kaada kutsujaa.
 * @param {number} [options.debounceMs]
 * @param {boolean} [options.initialOnline] verkon tila käynnistyshetkellä
 *   (navigator.onLine). Offline-tilassa käynnistynyt sovellus ei muuten
 *   reagoinut ensimmäiseen "online"-tapahtumaan lainkaan (F7): ohjain luuli
 *   olleensa koko ajan verkossa, eikä lähetystä tai latausta tehty.
 * @param {typeof setTimeout} [options.setTimeoutFn] testeja varten
 * @param {typeof clearTimeout} [options.clearTimeoutFn] testeja varten
 */
export function createReconnectController({
  onRefresh,
  debounceMs = RECONNECT_DEBOUNCE_MS,
  initialOnline = true,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  let online = initialOnline !== false;
  let timer = null;
  let refreshing = false;
  let refreshAgainAfter = false;

  function runRefresh() {
    // KOLMANNEN PÄÄLLEKKÄISEN KUTSUN ESTO. Jos päivitys on jo käynnissä,
    // uusi pyyntö ei käynnistä toista rinnakkaista Promise.all-vyöryä —
    // se vain merkitsee, että kun nykyinen päättyy, ajetaan vielä yksi
    // kierros. Näin online-flapping tai resume+online samaan aikaan ei
    // koskaan tuota kahta rinnakkaista täyttä latausta.
    if (refreshing) {
      refreshAgainAfter = true;
      return;
    }
    refreshing = true;
    Promise.resolve()
      .then(() => onRefresh())
      .catch(error => {
        console.warn('Manifestival: verkon palautumisen päivitys ei onnistunut', error);
      })
      .then(() => {
        refreshing = false;
        if (refreshAgainAfter) {
          refreshAgainAfter = false;
          runRefresh();
        }
      });
  }

  function scheduleDebouncedRefresh(delayMs = debounceMs) {
    if (timer) clearTimeoutFn(timer);
    timer = setTimeoutFn(() => {
      timer = null;
      runRefresh();
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
      if (wasOffline) scheduleDebouncedRefresh();
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
     * Pyydä välitön päivitys (esim. sovellus palaa etualalle).
     * Sama limittäly kuin online-siirtymässä: ei rinnakkaisia kutsuja.
     */
    refreshNow() {
      runRefresh();
    },

    /**
     * Yksi viivästetty päivitys (esim. ensimmäinen lataus epäonnistui,
     * vaikka laite on verkossa). Ei kasaudu: odottava ajastus korvataan,
     * offline-ilmoitus ja cancelPending() peruvat sen. Offline-tilassa
     * ei ajasteta — seuraava "online" hoitaa päivityksen.
     */
    refreshLater(delayMs) {
      if (!online) return;
      scheduleDebouncedRefresh(Math.max(0, Number(delayMs) || 0));
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
    isRefreshing: () => refreshing
  };
}
