// Aloitusasetukset: vaiheittainen, valinnainen ensikäytön lista (Profiili).
//
// "Extend onboarding without creating a wall of questions" (paketti §75).
// Opastusikkuna pysyy kevyenä; tämä lista kertoo Profiilin yläosassa, mitkä
// arjen perusasiat on jo kerrottu ja mitkä ovat vielä oletuksella, ja vie
// yhdellä napautuksella oikeaan kenttään. Mitään ei kysytä ikkunassa eikä
// kytketä päälle puolesta.
//
// TILA TULEE TIEDOISTA, EI MERKINNÖISTÄ. Kohta on "valmis", kun sen tieto on
// olemassa (profiili tallennettu, paikka lisätty, arjen asetukset tallennettu
// ...). Vain listan piilotus on käyttäjäkohtainen merkintä laitteella.
//
// Pakollinen ydin on yksi: unitavoite ja arkiherätys (niistä lasketaan
// herätys, uni ja päivän kapasiteetti). Kaikki muu on valinnaista ja sanoo sen.

import { maybe, renderHtml } from '../../ui/dom.js';
import { escapeHtml } from '../../lib/format.js';
import { getState, currentLifeSettings, setProfileSegment } from '../state.js';
import { switchTab } from '../navigation.js';
import { getUser } from '../../data/session.js';
import { getUserPreference, setUserPreference } from '../../data/preferences.js';
import { HABIT_KIND } from '../../domain/dailyLife.js';

const CONTAINER_ID = 'profileSetupChecklist';
const listOf = value => (Array.isArray(value) ? value : []);
const wired = new WeakSet();

/**
 * Kohdat järjestyksessä. `target`: minne napautus vie (välilehti, Profiilin
 * osio ja ensimmäinen kenttä, joka saa fokuksen).
 */
const ITEMS = Object.freeze([
  { key: 'sleep', label: 'Unitavoite ja arkiherätys', core: true,
    target: { screen: 'screen-profile', segment: 'daily', focus: '#dsSleepTarget' } },
  { key: 'lifeAreas', label: 'Elämänalueet', core: false,
    target: { screen: 'screen-direction', segment: null, focus: null } },
  { key: 'capacity', label: 'Viikon kapasiteetti', core: false,
    target: { screen: 'screen-direction', segment: null, focus: null } },
  { key: 'weekend', label: 'Viikonlopun rytmi', core: false,
    target: { screen: 'screen-profile', segment: 'daily', focus: '#dsWeekendWakeShift' } },
  { key: 'buffer', label: 'Etuaika perille', core: false,
    target: { screen: 'screen-profile', segment: 'places', focus: '[data-action="buffer-set"]' } },
  { key: 'places', label: 'Koti, työ ja muut paikat', core: false, optional: true,
    target: { screen: 'screen-profile', segment: 'places', focus: '[data-action="place-add"]' } },
  { key: 'routine', label: 'Aamurutiini', core: false, optional: true,
    target: { screen: 'screen-profile', segment: 'daily', focus: '#dsStepAdd' } },
  { key: 'style', label: 'Ohjaustyyli ja muistutukset', core: false,
    target: { screen: 'screen-profile', segment: 'settings', focus: 'input[name="gsStyle"]' } },
  { key: 'voice', label: 'Puhe', core: false, optional: true,
    target: { screen: 'screen-profile', segment: 'settings', focus: '#gsSpeech' } },
  { key: 'meals', label: 'Ateriarytmi', core: false, optional: true,
    target: { screen: 'screen-profile', segment: 'daily', focus: '#dsMealAdd' } },
  { key: 'nicotine', label: 'Nikotiinituki', core: false, optional: true,
    target: { screen: 'screen-profile', segment: 'wellbeing', focus: '[data-action="habit-add"]' } }
]);

/**
 * Listan malli tilasta (puhdas). Arjen asetukset "kerrottu" = rivi on
 * tallennettu: oletukset ovat järkeviä, mutta käyttäjä ei ole vielä nähnyt
 * niitä, joten ne näytetään oletuksina eikä valmiina.
 *
 * @returns {{items: Array<{key,label,core,optional,done,note}>, doneCount:number, total:number, coreDone:boolean}}
 */
