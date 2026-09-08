// Staattinen SQL-analyysi varmistustiedostoille.
//
// Varmistuksia ei voi ajaa testeissä: ne puhuvat tuotannon kannalle,
// eikä testiympäristössä ole PostgreSQL:ää. Siksi ne todennetaan
// lukemalla — ja jotta lukeminen olisi jotain muuta kuin silmäilyä,
// se tehdään koneellisesti ja samat säännöt mutaatiotestataan.
//
// Mitä tämä osaa todistaa:
//   - tiedosto on VAIN LUKEVA (ei kirjoittavia avainsanoja)
//   - tiedosto on YKSI lause (tasan yksi puolipiste, viimeisenä)
//   - sulut menevät tasan
//   - tarkistusnumerot ovat katkeamaton sarja alkaen ykkösestä
//   - jokainen tarkistus on union all -ketjussa
//
// Mitä tämä EI voi todistaa: että SQL on syntaktisesti kelvollista
// PostgreSQL:lle. Sen todistaa vasta ajo, ja se tehdään SQL-editorissa.

const NEWLINE = String.fromCharCode(10);

/**
 * Kirjoittavat avainsanat.
 *
 * `set role` on mukana, koska sillä voisi vaihtaa istunnon roolin ja
 * ohittaa juuri sen roolirajoitteen, jonka takia varmistus jaettiin
 * kahtia. `merge` on mukana, koska se on kirjoitus jota ei ensilukemalta
 * miellä kirjoitukseksi.
 */
export const WRITING_KEYWORDS = Object.freeze([
  'insert into', 'update ', 'delete from', 'truncate', 'merge into',
  'create ', 'alter ', 'drop ', 'grant ', 'revoke ', 'set role',
  'copy ', 'do $$', 'call '
]);

/** Poista kommentit, jotta avainsanoja etsitään vain koodista. */
export function withoutComments(sql) {
  return sql.split(NEWLINE)
    .map(line => {
      const index = line.indexOf('--');
      return index === -1 ? line : line.slice(0, index);
    })
    .join(NEWLINE);
}

/**
 * Poista merkkijonoliteraalien SISÄLTÖ.
 *
 * MIKSI TÄMÄ ON VÄLTTÄMÄTÖN
 *
 * Varmistus tarkistaa, ettei infrastruktuurifunktion runko sisällä
 * vaarallisia lauseita:
 *
 *     and f.prosrc not ilike '%delete from%'
 *
 * Rivi on nimenomaan turvatarkistus, mutta naiivi avainsanahaku lukee
 * siitä sanan "delete from" ja julistaa tiedoston kirjoittavaksi.
 * Samoin roolien oikeuslista sisältää merkkijonon 'truncate'.
 *
 * Kirjoittava lause ei voi koskaan olla heittomerkkien sisällä — se
 * olisi silloin dataa. Literaalien sisällön poistaminen ei siis
 * heikennä tarkistusta lainkaan: se poistaa täsmälleen ne osumat,
 * jotka eivät ole lauseita.
 *
 * Rivinvaihdot säilytetään, jotta rivinumerot eivät siirry.
 */
export function withoutStrings(sql) {
  let out = '';
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (char === "'") {
      if (inString && sql[i + 1] === "'") { i += 1; continue; }
      inString = !inString;
      out += "'";
      continue;
    }
    if (inString) {
      out += char === NEWLINE ? NEWLINE : ' ';
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Analysoi varmistustiedosto.
 *
 * @param {string} sql tiedoston koko sisältö
 */
export function analyzeVerifier(sql) {
  const code = withoutComments(sql);
  const executable = withoutStrings(code).toLowerCase();
  const lower = code.toLowerCase();

  const writes = WRITING_KEYWORDS.filter(keyword => executable.includes(keyword));

  const semicolons = (code.match(/;/g) || []).length;
  const trimmed = code.trimEnd();
  const semicolonLast = trimmed.endsWith(';');

  let depth = 0;
  let balanced = true;
  let inString = false;
  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    if (char === "'") {
      // Kahdennettu heittomerkki on merkkijonon sisällä oleva heittomerkki.
      if (inString && code[i + 1] === "'") { i += 1; continue; }
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth < 0) balanced = false;
  }
  if (depth !== 0) balanced = false;

  const checkNumbers = [...code.matchAll(/select\s+'(\d{2})'(?:\s+as\s+check_no)?/g)]
    .map(match => Number(match[1]));

  const unionCount = (lower.match(/\bunion all\b/g) || []).length;

  return {
    writes,
    readOnly: writes.length === 0,
    semicolons,
    semicolonLast,
    singleStatement: semicolons === 1 && semicolonLast,
    balancedParens: balanced,
    unterminatedString: inString,
    checkNumbers,
    unionCount,
    /** Numerot ovat katkeamaton sarja 1..n. */
    contiguous: checkNumbers.length > 0
      && checkNumbers.every((n, index) => n === index + 1),
    /** Jokainen tarkistus ensimmäistä lukuun ottamatta on union all -ketjussa. */
    chained: unionCount === Math.max(checkNumbers.length - 1, 0)
  };
}

/** Varmistuksen lopullisen select-lauseen sarakkeet. */
export const REQUIRED_COLUMNS = Object.freeze([
  'check_no', 'section', 'check_name', 'expected', 'actual', 'status', 'failures_total'
]);

/** Onko lopputuloksessa täsmälleen vaaditut sarakkeet? */
export function outputColumns(sql) {
  const code = withoutComments(sql);
  const last = code.lastIndexOf(')' + NEWLINE + NEWLINE + 'select');
  const tail = last === -1 ? code.slice(code.lastIndexOf('select')) : code.slice(last);
  return REQUIRED_COLUMNS.filter(column => new RegExp(`\\b${column}\\b`).test(tail));
}
