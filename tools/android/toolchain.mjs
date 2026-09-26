// Android-työkaluketju: polut, työkalujen ajaminen ja puiden lukeminen.
//
// Kaikki ulkoiset prosessit kulkevat tämän moduulin kautta, ja jokainen
// funktio ottaa ajajan (spawn/git) parametrina. Testit antavat omansa;
// yksikään testi ei aja aapt2:ta, apksigneria, gitiä eikä Gradlea.
//
// MIKSI apksigner AJETAAN java -jar -MUODOSSA
//
// build-tools/<versio>/apksigner.bat on pelkkä kääre: se etsii java.exe:n
// JAVA_HOMEsta ja ajaa `java -Xmx1024M -Xss1m -jar lib/apksigner.jar`.
// Node ei aja .bat-tiedostoja ilman komentotulkkia (CVE-2024-27980), ja
// cmd.exe:n lainausmerkkisäännöt rikkoivat polun välilyönnit. Sama
// komento suoraan JDK 21:n java.exe:llä on täsmälleen sama asia ilman
// kääreen ongelmia.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { WEB_DIRECTORIES, WEB_ROOT_FILES, isWebBuildPath } from './apk.mjs';

/** build-tools-versio, jolla tarkastus ajetaan. */
export const BUILD_TOOLS_VERSION = '36.0.0';

/** Tämän koneen oletukset (vain vihjeiksi virheilmoituksiin). */
export const KNOWN_SDK_DIR = 'C:/Users/info/AppData/Local/Android/Sdk';
export const KNOWN_JDK21_DIR = 'C:/Program Files/Eclipse Adoptium/jdk-21.0.12.101-hotspot';

const isWindows = process.platform === 'win32';
const exe = name => (isWindows ? name + '.exe' : name);

