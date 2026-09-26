// origin/mainin todellisen tilan lukeminen -- paikallisesti, ei verkkoa.
//
// MIKSI TÄMÄ ON OLEMASSA
//
// docs/RELEASE-SEQUENCING.md dokumentoi tarkasti sen, että tämän haaran
// docs/PRODUCTION-STATUS.md, sw.js ja tools/release/waves.mjs:n
// `PRODUCTION`-vakio kuvaavat maailmaa SELLAISENA KUIN SE OLI kun tämä
// haara erkani junasta -- eivät sitä mitä `origin/main` on JUURI NYT.
// `tests/release-sequencing.test.mjs` sanoo tämän suoraan omassa
// kommentissaan: se lukee vain tätä puuta, "eikä ota verkkoa, joten se
// ei voi tietää mikä tuotannossa oikeasti on."
//
// Se on juuri se aukko, josta koko tämän moduulin syy syntyy: kolme
// yhtäpitävää mutta vanhentunutta lähdettä (schema.js, sw.js,
// PRODUCTION-STATUS.md) on JOHDONMUKAINEN keskenään ja silti VÄÄRÄ,
// koska mikään niistä ei koskaan lue mitään tämän puun ulkopuolelta.
//
// Tämä moduuli täyttää sen aukon -- mutta ilman verkkoa. `git show
// origin/main:...` lukee paikallisen git-objektikannan; se ei ota
// yhteyttä mihinkään, koska `origin/main` on jo noudettu ennen kuin
// testejä ajetaan. Jos sitä EI ole noudettu paikallisesti (matala
// kloonaus, täysin verkoton ympäristö), moduuli palauttaa
// `available: false` eikä yritäkään ottaa yhteyttä. Testit, jotka
// käyttävät tätä, EIVÄT SAA vaatia verkkoa toimiakseen paikallisesti --
// niiden on kohdeltava `available: false` hyväksyttävänä tilana, ei
// virheenä.
//
// MITÄ TÄMÄ EI TEE
//
// Ei fetchaa, ei pushaa, ei aja migraatioita, ei deployaa, ei kirjoita
// mihinkään. Pelkkää paikallisen git-historian lukua.

import { execFileSync } from 'node:child_process';

import { RELEASE_WAVE_TRAILER, fileAtCommit, git, gitAvailable } from './manifest.mjs';
import { ROOT, parseCacheVersion, parseGates } from './state.mjs';
import { resolveWave } from './waves.mjs';

export const ORIGIN_MAIN = 'origin/main';

/** Versionumero lukuna. 'v15' -> 15, tai null jos muoto ei täsmää. */
export function versionNumber(value) {
  const match = /^v(\d+)$/.exec(String(value));
  return match ? Number(match[1]) : null;
}

/** Onko `origin/main` paikallisesti ratkaistavissa juuri nyt? Ei verkkoa. */
export function originMainAvailable() {
  if (!gitAvailable()) return false;
  return git(['rev-parse', '--verify', '-q', `${ORIGIN_MAIN}^{commit}`]) !== null;
}

/**
 * Onko `ancestorRef` esi-isä `descendantRef`:lle?
 *
 * `git merge-base --is-ancestor` ei tulosta mitään -- vastaus on
 * poistumiskoodi. 0 = kyllä, 1 = ei, mikä tahansa muu = todellinen
 * virhe (esim. ratkeamaton revisio) eikä kyllä/ei-vastaus.
 *
 * @returns {boolean|null} null jos kysymykseen ei voitu vastata
 */
export function isAncestor(ancestorRef, descendantRef) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestorRef, descendantRef],
      { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch (err) {
    if (err && err.status === 1) return false;
    return null;
  }
}

/**
 * `origin/main`in todellinen tila juuri nyt, luettuna suoraan gitistä
 * -- ei tämän puun tiedostoista.
 *
 * @returns {{
 *   available: boolean, sha: string|null, cacheVersion: string|null,
 *   gates: object|null, wave: string|null
 * }}
 */
