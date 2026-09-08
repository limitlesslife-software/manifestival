// Talousnäkymä: laskut, toistuvat menot ja säästötavoitteet.
//
// MIKSI TÄMÄ ON OLEMASSA
//
// Kolmella talousdomainilla oli kanta, RLS, repositoriot ja koko
// domain-logiikka — mutta ei yhtään näkymää. Rivit ladattiin tilaan
// eikä niitä renderöity missään. Sanaa "Talous" ei esiintynyt
// käyttöliittymässä kertaakaan, eikä laskua voinut luoda.
//
// RAHA ON SENTTEINÄ, AINA
//
// Lomake lukee tekstiä ja `parseMoneyToMinor` muuttaa sen
// kokonaisluvuksi. Näyttöön mennään `formatMoney`-funktion kautta.
// Liukulukua ei synny missään vaiheessa: `12,34` -> `1234` -> `12,34 €`.
//
// Molemmat desimaalierottimet kelpaavat. Suomalainen kirjoittaa
// pilkun, numeronäppäimistö tuottaa pisteen, ja kumpikin tarkoittaa
// samaa.
//
// MITÄ TÄMÄ EI TEE
//
// Ei pankkiyhteyksiä, ei tilisaldoja, ei sijoituksia, ei tuloja, ei
// ennusteita. Vain se mitä mallissa on. Yleiskuva laskee olemassa
// olevista riveistä eikä keksi lukuja.

import { el, maybe, toggle, setText, focus } from '../../ui/dom.js';
import { escapeHtml, formatShortDate } from '../../lib/format.js';
import {
  getState, findBill, findRecurringExpense, findSavingsGoal,
  setEditingBillId, setEditingExpenseId, setEditingSavingsId, setFinanceSegment
} from '../state.js';
import {
  BILL_STATUS, CADENCE, CADENCES, cadenceLabel, billUrgency, BILL_URGENCY,
  isOpenBill, summarizeSavingsGoal, monthlyCostByCurrency, summarizeFinances
} from '../../domain/finance.js';
import {
  DEFAULT_CURRENCY, parseMoneyToMinor, formatMoney, formatMinorAsInput,
  formatTotals
} from '../../domain/money.js';
import {
  createBill, editBill, deleteBill, setBillPaid,
  createRecurringExpense, editRecurringExpense, deleteRecurringExpense,
  createSavingsGoal, editSavingsGoal, deleteSavingsGoal
} from '../actions.js';
import { fmtISO, parseISO, todayMidnight } from '../../lib/datetime.js';

/**
 * Tuetut valuutat.
 *
 * Malli hyväksyy minkä tahansa kolmen ison kirjaimen koodin
 * (`normalizeCurrency`), mutta valikko tarjoaa ne joita oikeasti
 * käytetään. Vapaa tekstikenttä valuutalle olisi tapa kirjoittaa
 * kirjoitusvirhe pysyvästi kantaan.
 */
const CURRENCIES = Object.freeze(['EUR', 'SEK', 'NOK', 'DKK', 'USD', 'GBP']);

let optionsReady = false;

function fillSelectOptions() {
  if (optionsReady) return;

  for (const id of ['bfCurrency', 'efCurrency', 'sfCurrency']) {
    const node = maybe(id);
    if (!node) continue;
    node.innerHTML = CURRENCIES
      .map(code => `<option value="${escapeHtml(code)}">${escapeHtml(code)}</option>`)
      .join('');
  }

  const cadence = maybe('efCadence');
  if (cadence) {
    cadence.innerHTML = CADENCES
      .map(value => `<option value="${escapeHtml(value)}">`
        + `${escapeHtml(cadenceLabel(value))}</option>`).join('');
  }

  optionsReady = true;
}

/**
 * Toistuvien menojen valikko laskulle.
 *
 * KÄYTTÖKOKEMUSTA, EI TURVAA. Valikko näyttää vain kirjautuneen
 * käyttäjän omat menot, koska tila sisältää vain niitä. Varsinainen
 * este on kannassa: yhdistelmävierasavain
 * `(user_id, recurring_expense_id) -> recurring_expenses (user_id, id)`
 * torjuu vieraan menon, vaikka selain lähettäisi sellaisen.
 */
