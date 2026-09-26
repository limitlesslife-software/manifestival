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
//     23505 id    -> { ok: true }                     TÄMÄ kirjaus on jo kannassa
//                                                     (esim. toinen välilehti lähetti
//                                                     sen korista); ei kaksoiskappale
//     23505 muu   -> { ok: true, duplicate: true }   sama operaatio on jo kannassa
//                                                     toisella tunnisteella
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
//     lähettää lähtökorin järjestyksessä. Pysähtyy VAIN tilapäiseen virheeseen
//     (verkko, istunto, skeema, palvelin poissa), koska silloin seuraavatkaan
//     eivät mene perille. Kaksoiskappale (23505) = jo perillä; tiedon oma
//     virhe (22xxx, 23xxx) poistetaan korista (`rejected`-listassa). Muu
//     pysyvä virhe (esim. 42501, 42804, PGRST1xx) jättää kirjauksen koriin,
//     mutta lähetys JATKUU seuraaviin: yksi viallinen ei jumita muita.
//     MAX_FLUSH_ATTEMPTS yrityksen jälkeen kirjaus on "epäonnistunut":
//     se säilyy laitteella, sitä ei enää lähetetä automaattisesti, ja
//     käyttäjä näkee sen (failedEntries) ja voi yrittää uudelleen
//     (retryFailed) tai hylätä sen (forget). Yritykset lasketaan tämän
//     välilehden muistissa; kirjaus itse on laitteen lähtökorissa.
//     Ennen jokaista lähetystä kori luetaan uudelleen: kesken lähetyksen
//     poistettu kirjaus ei palaa. Yksi lähetys kerrallaan: rinnakkainen
//     kutsu saa käynnissä olevan tuloksen.
//
//   forget(entry) / requeue(entries) / settled(operationId)
//     käyttäjän poistama kirjaus pois korista (muuten seuraava lähetys
//     herättäisi sen henkiin); epäonnistuneen poiston palautus; odotus,
//     kunnes kesken oleva lähetys on valmis.

import { classifyError, ERROR_CLASS } from '../domain/offlineQueue.js';
import { fail } from '../lib/result.js';

/** Pysyvästi epäonnistuvan kirjauksen automaattiset yritykset ennen näkyvää "epäonnistui"-tilaa. */
export const MAX_FLUSH_ATTEMPTS = 3;

/**
 * 23505, jonka kohde on PÄÄAVAIN (sama tunniste): rivi on juuri tämä
 * kirjaus. Tunnisteen luo asiakas kerran per kirjaus, joten sama tunniste
 * kannassa tarkoittaa, että kirjaus on jo perillä -- esimerkiksi toisen
 * välilehden lähetys ehti ensin. Operaation uniikkiavain
 * (time_entries_operation_unique) on eri asia: sama operaatio toisella
 * tunnisteella on oikea kaksoiskappale.
 */
