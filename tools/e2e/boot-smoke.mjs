// Käynnistyssavu (boot smoke): junan ehdokkaan OMA koodi oikeassa
// selaimessa (headless Chrome, CDP). EI TUOTANTOA.
//
//   npm run e2e:boot-smoke -- --root .claude/worktrees/rc-f --label F
//   node tools/e2e/boot-smoke.mjs --root <työpuu> --label <X> [--expect-sha <sha>] [--gates J]
//
//   --expect-sha  HEAD:n ja tarjoillun puun (src, index.html, sw.js,
//                 manifest.json, vendor) on vastattava tätä committia
//   --gates J     tuotehaaralle: portit aallon J arvoilla (tools/e2e/gates.mjs);
//                 oletus on ehdokkaan oma schema.js sellaisenaan
//
// MIKSI: yksikkötestit eivät käynnistä src/app/main.js:ää. Aallosta F alkaen
// finance.js:n renderOverviewDetail viittasi muuttujaan `key` (oikea nimi
// `avain`), ja jokainen renderAll kaatui ReferenceErroriin; vika löytyi
// vasta E2E-valjaan ensimmäisestä oikeasta käynnistyksestä. Savu ajaa saman
// käynnistyksen jokaisen ehdokkaan omalle puulle ja sen omille
// käännösaikaisille porteille (ehdokkaan src/data/schema.js sellaisenaan).
//
// MITÄ TARJOILLAAN
//   /__smoke/…  tästä repositoriosta: sivu, valjas (boot-smoke-harness.mjs),
//               kannan korvike (fakeSupabase.mjs) ja siemen (seeds.mjs)
//   /api/…      501 (ei palvelinta, ei tekoälyä); jokainen kutsu kirjataan
//   muu         ehdokkaan työpuusta (--root), VAIN LUKU: vain GET ja HEAD,
//               ei pistetiedostoja (.git, .env), ei polkuja juuren ulkopuolelle.
//               Juuren sormenjälki (sisältötiivisteet) todennetaan ennen ja
//               jälkeen ajon: muuttunut juuri kaataa ajon.
//
// TURVASÄÄNNÖT (kuten run-suunta-e2e.mjs):
//   - debug-portti valitaan vapaaksi JA todennetaan vapaaksi ennen
//     käynnistystä; vieraaseen Chromeen ei koskaan liitytä (portin tai
//     osoitteen antaminen komentorivillä on virhe)
//   - tuotanto estetään DNS-tasolla (--host-resolver-rules) JA CDP:n
//     Fetch-tasolla: jokainen muu kuin paikallinen pyyntö katkaistaan ja
//     kirjataan; yksikin yritys tuotantoon kaataa ajon
//   - profiili on TÄMÄN repositorion tmp/-hakemistossa (ei koskaan ehdokkaan
//     puussa) ja poistetaan lopuksi (Windowsin EPERM ei peitä tulosta)
//
// SIEMEN: omistajan kanta (tools/e2e/seeds.mjs ownerSmokeSeed: 36 avointa
// tehtävää ilman kestoa rästissä/tällä/ensi viikolla, tavoite, siihen
// liitetty projekti, profiili, ilmoitusasetukset, hyvinvointimerkintä) ja
// tekaistu istunto ilman tokenia omistajan tunnuksella.
//
// KULKU: käynnistys -> jokainen alapalkin välilehti (ehdokkaan index.html)
// -> jokaisen näytön osiovälilehdet (segment*) -> sovelluksen omat pitkät
// ajastimet kerran (main.js:n 30 s NYT-kierros, ei odotusta) -> tulos.
// Poistuu koodilla 1, jos tuli yksikin poikkeus, käsittelemätön hylkäys,
// konsolivirhe (paitsi estetyn ulkoisen tiedoston odotettu latausvirhe),
// tuotantopyyntö, tuntematon ulkoinen pyyntö, api-kutsu, korvikkeen
// tukematon kysely, käynnistys tai näyttö epäonnistui, tai juuri muuttui.
// Käyttövirhe: 2.

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveGateMode, GATES_QUERY, harnessHtml } from './gates.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
};

/** Varattu etuliite: nämä tiedostot tulevat tästä repositoriosta, eivät ehdokkaasta. */
export const SMOKE_PREFIX = '/__smoke/';
export const SMOKE_PAGE = 'boot.html';
export const SMOKE_FILES = Object.freeze({
  'harness.mjs': 'tools/e2e/boot-smoke-harness.mjs',
  'fakeSupabase.mjs': 'tools/e2e/fakeSupabase.mjs',
  'seeds.mjs': 'tools/e2e/seeds.mjs'
});

/**
 * DNS-esto: samat säännöt kuin run-suunta-e2e.mjs:ssä, lisäksi paljas
 * anthropic.com ja tuotannon Vercel-osoitteet.
 */
export const HOST_RESOLVER_RULES = [
  'MAP *.supabase.co ~NOTFOUND', 'MAP supabase.co ~NOTFOUND', 'MAP *.anthropic.com ~NOTFOUND',
  'MAP cdn.jsdelivr.net ~NOTFOUND', 'MAP fonts.googleapis.com ~NOTFOUND', 'MAP fonts.gstatic.com ~NOTFOUND',
  'MAP anthropic.com ~NOTFOUND', 'MAP *.vercel.app ~NOTFOUND'
].join(', ');