function refreshExpensePicker(selectedId) {
  const picker = maybe('bfExpense');
  if (!picker) return;

  const expenses = getState().recurringExpenses;
  picker.innerHTML = '<option value="">Ei liity toistuvaan menoon</option>'
    + expenses.map(expense => `<option value="${escapeHtml(expense.id)}">`
      + `${escapeHtml(expense.name)}</option>`).join('');

  picker.value = selectedId || '';

  // Poistettu tai tuntematon meno: linkki näytetään silti, jottei
  // tallennus katkaisisi sitä huomaamatta.
  if (selectedId && picker.value !== selectedId) {
    picker.insertAdjacentHTML('beforeend',
      `<option value="${escapeHtml(selectedId)}">Poistettu meno</option>`);
    picker.value = selectedId;
  }
}

// ------------------------------------------------------------ yleiskuva

function renderOverview(container, state) {
  const todayIso = fmtISO(todayMidnight());
  const summary = summarizeFinances({
    bills: state.bills,
    recurringExpenses: state.recurringExpenses,
    savingsGoals: state.savingsGoals,
    todayIso
  });

  const nothing = state.bills.length === 0
    && state.recurringExpenses.length === 0
    && state.savingsGoals.length === 0;

  if (nothing) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">Talous on vielä tyhjä.</div>
        <p>Lisää lasku, toistuva meno tai säästötavoite. Yhteenveto
        lasketaan siitä mitä kirjaat — mitään ei haeta muualta.</p>
      </div>`;
    return;
  }

  const monthly = formatTotals(monthlyCostByCurrency(state.recurringExpenses));
  const openBills = state.bills.filter(isOpenBill);
  const overdue = openBills.filter(bill => billUrgency(bill, todayIso) === BILL_URGENCY.OVERDUE);

  container.innerHTML = `
    <div class="focus-block">
      <div class="focus-title">Tilanne</div>
      <div class="focus-summary">
        <span class="load-chip${overdue.length ? ' tone-clay' : ''}">
          ${openBills.length} avointa laskua</span>
        ${overdue.length
          ? `<span class="load-chip tone-clay">${overdue.length} myöhässä</span>` : ''}
        <span class="load-chip">${escapeHtml(monthly || 'Ei toistuvia menoja')} / kk</span>
        <span class="load-chip">${state.savingsGoals.length} säästötavoitetta</span>
      </div>
    </div>`;

  void summary;
}

// --------------------------------------------------------------- laskut

function renderBills(container, state) {
  const todayIso = fmtISO(todayMidnight());
  const bills = [...state.bills].sort((a, b) => {
    const aOpen = isOpenBill(a) ? 0 : 1;
    const bOpen = isOpenBill(b) ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    return String(a.dueDate || '').localeCompare(String(b.dueDate || ''));
  });

  if (bills.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">Ei laskuja.</div>
        <p>Lisää lasku, niin näet eräpäivät yhdessä paikassa ja voit
        merkitä ne maksetuiksi.</p>
      </div>`;
    return;
  }

  container.innerHTML = bills.map(bill => {
    const paid = bill.status === BILL_STATUS.PAID;
    const expense = bill.recurringExpenseId
      ? findRecurringExpense(bill.recurringExpenseId) : null;

    return `<div class="task-row ${paid ? 'done' : ''}">
      <button class="chk ${paid ? 'done' : ''}" data-toggle-bill="${escapeHtml(bill.id)}"
              aria-pressed="${paid ? 'true' : 'false'}"
              aria-label="${paid ? 'Merkitse maksamattomaksi' : 'Merkitse maksetuksi'}: ${escapeHtml(bill.name)}">
        <svg aria-hidden="true"><use href="#i-check"/></svg>
      </button>
      <button class="t-body t-open" data-edit-bill="${escapeHtml(bill.id)}"
              aria-label="Muokkaa laskua: ${escapeHtml(bill.name)}">
        <div class="t-title">${escapeHtml(bill.name)}</div>
        <div class="t-meta">
          <span class="task-cat-tag">${escapeHtml(formatMoney(bill.amountMinor, bill.currency))}</span>
          ${!paid && billUrgency(bill, todayIso) === BILL_URGENCY.OVERDUE
            ? '<span class="prio-tag prio-clay">Myöhässä</span>' : ''}
          ${bill.dueDate
            ? `<span>Erääntyy ${escapeHtml(formatShortDate(parseISO(bill.dueDate)))}</span>` : ''}
          ${paid && bill.paidDate
            ? `<span>Maksettu ${escapeHtml(formatShortDate(parseISO(bill.paidDate)))}</span>` : ''}
        </div>
        ${expense ? `<div class="t-sub">Toistuva meno: ${escapeHtml(expense.name)}</div>` : ''}
      </button>
    </div>`;
  }).join('');

  container.querySelectorAll('[data-edit-bill]').forEach(node =>
    node.addEventListener('click', () => openBillForm(node.dataset.editBill)));
  container.querySelectorAll('[data-toggle-bill]').forEach(node =>
    node.addEventListener('click', () => toggleBillPaid(node.dataset.toggleBill)));
}

