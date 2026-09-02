// Vahvistusdialogi.
//
// ONGELMA: tehtävän poisto tapahtui yhdellä klikkauksella ilman vahvistusta
// ja ilman peruutusmahdollisuutta. Yksi harhaklikkaus tuhosi tiedon pysyvästi.
//
// Käytetään natiivia <dialog>-elementtiä, jolloin fokusloukku, Esc-näppäin ja
// ruudunlukijasemantiikka tulevat selaimelta ilmaiseksi. Vanhemmille
// selaimille on varasuunnitelma (window.confirm), jotta poisto ei koskaan
// tapahdu vahingossa vahvistamatta.

const DIALOG_ID = 'confirmDialog';

function buildDialog() {
  const dialog = document.createElement('dialog');
  dialog.id = DIALOG_ID;
  dialog.className = 'confirm-dialog';
  dialog.innerHTML = `
    <form method="dialog" class="confirm-body">
      <h2 class="confirm-title" id="confirmTitle"></h2>
      <p class="confirm-message" id="confirmMessage"></p>
      <div class="confirm-actions">
        <button value="cancel" class="form-btn secondary" id="confirmCancel" type="submit"></button>
        <button value="confirm" class="form-btn danger" id="confirmAccept" type="submit"></button>
      </div>
    </form>`;
  document.body.appendChild(dialog);
  return dialog;
}

function dialogElement() {
  return document.getElementById(DIALOG_ID) || buildDialog();
}

/**
 * Kysy vahvistus.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.message
 * @param {string} [options.confirmLabel]
 * @param {string} [options.cancelLabel]
 * @param {boolean} [options.destructive] Väritä toiminto vaaralliseksi.
 * @returns {Promise<boolean>}
 */
export function confirmAction({
  title,
  message,
  confirmLabel = 'Vahvista',
  cancelLabel = 'Peruuta',
  destructive = false
}) {
  const dialog = dialogElement();

  // Varasuunnitelma, jos selain ei tue <dialog>-elementtiä.
  if (typeof dialog.showModal !== 'function') {
    const text = title ? `${title}\n\n${message}` : message;
    return Promise.resolve(Boolean(globalThis.confirm && globalThis.confirm(text)));
  }

  dialog.querySelector('#confirmTitle').textContent = title || '';
  dialog.querySelector('#confirmMessage').textContent = message || '';

  const acceptButton = dialog.querySelector('#confirmAccept');
  const cancelButton = dialog.querySelector('#confirmCancel');
  acceptButton.textContent = confirmLabel;
  cancelButton.textContent = cancelLabel;
  acceptButton.classList.toggle('danger', destructive);

  return new Promise(resolve => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      resolve(dialog.returnValue === 'confirm');
    };
    dialog.addEventListener('close', onClose);
    dialog.returnValue = 'cancel';
    dialog.showModal();
    // Fokus peruutukseen: vaarallinen toiminto ei saa olla oletusvalinta.
    cancelButton.focus();
  });
}

/** Valmis vahvistus tehtävän poistolle. */
export function confirmDelete(taskTitle) {
  return confirmAction({
    title: 'Poistetaanko tehtävä?',
    message: taskTitle
      ? `"${taskTitle}" poistetaan pysyvästi. Tätä ei voi perua.`
      : 'Tehtävä poistetaan pysyvästi. Tätä ei voi perua.',
    confirmLabel: 'Poista',
    cancelLabel: 'Peruuta',
    destructive: true
  });
}

// ---------------------------------------------- AI-ehdotuksen vahvistus

const PROPOSAL_DIALOG_ID = 'proposalDialog';

function buildProposalDialog() {
  const dialog = document.createElement('dialog');
  dialog.id = PROPOSAL_DIALOG_ID;
  dialog.className = 'confirm-dialog proposal-dialog';
  dialog.innerHTML = `
    <form method="dialog" class="confirm-body">
      <div class="proposal-kind" id="proposalKind"></div>
      <h2 class="confirm-title" id="proposalTitle"></h2>
      <p class="confirm-message" id="proposalTarget"></p>
      <div class="proposal-changes" id="proposalChanges"></div>
      <div class="proposal-warning" id="proposalWarning" hidden></div>
      <div class="confirm-actions">
        <button value="cancel" class="form-btn secondary" id="proposalCancel" type="submit">Peruuta</button>
        <button value="confirm" class="form-btn primary" id="proposalAccept" type="submit">Hyväksy</button>
      </div>
    </form>`;
  document.body.appendChild(dialog);
  return dialog;
}

function proposalDialogElement() {
  return document.getElementById(PROPOSAL_DIALOG_ID) || buildProposalDialog();
}

/**
 * Yksi muutosrivi.
 *
 * Rakennetaan DOM-solmuina eikä merkkijonona: arvot ovat käyttäjän ja
 * AI:n tuottamaa tekstiä, ja textContent estää injektion rakenteellisesti
 * sen sijaan että luottaisi escapetukseen. Tämä on vahvempi takuu kuin
 * escapeHtml, koska se ei voi unohtua yhdestä kentästä.
 */
