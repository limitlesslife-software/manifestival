// Release-Wave-trailer tunnistaa jokaisen aallon, ei vain A–E:tä.
//
// Löydös aallon F harjoittelukandidaattia rakennettaessa: manifesti
// etsi trailerin lausekkeella `(BASE|[A-E])`, joten F:n aaltocommitti
// (Release-Wave: F) jäi tunnistamatta ja manifesti näytti F:n
// commitoimattomana — ja samoin olisi käynyt G:lle, H:lle, I:lle ja J:lle.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RELEASE_WAVE_TRAILER } from '../tools/release/manifest.mjs';
import { WAVES } from '../tools/release/waves.mjs';

test('KRIITTINEN: trailer tunnistaa jokaisen määritellyn aallon ja perustilan', () => {
  for (const id of ['BASE', ...WAVES.map(w => w.id)]) {
    const body = `feat(release): aalto\n\nTekstiä.\n\nRelease-Wave: ${id}\n\nCo-Authored-By: x`;
    const match = RELEASE_WAVE_TRAILER.exec(body);
    assert.ok(match, `Release-Wave: ${id} jäi tunnistamatta`);
    assert.equal(match[1], id);
  }
});

test('tuntematon tai osittainen tunniste ei kelpaa', () => {
  for (const bad of ['Release-Wave: K', 'Release-Wave: FG', 'Release-Wave: f',
                     'Release-Wave:', 'Release-Wave: J (harjoittelu)']) {
    assert.equal(RELEASE_WAVE_TRAILER.test(`x\n\n${bad}\n`), false, bad);
  }
});
