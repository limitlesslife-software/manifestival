// Dokumenttien deploy- ja push-rivit ja lukko (ACT-09, ACT-14).
//
// Ensisijainen deploy-askel on AINA orkestroija:
//
//   npm run activation:orchestrate -- --execute-deploy --approved-sha=<lukon deployTarget>
//
// Raaka `git push origin <sha>:refs/heads/main` -rivi on dokumenteissa vain
// viitteenä siitä, mitä orkestroija ajaa compare-and-swapin jälkeen.
//
// Kohde on AINA lukon (docs/activation/release-train-c-j.json)
// `deployTarget`: täysi 40-merkkinen SHA. Ei haaran nimeä (liikkuu), ei
// lyhyttä SHA:ta (voi muuttua moniselitteiseksi), eikä manifestin
// aaltocommitia (J:n aaltocommit e96942c EI sisällä Day 1 -korjauksia,
// jotka ovat deploykohteessa 5df40b2). Ainoa poikkeus on peruutuksen
// `git push origin HEAD:main`, jossa HEAD on juuri tehty revert-commit.
//
// UUDELLEENLEIKKAUS (missingPatches)
//
// Jos lukon tietueella on `missingPatches`, aallolle EI SAA olla
// dokumentissa yhtään ajettavaa push- eikä deploy-riviä. `--sync-docs`
// korvaa sellaiset rivit STOP-huomautuksella (STOP_LINE alla) ja palauttaa
// ne lukon uusilla SHA:illa, kun uudelleenleikattu lukko on kirjoitettu.
// `pushLineProblems` kaatuu, jos rivi ja lukko eivät ole samaa mieltä.
//
// Rivin aalto luetaan joko rivin lopun kommentista (`# D`), tai — aallon
// omassa hyväksyntäpaketissa — tiedoston aallosta.

