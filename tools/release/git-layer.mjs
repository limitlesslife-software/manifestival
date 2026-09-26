// Injektoitava git-kerros aktivoinnin työkaluille.
//
// MIKSI TÄMÄ ON OLEMASSA
//
// Junan työkalut (train-map, dry-run, orkestroija, esitarkistukset)
// kysyvät gitiltä samoja asioita: mihin SHA:han viite osoittaa, mitä
// tiedosto sisältää tietyssä commitissa, onko commit toisen esi-isä.
// Kun jokainen työkalu kutsui `execFileSync('git', …)` suoraan, niitä ei
// voinut testata ilman oikeaa historiaa — ja deployhaaraa (push) ei
// voinut testata lainkaan ilman oikeaa pushia.
//
// Nyt jokainen työkalu ottaa `git`-olion parametrina. Oikea toteutus on
// tämä `createGit()`; testit antavat tynkäolion samalla rajapinnalla.
//
// RAJAPINTA (kaikki synkronisia, virhe -> null, ei poikkeusta)
//
//   revParse(ref)              40-merkkinen SHA tai null
//   show(sha, path)            tiedoston sisältö (utf8, EI trimmattu) tai null
//   showBuffer(sha, path)      tiedoston tavut (Buffer) tai null
//   isAncestor(a, b)           true | false | null (ei voitu vastata)
//   commitBody(sha)            commitviesti tai null
//   log(from, to)              [{ sha, body }] välille from..to, uusin ensin
//   statusPorcelain()          `git status --porcelain` tai null
//   grep(ref, regex, opts)     [polku] osumista (git grep -E), tai null
//   containsPatch(target, c)   onko commitin c muutos kohteessa (esi-isä tai
//                              git cherry '-'), true | false | null
//   fetchHeadTime()            viimeisimmän fetchin aika (Date) tai null
//
// VERKKO JA KIRJOITUS — vain orkestroijan deployhaarassa:
//
//   lsRemoteMain()             `git ls-remote origin refs/heads/main` -> SHA|null
//   pushMain(sha)              `git push origin <sha>:refs/heads/main`
//
// `pushMain` on OLETUKSENA ESTETTY: se heittää, ellei kerrosta luotu
// `{ allowPush: true }`. Vain scripts/activation-orchestrate.mjs luo
// sellaisen, ja vain lipulla --execute-deploy. Force-pushia ei ole
// rajapinnassa lainkaan: refspecissä ei ole '+'-etuliitettä eikä
// komennossa --force-lippua (testit tarkistavat lähteestä).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from './state.mjs';

const SHA40 = /^[0-9a-f]{40}$/;

/**
 * Oikea git-kerros.
 *
 * @param {object} [options]
 * @param {string} [options.cwd] työpuu (oletus: tämä repo)
 * @param {boolean} [options.allowPush] salli pushMain (vain deploy)
 * @param {Function} [options.execFile] execFileSync-korvike (testit)
 */
