// Ostos omana aikana: "vastaa noin 2 h 30 min työtä" ja suhde omiin
// säästötavoitteisiin (Talous → Säästötavoitteet).
//
// KUVAA, EI ARVOTA (src/domain/moneyAlignment.js). Vertailukohta on aina
// käyttäjän oma luku: itse ilmoitettu tunnin arvo ja omat säästötavoitteet.
// Ilman omaa tunnin arvoa ei ole työaikaa -- vain säästövertailu, jos
// tavoitteita on. Laskuri ei tallenna ostosta eikä sano, onko se järkevä.
//
// Vain tunnin arvo tallentuu (arjen asetukset, life_settings.hourly_value_minor).
// Hinta on hetken laskelma: se ei kulje minnekään, ei lokiin eikä tekoälylle.
//
// Moderni kaava: hinnan näppäily piirtää vain tuloksen (fokus ja kursori
// pysyvät), kuuntelijat delegoidaan kerran säiliöön.

import { maybe, renderHtml, singleFlight, setBusy } from '../../ui/dom.js';
import { escapeHtml } from '../../lib/format.js';
import { getState, currentLifeSettings } from '../state.js';
import { saveLifeSettings } from '../dailyLifeActions.js';
import { purchaseInWork, savingsComparison } from '../../domain/moneyAlignment.js';
import { parseMoneyToMinor, formatMoney } from '../../domain/money.js';
import { MAX_HOURLY_VALUE_MINOR, DEFAULT_CURRENCY } from '../../domain/lifeSettings.js';

const CONTAINER_ID = 'purchaseCheckContainer';

let draft = freshDraft();
const wired = new WeakSet();

function freshDraft() {
  return { price: '', hourly: null, hourlyError: '', hourlyStatus: '' };
}

/** Uloskirjautuminen: edellisen käyttäjän hinta tai luonnos ei jää näkyviin. */
export function resetPurchaseCheck() {
  draft = freshDraft();
}

/**
 * Laskelman malli (puhdas tilan ja syötteen funktio).
 *
 * @returns {{currency:string, hourlyMinor:number|null, priceMinor:number|null, priceInvalid:boolean,
 *   work:object|null, comparisons:ReadonlyArray<object>}}
 */
export function purchaseCheckModel({ priceText = '', state = getState() } = {}) {
  const settings = currentLifeSettings(state);
  const currency = settings.currency || DEFAULT_CURRENCY;
  const hourlyMinor = Number.isInteger(settings.hourlyValueMinor) ? settings.hourlyValueMinor : null;
  const text = String(priceText ?? '').trim();
  const priceMinor = text ? parseMoneyToMinor(text) : null;
  const priceInvalid = Boolean(text) && (priceMinor === null || priceMinor === 0);
  const price = priceInvalid ? null : priceMinor;
  return {
    currency,
    hourlyMinor,
    priceMinor: price,
    priceInvalid,
    work: price === null ? null : purchaseInWork({ priceMinor: price, currency, hourlyValueMinor: hourlyMinor, hourlyCurrency: currency }),
    comparisons: price === null ? [] : savingsComparison({ priceMinor: price, currency, savingsGoals: state.savingsGoals || [] })
  };
}

function resultHtml(model) {
  if (model.priceInvalid) {
    return '<p class="field-error" id="pcPriceError" role="alert">Anna hinta euroina, esim. 129,90.</p>';
  }
  if (model.priceMinor === null) {
    return '<p class="hint">Kirjoita hinta, niin näet sen suhteessa omaan aikaasi ja säästötavoitteisiisi.</p>';
  }
  const lines = [];
  lines.push(`<p class="pc-price">${escapeHtml(formatMoney(model.priceMinor, model.currency))}</p>`);
  lines.push(model.work
    ? `<p class="pc-work">${escapeHtml(model.work.text)}</p>`
    : '<p class="hint">Aseta oma tunnin arvo alla, niin hinta näkyy myös työaikana.</p>');
  if (model.comparisons.length > 0) {
    lines.push('<ul class="pc-goals">' + model.comparisons
      .map(row => `<li><span class="pc-goal-name">${escapeHtml(row.name || 'Säästötavoite')}</span>: ${escapeHtml(row.text)}</li>`)
      .join('') + '</ul>');
  }
  return lines.join('');
}

function hourlyText(model) {
  if (draft.hourly !== null) return draft.hourly;
  return model.hourlyMinor === null ? '' : (model.hourlyMinor / 100).toFixed(2).replace('.', ',');
}

