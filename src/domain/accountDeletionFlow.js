// Tilin poiston vahvistusvirran tilakone.
//
// PUHDAS MODUULI. Ei DOM:ia, ei verkkoa. Käyttöliittymä (src/app/
// accountDeletion.js) tekee sivuvaikutukset; TÄMÄ päättää, mikä
// siirtymä on ylipäätään sallittu. Kielletty siirtymä ei heitä eikä
// tee mitään -- se palauttaa saman tilan (kaatuu kiinni).
//
// TAVOITE: yksittäinen vahinkoklikkaus ei voi koskaan johtaa poistoon.
// Poistoon johtaa vain jono
//
//   IDLE -> PREVIEW -> CONFIRM -> DELETING -> DONE
//
// jossa CONFIRM -> DELETING vaatii (a) palvelinpoiston olevan käytössä,
// (b) esikatselun nähdyksi, (c) oman sähköpostin ja vahvistuslauseen
// täsmälleen oikein kirjoitetuiksi. Lopullinen "olen varma" -dialogi on
// käyttöliittymän oma, viimeinen lukko tämän jälkeen.

/**
 * Vahvistuslause. SAMA kuin palvelinfunktion CONFIRMATION_PHRASE
 * (supabase/functions/delete-account/handler.js); testi vaatii yhtäläisyyden.
 */
export const DELETION_PHRASE = 'POISTA TILINI';

export const FLOW = Object.freeze({
  IDLE: 'idle',
  PREVIEW: 'preview',
  CONFIRM: 'confirm',
  DELETING: 'deleting',
  DONE: 'done',
  FAILED: 'failed',
  REAUTH: 'reauth'
});

export const FLOW_EVENT = Object.freeze({
  OPEN_PREVIEW: 'open_preview',
  BEGIN_CONFIRM: 'begin_confirm',
  SUBMIT: 'submit',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  NEEDS_REAUTH: 'needs_reauth',
  CANCEL: 'cancel',
  RETRY: 'retry'
});

export function initialFlowState() {
  return { step: FLOW.IDLE, errorCode: null };
}

/**
 * Onko vahvistus täsmälleen oikein?
 *
 * Sähköposti vertaillaan kirjainkoosta ja reunavälilyönneistä
 * riippumatta (sama kuin palvelin); lause EI: "poista tilini" ei kelpaa,
 * koska tarkoitus on pakottaa käyttäjä kirjoittamaan se tietoisesti.
 * Jos tilillä ei ole sähköpostia, vain lause vaaditaan.
 */
export function confirmationStatus({ expectedEmail, emailInput, phraseInput }) {
  const phraseOk = String(phraseInput ?? '').trim() === DELETION_PHRASE;
  const needsEmail = Boolean(expectedEmail);
  const emailOk = !needsEmail
    || String(emailInput ?? '').trim().toLowerCase() === String(expectedEmail).trim().toLowerCase();
  return { phraseOk, emailOk, ready: phraseOk && emailOk };
}

/**
 * Seuraava tila.
 *
 * @param {{step:string, errorCode:string|null}} state
 * @param {string} event FLOW_EVENT
 * @param {object} [context]
 * @param {boolean} [context.endpointEnabled] palvelinpoisto käytössä
 * @param {boolean} [context.previewSeen]     esikatselu on nähty
 * @param {boolean} [context.confirmationReady] confirmationStatus().ready
 * @param {string}  [context.errorCode]
 */
export function nextFlowState(state, event, context = {}) {
  const current = state && state.step ? state : initialFlowState();
  const stay = current;
  const to = (step, errorCode = null) => ({ step, errorCode });

  switch (event) {
    case FLOW_EVENT.OPEN_PREVIEW:
      return current.step === FLOW.IDLE || current.step === FLOW.FAILED
        ? to(FLOW.PREVIEW)
        : stay;

    case FLOW_EVENT.BEGIN_CONFIRM:
      return current.step === FLOW.PREVIEW && context.endpointEnabled === true
        ? to(FLOW.CONFIRM)
        : stay;

    case FLOW_EVENT.SUBMIT:
      // Ainoa tie DELETING-tilaan. Toinen SUBMIT DELETING-tilassa on no-op,
      // joten tuplaklikkaus ei voi käynnistää toista poistoa.
      return current.step === FLOW.CONFIRM
        && context.endpointEnabled === true
        && context.previewSeen === true
        && context.confirmationReady === true
        ? to(FLOW.DELETING)
        : stay;

    case FLOW_EVENT.SUCCEEDED:
      return current.step === FLOW.DELETING ? to(FLOW.DONE) : stay;

    case FLOW_EVENT.NEEDS_REAUTH:
      return current.step === FLOW.DELETING ? to(FLOW.REAUTH, 'recent_login_required') : stay;

    case FLOW_EVENT.FAILED:
      return current.step === FLOW.DELETING
        ? to(FLOW.FAILED, context.errorCode || 'unknown')
        : stay;

    case FLOW_EVENT.CANCEL:
      // Peruminen on mahdollista kaikkialta paitsi kesken poiston ja
      // valmiista tilasta (poistoa ei voi enää perua).
      return current.step === FLOW.DELETING || current.step === FLOW.DONE
        ? stay
        : to(FLOW.IDLE);

    case FLOW_EVENT.RETRY:
      return current.step === FLOW.FAILED ? to(FLOW.CONFIRM) : stay;

    default:
      return stay;
  }
}
