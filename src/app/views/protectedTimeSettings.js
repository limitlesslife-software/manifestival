// Profiili → Suojattu aika: oma aika, vapaa-aika, loma ja suunnittelun väljyys.
//
// SUOJATTU AIKA EI OLE YLIJÄÄMÄÄ. Nämä ovat kapasiteettijarrun
// ensimmäisiä varauksia (docs/MENTAL-LOAD-CORE.md): ne vähennetään ennen
// kuin yhtäkään joustavaa tehtävää sijoitetaan, eikä automaatti ota niitä
// koskaan käyttöön.
//
// Kaikki kolme ovat saman protected_periods-taulun rivejä (omistajan
// päätös 4). Vapaa-ajan neljä sääntöä tallentuvat yhdellä painalluksella
// (mentalLoadActions.saveFreeTimeRules), joka vertaa haluttua sääntö-
// joukkoa olemassa olevaan eikä luo kaksoiskappaleita.
//
// Suunnittelun väljyys (puskuri) ja "lyhyt yö keventää päivää" ovat samassa
// paikassa, koska ne ovat saman jarrun osia.

import { maybe, setBusy } from '../../ui/dom.js';
import { escapeHtml } from '../../lib/format.js';
import { fmtISO, todayMidnight } from '../../lib/datetime.js';
import { getState, currentLifeSettings } from '../state.js';
import {
  saveProtectedPeriod, deleteProtectedPeriod, saveFreeTimeRules, saveVacation
} from '../mentalLoadActions.js';
import { saveLifeSettings } from '../dailyLifeActions.js';
import { saveProfile } from '../actions.js';
import {
  PROTECTED_KIND, PERIOD_RECURRENCE, freeTimeRules, describePeriod, ruleOf, RULE
} from '../../domain/protectedTime.js';
import { planningBufferRatio } from '../capacityBrake.js';
import { setDevicePreference } from '../../data/preferences.js';
import { columnGateOpen, isTableAvailable, hasTable } from '../../data/schema.js';
import { showError, success } from '../../ui/toast.js';

const WEEKDAYS = Object.freeze([
  [1, 'ma'], [2, 'ti'], [3, 'ke'], [4, 'to'], [5, 'pe'], [6, 'la'], [7, 'su']
]);

/** Puskurin vaihtoehdot: osuus vapaasta ajasta, jota ei suunnitella. */
export const BUFFER_OPTIONS = Object.freeze([0, 0.1, 0.2, 0.25, 0.3, 0.4, 0.5]);

function weekdayBoxes(prefix, selected = []) {
  return WEEKDAYS.map(([value, label]) => `
    <label class="checkbox-row pt-day">
      <input type="checkbox" id="${prefix}${value}" value="${value}" ${selected.includes(value) ? 'checked' : ''}> ${label}
    </label>`).join('');
}

function checkedDays(prefix) {
  return WEEKDAYS.map(([value]) => value).filter(value => {
    const node = maybe(`${prefix}${value}`);
    return Boolean(node && node.checked);
  });
}

function valueOf(id) {
  const node = maybe(id);
  return node ? String(node.value || '').trim() : '';
}

function periodList(periods, emptyText) {
  if (periods.length === 0) return `<p class="hint">${escapeHtml(emptyText)}</p>`;
  return `<ul class="td-list">${periods.map(period => `
    <li class="assist-row">
      <div class="assist-title">${escapeHtml(describePeriod(period))}</div>
      <div class="assist-actions">
        <button type="button" class="assist-btn danger" data-pt-delete="${escapeHtml(period.id)}"
          aria-label="${escapeHtml(`Poista: ${describePeriod(period)}`)}">Poista</button>
      </div>
    </li>`).join('')}</ul>`;
}