export function createGit({ cwd = ROOT, allowPush = false, execFile = execFileSync } = {}) {
  const run = (args, { buffer = false } = {}) => {
    try {
      return execFile('git', args, {
        cwd,
        encoding: buffer ? 'buffer' : 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024
      });
    } catch {
      return null;
    }
  };

  const status = args => {
    try {
      execFile('git', args, { cwd, stdio: 'ignore' });
      return 0;
    } catch (err) {
      return err && typeof err.status === 'number' ? err.status : -1;
    }
  };

  // Muistiin vain kysymykset, joiden KAIKKI argumentit ovat täysiä SHA:ita:
  // commitin sisältö ja sukulinja eivät muutu. Viitteitä (haara, origin/main,
  // HEAD) ei muisteta, koska ne liikkuvat.
  const memo = new Map();
  const remember = (key, args, fn) => {
    if (!args.every(a => SHA40.test(String(a)))) return fn();
    const k = `${key}\u0000${args.join('\u0000')}`;
    if (!memo.has(k)) memo.set(k, fn());
    return memo.get(k);
  };

  const revParse = ref => {
    if (!ref) return null;
    return remember('revParse', [ref], () => {
      const out = run(['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
      const sha = out ? out.trim() : null;
      return sha && SHA40.test(sha) ? sha : null;
    });
  };

  const isAncestor = (a, b) => remember('isAncestor', [a, b], () => {
    const code = status(['merge-base', '--is-ancestor', a, b]);
    if (code === 0) return true;
    if (code === 1) return false;
    return null;
  });

  // Välimuisti `sha:polku` -> Buffer|null. Commitin sisältö ei muutu,
  // joten välimuisti on turvallinen (viitteitä ei välimuisteta).
  const blobs = new Map();
  const showBuffer = (sha, file) => {
    const key = `${sha}:${file}`;
    if (!blobs.has(key)) blobs.set(key, run(['show', key], { buffer: true }));
    return blobs.get(key);
  };

  /**
   * Lue monta tiedostoa yhdellä `git cat-file --batch` -ajolla
   * välimuistiin. Vain SHA:lla (ei viitteellä) — viite voisi liikkua.
   */
  const showMany = (sha, files) => {
    if (!SHA40.test(String(sha))) return;
    const wanted = files.filter(f => !blobs.has(`${sha}:${f}`));
    if (!wanted.length) return;
    let out;
    try {
      out = execFile('git', ['cat-file', '--batch'], {
        cwd, input: wanted.map(f => `${sha}:${f}`).join('\n') + '\n',
        stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024
      });
    } catch {
      return;
    }
    const buf = Buffer.isBuffer(out) ? out : Buffer.from(out);
    let pos = 0;
    for (const file of wanted) {
      const eol = buf.indexOf(10, pos);
      if (eol === -1) break;
      const header = buf.subarray(pos, eol).toString('utf8');
      pos = eol + 1;
      const m = /^[0-9a-f]{40} (\w+) (\d+)$/.exec(header);
      if (!m) { blobs.set(`${sha}:${file}`, null); continue; }
      const size = Number(m[2]);
      blobs.set(`${sha}:${file}`, m[1] === 'blob' ? Buffer.from(buf.subarray(pos, pos + size)) : null);
      pos += size + 1;
    }
  };

  return Object.freeze({
    kind: 'git',
    cwd,
    revParse,
    show: (sha, file) => {
      const buf = SHA40.test(String(sha)) ? showBuffer(sha, file) : run(['show', `${sha}:${file}`], { buffer: true });
      return buf === null ? null : buf.toString('utf8');
    },
    showBuffer: (sha, file) => (SHA40.test(String(sha)) ? showBuffer(sha, file) : run(['show', `${sha}:${file}`], { buffer: true })),
    showMany,
    isAncestor,
    commitBody: sha => run(['log', '-1', '--format=%B', sha]),
    log(from, to) {
      return remember('log', [from, to], () => {
        const out = run(['log', '--format=%H%x1f%B%x1e', `${from}..${to}`]);
        if (out === null) return null;
        return out.split('\x1e').map(c => c.trim()).filter(Boolean).map(c => {
          const [sha, body] = c.split('\x1f');
          return { sha: sha.trim(), body: body || '' };
        });
      });
    },
    statusPorcelain: () => run(['status', '--porcelain']),
    grep(ref, regex, { ignoreCase = false, pathspec = [] } = {}) {
      const args = ['grep', '-I', '-l', '-E'];
      if (ignoreCase) args.push('-i');
      args.push(regex, ref);
      if (pathspec.length) args.push('--', ...pathspec);
      try {
        const out = execFile('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return out.split(/\r?\n/).filter(Boolean).map(line => line.replace(`${ref}:`, ''));
      } catch (err) {
        // git grep: poistumiskoodi 1 = ei osumia. Muu = virhe.
        return err && err.status === 1 ? [] : null;
      }
    },
    containsPatch(target, commit) {
      return remember('containsPatch', [target, commit], () => {
        const ancestor = isAncestor(commit, target);
        if (ancestor === true) return true;
        if (ancestor === null) return null;
        const out = run(['cherry', target, commit, `${commit}^`]);
        if (out === null) return null;
        const line = out.split(/\r?\n/).find(l => l.trim());
        if (!line) return true;
        return line.startsWith('-');
      });
    },
    fetchHeadTime() {
      const candidates = [];
      const own = run(['rev-parse', '--git-path', 'FETCH_HEAD']);
      if (own) candidates.push(path.resolve(cwd, own.trim()));
      const common = run(['rev-parse', '--git-common-dir']);
      if (common) candidates.push(path.resolve(cwd, common.trim(), 'FETCH_HEAD'));
      for (const file of candidates) {
        try {
          return fs.statSync(file).mtime;
        } catch { /* seuraava */ }
      }
      return null;
    },
    lsRemoteMain() {
      const out = run(['ls-remote', 'origin', 'refs/heads/main']);
      if (!out) return null;
      const sha = out.trim().split(/\s+/)[0];
      return SHA40.test(sha) ? sha : null;
    },
    pushMain(sha) {
      if (!allowPush) throw new Error('pushMain estetty: git-kerros luotiin ilman allowPush-lippua');
      if (!SHA40.test(String(sha))) throw new Error(`pushMain: ei 40-merkkinen SHA: ${sha}`);
      try {
        const output = execFile('git', ['push', 'origin', `${sha}:refs/heads/main`],
          { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { ok: true, output: String(output || '') };
      } catch (err) {
        return { ok: false, output: String((err && (err.stderr || err.message)) || err) };
      }
    }
  });
}

/** Onko arvo täysi 40-merkkinen SHA? */
export function isFullSha(value) {
  return SHA40.test(String(value || ''));
}