/** Tuotannon nimet: yksikin pyyntö näihin kaataa ajon. */
export const PRODUCTION_HOST = /(^|\.)(supabase\.co|anthropic\.com|vercel\.app)$/i;

/**
 * Estetyt ulkoiset lataukset, joiden latausvirhe on odotettu (offline):
 * index.html:n fontit ja CDN. Muu ulkoinen nimi on tuntematon ja kaataa ajon.
 */
export const EXPECTED_OFFLINE_HOSTS = Object.freeze(['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com']);

/** Juuren sormenjälkeen kuuluvat polut (kaikki, mitä savu tarjoilee sovellukselle). */
export const FINGERPRINT_ENTRIES = Object.freeze(['index.html', 'sw.js', 'manifest.json', 'src', 'vendor']);

export class UsageError extends Error {}

// ------------------------------------------------------------ argumentit

const FOREIGN_BROWSER_ARG = /^--(debug-port|remote-debugging-port|port|cdp|ws-endpoint|browser-url|browser-ws|chrome-port)(=|$)/;

/**
 * Komentoriviargumentit. Heittää UsageErrorin; ei koskaan liity vieraaseen
 * Chromeen (portin tai osoitteen antaminen on virhe).
 *
 * `--gates J` (valinnainen): ehdokkaan schema.js:n porttiliteraalit
 * korvataan aallon J arvoilla import mapin kautta (tools/e2e/gates.mjs,
 * sama kuin Suunta-E2E:n J-tila). Tuotehaaran portit ovat kiinni, joten
 * tällä sen koodi käynnistetään sellaisena kuin J sen avaa. Oletus:
 * ehdokkaan omat portit sellaisenaan.
 *
 * @returns {{ root: string, label: string, expectSha: string|null, gates: 'own'|'J' }}
 */
export function parseArgs(argv, { cwd = process.cwd() } = {}) {
  const out = { root: null, label: null, expectSha: null, gates: 'own' };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (FOREIGN_BROWSER_ARG.test(arg)) {
      throw new UsageError(`${arg.split('=')[0]}: vieraaseen Chromeen ei liitytä — savu valitsee debug-portin itse ja todentaa sen vapaaksi`);
    }
    const match = /^--(root|label|expect-sha|gates)(?:=(.*))?$/.exec(arg);
    if (!match) throw new UsageError(`tuntematon argumentti: ${arg}`);
    const value = match[2] !== undefined ? match[2] : args.shift();
    if (value === undefined || value === '' || value.startsWith('--')) throw new UsageError(`--${match[1]} tarvitsee arvon`);
    if (match[1] === 'root') out.root = value;
    else if (match[1] === 'label') out.label = value;
    else if (match[1] === 'gates') {
      if (value !== 'J' && value !== 'own') throw new UsageError(`--gates: sallittu J tai own: ${value}`);
      out.gates = value;
    } else out.expectSha = value;
  }
  if (!out.root) throw new UsageError('--root puuttuu (ehdokkaan työpuu)');
  const root = path.resolve(cwd, out.root);
  let stat = null;
  try { stat = fs.statSync(root); } catch { /* puuttuu */ }
  if (!stat || !stat.isDirectory()) throw new UsageError(`--root ei ole hakemisto: ${root}`);
  for (const needed of ['index.html', 'src/app/main.js', 'src/data/client.js']) {
    if (!fs.existsSync(path.join(root, needed))) throw new UsageError(`--root: ${needed} puuttuu (${root})`);
  }
  const label = out.label || path.basename(root);
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(label)) throw new UsageError(`--label: sallittu A–Z, 0–9, . _ - (enintään 40): ${label}`);
  if (out.expectSha !== null && !/^[0-9a-f]{7,40}$/i.test(out.expectSha)) throw new UsageError(`--expect-sha: ei commit-tunniste: ${out.expectSha}`);
  return { root, label, expectSha: out.expectSha ? out.expectSha.toLowerCase() : null, gates: out.gates };
}

/** Onko `child` hakemiston `parent` sisällä (tai sama)? */
export function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Chromen profiili: TÄMÄN repositorion tmp/. Ei koskaan ehdokkaan puussa
 * (juuri on vain luku). Oma työpuu juurena on sallittu (tuotehaara).
 */
export function profileDirFor({ repoRoot = ROOT, root, label, pid = process.pid, now = Date.now() }) {
  const profile = path.join(repoRoot, 'tmp', `boot-smoke-${label}-${pid}-${now}`);
  if (path.resolve(root) !== path.resolve(repoRoot) && isInside(profile, root)) {
    throw new UsageError(`profiili osuisi ehdokkaan puuhun (${root}); aja savu toisesta työpuusta`);
  }
  return profile;
}

/** Chromen argumentit: kuten run-suunta-e2e.mjs, oma portti ja DNS-esto. */
export function chromeArgs({ debugPort, profile }) {
  if (!Number.isInteger(debugPort) || debugPort <= 0) throw new Error('debug-portti puuttuu');
  return [
    '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    `--host-resolver-rules=${HOST_RESOLVER_RULES}`,
    'about:blank'
  ];
}

// ---------------------------------------------------------- palvelin