async function toggleBillPaid(id) {
  const bill = findBill(id);
  if (!bill) return;
  await setBillPaid(id, bill.status !== BILL_STATUS.PAID);
}

// ------------------------------------------------------ toistuvat menot

function renderExpenses(container, state) {
  const expenses = [...state.recurringExpenses].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return String(a.nextDueDate || '').localeCompare(String(b.nextDueDate || ''));
  });

  if (expenses.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">Ei toistuvia menoja.</div>
        <p>Vuokra, vakuutus, tilaukset. Kun ne ovat kirjattuina, tiedät
        paljonko kuukaudesta on jo varattu.</p>
      </div>`;
    return;
  }

  container.innerHTML = expenses.map(expense => `
    <div class="task-row ${expense.active ? '' : 'done'}">
      <button class="t-body t-open" data-edit-expense="${escapeHtml(expense.id)}"
              aria-label="Muokkaa toistuvaa menoa: ${escapeHtml(expense.name)}">
        <div class="t-title">${escapeHtml(expense.name)}${
          expense.active ? '' : '<span class="prio-tag prio-muted">Pois käytöstä</span>'}</div>
        <div class="t-meta">
          <span class="task-cat-tag">${escapeHtml(formatMoney(expense.amountMinor, expense.currency))}</span>
          <span>${escapeHtml(cadenceLabel(expense.cadence))}</span>
          ${expense.nextDueDate
            ? `<span>Seuraava ${escapeHtml(formatShortDate(parseISO(expense.nextDueDate)))}</span>` : ''}
        </div>
      </button>
    </div>`).join('');

  container.querySelectorAll('[data-edit-expense]').forEach(node =>
    node.addEventListener('click', () => openExpenseForm(node.dataset.editExpense)));
}

// ------------------------------------------------------ säästötavoitteet

function renderSavings(container, state) {
  const goals = [...state.savingsGoals]
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'fi'));

  if (goals.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">Ei säästötavoitteita.</div>
        <p>Puskuri, matka, hankinta. Tavoite ja kertynyt summa riittävät —
        edistyminen lasketaan niistä.</p>
      </div>`;
    return;
  }

  container.innerHTML = goals.map(goal => {
    const summary = summarizeSavingsGoal(goal);
    return `<div class="task-row">
      <button class="t-body t-open" data-edit-savings="${escapeHtml(goal.id)}"
              aria-label="Muokkaa säästötavoitetta: ${escapeHtml(goal.name)}">
        <div class="t-title">${escapeHtml(goal.name)}${
          summary.reached ? '<span class="prio-tag prio-sage">Täynnä</span>' : ''}</div>
        <div class="t-meta">
          <span class="task-cat-tag">${escapeHtml(formatMoney(goal.currentMinor, goal.currency))}</span>
          <span>/ ${escapeHtml(formatMoney(goal.targetMinor, goal.currency))}</span>
          <span>${summary.percent} %</span>
          ${goal.targetDate
            ? `<span>${escapeHtml(formatShortDate(parseISO(goal.targetDate)))}</span>` : ''}
        </div>
        <div class="progress" role="img"
             aria-label="Edistyminen ${summary.percent} prosenttia">
          <div class="progress-fill${summary.reached ? ' done' : ''}"
               style="width:${summary.percent}%"></div>
        </div>
      </button>
    </div>`;
  }).join('');

  container.querySelectorAll('[data-edit-savings]').forEach(node =>
    node.addEventListener('click', () => openSavingsForm(node.dataset.editSavings)));
}

