// Tuotannon staattisten tiedostojen luku ja todennus (ACT-06, ACT-10).
//
// Verkkoa EI käytetä: fetch-tynkä tarjoilee `git show <sha>:<polku>`
// -sisältöä joko synteettisestä historiasta tai (ehdollisesti) tämän
// repon oikeista ehdokas-SHA:ista. Se on sama tieto, jonka Vercel
// tarjoilisi, koska vercel.json palvelee repon juurta staattisesti.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ROOT, read } from './helpers/sources.mjs';
import { shaOf, stubFetch, stubGit } from './helpers/activation-history.mjs';
import {
  fingerprintOf, fingerprintPaths, identifySha, parseShellList, readLiveState, verifyLive
} from '../tools/release/live-assets.mjs';
import { createGit } from '../tools/release/git-layer.mjs';
import { expectedMatrix } from '../tools/release/waves.mjs';

const REAL = {
  C: 'cf259d0ef755f7e875cc9cd9c15405eba632e408',
  F: '5e4e7cf50e40fe1e0ba7b4543b147767e3a0eb32',
  J_WAVE_COMMIT: 'e96942c296944b4ac1a86d96563f2a1370678d97',
  J_TIP: '5df40b20cee4f35279a79888959d49c9af88bcc7'
};

/** Oikea git-historia fetch-tynkänä (vain luku). */
function realServe(git, sha, mutate = null) {
  const layer = { show: (s, p) => { const buf = git.showBuffer(s, p); if (buf === null) return null; const text = buf.toString('latin1'); return mutate ? mutate(p, text) : text; } };
  const fetchImpl = async (url) => {
    const livePath = new URL(url).pathname;
    const repoPath = livePath === '/' ? 'index.html' : livePath.replace(/^\//, '');
    const body = layer.show(sha, repoPath);
    const headers = new Map([['x-frame-options', 'DENY'], ['x-content-type-options', 'nosniff'], ['referrer-policy', 'strict-origin-when-cross-origin']]);
    return {
      status: body === null ? 404 : 200,
      headers: { get: n => headers.get(n) ?? null },
      arrayBuffer: async () => { const b = Buffer.from(body ?? '', 'latin1'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
    };
  };
  return fetchImpl;
}

const realGit = createGit({ cwd: ROOT });
const has = (...shas) => shas.every(s => realGit.revParse(s));
const gitShow = (s, p) => realGit.showBuffer(s, p);
const preload = (s, p) => realGit.showMany(s, p);

// ---------------------------------------------------------- synteettinen

test('synteettinen: tuotanto C tunnistetaan aalloksi C ja todennus menee läpi', async () => {
  const git = stubGit();
  const live = await readLiveState({ fetchImpl: stubFetch(git, shaOf('C')) });
  assert.equal(live.wave, 'C');
  assert.equal(live.state.label, 'C');
  assert.equal(live.cacheVersion, 'v16');
  assert.deepEqual(verifyLive(live, { wave: 'C' }), []);
  assert.ok(verifyLive(live, { wave: 'D' }).some(p => /CACHE_VERSION on v16, aalto D edellyttää v17/.test(p)));
});

test('turvaotsakkeen puuttuminen on poikkeama', async () => {
  const git = stubGit();
  const live = await readLiveState({ fetchImpl: stubFetch(git, shaOf('C'), { headers: false }) });
  assert.ok(verifyLive(live, { wave: 'C' }).some(p => /turvaotsake x-frame-options/.test(p)));
});

test('KRIITTINEN: tuntematon ylimääräinen portti on poikkeama', async () => {
  const git = stubGit({ extraCommits: {} });
  const base = stubGit();
  const sha = 'aa'.repeat(20);
  const files = {};
  for (const p of ['sw.js', 'index.html', 'src/app/main.js', 'src/domain/wellbeing.js', 'src/data/collectionsRepo.js']) files[p] = base.show(shaOf('C'), p);
  files['src/data/schema.js'] = base.show(shaOf('C'), 'src/data/schema.js').replace('  aiAudit: false,', '  aiAudit: false,\n  salainenPortti: true,');
  const g2 = stubGit({ extraCommits: { [sha]: files } });
  const live = await readLiveState({ fetchImpl: stubFetch(g2, sha) });
  assert.equal(live.gates, null);
  assert.ok(verifyLive(live, { wave: 'C' }).some(p => /porttilohkoa ei voitu jäsentää/.test(p)));
  assert.ok(git);
});

test('KRIITTINEN: sarakeportti väärin (F ilman BILL_PAYMENT_FIELDS) on poikkeama', async () => {
  const base = stubGit();
  const sha = 'bb'.repeat(20);
  const files = {};
  for (const p of ['sw.js', 'index.html', 'src/app/main.js', 'src/domain/wellbeing.js', 'src/data/collectionsRepo.js']) files[p] = base.show(shaOf('F'), p);
  files['src/data/schema.js'] = base.show(shaOf('F'), 'src/data/schema.js').replace('BILL_PAYMENT_FIELDS = true', 'BILL_PAYMENT_FIELDS = false');
  const git = stubGit({ extraCommits: { [sha]: files } });
  const live = await readLiveState({ fetchImpl: stubFetch(git, sha) });
  assert.equal(live.wave, 'F');
  const problems = verifyLive(live, { wave: 'F' });
  assert.ok(problems.some(p => /sarakeportti BILL_PAYMENT_FIELDS: tuotannossa kiinni/.test(p)), problems.join('; '));
});

test('sormenjälki: identifySha valitsee ainoan täsmäävän ehdokkaan', async () => {
  const git = stubGit();
  const candidates = ['C', 'D', 'E'].map(w => ({ sha: shaOf(w), ...fingerprintOf(shaOf(w), (s, p) => git.show(s, p)) }));
  const live = await readLiveState({ fetchImpl: stubFetch(git, shaOf('D')), paths: fingerprintPaths(candidates) });
  assert.equal(identifySha(live, candidates), shaOf('D'));
  assert.deepEqual(verifyLive(live, { wave: 'D', sha: shaOf('D'), gitShow: (s, p) => git.show(s, p) }), []);
  assert.ok(verifyLive(live, { wave: 'D', sha: shaOf('C'), gitShow: (s, p) => git.show(s, p) }).some(p => /sormenjälki/.test(p)));
});

test('KRIITTINEN: peruutustila (matriisi C, v18): --rollback-of=D läpi, tavallinen C-tarkistus kaatuu selkeästi', async () => {
  const base = stubGit();
  const sha = '99'.repeat(20);
  const files = {};
  for (const p of ['index.html', 'src/app/main.js', 'src/domain/wellbeing.js', 'src/data/collectionsRepo.js', 'src/data/schema.js']) files[p] = base.show(shaOf('C'), p);
  files['sw.js'] = base.show(shaOf('C'), 'sw.js').replace("'v16'", "'v18'");
  const git = stubGit({ extraCommits: { [sha]: files } });
  const live = await readLiveState({ fetchImpl: stubFetch(git, sha) });
  assert.equal(live.state.state, 'ROLLBACK');
  assert.equal(live.state.label, 'ROLLBACK(D)');
  assert.deepEqual(verifyLive(live, { rollbackOf: 'D' }), []);
  const plain = verifyLive(live, { wave: 'C' });
  assert.ok(plain.some(p => /v18, aalto C edellyttää v16 — tila näyttää aallon D peruutukselta: todenna --rollback-of=D/.test(p)), plain.join('; '));
  // Peruutus ilman nostoa (v17) ei kelpaa peruutukseksi.
  files['sw.js'] = base.show(shaOf('C'), 'sw.js').replace("'v16'", "'v17'");
  const git2 = stubGit({ extraCommits: { [sha]: files } });
  const live2 = await readLiveState({ fetchImpl: stubFetch(git2, sha) });
  assert.ok(verifyLive(live2, { rollbackOf: 'D' }).some(p => /suurempaa kuin v17/.test(p)));
});

test('KRIITTINEN: vain GET, ei /api/-polkuja, ei tunnuksia', async () => {
  const git = stubGit();
  const fetchImpl = stubFetch(git, shaOf('C'));
  await readLiveState({ fetchImpl, paths: ['/src/app/main.js'] });
  for (const r of fetchImpl.requests) assert.equal(r.method, 'GET');
  await assert.doesNotReject(readLiveState({ fetchImpl, paths: [] }));
  const live = await readLiveState({ fetchImpl, paths: ['/api/command'] });
  assert.ok(live.errors.some(e => /kielletty polku/.test(e)));
  assert.equal(fetchImpl.requests.some(r => /\/api\//.test(r.url)), false);
});

test('KRIITTINEN: live-assets.mjs ja CLI ovat vain lukevia eivätkä käytä tunnuksia', () => {
  for (const file of ['tools/release/live-assets.mjs', 'scripts/production-verify-assets.mjs']) {
    const code = read(file);
    assert.match(code, /method: 'GET'/, `${file}: metodia ei ole kiinnitetty`);
    for (const forbidden of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(new RegExp(`method:\\s*'${forbidden}'`).test(code), false, `${file}: ${forbidden}`);
    }
    for (const forbidden of ['service_role', 'SUPABASE_ANON_KEY', 'Authorization', 'apikey', 'password', 'sk-ant-']) {
      assert.equal(code.includes(forbidden), false, `${file}: ${forbidden}`);
    }
  }
  const cli = read('scripts/production-verify-assets.mjs');
  assert.match(cli, /--wave=<X>, --rollback-of=<X> tai --infer/, 'CLI ei vaadi odotettua tilaa');
  assert.equal(/currentState\(\)/.test(cli), false, 'CLI päättelee aallon yhä työpuusta');
});

test('SHELL-lista jäsennetään sw.js:stä', () => {
  const shell = parseShellList(read('sw.js'));
  assert.ok(shell.includes('/'));
  assert.ok(shell.includes('/index.html'));
  assert.ok(shell.every(p => p.startsWith('/')));
});

// ------------------------------------------------ oikea historia (ehdollinen)

test('oikea historia: C:n tiedostot -> aalto C ja identifySha = cf259d0', async t => {
  if (!has(REAL.C, REAL.F)) { t.skip('ehdokashistoria ei ole paikallisesti saatavilla'); return; }
  const candidates = [REAL.C, REAL.F].map(sha => ({ sha, ...fingerprintOf(sha, gitShow, preload) }));
  const live = await readLiveState({ fetchImpl: realServe(realGit, REAL.C), paths: fingerprintPaths(candidates) });
  assert.equal(live.wave, 'C');
  assert.deepEqual(live.gates, expectedMatrix('C'));
  assert.equal(identifySha(live, candidates), REAL.C);
  assert.deepEqual(verifyLive(live, { wave: 'C', sha: REAL.C, gitShow, preload }), []);
});

test('oikea historia: F:n BILL_PAYMENT_FIELDS käännettynä -> sarakeporttipoikkeama', async t => {
  if (!has(REAL.F)) { t.skip('ehdokashistoria ei ole paikallisesti saatavilla'); return; }
  const fetchImpl = realServe(realGit, REAL.F, (p, text) => (p === 'src/data/schema.js'
    ? text.replace('BILL_PAYMENT_FIELDS = true', 'BILL_PAYMENT_FIELDS = false') : text));
  const live = await readLiveState({ fetchImpl });
  assert.ok(verifyLive(live, { wave: 'F' }).some(p => /BILL_PAYMENT_FIELDS/.test(p)));
});

test('KRIITTINEN: oikea historia: J:n aaltocommit ja deploykohde erotetaan sormenjäljellä', async t => {
  if (!has(REAL.J_WAVE_COMMIT, REAL.J_TIP)) { t.skip('ehdokashistoria ei ole paikallisesti saatavilla'); return; }
  const candidates = [REAL.J_WAVE_COMMIT, REAL.J_TIP].map(sha => ({ sha, ...fingerprintOf(sha, gitShow, preload) }));
  const paths = fingerprintPaths(candidates);
  for (const served of [REAL.J_WAVE_COMMIT, REAL.J_TIP]) {
    const live = await readLiveState({ fetchImpl: realServe(realGit, served), paths });
    assert.equal(live.wave, 'J');
    assert.equal(identifySha(live, candidates), served, `tarjoiltu ${served.slice(0, 7)}`);
  }
});
