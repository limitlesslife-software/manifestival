// Offline-jonon tila käyttäjälle: yksi rivi ja tarkistusvirta.
//
// PERIAATTEET
//   - Odottava muutos EI ole palvelimen vahvistama, ja rivi sanoo sen.
//   - Rivi päivittyy vain kun teksti oikeasti muuttuu: yritysten
//     uusiminen ei tuota toast-ryöppyä eikä välkyntää.
//   - Ristiriita ja epäonnistuminen eivät katoa: rivi on painike, joka
//     avaa tarkistuksen. Hylkääminen vaatii AINA erillisen vahvistuksen,
//     joten Esc ei koskaan poista käyttäjän muutosta.

import { maybe } from '../ui/dom.js';
import { confirmAction } from '../ui/confirm.js';
import { showError } from '../ui/toast.js';
import { describeQueueStatus, OP_STATUS } from '../domain/offlineQueue.js';
import { offline, subscribeSyncStatus, isOnlineNow } from './offline.js';
import { SCHEMA_PENDING_CODE, SCHEMA_PENDING_NOTE } from './offlineSync.js';

const FIELD_LABELS = Object.freeze({
  title: 'otsikko', date: 'päivä', time: 'kellonaika', endTime: 'päättymisaika', category: 'elämänalue',
  note: 'muistiinpano', description: 'kuvaus', completed: 'tehty-tila', priority: 'prioriteetti',
  durationMinutes: 'kesto', deadline: 'määräaika', isWake: 'herätysmerkintä'
});

function fieldNames(fields) {
  const names = fields.map(field => FIELD_LABELS[field] || field);
  return names.length ? names.join(', ') : 'rivi';
}

let lastText = null;
let reviewing = false;

/** Jono odottaa kirjautumista (offlineSync: markPaused(…, 'auth')). */
export const AUTH_PAUSED_NOTE = 'Kirjaudu uudelleen sisään, niin muutokset lähtevät.';

/**
 * Miksi muutos ei lähtenyt: lastErrorCode -> selitys (ERR-18).
 *
 * Tarkistus kysyi aiemmin aina "Yritetäänkö uudelleen?", myös silloin kun
 * palvelin oli hylännyt muutoksen eikä uusi yritys voi auttaa. Koodit:
 * src/app/offlineSync.js (invalid_task, id_collision, rejected) ja
 * src/domain/offlineQueue.js markRetry (retries_exhausted tai viimeisin
 * uusintakoodi, kun yritykset loppuivat).
 *
 * @param {string|null} code
 * @returns {{text: string, retryHelps: boolean}}
 */
export function failedReason(code) {
  switch (code) {
    case 'invalid_task':
    case 'rejected':
      return {
        text: 'Palvelin ei hyväksynyt muutosta. Uusi yritys ei todennäköisesti auta – avaa tehtävä ja tarkista kentät.',
        retryHelps: false
      };
    case 'id_collision':
      return {
        text: 'Tehtävää ei voitu tallentaa, koska sen tunniste on jo käytössä. Uusi yritys ei auta – luo tehtävä uudelleen.',
        retryHelps: false
      };
    case 'unavailable':
      return { text: 'Palvelu ei vastannut toistuvasti. Yritetäänkö uudelleen?', retryHelps: true };
    case 'changed_during_sync':
      return { text: 'Tehtävä muuttui toistuvasti toisaalla lähetyksen aikana. Yritetäänkö uudelleen?', retryHelps: true };
    case 'network':
    case 'retries_exhausted':
      // Vain verkkovirhe (ja vanhan jonon yleiskoodi) on katkennut yhteys.
      return { text: 'Yhteys katkesi toistuvasti. Yritetäänkö uudelleen?', retryHelps: true };
    case 'unknown':
    default:
      // Tuntematon tai heitetty virhe ('exception') ei ole verkkovirhe:
      // "yhteys katkesi" ohjaisi etsimään vikaa verkosta.
      return { text: 'Muutos ei mennyt perille useista yrityksistä huolimatta. Yritetäänkö uudelleen?', retryHelps: true };
  }
}

/**
 * PUHDAS: jonon tila + operaatiot -> tilarivi. Kun osa muutoksesta odottaa,
 * että kanta tukee sitä (offlineSync: SCHEMA_PENDING_CODE), rivi sanoo sen:
 * muuten "odottaa synkronointia" näyttäisi jäävän jumiin ilman syytä.
 *
 * @param {object} status offline.status()
 * @param {Array<{status:string,lastErrorCode:string|null}>} items offline.list()
 * @param {{online:boolean}} context
 */
