// Latausvirhe tyhjän tilan paikalla.
//
// Epäonnistunut haku EI tyhjennä tilaa (src/app/actions.js applyLoadResult),
// mutta ENSIMMÄISELLÄ latauksella tila on tyhjä. Ilman tätä Tänään sanoi
// "Päivä on vielä avoin.", Tehtävät "Ei vielä yhtään tehtävää." ja
// Tavoitteet "Ei vielä tavoitteita." -- vaikka tiedot ovat tallessa
// kannassa. Käyttäjä, joka uskoo sen, luo ne uudelleen.
//
// Ohje valitaan yleisimmän syyn mukaan (src/lib/errorMessages.js
// loadAdvice): skeema- tai istuntovirheestä ei sanota "päivitä, kun
// yhteys toimii", koska päivitys ei silloin auta.
//
// Suunnan näkymällä on oma, laajempi ilmoitus (direction.js).

import { classifyError } from '../../domain/offlineQueue.js';
import { loadAdvice } from '../../lib/errorMessages.js';

/** Laite ilmoittaa olevansa offline (sama tarkistus kuin src/app/offline.js). */
function deviceOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * Kokoelmat, joiden viimeisin haku epäonnistui.
 *
 * @param {object} state getState()
 * @param {string[]} domains esim. ['tasks', 'routines']
 * @returns {string[]}
 */
export function failedDomains(state, domains) {
  const status = (state && state.dataLoadStatus) || {};
  return domains.filter(domain => status[domain] && status[domain].ok === false);
}

/**
 * Ilmoitus tyhjän tilan tilalle, tai '' jos kaikki haut onnistuivat.
 *
 * Kiinteä teksti: ei virheen viestiä, koodia eikä kokoelman nimeä.
 * role="status" eikä "alert": näkymä piirretään uudelleen puolen minuutin
 * välein, eikä ruudunlukija saa keskeyttää käyttäjää joka kerta.
 *
 * @param {object} state
 * @param {string[]} domains
 */
export function loadFailureHtml(state, domains) {
  const failed = failedDomains(state, domains);
  if (failed.length === 0) return '';
  const offline = deviceOffline();
  const classes = failed.map(domain => classifyError(state.dataLoadStatus[domain].error, { offline }));
  return `
      <div class="empty-state load-failure" role="status">
        <div class="empty-title">Tietoja ei saatu ladattua.</div>
        <p>Ne ovat tallessa – älä luo niitä uudelleen. ${loadAdvice(classes)}</p>
      </div>`;
}
