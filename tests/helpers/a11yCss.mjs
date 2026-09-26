// styles.css:n sääntöjen luku ja WCAG-kontrastin laskenta testeille.
//
// Ei selainta: säännöt luetaan tekstinä, :root-muuttujat ratkaistaan ja
// läpikuultavat taustat (rgba) yhdistetään alla olevaan väriin kuten
// selain piirtää ne. Valitsimia verrataan TÄSMÄLLEEN (sama merkkijono kuin
// styles.css:ssä), jotta testi ei arvaa kaskadia.

/** Säännöt: [{ selectors, decls, media }]; @media-lohkojen säännöt merkitään. */
export function parseRules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const walk = (body, media) => {
    let index = 0;
    while (index < body.length) {
      const open = body.indexOf('{', index);
      if (open < 0) break;
      const head = body.slice(index, open).trim();
      let depth = 1;
      let end = open + 1;
      while (end < body.length && depth > 0) {
        if (body[end] === '{') depth += 1;
        else if (body[end] === '}') depth -= 1;
        end += 1;
      }
      const inner = body.slice(open + 1, end - 1);
      if (head.startsWith('@media')) walk(inner, head);
      else if (!head.startsWith('@')) {
        rules.push({
          selectors: head.split(',').map(selector => selector.trim().replace(/\s+/g, ' ')),
          decls: parseDeclarations(inner),
          media
        });
      }
      index = end;
    }
  };
  walk(text, null);
  return rules;
}

function parseDeclarations(body) {
  const decls = {};
  for (const part of body.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    decls[part.slice(0, colon).trim().toLowerCase()] = part.slice(colon + 1).trim();
  }
  return decls;
}

/** Valitsimen ilmoitukset (ei @media-lohkoja), myöhempi voittaa. */
export function declarations(rules, selector, { media = null } = {}) {
  const normalized = selector.trim().replace(/\s+/g, ' ');
  const out = {};
  for (const rule of rules) {
    if (rule.media !== media) continue;
    if (rule.selectors.includes(normalized)) Object.assign(out, rule.decls);
  }
  return out;
}

export function rootTokens(rules) {
  return declarations(rules, ':root');
}

/** Pikselit ('44px' -> 44); muut yksiköt tai puuttuva -> null. */
export function px(value) {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(String(value ?? '').trim());
  return match ? Number(match[1]) : null;
}

// ------------------------------------------------------------ värit

export function resolveVar(value, tokens, depth = 0) {
  if (depth > 10) throw new Error('muuttujaketju liian pitkä: ' + value);
  return String(value).replace(/var\((--[\w-]+)(?:\s*,\s*([^)]+))?\)/g, (all, name, fallback) => {
    if (name in tokens) return resolveVar(tokens[name], tokens, depth + 1);
    if (fallback !== undefined) return fallback.trim();
    throw new Error('määrittelemätön muuttuja ' + name);
  });
}

/** Väri [r, g, b, a] tai null (läpinäkyvä). */
export function parseColor(value, tokens) {
  const text = resolveVar(String(value).trim(), tokens).trim().toLowerCase();
  if (text === 'none' || text === 'transparent') return null;
  let match = /^#([0-9a-f]{3})$/.exec(text);
  if (match) return [...match[1]].map(c => parseInt(c + c, 16)).concat(1);
  match = /^#([0-9a-f]{6})$/.exec(text);
  if (match) return [0, 2, 4].map(i => parseInt(match[1].slice(i, i + 2), 16)).concat(1);
  match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(text);
  if (match) return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
  throw new Error('tuntematon väri: ' + value + ' -> ' + text);
}

/** Läpikuultava väri tausta-värin päälle. */
export function composite(top, bottom) {
  if (!top) return bottom;
  const alpha = top[3];
  return [0, 1, 2].map(i => top[i] * alpha + bottom[i] * (1 - alpha)).concat(1);
}

function channel(value) {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x kontrastisuhde. */
export function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** Iso teksti: vähintään 24 px, tai 18,66 px (14 pt) lihavoituna. */
export function isLargeText(sizePx, weight) {
  return sizePx >= 24 || (sizePx >= 18.66 && weight >= 700);
}

export function fontWeight(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value === 'bold') return 700;
  if (value === 'normal') return 400;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
