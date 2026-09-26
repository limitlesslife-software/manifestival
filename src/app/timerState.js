// Ajastimen tila: missä ajastin on ja kumpi kopio voittaa.
//
// Kaksi paikkaa, yksi sääntö:
//
//   kanta (running_timers, 0013)  auktoritatiivinen, kun portti on auki
//                                 ja lataus onnistui; YKSI käyttäjää kohti
//   laite (timerStore)            varmistus uudelleenlatausta ja
//                                 verkkokatkoa varten; ainoa paikka ennen
//                                 migraatiota; välilehtien yhteinen kopio
//
// KUMPI VOITTAA (portti auki, lista onnistui ja on tuore):
//
//   sama ajastin      laite vain, jos siinä on kantaan ehtimätön muutos
//                     (dirty, esim. offline-tauko) tai pysäytys on kesken;
//                     muuten kanta (toisella laitteella tehty tauko näkyy)
//   kannassa ei mitään
//                     laite oli kannassa (synced) -> se pysäytettiin
//                     muualla, pudotetaan; ei koskaan ehtinyt kantaan ->
//                     pidetään ja lisätään kantaan uudelleen
//   eri ajastin       laite oli kannassa -> kanta; laite ei koskaan
//                     ehtinyt kantaan -> kanta käyntiin ja laitteen ajastin
//                     jää odottamaan käyttäjän päätöstä (kirjaa/hylkää);
//                     jos odottavia on jo enimmäismäärä, laitteen ajastin
//                     jatkuu (ei pudoteta) ja käyttäjälle kerrotaan
//
// VANHENTUNUT LISTA: lataus, joka alkoi ennen tämän laitteen viimeisintä
// ajastinmuutosta (timerMutationSeq), ei saa herättää pysäytettyä
// ajastinta eikä kumota taukoa. Sellainen lista ei muuta tilaa.
//
// KANNAN KIRJOITUKSET JONOSSA: lisäys, päivitys ja poisto lähtevät
// järjestyksessä (syncTimerToRepo). Heti käynnistyksen jälkeinen poisto ei
// voi ohittaa lisäystä, jolloin rivi jäisi kantaan ja ajastin palaisi.
// Jonossa odottanut työ lähtee vain samassa istunnossa, jossa se jonotettiin:
// kanta liittää rivin kirjautuneeseen käyttäjään (running_timers.user_id =
// auth.uid()), joten käyttäjän vaihduttua A:n ajastin menisi B:n tilille.
//
// KANNASSA (synced) VAIN LISÄYKSEN JÄLKEEN: nollaan riviin osuva UPDATE
// onnistuu ilman virhettä, joten onnistunut päivitys ei todista, että rivi
// on kannassa. Muuten offline-käynnistetty ajastin merkittäisiin kannassa
// olevaksi, ja seuraava tyhjä lista pudottaisi sen "muualla pysäytettynä".
//
// Tämä moduuli ei tuo actions.js:ää eikä alignment.js:ää, jotta lataus
// (actions.loadUserData) voi kutsua sitä ilman kehäriippuvuutta.

import { getState, setRunningTimerInState } from './state.js';
import { runningTimersRepo } from '../data/collectionsRepo.js';
import {
  loadTimer, loadTimerRecord, saveTimer, loadTombstones, addTombstone, clearTombstone,
  loadPendingTimers, savePendingTimers, timerKey, pendingTimersKey, MAX_PENDING_TIMERS
} from '../data/timerStore.js';
import { getUser, sessionSnapshot, isSameSession } from '../data/session.js';
import { normalizeTimer, validateTimer, hasStopPlan } from '../domain/timer.js';
import { classifyError, ERROR_CLASS } from '../domain/offlineQueue.js';
import { notify } from '../ui/toast.js';

function userId() {
  const user = getUser();
  return user && user.id ? String(user.id) : null;
}

/** Kentät, joita tauko ja jatko muuttavat. */
const MUTABLE_FIELDS = ['startedAt', 'pausedAt', 'pausedSeconds'];

function sameContent(a, b) {
  return MUTABLE_FIELDS.every(key => a[key] === b[key]);
}

