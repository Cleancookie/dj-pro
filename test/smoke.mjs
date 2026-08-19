// Run with: make smoke   (boots nothing itself - point BASE at a running server)
// End-to-end sync smoke test. Node 24 has a global WebSocket, no deps needed.
const BASE = process.env.BASE || 'http://localhost:8080';
const WS = BASE.replace('http', 'ws') + '/ws';
const PASS = process.env.DJ_PASSWORD || 'letmein';
const VID = 'dQw4w9WgXcQ';

let failed = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(label) { this.label = label; this.frames = []; this.state = null; }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(WS);
      this.ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        this.frames.push(m);
        if (m.t === 'hello') { this.role = m.role; this.config = m.config; this.state = m.state; res(m); }
        if (m.t === 'state') this.state = m.state;
        if (m.t === 'role') this.role = m.role;
      };
      this.ws.onerror = rej;
      setTimeout(() => rej(new Error(this.label + ': no hello in 5s')), 5000);
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  cmd(o) { this.send({ t: 'cmd', ...o }); }
  waitFor(pred, ms = 3000) {
    const t0 = Date.now();
    return new Promise(async (res, rej) => {
      while (Date.now() - t0 < ms) {
        if (this.state && pred(this.state)) return res(this.state);
        await sleep(30);
      }
      rej(new Error(this.label + ': condition not met in ' + ms + 'ms'));
    });
  }
}

const derive = (d, now) => (d.playing ? d.anchorPos + ((now - d.anchorAt) / 1000) * d.rateActual : d.anchorPos);

