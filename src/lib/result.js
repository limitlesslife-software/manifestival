// Virheiden esittäminen niin, että käyttäjälle näytettävä viesti ja
// diagnostinen tieto pysyvät erillään.
//
// Auditoinnissa todettiin, että jokainen epäonnistunut kantakutsu päätyi vain
// console.error-lokiin: käyttöliittymä näytti onnistumista, vaikka tallennus
// epäonnistui. Tämä moduuli tekee erottelusta pakollisen.
//
// PERIAATE: käyttäjä ei koskaan näe Supabasen sisäistä viestiä, pinojälkeä
// eikä palvelimen konfiguraatiota. Kehittäjä näkee ne konsolissa.

/**
 * Sovellusvirhe, jolla on erikseen käyttäjäviesti ja diagnostiikka.
 */
export class AppError extends Error {
  /**
   * @param {string} userMessage  Suomenkielinen, ymmärrettävä viesti käyttäjälle.
   * @param {object} [options]
   * @param {unknown} [options.cause]  Alkuperäinen virhe (vain diagnostiikkaan).
   * @param {string}  [options.code]   Lyhyt tunniste lokitusta varten.
   */
  constructor(userMessage, options = {}) {
    super(userMessage);
    this.name = 'AppError';
    this.userMessage = userMessage;
    this.code = options.code || 'unknown';
    this.cause = options.cause;
  }

  /** Kehittäjälle tarkoitettu esitys. Ei näytetä käyttäjälle. */
  toDiagnostic() {
    const parts = [`[${this.code}] ${this.userMessage}`];
    if (this.cause) {
      const c = this.cause;
      parts.push(String((c && c.message) || c));
      if (c && c.details) parts.push(String(c.details));
      if (c && c.hint) parts.push(String(c.hint));
    }
    return parts.join(' | ');
  }
}

/** Onnistunut tulos. */
export function ok(value) {
  return { ok: true, value };
}

/** Epäonnistunut tulos. */
export function fail(userMessage, options = {}) {
  return { ok: false, error: new AppError(userMessage, options) };
}


/**
 * Kirjaa virheen konsoliin diagnostisessa muodossa.
 * Erotettu omaksi funktiokseen, jotta lokitus voidaan myöhemmin ohjata muualle.
 */
export function logError(error) {
  if (error instanceof AppError) console.error('Manifestival:', error.toDiagnostic(), error.cause ?? '');
  else console.error('Manifestival:', error);
}

/**
 * Sovelluksen virhekoodit.
 *
 * Tyypitetty koodi on eri asia kuin käyttäjäviesti. Viesti voi muuttua
 * kielen tai sävyn mukaan; koodi on sopimus, jota testit ja kutsuva koodi
 * voivat tarkistaa. Ilman koodia jokainen virheen käsittely päätyisi
 * vertaamaan suomenkielistä merkkijonoa — ja hajoaisi ensimmäisestä
 * sanamuodon korjauksesta.
 */
export const ERROR_CODE = Object.freeze({
  /** Syöte ei kelpaa. Käyttäjä voi korjata sen. */
  VALIDATION_ERROR: 'validation_error',
  /** Kohdetta ei ole olemassa. */
  NOT_FOUND: 'not_found',
  /** Kohteita on useita eikä oikeaa voi valita puolesta. */
  AMBIGUOUS_TARGET: 'ambiguous_target',
  /** Käyttäjällä ei ole oikeutta tähän. */
  PERMISSION_DENIED: 'permission_denied',
  /** Toimintoa ei ole toteutettu tällä alustalla. */
  UNSUPPORTED: 'unsupported',
  /** Tieto on muuttunut samanaikaisesti muualla. */
  CONFLICT: 'conflict',
  /** Kirjautuminen puuttuu tai on vanhentunut. */
  AUTH_REQUIRED: 'auth_required',
  /** Tallennus ei ole käytettävissä — esim. migraatio ajamatta. */
  PERSISTENCE_UNAVAILABLE: 'persistence_unavailable',
  /** Verkkoyhteys puuttuu tai katkesi. */
  NETWORK_ERROR: 'network_error',
  /** Tuntematon. Käytetään vain kun mikään muu ei sovi. */
  UNKNOWN: 'unknown'
});

export const ERROR_CODES = Object.freeze(Object.values(ERROR_CODE));

/** Onko koodi tunnettu? Tuntematon koodi on itsessään vika. */
export function isKnownErrorCode(code) {
  return ERROR_CODES.includes(code);
}

/**
 * Epäonnistunut tulos tyypitetyllä koodilla.
 *
 * Erillinen `fail`-funktiosta, jotta vanhat kutsupaikat toimivat
 * ennallaan ja uudet saavat tyypityksen.
 */
export function failWith(code, userMessage, options = {}) {
  return {
    ok: false,
    error: new AppError(userMessage, {
      ...options,
      code: isKnownErrorCode(code) ? code : ERROR_CODE.UNKNOWN
    })
  };
}