/**
 * Varattu sivu: base "/" (ehdokkaan suhteelliset polut), ehdokkaan tyylit,
 * valjas. Tyhjä ikoni: selain ei pyydä /favicon.ico:ta ehdokkaalta.
 * J-porttitilassa import map (ennen moduuleja) ohjaa jokaisen schema.js-
 * importin J-porttiseen versioon (tools/e2e/gates.mjs harnessHtml).
 */
export function smokePageHtml(label, { gates = 'own' } = {}) {
  const safe = String(label).replace(/[^A-Za-z0-9._-]/g, '');
  const page = `<!DOCTYPE html>
<html lang="fi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<base href="/">
<title>Käynnistyssavu ${safe} (paikallinen)</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/src/styles.css">
</head>
<body>
<!-- PAIKALLINEN KÄYNNISTYSSAVU. EI TUOTANTOA. Ks. tools/e2e/boot-smoke.mjs. -->
<script type="module" src="${SMOKE_PREFIX}harness.mjs"></script>
</body>
</html>
`;
  return harnessHtml(page, gates === 'J' ? 'J' : 'closed');
}

/**
 * Mitä pyyntöön vastataan. Puhdas funktio (testataan ilman verkkoa).
 *
 * @returns {{ status: number, kind: string, file?: string }}
 */
export function resolveRequest({ root, repoRoot = ROOT, method, url, gatedSchema = false }) {
  if (method !== 'GET' && method !== 'HEAD') return { status: 405, kind: 'read-only' };
  let pathname;
  let parsed;
  try {
    parsed = new URL(url, 'http://127.0.0.1');
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return { status: 400, kind: 'bad-url' };
  }
  if (pathname.includes('\0')) return { status: 400, kind: 'bad-url' };
  if (pathname === '/src/data/schema.js' && parsed.searchParams.get(GATES_QUERY) === 'J') {
    return gatedSchema ? { status: 200, kind: 'gated-schema' } : { status: 404, kind: 'gated-schema-off' };
  }
  if (pathname.startsWith(SMOKE_PREFIX)) {
    const name = pathname.slice(SMOKE_PREFIX.length);
    if (name === '' || name === SMOKE_PAGE) return { status: 200, kind: 'smoke-page' };
    if (Object.prototype.hasOwnProperty.call(SMOKE_FILES, name)) {
      return { status: 200, kind: 'smoke', file: path.join(repoRoot, SMOKE_FILES[name]) };
    }
    return { status: 404, kind: 'smoke-missing' };
  }
  if (pathname === '/api' || pathname.startsWith('/api/')) return { status: 501, kind: 'api' };
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (relative.split(/[\\/]/).some(segment => segment.startsWith('.'))) return { status: 403, kind: 'forbidden' };
  const file = path.resolve(root, relative);
  if (!isInside(file, root) || file === path.resolve(root)) return { status: 403, kind: 'forbidden' };
  return { status: 200, kind: 'root', file };
}

