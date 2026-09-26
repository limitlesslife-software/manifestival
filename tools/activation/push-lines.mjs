// Dokumenttien `git push origin X:main` -rivit ja lukko (ACT-09, ACT-14).
//
// Push-kohde on AINA lukon (docs/activation/release-train-c-j.json)
// `deployTarget`: täysi 40-merkkinen SHA. Ei haaran nimeä (liikkuu), ei
// lyhyttä SHA:ta (voi muuttua moniselitteiseksi), eikä manifestin
// aaltocommitia (J:n aaltocommit e96942c EI sisällä Day 1 -korjauksia,
// jotka ovat deploykohteessa 5df40b2). Ainoa poikkeus on peruutuksen
// `git push origin HEAD:main`, jossa HEAD on juuri tehty revert-commit.
//
// Rivin aalto luetaan joko rivin lopun kommentista (`# D`), tai — aallon
// omassa hyväksyntäpaketissa — tiedoston aallosta.

const PUSH = /git push origin (\S+?):((?:refs\/heads\/)?main)\b([^\n`]*)/g;

/**
 * Kaikki push-rivit tekstissä.
 *
 * @returns {{target: string, refspec: string, wave: string|null, text: string}[]}
 */
export function pushLinesIn(text) {
  const lines = [];
  for (const m of String(text || '').matchAll(PUSH)) {
    const tag = /#\s*([A-J])\b/.exec(m[3] || '');
    lines.push({ target: m[1], refspec: m[2], wave: tag ? tag[1] : null, text: m[0] });
  }
  return lines;
}

/** Lukon deployTarget aallolle, tai null. */
export function deployTargetOf(lock, wave) {
  const record = lock && Array.isArray(lock.waves) ? lock.waves.find(w => w.wave === wave) : null;
  return record ? record.deployTarget || null : null;
}

/**
 * Päivitä push-rivit lukon SHA:ihin. Peruutusrivi (HEAD) jätetään.
 *
 * @param {string} text
 * @param {{lock: object, wave?: string|null}} options wave = tiedoston aalto
 */
export function syncPushLines(text, { lock, wave = null }) {
  return String(text).replace(PUSH, (whole, target, refspec, rest) => {
    if (target === 'HEAD') return whole;
    const tag = /#\s*([A-J])\b/.exec(rest || '');
    const lineWave = tag ? tag[1] : wave;
    const sha = lineWave ? deployTargetOf(lock, lineWave) : null;
    if (!sha) return whole;
    let tail = rest || '';
    if (tag) {
      // "(leikataan uudelleen)" seuraa lukon missingPatches-kenttää.
      tail = tail.replace(/\s*\(leikataan uudelleen\)/, '');
      if (needsRecut(lock, lineWave)) tail = tail.replace(/\s*$/, ' (leikataan uudelleen)');
    }
    return `git push origin ${sha}:refs/heads/main${tail}`;
  });
}

function needsRecut(lock, wave) {
  const record = lock && Array.isArray(lock.waves) ? lock.waves.find(w => w.wave === wave) : null;
  return Boolean(record && Array.isArray(record.missingPatches) && record.missingPatches.length);
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
 * Tarkista push-rivit: jokainen kohde on HEAD tai lukon 40-merkkinen
 * deployTarget, ja aallon omassa paketissa (tai `# X`-merkityllä rivillä)
 * juuri sen aallon deployTarget.
 *
 * @returns {string[]} ongelmat
 */
export function pushLineProblems(text, { lock, wave = null, file = '' }) {
  const problems = [];
  const targets = new Set((lock.waves || []).map(w => w.deployTarget).filter(Boolean));
  for (const line of pushLinesIn(text)) {
    if (line.target === 'HEAD') continue;
    if (!/^[0-9a-f]{40}$/.test(line.target)) {
      problems.push(`${file}: "${line.text.trim()}" — kohde ei ole 40-merkkinen SHA`);
      continue;
    }
    if (!targets.has(line.target)) {
      problems.push(`${file}: "${line.text.trim()}" — SHA ei ole lukon deployTarget`);
      continue;
    }
    const lineWave = line.wave || wave;
    if (lineWave && deployTargetOf(lock, lineWave) !== line.target) {
      problems.push(`${file}: "${line.text.trim()}" — aallon ${lineWave} deployTarget on ${deployTargetOf(lock, lineWave)}`);
    }
  }
  return problems;
}
