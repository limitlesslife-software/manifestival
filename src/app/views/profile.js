// Profiili ja asetukset.
//
// Profiilin kentät eivät ole koristeita: ne syöttävät suoraan
// aikataulumoottoria. Työmatka ja aamutoimet määrittävät automaattisen
// herätysajan, unitavoite nukkumaanmenoajan. Siksi näkymä myös näyttää,
// mihin kukin arvo vaikuttaa.

import { escapeHtml } from '../../lib/format.js';
import { computeWakeTime, computeBedtime } from '../../domain/scheduler.js';
import { el, maybe, setText, toggle, setBusy, singleFlight } from '../../ui/dom.js';
import { getState, viewDateIso } from '../state.js';
import { saveProfile } from '../actions.js';
import { userEmail } from '../../data/session.js';
import { volatileFields } from '../../data/schema.js';

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

/** Renderöi profiilinäkymä. */
export function renderProfile() {
  setText('signoutEmail', userEmail());
  renderPreview();
  renderSchemaNotice();
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
