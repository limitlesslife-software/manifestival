// Kirjautuneen käyttäjän identiteetti.
//
// TURVALLISUUDEN YDINKOHTA: jokainen tietokantakutsu hakee käyttäjän
// tunnisteen tästä requireUserId()-funktiolla, joka HEITTÄÄ POIKKEUKSEN,
// jos kirjautunutta käyttäjää ei ole. Näin rajaamaton kysely ei ole
// mahdollinen vahingossa — se kaatuu ennen kuin se lähtee verkkoon.
//
// Tämä on puolustusta syvyydessä. Varsinainen tae on tietokannan
// RLS-politiikka (supabase/migrations/0001_auth_user_scoping.sql).

let currentUser = null;

/** Aseta kirjautunut käyttäjä. Kutsutaan vain autentikointivirrasta. */
export function setUser(user) {
  currentUser = user && user.id ? user : null;
}

/** Tyhjennä istunto. Kutsutaan uloskirjautumisessa. */
export function clearUser() {
  currentUser = null;
}

/** Kirjautunut käyttäjä tai null. */
export function getUser() {
  return currentUser;
}

/** Onko käyttäjä kirjautuneena. */
export function isAuthenticated() {
  return currentUser !== null;
}

/** Kirjautuneen käyttäjän sähköposti tai tyhjä merkkijono. */
export function userEmail() {
  return (currentUser && currentUser.email) || '';
}

/**
 * Kirjautuneen käyttäjän tunniste.
 * @throws {Error} jos käyttäjä ei ole kirjautunut
 */
export function requireUserId() {
  if (!currentUser || !currentUser.id) {
    throw new Error('Ei kirjautunutta käyttäjää');
  }
  return currentUser.id;
}
