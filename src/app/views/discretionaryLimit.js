// Harkinnanvarainen käyttö suhteessa omaan kuukausirajaan (Talous →
// Budjetti) ja sama vertailu viikkokatsauksen Arki-osioon (direction.js).
//
// KUVAA, EI ARVOTA (src/domain/moneyAlignment.js). "Harkinnanvaraisia
// menoja 180,00 €, oma kuukausirajasi 200,00 € (90 %)" on mittasuhde, ei
// tuomio. Raja on AINA käyttäjän oma luku: ilman sitä näytetään vain
// kirjattu summa, eikä mitään verrata. Harvasta kuukaudesta (alle
// MONEY_RULES.MIN_TRANSACTIONS kirjausta) ei sanota mitään.
//
// Raja tallentuu käyttäjäkohtaisena tälle laitteelle
// (src/data/preferences.js USER_DEFAULTS.discretionaryLimit), koska
// tilikohtainen sarake vaatisi migraation. Se ei kulje tekoälylle eikä
// lokiin; katsaus piirtää vertailun vain ruudulle.
//
// Moderni kaava: kuuntelijat delegoidaan kerran säiliöön, näppäily ei
// piirrä (fokus pysyy), luonnos tyhjenee uloskirjautuessa.

import { maybe, renderHtml } from '../../ui/dom.js';
import { escapeHtml } from '../../lib/format.js';
import { getState, currentLifeSettings } from '../state.js';
import { getUser } from '../../data/session.js';
import { getUserPreference, setUserPreference } from '../../data/preferences.js';
import { summarizeMonth } from '../../domain/budget.js';
import { discretionaryStatus, isDiscretionaryCategory } from '../../domain/moneyAlignment.js';
import { parseMoneyToMinor, formatMinorAsInput, normalizeCurrency, normalizeMinor } from '../../domain/money.js';
import { transactionsInMonth, isExpense } from '../../domain/transactions.js';
import { MONEY_RULES } from '../../domain/dailyLifeSignalsPolicy.js';
import { DEFAULT_CURRENCY } from '../../domain/lifeSettings.js';

const CONTAINER_ID = 'discretionaryLimitContainer';
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

let draft = freshDraft();
const wired = new WeakSet();

function freshDraft() {
  return { limit: null, error: '', status: '' };
}

/** Uloskirjautuminen: edellisen käyttäjän luonnos ei jää näkyviin. */
export function resetDiscretionaryLimit() {
  draft = freshDraft();
  // Näppäilty mutta tallentamaton luku elää vain kentän arvona, eikä sama
  // merkintä kirjoitu uudelleen (setHtml). Kenttä palautetaan viimeksi
  // piirrettyyn arvoon; seuraavan käyttäjän raja piirtyy seuraavalla kerralla.
  const field = typeof document !== 'undefined' ? maybe('dlLimit') : null;
  if (field) field.value = field.getAttribute('value') ?? '';
}

function currentUserId() {
  const user = getUser();
  return user && user.id ? String(user.id) : null;
}

/**
 * Käyttäjän oma raja tai null. Muoto tarkistetaan: laitteen muistiin
 * jäänyt roska ei muutu rajaksi.
 *
 * @returns {{minor:number, currency:string}|null}
 */
export function readDiscretionaryLimit(userId = currentUserId()) {
  const raw = getUserPreference(userId, 'discretionaryLimit');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const minor = Number.isInteger(raw.minor) ? normalizeMinor(raw.minor) : null;
  const currency = typeof raw.currency === 'string' && CURRENCY_PATTERN.test(raw.currency) ? raw.currency : null;
  return minor === null || currency === null ? null : Object.freeze({ minor, currency });
}

/** Tallenna tai poista (null) oma raja. @returns {boolean} onnistuiko */
export function saveDiscretionaryLimit(minor, currency, userId = currentUserId()) {
  if (minor === null) return setUserPreference(userId, 'discretionaryLimit', null);
  const value = Number.isInteger(minor) ? normalizeMinor(minor) : null;
  if (value === null) return false;
  return setUserPreference(userId, 'discretionaryLimit', { minor: value, currency: normalizeCurrency(currency) });
}

/**
 * Kuukauden syöte moneyAlignment.discretionaryStatus- ja
 * dailyLifeSignals.moneyOverload-laskulle.
 *
 * Valuutta on rajan valuutta (tai arjen asetusten valuutta, jos rajaa ei
 * ole). Jos yksikin kuukauden harkinnanvarainen meno on eri valuutassa,
 * summia ei lasketa yhteen (mixedCurrencies): ilman kurssia se olisi arvaus.
 */
export function discretionaryMonthInput({ month, state = getState(), todayIso = null, limit = readDiscretionaryLimit() } = {}) {
  const settings = currentLifeSettings(state);
  const currency = limit ? limit.currency : normalizeCurrency(settings.currency || DEFAULT_CURRENCY);
  const transactions = state.transactions || [];
  const mixedCurrencies = transactionsInMonth(transactions, month)
    .some(t => isExpense(t) && isDiscretionaryCategory(t.category) && normalizeCurrency(t.currency) !== currency);
  return {
    monthSummary: summarizeMonth({
      month, transactions, bills: state.bills || [], recurringExpenses: state.recurringExpenses || [], todayIso
    }),
    declaredCapacityMinor: limit ? limit.minor : null,
    currency,
    capacityCurrency: limit ? limit.currency : undefined,
    mixedCurrencies
  };
}

