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