(async () => {
  const h = await (await fetch(BASE + '/api/health')).json();
  ok('GET /api/health', h.ok === true, JSON.stringify(h));

  const r = await fetch(BASE + `/api/resolve?url=https://www.youtube.com/watch?v=${VID}`);
  const vid = await r.json();
  ok('GET /api/resolve returns a title', r.ok && typeof vid.title === 'string' && vid.title.length > 0, vid.title || JSON.stringify(vid));
  ok('resolve extracts the video id', vid.videoId === VID, vid.videoId);

  const crowd = new Client('crowd'); await crowd.open();
  ok('audience gets hello with state', crowd.role === 'audience' && !!crowd.state, 'role=' + crowd.role);
  ok('hello carries deck rate list', Array.isArray(crowd.config?.deckRates) && crowd.config.deckRates.length > 0);

  const dj = new Client('dj'); await dj.open();
  dj.cmd({ action: 'deck.play', deck: 'a' });
  await sleep(200);
  ok('non-DJ command is denied', dj.frames.some((f) => f.t === 'denied'));

  dj.send({ t: 'auth', password: PASS });
  await dj.waitFor((s) => s.djOnline === true);
  ok('auth promotes the socket to DJ', dj.role === 'dj', 'role=' + dj.role);

  dj.send({ t: 'identity', name: 'TestDJ' });

  // Start from a known room. Without this the suite is not idempotent: the auto-advance checks
  // below leave cue points and a rotated queue behind, and on a second run against the same server
  // an inherited out point correctly clamps playback - which looks like a sync failure but is the
  // app behaving properly.
  dj.cmd({ action: 'autodj.set', enabled: false });
  for (const item of dj.state.queue) dj.cmd({ action: 'queue.remove', id: item.id });
  for (const deck of ['a', 'b']) {
    dj.cmd({ action: 'deck.eject', deck });
    dj.cmd({ action: 'deck.loop', deck, on: false });
    dj.cmd({ action: 'deck.cueOut', deck, sec: 0 });
    dj.cmd({ action: 'deck.cueIn', deck, sec: 0 });
    dj.cmd({ action: 'deck.rate', deck, rate: 1 });
    dj.cmd({ action: 'deck.gain', deck, gain: 1 });
  }
  dj.cmd({ action: 'mixer.crossfade', value: -1 });
  dj.cmd({ action: 'mixer.transition', kind: 'crossfade', durationMs: 8000 });
  await dj.waitFor((s) => s.queue.length === 0 && !s.decks[0].video && !s.decks[1].video);
  ok('the room resets to a known state', dj.state.decks[0].cueOut === 0 && dj.state.mixer.crossfade === -1);
  dj.cmd({ action: 'deck.load', deck: 'a', video: { ...vid, id: '' } });
  await dj.waitFor((s) => s.decks[0].video?.videoId === VID);
  ok('deck.load lands on deck A', dj.state.decks[0].video.videoId === VID);
  dj.cmd({ action: 'deck.meta', deck: 'a', durationSec: 212 });
  await dj.waitFor((s) => s.decks[0].video?.durationSec === 212);
  ok('deck.meta records duration', true);

  dj.cmd({ action: 'deck.play', deck: 'a' });
  await dj.waitFor((s) => s.decks[0].playing);
  const t0 = Date.now(), p0 = derive(dj.state.decks[0], dj.state.serverNow);
  await sleep(1200);
  const p1 = derive(dj.state.decks[0], dj.state.serverNow + (Date.now() - t0));
  ok('derived position advances with wall clock', p1 - p0 > 0.9 && p1 - p0 < 1.6, `+${(p1 - p0).toFixed(3)}s`);

  ok('audience sees the same anchor as the DJ',
    crowd.state.decks[0].anchorAt === dj.state.decks[0].anchorAt &&
    crowd.state.decks[0].anchorPos === dj.state.decks[0].anchorPos);

  dj.cmd({ action: 'deck.seek', deck: 'a', positionSec: 90 });
  await dj.waitFor((s) => Math.abs(s.decks[0].anchorPos - 90) < 0.01);
  ok('seek re-stamps the anchor', true);

  dj.cmd({ action: 'deck.rate', deck: 'a', rate: 1.1 });
  await dj.waitFor((s) => s.decks[0].rateReq !== 1);
  const dA = dj.state.decks[0];
  ok('rate request is kept and snapped separately', dA.rateReq === 1.1 && dj.config.deckRates.includes(dA.rateActual),
    `req=${dA.rateReq} actual=${dA.rateActual}`);

  dj.cmd({ action: 'deck.rate', deck: 'a', rate: 9 });
  await sleep(120);
  ok('absurd rate is clamped', dj.state.decks[0].rateReq <= 1.5, 'req=' + dj.state.decks[0].rateReq);

  dj.cmd({ action: 'deck.bpm', deck: 'a', bpm: 128 });
  dj.cmd({ action: 'deck.load', deck: 'b', video: { ...vid, id: '' } });
  dj.cmd({ action: 'deck.bpm', deck: 'b', bpm: 100 });
  await dj.waitFor((s) => s.decks[1].bpm === 100);
  dj.cmd({ action: 'deck.rate', deck: 'a', rate: 1 });
  await sleep(120);
  dj.cmd({ action: 'deck.sync', deck: 'b' });
  await sleep(150);
  const eff = dj.state.decks[1].bpm * dj.state.decks[1].rateActual;
  ok('sync moves deck B toward deck A tempo', Math.abs(eff - 128) < Math.abs(100 - 128),
    `B eff=${eff.toFixed(1)} target=128 actual rate=${dj.state.decks[1].rateActual}`);

  dj.cmd({ action: 'mixer.transition', kind: 'crossfade', durationMs: 1000 });
  dj.cmd({ action: 'mixer.fire', to: 'b' });
  await dj.waitFor((s) => s.mixer.auto.active);
  const au = dj.state.mixer.auto;
  ok('fire starts a declarative automation', au.to === 1 && au.durationMs === 1000 && au.startedAt > 0,
    JSON.stringify(au));
  ok('audience receives the identical automation',
    JSON.stringify(crowd.state.mixer.auto) === JSON.stringify(au));
  await dj.waitFor((s) => !s.mixer.auto.active, 4000);
  ok('automation collapses to its end value', Math.abs(dj.state.mixer.crossfade - 1) < 0.001,
    'xf=' + dj.state.mixer.crossfade);

  dj.cmd({ action: 'mixer.crossfade', value: -0.5 });
  await sleep(120);
  ok('manual crossfade touch cancels automation', dj.state.mixer.auto.active === false);

  crowd.send({ t: 'chat', text: 'x'.repeat(500) });
  await crowd.waitFor((s) => s.chat.length > 0);
  ok('chat is trimmed to 300 chars', crowd.state.chat.at(-1).text.length === 300, 'len=' + crowd.state.chat.at(-1).text.length);

  dj.cmd({ action: 'queue.add', video: { ...vid, id: '' } });
  await dj.waitFor((s) => s.queue.length === 1);
  const qid = dj.state.queue[0].id;
  ok('queue.add assigns an id', !!qid, qid);
  dj.cmd({ action: 'queue.load', id: qid, deck: 'b' });
  await dj.waitFor((s) => s.queue.length === 0);
  ok('queue.load consumes the queue item', dj.state.decks[1].video?.videoId === VID);

  // ---------------------------------------------------------------- auto-advance (infinite set)
  // Everything below runs in seconds by giving every queued item a 3s out point and a 1s planned
  // transition, so a whole rotation takes ~3s instead of a whole track.
  const plan = (over) => ({ kind: 'crossfade', durationMs: 1000, cueIn: 0, cueOut: 3, ...over });
  const track = (title, over) => ({ ...vid, id: '', title, plan: plan(over) });
  const titles = (s) => s.queue.map((v) => v.title);

  // Stand in for the browsers that report a real duration: auto-advance refuses to guess an out
  // point for a deck whose duration nobody has reported.
  const browsers = setInterval(() => {
    const s = dj.state;
    if (!s || dj.role !== 'dj') return;
    ['a', 'b'].forEach((deck, i) => {
      if (s.decks[i].video && s.decks[i].video.durationSec === 0) {
        dj.cmd({ action: 'deck.meta', deck, durationSec: 212 });
      }
    });
  }, 60);

  // Reset the surface the earlier checks left behind.
  dj.cmd({ action: 'autodj.set', enabled: false });
  for (const deck of ['a', 'b']) {
    dj.cmd({ action: 'deck.pause', deck });
    dj.cmd({ action: 'deck.eject', deck });
    dj.cmd({ action: 'deck.rate', deck, rate: 1 });
  }
  dj.cmd({ action: 'mixer.crossfade', value: -1 });
  // Mixer defaults deliberately DIFFERENT from every plan, so any transition that matches the plan
  // proves the plan was honoured rather than the mixer default.
  dj.cmd({ action: 'mixer.transition', kind: 'cut', durationMs: 8000 });
  await dj.waitFor((s) => !s.decks[0].video && !s.decks[1].video && s.queue.length === 0);
  ok('decks are clear before the auto-advance run', true);

  dj.cmd({ action: 'queue.addMany', videos: [track('A1'), track('A2'), track('A3')] });
  await dj.waitFor((s) => s.queue.length === 3);
  ok('queue.addMany preserves order', titles(dj.state).join(',') === 'A1,A2,A3', titles(dj.state).join(','));
  ok('queue.addMany assigns distinct ids', new Set(dj.state.queue.map((v) => v.id)).size === 3);
  ok('queue.addMany keeps each item plan', dj.state.queue.every((v) => v.plan.cueOut === 3 && v.plan.durationMs === 1000));

  dj.cmd({ action: 'queue.addMany', videos: [{ ...vid, id: '', videoId: 'nope' }, track('A4')] });
  await dj.waitFor((s) => s.queue.length === 4);
  ok('queue.addMany skips unusable rows and keeps the rest', titles(dj.state).join(',') === 'A1,A2,A3,A4');
  dj.cmd({ action: 'queue.remove', id: dj.state.queue[3].id });
  await dj.waitFor((s) => s.queue.length === 3);

  // --- queue.plan is a PARTIAL update
  const planned = dj.state.queue[1].id;
  dj.cmd({ action: 'queue.plan', id: planned, plan: { kind: 'bassSwap', durationMs: 2000, cueIn: 5, cueOut: 30 } });
  await dj.waitFor((s) => s.queue[1].plan.kind === 'bassSwap');
  ok('queue.plan sets a full plan',
    JSON.stringify(dj.state.queue[1].plan) === JSON.stringify({ kind: 'bassSwap', durationMs: 2000, cueIn: 5, cueOut: 30 }),
    JSON.stringify(dj.state.queue[1].plan));

  dj.cmd({ action: 'queue.plan', id: planned, plan: { durationMs: 1500 } });
  await dj.waitFor((s) => s.queue[1].plan.durationMs === 1500);
  const p2 = dj.state.queue[1].plan;
  ok('a partial queue.plan does not clobber sibling fields',
    p2.kind === 'bassSwap' && p2.cueIn === 5 && p2.cueOut === 30, JSON.stringify(p2));

  dj.cmd({ action: 'queue.plan', id: planned, plan: { cueIn: 9 } });
  await dj.waitFor((s) => s.queue[1].plan.cueIn === 9);
  const p3 = dj.state.queue[1].plan;
  ok('a partial queue.plan keeps the other cue point',
    p3.cueOut === 30 && p3.durationMs === 1500 && p3.kind === 'bassSwap', JSON.stringify(p3));

  dj.cmd({ action: 'queue.plan', id: planned, plan: { durationMs: 10 } });
  dj.cmd({ action: 'queue.plan', id: planned, plan: { kind: 'nonsense' } });
  dj.cmd({ action: 'queue.plan', id: planned, plan: { cueOut: 2 } });
  await sleep(250);
  const p4 = dj.state.queue[1].plan;
  ok('an invalid queue.plan patch changes nothing',
    p4.durationMs === 1500 && p4.kind === 'bassSwap' && p4.cueOut === 30, JSON.stringify(p4));

  // Put item 2 back on the fast schedule for the run.
  dj.cmd({ action: 'queue.plan', id: planned, plan: { kind: 'crossfade', durationMs: 1000, cueIn: 0, cueOut: 3 } });
  await dj.waitFor((s) => s.queue[1].plan.cueIn === 0 && s.queue[1].plan.kind === 'crossfade');
  const ids = dj.state.queue.map((v) => v.id);

  // --- cold start
  const mark = dj.frames.length;
  dj.cmd({ action: 'autodj.set', enabled: true });
  await dj.waitFor((s) => s.decks[0].playing, 4000);
  ok('autodj.set is reflected in state', dj.state.autoDj.enabled === true);
  ok('cold start loads the first queue item onto deck A and plays it',
    dj.state.decks[0].video?.id === ids[0] && dj.state.decks[0].playing === true, dj.state.decks[0].video?.title);
  ok('cold start puts the crossfader on the live deck', dj.state.mixer.crossfade === -1, 'xf=' + dj.state.mixer.crossfade);

  await dj.waitFor((s) => s.decks[1].video, 3000);
  ok('the next item is prepped on deck B, paused at its cue-in',
    dj.state.decks[1].video.id === ids[1] && dj.state.decks[1].playing === false && dj.state.decks[1].anchorPos === 0,
    JSON.stringify({ id: dj.state.decks[1].video.id, playing: dj.state.decks[1].playing, pos: dj.state.decks[1].anchorPos }));
  ok('the prepped deck carries the planned out point', dj.state.decks[1].cueOut === 3, 'cueOut=' + dj.state.decks[1].cueOut);
  ok('prepping consumes the queue item', dj.state.queue.length === 1 && dj.state.queue[0].id === ids[2]);

  // Distinguish an eject-and-reload from a plain load: eject clears BPM, load does not.
  dj.cmd({ action: 'deck.bpm', deck: 'a', bpm: 128 });
  await dj.waitFor((s) => s.decks[0].bpm === 128);

  // --- the transition fires by itself near the out point
  await dj.waitFor((s) => s.mixer.auto.active, 6000);
  const fired = dj.frames.slice(mark).find((f) => f.t === 'state' && f.state.mixer.auto.active);
  const au2 = fired.state.mixer.auto;
  const outgoing = fired.state.decks[0];
  const posAtFire = outgoing.anchorPos + ((au2.startedAt - outgoing.anchorAt) / 1000) * outgoing.rateActual;
  ok('auto-advance fires near the out point (3s out, 1s transition -> ~2.0s)',
    Math.abs(posAtFire - 2) < 0.35, `pos=${posAtFire.toFixed(3)}s`);
  ok('auto-advance uses the incoming item plan, not the mixer default',
    au2.durationMs === 1000 && au2.curve === 'smooth' && au2.to === 1, JSON.stringify(au2));
  ok('the incoming deck is started by the transition',
    fired.state.decks[1].playing === true, JSON.stringify({ playing: fired.state.decks[1].playing }));

  // --- rotation
  await dj.waitFor((s) => s.decks[0].video?.id === ids[2], 6000);
  const rotA = dj.state.decks[0];
  ok('the outgoing deck is reloaded with the next queue item, paused at its cue-in',
    rotA.playing === false && rotA.anchorPos === 0 && rotA.cueOut === 3,
    JSON.stringify({ playing: rotA.playing, pos: rotA.anchorPos, cueOut: rotA.cueOut }));
  ok('the outgoing deck was ejected first (channel BPM cleared)', rotA.bpm === 0, 'bpm=' + rotA.bpm);
  ok('the queue has rotated empty', dj.state.queue.length === 0);
  ok('the incoming deck is now the live one', dj.state.decks[1].playing === true && dj.state.mixer.crossfade === 1,
    'xf=' + dj.state.mixer.crossfade);

  // --- no double fire: exactly ONE automation for that rotation, despite a 20Hz tick
  const cycle = dj.frames.slice(mark, dj.frames.findIndex((f, i) => i >= mark && f.t === 'state' && f.state.decks[0].video?.id === ids[2]) + 1);
  const starts = [...new Set(cycle.filter((f) => f.t === 'state' && f.state.mixer.auto.active).map((f) => f.state.mixer.auto.startedAt))];
  ok('auto-advance fires exactly once per track', starts.length === 1, starts.length + ' automation(s): ' + starts.join(','));

  // --- an empty queue just stops: the last track plays out and the spare deck stays ejected
  await dj.waitFor((s) => s.decks[1].video === null, 8000);
  ok('with an empty queue the outgoing deck is left ejected', dj.state.decks[1].video === null);
  ok('the last track keeps playing', dj.state.decks[0].playing === true && dj.state.decks[0].video?.id === ids[2]);

  // --- inert when disabled
  dj.cmd({ action: 'autodj.set', enabled: false });
  await dj.waitFor((s) => s.autoDj.enabled === false);
  dj.cmd({ action: 'queue.addMany', videos: [track('Z1')] });
  await dj.waitFor((s) => s.queue.length === 1);
  dj.cmd({ action: 'deck.cueOut', deck: 'a', sec: 1 });
  dj.cmd({ action: 'deck.seek', deck: 'a', positionSec: 0.9 });
  await sleep(1300);
  ok('auto-advance is inert while disabled',
    dj.state.mixer.auto.active === false && dj.state.queue.length === 1 && dj.state.decks[1].video === null,
    JSON.stringify({ auto: dj.state.mixer.auto.active, queue: dj.state.queue.length, deckB: dj.state.decks[1].video }));
  clearInterval(browsers);
  dj.cmd({ action: 'queue.remove', id: dj.state.queue[0].id });
  await sleep(120);

  const dj2 = new Client('dj2'); await dj2.open();
  dj2.send({ t: 'auth', password: PASS });
  await sleep(250);
  ok('a second DJ login takes the seat', dj2.role === 'dj');
  ok('the previous DJ is demoted', dj.role === 'audience', 'was=' + dj.role);

  const bad = new Client('bad'); await bad.open();
  bad.send({ t: 'auth', password: 'nope' });
  await sleep(200);
  ok('wrong password is refused', bad.role !== 'dj' && bad.frames.some((f) => f.t === 'denied'));

  const login = await fetch(BASE + '/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASS }),
  });
  ok('POST /api/admin/login sets a session cookie',
    login.ok && /dj_session=/.test(login.headers.get('set-cookie') || ''), login.headers.get('set-cookie') || '');
  const badLogin = await fetch(BASE + '/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }),
  });
  ok('bad login is rejected', badLogin.status === 401, 'status=' + badLogin.status);

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('SMOKE ERROR', e); process.exit(2); });