const PUSH = /git push origin (\S+?):((?:refs\/heads\/)?main)\b([^\n`]*)/g;
const DEPLOY = /npm run activation:orchestrate -- --execute-deploy --approved-sha=(\S+?)(?=[\s`]|$)([^\n`]*)/g;
const PUSH_LINE = /^(\s*)git push origin (\S+?):((?:refs\/heads\/)?main)\b(.*)$/;
const DEPLOY_LINE = /^(\s*)npm run activation:orchestrate -- --execute-deploy --approved-sha=(\S+)(.*)$/;
const STOP_LINE = /^(\s*)# STOP ([A-J]) — TRAIN_RECUT_REQUIRED: .*\[(push|deploy)([^\]]*)\]\s*$/;
const SQL_SHOW = /(git show )([0-9a-f]{40})(:supabase\/)/g;
const SQL_SOURCE = /(SQL-lähde \(lukon sqlSource\): `)([^`]+)(` @ `)([0-9a-f]{40})(`)/g;
const SHA40 = /^[0-9a-f]{40}$/;

const tagOf = rest => /#\s*([A-J])\b/.exec(rest || '');

/**
 * Kaikki push-rivit tekstissä.
 *
 * @returns {{target: string, refspec: string, wave: string|null, text: string}[]}
 */
export function pushLinesIn(text) {
  const lines = [];
  for (const m of String(text || '').matchAll(PUSH)) {
    const tag = tagOf(m[3]);
    lines.push({ target: m[1], refspec: m[2], wave: tag ? tag[1] : null, text: m[0] });
  }
  return lines;
}

/** Kaikki orkestroijan deploy-komennot (`--execute-deploy --approved-sha=`). */
export function deployLinesIn(text) {
  const lines = [];
  for (const m of String(text || '').matchAll(DEPLOY)) {
    const tag = tagOf(m[2]);
    lines.push({ target: m[1], wave: tag ? tag[1] : null, text: m[0] });
  }
  return lines;
}

/** STOP-huomautukset (uudelleenleikkaus kesken). `rest` = palautettavan rivin loppu. */
export function stopLinesIn(text) {
  return String(text || '').split(/\r?\n/).map(l => STOP_LINE.exec(l)).filter(Boolean)
    .map(m => ({ wave: m[2], kind: m[3], rest: m[4], text: m[0].trim() }));
}

/** Lukon tietue aallolle, tai null. */
function recordOf(lock, wave) {
  return lock && Array.isArray(lock.waves) ? lock.waves.find(w => w.wave === wave) || null : null;
}

/** Lukon deployTarget aallolle, tai null. */
export function deployTargetOf(lock, wave) {
  const record = recordOf(lock, wave);
  return record ? record.deployTarget || null : null;
}

/** Onko aallolla lukossa puuttuvia pakollisia korjauksia? */
export function needsRecut(lock, wave) {
  const record = recordOf(lock, wave);
  return Boolean(record && Array.isArray(record.missingPatches) && record.missingPatches.length);
}

/**
 * STOP-huomautus aallolle: kertoo syyn ja säilyttää palautustiedon
 * hakasulkeissa ([push<rivin loppu>] tai [deploy<rivin loppu>]).
 */
export function stopLineFor(lock, wave, { kind, rest = '', indent = '' }) {
  const record = recordOf(lock, wave);
  const target = record && record.deployTarget ? record.deployTarget.slice(0, 7) : '-------';
  const patches = record && record.missingPatches ? record.missingPatches.map(s => s.slice(0, 7)).join(', ') : '-';
  return `${indent}# STOP ${wave} — TRAIN_RECUT_REQUIRED: lukon deployTarget ${target} ei sisällä pakollista korjausta ${patches}; `
    + 'ei push- eikä deploy-komentoa ennen uudelleenleikkausta (leikkaa, sitten node tools/activation/train-map.mjs --write ja --sync-docs) '
    + `[${kind}${cleanRest(rest)}]`;
}

function commandFor(kind, sha, { rest = '', indent = '' }) {
  const head = kind === 'push'
    ? `git push origin ${sha}:refs/heads/main`
    : `npm run activation:orchestrate -- --execute-deploy --approved-sha=${sha}`;
  return `${indent}${head}${cleanRest(rest)}`;
}

/** Rivin loppu ilman vanhaa "(leikataan uudelleen)" -merkintää ja loppuvälejä. */
const cleanRest = rest => String(rest || '').replace(/\s*\(leikataan uudelleen\)/, '').replace(/\s+$/, '');

/**
 * Päivitä push- ja deploy-rivit lukon SHA:ihin ja STOP-huomautukset
 * lukon missingPatches-tilaan. Peruutusrivi (HEAD) jätetään.
 *
 * @param {string} text
 * @param {{lock: object, wave?: string|null}} options wave = tiedoston aalto
 */
export function syncPushLines(text, { lock, wave = null }) {
  return String(text).split('\n').map(line => {
    const stop = STOP_LINE.exec(line);
    if (stop) {
      const [, indent, lineWave, kind, rest] = stop;
      if (needsRecut(lock, lineWave)) return stopLineFor(lock, lineWave, { kind, rest, indent });
      const sha = deployTargetOf(lock, lineWave);
      return sha ? commandFor(kind, sha, { rest, indent }) : line;
    }
    const push = PUSH_LINE.exec(line);
    const deploy = !push && DEPLOY_LINE.exec(line);
    const m = push || deploy;
    if (!m) return inlineSync(line, { lock, wave });
    const [indent, target] = [m[1], m[2]];
    const rest = push ? m[4] : m[3];
    if (target === 'HEAD' || target.startsWith('<')) return line;
    const tagMatch = tagOf(rest);
    const lineWave = tagMatch ? tagMatch[1] : wave;
    const sha = lineWave ? deployTargetOf(lock, lineWave) : null;
    if (!sha) return line;
    const kind = push ? 'push' : 'deploy';
    if (needsRecut(lock, lineWave)) return stopLineFor(lock, lineWave, { kind, rest, indent });
    // Rivin loppu (lisäliput, kommentti) säilyy; vain kohde normalisoidaan.
    return commandFor(kind, sha, { rest, indent });
  }).join('\n');
}

/** Proosan sisäiset komennot: vain SHA päivitetään (STOP-muunnosta ei tehdä). */
function inlineSync(line, { lock, wave }) {
  const fix = (whole, target, rest, build) => {
    if (target === 'HEAD' || !SHA40.test(target)) return whole;
    const tag = tagOf(rest);
    const sha = deployTargetOf(lock, tag ? tag[1] : wave);
    return sha ? build(sha) : whole;
  };
  return line
    .replace(PUSH, (whole, target, refspec, rest) => fix(whole, target, rest, sha => `git push origin ${sha}:${refspec}${rest}`))
    .replace(DEPLOY, (whole, target, rest) => fix(whole, target, rest, sha => `npm run activation:orchestrate -- --execute-deploy --approved-sha=${sha}${rest}`));
}

/**
 * SQL-lähteen viitteet lukon sqlSourceen: `git show <sha>:supabase/…`
 * ja "SQL-lähde (lukon sqlSource): `<ref>` @ `<sha>`".
 */
export function syncSqlSourceRefs(text, { lock }) {
  const source = lock && lock.sqlSource;
  if (!source || !SHA40.test(String(source.sha))) return String(text);
  return String(text)
    .replace(SQL_SHOW, (whole, a, sha, b) => `${a}${source.sha}${b}`)
    .replace(SQL_SOURCE, (whole, a, ref, b, sha, c) => `${a}${source.ref}${b}${source.sha}${c}`);
}

const WAVE_ARG = /--(?:wave|record-acceptance|record-candidate-tests)=([A-J])\b/;
const SHA_ARG = /(--sha=)([0-9a-f]{40})/g;

/**
 * `--sha=<40>`-argumentit riveillä, joilla on aaltomerkki (`--wave=X`,
 * `--record-acceptance=X`, `--record-candidate-tests=X`): SHA = lukon
 * deployTarget.
 */
export function syncWaveShaArgs(text, { lock }) {
  return String(text).split('\n').map(line => {
    const w = WAVE_ARG.exec(line);
    const sha = w ? deployTargetOf(lock, w[1]) : null;
    return sha ? line.replace(SHA_ARG, (whole, a) => `${a}${sha}`) : line;
  }).join('\n');
}

/** `--sha=`-argumenttien ongelmat (ks. syncWaveShaArgs). */
export function waveShaArgProblems(text, { lock, file = '' }) {
  const problems = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const w = WAVE_ARG.exec(line);
    if (!w) continue;
    for (const m of line.matchAll(SHA_ARG)) {
      if (m[2] !== deployTargetOf(lock, w[1])) problems.push(`${file}: --sha=${m[2].slice(0, 7)} ei ole aallon ${w[1]} lukittu deployTarget`);
    }
  }
  return problems;
}

/** SQL-lähteen viitteiden ongelmat (ks. syncSqlSourceRefs). */
export function sqlSourceProblems(text, { lock, file = '' }) {
  const source = lock && lock.sqlSource;
  const problems = [];
  for (const m of String(text || '').matchAll(SQL_SHOW)) {
    if (!source || m[2] !== source.sha) problems.push(`${file}: git show ${m[2].slice(0, 7)}:supabase/… — SQL-lähde ei ole lukon sqlSource ${source ? source.sha.slice(0, 7) : '-'}`);
  }
  for (const m of String(text || '').matchAll(SQL_SOURCE)) {
    if (!source || m[4] !== source.sha || m[2] !== source.ref) problems.push(`${file}: SQL-lähde ${m[2]} @ ${m[4].slice(0, 7)} ei ole lukon sqlSource`);
  }
  return problems;
}

/**
 * GO/NO-GO-taulukon Deploykohde-sarake lukon mukaan: rivin
 * `| **X** vNN |` ensimmäinen 40-merkkinen SHA -> lukon deployTarget,
 * ja "; leikataan uudelleen" lukon missingPatches-kentän mukaan.
 */
export function syncTableDeployTargets(text, { lock }) {
  return String(text).split('\n').map(line => {
    const m = /^\| \*\*([A-J])\*\* v\d+ \|/.exec(line);
    if (!m) return line;
    const sha = deployTargetOf(lock, m[1]);
    if (!sha) return line;
    let out = line.replace(/[0-9a-f]{40}/, sha).replace(/; leikataan uudelleen\)/, ')');
    if (needsRecut(lock, m[1])) out = out.replace(/(`[0-9a-f]{40}` \(`[^`]+`)\)/, '$1; leikataan uudelleen)');
    return out;
  }).join('\n');
}

/** GO/NO-GO-taulukon rivit: aalto -> { deployTarget, migration, risk, owner }. */
export function goNoGoTableRows(text) {
  const rows = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\| \*\*([A-J])\*\* (v\d+) \|/.exec(line);
    if (!m) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    const sha = /[0-9a-f]{40}/.exec(cells[2] || '');
    const migration = /\b(00\d\d)\b/.exec(cells[3] || '');
    rows[m[1]] = {
      cacheVersion: m[2],
      deployTarget: sha ? sha[0] : null,
      migration: migration ? migration[1] : null,
      owner: cells[5] || '',
      risk: (cells[6] || '').replace(/\*/g, '').split(/\s|\(/)[0],
      text: line
    };
  }
  return rows;
}

/**
 * Tarkista push- ja deploy-rivit ja STOP-huomautukset:
 *
 *   - kohde on HEAD (vain push) tai lukon 40-merkkinen deployTarget
 *   - aallon omassa paketissa (tai `# X`-merkityllä rivillä) juuri sen
 *     aallon deployTarget
 *   - aallolle, jonka lukossa on missingPatches, EI ole yhtään raakaa
 *     push- tai deploy-riviä (vain STOP-huomautus)
 *   - STOP-huomautus vain aallolle, jonka lukossa on missingPatches
 *
 * @returns {string[]} ongelmat
 */
export function pushLineProblems(text, { lock, wave = null, file = '' }) {
  const problems = [];
  const targets = new Set((lock.waves || []).map(w => w.deployTarget).filter(Boolean));
  const commands = [
    ...pushLinesIn(text).map(l => ({ ...l, kind: 'push' })),
    ...deployLinesIn(text).map(l => ({ ...l, kind: 'deploy' }))
  ];
  for (const line of commands) {
    if (line.kind === 'push' && line.target === 'HEAD') continue;
    if (line.kind === 'deploy' && line.target.startsWith('<')) continue; // paikkamerkki, esim. <deployTarget>
    const shown = line.text.trim();
    if (!SHA40.test(line.target)) {
      problems.push(`${file}: "${shown}" — kohde ei ole 40-merkkinen SHA`);
      continue;
    }
    if (!targets.has(line.target)) {
      problems.push(`${file}: "${shown}" — SHA ei ole lukon deployTarget`);
      continue;
    }
    const lineWave = line.wave || wave;
    if (lineWave && deployTargetOf(lock, lineWave) !== line.target) {
      problems.push(`${file}: "${shown}" — aallon ${lineWave} deployTarget on ${deployTargetOf(lock, lineWave)}`);
      continue;
    }
    const owner = lineWave || (lock.waves || []).find(w => w.deployTarget === line.target)?.wave;
    if (owner && needsRecut(lock, owner)) {
      problems.push(`${file}: "${shown}" — aallon ${owner} lukossa on missingPatches: raaka ${line.kind === 'push' ? 'push' : 'deploy'}-rivi on korvattava STOP-huomautuksella (train-map --sync-docs)`);
    }
  }
  for (const stop of stopLinesIn(text)) {
    if (!needsRecut(lock, stop.wave)) {
      problems.push(`${file}: STOP-huomautus aallolle ${stop.wave}, mutta lukossa ei ole missingPatches: aja train-map --sync-docs`);
    } else if (stopLineFor(lock, stop.wave, { kind: stop.kind, rest: stop.rest }) !== stop.text) {
      problems.push(`${file}: STOP-huomautus aallolle ${stop.wave} ei vastaa lukkoa: aja train-map --sync-docs`);
    }
  }
  return problems;
}