/**
 * Katsauksen rahasyöte tai null, kun rahasta ei ole mitään sanottavaa:
 * ei omaa rajaa eikä yhtään kirjattua tapahtumaa (Taloutta ei käytetä).
 */
export function discretionaryReviewInput({ month, state = getState(), todayIso = null } = {}) {
  const limit = readDiscretionaryLimit();
  if (!limit && (state.transactions || []).length === 0) return null;
  return discretionaryMonthInput({ month, state, todayIso, limit });
}

/** Kortin malli (puhdas tilan ja rajan funktio). */
export function discretionaryModel({ state = getState(), month = state.budgetMonth, limit = readDiscretionaryLimit() } = {}) {
  const input = discretionaryMonthInput({ month, state, limit });
  const status = discretionaryStatus(input);
  let text;
  if (status) {
    text = status.text;
  } else if (input.mixedCurrencies) {
    text = 'Harkinnanvaraisissa menoissa on useita valuuttoja, joten niitä ei lasketa yhteen eikä verrata rajaan.';
  } else {
    const count = input.monthSummary.transactionCount;
    text = `Kuukaudelta on kirjattu ${count === 1 ? '1 tapahtuma' : `${count} tapahtumaa`}. `
      + `Vertailu tehdään, kun kirjauksia on vähintään ${MONEY_RULES.MIN_TRANSACTIONS}: muutamasta kuitista ei näe kuukautta.`;
  }
  return { limit, currency: input.currency, status, text };
}

function limitText(model) {
  if (draft.limit !== null) return draft.limit;
  return model.limit ? formatMinorAsInput(model.limit.minor).replace('.', ',') : '';
}

/** Piirrä kortti. Kutsutaan Talous-näkymän piirrossa. */
export function renderDiscretionaryLimit(container = maybe(CONTAINER_ID)) {
  if (!container) return;
  const model = discretionaryModel();
  const described = draft.error ? 'dlLimitHint dlLimitError' : 'dlLimitHint';
  renderHtml(container, `
    <section class="card discretionary-limit" aria-labelledby="dlTitle">
      <h2 class="section-title" id="dlTitle">Harkinnanvarainen käyttö</h2>
      <p class="hint">Harrastukset, ostokset ja viihde suhteessa omaan kuukausirajaasi. Kuvaa, ei arvota.</p>
      <p class="dl-status" id="dlStatus">${escapeHtml(model.text)}</p>
      <label class="field-label" for="dlLimit">Oma kuukausiraja (${escapeHtml(model.currency)})</label>
      <input type="text" id="dlLimit" inputmode="decimal" autocomplete="off" placeholder="esim. 200,00"
        value="${escapeHtml(limitText(model))}" aria-describedby="${described}"${draft.error ? ' aria-invalid="true"' : ''}>
      <p class="hint" id="dlLimitHint">Oma lukusi, ei suositus. Tallentuu vain tälle laitteelle; tyhjä poistaa rajan. Vertailu näkyy myös viikkokatsauksen Arki-osiossa.</p>
      ${draft.error ? `<div class="field-error" id="dlLimitError" role="alert">${escapeHtml(draft.error)}</div>` : ''}
      <div class="assist-actions">
        <button type="button" class="assist-btn primary" id="dlSave">Tallenna raja</button>
      </div>
      ${draft.status ? `<p class="hint" role="status">${escapeHtml(draft.status)}</p>` : ''}
    </section>`);
}

/** Raja tekstistä: tyhjä = poista (null), muuten 0 … MAX_MINOR senttiä. */
export function parseLimit(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { value: null };
  const minor = parseMoneyToMinor(trimmed);
  if (minor === null) return { error: 'Anna raja euroina, esim. 200,00.' };
  return { value: minor };
}

function save(container) {
  const model = discretionaryModel();
  const parsed = parseLimit(limitText(model));
  if (parsed.error) {
    draft.error = parsed.error;
    draft.status = '';
    renderDiscretionaryLimit(container);
    const field = container.querySelector('#dlLimit');
    if (field) field.focus();
    return;
  }
  const ok = saveDiscretionaryLimit(parsed.value, model.currency);
  if (ok) {
    draft.limit = null;
    draft.error = '';
    draft.status = parsed.value === null ? 'Raja poistettu.' : 'Raja tallennettu.';
  } else {
    draft.error = 'Tallennus ei onnistunut: laitteen muisti ei ole käytettävissä.';
    draft.status = '';
  }
  renderDiscretionaryLimit(container);
}

/** Kytke kuuntelijat kerran (main.js start). */
export function initDiscretionaryLimit(container = maybe(CONTAINER_ID)) {
  if (!container || wired.has(container)) return;
  wired.add(container);
  container.addEventListener('input', event => {
    const target = event.target;
    if (target && target.id === 'dlLimit') {
      draft.limit = String(target.value ?? '');
      draft.status = '';
    }
  });
  container.addEventListener('click', event => {
    const button = event.target && typeof event.target.closest === 'function' ? event.target.closest('#dlSave') : null;
    if (button) save(container);
  });
  container.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target && event.target.id === 'dlLimit') {
      event.preventDefault();
      save(container);
    }
  });
}
