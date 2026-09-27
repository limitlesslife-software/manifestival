// Tapahtumat, kuitin luenta ja kuukausibudjetti.
//
// KOLME KYSYMYSTÄ, JOIHIN TÄMÄ VASTAA
//
//   Tapahtumat   mitä olen kirjannut
//   Kuvasta      mitä tässä kuitissa lukee — ehdotuksena
//   Budjetti     mihin kuukauden raha meni
//
// ---------------------------------------------------------------
// SUUNTA ON LAJI, EI ETUMERKKI
// ---------------------------------------------------------------
//
// Käyttäjä kirjoittaa aina positiivisen summan. Menoksi tai tuloksi sen
// tekee `kind`, ja lomake avataan eri painikkeesta. Miinusmerkillä
// kirjoitettu tulo olisi toinen tapa sanoa meno — ja kahdesta tavasta
// seuraa ennemmin tai myöhemmin kolmas.
//
// ---------------------------------------------------------------
// LUENTA ON EHDOTUS
// ---------------------------------------------------------------
//
// Kuvasta luettu tieto ei tallennu mihinkään ennen kuin käyttäjä
// hyväksyy sen. Epävarmat kentät korostetaan, jokainen on
// muokattavissa, ja korjaaminen palauttaa luennan tarkistettavaksi.
//
// KUVAA EI OLE TÄSSÄ TIEDOSTOSSA. Se elää `receiptCapture.js`:ssä
// yhden funktiokutsun ajan ja vapautetaan. Näkymä saa vain luennan.

import { el, maybe, toggle, setText, focus } from '../../ui/dom.js';
import { escapeHtml, formatShortDate } from '../../lib/format.js';
import {
  getState, findTransaction, setEditingTransactionId, setPendingExtraction,
  clearPendingExtraction, setBudgetMonth, shiftBudgetMonth
} from '../state.js';
import { TRANSACTION_KIND, compareTransactions } from '../../domain/transactions.js';
import {
  EXPENSE_CATEGORIES, INCOME_CATEGORIES, categoryLabelForKind
} from '../../domain/financeCategories.js';
import {
  summarizeMonth, categoryBreakdown, surplusMinor, monthsWithData
} from '../../domain/budget.js';
import {
  EXTRACTION_SUBJECT, fieldsNeedingReview, applyCorrection
} from '../../domain/receipts.js';
import {
  DEFAULT_CURRENCY, parseMoneyToMinor, formatMoney, formatMinorAsInput
} from '../../domain/money.js';
import {
  createTransaction, createIncome, editTransaction, deleteTransaction,
  approveReceipt, approveScannedBill, rejectExtractionAction, scanImage
} from '../actions.js';
import { releaseFileInput } from '../receiptCapture.js';
import { fmtISO, parseISO, todayMidnight } from '../../lib/datetime.js';
import { showError } from '../../ui/toast.js';

const CURRENCIES = Object.freeze(['EUR', 'SEK', 'NOK', 'DKK', 'USD', 'GBP']);

/**
 * Kummalle lajille lomake on auki.
 *
 * Tämä ei ole sovelluksen tilaa vaan lomakkeen tilaa: se elää vain niin
 * kauan kuin lomake on auki, eikä sitä tarvitse kukaan muu.
 */
let formKind = TRANSACTION_KIND.EXPENSE;

/** Kumpaa kuvasta luetaan: kuittia vai laskua. */
let scanSubject = EXTRACTION_SUBJECT.RECEIPT;

/** Onko luenta parhaillaan kesken. Estää kaksoisklikkauksen. */
let scanning = false;

let optionsReady = false;

function fillSelectOptions() {
  if (optionsReady) return;

  const currency = maybe('txCurrency');
  if (currency) {
    currency.innerHTML = CURRENCIES
      .map(code => `<option value="${escapeHtml(code)}">${escapeHtml(code)}</option>`)
      .join('');
  }

  optionsReady = true;
}

/**
 * Täytä luokkavalikko lajin mukaan.
 *
 * Kululuokat ja tuloluokat ovat eri joukkoja: palkka ei ole kululuokka
 * eikä ruoka tuloluokka. Valikko vaihdetaan aina kun lomake avataan.
 */
function fillCategoryOptions(kind, selected) {
  const node = maybe('txCategory');
  if (!node) return;

  const categories = kind === TRANSACTION_KIND.INCOME
    ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;

  node.innerHTML = categories
    .map(category => `<option value="${escapeHtml(category.key)}">`
      + `${escapeHtml(category.label)}</option>`).join('');

  if (selected) node.value = selected;
}

