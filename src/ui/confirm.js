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