// ------------------------------------------------------------ renderöi

/** Renderöi koko talousnäkymä. */
export function renderFinance() {
  const overview = maybe('financeOverview');
  if (!overview) return;

  fillSelectOptions();
  const state = getState();

  renderOverview(overview, state);
  renderBills(el('billsListContainer'), state);
  renderExpenses(el('expensesListContainer'), state);
  renderSavings(el('savingsListContainer'), state);
  syncSegment();
}

function syncSegment() {
  const segment = getState().financeSegment || 'bills';

  toggle('billsSection', segment === 'bills');
  toggle('expensesSection', segment === 'expenses');
  toggle('savingsSection', segment === 'savings');

  const tabs = {
    bills: maybe('segmentBills'),
    expenses: maybe('segmentExpenses'),
    savings: maybe('segmentSavings')
  };
  for (const [key, node] of Object.entries(tabs)) {
    if (!node) continue;
    node.classList.toggle('active', key === segment);
    node.setAttribute('aria-selected', String(key === segment));
  }
}

// -------------------------------------------------------- lomakeapurit

/**
 * Näytä virheet lomakkeella.
 *
 * `formSelector` rajaa tyhjennyksen yhteen lomakkeeseen: kolme
 * lomaketta elää samalla näytöllä, eikä yhden tallennus saa pyyhkiä
 * toisen virheitä.
 */
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
      const errorNode = maybe(inputId + 'Error');
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

const billErrors = makeFormErrors('#billForm', {
  name: 'bfName', amountMinor: 'bfAmount', dueDate: 'bfDueDate', paidDate: 'bfPaidDate'
});
const expenseErrors = makeFormErrors('#expenseForm', {
  name: 'efName', amountMinor: 'efAmount', cadence: 'efCadence',
  nextDueDate: 'efNextDueDate'
});
const savingsErrors = makeFormErrors('#savingsForm', {
  name: 'sfName', targetMinor: 'sfTarget', currentMinor: 'sfCurrent',
  targetDate: 'sfTargetDate'
});

/**
 * Lue rahakenttä.
 *
 * Tyhjä on `null` eikä nolla: "ei summaa" ja "nolla euroa" ovat eri
 * asioita, ja validointi erottaa ne. Kelvoton syöte on myös `null`,
 * jolloin `validateX` kertoo siitä käyttäjälle — se ei koskaan
 * pyöristy hiljaa joksikin muuksi.
 */
function readMoney(id) {
  const raw = el(id).value.trim();
  if (raw === '') return null;
  return parseMoneyToMinor(raw);
}

// ---------------------------------------------------------------- lasku

function readBillForm() {
  const picker = maybe('bfExpense');
  return {
    name: el('bfName').value.trim(),
    amountMinor: readMoney('bfAmount'),
    currency: el('bfCurrency').value,
    dueDate: el('bfDueDate').value || null,
    paidDate: el('bfPaidDate').value || null,
    status: el('bfPaidDate').value ? BILL_STATUS.PAID : BILL_STATUS.OPEN,
    recurringExpenseId: picker && picker.value ? picker.value : null,
    note: el('bfNote').value.trim() || null
  };
}

function fillBillForm(bill) {
  fillSelectOptions();
  el('bfName').value = bill ? bill.name : '';
  el('bfAmount').value = bill ? formatMinorAsInput(bill.amountMinor) : '';
  el('bfCurrency').value = bill ? bill.currency : DEFAULT_CURRENCY;
  el('bfDueDate').value = bill && bill.dueDate ? bill.dueDate : '';
  el('bfPaidDate').value = bill && bill.paidDate ? bill.paidDate : '';
  el('bfNote').value = bill && bill.note ? bill.note : '';
  refreshExpensePicker(bill && bill.recurringExpenseId ? bill.recurringExpenseId : null);
}