/** Ajastimen repositorio; testit voivat korvata sen (timeTracking.setTimerRepoForTests). */
let repo = runningTimersRepo;

/** Kannan kirjoitusten jono: seuraava lähtee vasta edellisen jälkeen. */
let timerSync = Promise.resolve();

/** Poistot (tunniste -> määrä), jotka ovat jonossa tai matkalla: niiden hautakiveä ei pureta. */
const pendingRemovals = new Map();

/** Jonon sukupolvi: nollauksen jälkeen edellisen jonon työt eivät koske uuteen kirjanpitoon. */
let queueEpoch = 0;

/**
 * Ajastinmuutosten järjestysnumero. Kasvaa jokaisessa tämän laitteen
 * ajastinmuutoksessa (käynnistys, tauko, pysäytys, kannan kuittaus,
 * hautakivi, toisen välilehden muutos).
 */
let mutationSeq = 0;

function bump() {
  mutationSeq += 1;
}

export function timerMutationSeq() {
  return mutationSeq;
}

export function setTimerStateRepo(replacement) {
  repo = replacement || runningTimersRepo;
  // Uusi repositorio = uusi jono: edellisen testin jumiin jäänyt pyyntö
  // ei saa pysäyttää seuraavan kirjoituksia.
  resetTimerSync();
}

/**
 * Uloskirjautuminen ja tilinvaihto (main.js onSignedOut): jono ja
 * poistojen kirjanpito alusta. Edellisen istunnon jonossa odottavat työt
 * ohitetaan joka tapauksessa (send), mutta jumiin jäänyt pyyntö ei saa
 * pidätellä seuraavan käyttäjän kirjoituksia. Laitteelle jäävät liput ja
 * hautakivet hoitavat uusinnan, kun sama käyttäjä palaa.
 */
export function resetTimerSync() {
  queueEpoch += 1;
  timerSync = Promise.resolve();
  pendingRemovals.clear();
}

/** Nykyinen ajastin tai null. */
export function currentTimer() {
  return getState().runningTimers[0] || null;
}

function isUniqueViolation(error) {
  return classifyError(error) === ERROR_CLASS.DUPLICATE;
}

// ------------------------------------------------------------ kanta

async function send(target, action, timer, owner, session) {
  // Käyttäjä vaihtui (tai kävi uloskirjautuneena) sillä välin, kun työ
  // odotti jonossa: pyyntö lähtisi uuden istunnon tokenilla, ja kanta
  // kirjoittaisi A:n ajastimen (muistiinpanoineen) B:n tilille. Ohitetaan
  // eikä kuitata: laitteen liput ja hautakivet uusivat työn, kun A palaa.
  if (!isSameSession(session) || userId() !== owner) {
    return { ok: false, skipped: true, sessionChanged: true };
  }
  if (action === 'reinsert') {
    // Jonossa ehtinyt odottaa: jos alkuperäinen lisäys meni sillä välin
    // perille (tai ajastin pysäytettiin), uusintaa ei tarvita.
    const record = owner ? loadTimerRecord(owner) : null;
    if (!record || record.timer.id !== timer.id || record.synced) return { ok: true, skipped: true };
    action = 'insert';
  }
  let result;
  try {
    result = action === 'insert' ? await target.insert(timer)
      : action === 'update' ? await target.update(timer)
        : await target.remove(timer.id);
  } catch (error) {
    result = { ok: false, error };
  }
  result = result || { ok: false };
  if (result.ok && action !== 'remove' && owner) markTimerSynced(owner, timer, { inserted: action === 'insert' });
  return result;
}

function enqueue(action, timer, owner) {
  if (!repo.isPersistent()) return Promise.resolve({ ok: true });
  const target = repo;
  const epoch = queueEpoch;
  // Istunto talteen jonotettaessa: send ohittaa työn, jos se on vaihtunut.
  const session = sessionSnapshot();
  const removal = action === 'remove' ? String(timer.id) : null;
  if (removal) pendingRemovals.set(removal, (pendingRemovals.get(removal) || 0) + 1);
  const run = timerSync.then(() => send(target, action, timer, owner, session));
  timerSync = run.catch(() => {});
  if (!removal) return run;
  return run.finally(() => {
    if (epoch !== queueEpoch) return;
    const left = (pendingRemovals.get(removal) || 1) - 1;
    if (left > 0) pendingRemovals.set(removal, left);
    else pendingRemovals.delete(removal);
  });
}

