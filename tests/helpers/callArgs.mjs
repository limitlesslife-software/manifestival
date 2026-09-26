// Kutsun argumenttien poiminta lähdekoodista (loki- ja konsolitarkistukset).
//
// Säännöllinen lauseke ei riitä: argumentti voi sisältää pilkkuja,
// sulkeita ja merkkijonoja ("console.warn('a, b', error)"). Tämä käy
// lähdekoodin merkki kerrallaan ja pitää kirjaa sulkeista ja lainauksista.

/**
 * Kutsun ylätason argumentit: `source[open]` on avaava sulku.
 * @returns {string[]} argumenttien lähdeteksti sellaisenaan
 */
export function callArguments(source, open) {
  const args = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let index = open; index < source.length; index += 1) {
    const ch = source[index];
    if (quote) {
      current += ch;
      if (ch === '\\') { current += source[index + 1]; index += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
    if ('([{'.includes(ch)) {
      depth += 1;
      if (depth === 1) continue;
    } else if (')]}'.includes(ch)) {
      depth -= 1;
      if (depth === 0) {
        if (current.trim()) args.push(current.trim());
        return args;
      }
    } else if (ch === ',' && depth === 1) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  return args;
}

/** Merkkijonoliteraali ilman lausekkeita (`${…}`). */
export const STRING_LITERAL = /^(?:'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"|`[^`$]*`)$/;

/**
 * Kaikki kutsut, joiden nimi osuu lausekkeeseen `callee` (ryhmä 1 = nimi),
 * argumentteineen.
 * @returns {Array<{callee: string, index: number, args: string[]}>}
 */
export function callsIn(source, callee) {
  const pattern = new RegExp(`(${callee.source})\\(`, 'g');
  return [...source.matchAll(pattern)].map(match => ({
    callee: match[1],
    index: match.index,
    args: callArguments(source, match.index + match[0].length - 1)
  }));
}