function startServer({ root, label, port, served, gates, gatedSchemaSource }) {
  const server = http.createServer((req, res) => {
    const decision = resolveRequest({ root, method: req.method, url: req.url || '/', gatedSchema: Boolean(gatedSchemaSource) });
    const headers = type => ({ 'Content-Type': type, 'Cache-Control': 'no-store' });
    const entry = { kind: decision.kind, url: req.url, status: decision.status };
    served.push(entry);
    if (decision.kind === 'smoke-page') {
      res.writeHead(200, headers(MIME['.html'])).end(req.method === 'HEAD' ? undefined : smokePageHtml(label, { gates }));
      return;
    }
    if (decision.kind === 'gated-schema') {
      res.writeHead(200, headers(MIME['.js'])).end(req.method === 'HEAD' ? undefined : gatedSchemaSource);
      return;
    }
    if (decision.status !== 200) {
      res.writeHead(decision.status, headers('application/json')).end(JSON.stringify({ error: decision.kind }));
      return;
    }
    // VAIN LUKU: ainoa tiedosto-operaatio on readFile.
    fs.readFile(decision.file, (err, data) => {
      if (err) {
        entry.status = 404;
        res.writeHead(404, headers('text/plain; charset=utf-8')).end('404');
        return;
      }
      res.writeHead(200, headers(MIME[path.extname(decision.file).toLowerCase()] || 'application/octet-stream'))
        .end(req.method === 'HEAD' ? undefined : data);
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// -------------------------------------------------- juuri: vain luku

function walk(root, relative, out) {
  const full = path.join(root, relative);
  let stat;
  try { stat = fs.statSync(full); } catch { return; }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(full).sort()) walk(root, path.join(relative, name), out);
  } else if (stat.isFile()) {
    out.push(relative.split(path.sep).join('/'));
  }
}

/** Juuren tarjoiltavien tiedostojen sisältötiivisteet: { polku: sha256 }. */
export function fingerprintRoot(root) {
  const files = [];
  for (const entry of FINGERPRINT_ENTRIES) walk(root, entry, files);
  const out = {};
  for (const file of files) out[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
  return out;
}

/** Sormenjälkien erot: muuttuneet, lisätyt ja poistetut polut. */
export function fingerprintChanges(before, after) {
  const changes = [];
  for (const [file, hash] of Object.entries(before)) {
    if (!(file in after)) changes.push(`poistettu: ${file}`);
    else if (after[file] !== hash) changes.push(`muuttunut: ${file}`);
  }
  for (const file of Object.keys(after)) if (!(file in before)) changes.push(`lisätty: ${file}`);
  return changes;
}

/** Juuren HEAD pelkillä tiedostolukuilla (.git-tiedosto tai -hakemisto). Ei gitiä juuressa. */
export function readGitHead(root) {
  try {
    let gitDir = path.join(root, '.git');
    if (fs.statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'));
      if (!pointer) return { sha: null, ref: null };
      gitDir = path.resolve(root, pointer[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return { sha: head, ref: null };
    const ref = head.slice(4).trim();
    const commonFile = path.join(gitDir, 'commondir');
    const common = fs.existsSync(commonFile) ? path.resolve(gitDir, fs.readFileSync(commonFile, 'utf8').trim()) : gitDir;
    for (const dir of [gitDir, common]) {
      const file = path.join(dir, ...ref.split('/'));
      if (fs.existsSync(file)) return { sha: fs.readFileSync(file, 'utf8').trim(), ref };
    }
    const packed = fs.readFileSync(path.join(common, 'packed-refs'), 'utf8').split(/\r?\n/)
      .find(line => line.endsWith(' ' + ref));
    return { sha: packed ? packed.split(' ')[0] : null, ref };
  } catch {
    return { sha: null, ref: null };
  }
}

/** Gitin blob-tiiviste (kuten `git hash-object`). */
export function gitBlobSha(buffer) {
  return crypto.createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
}

/**
 * Vastaako juuren tarjoiltava puu commitia? Lukee commitin puun TÄSTÄ
 * repositoriosta (`git ls-tree`, sama objektivarasto kuin työpuilla) ja
 * vertaa juuren tiedostoihin (CRLF sallitaan: core.autocrlf).
 *
 * @returns {{ ok: boolean, checked: number, differences: string[], error?: string }}
 */
export function treeMatchesCommit(root, sha, { repoRoot = ROOT, lsTree = defaultLsTree } = {}) {
  let listing;
  try {
    listing = lsTree(sha, repoRoot);
  } catch (error) {
    return { ok: false, checked: 0, differences: [], error: `git ls-tree ${sha}: ${error.message.split('\n')[0]}` };
  }
  const tracked = new Set();
  const differences = [];
  for (const line of listing.split('\n').filter(Boolean)) {
    const tab = line.indexOf('\t');
    const [, type, blob] = line.slice(0, tab).split(' ');
    const file = line.slice(tab + 1);
    if (type !== 'blob') continue;
    tracked.add(file);
    let content;
    try { content = fs.readFileSync(path.join(root, file)); } catch { differences.push(`puuttuu: ${file}`); continue; }
    const lf = Buffer.from(content.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    if (gitBlobSha(content) !== blob && gitBlobSha(lf) !== blob) differences.push(`muutettu: ${file}`);
  }
  const present = [];
  for (const entry of FINGERPRINT_ENTRIES) walk(root, entry, present);
  for (const file of present) if (!tracked.has(file)) differences.push(`ei commitissa: ${file}`);
  return { ok: differences.length === 0, checked: tracked.size, differences };
}

function defaultLsTree(sha, repoRoot) {
  return execFileSync('git', ['ls-tree', '-r', '--full-tree', sha, '--', ...FINGERPRINT_ENTRIES],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

// ------------------------------------------------------- luokittelu

/** Pyynnön luokka: local, inline, production, offline (odotettu esto) tai external. */
export function classifyUrl(url, localOrigin) {
  let parsed;
  try { parsed = new URL(url); } catch { return 'inline'; }
  if (['data:', 'blob:', 'about:', 'chrome:', 'devtools:'].includes(parsed.protocol)) return 'inline';
  if (parsed.origin === localOrigin) return 'local';
  if (PRODUCTION_HOST.test(parsed.hostname)) return 'production';
  if (EXPECTED_OFFLINE_HOSTS.includes(parsed.hostname.toLowerCase())) return 'offline';
  return 'external';
}

/** Selaimen URL -> ehdokkaan polku (1-pohjainen rivi). */
export function locate(url, line, column, localOrigin) {
  if (!url) return null;
  let where = url;
  if (localOrigin && url.startsWith(localOrigin)) {
    where = url.slice(localOrigin.length).replace(/^\//, '').split('?')[0];
    if (where.startsWith(SMOKE_PREFIX.slice(1))) where = `[savu] ${SMOKE_FILES[where.slice(SMOKE_PREFIX.length - 1)] || where}`;
  }
  return Number.isInteger(line) ? `${where}:${line}${Number.isInteger(column) ? `:${column}` : ''}` : where;
}

/** Ensimmäinen sijainti virheen pinosta ("at f (http://…/src/x.js:12:5)"). */
export function firstStackLocation(text, localOrigin) {
  const match = /(https?:\/\/[^\s()]+?):(\d+):(\d+)/.exec(String(text || ''));
  return match ? locate(match[1], Number(match[2]), Number(match[3]), localOrigin) : null;
}

function cdpFrameLocation(frame, localOrigin) {
  if (!frame || !frame.url) return null;
  return locate(frame.url, frame.lineNumber + 1, frame.columnNumber + 1, localOrigin);
}

/** CDP Runtime.exceptionThrown -> { kind, message, location }. */
export function describeException(details, localOrigin) {
  const text = String(details.text || '');
  const description = details.exception && details.exception.description ? String(details.exception.description) : '';
  const kind = /\(in promise\)/.test(text) ? 'rejection' : 'exception';
  const message = `${text}${description && !text.includes(description.split('\n')[0]) ? ' ' + description.split('\n')[0] : ''}`.trim();
  const frame = details.stackTrace && details.stackTrace.callFrames && details.stackTrace.callFrames[0];
  const location = firstStackLocation(description, localOrigin)
    || cdpFrameLocation(frame, localOrigin)
    || (details.url ? locate(details.url, details.lineNumber + 1, details.columnNumber + 1, localOrigin) : null);
  return { kind, message, location };
}

/** CDP Runtime.consoleAPICalled (error) -> { kind, message, location, origin }. */
export function describeConsole(params, localOrigin) {
  const parts = (params.args || []).map(arg => (arg.value !== undefined ? String(arg.value) : String(arg.description || arg.type)));
  const message = parts.map(part => part.split('\n')[0]).join(' ');
  const origin = parts.map(part => firstStackLocation(part, localOrigin)).find(Boolean) || null;
  const frame = params.stackTrace && params.stackTrace.callFrames && params.stackTrace.callFrames[0];
  return { kind: 'console', message, location: cdpFrameLocation(frame, localOrigin), origin };
}

// ------------------------------------------------------------- CDP

async function cdpReachable(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Heittää, jos portissa vastaa jo jokin (vieras Chrome): siihen ei liitytä. */
export async function assertDebugPortFree(port, probe = cdpReachable) {
  if (await probe(port)) throw new Error(`debug-portti ${port} on jo käytössä — ei liitytä vieraaseen prosessiin`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners) listener(message);
      }
    });
  }
  open() { return new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve); this.ws.addEventListener('error', reject); }); }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(listener) { this.listeners.push(listener); }
  close() { this.ws.close(); }
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`aikakatkaisu (${ms} ms): ${label}`)), ms); })
  ]);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Sulje OMA Chrome hallitusti (Browser.close sen omaan selainpäätteeseen),
 * odota prosessin loppu ja tapa vasta sitten. Hallittu sulku vapauttaa
 * profiilin tiedostot, jolloin siivous ei törmää Windowsin EPERMiin.
 */
