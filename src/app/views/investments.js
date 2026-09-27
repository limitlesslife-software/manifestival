// Sijoitusnäkymä.
//
// ---------------------------------------------------------------
// TÄMÄ NÄKYMÄ EI KEKSI YHTÄÄN LUKUA
// ---------------------------------------------------------------
//
// Manifestivalilla ei ole markkinadatan toimittajaa eikä yhteyttä
// välittäjään. Kurssia ei haeta mistään.
//
// Arvo on joko käyttäjän itse kirjaama — merkittynä ja päivättynä —
// tai TUNTEMATON, ja silloin se sanotaan ääneen. Tuntematon arvo ei ole
// nolla, eikä siitä lasketa tuottoa.
//
// Näkymä näyttää siksi kolme asiaa, joita muut salkkunäkymät eivät
// yleensä näytä:
//
//   1. montako omistusta on ILMAN arvoa
//   2. mitkä arvot ovat VANHOJA (yli 30 vrk)
//   3. valuutat ERIKSEEN, koska muuntokurssia ei ole
//
// Keksitty kurssi olisi pahin mahdollinen virhe tässä sovelluksessa:
// se näyttäisi täsmälleen yhtä varmalta kuin oikea.

import { el, maybe, toggle, setText, focus } from '../../ui/dom.js';
import { escapeHtml, formatShortDate } from '../../lib/format.js';
import { getState, findInvestment, setEditingInvestmentId } from '../state.js';
import {
  HOLDING_KIND, HOLDING_KINDS, holdingKindLabel, summarizePortfolio,
  compareHoldings, hasKnownValue, hasMarketDataProvider, targetComparison
} from '../../domain/investments.js';
import {
  DEFAULT_CURRENCY, parseMoneyToMinor, formatMoney, formatMinorAsInput,
  formatTotals
} from '../../domain/money.js';
import { createInvestment, editInvestment, deleteInvestment } from '../actions.js';
import { fmtISO, parseISO, todayMidnight } from '../../lib/datetime.js';

const CURRENCIES = Object.freeze(['EUR', 'SEK', 'NOK', 'DKK', 'USD', 'GBP']);

let optionsReady = false;

function fillSelectOptions() {
  if (optionsReady) return;

  const currency = maybe('ifCurrency');
  if (currency) {
    currency.innerHTML = CURRENCIES
      .map(code => `<option value="${escapeHtml(code)}">${escapeHtml(code)}</option>`)
      .join('');
  }

  const kind = maybe('ifKind');
  if (kind) {
    kind.innerHTML = HOLDING_KINDS
      .map(value => `<option value="${escapeHtml(value)}">`
        + `${escapeHtml(holdingKindLabel(value))}</option>`).join('');
  }

  optionsReady = true;
}

/**
 * Määrän muotoilu.
 *
 * MÄÄRÄ EI OLE RAHAA, joten sitä ei muotoilla rahana. Turhat nollat
 * karsitaan: 12,50000000 osaketta on 12,5, mutta 0,00031 kryptoa on
 * kirjoitettava kokonaan.
 */
export function formatQuantity(quantity) {
  if (quantity === null || quantity === undefined || !Number.isFinite(quantity)) return '';
  return String(Number(quantity.toFixed(8))).replace('.', ',');
}

// ------------------------------------------------------------ renderöi