export function originMainState() {
  if (!originMainAvailable()) {
    return { available: false, sha: null, cacheVersion: null, gates: null, wave: null };
  }

  const sha = git(['rev-parse', ORIGIN_MAIN]);
  const swSource = fileAtCommit(ORIGIN_MAIN, 'sw.js');
  const schemaSource = fileAtCommit(ORIGIN_MAIN, 'src/data/schema.js');

  const cacheVersion = parseCacheVersion(swSource);
  // allowMissing: origin/main saattaa tuntea vähemmän portteja kuin
  // tämä haara (esim. aallon H portit eivät ole vielä olemassa
  // origin/mainissa). Puuttuva portti on siellä kiinni -- ei virhe.
  const gates = parseGates(schemaSource, { allowMissing: true });
  const wave = gates ? resolveWave(gates) : null;

  return { available: true, sha, cacheVersion, gates, wave };
}

/**
 * Sama kuin `originMainState()`, mutta injektoidun git-kerroksen kautta
 * (tools/release/git-layer.mjs). Orkestroija ja dry-run käyttävät tätä,
 * jotta testit voivat antaa tynkähistorian.
 */
export function originMainStateFrom(gitLayer) {
  const sha = gitLayer.revParse(ORIGIN_MAIN);
  if (!sha) return { available: false, sha: null, cacheVersion: null, gates: null, wave: null };
  const cacheVersion = parseCacheVersion(gitLayer.show(sha, 'sw.js'));
  const gates = parseGates(gitLayer.show(sha, 'src/data/schema.js'), { allowMissing: true });
  const wave = gates ? resolveWave(gates) : null;
  return { available: true, sha, cacheVersion, gates, wave };
}

/**
 * LINEAGE-CHECK-rivin jäsennys docs/RELEASE-SEQUENCING.md:stä.
 *
 * @returns {{sha: string, cache: string}|null}
 */
export function parseLineageCheck(doc) {
  const match = /LINEAGE-CHECK: origin\/main sha=([0-9a-f]{40}) cache=(v\d+)/.exec(String(doc || ''));
  return match ? { sha: match[1], cache: match[2] } : null;
}

/**
 * Dokumentoitu origin/main-tila vs todellinen -- SUKULINJANA, ei
 * yhtäsuuruutena (ACT-03).
 *
 * MIKSI EI YHTÄSUURUUS
 *
 * Aiempi testi vaati, että dokumentin SHA ON origin/main. Se testi on
 * jäädytetyissä ehdokkaissa H, I ja J, ja jokainen deploy siirtää
 * origin/mainia: heti aallon D pushin jälkeen jokaisen jäädytetyn
 * ehdokkaan oma testipatteristo kaatui, vaikka mikään ei ollut vialla.
 * Dokumentti ei valehtele, jos se nimeää tuotannon AIEMMAN tilan: se on
 * vain jäljessä. Valhe on vain se, että dokumentti nimeää SHA:n, joka ei
 * ole koskaan ollut tuotannossa (ei ole origin/mainin esi-isä), tai
 * väittää suurempaa välimuistiversiota kuin tuotannossa on.
 *
 * @param {{sha: string, cache: string}} documented
 * @param {{sha: string, cacheVersion: string}} origin
 * @param {(a: string, b: string) => boolean|null} isAncestorFn
 * @returns {{ok: boolean, problems: string[], behind: boolean}}
 */
