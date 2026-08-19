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
