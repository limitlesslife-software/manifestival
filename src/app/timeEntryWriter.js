// Aikakirjauksen kirjoittaja: kanta, idempotenssi ja lähtökori.
//
// Tehdas, jotta riippuvuudet (repositorio, tallennus, istunto) voidaan
// korvata testeissä. Portin ollessa kiinni oikeaa kantapolkua ei voi
// ajaa; tällä rakenteella offline- ja uusintapolku testataan silti
// oikealla koodilla tekorepositoriota vasten.
//
// KAPEA RAJAUS: tämä koskee VAIN aikakirjauksia. Yleistä offline-jonoa
// (src/app/offlineSync.js, tehtävät) ei laajenneta.
//
//   insert(entry)
//     ok          -> { ok: true }
//     23505       -> { ok: true, duplicate: true }   sama operaatio on jo kannassa
//     verkko/auth -> { ok: true, queued: true }       jos kanta on käytössä ja
//                                                     lähtökoriin mahtuu
//     muu         -> { ok: false, error }
//
//   flush()
//     lähettää lähtökorin järjestyksessä; pysähtyy ensimmäiseen verkkovirheeseen;
//     kaksoiskappale (23505) = jo perillä; hylätty poistetaan korista
//     (`rejected`-listassa), ettei sitä uusita loputtomiin.

import { classifyError, ERROR_CLASS } from '../domain/offlineQueue.js';

export function createTimeEntryWriter({
  repo, loadOutbox, saveOutbox, userId, isSameSession = () => true, snapshot = () => null,
  isOffline = () => false, maxOutbox = 200
}) {
  function retryable(error) {
    const kind = classifyError(error, { offline: isOffline() });
    return kind === ERROR_CLASS.NETWORK || kind === ERROR_CLASS.AUTH;
  }

  function queue(entry) {
    const id = userId();
    if (!id) return false;
    const outbox = loadOutbox(id);
    if (outbox.some(other => other.operationId === entry.operationId)) return true;
    if (outbox.length >= maxOutbox) return false;
    return saveOutbox(id, [...outbox, entry]).ok;
  }

  return {
    async insert(entry) {
      const result = await repo.insert(entry);
      if (result.ok) return { ok: true };
      if (classifyError(result.error) === ERROR_CLASS.DUPLICATE) return { ok: true, duplicate: true };
      if (repo.isPersistent() && retryable(result.error) && queue(entry)) return { ok: true, queued: true };
      return { ok: false, error: result.error };
    },

    pendingCount() {
      const id = userId();
      return id ? loadOutbox(id).length : 0;
    },

    async flush() {
      const id = userId();
      if (!id || !repo.isPersistent()) return { sent: 0, left: 0, rejected: [] };
      const started = snapshot();
      const outbox = loadOutbox(id);
      const left = [];
      const rejected = [];
      let sent = 0;
      for (const [index, entry] of outbox.entries()) {
        // Istunto vaihtui kesken: ei lähetetä toisen käyttäjän nimissä.
        if (!isSameSession(started)) return { sent, left: outbox.length - index, rejected, aborted: true };
        const result = await repo.insert(entry);
        if (result.ok || classifyError(result.error) === ERROR_CLASS.DUPLICATE) {
          sent += 1;
          continue;
        }
        if (retryable(result.error)) {
          left.push(...outbox.slice(index));
          break;
        }
        rejected.push({ entry, error: result.error });
      }
      saveOutbox(id, left);
      return { sent, left: left.length, rejected };
    }
  };
}
