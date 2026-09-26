// Kirjautumisvirta.
//
// Käytetään Supabasen omaa salasanapohjaista kirjautumista. Sovellus ei
// käsittele, tiivistä eikä tallenna salasanoja itse.
//
// Virheviestit on käännetty suomeksi eivätkä ne paljasta, oliko sähköposti
// olemassa: väärä salasana ja tuntematon tili antavat saman viestin.

import { getClient } from '../data/client.js';
import { setUser, clearUser, getUser } from '../data/session.js';
import { el, setBusy, singleFlight } from '../ui/dom.js';
import { confirmAction } from '../ui/confirm.js';
import { offline } from './offline.js';
// Suoraan tallennuksesta eikä alignment.js:n kautta: se importoi tämän
// moduulin (currentAccessToken), ja sykli olisi arkkitehtuurivirhe.
import { loadOutbox, loadTimer } from '../data/timerStore.js';
import { saveAuthNote, takeAuthNote } from '../data/deviceData.js';
import { logFailure, LOG_LEVEL } from '../lib/logger.js';

export const MIN_PASSWORD_LENGTH = 8;

let mode = 'signin'; // 'signin' | 'signup'

function clearMessages() {
  const error = el('authError');
  const note = el('authNote');
  error.style.display = 'none';
  error.textContent = '';
  note.style.display = 'none';
  note.textContent = '';
}

function showError(message) {
  const error = el('authError');
  el('authNote').style.display = 'none';
  error.textContent = message;
  error.style.display = 'block';
}

function showNote(message) {
  const note = el('authNote');
  el('authError').style.display = 'none';
  note.textContent = message;
  note.style.display = 'block';
}

function setMode(next) {
  mode = next;
  const isSignin = next === 'signin';

  const signinTab = el('authTabSignin');
  const signupTab = el('authTabSignup');
  signinTab.classList.toggle('active', isSignin);
  signupTab.classList.toggle('active', !isSignin);
  signinTab.setAttribute('aria-selected', String(isSignin));
  signupTab.setAttribute('aria-selected', String(!isSignin));

  el('authPassword').setAttribute('autocomplete', isSignin ? 'current-password' : 'new-password');
  el('authSubmit').textContent = isSignin ? 'Kirjaudu' : 'Luo tili';
  clearMessages();
}

/**
 * Käännä Supabasen virhe suomeksi.
 * Tuntematon virhe palautuu yleisviestinä — palvelimen sisäistä tilaa ei
 * paljasteta käyttäjälle.
 */
export function authErrorMessage(error) {
  const raw = String((error && error.message) || '').toLowerCase();
  if (raw.includes('invalid login credentials')) return 'Sähköposti tai salasana ei täsmää.';
  if (raw.includes('email not confirmed')) return 'Vahvista ensin sähköpostiosoitteesi. Tarkista postilaatikkosi.';
  if (raw.includes('user already registered') || raw.includes('already been registered')) {
    return 'Tällä sähköpostilla on jo tili. Kirjaudu sisään.';
  }
  if (raw.includes('password')) return `Salasana ei kelpaa. Vähintään ${MIN_PASSWORD_LENGTH} merkkiä.`;
  if (raw.includes('rate limit') || raw.includes('too many')) {
    return 'Liian monta yritystä. Odota hetki ja yritä uudelleen.';
  }
  if (raw.includes('failed to fetch') || raw.includes('network')) {
    return 'Verkkoyhteys ei toimi. Tarkista yhteys ja yritä uudelleen.';
  }
  return 'Kirjautuminen ei onnistunut. Yritä uudelleen.';
}