// ---------------------------------------------------------- tapahtumat

function renderTransactions(container, state) {
  const transactions = [...state.transactions].sort(compareTransactions);

  if (transactions.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">Ei kirjattuja tapahtumia.</div>
        <p>Kirjaa meno tai tulo, tai lue kuitti kuvasta. Budjetti
        lasketaan siitä mitä kirjaat — mitään ei haeta pankista.</p>
      </div>`;
    return;
  }

  container.innerHTML = transactions.map(transaction => {
    const income = transaction.kind === TRANSACTION_KIND.INCOME;
    const transfer = transaction.kind === TRANSACTION_KIND.TRANSFER;
    const title = transaction.description
      || categoryLabelForKind(transaction.kind, transaction.category)
      || 'Nimetön tapahtuma';

    return `<div class="task-row">
      <button class="t-body t-open" data-edit-transaction="${escapeHtml(transaction.id)}"
              aria-label="Muokkaa tapahtumaa: ${escapeHtml(title)}">
        <div class="t-title">${escapeHtml(title)}${
          transfer ? '<span class="prio-tag prio-muted">Siirto</span>' : ''}</div>
        <div class="t-meta">
          <span class="task-cat-tag${income ? ' tone-sage' : ''}">${
            income ? '+' : transfer ? '' : '−'}${
            escapeHtml(formatMoney(transaction.amountMinor, transaction.currency))}</span>
          ${transaction.category
            ? `<span>${escapeHtml(
                categoryLabelForKind(transaction.kind, transaction.category))}</span>` : ''}
          ${transaction.date
            ? `<span>${escapeHtml(formatShortDate(parseISO(transaction.date)))}</span>` : ''}
        </div>
        ${transaction.sourceKind
          ? `<div class="t-sub">Syntyi lähteestä: ${escapeHtml(sourceLabel(transaction.sourceKind))}</div>`
          : ''}
      </button>
    </div>`;
  }).join('');

  container.querySelectorAll('[data-edit-transaction]').forEach(node =>
    node.addEventListener('click',
      () => openTransactionForm(node.dataset.editTransaction)));
}

function sourceLabel(sourceKind) {
  return {
    bill: 'lasku',
    recurring_expense: 'toistuva meno',
    savings_goal: 'säästötavoite',
    receipt: 'kuitti',
    investment: 'sijoitus'
  }[sourceKind] || sourceKind;
}

// ------------------------------------------------------------- budjetti

function renderBudget(container, state) {
  const todayIso = fmtISO(todayMidnight());
  const month = state.budgetMonth;

  const kuukausi = summarizeMonth({
    month,
    transactions: state.transactions,
    bills: state.bills,
    recurringExpenses: state.recurringExpenses,
    todayIso
  });

  const kuukaudet = monthsWithData({
    transactions: state.transactions, bills: state.bills
  });

  const breakdown = categoryBreakdown(kuukausi.byCategory, kuukausi.actualExpenseMinor);
  const surplus = surplusMinor(kuukausi);

  container.innerHTML = `
    <div class="month-picker">
      <button class="form-btn secondary" id="budgetPrev" type="button"
              aria-label="Edellinen kuukausi">‹</button>
      <div class="month-label" role="status">${escapeHtml(monthLabel(month))}</div>
      <button class="form-btn secondary" id="budgetNext" type="button"
              aria-label="Seuraava kuukausi">›</button>
    </div>

    <div class="focus-block">
      <div class="focus-title">Toteuma</div>
      <div class="focus-summary">
        <span class="load-chip tone-sage">Tulot ${
          escapeHtml(formatMoney(kuukausi.incomeMinor, DEFAULT_CURRENCY))}</span>
        <span class="load-chip">Menot ${
          escapeHtml(formatMoney(kuukausi.actualExpenseMinor, DEFAULT_CURRENCY))}</span>
        <span class="load-chip${kuukausi.netMinor < 0 ? ' tone-clay' : ''}">Erotus ${
          escapeHtml(formatMoney(kuukausi.netMinor, DEFAULT_CURRENCY))}</span>
      </div>
      <p class="hint">
        Tämä on kuukauden kirjattu erotus, <strong>ei tilin saldoa</strong>.
        Manifestivalilla ei ole pankkiyhteyttä eikä se tiedä saldoasi.
      </p>
    </div>

    <div class="focus-block">
      <div class="focus-title">Sitoumus</div>
      <div class="focus-summary">
        <span class="load-chip${kuukausi.overdueBillCount ? ' tone-clay' : ''}">${
          kuukausi.openBillCount} avointa laskua</span>
        <span class="load-chip">${
          escapeHtml(formatMoney(kuukausi.openBillsMinor, DEFAULT_CURRENCY))} maksamatta</span>
        ${kuukausi.overdueBillCount
          ? `<span class="load-chip tone-clay">${kuukausi.overdueBillCount} myöhässä</span>` : ''}
      </div>
    </div>

    <div class="focus-block">
      <div class="focus-title">Ennuste</div>
      <div class="focus-summary">
        <span class="load-chip">Toistuvat ${
          escapeHtml(formatMoney(kuukausi.recurringMonthlyMinor, DEFAULT_CURRENCY))} / kk</span>
        <span class="load-chip${kuukausi.projectedNetMinor < 0 ? ' tone-clay' : ''}">Jäljellä ${
          escapeHtml(formatMoney(kuukausi.projectedNetMinor, DEFAULT_CURRENCY))}</span>
      </div>
      <p class="hint">
        Toistuvia menoja ei vähennetä jäljellä olevasta: ne toteutuvat
        laskuina tai tapahtumina, ja vähentäminen laskisi saman menon kahdesti.
      </p>
    </div>

    ${surplus > 0 ? `
      <div class="focus-block">
        <div class="focus-title">Ylijäämä</div>
        <div class="focus-summary">
          <span class="load-chip tone-sage">${
            escapeHtml(formatMoney(surplus, DEFAULT_CURRENCY))}</span>
        </div>
        <p class="hint">
          Tästä voisit siirtää säästöön. <strong>Ehdotus, ei siirto</strong> —
          siirron teet itse omassa pankissasi ja kirjaat sen säästötavoitteeseen.
        </p>
      </div>` : ''}

    ${breakdown.length > 0 ? `
      <div class="focus-block">
        <div class="focus-title">Mihin raha meni</div>
        ${breakdown.map(row => `
          <div class="breakdown-row">
            <div class="breakdown-label">${escapeHtml(
              categoryLabelForKind(TRANSACTION_KIND.EXPENSE, row.category))}</div>
            <div class="progress" role="img"
                 aria-label="${row.percent} prosenttia menoista">
              <div class="progress-fill" style="width:${row.percent}%"></div>
            </div>
            <div class="breakdown-amount">${
              escapeHtml(formatMoney(row.amountMinor, DEFAULT_CURRENCY))}</div>
          </div>`).join('')}
      </div>` : `
      <div class="empty-state">
        <div class="empty-title">Tältä kuukaudelta ei ole menoja.</div>
        <p>Kirjaa tapahtumia tai merkitse laskuja maksetuiksi, niin
        erittely syntyy siitä.</p>
      </div>`}

    ${kuukaudet.length > 1 ? `
      <div class="month-jump">
        ${kuukaudet.slice(0, 12).map(m => `
          <button class="chip-btn${m === month ? ' active' : ''}" type="button"
                  data-month="${escapeHtml(m)}">${escapeHtml(monthLabel(m))}</button>`).join('')}
      </div>` : ''}`;

  const prev = container.querySelector('#budgetPrev');
  const next = container.querySelector('#budgetNext');
  if (prev) prev.addEventListener('click', () => shiftBudgetMonth(-1));
  if (next) next.addEventListener('click', () => shiftBudgetMonth(1));

  container.querySelectorAll('[data-month]').forEach(node =>
    node.addEventListener('click', () => setBudgetMonth(node.dataset.month)));
}

const MONTH_NAMES = Object.freeze([
  'tammikuu', 'helmikuu', 'maaliskuu', 'huhtikuu', 'toukokuu', 'kesäkuu',
  'heinäkuu', 'elokuu', 'syyskuu', 'lokakuu', 'marraskuu', 'joulukuu'
]);

/** 'YYYY-MM' -> 'lokakuu 2026'. */
export function monthLabel(month) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) return '';
  const [year, index] = month.split('-').map(Number);
  const name = MONTH_NAMES[index - 1];
  return name ? `${name} ${year}` : '';
}

// ---------------------------------------------------------- kuvan luenta

function renderExtraction(container, state) {
  const extraction = state.pendingExtraction;

  if (!extraction) {
    container.innerHTML = '';
    return;
  }

  const epavarmat = new Set(fieldsNeedingReview(extraction));
  const bill = extraction.subject === EXTRACTION_SUBJECT.BILL;

  // KENTTIEN NIMET OVAT SAMAT MOLEMMILLE, vain otsikot vaihtuvat:
  // laskulla `merchant` on saaja ja `date` eräpäivä. Yksi nimistö
  // tarkoittaa yhtä jäsennyspolkua ja yhtä korjauspolkua.
  const kentat = bill
    ? [
      ['merchant', 'Saaja', 'text', extraction.merchant || ''],
      ['totalMinor', 'Summa', 'money', formatMinorAsInput(extraction.totalMinor)],
      ['date', 'Eräpäivä', 'date', extraction.date || ''],
      ['iban', 'Tilinumero', 'text', extraction.iban || ''],
      ['reference', 'Viite', 'text', extraction.reference || '']
    ]
    : [
      ['merchant', 'Kauppa', 'text', extraction.merchant || ''],
      ['totalMinor', 'Summa', 'money', formatMinorAsInput(extraction.totalMinor)],
      ['date', 'Päivä', 'date', extraction.date || '']
    ];

  container.innerHTML = `
    <div class="add-form" style="display:flex;" role="group"
         aria-labelledby="extractionTitle">
      <div class="add-form-title" id="extractionTitle">
        ${bill ? 'Luettu lasku' : 'Luettu kuitti'} — tarkista ennen tallennusta
      </div>

      <p class="hint">
        Tämä on <strong>ehdotus</strong>. Mitään ei ole tallennettu.
        ${epavarmat.size > 0
          ? 'Korostetut kentät luettiin epävarmasti — tarkista ne.'
          : 'Kaikki kentät luettiin varmasti, mutta tarkista silti.'}
        ${bill ? 'Lasku tallennetaan <strong>avoimena</strong>: Manifestival ei maksa sitä.' : ''}
      </p>

      ${kentat.map(([kentta, teksti, tyyppi, arvo]) => `
        <div>
          <label class="field-label" for="ex_${field}">${escapeHtml(label)}${
            epavarmat.has(field) ? ' <span class="prio-tag prio-clay">epävarma</span>' : ''}</label>
          <input type="${type === 'date' ? 'date' : 'text'}" id="ex_${field}"
                 data-extraction-field="${field}"
                 ${type === 'money' ? 'inputmode="decimal"' : ''}
                 class="${epavarmat.has(field) ? 'invalid' : ''}"
                 value="${escapeHtml(String(value))}" autocomplete="off">
        </div>`).join('')}

      ${!bill && extraction.lineItems && extraction.lineItems.length > 0 ? `
        <div class="t-sub">Luetut rivit: ${extraction.lineItems.length} kpl</div>` : ''}

      <div class="form-actions">
        <button class="form-btn secondary" id="extractionReject" type="button">Hylkää</button>
        <button class="form-btn primary" id="extractionApprove" type="button">
          ${bill ? 'Tallenna avoimena laskuna' : 'Hyväksy ja kirjaa'}
        </button>
      </div>
    </div>`;

  container.querySelectorAll('[data-extraction-field]').forEach(node =>
    node.addEventListener('change', () => correctField(node.dataset.extractionField, node.value)));

  const reject = container.querySelector('#extractionReject');
  const approve = container.querySelector('#extractionApprove');
  if (reject) reject.addEventListener('click', () => rejectExtractionAction());
  if (approve) approve.addEventListener('click', submitExtraction);
}

/**
 * Korjaa yksi kenttä luennassa.
 *
 * KORJAUS PALAUTTAA LUENNAN TARKISTETTAVAKSI. `applyCorrection` asettaa
 * tilan REVIEWED eikä koskaan APPROVED — korjattu luenta ei ole
 * hyväksytty luenta, ja hyväksyntä on aina erillinen ele.
 */
function correctField(field, rawValue) {
  const extraction = getState().pendingExtraction;
  if (!extraction) return;

  const value = field === 'totalMinor'
    ? (String(rawValue).trim() === '' ? null : parseMoneyToMinor(rawValue))
    : (String(rawValue).trim() || null);

  setPendingExtraction(applyCorrection(extraction, { [field]: value }));
}

async function submitExtraction() {
  const extraction = getState().pendingExtraction;
  if (!extraction) return;

  const result = extraction.subject === EXTRACTION_SUBJECT.BILL
    ? await approveScannedBill(extraction)
    : await approveReceipt(extraction);

  if (!result || !result.ok) {
    showError('Luentaa ei voitu tallentaa. Tarkista kentät.');
  }
}

/**
 * Kuvan valinta ja luenta.
 *
 * TIEDOSTOVALITSIN TYHJENNETÄÄN AINA. Se pitää valitun tiedoston
 * muistissa niin kauan kuin arvo on asetettu, ja juuri kuitin kuva on
 * se tiedosto, jota ei haluta jättää DOMiin. Tyhjennys myös sallii
 * saman tiedoston valitsemisen uudelleen — `change` ei laukea, jos
 * arvo ei muutu.
 */
async function handleFileChosen(event) {
  const input = event.target;
  const file = input && input.files && input.files[0];

  if (!file || scanning) {
    releaseFileInput(input);
    return;
  }

  scanning = true;
  setText('captureReceiptBtn', 'Luetaan kuvaa…');

  try {
    // Tunnisteen luonti ja tilaan asettaminen tehdään toimintokerroksessa.
    // Näkymä vain kertoo, mitä luetaan, ja näyttää virheen.
    const result = await scanImage({ file, subject: scanSubject });
    // Hylätty = istunto vaihtui kesken; seuraavalle käyttäjälle ei näytetä
    // edellisen luennan lopputulosta, ei edes virhettä.
    if (!result.ok && !result.discarded) showError(result.error);
  } finally {
    // Kuva vapautetaan riippumatta siitä, onnistuiko luenta.
    releaseFileInput(input);
    scanning = false;
    setText('captureReceiptBtn', 'Valitse tai ota kuva');
  }
}

// --------------------------------------------------------- tapahtumalomake

function readTransactionForm() {
  return {
    kind: formKind,
    amountMinor: readMoney('txAmount'),
    currency: el('txCurrency').value,
    date: el('txDate').value || null,
    category: el('txCategory').value || null,
    description: el('txDescription').value.trim() || null,
    note: el('txNote').value.trim() || null
  };
}

function readMoney(id) {
  const raw = el(id).value.trim();
  if (raw === '') return null;
  return parseMoneyToMinor(raw);
}

function fillTransactionForm(transaction, kind) {
  fillSelectOptions();
  formKind = kind;
  fillCategoryOptions(kind, transaction ? transaction.category : null);

  el('txAmount').value = transaction ? formatMinorAsInput(transaction.amountMinor) : '';
  el('txCurrency').value = transaction ? transaction.currency : DEFAULT_CURRENCY;
  el('txDate').value = transaction && transaction.date
    ? transaction.date : fmtISO(todayMidnight());
  el('txDescription').value = transaction && transaction.description
    ? transaction.description : '';
  el('txNote').value = transaction && transaction.note ? transaction.note : '';
}

export function openAddTransactionForm(kind = TRANSACTION_KIND.EXPENSE) {
  setEditingTransactionId(null);
  fillTransactionForm(null, kind);
  transactionErrors.clear();
  setText('transactionFormTitle',
    kind === TRANSACTION_KIND.INCOME ? 'Uusi tulo' : 'Uusi meno');
  toggle('txDelete', false);
  toggle('transactionForm', true, 'flex');
  toggle('addExpenseTxBtn', false, 'flex');
  toggle('addIncomeTxBtn', false, 'flex');
  focus('txAmount');
}

export function openTransactionForm(id) {
  const transaction = findTransaction(id);
  if (!transaction) return;

  setEditingTransactionId(id);
  fillTransactionForm(transaction, transaction.kind);
  transactionErrors.clear();
  setText('transactionFormTitle',
    transaction.kind === TRANSACTION_KIND.INCOME ? 'Muokkaa tuloa' : 'Muokkaa menoa');
  toggle('txDelete', true, 'flex');
  toggle('transactionForm', true, 'flex');
  toggle('addExpenseTxBtn', false, 'flex');
  toggle('addIncomeTxBtn', false, 'flex');
  focus('txAmount');
}

export function closeTransactionForm() {
  setEditingTransactionId(null);
  // Kentät tyhjennetään, ei vain piiloteta — uloskirjautuminen kutsuu
  // tätä, eikä seuraava käyttäjä saa löytää edellisen tekstiä.
  fillTransactionForm(null, TRANSACTION_KIND.EXPENSE);
  transactionErrors.clear();
  toggle('transactionForm', false);
  toggle('addExpenseTxBtn', true, 'flex');
  toggle('addIncomeTxBtn', true, 'flex');
}

async function submitTransaction() {
  const input = readTransactionForm();
  const editingId = getState().editingTransactionId;

  const result = editingId
    ? await editTransaction(editingId, input)
    : input.kind === TRANSACTION_KIND.INCOME
      ? await createIncome(input)
      : await createTransaction(input);

  if (!result || !result.ok) {
    if (result && result.errors) transactionErrors.show(result.errors);
    return;
  }
  closeTransactionForm();
}

/** Virheiden näyttö, rajattuna tapahtumalomakkeeseen. */
const transactionErrors = makeFormErrors('#transactionForm', {
  amountMinor: 'txAmount', date: 'txDate', category: 'txCategory'
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

// ------------------------------------------------------------- renderöi

/** Renderöi tapahtumat, luenta ja budjetti. */
export function renderTransactionViews() {
  const state = getState();

  const list = maybe('transactionsListContainer');
  if (list) renderTransactions(list, state);

  const budget = maybe('budgetContainer');
  if (budget) renderBudget(budget, state);

  const capture = maybe('receiptCaptureContainer');
  if (capture) renderExtraction(capture, state);

  syncScanMode();
}

/** Kirjaustapa: kirjaa itse vai kuvasta. */
let scanMode = false;

function syncScanMode() {
  toggle('txManualMode', !scanMode);
  toggle('txScanMode', scanMode);

  for (const [id, active] of [['txModeManual', !scanMode], ['txModeScan', scanMode]]) {
    const node = maybe(id);
    if (!node) continue;
    node.classList.toggle('active', active);
    node.setAttribute('aria-selected', String(active));
  }

  for (const [id, active] of [
    ['scanKindReceipt', scanSubject === EXTRACTION_SUBJECT.RECEIPT],
    ['scanKindBill', scanSubject === EXTRACTION_SUBJECT.BILL]
  ]) {
    const node = maybe(id);
    if (!node) continue;
    node.classList.toggle('active', active);
    node.setAttribute('aria-selected', String(active));
  }
}

// ------------------------------------------------------------ kytkennät

/** Kytke tapahtumanäkymän tapahtumat. Kutsutaan kerran. */
export function initTransactionForms() {
  if (!maybe('addExpenseTxBtn')) return;

  el('addExpenseTxBtn').addEventListener('click',
    () => openAddTransactionForm(TRANSACTION_KIND.EXPENSE));
  el('addIncomeTxBtn').addEventListener('click',
    () => openAddTransactionForm(TRANSACTION_KIND.INCOME));
  el('txCancel').addEventListener('click', closeTransactionForm);
  el('txSave').addEventListener('click', submitTransaction);
  el('txDelete').addEventListener('click', async () => {
    const id = getState().editingTransactionId;
    if (id && await deleteTransaction(id)) closeTransactionForm();
  });

  el('transactionForm').addEventListener('keydown', event => {
    if (event.key === 'Escape') closeTransactionForm();
  });

  // Kirjaustapa. Kuvasta-tilaan siirtyminen sulkee lomakkeen, jottei
  // kaksi kirjaustapaa ole auki yhtä aikaa.
  el('txModeManual').addEventListener('click', () => {
    scanMode = false;
    syncScanMode();
  });
  el('txModeScan').addEventListener('click', () => {
    scanMode = true;
    closeTransactionForm();
    syncScanMode();
  });

  el('scanKindReceipt').addEventListener('click', () => {
    scanSubject = EXTRACTION_SUBJECT.RECEIPT;
    // Kesken oleva luenta koskee toista kohdetta, joten se unohdetaan.
    // Vaihtoehto — jättää se näkyviin — näyttäisi kuitin laskuna.
    clearPendingExtraction();
    syncScanMode();
  });
  el('scanKindBill').addEventListener('click', () => {
    scanSubject = EXTRACTION_SUBJECT.BILL;
    clearPendingExtraction();
    syncScanMode();
  });

  el('captureReceiptBtn').addEventListener('click', () => {
    if (!scanning) el('receiptFileInput').click();
  });
  el('receiptFileInput').addEventListener('change', handleFileChosen);
}

/** Tila, jonka uloskirjautuminen nollaa. */
export function resetTransactionViews() {
  scanMode = false;
  scanSubject = EXTRACTION_SUBJECT.RECEIPT;
  scanning = false;
  const input = maybe('receiptFileInput');
  if (input) releaseFileInput(input);
  closeTransactionForm();
}
