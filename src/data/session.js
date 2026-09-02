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

// ---------------------------------------------------------------------
// ISTUNNON SUKUPOLVI
// ---------------------------------------------------------------------
// Pelkkä käyttäjätunnisteen vertailu ei riitä pitkien asynkronisten
// operaatioiden suojaksi. Vertailu läpäisee ketjun
//
//     A kirjautuu ulos  ->  A kirjautuu takaisin sisään
//
// koska tunniste on lopussa sama kuin alussa. Vanhentunut vastaus
// kirjoittaisi silloin vanhan tilannekuvan tuoreemman päälle.
//
// Sukupolvi kasvaa JOKAISESSA identiteettisiirtymässä. Asynkroninen
// operaatio ottaa lähtiessään talteen sekä tunnisteen että sukupolven, ja
// tulos hyväksytään vain jos MOLEMMAT täsmäävät.
//
// Tokenin uusiutuminen EI ole identiteettisiirtymä: setUser samalla
// tunnisteella ei kasvata sukupolvea. Muuten taustalla tunnin välein
// tapahtuva uusiutuminen hylkäisi juuri käynnissä olevan latauksen.
let generation = 0;

/** Aseta kirjautunut käyttäjä. Kutsutaan vain autentikointivirrasta. */
export function setUser(user) {
  const next = user && user.id ? user : null;
  const changed = (currentUser && currentUser.id ? String(currentUser.id) : null)
    !== (next && next.id ? String(next.id) : null);

  currentUser = next;
  if (changed) generation += 1;
}

/** Tyhjennä istunto. Kutsutaan uloskirjautumisessa. */
export function clearUser() {
  if (currentUser !== null) generation += 1;
  currentUser = null;
}

/**
 * Nykyisen istunnon tunniste asynkronisen operaation talteenottoa varten.
 *
 * Otetaan talteen ENNEN awaitia ja tarkistetaan sen JÄLKEEN.
 */
export function sessionSnapshot() {
  return Object.freeze({
    userId: currentUser && currentUser.id ? String(currentUser.id) : null,
    generation
  });
}

/**
 * Onko istunto yhä sama kuin tilannekuvaa otettaessa?
 *
 * Palauttaa false myös silloin, kun käyttäjä on sama mutta välissä on
 * käyty uloskirjautumassa — juuri se tapaus, jonka pelkkä tunnisteen
 * vertailu päästäisi läpi.
 */
export function isSameSession(snapshot) {
  if (!snapshot) return false;
  const now = sessionSnapshot();
  return snapshot.userId === now.userId && snapshot.generation === now.generation;
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
