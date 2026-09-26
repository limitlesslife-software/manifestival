// Yhteiset komentorivin apuvälineet Android-skripteille.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repon juuri (tämän tiedoston sijainnista). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * `--avain arvo`, `--avain=arvo` ja `--lippu` objektiksi.
 *
 * Lippu (flags) hyväksyy VAIN muodot `--lippu` ja `--lippu=true`. Muu arvo
 * kaatuu: aiemmin `--skip-lock-check=false` tuotti merkkijonon 'false',
 * joka on JS:ssä tosi, ja OHITTI lukitustarkistuksen päinvastoin kuin
 * kirjoittaja tarkoitti.
 *
 * @param {string[]} argv
 * @param {string[]} flags avaimet, jotka eivät ota arvoa
 */
export function parseCliArgs(argv, flags = []) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    const key = arg.slice(2, eq === -1 ? undefined : eq);
    if (flags.includes(key)) {
      const value = eq === -1 ? 'true' : arg.slice(eq + 1);
      if (value !== 'true') {
        throw new Error(`--${key} on lippu: anna pelkkä --${key} (tai --${key}=true), ei arvoa '${value}'`);
      }
      options[key] = true;
    } else if (eq !== -1) options[key] = arg.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) options[key] = argv[++i];
    else throw new Error(`--${key} tarvitsee arvon`);
  }
  return { options, positional };
}

/**
 * Skriptit eivät ota paikkasidonnaisia argumentteja. Hylätään ne, jottei
 * `--skip-lock-check false` (välilyönnillä) ohita lukitusta hiljaa: lippu
 * ei ota arvoa, joten 'false' jäisi irralliseksi ja huomiotta.
 */
export function rejectPositional(positional) {
  if (positional.length) {
    throw new Error(`tuntematon argumentti: ${positional.join(' ')} (liput eivät ota arvoa erillisenä sanana)`);
  }
}

/**
 * Käyttäjän antama polku sen hakemiston mukaan, jossa komento kirjoitettiin:
 * `npm run` vaihtaa cwd:n paketin juureen ja jättää alkuperäisen INIT_CWD:hen.
 */
export function resolveFromInvocation(value, { env = process.env, cwd = process.cwd() } = {}) {
  return path.resolve(env.INIT_CWD || cwd, String(value));
}

/** Polku vertailukelpoiseksi (Windowsissa kirjainkoko ja kauttaviivat). */
export function samePath(a, b) {
  const norm = p => {
    const resolved = path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

/** Onko tämä moduuli ajettu suoraan (node skripti.mjs)? */
export function isMain(importMetaUrl) {
  return Boolean(process.argv[1]) && samePath(fileURLToPath(importMetaUrl), process.argv[1]);
}
