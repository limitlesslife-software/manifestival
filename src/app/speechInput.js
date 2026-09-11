// Puhesyötteen sovitin: ääni sisään, teksti ulos.
//
// =====================================================================
// TÄMÄ EI OLE PUHEOHJAUS
// =====================================================================
//
// `src/app/voice.js` on puheOHJAUS: se kuuntelee, tulkitsee ja tarjoaa
// valmiin tehtävälomakkeen. Tämä moduuli on paljon pienempi ja tekee
// tasan yhden asian:
//
//   kuuntele kerran  →  palauta teksti
//
// Se ei tulkitse, ei kutsu mallia eikä luo mitään. Kutsuja päättää mitä
// tekstillä tehdään — ja kirjauspalkissa se tarkoittaa, että käyttäjä
// NÄKEE tekstin kentässä ennen kuin mitään lähtee eteenpäin.
//
// =====================================================================
// ÄÄNTÄ EI TALLENNETA
// =====================================================================
//
// Tunnistin antaa tekstin, teksti menee kenttään, ja äänivirta katoaa.
// Tässä moduulissa ei ole tallennusta, puskuria eikä `MediaRecorder`ia,
// eikä sellaista saa lisätä: äänitallenne kertoo ihmisestä paljon
// enemmän kuin se mitä hän sanoi.
//
// =====================================================================
// EPÄONNISTUMINEN EI OLE UMPIKUJA
// =====================================================================
//
// Tunnistus epäonnistuu säännöllisesti: selain ei tue sitä, lupa
// puuttuu, tai mikrofoni ei kuullut mitään. Jokainen näistä palauttaa
// `{ok: false, error}` — ja kutsupaikassa on aina tekstikenttä, johon
// saman asian voi kirjoittaa. Puhe on oikotie, ei ainoa tie.

const TIMEOUT_MS = 15000;

/** Selaimen tunnistin, jos sellainen on. */
function recognitionCtor() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

/** Onko puheentunnistus käytettävissä tässä selaimessa? */
export function speechAvailable() {
  return recognitionCtor() !== null;
}

/**
 * Kuuntele kerran ja palauta teksti.
 *
 * EI HEITÄ. Jokainen virhepolku palauttaa `{ok: false, error}`, koska
 * kutsupaikka on käyttöliittymä eikä sen kuulu erotella poikkeuksia.
 *
 * @param {{lang?: string, timeoutMs?: number}} options
 * @returns {Promise<{ok: boolean, text?: string, error?: string}>}
 */
export function listenOnce({ lang = 'fi-FI', timeoutMs = TIMEOUT_MS } = {}) {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    return Promise.resolve({
      ok: false,
      error: 'Tämä selain ei tunnista puhetta. Kirjoita sen sijaan.'
    });
  }

  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    let recognition;

    /** Vastaa kerran ja siivoa. Toinen vastaus olisi ohjelmointivirhe. */
    function finish(result) {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      try { recognition.stop(); } catch { /* jo pysähtynyt */ }
      resolve(result);
    }

    try {
      recognition = new Ctor();
    } catch {
      resolve({ ok: false, error: 'Puheentunnistusta ei voitu käynnistää.' });
      return;
    }

    recognition.lang = lang;
    recognition.continuous = false;
    // Väliaikatuloksia ei tarvita: tämä ei näytä puhetta reaaliajassa,
    // vaan palauttaa valmiin tekstin kenttään tarkistettavaksi.
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = event => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i += 1) {
        transcript += event.results[i][0].transcript;
      }
      const clean = transcript.trim();

      if (!clean) {
        finish({ ok: false, error: 'En kuullut mitään. Yritä uudelleen.' });
        return;
      }
      finish({ ok: true, text: clean });
    };

    recognition.onerror = event => {
      const code = event && event.error;
      if (code === 'no-speech') {
        finish({ ok: false, error: 'En kuullut mitään. Yritä uudelleen.' });
      } else if (code === 'not-allowed' || code === 'service-not-allowed') {
        finish({
          ok: false,
          error: 'Mikrofonin käyttö on estetty. Salli mikrofoni selaimen asetuksista.'
        });
      } else if (code === 'aborted') {
        // Käyttäjä keskeytti. Ei virhe, mutta ei myöskään tulosta.
        finish({ ok: false, error: '' });
      } else {
        finish({ ok: false, error: 'Puheentunnistus ei onnistunut.' });
      }
    };

    // `onend` ilman tulosta tarkoittaa, ettei mitään kuultu. Ilman tätä
    // lupaus jäisi roikkumaan ja mikrofonipainike näyttäisi ikuisesti
    // aktiiviselta.
    recognition.onend = () => {
      finish({ ok: false, error: 'En kuullut mitään. Yritä uudelleen.' });
    };

    // AIKAKATKAISU ON PAKOLLINEN. Osa selaimista ei laukaise `onend`-
    // tapahtumaa lainkaan, jos mikrofoni jää auki taustalla.
    timer = setTimeout(() => {
      finish({ ok: false, error: 'Kuuntelu keskeytyi. Yritä uudelleen.' });
    }, timeoutMs);

    try {
      recognition.start();
    } catch {
      finish({ ok: false, error: 'Puheentunnistusta ei voitu käynnistää.' });
    }
  });
}