export function lineageCheck(documented, origin, isAncestorFn) {
  const problems = [];
  if (!documented || !documented.sha) {
    return { ok: false, problems: ['LINEAGE-CHECK-riviä ei ole'], behind: false };
  }
  if (!origin || !origin.sha) {
    return { ok: false, problems: ['origin/main ei ole saatavilla'], behind: false };
  }
  const equal = documented.sha === origin.sha;
  if (!equal) {
    const ancestor = isAncestorFn(documented.sha, origin.sha);
    if (ancestor === null) {
      problems.push(`dokumentoitua SHA:ta ${documented.sha} ei voitu verrata origin/mainiin `
        + '(puuttuuko commit paikallisesta historiasta?)');
    } else if (ancestor === false) {
      problems.push(`dokumentoitu SHA ${documented.sha} ei ole origin/mainin (${origin.sha}) `
        + 'esi-isä -- dokumentti nimeää commitin, joka ei ole ollut tuotannossa');
    }
  }
  const documentedNumber = versionNumber(documented.cache);
  const originNumber = versionNumber(origin.cacheVersion);
  if (documentedNumber === null || originNumber === null) {
    problems.push(`välimuistiversiota ei voitu verrata (${documented.cache} / ${origin.cacheVersion})`);
  } else if (equal && documentedNumber !== originNumber) {
    problems.push(`sama SHA mutta eri välimuistiversio: dokumentti ${documented.cache}, `
      + `origin/main ${origin.cacheVersion}`);
  } else if (documentedNumber > originNumber) {
    problems.push(`dokumentti väittää välimuistiversiota ${documented.cache}, `
      + `mutta origin/main on ${origin.cacheVersion}`);
  }
  return { ok: problems.length === 0, problems, behind: !equal };
}

/**
 * Onko TÄMÄ haara `origin/main`in jälkeläinen -- ts. sisältääkö se
 * kaiken, mitä `origin/main`issa on juuri nyt?
 *
 * `false` ei ole itsessään virhe: tuotepakettihaarat (Talous 2.0,
 * Tavoitteesta tekemiseksi, Henkilökohtainen avustaja) erkanivat
 * junasta TAHALLAAN ennen aaltoja A ja B. Se on kuitenkin täsmälleen
 * se tieto, jonka nojalla tämän haaran PRODUCTION-STATUS.md ei saa
 * väittää itseään ajantasaiseksi kuvaksi origin/mainista.
 *
 * @returns {boolean|null} null jos origin/main ei ole paikallisesti
 *   saatavilla
 */
export function isDescendantOfOriginMain() {
  if (!originMainAvailable()) return null;
  return isAncestor(ORIGIN_MAIN, 'HEAD');
}

/**
 * Onko HEAD irrallinen (detached) tässä työpuussa?
 *
 * MIKSI TÄMÄ ON OLEMASSA
 *
 * `git branch --show-current` palauttaa tyhjän merkkijonon myös
 * irrallisella HEADilla, mutta se EI kerro EROA "irrallinen" ja
 * "haaraa ei voitu lukea" välillä. `activation-preflight.mjs` käytti
 * pelkkää haaran nimen pituutta tunnistaakseen sen -- ja koska
 * irrallinen HEAD ON kelvollinen tila (esim. julkaisuautomaatio, joka
 * tarkistaa nimetyn commitin eikä haaraa), sen ei pitäisi tuottaa
 * FAILia joka näyttää samalta kuin oikea porttivika. `git symbolic-ref`
 * on tarkka väline juuri tähän: se onnistuu JOS JA VAIN JOS HEAD
 * osoittaa haaraan.
 *
 * @param {string} [cwd] mistä työpuusta kysytään -- oletus tämä repo
 * @returns {boolean|null} null jos git ei ole käytettävissä
 */
export function isDetachedHead(cwd = ROOT) {
  if (!gitAvailable(cwd)) return null;
  return git(['symbolic-ref', '-q', 'HEAD'], cwd) === null;
}