/** org.gradle.java.home android/gradle.properties -tekstistä, tai null. */
export function readGradleJavaHome(propertiesText) {
  for (const raw of String(propertiesText || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#') || line.startsWith('!')) continue;
    const m = /^org\.gradle\.java\.home\s*[=:]\s*(.+)$/.exec(line);
    if (m) return m[1].trim().replace(/\\\\/g, '\\').replace(/\\:/g, ':');
  }
  return null;
}

/** sdk.dir android/local.properties -tekstistä, tai null. */
export function readLocalPropertiesSdk(text) {
  const m = /^\s*sdk\.dir\s*=\s*(.+)$/m.exec(String(text || ''));
  return m ? m[1].trim().replace(/\\\\/g, '\\').replace(/\\:/g, ':') : null;
}

/**
 * Android SDK -hakemisto: --sdk, ANDROID_HOME, ANDROID_SDK_ROOT, työpuun tai
 * repon android/local.properties (gitignorattu, konekohtainen).
 * @returns {{ dir: string|null, source: string }}
 */
export function resolveSdkDir({ override = null, env = process.env, worktree = null, repoRoot = null,
  exists = fs.existsSync, readFile = file => fs.readFileSync(file, 'utf8') } = {}) {
  const candidates = [];
  if (override) candidates.push([override, '--sdk']);
  if (env.ANDROID_HOME) candidates.push([env.ANDROID_HOME, 'ANDROID_HOME']);
  if (env.ANDROID_SDK_ROOT) candidates.push([env.ANDROID_SDK_ROOT, 'ANDROID_SDK_ROOT']);
  for (const [root, label] of [[worktree, 'työpuun'], [repoRoot, 'repon']]) {
    if (!root) continue;
    const file = path.join(root, 'android', 'local.properties');
    if (exists(file)) {
      const dir = readLocalPropertiesSdk(readFile(file));
      if (dir) candidates.push([dir, `${label} android/local.properties`]);
    }
  }
  for (const [dir, source] of candidates) {
    if (exists(dir)) return { dir, source };
  }
  return { dir: null, source: candidates.length ? 'ehdokkaita ei löytynyt levyltä' : 'ei ehdokkaita' };
}

/**
 * JDK 21 -hakemisto: --jdk, työpuun org.gradle.java.home, repon
 * org.gradle.java.home. Palauttaa myös, mistä arvo tuli.
 * @returns {{ dir: string|null, source: string, pinned: string|null }}
 */
export function resolveJdkDir({ override = null, worktree = null, repoRoot = null,
  exists = fs.existsSync, readFile = file => fs.readFileSync(file, 'utf8') } = {}) {
  const pinOf = root => {
    const file = path.join(root, 'android', 'gradle.properties');
    return exists(file) ? readGradleJavaHome(readFile(file)) : null;
  };
  const pinned = worktree ? pinOf(worktree) : null;
  if (override) return { dir: override, source: '--jdk', pinned };
  if (pinned) return { dir: pinned, source: 'työpuun android/gradle.properties', pinned };
  const repoPin = repoRoot ? pinOf(repoRoot) : null;
  if (repoPin) return { dir: repoPin, source: 'repon android/gradle.properties', pinned: null };
  return { dir: null, source: 'org.gradle.java.home puuttuu', pinned: null };
}

/** Työkalujen polut SDK- ja JDK-hakemistoista. */
export function toolPaths({ sdkDir, jdkDir, buildTools = BUILD_TOOLS_VERSION }) {
  const bt = path.join(sdkDir, 'build-tools', buildTools);
  return {
    buildToolsDir: bt,
    aapt2: path.join(bt, exe('aapt2')),
    apksignerJar: path.join(bt, 'lib', 'apksigner.jar'),
    java: jdkDir ? path.join(jdkDir, 'bin', exe('java')) : null
  };
}

/** Oletusajaja: synkroninen prosessi, stdout+stderr talteen. */
export function defaultSpawn(file, args, options = {}) {
  const { encoding, ...rest } = options;
  const result = spawnSync(file, args, {
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    ...rest,
    encoding: encoding === 'buffer' ? 'buffer' : 'utf8'
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * aapt2- ja apksigner-ajajat.
 * @returns {{ aapt2: (args: string[]) => string, apksigner: (args: string[]) => string }}
 */
export function makeToolRunners({ sdkDir, jdkDir, spawn = defaultSpawn }) {
  const paths = toolPaths({ sdkDir, jdkDir });
  const run = (file, args, env) => {
    const result = spawn(file, args, env ? { env: { ...process.env, ...env } } : {});
    if (result.status !== 0) {
      throw new Error(`${path.basename(file)} ${args.join(' ')} päättyi koodiin ${result.status}: `
        + String(result.stderr || result.stdout || '').trim().slice(0, 500));
    }
    return String(result.stdout || '');
  };
  return {
    paths,
    aapt2: args => run(paths.aapt2, args),
    apksigner: args => {
      if (!paths.java) throw new Error('apksigner tarvitsee JDK:n (--jdk tai org.gradle.java.home)');
      return run(paths.java, ['-Xmx1024M', '-Xss1m', '-jar', paths.apksignerJar, ...args], { JAVA_HOME: jdkDir });
    }
  };
}

/** git-ajaja työpuulle: palauttaa Bufferin. Vain lukevia komentoja. */
export function makeGit(worktree, spawn = defaultSpawn) {
  return (args, { input } = {}) => {
    // input Bufferina: merkkijonona spawnSync koodaisi sen `encoding`-
    // asetuksella, eikä 'buffer' ole Bufferin merkistökoodaus.
    const result = spawn('git', ['-C', worktree, '--no-optional-locks', ...args],
      { encoding: 'buffer', input: input === undefined ? undefined : Buffer.from(input, 'utf8') });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')}: ${Buffer.from(result.stderr || '').toString('utf8').trim()}`);
    }
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
  };
}

/** Hakemistopuu Mapiksi: suhteellinen polku (/) -> tavut. */
export function readTree(root, { fsImpl = fs } = {}) {
  const files = new Map();
  const walk = dir => {
    for (const entry of fsImpl.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(path.relative(root, full).split(path.sep).join('/'), fsImpl.readFileSync(full));
    }
  };
  walk(root);
  return new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** `git ls-tree -r -z` -tuloste: [{ mode, type, oid, path }]. */
export function parseLsTree(buffer) {
  return Buffer.from(buffer).toString('utf8').split('\0').filter(Boolean).map(record => {
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    return { mode, type, oid, path: record.slice(tab + 1) };
  });
}

/** `git cat-file --batch` -tuloste: oid -> sisältö. */
export function parseCatFileBatch(buffer) {
  const out = new Map();
  let p = 0;
  while (p < buffer.length) {
    const newline = buffer.indexOf(10, p);
    if (newline === -1) break;
    const header = buffer.toString('utf8', p, newline);
    const [oid, type, size] = header.split(' ');
    if (type === 'missing' || size === undefined) throw new Error(`git cat-file: ${header}`);
    const start = newline + 1;
    const end = start + Number(size);
    out.set(oid, buffer.subarray(start, end));
    p = end + 1;
  }
  return out;
}

/**
 * Commitin web-koontiin kuuluvat blobit (build-web.mjs:n säännöin).
 * @param {(args: string[], opts?: object) => Buffer} git
 */
export function readGitWebTree(git, commit) {
  const entries = parseLsTree(git(['ls-tree', '-r', '-z', commit, '--', ...WEB_ROOT_FILES, ...WEB_DIRECTORIES]))
    .filter(e => e.type === 'blob' && isWebBuildPath(e.path));
  if (entries.length === 0) return new Map();
  const blobs = parseCatFileBatch(git(['cat-file', '--batch'], { input: entries.map(e => e.oid).join('\n') + '\n' }));
  const tree = new Map();
  for (const entry of entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    tree.set(entry.path, blobs.get(entry.oid));
  }
  return tree;
}

/** SHA-256 heksana (pienet kirjaimet). */
export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Hakemistopuun tunniste: tiedostojen määrä ja SHA-256 riveistä
 * `<sha256>  <polku>\n` polkujärjestyksessä (sha256sum-muoto). Riippuu
 * vain sisällöstä ja poluista, ei järjestyksestä jossa ne luettiin.
 */
export function treeDigest(files) {
  const lines = [...files.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, bytes]) => `${sha256Hex(bytes)}  ${file}\n`)
    .join('');
  return { fileCount: files.size, sha256: sha256Hex(Buffer.from(lines, 'utf8')) };
}

/** Gradle-versio gradle-wrapper.properties:n distributionUrl:sta. */
export function readGradleVersion(wrapperProperties) {
  const m = /gradle-([\d.]+)-(?:all|bin)\.zip/.exec(String(wrapperProperties || ''));
  return m ? m[1] : null;
}

/** AGP-versio android/build.gradle:sta. */
export function readAgpVersion(rootBuildGradle) {
  const m = /com\.android\.tools\.build:gradle:([\d.]+)/.exec(String(rootBuildGradle || ''));
  return m ? m[1] : null;
}
