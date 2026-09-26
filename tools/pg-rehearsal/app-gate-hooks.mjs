// Moduulikoukut, joilla sovelluksen OIKEAT rivimuunnokset ladataan
// tietyn aallon sarakeporteilla — ilman että src/-hakemistoon koskee.
//
// Sovellus valitsee lähetettävät sarakkeet src/data/schema.js:n
// vakioista (BILL_PAYMENT_FIELDS, GOAL_PLANNING_FIELDS, ...). Vakioita ei
// voi vaihtaa ajon aikana, joten jokainen aalto ladataan omana
// moduuligraafinaan: URL:iin lisätään ?mvgates=<portit>, ja
//
//   resolve  periyttää kyselyn jokaiseen src/-tiedostoon, jota graafi
//            importtaa (sama tiedosto eri porteilla = eri moduuli)
//   load     korvaa schema.js:n porttivakiot annetuilla arvoilla
//
// Vain tämän harjoittelun prosessi rekisteröi nämä (waves.mjs). Jos
// schema.js:stä puuttuu yksikin tunnettu portti, lataus kaatuu: portin
// nimen muutos ei saa hiljaa tuottaa väärää rivimuotoa.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const KNOWN_GATES = Object.freeze([
  'BILL_PAYMENT_FIELDS', 'GOAL_PLANNING_FIELDS', 'GOAL_MAINTENANCE_MODE',
  'GOAL_LIFE_AREA_FIELD', 'ALIGNMENT_REALITY_FIELDS'
]);

const PARAM = 'mvgates';

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  const parent = context.parentURL;
  if (!parent || !parent.startsWith('file:') || !result.url.startsWith('file:')) return result;
  const parentUrl = new URL(parent);
  if (!parentUrl.searchParams.has(PARAM)) return result;
  const child = new URL(result.url);
  if (child.searchParams.has(PARAM) || !/\/src\//.test(child.pathname)) return result;
  child.searchParams.set(PARAM, parentUrl.searchParams.get(PARAM));
  return { ...result, url: child.href };
}

/** Puhdas: korvaa schema.js:n porttivakiot. Heittää, jos portti puuttuu. */
export function patchSchemaSource(source, gatesOn) {
  let out = String(source);
  for (const gate of KNOWN_GATES) {
    const pattern = new RegExp(`^export const ${gate} = (true|false);`, 'm');
    if (!pattern.test(out)) throw new Error(`src/data/schema.js: porttia ${gate} ei löytynyt`);
    out = out.replace(pattern, `export const ${gate} = ${gatesOn.includes(gate)};`);
  }
  return out;
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:')) {
    const u = new URL(url);
    if (u.searchParams.has(PARAM) && u.pathname.endsWith('/src/data/schema.js')) {
      const gatesOn = u.searchParams.get(PARAM).split(',').filter(Boolean);
      for (const g of gatesOn) if (!KNOWN_GATES.includes(g)) throw new Error(`Tuntematon portti ${g}`);
      const clean = new URL(url);
      clean.search = '';
      const source = patchSchemaSource(await readFile(fileURLToPath(clean), 'utf8'), gatesOn);
      return { format: 'module', source, shortCircuit: true };
    }
  }
  return nextLoad(url, context);
}