/** Piirrä laskuri. Kutsutaan Talous-näkymän piirrossa. */
export function renderPurchaseCheck(container = maybe(CONTAINER_ID)) {
  if (!container) return;
  const model = purchaseCheckModel({ priceText: draft.price });
  const errorId = draft.hourlyError ? ' aria-describedby="pcHourlyHint pcHourlyError" aria-invalid="true"' : ' aria-describedby="pcHourlyHint"';
  renderHtml(container, `
    <section class="card purchase-check" aria-labelledby="pcTitle">
      <h2 class="section-title" id="pcTitle">Ostos omana aikana</h2>
      <p class="hint">Kuvaa, ei arvota. Hintaa ei tallenneta minnekään.</p>
      <label class="field-label" for="pcPrice">Hinta (${escapeHtml(model.currency)})</label>
      <input type="text" id="pcPrice" inputmode="decimal" autocomplete="off" placeholder="esim. 129,90"
        value="${escapeHtml(draft.price)}"${model.priceInvalid ? ' aria-invalid="true" aria-describedby="pcPriceError"' : ''}>
      <div id="pcResult" role="status" aria-live="polite">${resultHtml(model)}</div>
      <label class="field-label" for="pcHourly">Oma tunnin arvo (${escapeHtml(model.currency)})</label>
      <input type="text" id="pcHourly" inputmode="decimal" autocomplete="off" placeholder="esim. 25,00"
        value="${escapeHtml(hourlyText(model))}"${errorId}>
      <p class="hint" id="pcHourlyHint">Oma arviosi, esimerkiksi nettotuntipalkka. Tallentuu arjen asetuksiin; tyhjä poistaa sen.</p>
      ${draft.hourlyError ? `<div class="field-error" id="pcHourlyError" role="alert">${escapeHtml(draft.hourlyError)}</div>` : ''}
      <div class="assist-actions">
        <button type="button" class="assist-btn primary" id="pcHourlySave">Tallenna tunnin arvo</button>
      </div>
      ${draft.hourlyStatus ? `<p class="hint" role="status">${escapeHtml(draft.hourlyStatus)}</p>` : ''}
    </section>`);
}

function renderResultOnly(container) {
  const result = container.querySelector('#pcResult');
  const price = container.querySelector('#pcPrice');
  if (!result) return renderPurchaseCheck(container);
  const model = purchaseCheckModel({ priceText: draft.price });
  renderHtml(result, resultHtml(model));
  if (price) {
    if (model.priceInvalid) {
      price.setAttribute('aria-invalid', 'true');
      price.setAttribute('aria-describedby', 'pcPriceError');
    } else {
      price.removeAttribute('aria-invalid');
      price.removeAttribute('aria-describedby');
    }
  }
}

/** Tunnin arvo tekstistä: tyhjä = poista (null), muuten 0,01 … raja. */
export function parseHourlyValue(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { value: null };
  const minor = parseMoneyToMinor(trimmed);
  if (minor === null || minor < 1 || minor > MAX_HOURLY_VALUE_MINOR) {
    return { error: 'Anna tunnin arvo euroina, esim. 25,00.' };
  }
  return { value: minor };
}

const saveHourly = singleFlight(async (container, button) => {
  const parsed = parseHourlyValue(draft.hourly ?? hourlyText(purchaseCheckModel({ priceText: draft.price })));
  if (parsed.error) {
    draft.hourlyError = parsed.error;
    draft.hourlyStatus = '';
    renderPurchaseCheck(container);
    const field = container.querySelector('#pcHourly');
    if (field) field.focus();
    return;
  }
  setBusy(button, true, 'Tallennetaan…');
  try {
    const result = await saveLifeSettings({ hourlyValueMinor: parsed.value });
    if (result && result.ok) {
      draft.hourly = null;
      draft.hourlyError = '';
      draft.hourlyStatus = parsed.value === null ? 'Tunnin arvo poistettu.' : 'Tunnin arvo tallennettu.';
    } else {
      draft.hourlyError = result && result.errors && result.errors.hourlyValueMinor
        ? result.errors.hourlyValueMinor : 'Tallennus ei onnistunut. Yritä uudelleen.';
      draft.hourlyStatus = '';
    }
  } finally {
    setBusy(button, false);
  }
  renderPurchaseCheck(container);
});

/** Kytke kuuntelijat kerran (main.js start). */
export function initPurchaseCheck(container = maybe(CONTAINER_ID)) {
  if (!container || wired.has(container)) return;
  wired.add(container);
  container.addEventListener('input', event => {
    const target = event.target;
    if (!target) return;
    if (target.id === 'pcPrice') {
      draft.price = String(target.value ?? '');
      renderResultOnly(container);
    } else if (target.id === 'pcHourly') {
      draft.hourly = String(target.value ?? '');
      draft.hourlyStatus = '';
    }
  });
  container.addEventListener('click', event => {
    const button = event.target && typeof event.target.closest === 'function' ? event.target.closest('#pcHourlySave') : null;
    if (button) saveHourly(container, button);
  });
  container.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target && event.target.id === 'pcHourly') {
      event.preventDefault();
      saveHourly(container, container.querySelector('#pcHourlySave'));
    }
  });
}