/** Piirrä Suojattu aika -osio. */
export function renderProtectedTimeSettings() {
  const container = maybe('protectedTimeContainer');
  if (!container) return;
  const state = getState();
  const periods = (state.protectedPeriods || []).filter(period => period && period.active !== false);
  const ownTime = periods.filter(period => period.kind === PROTECTED_KIND.OWN_TIME);
  const vacations = periods.filter(period => period.kind === PROTECTED_KIND.VACATION)
    .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  const otherFree = periods.filter(period => period.kind === PROTECTED_KIND.FREE_TIME
    && period.recurrence !== PERIOD_RECURRENCE.WEEKLY_TARGET && ruleOf(period) === RULE.OTHER);
  const rules = freeTimeRules(periods);
  const settings = currentLifeSettings(state);
  const ratio = planningBufferRatio(state);
  const today = fmtISO(todayMidnight());

  const volatile = isTableAvailable('protectedPeriods') ? ''
    : hasTable('protectedPeriods')
      ? '<p class="hint">Palvelin ei juuri nyt tallenna suojattua aikaa. Muutokset eivät säily.</p>'
      : '<p class="hint"><strong>Huom.</strong> Suojattu aika säilyy toistaiseksi vain tämän istunnon ajan (migraatio 0015).</p>';

  container.innerHTML = `
    <p class="hint">Suojattu aika ei ole ylijäämää. Se varataan ennen kuin tehtäville jää aikaa, eikä sitä käytetä automaattisesti muuhun.</p>
    ${volatile}

    <h2 class="section-title" id="ptOwnTitle">Oma aika</h2>
    <p class="hint">Harrastus, lepo, yksinolo — tai ei mitään. Tähän ei sijoiteta tehtäviä.</p>
    ${periodList(ownTime, 'Omaa aikaa ei ole vielä suojattu.')}
    <div class="add-form pt-form" role="group" aria-labelledby="ptOwnTitle" style="display:flex;">
      <fieldset class="pt-days"><legend class="field-label">Viikonpäivät</legend>${weekdayBoxes('ptOwnDay', [])}</fieldset>
      <div class="form-row">
        <div><label class="field-label" for="ptOwnFrom">Alkaa</label><input type="time" id="ptOwnFrom" value="18:00"></div>
        <div><label class="field-label" for="ptOwnTo">Päättyy</label><input type="time" id="ptOwnTo" value="20:00"></div>
        <div><label class="field-label" for="ptOwnTitleInput">Nimi (valinnainen)</label>
          <input type="text" id="ptOwnTitleInput" maxlength="60" placeholder="esim. Kitara"></div>
      </div>
      <div class="field-error" id="ptOwnError" role="alert"></div>
      <button type="button" class="form-btn primary" id="ptOwnSave">Suojaa oma aika</button>
    </div>

    <h2 class="section-title" id="ptFreeTitle">Vapaa-aika</h2>
    <p class="hint">Yksi sääntöjoukko: vähimmäismäärä, vapaat illat, pääosin vapaa sunnuntai ja takaraja velvoitteille.</p>
    <div class="add-form pt-form" role="group" aria-labelledby="ptFreeTitle" style="display:flex;">
      <div class="form-row">
        <div><label class="field-label" for="ptFreeMin">Vapaa-aikaa vähintään (h viikossa)</label>
          <input type="number" id="ptFreeMin" min="0" max="168" step="0.5" value="${rules.minimumMinutes ? rules.minimumMinutes / 60 : ''}" placeholder="esim. 10"></div>
        <div><label class="field-label" for="ptCutoff">Ei velvoitteita kellon jälkeen</label>
          <input type="time" id="ptCutoff" value="${escapeHtml(rules.cutoffTime || '')}"></div>
      </div>
      <fieldset class="pt-days"><legend class="field-label">Suojatut illat</legend>${weekdayBoxes('ptEvening', rules.eveningWeekdays)}</fieldset>
      <div class="form-row">
        <div><label class="field-label" for="ptEveningFrom">Ilta alkaa</label>
          <input type="time" id="ptEveningFrom" value="${escapeHtml(rules.eveningFrom || '17:00')}"></div>
      </div>
      <label class="checkbox-row" for="ptSunday"><input type="checkbox" id="ptSunday" ${rules.sundayMostlyFree ? 'checked' : ''}> Sunnuntai pääosin vapaa</label>
      <div class="field-error" id="ptFreeError" role="alert"></div>
      <button type="button" class="form-btn primary" id="ptFreeSave">Tallenna vapaa-ajan säännöt</button>
    </div>
    ${otherFree.length ? `<div class="review-label">Muut vapaa-ajan jaksot</div>${periodList(otherFree, '')}` : ''}

    <h2 class="section-title" id="ptVacationTitle">Loma</h2>
    <p class="hint">Kiinteät menot pysyvät näkyvissä, eikä niitä poisteta. Joustavaa työtä ja jonoa ei sijoiteta lomalle.</p>
    ${periodList(vacations, 'Ei tulevia lomia.')}
    <div class="add-form pt-form" role="group" aria-labelledby="ptVacationTitle" style="display:flex;">
      <div class="form-row">
        <div><label class="field-label" for="ptVacFrom">Alkaa</label><input type="date" id="ptVacFrom" min="${today}"></div>
        <div><label class="field-label" for="ptVacTo">Päättyy</label><input type="date" id="ptVacTo" min="${today}"></div>
      </div>
      <div class="field-error" id="ptVacError" role="alert"></div>
      <button type="button" class="form-btn primary" id="ptVacSave">Lisää loma</button>
    </div>

    <h2 class="section-title" id="ptBufferTitle">Suunnittelun väljyys</h2>
    <div class="add-form pt-form" role="group" aria-labelledby="ptBufferTitle" style="display:flex;">
      <div><label class="field-label" for="ptBuffer">Jätä vapaasta ajasta suunnittelematta</label>
        <select id="ptBuffer">${BUFFER_OPTIONS.map(option => `<option value="${option}" ${Math.abs(option - ratio) < 0.001 ? 'selected' : ''}>${Math.round(option * 100)} %</option>`).join('')}</select>
      </div>
      <label class="checkbox-row" for="ptSleep"><input type="checkbox" id="ptSleep" ${settings.sleepAffectsCapacity ? 'checked' : ''}>
        Lyhyt yö keventää seuraavan päivän suunnitelmaa</label>
      <p class="hint">Väljyys ei ole hukkaa: se pitää suunnitelman mahdollisena, kun jokin kestää arvioitua pidempään.</p>
      <button type="button" class="form-btn secondary" id="ptBufferSave">Tallenna väljyys</button>
    </div>`;
}