/**
 * Lähetä ajastimen muutos kantaan, jonossa edellisten jälkeen.
 *
 * `owner` otetaan talteen ENNEN awaitia: jos käyttäjä vaihtuu kesken,
 * kuittaus ja hautakivi menevät ajastimen omistajalle, eivät seuraavalle.
 */
export function syncTimerToRepo(action, timer, { owner = userId() } = {}) {
  if (!repo.isPersistent()) return Promise.resolve({ ok: true });
  // Hautakivi ENNEN poistoa (ei vasta epäonnistumisen jälkeen): kesken
  // poiston palaava lataus ei herätä pysäytettyä ajastinta henkiin.
  if (action === 'remove' && owner) buryTimer(owner, timer.id);
  return enqueue(action, timer, owner);
}

/**
 * Kanta kuittasi lisäyksen tai päivityksen.
 *
 * Vain lisäys (myös uusinta) merkitsee ajastimen kannassa olevaksi.
 * Päivitys säilyttää aiemman lipun: nollaan riviin osuva UPDATE onnistuu
 * sekin (offline-käynnistys, jonka lisäys ei mennyt perille), eikä se saa
 * tehdä ajastimesta "kannassa ollutta", jonka tyhjä lista pudottaisi.
 */
function markTimerSynced(owner, sent, { inserted = false } = {}) {
  const record = loadTimerRecord(owner);
  if (!record || record.timer.id !== sent.id) return;
  // Kuittaus koskee lähetettyä versiota: jos laitteella on sen jälkeen
  // tehty muutos (tauko matkalla), se on yhä kannasta puuttuva.
  saveTimer(owner, record.timer, {
    synced: inserted || record.synced,
    dirty: record.dirty && !sameContent(record.timer, sent)
  });
  bump();
}

function buryTimer(owner, timerId) {
  addTombstone(owner, timerId);
  bump();
}

// ------------------------------------------------------------ lataus

/**
 * Latauksen tulos: kannasta (tai muistivarastosta) saatu lista.
 *
 * @param {Array} list onnistuneen haun rivit
 * @param {object} [options]
 * @param {number|null} [options.sinceSeq] timerMutationSeq() latauksen
 *   alkaessa; jos se on muuttunut, lista on vanhentunut eikä muuta tilaa
 */