/**
 * Mitä aaltoa annettu commit vastaa `Release-Wave:`-trailerin
 * perusteella -- KESTÄVÄ tunniste, joka ei koskaan lue haaran nimeä.
 *
 * TÄMÄ ON SE, JOKA KORVAA HAARAN NIMEEN NOJAAVAN PÄÄTTELYN. `ref`
 * ratkaistaan `cwd`:n NYKYISESSÄ tilassa (jotta irrallisella HEADilla
 * `'HEAD'` tarkoittaa juuri sitä irrallista committia), ja sen
 * jälkeen luetaan TÄSMÄLLEEN sen yhden commitin oma viesti --
 * TAHALLAAN EI `tools/release/manifest.mjs`:n `discoverWaveCommits()`,
 * joka rajaa haun `PRODUCTION.sha..HEAD`-väliin NYKYISEN haaran
 * ("tämän puun") HEADista käsin. Jos pyydetty commit on eri haaran
 * historiassa (esim. erillinen julkaisujuna, joka ei ole tämän puun
 * esi-isä), tuo väli ei koskaan tavoittaisi sitä, vaikka commitilla
 * ITSELLÄÄN olisi täysin kelvollinen trailer. Tunnisteen on siis
 * riipputtava VAIN pyydetyn commitin omasta sisällöstä, ei siitä millä
 * haaralla tämä työpuu sattuu olemaan.
 *
 * Commit, jolla EI ole `Release-Wave:`-trailería, ei ole virhe: se on
 * tavallinen kehityscommit. Palautetaan silloin null, ei arvata.
 *
 * TUNNISTE LUETAAN `RELEASE_WAVE_TRAILER`ISTA (ACT-07). Aiempi oma
 * lauseke `(BASE|[A-E])` jätti aallot F–J tunnistamatta, joten
 * esitarkistuksen trailerivertailu oli F–J:lle hiljaa ohitettu: väärin
 * merkitty migraatioaallon commit olisi mennyt läpi.
 *
 * @param {string} [ref] git-referenssi, oletus 'HEAD'
 * @param {string} [cwd] mistä työpuusta `ref` ratkaistaan
 * @returns {string|null} 'BASE', 'A'..'J', tai null jos commit ei
 *   kanna tunnettua aaltomerkintää
 */
export function waveOfCommit(ref = 'HEAD', cwd = ROOT) {
  if (!gitAvailable(cwd)) return null;
  const sha = git(['rev-parse', ref], cwd);
  if (!sha) return null;

  const body = git(['log', '-1', '--format=%B', sha], cwd);
  if (!body) return null;

  return waveOfCommitBody(body);
}

/** Commitviestin `Release-Wave:`-tunniste, tai null. Puhdas funktio. */
export function waveOfCommitBody(body) {
  const match = RELEASE_WAVE_TRAILER.exec(String(body || ''));
  return match ? match[1] : null;
}

/**
 * Vertaa tämän puun väitettyä välimuistiversiota origin/mainin
 * todelliseen. Palauttaa kuvauksen ongelmasta tai null jos ei ole
 * mitään sanottavaa (joko origin/main ei ole saatavilla, tai versiot
 * ovat sopusoinnussa).
 *
 * "Sopusoinnussa" tarkoittaa: joko tämä haara on origin/mainin
 * jälkeläinen (jolloin sen versio SAA olla korkeampi, se on eteenpäin),
 * tai tämä haara väittää PIENEMPÄÄ tai YHTÄ SUURTA versiota kuin
 * origin/main -- rehellinen jälkeenjääneisyys. Ongelma syntyy vain jos
 * haara väittäisi ISOMPAA versiota kuin origin/main ILMAN että se on
 * origin/mainin jälkeläinen: se olisi keksitty tuotantoversio.
 */
export function cacheVersionLineageProblem(localCacheVersion) {
  const origin = originMainState();
  if (!origin.available || !origin.cacheVersion) return null;

  const local = versionNumber(localCacheVersion);
  const remote = versionNumber(origin.cacheVersion);
  if (local === null || remote === null) return null;

  const descendant = isDescendantOfOriginMain();
  if (descendant) return null; // eteenpäin todellisesta tuotannosta: OK

  if (local > remote) {
    return `tämä haara väittää välimuistiversiota ${localCacheVersion}, mutta `
      + `origin/main on ${origin.cacheVersion} eikä tämä haara ole sen `
      + 'jälkeläinen -- versio on keksitty, ei todennettu';
  }
  return null;
}
