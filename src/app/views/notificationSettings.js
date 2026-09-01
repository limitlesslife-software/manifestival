// Muistutusasetukset.
//
// Näkymän tärkein tehtävä ei ole säätimien tarjoaminen vaan REHELLISYYS.
// Käyttäjän on nähtävä yhdellä silmäyksellä, mitä muistutuksista voi juuri
// tällä alustalla odottaa — eikä lupauksia saa antaa yli sen.
//
// Selaimessa muistutus näkyy vain kun sovellus on auki. Android-sovelluksessa
// se toimii myös suljettuna. Ero on käyttäjälle iso, joten se sanotaan
// suoraan sen sijaan että toivottaisiin ettei sitä huomata.

import { escapeHtml } from '../../lib/format.js';
import { summarizeIntents, levelLabel } from '../../domain/notification.js';
import { el, maybe, setBusy, singleFlight } from '../../ui/dom.js';
import { getState } from '../state.js';
import {
  planUpcoming, syncNotifications, enableNotifications,
  disableNotifications, updatePreferences, SYNC_HORIZON_DAYS
} from '../notifications.js';
import { notifications as platformNotifications } from '../../platform/index.js';
import { isPersistent } from '../../data/notificationPrefsRepo.js';

/** Kytkimet, jotka ovat pelkkiä totuusarvoja. */
const TOGGLES = [
  ['dailyPlanEnabled', 'Päivän suunnitelma aamulla'],
  ['eveningReviewEnabled', 'Illan katsaus'],
  ['deadlineWarningsEnabled', 'Määräaikavaroitukset']
];

/** Tuen kuvaus värikoodattuna. */
function supportNotice() {
  const description = platformNotifications.describeSupport();
  const tone = description.level === 'blocked' || description.level === 'none'
    ? 'clay'
    : description.level === 'scheduled' ? 'sage' : 'gold';
  return `<div class="notice tone-${tone}">${escapeHtml(description.text)}</div>`;
}

/**
 * Esikatselu: mitä tänään lähtisi.
 *
 * Tämä on puhdas laskenta eikä ajasta mitään. Käyttäjä näkee muistutusten
 * määrän ennen kuin päättää kytkeä ne päälle.
 */
function previewSection(preferences) {
  if (!preferences.enabled) return '';

  const { intents } = planUpcoming();
  const summary = summarizeIntents(intents);

  if (summary.total === 0) {
    return '<div class="hint">Seuraaville päiville ei ole muistutettavaa.</div>';
  }

  const levels = Object.entries(summary.byLevel)
    .filter(([, count]) => count > 0)
    .map(([level, count]) =>
      `<span class="slot-chip">${escapeHtml(levelLabel(Number(level)))} ${count}</span>`)
    .join('');

  return `
    <div class="hint" style="margin-bottom:6px;">
      Seuraavan ${SYNC_HORIZON_DAYS} päivän aikana ${summary.total} muistutusta.
    </div>
    <div class="slot-row">${levels}</div>`;
}