export function adoptLoadedTimers(list = [], { sinceSeq = null } = {}) {
  const id = userId();
  const persistent = repo.isPersistent();
  const fromRepo = (list || []).map(normalizeTimer).filter(timer => validateTimer(timer).valid);
  const tombstones = new Set(id ? loadTombstones(id) : []);
  const stale = sinceSeq !== null && sinceSeq !== undefined && sinceSeq !== mutationSeq;

  // Tällä laitteella pysäytetty/hylätty, mutta rivi on yhä kannassa:
  // EI herätetä henkiin. Poisto yritetään uudelleen taustalla.
  for (const buried of fromRepo.filter(timer => tombstones.has(timer.id))) {
    enqueue('remove', buried, id).catch(() => { /* yritetään seuraavalla latauksella */ });
  }
  // Hautakivi puretaan vasta, kun TUORE lista vahvistaa rivin puuttuvan
  // eikä poisto ole enää matkalla. Onnistunut poisto ei yksin riitä:
  // ennen sitä alkanut lataus voi yhä palauttaa rivin.
  if (persistent && id && !stale) {
    const present = new Set(fromRepo.map(timer => timer.id));
    for (const buriedId of tombstones) {
      if (!present.has(buriedId) && !pendingRemovals.has(buriedId)) clearTombstone(id, buriedId);
    }
  }
  if (stale) return currentTimer();

  const live = fromRepo.filter(timer => !tombstones.has(timer.id));
  const record = id ? loadTimerRecord(id) : null;
  if (record && tombstones.has(record.timer.id)) {
    // Laitteelle jäänyt kopio jo pysäytetystä ajastimesta.
    saveTimer(id, null, { expectId: record.timer.id });
  }
  const local = record && !tombstones.has(record.timer.id) ? record.timer : null;

  if (!persistent || !id) {
    // Portti kiinni: laitteen kopio on ajastimen ainoa pysyvä paikka.
    const timer = local || live[0] || null;
    if (timer && !local && id) saveTimer(id, timer);
    setRunningTimerInState(timer);
    return currentTimer();
  }

  // Käyttöönotto kirjoittaa laitteen kopion: sitä ennen alkanut, yhä kesken
  // oleva lataus on vanhentunut eikä saa kääntää tilaa takaisin.
  const remote = live[0] || null;
  const keep = (timer, flags) => {
    saveTimer(id, timer, flags);
    bump();
    setRunningTimerInState(timer);
    return currentTimer();
  };
  const drop = expectId => {
    if (expectId) saveTimer(id, null, { expectId });
    bump();
    setRunningTimerInState(null);
    return null;
  };

  if (!local) return remote ? keep(remote, { synced: true, dirty: false }) : drop(null);

  if (remote && remote.id === local.id) {
    if (record.dirty || hasStopPlan(local)) {
      // Laitteella on kantaan ehtimätön muutos (offline-tauko) tai pysäytys
      // on kesken: laite voittaa, ja muutos lähetetään uudelleen.
      const differs = !sameContent(local, remote);
      keep(local, { synced: true, dirty: record.dirty && differs });
      if (record.dirty && differs) enqueue('update', local, id).catch(() => { /* seuraavalla kerralla */ });
      return currentTimer();
    }
    // Laitteen kopio on ajan tasalla: kanta voittaa (tauko toiselta laitteelta).
    return keep(remote, { synced: true, dirty: false });
  }

  if (!remote) {
    if (record.synced && !hasStopPlan(local)) {
      // Ajastin oli kannassa, mutta ei enää: se pysäytettiin tai hylättiin
      // toisella laitteella. Laitteen kopio ei herätä sitä henkiin.
      return drop(local.id);
    }
    // Ei koskaan ehtinyt kantaan (offline-käynnistys) tai pysäytys on
    // kesken: laite pitää ajastimen. Kanta saa sen uudelleen, jotta yksi
    // ajastin käyttäjää kohti pätee myös muille laitteille.
    keep(local, { synced: record.synced, dirty: record.dirty });
    if (!record.synced && !hasStopPlan(local)) reinsert(local, id);
    return currentTimer();
  }

  if (record.synced && !hasStopPlan(local)) {
    // Laitteen ajastin oli kannassa, mutta tilalla on nyt toinen: se
    // pysäytettiin toisella laitteella ja sieltä käynnistettiin uusi.
    return keep(remote, { synced: true, dirty: false });
  }
  // Laitteen ajastin ei koskaan ehtinyt kantaan, ja toisella laitteella
  // on nyt oma: kanta käyntiin, eikä tämän laitteen aikaa pudoteta hiljaa.
  if (holdAsPending(id, local)) return keep(remote, { synced: true, dirty: false });
  // Odottavia on jo enimmäismäärä: tämän laitteen ajastin jatkuu täällä
  // (käyttäjälle kerrottiin), eikä mitään pudoteta. Kannan ajastin tulee
  // näkyviin, kun odottavat on kirjattu tai hylätty.
  return keep(local, { synced: record.synced, dirty: record.dirty });
}

/** Laitteella käynnistetty ajastin kantaan uudelleen (offline-käynnistys). */
function reinsert(timer, owner) {
  enqueue('reinsert', timer, owner).then(result => {
    if (!result || result.ok || !isUniqueViolation(result.error)) return null;
    // 23505: kannassa on jo rivi — toisen laitteen ajastin tai tämän laitteen
    // oma, jonka lisäyksen vastaus katosi. Tuore lista ratkaisee: sama
    // tunniste otetaan käyttöön, eri ajastin käyntiin ja tämän laitteen
    // ajastin jää odottamaan käyttäjän päätöstä (ei katoa hiljaa).
    return userId() === owner ? reloadRunningTimers() : null;
  }).catch(() => { /* yritetään seuraavalla latauksella */ });
}