export function isSameEntryDuplicate(error) {
  const cause = (error && error.cause) || error || {};
  if (String(cause.code || '') !== '23505') return false;
  const text = `${cause.message || ''} ${cause.details || ''}`;
  return /_pkey\b/.test(text) || /Key \(id\)=/.test(text);
}

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

  const keyOf = (owner, operationId) => `${owner}|${operationId}`;
  /**
   * Tällä välilehdellä poistetut (forget) operaatiot. Kesken oleva lähetys
   * ei lähetä niitä eikä raportoi niitä lähetetyiksi (sentEntries), vaikka
   * sen oma korikopio on luettu ennen poistoa.
   */
  const forgotten = new Set();
  const MAX_FORGOTTEN = 500;
  /** Pysyvän (ei tilapäisen) virheen yritykset: omistaja|operaatio -> määrä. */
  const attempts = new Map();

  const isFailed = (owner, operationId) => (attempts.get(keyOf(owner, operationId)) || 0) >= MAX_FLUSH_ATTEMPTS;

  function noteAttempt(owner, operationId) {
    const key = keyOf(owner, operationId);
    const count = (attempts.get(key) || 0) + 1;
    attempts.set(key, count);
    return count;
  }

  function remember(owner, operationId) {
    forgotten.add(keyOf(owner, operationId));
    if (forgotten.size > MAX_FORGOTTEN) forgotten.delete(forgotten.values().next().value);
  }

  /** Onko operaatio yhä omistajan korissa (toinen välilehti tai poisto on voinut viedä sen)? */
  function stillQueued(owner, operationId) {
    if (forgotten.has(keyOf(owner, operationId))) return false;
    return loadOutbox(owner).some(entry => entry.operationId === operationId);
  }

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
    if (outbox.length >= maxOutbox) return { ok: false, full: true };
    const written = saveOutbox(owner, [...outbox, entry]) || {};
    const saved = Boolean(written.ok);
    // Palautettu (esim. epäonnistunut poisto): lähetys saa taas koskea siihen.
    if (saved) forgotten.delete(keyOf(owner, entry.operationId));
    // persistent:false = laitteen tallennus ei toimi (yksityinen tila,
    // kiintiö): kirjaus on vain tämän istunnon muistissa (ERR-19).
    return { ok: saved, persistent: written.persistent !== false };
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
    let aheadQueued = null;
    if (persistent && owner) {
      const queued = queue(entry, owner);
      if (queued.duplicate) return { ok: true, duplicate: true };
      ahead = queued.ok;
      aheadQueued = queued;
    }
    const mine = other => other.id === entry.id;
    const { result, entry: stored, detached } = await insertOnce(entry);
    if (result.ok) {
      if (ahead) unqueue(owner, mine);
      return detached ? { ok: true, detached: true, entry: stored } : { ok: true };
    }
    if (classifyError(result.error) === ERROR_CLASS.DUPLICATE) {
      if (ahead) unqueue(owner, mine);
      // Sama tunniste on jo kannassa: tämä kirjaus on perillä (toinen
      // välilehti lähetti sen korista kesken tämän pyynnön). Ei poisteta
      // tilasta eikä kerrota "jo kirjattu" -- se olisi väärin.
      if (isSameEntryDuplicate(result.error)) {
        return detached ? { ok: true, detached: true, entry: stored } : { ok: true };
      }
      return { ok: true, duplicate: true };
    }
    if (persistent && retryable(result.error)) {
      const queued = ahead ? aheadQueued : queue(entry, owner);
      if (queued.duplicate) return { ok: true, duplicate: true };
      if (queued.ok) return { ok: true, queued: true, sessionOnly: queued.persistent === false };
      if (queued.full) {
        // Täysi kori: kirjausta EI jonotettu. Oma viesti yleisen
        // "Tallennus ei onnistunut." sijaan -- käyttäjä voi tehdä jotain.
        return {
          ok: false,
          error: fail(`Laitteella on jo ${maxOutbox} lähettämätöntä aikakirjausta, eikä tätä voitu tallentaa. `
            + 'Yhdistä verkkoon, jotta ne lähtevät, ja kirjaa tämä sitten uudelleen.',
          { code: 'timeOutbox.full', cause: result.error }).error
        };
      }
    }
    if (ahead) unqueue(owner, mine);
    return { ok: false, error: result.error };
  }

  async function runFlush() {
    const id = userId();
    if (!id || !repo.isPersistent()) return { sent: 0, left: 0, failed: 0, rejected: [], newlyFailed: [] };
    const started = snapshot();
    const outbox = loadOutbox(id);
    const rejected = [];
    const detachedEntries = [];
    const sentEntries = [];
    const newlyFailed = [];
    /** Tämän kierroksen käsittelemät, korista poistettavat operaatiot. */
    const done = new Set();
    let sent = 0;
    for (const [index, entry] of outbox.entries()) {
      // Istunto vaihtui kesken: ei lähetetä toisen käyttäjän nimissä.
      if (!isSameSession(started)) {
        return { sent, left: outbox.length - index, failed: 0, rejected, detached: detachedEntries, newlyFailed, aborted: true };
      }
      // Tämän välilehden kirjaus, jonka oma lähetys on yhä kesken: ei
      // lähetetä rinnakkain, eikä pudoteta korista ennen sen vastausta.
      if (sending.has(entry.operationId)) continue;
      // Kori luetaan UUDELLEEN ennen jokaista lähetystä: käyttäjä on voinut
      // poistaa kirjauksen sillä aikaa, kun aiempi oli matkalla. Vanhan
      // kopion lähettäminen herättäisi poistetun rivin henkiin.
      if (!stillQueued(id, entry.operationId)) continue;
      // Toistuvasti epäonnistunut: odottaa käyttäjän päätöstä (retryFailed).
      if (isFailed(id, entry.operationId)) continue;

      const { result, entry: stored, detached } = await track(entry.operationId, insertOnce(entry));
      const kind = result.ok ? null : classifyError(result.error, { offline: isOffline() });
      if (result.ok || kind === ERROR_CLASS.DUPLICATE) {
        attempts.delete(keyOf(id, entry.operationId));
        done.add(entry.operationId);
        sent += 1;
        // Poistettu lähetyksen aikana: poistaja (deleteTimeEntry) odottaa
        // tämän lähetyksen ja poistaa rivin kannasta. Ei muisteta tilaan.
        if (forgotten.has(keyOf(id, entry.operationId))) continue;
        if (detached && result.ok) detachedEntries.push(stored);
        if (result.ok || isSameEntryDuplicate(result.error)) sentEntries.push(stored);
        continue;
      }
      // Tilapäinen: seuraavatkaan eivät mene nyt perille. Kori säilyy.
      if (retryable(result.error)) break;
      if (rejectable(result.error)) {
        attempts.delete(keyOf(id, entry.operationId));
        done.add(entry.operationId);
        rejected.push({ entry, error: result.error });
        continue;
      }
      // Pysyvä, tunnistamaton virhe: kirjaus jää laitteelle, ja muut jatkavat.
      if (noteAttempt(id, entry.operationId) === MAX_FLUSH_ATTEMPTS) newlyFailed.push({ entry, error: result.error });
    }
    // Kori luetaan UUDELLEEN ennen tallennusta: lähetyksen aikana
    // (awaitien välissä) jonoon lisätty kirjaus ei ollut alkuperäisessä
    // listassa, ja vanhan listan tallennus olisi pyyhkinyt sen. Samasta
    // syystä korista sillä välin POISTETTU (käyttäjän poistama, tai oma
    // lähetys valmistui) ei palaa takaisin. Vain tämän kierroksen
    // lähettämät ja hylkäämät poistetaan.
    const current = loadOutbox(id);
    const remaining = current.filter(entry => !done.has(entry.operationId));
    if (remaining.length !== current.length) saveOutbox(id, remaining);
    const failed = remaining.filter(entry => isFailed(id, entry.operationId)).length;
    return {
      sent, left: remaining.length - failed, failed, rejected, detached: detachedEntries, sentEntries, newlyFailed
    };
  }

  return {
    insert(entry) {
      // Rekisteröinti tapahtuu synkronisesti: poisto (settled) näkee
      // lähetyksen heti, vaikka verkko ei olisi vielä vastannut.
      return track(entry.operationId, insertTracked(entry));
    },

    /**
     * Lähettämättömät; tämän välilehden kesken olevat lähetykset eivät
     * "odota yhteyttä", eivätkä epäonnistuneet (ne odottavat käyttäjää).
     */
    pendingCount() {
      const id = userId();
      return id ? loadOutbox(id)
        .filter(entry => !sending.has(entry.operationId) && !isFailed(id, entry.operationId)).length : 0;
    },

    /** Korissa yhteyttä odottavien operaatiotunnisteet (näkymän merkintä). */
    pendingOperations() {
      const id = userId();
      return new Set(id ? loadOutbox(id).map(entry => entry.operationId)
        .filter(op => !sending.has(op) && !isFailed(id, op)) : []);
    },

    /**
     * Kirjaukset, joiden lähetys on epäonnistunut toistuvasti pysyvään
     * virheeseen. Ne ovat yhä laitteella; käyttäjä päättää (uudelleen tai hylkää).
     */
    failedEntries() {
      const id = userId();
      return id ? loadOutbox(id).filter(entry => isFailed(id, entry.operationId)) : [];
    },

    /** "Yritä uudelleen": epäonnistuneet takaisin lähetykseen. Palauttaa määrän. */
    retryFailed() {
      const id = userId();
      if (!id) return 0;
      let count = 0;
      for (const entry of loadOutbox(id)) {
        if (!isFailed(id, entry.operationId)) continue;
        attempts.delete(keyOf(id, entry.operationId));
        count += 1;
      }
      return count;
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

    /**
     * Poista kirjaus korista (tunniste tai operaatio). Palauttaa poistetut.
     * Kesken oleva lähetys ei enää lähetä eikä muista sitä (F6).
     */
    forget(entry) {
      if (!entry) return [];
      const owner = userId();
      const removed = unqueue(owner, other => other.id === entry.id
        || (Boolean(entry.operationId) && other.operationId === entry.operationId));
      if (owner) {
        for (const operationId of new Set([entry.operationId, ...removed.map(other => other.operationId)])) {
          if (!operationId) continue;
          remember(owner, operationId);
          attempts.delete(keyOf(owner, operationId));
        }
      }
      return removed;
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
