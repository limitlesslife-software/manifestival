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
//     ENNAKKOKIRJAUS: kun kanta on käytössä, kirjaus tallennetaan koriin
//     ENNEN lähetystä ja poistetaan vasta vastauksen jälkeen. Jumittunut
//     pyyntö, sovelluksen sulkeminen tai samaan aikaan valmistuva lataus
//     ei siis hukkaa sitä; uusinta on idempotentti (23505 = perillä).
//     Omistaja luetaan ENNEN odotusta: jos käyttäjä vaihtuu kesken,
//     kirjaus jää tekijänsä koriin eikä koskaan uuden käyttäjän nimiin.
//
//   flush()
//     lähettää lähtökorin järjestyksessä; pysähtyy ensimmäiseen verkkovirheeseen;
//     kaksoiskappale (23505) = jo perillä; hylätty poistetaan korista
//     (`rejected`-listassa), ettei sitä uusita loputtomiin. Yksi lähetys
//     kerrallaan: rinnakkainen kutsu saa käynnissä olevan tuloksen.
//
//   forget(entry) / requeue(entries) / settled(operationId)
//     käyttäjän poistama kirjaus pois korista (muuten seuraava lähetys
//     herättäisi sen henkiin); epäonnistuneen poiston palautus; odotus,
//     kunnes kesken oleva lähetys on valmis.

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
    // Skeemavirhe (sarake/taulu puuttuu tai kirjoitus torjuttiin ennen
    // verkkoa) ja tilapäinen palvelinvirhe (503, aikakatkaisu) eivät tee
    // kirjauksesta viallista: se odottaa korissa kuten verkkovirheessä.
    return kind === ERROR_CLASS.NETWORK || kind === ERROR_CLASS.AUTH
      || kind === ERROR_CLASS.UNAVAILABLE || kind === ERROR_CLASS.SCHEMA;
  }

  /**
   * Korissa odottava kirjaus hylätään VAIN tiedon omasta virheestä
   * (22xxx arvo, 23xxx rajoite; 23505 = jo perillä). Kaikki muu jättää
   * sen koriin: käyttäjälle on jo kerrottu, että aika on tallessa.
   */
  function rejectable(error) {
    const cause = (error && error.cause) || error || {};
    const code = String(cause.code || '');
    return /^2[23][0-9A-Z]{3}$/.test(code) && code !== '23505';
  }

  /** Tämän välilehden lähetyksessä olevat operaatiot -> valmistumislupaus. */
  const sending = new Map();
  let flushing = null;

  /**
   * Lisää kirjaus omistajansa koriin. Sama operaatio eri tunnisteella on
   * jo kirjattu (esim. rutiinin esiintymä toisesta näkymästä): se on
   * kaksoiskappale, ei uusi jonotettava kirjaus.
   */
  function queue(entry, owner) {
    if (!owner) return { ok: false };
    const outbox = loadOutbox(owner);
    const same = outbox.find(other => other.operationId === entry.operationId);
    if (same) return same.id === entry.id ? { ok: true } : { ok: true, duplicate: true };
    if (outbox.length >= maxOutbox) return { ok: false };
    return { ok: Boolean(saveOutbox(owner, [...outbox, entry]).ok) };
  }

  /** Poista korista ne, joihin `matches` osuu. Palauttaa poistetut. */
  function unqueue(owner, matches) {
    if (!owner) return [];
    const outbox = loadOutbox(owner);
    const removed = outbox.filter(matches);
    if (removed.length > 0) saveOutbox(owner, outbox.filter(entry => !matches(entry)));
    return removed;
  }

  /** Merkitse operaatio lähetykseen; palauttaa lähetyksen lupauksen. */
  function track(operationId, promise) {
    sending.set(operationId, promise);
    const done = () => { if (sending.get(operationId) === promise) sending.delete(operationId); };
    promise.then(done, done);
    return promise;
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

  async function insertTracked(entry) {
    // Omistaja ENNEN odotusta (F5): vastauksen aikaan kirjautunut voi olla
    // eri käyttäjä, jonka koriin toisen käyttäjän kirjaus ei saa päätyä.
    const owner = userId();
    const persistent = repo.isPersistent();
    let ahead = false;
    if (persistent && owner) {
      const queued = queue(entry, owner);
      if (queued.duplicate) return { ok: true, duplicate: true };
      ahead = queued.ok;
    }
    const mine = other => other.id === entry.id;
    const { result, entry: stored, detached } = await insertOnce(entry);
    if (result.ok) {
      if (ahead) unqueue(owner, mine);
      return detached ? { ok: true, detached: true, entry: stored } : { ok: true };
    }
    if (classifyError(result.error) === ERROR_CLASS.DUPLICATE) {
      if (ahead) unqueue(owner, mine);
      return { ok: true, duplicate: true };
    }
    if (persistent && retryable(result.error)) {
      const queued = ahead ? { ok: true } : queue(entry, owner);
      if (queued.duplicate) return { ok: true, duplicate: true };
      if (queued.ok) return { ok: true, queued: true };
    }
    if (ahead) unqueue(owner, mine);
    return { ok: false, error: result.error };
  }

  async function runFlush() {
      const id = userId();
      if (!id || !repo.isPersistent()) return { sent: 0, left: 0, rejected: [] };
      const started = snapshot();
      const outbox = loadOutbox(id);
      const left = [];
      const rejected = [];
      const detachedEntries = [];
      // Tämän välilehden kirjaus, jonka oma lähetys on yhä kesken: ei
      // lähetetä rinnakkain, eikä pudoteta korista ennen sen vastausta.
      const skipped = [];
      const sentEntries = [];
      let sent = 0;
      for (const [index, entry] of outbox.entries()) {
        // Istunto vaihtui kesken: ei lähetetä toisen käyttäjän nimissä.
        if (!isSameSession(started)) return { sent, left: outbox.length - index, rejected, detached: detachedEntries, aborted: true };
        if (sending.has(entry.operationId)) { skipped.push(entry); continue; }
        const { result, entry: stored, detached } = await track(entry.operationId, insertOnce(entry));
        if (result.ok || classifyError(result.error) === ERROR_CLASS.DUPLICATE) {
          sent += 1;
          if (detached && result.ok) detachedEntries.push(stored);
          if (result.ok) sentEntries.push(stored);
          continue;
        }
        if (!rejectable(result.error)) {
          left.push(...outbox.slice(index));
          break;
        }
        rejected.push({ entry, error: result.error });
      }
      // Kori luetaan UUDELLEEN ennen tallennusta: lähetyksen aikana
      // (awaitien välissä) jonoon lisätty kirjaus ei ollut alkuperäisessä
      // listassa, ja pelkkä saveOutbox(left) olisi pyyhkinyt sen. Samasta
      // syystä korista sillä välin POISTETTU (käyttäjän poistama, tai oma
      // lähetys valmistui) ei palaa takaisin.
      const current = loadOutbox(id);
      const stillQueued = new Set(current.map(entry => entry.operationId));
      const original = new Set(outbox.map(entry => entry.operationId));
      const kept = [...skipped, ...left].filter(entry => stillQueued.has(entry.operationId));
      const added = current.filter(entry => !original.has(entry.operationId));
      saveOutbox(id, [...kept, ...added]);
      return { sent, left: kept.length + added.length, rejected, detached: detachedEntries, sentEntries };
  }

  return {
    insert(entry) {
      // Rekisteröinti tapahtuu synkronisesti: poisto (settled) näkee
      // lähetyksen heti, vaikka verkko ei olisi vielä vastannut.
      return track(entry.operationId, insertTracked(entry));
    },

    /** Lähettämättömät; tämän välilehden kesken olevat lähetykset eivät "odota yhteyttä". */
    pendingCount() {
      const id = userId();
      return id ? loadOutbox(id).filter(entry => !sending.has(entry.operationId)).length : 0;
    },

    /** Korissa yhteyttä odottavien operaatiotunnisteet (näkymän merkintä). */
    pendingOperations() {
      const id = userId();
      return new Set(id ? loadOutbox(id).map(entry => entry.operationId).filter(op => !sending.has(op)) : []);
    },

    /**
     * Yksi lähetys kerrallaan: rinnakkainen kutsu saa käynnissä olevan
     * tuloksen. Käyttäjäkohtainen: edellisen käyttäjän kesken oleva lähetys
     * (joka keskeytyy istunnon vaihtuessa) ei korvaa uuden käyttäjän omaa.
     */
    flush() {
      const owner = userId();
      if (flushing && flushing.owner === owner) return flushing.run;
      const run = runFlush();
      flushing = { owner, run };
      const done = () => { if (flushing && flushing.run === run) flushing = null; };
      run.then(done, done);
      return run;
    },

    /** Poista kirjaus korista (tunniste tai operaatio). Palauttaa poistetut. */
    forget(entry) {
      if (!entry) return [];
      return unqueue(userId(), other => other.id === entry.id
        || (Boolean(entry.operationId) && other.operationId === entry.operationId));
    },

    /** Palauta forget()-kutsun poistamat (poisto kannasta epäonnistui). */
    requeue(entries = []) {
      const owner = userId();
      for (const entry of entries) queue(entry, owner);
    },

    /** Valmistuu, kun operaation kesken oleva lähetys (jos on) on valmis. */
    settled(operationId) {
      const pending = operationId ? sending.get(operationId) : null;
      return pending ? pending.then(() => undefined, () => undefined) : Promise.resolve();
    }
  };
}
