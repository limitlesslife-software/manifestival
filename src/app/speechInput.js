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
// Varsinainen tunnistus on alustasovittimessa (src/platform/speech.js):
// selaimessa Web Speech API, Android-sovelluksessa oma liitännäinen.
// Sovitin hoitaa aikakatkaisun (15 s), perumisen (abort) ja sen, ettei
// mikrofoni jää auki taustalle.
//
// =====================================================================
// EPÄONNISTUMINEN EI OLE UMPIKUJA
// =====================================================================
//
// Tunnistus epäonnistuu säännöllisesti: alusta ei tue sitä, lupa
// puuttuu, tai mikrofoni ei kuullut mitään. Jokainen näistä palauttaa
// `{ok: false, code, error}` — ja kutsupaikassa on aina tekstikenttä, johon
// saman asian voi kirjoittaa. Puhe on oikotie, ei ainoa tie.
//
// Peruttu sanelu (`code: 'aborted'`) ei ole virhe: `error` on tyhjä, eikä
// kutsupaikka näytä siitä viestiä.

import { speech } from '../platform/index.js';

/** Käynnissä oleva sanelu, tai null. */
let active = null;

/** Onko puheentunnistus käytettävissä tällä alustalla? */
export function speechAvailable() {
  const state = speech.capability();
  return state.supported && state.implemented;
}

/** Onko sanelu käynnissä (mikrofoni auki tai aukeamassa)? */
export function isDictating() {
  return active !== null;
}

/**
 * Peru käynnissä oleva sanelu. Kesken olevan kuuntelun lupaus ratkeaa
 * koodilla 'aborted'; myöhäinen tulos ei päädy kenttään.
 * @returns {boolean} peruttiinko jotain
 */
export function cancelDictation() {
  if (!active) return false;
  const current = active;
  active = null;
  current.cancel();
  return true;
}

/**
 * Kuuntele kerran ja palauta teksti. VAIN käyttäjän napautuksesta: tämä
 * voi avata mikrofonin lupadialogin.
 *
 * EI HEITÄ. Jokainen virhepolku palauttaa `{ok: false, code, error}`, koska
 * kutsupaikka on käyttöliittymä eikä sen kuulu erotella poikkeuksia.
 *
 * @param {{lang?: string, timeoutMs?: number, onStart?: Function, onPermission?: Function}} options
 * @returns {Promise<{ok: true, text: string}|{ok: false, code: string, error: string}>}
 */
export function listenOnce({ lang = 'fi-FI', timeoutMs, onStart, onPermission } = {}) {
  cancelDictation();
  // Väliaikatuloksia ei pyydetä: tämä ei näytä puhetta reaaliajassa,
  // vaan palauttaa valmiin tekstin kenttään tarkistettavaksi.
  const handle = speech.startListening({ lang, timeoutMs, onStart, onPermission });
  active = handle;
  return handle.result.then(result => {
    if (active === handle) active = null;
    if (result.ok) return { ok: true, text: result.text };
    return { ok: false, code: result.code, error: speech.errorMessage(result.code) };
  });
}