export function setupChecklistModel(state = getState()) {
  const settings = currentLifeSettings(state);
  const settingsSaved = listOf(state.lifeSettings).length > 0;
  const profileSaved = state.profileExists === true;
  const done = {
    sleep: profileSaved,
    lifeAreas: listOf(state.lifeAreas).length > 0,
    capacity: listOf(state.weeklyCapacities).length > 0,
    weekend: settingsSaved,
    buffer: settingsSaved,
    places: listOf(state.savedPlaces).length > 0,
    routine: listOf(settings.morningRoutine).length > 0,
    style: settingsSaved,
    voice: settings.speechEnabled === true,
    meals: listOf(settings.mealRhythm && settings.mealRhythm.meals).length > 0,
    nicotine: listOf(state.habitPlans).some(plan => plan && plan.kind === HABIT_KIND.NICOTINE)
  };
  const items = ITEMS.map(item => {
    let note;
    if (done[item.key]) note = 'kerrottu';
    else if (item.core) note = 'tarvitaan herätykseen ja uneen';
    else if (item.optional) note = 'valinnainen';
    else if (item.key === 'weekend' || item.key === 'buffer' || item.key === 'style') note = 'oletus käytössä';
    else note = 'ei vielä';
    return Object.freeze({ key: item.key, label: item.label, core: item.core, optional: Boolean(item.optional), done: done[item.key], note });
  });
  const doneCount = items.filter(item => item.done).length;
  return Object.freeze({ items, doneCount, total: items.length, coreDone: done.sleep });
}

function userId() {
  const user = getUser();
  return user && user.id ? String(user.id) : null;
}

function hidden() {
  const id = userId();
  return id ? getUserPreference(id, 'setupChecklistHidden') === true : false;
}

/** Piirrä lista Profiilin yläosaan (tai ei mitään, jos käyttäjä piilotti sen). */
export function renderSetupChecklist(container = maybe(CONTAINER_ID)) {
  if (!container) return;
  if (!userId() || hidden()) {
    renderHtml(container, '');
    return;
  }
  const model = setupChecklistModel();
  const rows = model.items.map(item => `
      <li class="setup-row${item.done ? ' is-done' : ''}">
        <button type="button" class="setup-open" data-setup-open="${escapeHtml(item.key)}"
          aria-label="${escapeHtml(`${item.label}: ${item.note}. Avaa`)}">
          <span class="setup-mark" aria-hidden="true">${item.done ? '✓' : '○'}</span>
          <span class="setup-label">${escapeHtml(item.label)}</span>
          <span class="setup-note">${escapeHtml(item.note)}</span>
        </button>
      </li>`).join('');
  renderHtml(container, `
    <section class="card setup-checklist" aria-labelledby="setupTitle">
      <h2 class="section-title" id="setupTitle">Aloitusasetukset <span class="count-badge">${model.doneCount}/${model.total}</span></h2>
      <p class="hint">${model.coreDone
        ? 'Perusasiat on kerrottu. Loput ovat valinnaisia: täydennä, kun haluat.'
        : 'Kerro ainakin unitavoite ja arkiherätys, niin herätys ja uni lasketaan sinun rytmistäsi. Muu on valinnaista.'}</p>
      <ul class="setup-list">${rows}</ul>
      <div class="assist-actions"><button type="button" class="assist-btn" data-setup-hide>Piilota lista</button></div>
    </section>`);
}

/** Näkymä piirtyy tilamuutoksesta synkronisesti, joten kenttä on jo olemassa. */
function focusTarget(selector) {
  if (!selector || typeof document === 'undefined') return;
  const node = document.querySelector(selector);
  if (node && typeof node.focus === 'function') node.focus();
}

/** Vie kohdan asetukseen: välilehti, Profiilin osio ja ensimmäinen kenttä. */
export function openSetupItem(key) {
  const item = ITEMS.find(entry => entry.key === key);
  if (!item) return false;
  switchTab(item.target.screen);
  if (item.target.segment) setProfileSegment(item.target.segment);
  focusTarget(item.target.focus);
  return true;
}

/** Kytke kuuntelijat kerran (main.js start). */
export function initSetupChecklist(container = maybe(CONTAINER_ID)) {
  if (!container || wired.has(container)) return;
  wired.add(container);
  container.addEventListener('click', event => {
    const target = event.target && typeof event.target.closest === 'function' ? event.target : null;
    if (!target) return;
    const open = target.closest('[data-setup-open]');
    if (open) {
      openSetupItem(open.getAttribute('data-setup-open'));
      return;
    }
    if (target.closest('[data-setup-hide]')) {
      const id = userId();
      if (id) setUserPreference(id, 'setupChecklistHidden', true);
      renderSetupChecklist(container);
      const title = maybe('segmentProfileDaily');
      if (title && typeof title.focus === 'function') title.focus();
    }
  });
}
