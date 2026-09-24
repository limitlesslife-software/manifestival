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

/** Vierasavainrikkomus: viitattu kohde (tehtävä, rutiini, ...) on poistettu. */
function isMissingTarget(error) {
  const cause = (error && error.cause) || error || {};
  return String(cause.code || '') === '23503';
}

/**
 * Kohde poistui ennen kuin kirjaus ehti kantaan. Minuutit ovat silti
 * käyttäjän aikaa: kirjaus tallennetaan ilman kohdetta (ensin alue
 * säilyttäen, sitten ilman aluettakin) eikä sitä hylätä.
 */
function detachedVariants(entry) {
  const noItem = { ...entry, taskId: null, goalId: null, projectId: null, routineId: null, occurrenceDate: null };
  return entry.lifeAreaId ? [noItem, { ...noItem, lifeAreaId: null }] : [noItem];
}

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

  async function insertOnce(entry) {
    let result = await repo.insert(entry);
    if (!result.ok && isMissingTarget(result.error)) {
      for (const variant of detachedVariants(entry)) {
        result = await repo.insert(variant);
        if (result.ok || !isMissingTarget(result.error)) {
          return { result, entry: variant, detached: true };
        }
      }
    }
    return { result, entry, detached: false };
  }

  return {
    async insert(entry) {
      const { result, entry: stored, detached } = await insertOnce(entry);
      if (result.ok) return detached ? { ok: true, detached: true, entry: stored } : { ok: true };
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
      const detachedEntries = [];
      let sent = 0;
      for (const [index, entry] of outbox.entries()) {
        // Istunto vaihtui kesken: ei lähetetä toisen käyttäjän nimissä.
        if (!isSameSession(started)) return { sent, left: outbox.length - index, rejected, detached: detachedEntries, aborted: true };
        const { result, entry: stored, detached } = await insertOnce(entry);
        if (result.ok || classifyError(result.error) === ERROR_CLASS.DUPLICATE) {
          sent += 1;
          if (detached && result.ok) detachedEntries.push(stored);
          continue;
        }
        if (retryable(result.error)) {
          left.push(...outbox.slice(index));
          break;
        }
        rejected.push({ entry, error: result.error });
      }
      saveOutbox(id, left);
      return { sent, left: left.length, rejected, detached: detachedEntries };
    }
  };
}