function setError(id, errors) {
  const node = maybe(id);
  if (!node) return;
  const text = errors ? Object.values(errors).filter(Boolean).join(' ') : '';
  node.textContent = text;
  node.style.display = text ? 'block' : 'none';
}

async function onClick(event) {
  const target = event.target;
  const del = target.closest('[data-pt-delete]');
  if (del) {
    await deleteProtectedPeriod(del.dataset.ptDelete);
    return;
  }
  if (target.closest('#ptOwnSave')) {
    const button = maybe('ptOwnSave');
    setBusy(button, true);
    try {
      const result = await saveProtectedPeriod({
        kind: PROTECTED_KIND.OWN_TIME, recurrence: PERIOD_RECURRENCE.WEEKLY,
        weekdays: checkedDays('ptOwnDay'), startTime: valueOf('ptOwnFrom') || null,
        endTime: valueOf('ptOwnTo') || null, title: valueOf('ptOwnTitleInput') || 'Oma aika'
      });
      setError('ptOwnError', result.ok ? null : result.errors);
      if (result.ok) success('Oma aika suojattu.');
    } finally {
      setBusy(button, false);
    }
    return;
  }
  if (target.closest('#ptFreeSave')) {
    const hours = Number(valueOf('ptFreeMin').replace(',', '.'));
    const result = await saveFreeTimeRules({
      minimumMinutes: Number.isFinite(hours) && hours > 0 ? Math.round(hours * 60) : null,
      eveningWeekdays: checkedDays('ptEvening'),
      eveningFrom: valueOf('ptEveningFrom') || null,
      sundayMostlyFree: Boolean(maybe('ptSunday') && maybe('ptSunday').checked),
      cutoffTime: valueOf('ptCutoff') || null
    });
    setError('ptFreeError', result.ok ? null : (result.errors || { rules: 'Sääntöjä ei voitu tallentaa.' }));
    if (result.ok) success('Vapaa-ajan säännöt tallennettu.');
    return;
  }
  if (target.closest('#ptVacSave')) {
    const result = await saveVacation({ startDate: valueOf('ptVacFrom'), endDate: valueOf('ptVacTo') || valueOf('ptVacFrom') });
    setError('ptVacError', result.ok ? null : result.errors);
    if (result.ok) success('Loma lisätty. Kiinteät menot pysyvät ennallaan.');
    return;
  }
  if (target.closest('#ptBufferSave')) {
    const ratio = Number(valueOf('ptBuffer'));
    const sleep = Boolean(maybe('ptSleep') && maybe('ptSleep').checked);
    if (Number.isFinite(ratio)) {
      setDevicePreference('planningBufferRatio', ratio);
      if (columnGateOpen('GOAL_PLANNING_FIELDS')) {
        await saveProfile({ ...getState().profile, planningBufferRatio: ratio });
      }
    }
    const saved = await saveLifeSettings({ sleepAffectsCapacity: sleep });
    if (saved && saved.ok === false && saved.errors) showError(Object.values(saved.errors).join(' '));
    else success('Väljyys tallennettu.');
    renderProtectedTimeSettings();
  }
}

/** Kytke kuuntelija kerran (delegointi: osio piirretään uudelleen). */
export function initProtectedTimeSettings() {
  const container = maybe('protectedTimeContainer');
  if (container && !container.dataset.wired) {
    container.dataset.wired = '1';
    container.addEventListener('click', onClick);
  }
}