export function describeSyncLine(status, items = [], { online = true } = {}) {
  const view = describeQueueStatus(status, { online, replaying: status.replaying });
  const pending = code => (items || []).some(item =>
    item.status === OP_STATUS.PENDING && item.lastErrorCode === code);
  if (!view.text || view.needsReview) return view;
  // Istunto vanheni: "odottaa synkronointia" jäisi odottamaan ikuisesti,
  // koska lähetys jatkuu vasta kirjautumisen jälkeen.
  if (pending('auth')) return { ...view, tone: 'warn', text: `${view.text} · ${AUTH_PAUSED_NOTE}` };
  if (!pending(SCHEMA_PENDING_CODE)) return view;
  return { ...view, text: `${view.text} · ${SCHEMA_PENDING_NOTE}` };
}

function render(status) {
  const node = maybe('syncStatus');
  if (!node) return;

  let items = [];
  try { items = offline.list(); } catch { /* tilarivi ei kaada jonoa */ }
  const view = describeSyncLine(status, items, { online: isOnlineNow() });
  const key = `${view.text}|${view.tone}|${view.needsReview}`;
  if (key === lastText) return;
  lastText = key;

  node.hidden = view.text === '';
  node.textContent = view.text;
  node.classList.toggle('tone-warn', view.tone === 'warn');
  node.classList.toggle('tone-error', view.tone === 'error');
  node.classList.toggle('needs-review', view.needsReview);
  node.disabled = !view.needsReview;
  if (view.needsReview) node.setAttribute('aria-label', view.text + '. Avaa tarkistus.');
  else node.removeAttribute('aria-label');
}

/** Päivitä rivi nykytilasta (esim. verkon tila vaihtui). */
export function refreshSyncStatus() {
  lastText = null;
  render(offline.status());
}

/**
 * Käy läpi ristiriidat ja epäonnistuneet yksi kerrallaan.
 *
 * Kaksivaiheinen: ensin ehdotetaan turvallisempaa jatkoa, ja hylkääminen
 * kysytään erikseen. Sulkeminen (Esc, tausta) jättää operaation ennalleen.
 */
async function reviewProblems() {
  if (reviewing) return;
  reviewing = true;
  try {
    for (const item of offline.list()) {
      if (item.status === OP_STATUS.CONFLICT) {
        const mine = await confirmAction({
          title: 'Muutos on ristiriidassa',
          message: `"${item.title || 'Tehtävä'}": ${fieldNames(item.conflictFields)} on muuttunut toisaalla `
            + 'sen jälkeen kun teit muutoksen. Käytetäänkö sinun muutostasi?',
          confirmLabel: 'Käytä minun muutostani',
          cancelLabel: 'Ei nyt'
        });
        if (mine) {
          offline.resolve(item.id, 'mine');
          continue;
        }
        const drop = await confirmAction({
          title: 'Hylätäänkö oma muutos?',
          message: 'Palvelimen versio säilyy ja sinun muutoksesi poistetaan. Tätä ei voi perua.',
          confirmLabel: 'Hylkää oma muutos',
          cancelLabel: 'Pidä toistaiseksi',
          destructive: true
        });
        if (drop) offline.resolve(item.id, 'discard');
      } else if (item.status === OP_STATUS.FAILED) {
        const reason = failedReason(item.lastErrorCode);
        const retry = await confirmAction({
          title: 'Synkronointi epäonnistui',
          message: `"${item.title || 'Tehtävä'}" ei lähtenyt palvelimelle. ${reason.text}`,
          confirmLabel: reason.retryHelps ? 'Yritä uudelleen' : 'Yritä silti uudelleen',
          cancelLabel: 'Ei nyt'
        });
        if (retry) {
          offline.resolve(item.id, 'retry');
          continue;
        }
        const drop = await confirmAction({
          title: 'Hylätäänkö muutos?',
          message: 'Muutos poistetaan tältä laitteelta eikä sitä lähetetä. Tätä ei voi perua.',
          confirmLabel: 'Hylkää muutos',
          cancelLabel: 'Pidä toistaiseksi',
          destructive: true
        });
        if (drop) offline.resolve(item.id, 'discard');
      }
    }
    await offline.replay();
  } catch (error) {
    showError(error, 'Tarkistus ei onnistunut.');
  } finally {
    reviewing = false;
    refreshSyncStatus();
  }
}

/** Kytke tilarivi. Kutsutaan kerran käynnistyksessä. */
export function initOfflineStatus() {
  subscribeSyncStatus(render);
  const node = maybe('syncStatus');
  if (node) node.addEventListener('click', reviewProblems);
}
