// Skeematarkistuksen näkyvä tila: rajoitetun tilan rivi ja huoltokatko.
//
// KÄYTTÄJÄ EI NÄE TAULUJA, SARAKKEITA EIKÄ VIRHEKOODEJA. Hän näkee sen,
// mikä häntä koskee:
//
//   rajoitettu   osa uusista ominaisuuksista ei ole vielä käytössä;
//                tehtävät ja tavoitteet toimivat (role=status, ei keskeytä)
//   huoltokatko  kannan ydin puuttuu: mitään ei tallenneta, ja koko näytön
//                ilmoitus kertoo sen. "Yritä uudelleen" tarkistaa uudelleen,
//                "Kirjaudu ulos" vapauttaa laitteen.
//
// Tekniset tiedot näyttävät VAIN migraatiotunnisteet (esim. "0012"),
// erillisen avauksen takana. Tila tulee src/data/schemaRuntime.js:stä.

import { maybe } from '../ui/dom.js';
import {
  subscribeSchemaStatus, schemaSnapshot, schemaGeneration, setReprobeHandler,
  isWritable, SCHEMA_STATUS
} from '../data/schemaRuntime.js';
import { ensureSchemaCompatibility, scheduleSchemaReprobe } from '../data/schemaProbe.js';
import { getClient } from '../data/client.js';

/** Kaikki käyttäjälle näkyvä teksti. Testi varmistaa, ettei skeeman nimiä vuoda. */
export const SCHEMA_COPY = Object.freeze({
  degraded: 'Osa uusista ominaisuuksista ei ole vielä käytössä, koska palvelua päivitetään. '
    + 'Tehtäväsi ja tavoitteesi toimivat normaalisti.',
  maintenanceTitle: 'Huoltokatko',
  maintenance: 'Palvelussa on huoltokatko. Tietosi ovat tallessa, ja tälle laitteelle jääneet '
    + 'muutokset lähetetään, kun palvelu toimii taas.',
  checking: 'Tarkistetaan palvelun tilaa…',
  stillDown: 'Palvelu ei ole vielä käytettävissä. Yritä hetken kuluttua uudelleen.',
  signOutFailed: 'Uloskirjautuminen ei onnistunut. Yritä uudelleen.',
  detailsPrefix: 'Odottaa palvelimen päivitystä: '
});

/**
 * Näkymän huomautus, kun portti on käännösaikaisesti auki mutta kanta ei
 * vielä tue ominaisuutta (ajon aikana laskettu). Eri asia kuin "säilyy
 * vain istunnon ajan": nyt muutokset torjutaan eikä niitä pidetä muistissa.
 */
export const SERVER_UNAVAILABLE_HINT = 'Tämä osa ei ole vielä käytössä tällä palvelimella, '
  + 'joten muutokset eivät tallennu. Aiemmin tallennettu tieto säilyy.';

export function serverUnavailableHintHtml() {
  return `<p class="hint"><strong>Huom.</strong> ${SERVER_UNAVAILABLE_HINT}</p>`;
}

/** Tekniset tiedot: pelkät migraatiotunnisteet, ei nimiä eikä koodeja. */
export function technicalDetails(snapshot) {
  const pending = (snapshot && snapshot.pendingMigrations) || [];
  const ids = pending.filter(id => /^\d{4}$/.test(String(id)));
  return ids.length ? SCHEMA_COPY.detailsPrefix + ids.join(', ') : '';
}

/**
 * PUHDAS: tilannekuva -> mitä näytetään. null = ei näytetä.
 *
 * @returns {{banner: null|{text:string, details:string},
 *            maintenance: null|{title:string, text:string, details:string}}}
 */
export function describeSchemaStatus(snapshot) {
  const status = snapshot && snapshot.status;
  const details = technicalDetails(snapshot);
  return {
    banner: status === SCHEMA_STATUS.DEGRADED ? { text: SCHEMA_COPY.degraded, details } : null,
    maintenance: status === SCHEMA_STATUS.MAINTENANCE
      ? { title: SCHEMA_COPY.maintenanceTitle, text: SCHEMA_COPY.maintenance, details }
      : null
  };
}

let active = false;
let retrying = false;
let loweredSinceReprobe = false;
let onRecovered = () => {};
let lastKey = null;

/** Elementti tai null. Toimii myös ilman DOMia (testit, esilataus). */
function node(id) {
  return typeof document === 'undefined' ? null : maybe(id);
}

function setText(id, text) {
  const target = node(id);
  if (target) target.textContent = text;
}