/** Perustarkistus ennen verkkokutsua. */
export function validateCredentials(email, password) {
  if (!email || !email.includes('@')) return 'Anna kelvollinen sähköpostiosoite.';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Salasanan pitää olla vähintään ${MIN_PASSWORD_LENGTH} merkkiä.`;
  }
  return null;
}

const submit = singleFlight(async () => {
  clearMessages();
  const email = el('authEmail').value.trim();
  const password = el('authPassword').value;

  const problem = validateCredentials(email, password);
  if (problem) { showError(problem); return; }

  const button = el('authSubmit');
  setBusy(button, true, 'Hetki…');
  try {
    if (mode === 'signin') {
      const { error } = await getClient().auth.signInWithPassword({ email, password });
      if (error) throw error;
      // Eteneminen tapahtuu onAuthStateChange-kuuntelijassa.
    } else {
      const { data, error } = await getClient().auth.signUp({ email, password });
      if (error) throw error;
      if (data && data.user && !data.session) {
        showNote('Tili luotu. Vahvista sähköpostiosoitteesi ennen kirjautumista.');
        setMode('signin');
      }
    }
  } catch (error) {
    showError(authErrorMessage(error));
  } finally {
    setBusy(button, false);
    el('authSubmit').textContent = mode === 'signin' ? 'Kirjaudu' : 'Luo tili';
  }
});

/**
 * Uloskirjautumisen varoitusteksti, tai null jos varoitettavaa ei ole.
 *
 * Tehtäväjonon lisäksi (F14) lähettämättömät aikakirjaukset ja käynnissä
 * oleva ajastin: nekin jäävät vain tälle laitteelle ja jatkuvat vasta, kun
 * sama käyttäjä kirjautuu takaisin.
 *
 * @param {{tasks?: number, timeEntries?: number, timerRunning?: boolean}} counts
 */
export function signOutWarning({ tasks = 0, timeEntries = 0, timerRunning = false } = {}) {
  const unsent = [];
  if (tasks > 0) unsent.push(tasks + (tasks === 1 ? ' muutos' : ' muutosta'));
  if (timeEntries > 0) unsent.push(timeEntries + (timeEntries === 1 ? ' aikakirjaus' : ' aikakirjausta'));
  if (unsent.length === 0 && !timerRunning) return null;
  const parts = [];
  if (unsent.length > 0) {
    parts.push(`Lähettämättä: ${unsent.join(' ja ')}. Ne säilyvät tällä laitteella ja lähetetään, `
      + 'kun kirjaudut takaisin samalla tilillä.');
  }
  if (timerRunning) {
    parts.push('Ajastin on käynnissä. Se jää tälle laitteelle ja jatkuu, kun kirjaudut takaisin samalla tilillä.');
  }
  return parts.join(' ') + ' Kirjaudutaanko ulos?';
}

const signOut = singleFlight(async () => {
  // Lähettämättömät offline-muutokset eivät katoa uloskirjautumisessa, mutta
  // käyttäjän on tiedettävä, ettei niitä ole vielä lähetetty.
  const { total } = offline.status();
  const user = getUser();
  const counts = {
    tasks: total,
    timeEntries: user && user.id ? loadOutbox(user.id).length : 0,
    timerRunning: Boolean(user && user.id && loadTimer(user.id))
  };
  const message = signOutWarning(counts);
  if (message) {
    const sure = await confirmAction({
      title: counts.tasks > 0 || counts.timeEntries > 0 ? 'Lähettämättömiä muutoksia' : 'Ajastin on käynnissä',
      message,
      confirmLabel: 'Kirjaudu ulos',
      cancelLabel: 'Peruuta'
    });
    if (!sure) return;
  }

  const button = el('signoutBtn');
  setBusy(button, true, 'Kirjaudutaan ulos…');
  try {
    await getClient().auth.signOut();
  } catch (error) {
    logFailure('auth.sign_out_failed', error, LOG_LEVEL.ERROR);
  } finally {
    setBusy(button, false);
  }
});

/**
 * Viesti, joka näytetään seuraavan kerran kun kirjautumisportti avautuu.
 *
 * Tarvitaan tilin poiston jälkeen: uloskirjautuminen avaa portin
 * asynkronisesti ja setMode() tyhjentää viestit, joten viesti ei voi olla
 * suora showNote()-kutsu poiston hetkellä.
 */
let pendingAuthNote = null;

export function queueAuthNote(message) {
  pendingAuthNote = typeof message === 'string' && message ? message : null;
}

/**
 * Säilytä jonossa oleva viesti sivun uudelleenlatauksen yli.
 *
 * Tilin poiston varapolku (accountDeletion.js signOutAndClean) lataa sivun
 * uudelleen, ja lataus hävittää muistissa olevan viestin: käyttäjä ei
 * näkisi, että tili poistettiin, eikä varoitusta kesken jääneestä
 * jälkitarkistuksesta. Viesti tallennetaan laitteelle, ja seuraava
 * showAuthGate() näyttää ja poistaa sen.
 *
 * @returns {boolean} tallentuiko viesti
 */
export function persistQueuedAuthNote() {
  return pendingAuthNote ? saveAuthNote(pendingAuthNote) : false;
}

/** Näytä kirjautumisportti ja piilota sovellus. */
export function showAuthGate() {
  el('app').classList.add('app-hidden');
  el('authGate').classList.add('open');
  el('authPassword').value = '';
  setMode('signin');
  // Tallennettu viesti luetaan (ja poistetaan) aina, jottei se jää
  // odottamaan myöhempää porttia muistissa olevan viestin rinnalle.
  const stored = takeAuthNote();
  const note = pendingAuthNote || stored;
  pendingAuthNote = null;
  if (note) showNote(note);
}

/** Piilota kirjautumisportti ja näytä sovellus. */
export function hideAuthGate() {
  el('authGate').classList.remove('open');
  el('app').classList.remove('app-hidden');
  el('authEmail').value = '';
  el('authPassword').value = '';
}

/**
 * Kytke kirjautumisvirta.
 *
 * @param {object} handlers
 * @param {Function} handlers.onSignedIn  Kutsutaan kun käyttäjä kirjautuu.
 * @param {Function} handlers.onSignedOut Kutsutaan kun käyttäjä kirjautuu ulos.
 * @returns {Promise<object|null>} palautunut istunto tai null
 */
/**
 * Istunnon tilasiirtymät.
 *
 * Erotettu omaksi puhtaaksi funktiokseen, koska tämä on turvallisuuden
 * kannalta ratkaiseva päätös eikä sitä voi testata selaimen
 * onAuthStateChange-tapahtuman kautta.
 */
export const AUTH_TRANSITION = Object.freeze({
  /** Kukaan ei ollut kirjautuneena, nyt on. */
  SIGNED_IN: 'signed_in',
  /** Sama käyttäjä, uusi token. Ei saa ladata dataa uudelleen. */
  TOKEN_REFRESHED: 'token_refreshed',
  /** ERI käyttäjä ilman välissä tapahtunutta uloskirjautumista. */
  USER_SWITCHED: 'user_switched',
  /** Oli kirjautuneena, ei enää. */
  SIGNED_OUT: 'signed_out',
  /** Ei ollut eika ole. */
  IDLE: 'idle'
});

/**
 * Päättele mitä istunnolle tapahtui.
 *
 * PUHDAS FUNKTIO. Ei kosketa tilaan, ei kutsu mitään.
 *
 * @param {object|null} currentUser  Kuka oli kirjautuneena
 * @param {object|null} sessionUser  Kuka on istunnossa nyt
 */
export function resolveAuthTransition(currentUser, sessionUser) {
  const current = currentUser && currentUser.id ? String(currentUser.id) : null;
  const next = sessionUser && sessionUser.id ? String(sessionUser.id) : null;

  if (!next) return current ? AUTH_TRANSITION.SIGNED_OUT : AUTH_TRANSITION.IDLE;
  if (!current) return AUTH_TRANSITION.SIGNED_IN;
  return current === next ? AUTH_TRANSITION.TOKEN_REFRESHED : AUTH_TRANSITION.USER_SWITCHED;
}

export async function initAuth({ onSignedIn, onSignedOut }) {
  el('authTabSignin').addEventListener('click', () => setMode('signin'));
  el('authTabSignup').addEventListener('click', () => setMode('signup'));
  el('authForm').addEventListener('submit', event => { event.preventDefault(); submit(); });
  el('signoutBtn').addEventListener('click', signOut);

  const client = getClient();

  // Reagoi kirjautumiseen, uloskirjautumiseen ja tokenin uusiutumiseen.
  //
  // Tokenin uusiutuminen tapahtuu taustalla tunnin välein. Se EI saa
  // laukaista datan uudelleenlatausta — muuten näkymä välkkyisi ja
  // keskeneräinen lomake nollautuisi kesken päivän.
  client.auth.onAuthStateChange((_event, session) => {
    const transition = resolveAuthTransition(getUser(), session && session.user);

    switch (transition) {
      case AUTH_TRANSITION.SIGNED_IN:
        setUser(session.user);
        onSignedIn(session.user);
        break;

      case AUTH_TRANSITION.USER_SWITCHED:
        // Tili vaihtui ILMAN uloskirjautumista. Ilman tätä haaraa edellisen
        // käyttäjän muistivarastot jäisivät paikoilleen ja uusi käyttäjä
        // näkisi ne. Kierrätetään sama siivouspolku kuin uloskirjautumisessa
        // sen sijaan että kirjoitettaisiin toinen, erikseen unohtuva.
        clearUser();
        onSignedOut();
        setUser(session.user);
        onSignedIn(session.user);
        break;

      case AUTH_TRANSITION.TOKEN_REFRESHED:
        // Tapahtuu taustalla tunnin välein. EI saa laukaista datan
        // uudelleenlatausta — muuten näkymä välkkyisi ja keskeneräinen
        // lomake nollautuisi kesken päivän.
        setUser(session.user);
        break;

      case AUTH_TRANSITION.SIGNED_OUT:
        clearUser();
        onSignedOut();
        break;

      default:
        clearUser();
    }
  });

  try {
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    return data ? data.session : null;
  } catch (error) {
    logFailure('auth.session_restore_failed', error, LOG_LEVEL.ERROR);
    return null;
  }
}

/** Nykyisen istunnon access token, jos sellainen on. */
export async function currentAccessToken() {
  try {
    const { data } = await getClient().auth.getSession();
    return (data && data.session && data.session.access_token) || null;
  } catch {
    return null;
  }
}
