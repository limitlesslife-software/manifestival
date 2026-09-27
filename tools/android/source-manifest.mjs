// Ehdokkaan LÄHDEMANIFESTI ja MainActivity ennen koontia.
//
// verify-apk tarkistaa valmiin APK:n yhdistetyn manifestin (tools/android/
// apk.mjs). Tämä moduuli tarkistaa saman vaatimuksen lähteen tasolla, jotta
// esitarkistus (tools/android/preflight.mjs, tarkistus `manifest.source`)
// kaatuu HETI, jos ehdokkaalta puuttuvat puhe- ja sijaintimuutokset — eikä
// vasta minuuttien Gradle-koonnin jälkeen.
//
// Lähdemanifestilta vaaditaan:
//   - uses-permission-joukko on APK_PERMISSION_ALLOWLISTin osajoukko
//   - RECORD_AUDIO on mukana (repon oma SpeechPlugin)
//   - ei yhtään sijaintilupaa (ACCESS_*LOCATION) eikä kiellettyä lupaa
//   - <queries> sisältää android.speech.RecognitionService ja
//     android.intent.action.TTS_SERVICE
// ja MainActivitylta, että se rekisteröi SpeechPluginin ja AlarmPluginin
// ennen super.onCreatea (muuten liitännäinen ei päädy siltaan).
//
// Puhdas: saa tiedostojen SISÄLLÖN merkkijonoina.

import {
  APK_PERMISSION_ALLOWLIST, REQUIRED_QUERY_INTENT_ACTIONS, expectedPermissions,
  isForbiddenPermission, manifestFacts
} from './apk.mjs';

/** Lähdemanifesti työpuun juuresta. */
export const SOURCE_MANIFEST = 'android/app/src/main/AndroidManifest.xml';

/** MainActivity työpuun juuresta. */
export const MAIN_ACTIVITY = 'android/app/src/main/java/fi/limitlesslife/manifestival/MainActivity.java';

/** Mikrofonilupa, jota SpeechPlugin tarvitsee. */
export const SPEECH_PERMISSION = 'android.permission.RECORD_AUDIO';

const LOCATION_PERMISSION = /^android\.permission\.ACCESS_\w*LOCATION$/;
const TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITIES = Object.freeze({ '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' });

function decode(value) {
  return value.replace(/&(?:lt|gt|quot|apos|amp);/g, entity => ENTITIES[entity]);
}

/**
 * Lähdemanifestin XML puuksi, samaan muotoon kuin parseXmlTree (apk.mjs)
 * tuottaa aapt2:n tulosteesta, joten manifestFacts toimii molemmille.
 * Kommentit ohitetaan: niissä saa mainita lupia.
 */
export function parseManifestXml(text) {
  const source = String(text || '').replace(/^﻿/, '').replace(/<!--[\s\S]*?-->/g, '');
  const root = { name: '#document', line: null, attrs: {}, children: [] };
  const stack = [root];
  for (const [, closing, name, attributeText, selfClosing] of source.matchAll(TAG)) {
    if (closing) {
      const index = stack.map(element => element.name).lastIndexOf(name);
      if (index > 0) stack.length = index;
      continue;
    }
    const attrs = {};
    for (const [, key, double, single] of attributeText.matchAll(ATTRIBUTE)) attrs[key] = decode(double ?? single);
    const element = { name, line: null, attrs, children: [] };
    stack[stack.length - 1].children.push(element);
    if (!selfClosing) stack.push(element);
  }
  return root;
}

function walk(element, visit) {
  for (const child of element.children) {
    visit(child);
    walk(child, visit);
  }
}

/**
 * Lähdemanifestin tiedot. `permissions` kerätään KOKO puusta (myös väärin
 * sisäkkäisistä elementeistä), jottei rikkinäinen rakenne piilota
 * sijaintilupaa. `tools:node="remove"` on poistomerkintä, ei julistus.
 */
