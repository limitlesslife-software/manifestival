// Laitteen aikavyöhyke sovelluskerrokselle.
//
// YKSI AIKAMALLI (src/domain/wallClock.js): domain ei lue kelloa eikä
// vyöhykettä, vaan kutsuja antaa funktion offsetMinutesFn(epochMs) ->
// minuutteja UTC:stä itään. Tämä moduuli on se kutsuja: lähtö, herätys,
// uni ja muistutukset saavat kaikki SAMAN laitteen vyöhykkeen, eikä
// yhdenkään maan sääntöä kovakoodata.
//
// Laite, joka vaihtaa vyöhykettä (matka), saa uuden vyöhykkeen seuraavassa
// laskennassa: funktio lukee sen joka kutsulla.

/** Laitteen ero UTC:stä minuutteina hetkellä `epochMs` (Helsinki: 120/180). */
export function deviceOffsetMinutes(epochMs) {
  const date = new Date(epochMs);
  const offset = date.getTimezoneOffset();
  return Number.isFinite(offset) ? -offset : 0;
}

/** Laitteen IANA-vyöhyke (esim. 'Europe/Helsinki') tai null, jos ympäristö ei kerro sitä. */
export function deviceTimeZone() {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone ? zone : null;
  } catch {
    return null;
  }
}
