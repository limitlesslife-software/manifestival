// Migraatioiden rakenteellinen luku tilin elinkaaren testeille.
//
// MIKSI OMA JÄSENNIN EIKÄ YKSI REGEX: aiempi vartija tunnisti vain talon
// oman kirjoitustavan (`create table public.x (...\n);` ja omistajasarake
// `... default auth.uid() references auth.users(id) on delete cascade`).
// Taulu ilman `default auth.uid()`:ta, `if not exists`, isot kirjaimet,
// taulutason FOREIGN KEY tai RESTRICT-viite auth.users:iin menivät ohi
// hiljaa -- ja RESTRICT estäisi lisäksi koko tilin poiston.
//
// Tämä EI ole täysi SQL-jäsennin. Se tekee kolme asiaa luotettavasti:
//   1. poistaa kommentit (-- ja sisäkkäiset /* */) koskematta
//      merkkijonoihin ('...') tai lainattuihin tunnisteisiin ("...")
//   2. löytää jokaisen CREATE TABLE -lauseen (mikä tahansa skeema,
//      temp/unlogged, if not exists, isot/pienet kirjaimet) ja sen
//      sarakelistan sulkujen tasapainolla
//   3. löytää jokaisen viittauksen auth.users-tauluun ja sen ON DELETE
//      -säännön, olipa se sarake-, taulu- tai ALTER-tason
//
// Dollarilainaukset ($$...$$, $tag$...$tag$) kopioidaan SELLAISINAAN:
// funktion rungossa oleva CREATE TABLE tai viite näkyy siis tarkistukselle.
// Väärä hälytys on tässä turvallinen suunta; hiljainen ohitus ei ole.

const NEWLINE = '\n';

function dollarTagAt(sql, index) {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index, index + 64));
  return match ? match[0] : null;
}

/** Poista kommentit. Rivinvaihdot säilyvät (virheilmoitusten rivit pysyvät oikein). */
export function stripSqlComments(sql) {
  const text = String(sql).replace(/\r\n?/g, NEWLINE);
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '-' && next === '-') {
      while (index < text.length && text[index] !== NEWLINE) index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      let depth = 1;
      index += 2;
      while (index < text.length && depth > 0) {
        if (text[index] === '/' && text[index + 1] === '*') { depth += 1; index += 2; continue; }
        if (text[index] === '*' && text[index + 1] === '/') { depth -= 1; index += 2; continue; }
        if (text[index] === NEWLINE) out += NEWLINE;
        index += 1;
      }
      out += ' ';
      continue;
    }
    if (char === "'" || char === '"') {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === char && text[end + 1] === char) { end += 2; continue; }
        if (text[end] === char) { end += 1; break; }
        end += 1;
      }
      out += text.slice(index, end);
      index = end;
      continue;
    }
    if (char === '$') {
      const tag = dollarTagAt(text, index);
      if (tag) {
        const close = text.indexOf(tag, index + tag.length);
        const end = close === -1 ? text.length : close + tag.length;
        out += text.slice(index, end);
        index = end;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return out;
}

/** Tunnisteen normalisointi: lainaamaton pieniksi, lainatusta lainausmerkit pois. */
function identifier(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) return trimmed.slice(1, -1).replace(/""/g, '"');
  return trimmed.toLowerCase();
}

const IDENT = '(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)';
const QUALIFIED = `(${IDENT}(?:\\s*\\.\\s*${IDENT})?)`;