/**
 * Hae kannan ajastin heti (esim. kun käynnistys törmäsi toisen laitteen
 * ajastimeen). Vanhentunut vastaus ohitetaan kuten latauksessa.
 */
export async function reloadRunningTimers() {
  if (!repo.isPersistent() || typeof repo.list !== 'function') return currentTimer();
  const since = mutationSeq;
  const session = sessionSnapshot();
  const result = await repo.list();
  if (!result || !result.ok || !isSameSession(session)) return currentTimer();
  return adoptLoadedTimers(result.value, { sinceSeq: since });
}

/** Palauta laitteen ajastin tilaan (käynnistys ennen latausta). */
export function restoreLocalTimer() {
  const id = userId();
  const local = id ? loadTimer(id) : null;
  if (local) setRunningTimerInState(local);
  return local;
}

// ---------------------------------------------------- laitteen kopio

/**
 * Tallenna ajastin laitteelle ja tilaan. Kanta päivitetään erikseen
 * (syncTimerToRepo), koska sen epäonnistuminen ei saa hukata ajastinta.
 *
 * Liput: jos niitä ei anneta, saman ajastimen liput säilyvät; uusi
 * ajastin on kantaan ehtimätön. Tila päivitetään vain, jos omistaja on yhä
 * kirjautuneena (kesken vaihtunut käyttäjä ei näe edellisen ajastinta).
 *
 * persistTimerLocally(null) tyhjentää VAIN nykyisen ajastimen
 * (clearTimerLocally); laitteelta ei pyyhitä toisen välilehden ajastinta.
 */
export function persistTimerLocally(timer, { owner = userId(), synced, dirty } = {}) {
  if (!timer) {
    const current = currentTimer();
    return current ? clearTimerLocally(current.id, { owner }) : { ok: true, persistent: false };
  }
  const previous = owner ? loadTimerRecord(owner) : null;
  const same = Boolean(previous) && previous.timer.id === String(timer.id);
  const saved = owner
    ? saveTimer(owner, timer, {
      synced: synced ?? (same ? previous.synced : false),
      dirty: dirty ?? (same ? previous.dirty : true)
    })
    : { ok: false, persistent: false };
  bump();
  if (userId() === owner) setRunningTimerInState(timer);
  return saved;
}

/**
 * Poista ajastin tilasta ja laitteelta — vain jos se on juuri tämä
 * ajastin. Toisen välilehden (tai toisen käyttäjän) ajastin säilyy.
 */
export function clearTimerLocally(timerId, { owner = userId() } = {}) {
  const saved = owner ? saveTimer(owner, null, { expectId: timerId }) : { ok: false, persistent: false };
  bump();
  const current = currentTimer();
  if (userId() === owner && current && current.id === String(timerId)) setRunningTimerInState(null);
  return saved;
}

/**
 * Tallenna pysäytyssuunnitelma (ja jo kirjatut osat) laitteelle — vain jos
 * laitteella on yhä sama ajastin. Toisen välilehden jo siivoamaa ajastinta
 * ei kirjoiteta takaisin.
 */
export function recordStopPlan(timer, { owner = userId() } = {}) {
  if (owner && timerKey(owner)) {
    const record = loadTimerRecord(owner);
    if (!record || record.timer.id !== timer.id) return { ok: false, gone: true };
    saveTimer(owner, timer, { synced: record.synced, dirty: record.dirty });
  }
  bump();
  const current = currentTimer();
  if (userId() === owner && current && current.id === timer.id) setRunningTimerInState(timer);
  return { ok: true };
}

/**
 * Onko laitteella yhä tämä ajastin? Jos ei, toinen välilehti on jo
 * pysäyttänyt tai vaihtanut sen (laite on välilehtien yhteinen kopio).
 */
export function deviceHoldsTimer(timer, owner = userId()) {
  if (!timer || !owner || !timerKey(owner)) return true;
  const device = loadTimer(owner);
  return Boolean(device) && device.id === timer.id;
}

/** Laitteen ajastin (välilehtien yhteinen totuus), tai tilan ajastin ilman käyttäjää. */
export function deviceTimer(owner = userId()) {
  if (!owner || !timerKey(owner)) return currentTimer();
  return loadTimer(owner);
}

