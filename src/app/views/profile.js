// Profiili ja asetukset.
//
// Profiilin kentät eivät ole koristeita: ne syöttävät suoraan
// aikataulumoottoria. Työmatka ja aamutoimet määrittävät automaattisen
// herätysajan, unitavoite nukkumaanmenoajan. Siksi näkymä myös näyttää,
// mihin kukin arvo vaikuttaa.

import { escapeHtml } from '../../lib/format.js';
import { fmtISO } from '../../lib/datetime.js';
import { computeWakeTime, computeBedtime } from '../../domain/scheduler.js';
import { el, maybe, setText, toggle, setBusy, singleFlight } from '../../ui/dom.js';
import { getState, viewDateIso } from '../state.js';
import { saveProfile, incompleteExportCollections } from '../actions.js';
import { confirmAction } from '../../ui/confirm.js';
import { userEmail } from '../../data/session.js';
import { volatileFields } from '../../data/schema.js';
import {
  capabilities, notifications as platformNotifications, location as platformLocation
} from '../../platform/index.js';
import { buildUserDataExport, serializeExport, EXPORTED_COLLECTIONS } from '../../domain/dataExport.js';
import { countOf } from '../../domain/lifeArea.js';
import { renderAccountDeletionSection } from '../accountDeletion.js';
import { logEvent, LOG_LEVEL } from '../../lib/logger.js';

function numberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readForm() {
  return {
    age: numberOrNull(el('pfAge').value),
    weightKg: numberOrNull(el('pfWeight').value),
    heightCm: numberOrNull(el('pfHeight').value),
    sleepTargetHours: numberOrNull(el('pfSleepTarget').value) || 8,
    defaultWakeTime: el('pfDefaultWake').value || '07:00',
    commuteMinutes: numberOrNull(el('pfCommute').value) ?? 30,
    routineMinutes: numberOrNull(el('pfRoutine').value) ?? 60
  };
}

/** Täytä lomake nykyisestä profiilista. */
export function fillProfileForm() {
  const { profile } = getState();
  el('pfAge').value = profile.age ?? '';
  el('pfWeight').value = profile.weightKg ?? '';
  el('pfHeight').value = profile.heightCm ?? '';
  el('pfSleepTarget').value = profile.sleepTargetHours ?? 8;
  el('pfDefaultWake').value = profile.defaultWakeTime ?? '07:00';
  el('pfCommute').value = profile.commuteMinutes ?? 30;
  el('pfRoutine').value = profile.routineMinutes ?? 60;
}

/**
 * Näytä, mitä nykyiset asetukset tarkoittavat käytännössä.
 * Tämä tekee abstrakteista luvuista ymmärrettäviä.
 */
function renderPreview() {
  const container = maybe('pfPreview');
  if (!container) return;

  const state = getState();
  const dateIso = viewDateIso();
  const wake = computeWakeTime({ tasks: state.tasks, profile: state.profile, dateIso });
  const bedtime = computeBedtime({ tasks: state.tasks, profile: state.profile, dateIso });

  container.innerHTML = `
    <div class="preview-title">Näillä asetuksilla</div>
    <div class="preview-row">
      <span>Herätys</span>
      <strong>${escapeHtml(wake.time)}</strong>
      <span class="muted">${wake.auto ? 'laskettu' : 'oma merkintä'}</span>
    </div>
    <div class="preview-row">
      <span>Nukkumaan</span>
      <strong>${escapeHtml(bedtime.bedtime)}</strong>
      <span class="muted">jotta huomenna ${escapeHtml(bedtime.wakeTime)}</span>
    </div>`;
}

