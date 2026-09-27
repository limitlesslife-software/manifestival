// Puheohjauksen tilakone.
//
// PUHDAS MODUULI. Käyttöliittymä (src/app/voice.js) tekee sivuvaikutukset
// (mikrofoni, DOM); TÄMÄ päättää mikä siirtymä on ylipäätään sallittu.
// Kielletty siirtymä ei heitä eikä tee mitään: se palauttaa saman tilan.
//
//   IDLE
//    -> REQUESTING_PERMISSION   (avataan; alusta voi kysyä mikrofonin luvan)
//    -> LISTENING               (tunnistus käynnissä)
//    -> TRANSCRIPT_READY        (käyttäjä näkee ja voi muokata tekstiä)
//    -> CLASSIFYING             (teksti lähetetty tulkittavaksi)
//    -> REVIEW / TARGET_SELECTION / CONFIRMATION / EXECUTING
//                               (samat vaiheet kuin kirjoitetulla komennolla:
//                                commandBar.js raportoi ne onPhase-kutsulla)
//    -> SUCCESS | ERROR | MIC_DENIED
//
// TAKUUT
//   - Mikrofoni on päällä VAIN tiloissa REQUESTING_PERMISSION ja LISTENING
//     (micActive). Jokainen muu tila, myös piilotettu sivu (HIDDEN),
//     tarkoittaa että tunnistus sammutetaan. Ei taustamikrofonia.
//   - Litterointi ei koskaan mene suoraan tallennukseen: TRANSCRIPT_READY ->
//     CLASSIFYING vaatii käyttäjän SUBMIT:n. Saapuviin tallennus
//     (SAVE_TO_INBOX) on sallittu vain tiloista, joissa käyttäjä näkee
//     tekstin; se ei tulkitse eikä suorita mitään.
//   - Peruutus (CANCEL/CLOSE) on mahdollinen joka tilasta ja palauttaa IDLE.
//   - Pysyvä virhe (lupa estetty, tunnistin puuttuu) on oma tilansa
//     MIC_DENIED, josta RETRY ei käynnistä uutta kuuntelua: sama pyyntö
//     epäonnistuisi samalla tavalla. Tarjolla on kirjoittaminen.

export const VOICE = Object.freeze({
  IDLE: 'idle',
  REQUESTING_PERMISSION: 'requesting_permission',
  LISTENING: 'listening',
  TRANSCRIPT_READY: 'transcript_ready',
  CLASSIFYING: 'classifying',
  REVIEW: 'review',
  TARGET_SELECTION: 'target_selection',
  CONFIRMATION: 'confirmation',
  EXECUTING: 'executing',
  SUCCESS: 'success',
  ERROR: 'error',
  /** Mikrofonia ei sallittu tai tunnistinta ei ole: uusi yritys ei auta heti. */
  MIC_DENIED: 'mic_denied',
  /** Selain ei tue puheentunnistusta tai käyttäjä valitsi kirjoittamisen. */
  TYPE_FALLBACK: 'type_fallback'
});

export const VOICE_EVENT = Object.freeze({
  OPEN: 'open',
  MIC_UNSUPPORTED: 'mic_unsupported',
  MIC_STARTED: 'mic_started',
  HEARD: 'heard',
  FAIL: 'fail',
  /** Kuuntelu epäonnistui pysyvästi (lupa estetty, tunnistin puuttuu). */
  FAIL_PERMANENT: 'fail_permanent',
  SUBMIT: 'submit',
  PHASE_REVIEW: 'phase_review',
  PHASE_TARGET: 'phase_target',
  PHASE_CONFIRM: 'phase_confirm',
  PHASE_EXECUTE: 'phase_execute',
  DONE_OK: 'done_ok',
  DONE_CANCELLED: 'done_cancelled',
  DONE_ERROR: 'done_error',
  RETRY: 'retry',
  TYPE_INSTEAD: 'type_instead',
  /**
   * Käyttäjä tallensi tekstin Saapuviin päättämättä mitään (aalto L).
   * Vain tekstistä, jonka käyttäjä näkee: tarkistus, kirjoitus tai virhe.
   */
  SAVE_TO_INBOX: 'save_to_inbox',
  CANCEL: 'cancel',
  HIDDEN: 'hidden'
});

/** Komennon käsittelyvaiheet (commandBar.js:n sisällä). */
export const PROCESSING_STATES = Object.freeze([
  VOICE.CLASSIFYING, VOICE.REVIEW, VOICE.TARGET_SELECTION, VOICE.CONFIRMATION, VOICE.EXECUTING
]);