export function openAddBillForm() {
  setEditingBillId(null);
  fillBillForm(null);
  billErrors.clear();
  setText('billFormTitle', 'Uusi lasku');
  toggle('bfDelete', false);
  toggle('billForm', true, 'flex');
  toggle('addBillBtn', false, 'flex');
  focus('bfName');
}

export function openBillForm(id) {
  const bill = findBill(id);
  if (!bill) return;
  setEditingBillId(id);
  fillBillForm(bill);
  billErrors.clear();
  setText('billFormTitle', 'Muokkaa laskua');
  toggle('bfDelete', true, 'flex');
  toggle('billForm', true, 'flex');
  toggle('addBillBtn', false, 'flex');
  focus('bfName');
}

export function closeBillForm() {
  setEditingBillId(null);
  // Kentat tyhjennetaan, ei vain piiloteta -- uloskirjautuminen
  // kutsuu tata, eika seuraava kayttaja saa loytaa edellisen tekstia.
  fillBillForm(null);
  billErrors.clear();
  toggle('billForm', false);
  toggle('addBillBtn', true, 'flex');
}

async function submitBill() {
  const input = readBillForm();
  const editingId = getState().editingBillId;
  const result = editingId ? await editBill(editingId, input) : await createBill(input);

  if (!result || !result.ok) {
    if (result && result.errors) billErrors.show(result.errors);
    return;
  }
  closeBillForm();
}

// -------------------------------------------------------- toistuva meno

function readExpenseForm() {
  const day = el('efDayOfMonth').value.trim();
  return {
    name: el('efName').value.trim(),
    amountMinor: readMoney('efAmount'),
    currency: el('efCurrency').value,
    cadence: el('efCadence').value,
    nextDueDate: el('efNextDueDate').value || null,
    dayOfMonth: day === '' ? null : Number(day),
    active: el('efActive').checked
  };
}

function fillExpenseForm(expense) {
  fillSelectOptions();
  el('efName').value = expense ? expense.name : '';
  el('efAmount').value = expense ? formatMinorAsInput(expense.amountMinor) : '';
  el('efCurrency').value = expense ? expense.currency : DEFAULT_CURRENCY;
  el('efCadence').value = expense ? expense.cadence : CADENCE.MONTHLY;
  el('efNextDueDate').value = expense && expense.nextDueDate ? expense.nextDueDate : '';
  el('efDayOfMonth').value = expense && expense.dayOfMonth != null
    ? String(expense.dayOfMonth) : '';
  el('efActive').checked = expense ? expense.active !== false : true;
}

export function openAddExpenseForm() {
  setEditingExpenseId(null);
  fillExpenseForm(null);
  expenseErrors.clear();
  setText('expenseFormTitle', 'Uusi toistuva meno');
  toggle('efDelete', false);
  toggle('expenseForm', true, 'flex');
  toggle('addExpenseBtn', false, 'flex');
  focus('efName');
}

export function openExpenseForm(id) {
  const expense = findRecurringExpense(id);
  if (!expense) return;
  setEditingExpenseId(id);
  fillExpenseForm(expense);
  expenseErrors.clear();
  setText('expenseFormTitle', 'Muokkaa toistuvaa menoa');
  toggle('efDelete', true, 'flex');
  toggle('expenseForm', true, 'flex');
  toggle('addExpenseBtn', false, 'flex');
  focus('efName');
}

export function closeExpenseForm() {
  setEditingExpenseId(null);
  // Kentat tyhjennetaan, ei vain piiloteta -- uloskirjautuminen
  // kutsuu tata, eika seuraava kayttaja saa loytaa edellisen tekstia.
  fillExpenseForm(null);
  expenseErrors.clear();
  toggle('expenseForm', false);
  toggle('addExpenseBtn', true, 'flex');
}

async function submitExpense() {
  const input = readExpenseForm();
  const editingId = getState().editingExpenseId;
  const result = editingId
    ? await editRecurringExpense(editingId, input)
    : await createRecurringExpense(input);

  if (!result || !result.ok) {
    if (result && result.errors) expenseErrors.show(result.errors);
    return;
  }
  closeExpenseForm();
}

// ------------------------------------------------------- säästötavoite