function render(snapshot = schemaSnapshot()) {
  const view = active ? describeSchemaStatus(snapshot) : { banner: null, maintenance: null };
  const key = JSON.stringify(view);
  if (key === lastKey) return;
  lastKey = key;

  const banner = node('schemaBanner');
  if (banner) {
    banner.hidden = !view.banner;
    setText('schemaBannerText', view.banner ? view.banner.text : '');
    setText('schemaBannerDetails', view.banner ? view.banner.details : '');
    const toggle = node('schemaBannerDetailsWrap');
    if (toggle) toggle.hidden = !(view.banner && view.banner.details);
  }

  const overlay = node('schemaMaintenance');
  if (overlay) {
    const wasHidden = overlay.hidden;
    overlay.hidden = !view.maintenance;
    setText('schemaMaintenanceDetails', view.maintenance ? view.maintenance.details : '');
    const detailsWrap = node('schemaMaintenanceDetailsWrap');
    if (detailsWrap) detailsWrap.hidden = !(view.maintenance && view.maintenance.details);
    // Taustalla oleva sovellus ei saa ottaa fokusta eikä syötettä, kun
    // huoltoilmoitus on päällä.
    const app = node('app');
    if (app) app.inert = Boolean(view.maintenance);
    if (view.maintenance && wasHidden) {
      setText('schemaMaintenanceStatus', '');
      const retry = node('schemaRetry');
      if (retry && typeof retry.focus === 'function') retry.focus();
    }
  }
}

/**
 * "Yritä uudelleen": tasan yksi tarkistus per painallus, ei rinnakkaisia.
 * Kun huoltotila päättyy, kutsutaan palautus (lähetys ja lataus).
 *
 * @returns {Promise<{ran:boolean, recovered?:boolean}>}
 */
export async function retrySchemaCheck({ ensure = ensureSchemaCompatibility } = {}) {
  if (retrying) return { ran: false };
  retrying = true;
  const button = node('schemaRetry');
  if (button) button.disabled = true;
  setText('schemaMaintenanceStatus', SCHEMA_COPY.checking);
  try {
    await ensure({ force: true, timeoutMs: 8000 });
    const recovered = isWritable();
    setText('schemaMaintenanceStatus', recovered ? '' : SCHEMA_COPY.stillDown);
    if (recovered && active) {
      try { onRecovered(); } catch { /* palautus ei kaada näkymää */ }
    }
    return { ran: true, recovered };
  } finally {
    retrying = false;
    if (button) button.disabled = false;
  }
}

async function signOutFromMaintenance() {
  try {
    await getClient().auth.signOut();
  } catch {
    setText('schemaMaintenanceStatus', SCHEMA_COPY.signOutFailed);
  }
}

/**
 * Kannan skeemavirhe pyysi uutta tarkistusta (src/data/schema.js).
 *
 * Jos virhe laski portin ('lowered') tai tarkistus muutti kyvykkyyttä,
 * odottavat muutokset lähetetään heti uudelleen (onRecovered). Laskettu
 * tieto on pysyvä istunnon ajan, joten tämä ei voi kiertää kehää.
 */
function handleReprobeRequest(reason) {
  if (reason === 'lowered') loweredSinceReprobe = true;
  const before = schemaGeneration();
  const pending = scheduleSchemaReprobe();
  if (!pending) return null;
  return pending.then(() => {
    const changed = loweredSinceReprobe || schemaGeneration() !== before;
    loweredSinceReprobe = false;
    if (active && changed && isWritable()) {
      try { onRecovered(); } catch { /* ignore */ }
    }
  });
}

/**
 * Kytke tilarivi ja huoltoilmoitus. Kutsutaan kerran käynnistyksessä.
 *
 * @param {object} [options]
 * @param {() => void} [options.onRecovered] huoltotila päättyi tai portti
 *   laski: lähetä odottavat muutokset ja lataa tiedot uudelleen
 */
export function initSchemaStatus({ onRecovered: recovered } = {}) {
  onRecovered = typeof recovered === 'function' ? recovered : () => {};
  setReprobeHandler(handleReprobeRequest);
  subscribeSchemaStatus(snapshot => render(snapshot));
  const retry = node('schemaRetry');
  if (retry) retry.addEventListener('click', () => { retrySchemaCheck(); });
  const signOut = node('schemaSignOut');
  if (signOut) signOut.addEventListener('click', signOutFromMaintenance);
  render();
}

/**
 * Näytetäänkö tila? Vain kirjautuneelle: uloskirjautuessa kaikki piiloon
 * (kirjautumisportti ei saa jäädä huoltoilmoituksen alle).
 */
export function setSchemaStatusActive(value) {
  active = Boolean(value);
  loweredSinceReprobe = false;
  lastKey = null;
  render();
}