/** Renderöi asetukset. */
export function renderNotificationSettings() {
  const container = maybe('notificationSettings');
  if (!container) return;

  const preferences = getState().notificationPreferences;
  const state = platformNotifications.capability();

  const toggles = TOGGLES.map(([key, label]) => `
    <label class="checkbox-row" for="nf-${key}">
      <input type="checkbox" id="nf-${key}" data-pref="${key}"
             ${preferences[key] ? 'checked' : ''}
             ${preferences.enabled ? '' : 'disabled'}>
      ${escapeHtml(label)}
    </label>`).join('');

  container.innerHTML = `
    <h2 class="section-title">Muistutukset</h2>
    ${supportNotice()}

    <div class="add-form" style="display:flex;">
      <label class="checkbox-row" for="nfEnabled">
        <input type="checkbox" id="nfEnabled" ${preferences.enabled ? 'checked' : ''}
               ${state.supported ? '' : 'disabled'}>
        Käytä muistutuksia
      </label>

      ${preferences.enabled ? `
        <div class="form-row">
          <div>
            <label class="field-label" for="nfTaskLead">Tehtävä (min ennen)</label>
            <input type="number" id="nfTaskLead" min="0" max="240" step="5"
                   value="${preferences.taskLeadMinutes}">
          </div>
          <div>
            <label class="field-label" for="nfRoutineLead">Rutiini (min ennen)</label>
            <input type="number" id="nfRoutineLead" min="0" max="240" step="5"
                   value="${preferences.routineLeadMinutes}">
          </div>
          <div>
            <label class="field-label" for="nfMaxPerDay">Enintään/vrk</label>
            <input type="number" id="nfMaxPerDay" min="1" max="50"
                   value="${preferences.maxPerDay}">
          </div>
        </div>

        <div class="form-row">
          <div>
            <label class="field-label" for="nfDailyPlanTime">Suunnitelma klo</label>
            <input type="time" id="nfDailyPlanTime" value="${preferences.dailyPlanTime}">
          </div>
          <div>
            <label class="field-label" for="nfEveningTime">Katsaus klo</label>
            <input type="time" id="nfEveningTime" value="${preferences.eveningReviewTime}">
          </div>
        </div>

        <div class="add-form-title" style="margin-top:6px;">Rauhoitusaika</div>
        <div class="hint">
          Rauhoitusaikana ei tule muistutuksia. Vain kriittiset läpäisevät sen.
          Väli saa ylittää keskiyön.
        </div>
        <div class="form-row">
          <div>
            <label class="field-label" for="nfQuietFrom">Alkaa</label>
            <input type="time" id="nfQuietFrom" value="${preferences.quietHours.from}">
          </div>
          <div>
            <label class="field-label" for="nfQuietTo">Päättyy</label>
            <input type="time" id="nfQuietTo" value="${preferences.quietHours.to}">
          </div>
        </div>

        ${toggles}
        ${previewSection(preferences)}
      ` : ''}

      ${isPersistent() ? '' : `<div class="hint">
        Asetukset eivät vielä säily sivun latauksen yli — tietokannan
        päivitys on tekemättä.
      </div>`}
    </div>`;

  attachHandlers();
}

/** Numerokentät ja kellonajat, jotka päivittyvät suoraan asetuksiin. */
const FIELDS = [
  ['nfTaskLead', 'taskLeadMinutes', 'number'],
  ['nfRoutineLead', 'routineLeadMinutes', 'number'],
  ['nfMaxPerDay', 'maxPerDay', 'number'],
  ['nfDailyPlanTime', 'dailyPlanTime', 'text'],
  ['nfEveningTime', 'eveningReviewTime', 'text']
];

function attachHandlers() {
  const master = maybe('nfEnabled');
  if (master) {
    master.addEventListener('change', toggleMaster);
  }

  for (const [id, key, kind] of FIELDS) {
    const input = maybe(id);
    if (!input) continue;
    input.addEventListener('change', async () => {
      const value = kind === 'number' ? Number(input.value) : input.value;
      await updatePreferences({ [key]: value });
      await syncNotifications();
    });
  }

  for (const id of ['nfQuietFrom', 'nfQuietTo']) {
    const input = maybe(id);
    if (!input) continue;
    input.addEventListener('change', async () => {
      const from = maybe('nfQuietFrom');
      const to = maybe('nfQuietTo');
      await updatePreferences({
        quietHours: { from: from ? from.value : null, to: to ? to.value : null }
      });
      await syncNotifications();
    });
  }

  for (const node of document.querySelectorAll('#notificationSettings [data-pref]')) {
    node.addEventListener('change', async () => {
      await updatePreferences({ [node.dataset.pref]: node.checked });
      await syncNotifications();
    });
  }
}

/**
 * Pääkytkin.
 *
 * singleFlight estää kaksoisklikkauksen: kaksi rinnakkaista lupapyyntöä
 * tuottaisi kaksi järjestelmädialogia päällekkäin.
 */
const toggleMaster = singleFlight(async () => {
  const master = el('nfEnabled');
  setBusy(master, true);
  try {
    if (master.checked) await enableNotifications();
    else await disableNotifications();
  } finally {
    setBusy(master, false);
  }
});