/** Kerro rehellisesti, jos osa kentistä ei vielä tallennu. */
function renderSchemaNotice() {
  const container = maybe('pfSchemaNotice');
  if (!container) return;

  const fields = volatileFields();
  if (fields.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = `<div class="notice">
    Tehtävien kuvaus, kesto ja prioriteetti näkyvät toistaiseksi vain tämän
    istunnon ajan. Ne alkavat tallentua, kun tietokannan päivitys on tehty.
  </div>`;
}

/**
 * Yhden kyvykkyyden rivi tietosuojanäkymässä.
 *
 * Kolme väriä kertovat kolme eri tilaa: käytössä nyt, ei vielä toteutettu
 * tällä alustalla, tai lupa evätty/kysymättä. Teksti ei koskaan lupaa
 * enempää kuin `capabilities()` todella kertoo.
 */
function capabilityRow(item) {
  const tone = !item.supported ? 'clay' : item.available ? 'sage' : 'gold';
  const status = !item.supported
    ? 'Ei tuettu tällä alustalla'
    : !item.implemented
      ? (item.plannedNote || 'Ei vielä toteutettu')
      : item.permission === 'granted' ? 'Lupa myönnetty'
        : item.permission === 'denied' ? 'Lupa evätty'
          : item.permission === 'not_required' ? 'Ei vaadi lupaa'
            : 'Lupaa ei ole vielä kysytty';
  return `<div class="notice tone-${tone}"><strong>${escapeHtml(item.label)}</strong> — ${escapeHtml(status)}</div>`;
}

/**
 * Sijainnin tila ja hallinta.
 *
 * SIJAINTIA EI PYYDETÄ TÄÄLTÄ ITSESTÄÄN: lupa kysytään vain painikkeen
 * painalluksesta, ja haku on kertaluonteinen kokeilu, joka kertoo vain
 * tarkkuuden. Koordinaatteja ei näytetä, tallenneta eikä lähetetä minnekään.
 */
function locationControlsHtml() {
  const state = platformLocation.capability();
  if (!state.supported || !state.implemented) {
    return `<div class="hint" style="margin-top:6px;">${escapeHtml(state.reason || 'Sijainti ei ole käytettävissä.')}</div>`;
  }

  const permission = platformLocation.permissionState();
  const canAsk = permission === 'not_requested' || permission === 'prompt' || permission === 'denied';
  const canTry = permission === 'granted';

  return `
    <div class="hint" id="pfLocationStatus" style="margin-top:6px;">${escapeHtml(platformLocation.describePermission(permission))}</div>
    <div class="form-actions" style="margin-top:6px; flex-wrap:wrap;">
      <button class="form-btn" id="pfLocationRefreshBtn" type="button">Tarkista sijaintilupa</button>
      ${canAsk ? '<button class="form-btn" id="pfLocationAskBtn" type="button">Salli sijainti</button>' : ''}
      ${canTry ? '<button class="form-btn" id="pfLocationTryBtn" type="button">Kokeile sijainnin hakua</button>' : ''}
    </div>
    <div class="hint" id="pfLocationMsg" role="status" aria-live="polite" style="margin-top:4px;"></div>
    <div class="hint" style="margin-top:4px;">
      Sijaintia haetaan vain kun pyydät, kerran kerrallaan. Sitä ei tallenneta,
      lähetetä tekoälylle eikä sisällytetä vientiin. Taustaseurantaa ei ole.
    </div>`;
}

function wireLocationControls() {
  const message = text => { const node = maybe('pfLocationMsg'); if (node) node.textContent = text; };
  const rerender = () => renderPrivacyCenter();

  const refresh = maybe('pfLocationRefreshBtn');
  if (refresh) refresh.addEventListener('click', async () => {
    await platformLocation.refreshPermission();
    rerender();
  });

  const ask = maybe('pfLocationAskBtn');
  if (ask) ask.addEventListener('click', async () => {
    const result = await platformLocation.requestPermission();
    logEvent('location.permission', { state: result.state });
    rerender();
    message(result.reason);
  });

  const attempt = maybe('pfLocationTryBtn');
  if (attempt) attempt.addEventListener('click', async () => {
    message('Haetaan…');
    const result = await platformLocation.current({ allowPrompt: false });
    // Vain onnistuiko ja virhekoodi. Koordinaatit eivät koskaan lokiin.
    logEvent('location.attempt', { ok: result.ok, code: result.ok ? null : result.code });
    const text = result.ok
      ? `Sijainti saatu (tarkkuus ±${result.position.accuracyMeters ?? '?'} m). Sitä ei tallenneta.`
      : result.reason;
    // Uudelleenrenderöinti tyhjentää viestin, joten viesti asetetaan sen jälkeen.
    rerender();
    message(text);
  });
}

/** Renderöi tietosuoja- ja kyvykkyysosio. */
function renderPrivacyCenter() {
  const container = maybe('pfCapabilities');
  if (!container) return;

  const caps = capabilities();
  const rows = Object.values(caps.registry).map(capabilityRow).join('');

  // Ajastettujen ilmoitusten määrä on hyödyllinen vain natiivikuoressa,
  // jossa laite todella pitää kirjaa. Selaimessa se olisi aina nolla eikä
  // kertoisi mitään — jätetään siksi kokonaan pois sieltä.
  const showPendingCount = caps.native && caps.registry.notifications.available;

  container.innerHTML = `
    <h2 class="section-title">Tietosuoja ja oikeudet</h2>
    <div class="hint" style="margin-bottom:8px;">
      Alusta: ${escapeHtml(caps.platform)}${caps.native ? ' (natiivisovellus)' : ' (selain)'}
    </div>
    ${rows}
    ${locationControlsHtml()}
    ${showPendingCount
      ? '<div class="hint" id="pfPendingNotices">Ajastettuja ilmoituksia laitteella: …</div>'
      : ''}
    <div class="form-actions" style="margin-top:10px;">
      <button class="form-btn" id="pfExportBtn" type="button">Lataa oma data (JSON)</button>
    </div>
    <div class="hint" style="margin-top:4px;">
      Vienti sisältää kaiken oman tietosi — ei koskaan tunnuksia, tokeneita
      eikä muiden käyttäjien tietoja.
    </div>
    <div id="pfExportMsg" style="display:none; font-size:12px; margin-top:6px;" role="status"></div>`;

  const exportBtn = maybe('pfExportBtn');
  if (exportBtn) exportBtn.addEventListener('click', runExport);
  wireLocationControls();

  if (showPendingCount) {
    // Kysytään laitteelta erikseen: pendingCount on asynkroninen eikä sitä
    // odoteta ennen renderöintiä, jottei koko profiilinäkymä jäisi kiinni
    // yhteen liitännäiskutsuun.
    platformNotifications.pendingCount().then(count => {
      const node = maybe('pfPendingNotices');
      if (node) node.textContent = `Ajastettuja ilmoituksia laitteella: ${count}`;
    }).catch(() => { /* laskuri on mukavuus, ei kriittinen tieto */ });
  }
}

/**
 * "Poista tili" -osio. Koko virta (esikatselu, kirjoitettu vahvistus,
 * palvelinkutsu) on src/app/accountDeletion.js:ssä; tämä vain antaa sille
 * säiliön ja datan lähteen. Ks. docs/ACCOUNT-DELETION.md.
 */
function renderAccountDeletion() {
  renderAccountDeletionSection(
    maybe('pfAccountDeletion'),
    () => collectExportData(getState()));
}

/**
 * Kokoa vientiin annettava data nykyisestä tilasta.
 *
 * LUETTELO TULEE YKSISTÄÄN EXPORTED_COLLECTIONS:STA. Käsin kirjoitettu
 * kopio ajautuisi siitä eroon ensimmäisellä unohtuneella tietotyypin
 * lisäyksellä, ja vienti näyttäisi onnistuneen vaikka jokin kokoelma
 * puuttuisi tiedostosta hiljaa.
 *
 * PROFIILI VAIN JOS RIVI ON OLEMASSA. Tilassa on aina profiili
 * (oletusarvoin), mutta kannassa rivi on vasta kun käyttäjä on tallentanut
 * sen. Oletusarvot eivät ole käyttäjän dataa: vienti ei väitä niitä hänen
 * tiedoikseen, eikä poiston esikatselu laske riviä, jota ei ole.
 * (Muistutusasetuksille vastaavaa olemassaolotietoa ei vielä ole tilassa.)
 */
export function collectExportData(state) {
  const data = {};
  for (const name of EXPORTED_COLLECTIONS) data[name] = state[name];
  if (state.profileExists !== true) data.profile = null;
  return data;
}

/** Käynnistä tiedoston lataus selaimessa. */
function triggerDownload(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Vienti olisi vajaa: osa kokoelmista ei latautunut (ERR-03). */
export const EXPORT_INCOMPLETE_MESSAGE = 'Osa tiedoista ei latautunut, joten vienti olisi vajaa. '
  + 'Lataa vienti uudelleen, kun kaikki tiedot ovat näkyvissä.';

/**
 * Koosta ja lataa vienti.
 *
 * VAJAA VIENTI EI OLE ONNISTUNUT VIENTI. Vienti lukee tilasta, ja
 * epäonnistunut haku jättää kokoelman tyhjäksi. Aiemmin tiedosto
 * kirjoitti sen tyhjänä ja näkymä sanoi "Tiedosto ladattu.", vaikka
 * vienti lupaa "kaiken oman tietosi". Nyt vajaa vienti ladataan vain
 * käyttäjän nimenomaisesta valinnasta, ja tiedosto kertoo puuttuvat
 * kokoelmat (`incomplete`).
 *
 * @param {object} [deps] testejä varten
 * @returns {Promise<{downloaded: boolean, incomplete: string[], message: string}>}
 */
export async function exportUserData({
  state = getState(), confirmFn = confirmAction, download = triggerDownload, now = () => new Date()
} = {}) {
  const incomplete = incompleteExportCollections(state);
  if (incomplete.length > 0) {
    const proceed = await confirmFn({
      title: 'Vienti olisi vajaa',
      message: EXPORT_INCOMPLETE_MESSAGE,
      confirmLabel: 'Lataa silti vajaana',
      cancelLabel: 'Peruuta'
    });
    if (!proceed) return { downloaded: false, incomplete, message: EXPORT_INCOMPLETE_MESSAGE };
  }
  const exported = buildUserDataExport(collectExportData(state), {
    exportedAt: now().toISOString(),
    appVersion: null
  });
  if (incomplete.length > 0) exported.incomplete = incomplete;
  download(`manifestival-vienti-${fmtISO(now())}.json`, serializeExport(exported));
  const message = incomplete.length > 0
    ? `Vajaa vienti ladattu: ${countOf(incomplete.length, 'tietotyyppi', 'tietotyyppiä')} puuttuu. `
      + 'Lataa vienti uudelleen, kun kaikki tiedot ovat näkyvissä.'
    : 'Tiedosto ladattu.';
  return { downloaded: true, incomplete, message };
}

const runExport = singleFlight(async () => {
  const button = maybe('pfExportBtn');
  const msg = maybe('pfExportMsg');
  setBusy(button, true, 'Kootaan…');
  let message = 'Viennin luonti epäonnistui. Yritä uudelleen.';
  let complete = false;
  try {
    const result = await exportUserData();
    message = result.message;
    complete = result.downloaded && result.incomplete.length === 0;
  } catch {
    logEvent('export.failed', { code: 'exception' }, LOG_LEVEL.WARN);
  } finally {
    setBusy(button, false);
    if (msg) {
      msg.textContent = message;
      msg.style.display = 'block';
      // Onnistuminen häviää, vajaan viennin ohje jää luettavaksi pidemmäksi aikaa.
      setTimeout(() => { msg.style.display = 'none'; }, complete ? 3000 : 10000);
    }
  }
});

/** Renderöi profiilinäkymä. */
export function renderProfile() {
  setText('signoutEmail', userEmail());
  renderPreview();
  renderSchemaNotice();
  renderPrivacyCenter();
  renderAccountDeletion();
}

const submitProfile = singleFlight(async () => {
  const saveButton = el('pfSave');
  const okMessage = el('pfSavedMsg');
  const errorMessage = el('pfErrorMsg');

  toggle('pfSavedMsg', false);
  toggle('pfErrorMsg', false);

  setBusy(saveButton, true, 'Tallennetaan…');
  try {
    const saved = await saveProfile(readForm());
    const target = saved ? okMessage : errorMessage;
    target.style.display = 'block';
    setTimeout(() => { target.style.display = 'none'; }, 2500);
  } finally {
    setBusy(saveButton, false);
  }
});

/** Kytke profiilinäkymän tapahtumat. */
export function initProfileForm() {
  el('pfSave').addEventListener('click', submitProfile);

  // Esikatselu päivittyy heti, kun arvoa muutetaan — muutoksen vaikutus näkyy
  // ennen tallennusta.
  for (const id of ['pfSleepTarget', 'pfDefaultWake', 'pfCommute', 'pfRoutine']) {
    el(id).addEventListener('input', () => {
      const preview = maybe('pfPreview');
      if (!preview) return;
      const draft = readForm();
      const state = getState();
      const wake = computeWakeTime({ tasks: state.tasks, profile: draft, dateIso: viewDateIso() });
      const bedtime = computeBedtime({ tasks: state.tasks, profile: draft, dateIso: viewDateIso() });
      preview.innerHTML = `
        <div class="preview-title">Näillä asetuksilla</div>
        <div class="preview-row"><span>Herätys</span><strong>${escapeHtml(wake.time)}</strong>
          <span class="muted">${wake.auto ? 'laskettu' : 'oma merkintä'}</span></div>
        <div class="preview-row"><span>Nukkumaan</span><strong>${escapeHtml(bedtime.bedtime)}</strong>
          <span class="muted">jotta huomenna ${escapeHtml(bedtime.wakeTime)}</span></div>`;
    });
  }
}