/** Tilat, joissa mikrofoni saa olla päällä. */
const MIC_STATES = Object.freeze([VOICE.REQUESTING_PERMISSION, VOICE.LISTENING]);

export function initialVoiceState() {
  return VOICE.IDLE;
}

export function isProcessing(state) {
  return PROCESSING_STATES.includes(state);
}

/** Saako mikrofoni olla päällä tässä tilassa? Kaikki muu = sammuta. */
export function micActive(state) {
  return MIC_STATES.includes(state);
}

/**
 * Seuraava tila. Tuntematon tapahtuma tai kielletty siirtymä -> sama tila.
 *
 * @param {string} state VOICE
 * @param {string} event VOICE_EVENT
 * @param {{micSupported?: boolean}} [context]
 */
export function nextVoiceState(state, event, { micSupported = true } = {}) {
  const current = Object.values(VOICE).includes(state) ? state : VOICE.IDLE;
  const processing = isProcessing(current);

  switch (event) {
    case VOICE_EVENT.OPEN:
      // Avaus vain suljetusta paneelista. Avoin paneeli ei aloita uutta kuuntelua itsestään.
      return current === VOICE.IDLE
        ? (micSupported ? VOICE.REQUESTING_PERMISSION : VOICE.TYPE_FALLBACK)
        : current;

    case VOICE_EVENT.MIC_UNSUPPORTED:
      return current === VOICE.REQUESTING_PERMISSION ? VOICE.TYPE_FALLBACK : current;

    case VOICE_EVENT.MIC_STARTED:
      return current === VOICE.REQUESTING_PERMISSION ? VOICE.LISTENING : current;

    case VOICE_EVENT.HEARD:
      return micActive(current) ? VOICE.TRANSCRIPT_READY : current;

    case VOICE_EVENT.FAIL:
      return micActive(current) ? VOICE.ERROR : current;

    case VOICE_EVENT.FAIL_PERMANENT:
      return micActive(current) ? VOICE.MIC_DENIED : current;

    case VOICE_EVENT.SUBMIT:
      // Ainoa tie tulkintaan: käyttäjä on nähnyt tekstin (tai kirjoittanut sen itse).
      return current === VOICE.TRANSCRIPT_READY || current === VOICE.TYPE_FALLBACK
        ? VOICE.CLASSIFYING
        : current;

    case VOICE_EVENT.PHASE_REVIEW: return processing ? VOICE.REVIEW : current;
    case VOICE_EVENT.PHASE_TARGET: return processing ? VOICE.TARGET_SELECTION : current;
    case VOICE_EVENT.PHASE_CONFIRM: return processing ? VOICE.CONFIRMATION : current;
    case VOICE_EVENT.PHASE_EXECUTE: return processing ? VOICE.EXECUTING : current;

    case VOICE_EVENT.DONE_OK: return processing ? VOICE.SUCCESS : current;
    case VOICE_EVENT.DONE_CANCELLED: return processing ? VOICE.IDLE : current;
    case VOICE_EVENT.DONE_ERROR: return processing ? VOICE.ERROR : current;

    case VOICE_EVENT.RETRY:
      // Ei MIC_DENIED-tilasta: estetty lupa ei muutu yrittämällä uudelleen.
      return current === VOICE.ERROR || current === VOICE.TRANSCRIPT_READY
        ? (micSupported ? VOICE.REQUESTING_PERMISSION : VOICE.TYPE_FALLBACK)
        : current;

    case VOICE_EVENT.TYPE_INSTEAD:
      return current === VOICE.ERROR || current === VOICE.MIC_DENIED
        || current === VOICE.TRANSCRIPT_READY || micActive(current)
        ? VOICE.TYPE_FALLBACK
        : current;

    case VOICE_EVENT.SAVE_TO_INBOX:
      // Litterointi Saapuviin, ei tulkintaa eikä suoritusta. Ei kuuntelusta
      // (tekstiä ei ole vielä nähty) eikä käsittelyn aikana.
      return current === VOICE.TRANSCRIPT_READY || current === VOICE.TYPE_FALLBACK || current === VOICE.ERROR
        ? VOICE.IDLE
        : current;

    case VOICE_EVENT.CANCEL:
      return VOICE.IDLE;

    case VOICE_EVENT.HIDDEN:
      // Sivu piilotettiin: mikrofoni sammuu. Käsittelyssä oleva komento saa jatkua.
      return micActive(current) ? VOICE.IDLE : current;

    default:
      return current;
  }
}
