// Yhteiset komentorivin apuvälineet Android-skripteille.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repon juuri (tämän tiedoston sijainnista). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * `--avain arvo`, `--avain=arvo` ja `--lippu` objektiksi.
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
    if (eq !== -1) options[key] = arg.slice(eq + 1);
    else if (flags.includes(key)) options[key] = true;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) options[key] = argv[++i];
    else throw new Error(`--${key} tarvitsee arvon`);
  }
  return { options, positional };
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