/** Tila laitteen kopion mukaiseksi (toinen välilehti muutti sitä). */
export function syncStateFromDevice(owner = userId()) {
  if (!owner || userId() !== owner || !timerKey(owner)) return currentTimer();
  setRunningTimerInState(loadTimer(owner));
  return currentTimer();
}

// ------------------------------------------- päätöstä odottavat ajastimet

/** Käyttäjän päätöstä odottavat (kirjaamattomat) ajastimet. */
export function pendingTimers(owner = userId()) {
  return owner ? loadPendingTimers(owner) : [];
}

/** Näkymä piirtyy uudelleen (odottavat ajastimet eivät ole tilassa). */
function refreshTimerView(owner) {
  if (userId() === owner) setRunningTimerInState(currentTimer());
}

/**
 * Jätä laitteen ajastin odottamaan käyttäjän päätöstä. Palauttaa false, jos
 * sitä ei voitu jättää (odottavia on jo enimmäismäärä): silloin mitään ei
 * pudoteta, vaan kutsuja pitää ajastimen käynnissä laitteella.
 */
function holdAsPending(owner, timer) {
  if (!owner) return false;
  const others = loadPendingTimers(owner).filter(other => other.id !== timer.id);
  if (others.length >= MAX_PENDING_TIMERS) {
    notify(`Tällä laitteella on jo ${MAX_PENDING_TIMERS} kirjaamatonta ajastusta. Tämän laitteen ajastin jatkuu täällä; kirjaa tai hylkää odottavat ajastinpalkista, niin toisen laitteen ajastin tulee näkyviin.`, 10000);
    return false;
  }
  if (!savePendingTimers(owner, [...others, timer]).ok) return false;
  bump();
  refreshTimerView(owner);
  notify('Tälle laitteelle jäi kirjaamaton ajastus, kun toisella laitteella oli jo ajastin. Tarkista se ajastinpalkista.', 8000);
  return true;
}

/** Päivitä odottavan ajastimen pysäytyssuunnitelma (vain jos se on yhä odottamassa). */
export function updatePendingTimer(timer, { owner = userId() } = {}) {
  if (!owner) return { ok: false };
  const list = loadPendingTimers(owner);
  if (!list.some(other => other.id === timer.id)) return { ok: false, gone: true };
  savePendingTimers(owner, list.map(other => (other.id === timer.id ? timer : other)));
  bump();
  refreshTimerView(owner);
  return { ok: true };
}

export function removePendingTimer(timerId, { owner = userId() } = {}) {
  if (!owner) return { ok: false };
  const list = loadPendingTimers(owner);
  savePendingTimers(owner, list.filter(other => other.id !== String(timerId)));
  bump();
  refreshTimerView(owner);
  return { ok: true };
}

// --------------------------------------------------------- välilehdet

let storageTarget = null;
let storageListener = null;

/**
 * Välilehtien synkronointi: toisen välilehden käynnistys, tauko tai
 * pysäytys näkyy tässäkin heti (storage-tapahtuma). Kutsutaan
 * kirjautuessa; uloskirjautuminen poistaa kuuntelijan.
 */
export function initTimerCrossTabSync(target = typeof window !== 'undefined' ? window : null) {
  stopTimerCrossTabSync();
  const owner = userId();
  if (!owner || !target || typeof target.addEventListener !== 'function') return false;
  const keys = new Set([timerKey(owner), pendingTimersKey(owner)]);
  storageListener = event => {
    // key === null: toinen välilehti tyhjensi koko tallennuksen.
    if (!event || (event.key !== null && !keys.has(event.key))) return;
    if (userId() !== owner) return;
    bump();
    setRunningTimerInState(loadTimer(owner));
  };
  storageTarget = target;
  target.addEventListener('storage', storageListener);
  return true;
}

export function stopTimerCrossTabSync() {
  if (storageTarget && storageListener && typeof storageTarget.removeEventListener === 'function') {
    storageTarget.removeEventListener('storage', storageListener);
  }
  storageTarget = null;
  storageListener = null;
}