function buildChangeRow(row) {
  const node = document.createElement('div');
  node.className = 'proposal-change';

  const label = document.createElement('span');
  label.className = 'proposal-change-label';
  label.textContent = row.label;

  const before = document.createElement('span');
  before.className = 'proposal-before';
  before.textContent = row.before;

  const arrow = document.createElement('span');
  arrow.className = 'proposal-arrow';
  arrow.textContent = '→';
  arrow.setAttribute('aria-label', 'muuttuu arvoksi');

  const after = document.createElement('span');
  after.className = 'proposal-after';
  after.textContent = row.after;

  node.append(label, before, arrow, after);
  return node;
}

/**
 * Näytä AI:n ehdotus ja kysy vahvistus.
 *
 * Käyttäjän on nähtävä NELJÄ asiaa ennen päätöstä:
 *   1. mitä tehdään
 *   2. mihin tietoon
 *   3. nykyinen arvo → uusi arvo
 *   4. onko toiminto peruuttamaton
 *
 * Käytetään sovelluksen omaa dialogia eikä selaimen confirm-toimintoa:
 * raaka dialogi ei voi näyttää muutosrivejä eikä erottaa vaarallista
 * toimintoa tavallisesta.
 *
 * @param {object} proposal buildProposal-tulos
 * @returns {Promise<boolean>}
 */
export function confirmProposal(proposal) {
  if (!proposal || !proposal.preview) return Promise.resolve(false);

  const preview = proposal.preview;
  const dialog = proposalDialogElement();

  // Varasuunnitelma vanhoille selaimille. Muutosrivit tiivistetään
  // tekstiksi, jottei vahvistus tapahdu tyhjän päälle.
  if (typeof dialog.showModal !== 'function') {
    const lines = [preview.description];
    for (const row of preview.changes) {
      lines.push(`${row.label}: ${row.before} -> ${row.after}`);
    }
    if (preview.destructive) lines.push('Tätä ei voi perua.');
    return Promise.resolve(
      Boolean(globalThis.confirm && globalThis.confirm(lines.join('\n'))));
  }

  dialog.querySelector('#proposalKind').textContent = preview.targetTypeLabel || '';
  dialog.querySelector('#proposalTitle').textContent = preview.action;
  dialog.querySelector('#proposalTarget').textContent =
    preview.targetLabel || preview.description;

  const changes = dialog.querySelector('#proposalChanges');
  changes.replaceChildren();
  for (const row of preview.changes) changes.appendChild(buildChangeRow(row));

  const warning = dialog.querySelector('#proposalWarning');
  warning.textContent = preview.destructive
    ? 'Tämä poistaa tiedon pysyvästi. Toimintoa ei voi perua.'
    : '';
  warning.hidden = !preview.destructive;

  const accept = dialog.querySelector('#proposalAccept');
  const cancel = dialog.querySelector('#proposalCancel');

  accept.hidden = false;
  accept.textContent = preview.destructive ? 'Poista pysyvästi' : 'Hyväksy';
  accept.classList.toggle('danger', preview.destructive);
  accept.classList.toggle('primary', !preview.destructive);
  cancel.textContent = 'Peruuta';
  dialog.classList.toggle('destructive', preview.destructive);

  return new Promise(resolve => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      resolve(dialog.returnValue === 'confirm');
    };
    dialog.addEventListener('close', onClose);
    dialog.returnValue = 'cancel';
    dialog.showModal();
    // Fokus peruutukseen: vaarallinen toiminto ei saa olla oletusvalinta.
    cancel.focus();
  });
}

/**
 * Kysy käyttäjältä kumpi kohde tarkoitettiin.
 *
 * Näytetään silloin kun tunnistus palautti AMBIGUOUS. AI ei saa valita
 * puolesta, mutta käyttäjä voi — ja se on ainoa turvallinen tapa edetä.
 *
 * @returns {Promise<object|null>} valittu ehdokas tai null
 */
export function chooseTarget(candidates, question = 'Mitä näistä tarkoitit?') {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return Promise.resolve(null);
  }

  const dialog = proposalDialogElement();

  // Ilman dialogia ei voi valita turvallisesti, eikä arvata saa.
  if (typeof dialog.showModal !== 'function') return Promise.resolve(null);

  dialog.querySelector('#proposalKind').textContent = 'Tarkennus';
  dialog.querySelector('#proposalTitle').textContent = question;
  dialog.querySelector('#proposalTarget').textContent = '';

  const list = dialog.querySelector('#proposalChanges');
  list.replaceChildren();

  let chosen = null;

  for (const candidate of candidates) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'proposal-candidate';
    button.textContent = candidate.date
      ? `${candidate.label} — ${candidate.date}`
      : candidate.label;
    button.addEventListener('click', () => {
      chosen = candidate;
      dialog.returnValue = 'confirm';
      dialog.close();
    });
    list.appendChild(button);
  }

  dialog.querySelector('#proposalWarning').hidden = true;

  const accept = dialog.querySelector('#proposalAccept');
  const cancel = dialog.querySelector('#proposalCancel');
  accept.hidden = true;
  cancel.textContent = 'Peruuta';

  return new Promise(resolve => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      accept.hidden = false;
      resolve(dialog.returnValue === 'confirm' ? chosen : null);
    };
    dialog.addEventListener('close', onClose);
    dialog.returnValue = 'cancel';
    dialog.showModal();
    cancel.focus();
  });
}