async function closeBrowser(browser, browserWsUrl) {
  const exited = new Promise(resolve => {
    if (browser.exitCode !== null || browser.signalCode !== null) resolve();
    else browser.once('exit', resolve);
  });
  if (browserWsUrl) {
    try {
      const session = new Cdp(browserWsUrl);
      await withTimeout(session.open(), 2000, 'selainpääte');
      session.send('Browser.close').catch(() => {});
    } catch { /* tapetaan alla */ }
  }
  await Promise.race([exited, sleep(5000)]);
  if (browser.exitCode === null && browser.signalCode === null) browser.kill();
  await Promise.race([exited, sleep(3000)]);
}

// ----------------------------------------------------------- ajo

/** Samat virheet yhdeksi riviksi (renderAll toistaa saman joka tilamuutoksessa). */
export function groupIssues(issues) {
  const groups = new Map();
  for (const issue of issues) {
    const key = `${issue.kind}|${issue.message}|${issue.location || ''}|${issue.origin || ''}`;
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      if (!group.steps.includes(issue.step)) group.steps.push(issue.step);
    } else {
      groups.set(key, { ...issue, count: 1, steps: [issue.step] });
    }
  }
  return [...groups.values()];
}

async function run({ root, label, expectSha, gates = 'own' }) {
  const chrome = CHROME_CANDIDATES.find(candidate => fs.existsSync(candidate));
  if (!chrome) throw new Error('Chromea ei löytynyt; aseta CHROME_PATH');

  const head = readGitHead(root);
  const provenance = head.sha ? treeMatchesCommit(root, head.sha) : { ok: false, checked: 0, differences: [], error: 'HEAD ei luettavissa' };
  const before = fingerprintRoot(root);
  // J-porttitila: ehdokkaan schema.js luetaan (vain luku) ja korvattu versio
  // tarjoillaan muistista; juuren tiedosto ei muutu.
  const gateMode = gates === 'J'
    ? resolveGateMode('J', { cwd: ROOT, schemaSource: fs.readFileSync(path.join(root, 'src/data/schema.js'), 'utf8') })
    : { mode: 'own', source: null, provenance: 'ehdokkaan oma src/data/schema.js sellaisenaan' };

  const httpPort = await freePort();
  const debugPort = await freePort();
  await assertDebugPortFree(debugPort);
  const origin = `http://127.0.0.1:${httpPort}`;
  const served = [];
  const server = await startServer({ root, label, port: httpPort, served, gates, gatedSchemaSource: gateMode.source });
  const profile = profileDirFor({ root, label });
  fs.mkdirSync(profile, { recursive: true });
  const browser = spawn(chrome, chromeArgs({ debugPort, profile }), { stdio: 'ignore' });

  const issues = [];
  const requests = [];
  const blocked = [];
  const navigations = [];
  const steps = [];
  let step = 'käynnistys';
  let boot = null;
  let bootError = null;
  let stats = null;
  let cdp = null;
  let browserWsUrl = null;
  try {
    let version = null;
    for (let i = 0; i < 80 && !version; i++) {
      await sleep(100);
      try { version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); } catch { /* käynnistyy */ }
    }
    if (!version) throw new Error('Chrome ei käynnistynyt');
    if (!String(version.webSocketDebuggerUrl || '').includes(`:${debugPort}/`)) throw new Error('debug-portissa vastasi jokin muu kuin käynnistetty Chrome');
    browserWsUrl = version.webSocketDebuggerUrl;
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    cdp.on(message => {
      const { method, params } = message;
      if (method === 'Network.requestWillBeSent') requests.push({ url: params.request.url, step });
      else if (method === 'Fetch.requestPaused') {
        const kind = classifyUrl(params.request.url, origin);
        if (kind === 'local' || kind === 'inline') {
          cdp.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
        } else {
          blocked.push({ url: params.request.url, kind, step });
          cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
        }
      } else if (method === 'Runtime.exceptionThrown') {
        issues.push({ ...describeException(params.exceptionDetails, origin), step });
      } else if (method === 'Runtime.consoleAPICalled' && (params.type === 'error' || params.type === 'assert')) {
        issues.push({ ...describeConsole(params, origin), step });
      } else if (method === 'Log.entryAdded' && params.entry.level === 'error') {
        const url = params.entry.url || '';
        const kind = url ? classifyUrl(url, origin) : 'local';
        // Estetyn ulkoisen tiedoston latausvirhe on odotettu (offline); tuotanto kirjataan pyyntönä.
        if (params.entry.source === 'network' && (kind === 'offline' || kind === 'production' || kind === 'external')) return;
        issues.push({ kind: 'log', message: `${params.entry.source}: ${params.entry.text}`, location: url ? locate(url, null, null, origin) : null, step });
      } else if (method === 'Page.frameNavigated' && !params.frame.parentId) {
        navigations.push({ url: params.frame.url, step });
      }
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await cdp.send('Network.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });

    const evaluate = async (expression, ms = 20000) => {
      const response = await withTimeout(cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), ms, expression.slice(0, 60));
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return response.result.value;
    };

    await cdp.send('Page.navigate', { url: `${origin}${SMOKE_PREFIX}${SMOKE_PAGE}` });
    for (let i = 0; i < 400; i++) {
      await sleep(100);
      const ready = await evaluate('Boolean(window.__smoke && window.__smoke.ready) || (window.__smokeErrors || []).length > 0').catch(() => false);
      if (ready) break;
    }
    const harnessErrors = await evaluate('window.__smokeErrors || []').catch(() => ['ei vastausta']);
    if (harnessErrors.length) bootError = harnessErrors.join('; ');
    else if (!(await evaluate('Boolean(window.__smoke && window.__smoke.ready)').catch(() => false))) bootError = 'valjas ei valmistunut 40 sekunnissa';
    else boot = await evaluate('window.__smoke.info');

    if (boot && boot.appVisible && !boot.authGateOpen) {
      const nav = await evaluate('window.__smoke.navigation()');
      for (const tab of nav) {
        step = tab.label;
        const selector = JSON.stringify(`.tab-btn[data-screen="${tab.screen}"]`);
        const result = { kind: 'screen', screen: tab.screen, label: tab.label, exists: tab.exists };
        try {
          result.settled = await evaluate(`window.__smoke.tap(${selector})`);
          Object.assign(result, await evaluate(`window.__smoke.measure(${JSON.stringify(tab.screen)})`));
        } catch (error) {
          result.error = error.message.split('\n')[0];
        }
        steps.push(result);
        for (const segment of tab.segments) {
          step = `${tab.label} › ${segment.label}`;
          const seg = { kind: 'segment', screen: tab.screen, label: `${tab.label} › ${segment.label}`, id: segment.id, exists: true };
          try {
            seg.settled = await evaluate(`window.__smoke.tap(${JSON.stringify('#' + segment.id)})`);
            Object.assign(seg, await evaluate(`window.__smoke.measure(${JSON.stringify(tab.screen)}, ${JSON.stringify(segment.id)})`));
          } catch (error) {
            seg.error = error.message.split('\n')[0];
          }
          steps.push(seg);
        }
      }
      // Sovelluksen oma NYT-kierros (30 s) kerran heti, ei odotusta.
      step = 'ajastinkierros';
      const tick = { kind: 'tick', label: 'sovelluksen omat pitkät ajastimet kerran (NYT-kierros)' };
      try {
        tick.periods = await evaluate('window.__smoke.tick()');
      } catch (error) {
        tick.error = error.message.split('\n')[0];
      }
      steps.push(tick);
      step = 'lopetus';
      await evaluate('window.__smoke.settle({ quietMs: 500 })').catch(() => false);
    }
    stats = await evaluate('window.__smoke ? window.__smoke.stats() : null').catch(() => null);
  } finally {
    if (cdp) cdp.close();
    await closeBrowser(browser, browserWsUrl);
    server.close();
    await sleep(300);
    // Windows voi pitää profiilin tiedostoja hetken lukossa Chromen sulkeuduttua.
    // Siivouksen epäonnistuminen ei saa peittää varsinaista tulosta (EPERM).
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (error) {
      console.warn(`HUOM  väliaikaisprofiilia ei voitu poistaa (${error.code}); poista käsin: ${path.relative(ROOT, profile)}`);
    }
  }

  const after = fingerprintRoot(root);
  return { root, label, expectSha, gateMode, head, provenance, before, after, origin, boot, bootError, steps, issues, requests, blocked, navigations, served, stats };
}

// --------------------------------------------------------- tulos

/** Tulosrivit ja lopputulos. Puhdas funktio (testattavissa). */
export function evaluateRun(run) {
  const lines = [];
  const add = (ok, name, detail) => lines.push({ ok, name, detail });
  const shortSha = run.head && run.head.sha ? run.head.sha.slice(0, 7) : '?';

  if (run.expectSha) {
    add(Boolean(run.head && run.head.sha && run.head.sha.startsWith(run.expectSha)), 'HEAD on odotettu commit',
      `HEAD ${shortSha}, odotettu ${run.expectSha.slice(0, 7)}`);
    add(run.provenance.ok, 'tarjoiltu puu = commit (src, index.html, sw.js, manifest.json, vendor)',
      run.provenance.error || (run.provenance.ok ? `${run.provenance.checked} tiedostoa` : run.provenance.differences.slice(0, 5).join(', ')));
  }

  const boot = run.boot;
  if (run.gateMode && run.gateMode.mode === 'J') {
    const wanted = Object.entries(run.gateMode.matrix.tables);
    const live = boot && boot.gates && boot.gates.tables;
    const wrong = live ? wanted.filter(([gate, on]) => Boolean(live[gate]) !== on).map(([gate]) => gate) : ['ei luettavissa'];
    add(wrong.length === 0, 'J-portit voimassa selaimessa (import map)', wrong.length ? `poikkeavat: ${wrong.join(', ')}` : `${wanted.length} taulua`);
  }
  add(Boolean(boot && boot.appVisible && !boot.authGateOpen && !boot.startupError), 'käynnistys: istunto palautui, sovellus näkyy',
    run.bootError ? `valjas: ${run.bootError.split('\n').slice(0, 3).join(' | ')}`
      : !boot ? 'ei tulosta'
        : boot.startupError ? `käynnistysvirhe näkyy: ${boot.startupError}`
          : boot.authGateOpen ? 'kirjautumisportti auki: tekaistu istunto ei palautunut'
            : !boot.appVisible ? 'sovellus piilossa (#app.app-hidden)'
              : `${run.stats ? run.stats.queries : '?'} kyselyä; opastus: ${boot.onboarding}`);

  for (const result of run.steps) {
    if (result.kind === 'tick') {
      add(!result.error, result.label, result.error
        || (result.periods.length ? `${result.periods.length} ajastinta ajettu (${result.periods.map(ms => `${ms / 1000} s`).join(', ')})` : 'ei pitkiä ajastimia'));
      continue;
    }
    const what = result.kind === 'screen' ? `näyttö ${result.label} (${result.screen})` : `osio ${result.label} (${result.id})`;
    let ok = !result.error && result.exists && result.active && result.visible && result.textLength > 0;
    if (result.kind === 'segment') ok = ok && result.selected === true;
    const detail = result.error ? result.error
      : !result.exists ? 'näyttöä ei ole merkinnässä'
        : !result.active ? 'ei aktivoitunut'
          : !result.visible ? 'ei näkyvissä'
            : result.textLength === 0 ? 'TYHJÄ'
              : result.kind === 'segment' && result.selected !== true ? 'osiovälilehti ei valittuna'
                : `${result.textLength} merkkiä näkyvissä, +${result.dynamic} piirrettyä elementtiä${result.dynamic <= 0 ? ' (HUOM: ei piirrettyä sisältöä)' : ''}${result.settled === false ? ' (HUOM: kanta ei hiljentynyt)' : ''}`;
    add(ok, what, detail);
  }

  const grouped = groupIssues(run.issues);
  const describe = issue => `[${issue.steps.join(', ')}] ${issue.message}${issue.location ? ` — ${issue.location}` : ''}${issue.origin && issue.origin !== issue.location ? ` (heitetty: ${issue.origin})` : ''}${issue.count > 1 ? ` ×${issue.count}` : ''}`;
  const exceptions = grouped.filter(issue => issue.kind === 'exception');
  const rejections = grouped.filter(issue => issue.kind === 'rejection');
  const consoles = grouped.filter(issue => issue.kind === 'console' || issue.kind === 'log');
  add(exceptions.length === 0, 'ei käsittelemättömiä poikkeuksia', exceptions.map(describe).join('\n      ') || 'ei yhtään');
  add(rejections.length === 0, 'ei käsittelemättömiä hylkäyksiä (unhandled rejection)', rejections.map(describe).join('\n      ') || 'ei yhtään');
  add(consoles.length === 0, 'ei konsolivirheitä', consoles.map(describe).join('\n      ') || 'ei yhtään');

  const production = [...run.requests, ...run.blocked].filter(r => classifyUrl(r.url, run.origin) === 'production');
  const external = run.blocked.filter(r => r.kind === 'external');
  const offline = run.blocked.filter(r => r.kind === 'offline');
  add(production.length === 0, 'ei yhtään pyyntöä tuotantoon (Supabase/Anthropic/Vercel)',
    production.length ? [...new Set(production.map(r => `[${r.step}] ${r.url}`))].join(', ')
      : `${run.requests.length} pyyntöä, kaikki paikallisia${offline.length ? `; estetty odotettu ulkoinen lataus ${offline.length}` : ''}`);
  add(external.length === 0, 'ei tuntemattomia ulkoisia pyyntöjä', external.map(r => `[${r.step}] ${r.url}`).join(', ') || 'ei yhtään');
  const api = run.served.filter(entry => entry.kind === 'api');
  add(api.length === 0, 'ei palvelinkutsuja (/api/)', api.map(entry => entry.url).join(', ') || 'ei yhtään');
  const away = run.navigations.filter(nav => !nav.url.startsWith(`${run.origin}${SMOKE_PREFIX}`));
  add(away.length === 0, 'sivu pysyi valjaassa (ei uudelleenlatausta eikä poisnavigointia)', away.map(nav => `[${nav.step}] ${nav.url}`).join(', ') || 'kyllä');
  const missing = run.served.filter(entry => entry.kind === 'root' && entry.status === 404);
  add(missing.length === 0, 'ehdokkaan jokainen pyydetty tiedosto löytyi', missing.map(entry => entry.url).join(', ') || 'kyllä');
  const unsupported = run.stats ? run.stats.unsupported : [];
  add(unsupported.length === 0, 'kannan korvike tuki jokaisen kyselyn', unsupported.join(', ') || 'ei tukemattomia kyselyjä');
  const changes = fingerprintChanges(run.before, run.after);
  add(changes.length === 0, 'ehdokkaan puu koskematon (sisältötiivisteet ennen = jälkeen)',
    changes.slice(0, 5).join(', ') || `${Object.keys(run.before).length} tiedostoa`);

  const failed = lines.filter(line => !line.ok).length;
  return {
    lines, failed, passed: failed === 0,
    counts: { exceptions: exceptions.length, rejections: rejections.length, consoles: consoles.length, production: production.length }
  };
}

function report(run, verdict) {
  const writes = run.stats ? run.stats.writes : [];
  const writtenTables = [...new Set(writes.map(w => `${w.table}.${w.op}`))];
  console.log(`KÄYNNISTYSSAVU [${run.label}] — ${run.root}`);
  console.log(`  HEAD ${run.head.sha ? run.head.sha.slice(0, 7) : '?'}${run.head.ref ? ` (${run.head.ref})` : ' (irrotettu)'}; puu = HEAD: ${run.provenance.ok ? `kyllä (${run.provenance.checked} tiedostoa)` : `EI — ${run.provenance.error || run.provenance.differences.slice(0, 5).join(', ')}`}`);
  if (run.boot) {
    const gates = run.boot.gates || {};
    const open = gates.tables ? Object.entries(gates.tables).filter(([, on]) => on).map(([name]) => name) : [];
    const columns = gates.columns ? Object.entries(gates.columns).filter(([, on]) => on).map(([name]) => name) : [];
    console.log(`  portit (${run.gateMode ? run.gateMode.provenance : 'ehdokkaan omat'}): ${gates.tables ? `${open.length}/${Object.keys(gates.tables).length} taulua auki` : `ei TABLES-lohkoa${gates.error ? ` (${gates.error})` : ''}`}${gates.columns ? `; sarakeportit auki: ${columns.join(', ') || 'ei yhtään'}` : ''}`);
    console.log(`  sovitus: ${run.boot.adaptations.join('; ')}`);
    console.log(`  siemen: omistaja ${run.boot.userId}, päivä ${run.boot.todayIso}: ${Object.entries(run.boot.seed).map(([t, n]) => `${t} ${n}`).join(', ')}`);
  }
  console.log(`  käynnistyksen ja napautusten kirjoitukset kantaan: ${writtenTables.join(', ') || 'ei yhtään'}`);
  for (const line of verdict.lines) console.log(`${line.ok ? 'PASS' : 'FAIL'}  ${line.name}\n      ${line.detail}`);
  const c = verdict.counts;
  console.log(`\nKÄYNNISTYSSAVU [${run.label}]: ${verdict.passed ? 'PASS' : 'FAIL'} (${verdict.lines.length - verdict.failed}/${verdict.lines.length}; poikkeuksia ${c.exceptions}, hylkäyksiä ${c.rejections}, konsolivirheitä ${c.consoles}, tuotantopyyntöjä ${c.production})`);
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`KÄYNNISTYSSAVU: käyttövirhe — ${error.message}`);
      console.error('  käyttö: node tools/e2e/boot-smoke.mjs --root <ehdokkaan työpuu> --label <X> [--expect-sha <sha>] [--gates J]');
      return 2;
    }
    throw error;
  }
  const result = await run(options);
  const verdict = evaluateRun(result);
  report(result, verdict);
  return verdict.passed ? 0 : 1;
}

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const invokedDirectly = Boolean(process.argv[1]) && samePath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then(code => { process.exitCode = code; }, error => {
    console.error('KÄYNNISTYSSAVU: KESKEYTYI —', error.message);
    process.exitCode = 1;
  });
}