function readSavingsForm() {
  return {
    name: el('sfName').value.trim(),
    targetMinor: readMoney('sfTarget'),
    currentMinor: readMoney('sfCurrent') ?? 0,
    currency: el('sfCurrency').value,
    targetDate: el('sfTargetDate').value || null
  };
}

function fillSavingsForm(goal) {
  fillSelectOptions();
  el('sfName').value = goal ? goal.name : '';
  el('sfTarget').value = goal ? formatMinorAsInput(goal.targetMinor) : '';
  el('sfCurrent').value = goal ? formatMinorAsInput(goal.currentMinor) : '';
  el('sfCurrency').value = goal ? goal.currency : DEFAULT_CURRENCY;
  el('sfTargetDate').value = goal && goal.targetDate ? goal.targetDate : '';
}

export function openAddSavingsForm() {
  setEditingSavingsId(null);
  fillSavingsForm(null);
  savingsErrors.clear();
  setText('savingsFormTitle', 'Uusi säästötavoite');
  toggle('sfDelete', false);
  toggle('savingsForm', true, 'flex');
  toggle('addSavingsBtn', false, 'flex');
  focus('sfName');
}

export function openSavingsForm(id) {
  const goal = findSavingsGoal(id);
  if (!goal) return;
  setEditingSavingsId(id);
  fillSavingsForm(goal);
  savingsErrors.clear();
  setText('savingsFormTitle', 'Muokkaa säästötavoitetta');
  toggle('sfDelete', true, 'flex');
  toggle('savingsForm', true, 'flex');
  toggle('addSavingsBtn', false, 'flex');
  focus('sfName');
}

export function closeSavingsForm() {
  setEditingSavingsId(null);
  // Kentat tyhjennetaan, ei vain piiloteta -- uloskirjautuminen
  // kutsuu tata, eika seuraava kayttaja saa loytaa edellisen tekstia.
  fillSavingsForm(null);
  savingsErrors.clear();
  toggle('savingsForm', false);
  toggle('addSavingsBtn', true, 'flex');
}

async function submitSavings() {
  const input = readSavingsForm();
  const editingId = getState().editingSavingsId;
  const result = editingId
    ? await editSavingsGoal(editingId, input)
    : await createSavingsGoal(input);

  if (!result || !result.ok) {
    if (result && result.errors) savingsErrors.show(result.errors);
    return;
  }
  closeSavingsForm();
}

// ------------------------------------------------------------- kytkennät

/** Kytke talousnäkymän tapahtumat. Kutsutaan kerran. */
export function initFinanceForms() {
  const segments = {
    bills: maybe('segmentBills'),
    expenses: maybe('segmentExpenses'),
    savings: maybe('segmentSavings')
  };
  for (const [key, node] of Object.entries(segments)) {
    if (node) node.addEventListener('click', () => setFinanceSegment(key));
  }

  if (!maybe('addBillBtn')) return;

  el('addBillBtn').addEventListener('click', openAddBillForm);
  el('bfCancel').addEventListener('click', closeBillForm);
  el('bfSave').addEventListener('click', submitBill);
  el('bfDelete').addEventListener('click', async () => {
    const id = getState().editingBillId;
    if (id && await deleteBill(id)) closeBillForm();
  });

  el('addExpenseBtn').addEventListener('click', openAddExpenseForm);
  el('efCancel').addEventListener('click', closeExpenseForm);
  el('efSave').addEventListener('click', submitExpense);
  el('efDelete').addEventListener('click', async () => {
    const id = getState().editingExpenseId;
    if (id && await deleteRecurringExpense(id)) closeExpenseForm();
  });

  el('addSavingsBtn').addEventListener('click', openAddSavingsForm);
  el('sfCancel').addEventListener('click', closeSavingsForm);
  el('sfSave').addEventListener('click', submitSavings);
  el('sfDelete').addEventListener('click', async () => {
    const id = getState().editingSavingsId;
    if (id && await deleteSavingsGoal(id)) closeSavingsForm();
  });

  for (const [formId, close] of [
    ['billForm', closeBillForm],
    ['expenseForm', closeExpenseForm],
    ['savingsForm', closeSavingsForm]
  ]) {
    el(formId).addEventListener('keydown', event => {
      if (event.key === 'Escape') close();
    });
  }
}