export function sourceManifestFacts(text) {
  const tree = parseManifestXml(text);
  const facts = manifestFacts(tree);
  if (!facts) return null;
  const permissions = [];
  const removed = [];
  walk(tree, element => {
    if (element.name !== 'uses-permission' && element.name !== 'uses-permission-sdk-23') return;
    const name = element.attrs['android:name'];
    if (!name) return;
    if (/^remove/.test(element.attrs['tools:node'] || '')) removed.push(name);
    else permissions.push(name);
  });
  return { ...facts, permissions, removedPermissions: removed };
}

/** MainActivity ilman kommentteja: rekisteröinnin on oltava koodia. */
function javaCode(source) {
  return String(source || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/).filter(line => !line.trim().startsWith('//')).join('\n');
}

/** Repon omat natiiviliitännäiset, jotka MainActivityn on rekisteröitävä ennen super.onCreatea. */
export const REQUIRED_PLUGIN_CLASSES = Object.freeze(['SpeechPlugin', 'AlarmPlugin']);

/** Rekisteröikö MainActivity annetun liitännäisluokan ENNEN super.onCreatea? */
export function registersPlugin(mainActivitySource, className) {
  if (!/^[A-Z]\w*$/.test(String(className))) return false;
  const code = javaCode(mainActivitySource);
  const register = code.search(new RegExp(`registerPlugin\\(\\s*${className}\\.class\\s*\\)`));
  const superCreate = code.indexOf('super.onCreate(');
  return register > -1 && superCreate > -1 && register < superCreate;
}

/** Rekisteröikö MainActivity SpeechPluginin ENNEN super.onCreatea? */
export function registersSpeechPlugin(mainActivitySource) {
  return registersPlugin(mainActivitySource, 'SpeechPlugin');
}

/** Rekisteröikö MainActivity AlarmPluginin (herätys) ENNEN super.onCreatea? */
export function registersAlarmPlugin(mainActivitySource) {
  return registersPlugin(mainActivitySource, 'AlarmPlugin');
}

/**
 * Ongelmat lähdemanifestissa ja MainActivityssä (tyhjä = kunnossa).
 *
 * @param {object} input
 * @param {string|null} input.manifest AndroidManifest.xml:n sisältö (null = puuttuu)
 * @param {string|null} input.mainActivity MainActivity.javan sisältö (null = puuttuu)
 * @returns {string[]}
 */
export function sourceManifestProblems({ manifest, mainActivity }) {
  const problems = [];
  const facts = manifest === null || manifest === undefined ? null : sourceManifestFacts(manifest);
  if (!facts) {
    problems.push(manifest === null || manifest === undefined
      ? `${SOURCE_MANIFEST} puuttuu` : `${SOURCE_MANIFEST}: <manifest>-elementtiä ei löydy`);
  } else {
    const allowed = new Set([...APK_PERMISSION_ALLOWLIST, ...expectedPermissions()]);
    const location = facts.permissions.filter(p => LOCATION_PERMISSION.test(p));
    const forbidden = facts.permissions.filter(p => isForbiddenPermission(p) && !location.includes(p));
    const unknown = facts.permissions.filter(p => !allowed.has(p) && !location.includes(p) && !forbidden.includes(p));
    if (location.length) problems.push('sijaintilupa: ' + location.join(', '));
    if (forbidden.length) problems.push('kielletty lupa: ' + forbidden.join(', '));
    if (unknown.length) problems.push('lupa ei kuulu sallittuun joukkoon (APK_PERMISSION_ALLOWLIST): ' + unknown.join(', '));
    if (!facts.permissions.includes(SPEECH_PERMISSION)) problems.push(`${SPEECH_PERMISSION} puuttuu`);
    const missingQueries = REQUIRED_QUERY_INTENT_ACTIONS.filter(a => !facts.queryIntentActions.includes(a));
    if (missingQueries.length) problems.push('<queries><intent><action> puuttuu: ' + missingQueries.join(', '));
  }
  if (mainActivity === null || mainActivity === undefined) problems.push(`${MAIN_ACTIVITY} puuttuu`);
  else {
    for (const className of REQUIRED_PLUGIN_CLASSES) {
      if (!registersPlugin(mainActivity, className)) {
        problems.push(`MainActivity ei rekisteröi ${className}ia ennen super.onCreatea`);
      }
    }
  }
  return problems;
}