function renderPortfolio(container, state) {
  const todayIso = fmtISO(todayMidnight());
  const holdings = [...state.investments].sort(compareHoldings);

  if (holdings.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">Ei sijoituksia.</div>
        <p>Kirjaa omistuksesi ja niiden hankintahinta. Arvon päivität
        itse — Manifestival ei hae kursseja mistään.</p>
      </div>`;
    return;
  }

  const summary = summarizePortfolio(holdings, todayIso);
  const arvo = formatTotals(summary.valueByCurrency);
  const tuotto = formatTotals(summary.gainByCurrency);

  const yhteenveto = `
    <div class="focus-block">
      <div class="focus-title">Salkku</div>
      <div class="focus-summary">
        <span class="load-chip">${escapeHtml(arvo || 'Arvoa ei ole kirjattu')}</span>
        ${tuotto ? `<span class="load-chip${
          hasNegative(summary.gainByCurrency) ? ' tone-clay' : ' tone-sage'
        }">${escapeHtml(tuotto)}</span>` : ''}
        ${summary.unknownCount > 0
          ? `<span class="load-chip tone-clay">${summary.unknownCount} ilman arvoa</span>` : ''}
        ${summary.staleCount > 0
          ? `<span class="load-chip">${summary.staleCount} vanhentunutta</span>` : ''}
      </div>
      ${summary.unknownCount > 0 ? `
        <p class="hint">
          Omistukset ilman kirjattua arvoa <strong>eivät ole nollan
          arvoisia</strong> — niiden arvoa ei vain tiedetä, eikä niitä
          lasketa yhteissummaan.
        </p>` : ''}
      ${!hasMarketDataProvider() ? `
        <p class="hint">
          Arvot ovat käsin kirjattuja. Kursseja ei haeta mistään.
        </p>` : ''}
    </div>`;

  const rivit = summary.holdings.map(item => {
    const holding = item.holding;
    const known = hasKnownValue(holding);

    return `<div class="task-row">
      <button class="t-body t-open" data-edit-investment="${escapeHtml(holding.id)}"
              aria-label="Muokkaa sijoitusta: ${escapeHtml(holding.name)}">
        <div class="t-title">${escapeHtml(holding.name)}${
          item.stale ? '<span class="prio-tag prio-clay">Arvo vanha</span>' : ''}</div>
        <div class="t-meta">
          <span class="task-cat-tag">${escapeHtml(holdingKindLabel(holding.kind))}</span>
          ${holding.symbol ? `<span>${escapeHtml(holding.symbol)}</span>` : ''}
          ${holding.quantity !== null
            ? `<span>${escapeHtml(formatQuantity(holding.quantity))} kpl</span>` : ''}
          ${known
            ? `<span>${escapeHtml(formatMoney(holding.currentValueMinor, holding.currency))}</span>`
            : '<span>Arvo tuntematon</span>'}
          ${item.known
            ? `<span class="prio-tag ${item.gainMinor >= 0 ? 'prio-sage' : 'prio-clay'}">${
                item.gainMinor >= 0 ? '+' : '−'}${
                escapeHtml(formatMoney(Math.abs(item.gainMinor), holding.currency))} (${
                item.gainPercent} %)</span>`
            : ''}
        </div>
        ${holding.valuedOn
          ? `<div class="t-sub">Arvo kirjattu ${
              escapeHtml(formatShortDate(parseISO(holding.valuedOn)))}</div>`
          : known ? '<div class="t-sub">Arvolle ei ole päiväystä</div>' : ''}
        ${targetLine(holding, todayIso)}
      </button>
    </div>`;
  }).join('');

  container.innerHTML = yhteenveto + rivit;

  container.querySelectorAll('[data-edit-investment]').forEach(node =>
    node.addEventListener('click', () => openInvestmentForm(node.dataset.editInvestment)));
}

/**
 * Oma tavoitearvo suhteessa käsin kirjattuun arvoon (targetComparison).
 * Tuntematon arvo ei ole 0 % tavoitteesta: silloin vertailua ei tehdä,
 * ja se sanotaan. Kuvaa, ei neuvo ostamaan eikä myymään.
 */
function targetLine(holding, todayIso) {
  if (!Number.isSafeInteger(holding.targetValueMinor) || holding.targetValueMinor <= 0) return '';
  const comparison = targetComparison(holding, todayIso);
  const text = comparison
    ? comparison.text
    : `Tavoitearvo ${formatMoney(holding.targetValueMinor, holding.currency)}. Arvoa ei tiedetä, joten vertailua ei tehdä.`;
  return `<div class="t-sub inv-target">${escapeHtml(text)}</div>`;
}

function hasNegative(byCurrency) {
  return Object.values(byCurrency || {}).some(value => value < 0);
}

/** Renderöi sijoitusnäkymä. */
export function renderInvestments() {
  const container = maybe('investmentsListContainer');
  if (!container) return;
  fillSelectOptions();
  renderPortfolio(container, getState());
}

// --------------------------------------------------------------- lomake

function readMoney(id) {
  const raw = el(id).value.trim();
  if (raw === '') return null;
  return parseMoneyToMinor(raw);
}

/**
 * Lue määrä.
 *
 * `parseMoneyToMinor` EI KELPAA TÄHÄN: se muuttaisi 12,5 arvoksi 1250.
 * Määrä ei ole rahaa. Pilkku hyväksytään erottimena, koska suomalainen
 * kirjoittaa pilkun ja numeronäppäimistö tuottaa pisteen.
 */
export function readQuantity(raw) {
  const text = String(raw ?? '').trim().replace(',', '.');
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function readInvestmentForm() {
  const currentValueMinor = readMoney('ifCurrentValue');

  return {
    name: el('ifName').value.trim(),
    symbol: el('ifSymbol').value.trim() || null,
    kind: el('ifKind').value,
    quantity: readQuantity(el('ifQuantity').value),
    costBasisMinor: readMoney('ifCostBasis'),
    currentValueMinor,
    currency: el('ifCurrency').value,
    valuedOn: el('ifValuedOn').value || null,
    targetValueMinor: readMoney('ifTargetValue'),

    // ARVON LÄHDE JOHDETAAN, EI KYSYTÄ.
    //
    // Jos käyttäjä kirjoitti arvon, se on käsin kirjattu. Jos ei,
    // se on tuntematon. Erillinen valikko antaisi mahdollisuuden
    // merkitä tyhjä arvo "kirjatuksi", ja kanta hylkäisi sen —
    // mutta vasta tallennuksessa.
    valueSource: currentValueMinor === null ? 'unknown' : 'manual',

    note: el('ifNote').value.trim() || null
  };
}

function fillInvestmentForm(holding) {
  fillSelectOptions();
  el('ifName').value = holding ? holding.name : '';
  el('ifSymbol').value = holding && holding.symbol ? holding.symbol : '';
  el('ifKind').value = holding ? holding.kind : HOLDING_KIND.OTHER;
  el('ifQuantity').value = holding && holding.quantity !== null
    ? formatQuantity(holding.quantity) : '';
  el('ifCostBasis').value = holding ? formatMinorAsInput(holding.costBasisMinor) : '';
  el('ifCurrentValue').value = holding ? formatMinorAsInput(holding.currentValueMinor) : '';
  el('ifCurrency').value = holding ? holding.currency : DEFAULT_CURRENCY;
  el('ifValuedOn').value = holding && holding.valuedOn ? holding.valuedOn : '';
  el('ifTargetValue').value = holding ? formatMinorAsInput(holding.targetValueMinor) : '';
  el('ifNote').value = holding && holding.note ? holding.note : '';
}

export function openAddInvestmentForm() {
  setEditingInvestmentId(null);
  fillInvestmentForm(null);
  investmentErrors.clear();
  setText('investmentFormTitle', 'Uusi sijoitus');
  toggle('ifDelete', false);
  toggle('investmentForm', true, 'flex');
  toggle('addInvestmentBtn', false, 'flex');
  focus('ifName');
}

export function openInvestmentForm(id) {
  const holding = findInvestment(id);
  if (!holding) return;
  setEditingInvestmentId(id);
  fillInvestmentForm(holding);
  investmentErrors.clear();
  setText('investmentFormTitle', 'Muokkaa sijoitusta');
  toggle('ifDelete', true, 'flex');
  toggle('investmentForm', true, 'flex');
  toggle('addInvestmentBtn', false, 'flex');
  focus('ifName');
}

export function closeInvestmentForm() {
  setEditingInvestmentId(null);
  // Kentät tyhjennetään, ei vain piiloteta — uloskirjautuminen kutsuu
  // tätä, eikä seuraava käyttäjä saa löytää edellisen tekstiä.
  fillInvestmentForm(null);
  investmentErrors.clear();
  toggle('investmentForm', false);
  toggle('addInvestmentBtn', true, 'flex');
}

async function submitInvestment() {
  // Lukematon tavoitearvo on virhe, ei tyhjä: muuten kirjoitettu luku
  // katoaisi hiljaa ja vanha tavoite poistuisi.
  const targetText = el('ifTargetValue').value.trim();
  if (targetText !== '' && parseMoneyToMinor(targetText) === null) {
    investmentErrors.show({ targetValueMinor: 'Anna tavoitearvo euroina, esim. 5000,00.' });
    return;
  }
  const input = readInvestmentForm();

  // Arvon päiväys täytetään automaattisesti, jos arvo on kirjattu
  // mutta päivä puuttuu. Ilman päivää käyttöliittymä ei voisi kertoa
  // arvon ikää — ja käsin kirjattu arvo vanhenee.
  if (input.currentValueMinor !== null && !input.valuedOn) {
    input.valuedOn = fmtISO(todayMidnight());
  }

  const editingId = getState().editingInvestmentId;
  const result = editingId
    ? await editInvestment(editingId, input)
    : await createInvestment(input);

  if (!result || !result.ok) {
    if (result && result.errors) investmentErrors.show(result.errors);
    return;
  }
  closeInvestmentForm();
}

const investmentErrors = makeFormErrors('#investmentForm', {
  name: 'ifName', kind: 'ifKind', quantity: 'ifQuantity',
  costBasisMinor: 'ifCostBasis', currentValueMinor: 'ifCurrentValue',
  targetValueMinor: 'ifTargetValue'
});

function makeFormErrors(formSelector, fieldToInput) {
  const clear = () => {
    document.querySelectorAll(`${formSelector} .field-error`).forEach(node => {
      node.textContent = '';
      node.style.display = 'none';
    });
    document.querySelectorAll(`${formSelector} .invalid`).forEach(node => {
      node.classList.remove('invalid');
      node.removeAttribute('aria-invalid');
    });
  };

  const show = errors => {
    clear();
    let firstInvalid = null;
    for (const [field, message] of Object.entries(errors)) {
      const inputId = fieldToInput[field];
      if (!inputId) continue;
      const input = maybe(inputId);
      // Rahakenttien virheriveillä on kentän nimen mukainen tunniste
      // (ifCostBasisMinorError); ilman tätä niiden viesti jäi näkymättä.
      const errorNode = maybe(inputId + 'Error') || maybe(inputId + 'MinorError');
      if (input) {
        input.classList.add('invalid');
        input.setAttribute('aria-invalid', 'true');
        if (!firstInvalid) firstInvalid = inputId;
      }
      if (errorNode) {
        errorNode.textContent = message;
        errorNode.style.display = 'block';
      }
    }
    if (firstInvalid) focus(firstInvalid);
  };

  return { clear, show };
}

// ------------------------------------------------------------ kytkennät

/** Kytke sijoitusnäkymän tapahtumat. Kutsutaan kerran. */
export function initInvestmentForms() {
  if (!maybe('addInvestmentBtn')) return;

  el('addInvestmentBtn').addEventListener('click', openAddInvestmentForm);
  el('ifCancel').addEventListener('click', closeInvestmentForm);
  el('ifSave').addEventListener('click', submitInvestment);
  el('ifDelete').addEventListener('click', async () => {
    const id = getState().editingInvestmentId;
    if (id && await deleteInvestment(id)) closeInvestmentForm();
  });

  el('investmentForm').addEventListener('keydown', event => {
    if (event.key === 'Escape') closeInvestmentForm();
  });
}