function qualifiedName(raw) {
  const parts = raw.split(/\s*\.\s*(?=(?:"|[A-Za-z_]))/).map(identifier);
  return parts.length === 2 ? { schema: parts[0], name: parts[1] } : { schema: null, name: parts[0] };
}

/** Sulkujen tasapainolla: indeksi `(`-merkissä -> [sisältö, loppuindeksi]. */
function balancedBody(sql, openIndex) {
  let depth = 0;
  let quote = null;
  for (let index = openIndex; index < sql.length; index++) {
    const char = sql[index];
    if (quote) {
      if (char === quote && sql[index + 1] === quote) { index += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return [sql.slice(openIndex + 1, index), index];
    }
  }
  return [sql.slice(openIndex + 1), sql.length];
}

/** Jaa pilkuilla ylimmällä sulkutasolla (sarakelista, ALTER-toimenpiteet). */
export function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      current += char;
      if (char === quote && text[index + 1] === quote) { current += text[index + 1]; index += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts.map(part => part.trim()).filter(Boolean);
}

const CREATE_TABLE = new RegExp(
  `\\bcreate\\s+(?:(?:global|local)\\s+)?(?:(temp|temporary|unlogged)\\s+)?table\\s+(if\\s+not\\s+exists\\s+)?${QUALIFIED}`,
  'gi');

/**
 * Jokainen CREATE TABLE. Skeemattoman nimen skeema on `public`
 * (hakupolun oletus), väliaikaisen `pg_temp`.
 *
 * @returns {Array<{schema:string, name:string, display:string, temporary:boolean, body:string|null, index:number}>}
 */
export function createTableStatements(sql) {
  const code = stripSqlComments(sql);
  const tables = [];
  for (const match of code.matchAll(CREATE_TABLE)) {
    const temporary = /^temp/i.test(match[1] || '');
    const parsed = qualifiedName(match[3]);
    const schema = parsed.schema || (temporary ? 'pg_temp' : 'public');
    let cursor = match.index + match[0].length;
    while (/\s/.test(code[cursor] || '')) cursor += 1;
    const body = code[cursor] === '(' ? balancedBody(code, cursor)[0] : null;
    tables.push({
      schema,
      name: parsed.name,
      display: schema === 'public' || schema === 'pg_temp' ? parsed.name : `${schema}.${parsed.name}`,
      temporary,
      body,
      index: match.index
    });
  }
  return tables;
}

const TABLE_CONSTRAINT = /^(?:constraint\s+\S+\s+)?(?:primary|foreign|unique|check|exclude)\b/i;
const AUTH_USERS = /\breferences\s+"?auth"?\s*\.\s*"?users"?(?![A-Za-z0-9_$"])/i;
const AUTH_USERS_GLOBAL = new RegExp(AUTH_USERS.source, 'gi');

/** ON DELETE -sääntö normalisoituna; null = ei lauseketta (oletus NO ACTION). */
export function onDeleteRule(text) {
  const match = /\bon\s+delete\s+(cascade|restrict|no\s+action|set\s+null|set\s+default)\b/i.exec(text);
  return match ? match[1].toLowerCase().replace(/\s+/g, ' ') : null;
}

/** Sarakemäärittelyt: [{ name, type, definition }]. Taulutason rajoitteet ohitetaan. */
export function columnDefinitions(body) {
  if (!body) return [];
  return splitTopLevel(body)
    .filter(item => !TABLE_CONSTRAINT.test(item) && !/^like\b/i.test(item))
    .map(item => {
      const match = new RegExp(`^(${IDENT})\\s+([\\s\\S]*)$`).exec(item);
      if (!match) return null;
      const type = /^([A-Za-z_][A-Za-z0-9_ ]*?(?:\s*\([^)]*\))?(?:\[\])?)(?=\s|$)/.exec(match[2].trim());
      return { name: identifier(match[1]), type: (type ? type[1] : match[2]).trim().toLowerCase(), definition: item };
    })
    .filter(Boolean);
}

/** Taulun viittaukset auth.users:iin sen omassa CREATE TABLE -lauseessa. */
function authOwnersInBody(body) {
  const owners = [];
  for (const item of splitTopLevel(body || '')) {
    if (!AUTH_USERS.test(item)) continue;
    const foreignKey = new RegExp(`^(?:constraint\\s+\\S+\\s+)?foreign\\s+key\\s*\\(\\s*(${IDENT})`, 'i').exec(item);
    if (foreignKey) {
      owners.push({ column: identifier(foreignKey[1]), onDelete: onDeleteRule(item) });
      continue;
    }
    const column = new RegExp(`^(${IDENT})\\s`).exec(item);
    if (column && !TABLE_CONSTRAINT.test(item)) owners.push({ column: identifier(column[1]), onDelete: onDeleteRule(item) });
  }
  return owners;
}

const ALTER_TABLE = new RegExp(`\\balter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${QUALIFIED}\\s+([^;]*);`, 'gi');

/**
 * ALTER TABLE -toimenpiteet, joista sarakejoukko ja omistajuus riippuvat.
 * @returns {Array<{schema, name, display, action:'add'|'drop'|'rename'|'fk', column, to?, type?, onDelete?, auth?:boolean}>}
 */
export function alterTableActions(sql) {
  const code = stripSqlComments(sql);
  const actions = [];
  for (const match of code.matchAll(ALTER_TABLE)) {
    const parsed = qualifiedName(match[1]);
    const schema = parsed.schema || 'public';
    const base = { schema, name: parsed.name, display: schema === 'public' ? parsed.name : `${schema}.${parsed.name}` };
    for (const part of splitTopLevel(match[2])) {
      const rename = new RegExp(`^rename\\s+(?:column\\s+)?(${IDENT})\\s+to\\s+(${IDENT})`, 'i').exec(part);
      if (rename) { actions.push({ ...base, action: 'rename', column: identifier(rename[1]), to: identifier(rename[2]) }); continue; }
      const drop = new RegExp(`^drop\\s+column\\s+(?:if\\s+exists\\s+)?(${IDENT})`, 'i').exec(part);
      if (drop) { actions.push({ ...base, action: 'drop', column: identifier(drop[1]) }); continue; }
      const foreignKey = new RegExp(`^add\\s+(?:constraint\\s+\\S+\\s+)?foreign\\s+key\\s*\\(\\s*(${IDENT})`, 'i').exec(part);
      if (foreignKey) {
        actions.push({ ...base, action: 'fk', column: identifier(foreignKey[1]), auth: AUTH_USERS.test(part), onDelete: onDeleteRule(part) });
        continue;
      }
      if (/^add\s+(?:constraint|primary|unique|check|exclude|foreign)\b/i.test(part)) continue;
      const add = new RegExp(`^add\\s+(?:column\\s+)?(?:if\\s+not\\s+exists\\s+)?(${IDENT})\\s+([\\s\\S]*)$`, 'i').exec(part);
      if (add) {
        const column = identifier(add[1]);
        const [definition] = columnDefinitions(`${add[1]} ${add[2]}`);
        actions.push({ ...base, action: 'add', column, type: definition ? definition.type : '' });
        if (AUTH_USERS.test(part)) actions.push({ ...base, action: 'fk', column, auth: true, onDelete: onDeleteRule(part) });
      }
    }
  }
  return actions;
}

/**
 * Jokainen viittaus auth.users-tauluun ja sen ON DELETE -sääntö.
 * Lauseke luetaan viittauksesta seuraavaan pilkkuun, puolipisteeseen tai
 * sulkevaan sulkuun asti ylimmällä tasolla.
 */
export function authUserReferences(sql) {
  const code = stripSqlComments(sql);
  const references = [];
  for (const match of code.matchAll(AUTH_USERS_GLOBAL)) {
    let end = match.index + match[0].length;
    let depth = 0;
    while (end < code.length) {
      const char = code[end];
      if (char === '(') depth += 1;
      if (char === ')') { if (depth === 0) break; depth -= 1; }
      if ((char === ',' || char === ';') && depth === 0) break;
      end += 1;
    }
    const line = code.slice(0, match.index).split(NEWLINE).length;
    references.push({ line, clause: code.slice(match.index, end).trim(), onDelete: onDeleteRule(code.slice(match.index, end)) });
  }
  return references;
}

/**
 * Tilin poiston kannalta: mitkä taulut on luotu, kuka omistaa minkä ja
 * mitkä auth.users-viittaukset eivät kaskadoidu.
 *
 * @param {string} sql kaikki migraatiot yhdessä
 * @param {{mappedTables:Iterable<string>, exemptTables?:object}} options
 *   mappedTables: public-skeeman taulut, jotka poistokartta tuntee;
 *   exemptTables: { nimi: perustelu } tauluille, jotka eivät ole käyttäjän dataa
 */
export function classifyAccountSchema(sql, { mappedTables, exemptTables = {} }) {
  const mapped = new Set(mappedTables);
  const created = createTableStatements(sql);
  const owners = new Map();
  const nonCascade = [];

  const addOwner = (display, column, onDelete) => {
    if (onDelete === 'cascade') owners.set(display, column);
    else nonCascade.push({ table: display, column, onDelete: onDelete || 'no action (oletus)' });
  };

  for (const table of created) {
    for (const owner of authOwnersInBody(table.body)) addOwner(table.display, owner.column, owner.onDelete);
  }
  for (const action of alterTableActions(sql)) {
    if (action.action === 'fk' && action.auth) addOwner(action.display, action.column, action.onDelete);
  }

  const isClassified = table => (table.schema === 'public' && mapped.has(table.name))
    || Object.prototype.hasOwnProperty.call(exemptTables, table.display);
  const unclassified = created.filter(table => !isClassified(table)).map(table => table.display);
  const unmappedOwners = [...owners.keys()].filter(display => !mapped.has(display));
  const nonCascadeReferences = authUserReferences(sql).filter(reference => reference.onDelete !== 'cascade');

  return { created, owners, unclassified, unmappedOwners, nonCascade, nonCascadeReferences };
}
