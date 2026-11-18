// js/sync.js when GitHub says no: expired sign-in, stale sha (someone else wrote first), server errors,
// files over 1 MB, a token without write access. These paths guard Agustín's ride history in rodillo-data.
import assert from 'node:assert/strict';
import { GitHubSync, PLAN_PATH } from '../js/sync.js';

let n = 0;
const ok = (name) => { n++; console.log('ok -', name); };
const b64 = (s) => Buffer.from(s).toString('base64');

// A fake GitHub contents API. `fail` holds scripted answers: [method, path regex, status], used once each in order.
function fakeGitHub(files = {}) {
  let seq = 0;
  const calls = [], fail = [];
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body ?? '') });
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const u = new URL(url), path = u.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    calls.push(`${method} ${path}`);
    const f = fail.findIndex(([m, re]) => m === method && re.test(path));
    if (f >= 0) return res(fail.splice(f, 1)[0][2], { message: 'scripted' });
    if (path === '') return res(200, { permissions: { push: true } });
    const blob = path.match(/^\/git\/blobs\/(.+)$/);
    if (blob) { const e = Object.values(files).find((x) => x.sha === blob[1]); return res(200, { content: b64(e.text) }); }
    const p = path.replace(/^\/contents\//, '');
    if (method === 'GET') {
      const e = files[p];
      if (!e) return res(404, {});
      return res(200, e.big ? { sha: e.sha, content: '', download_url: 'x' } : { sha: e.sha, content: b64(e.text) });
    }
    if (method === 'PUT') {
      const body = JSON.parse(opts.body), cur = files[p];
      if (cur && body.sha !== cur.sha) return res(cur && !body.sha ? 422 : 409, { message: 'sha' });
      files[p] = { sha: `s${++seq}`, text: Buffer.from(body.content, 'base64').toString() };
      return res(200, { content: { sha: files[p].sha } });
    }
    return res(500, {});
  };
  return { files, calls, fail, fetchImpl, json: (p) => JSON.parse(files[p].text) };
}

// expired sign-in: one refresh, then the call goes through; a pasted token gets no retry
{
  const g = fakeGitHub({ 'a.json': { sha: 'a1', text: '{"x":1}' } });
  g.fail.push(['GET', /a\.json/, 401]);
  const asked = [];
  const s = new GitHubSync({ token: async (force) => { asked.push(force); return force ? 'new' : 'old'; }, fetchImpl: g.fetchImpl });
  assert.deepEqual((await s.getJson('a.json')).json, { x: 1 });
  assert.deepEqual(asked, [false, true]);

  g.fail.push(['GET', /a\.json/, 401]);
  const pasted = new GitHubSync({ token: 'github_pat_x', fetchImpl: g.fetchImpl });
  await assert.rejects(pasted.getJson('a.json'), (e) => e.status === 401);
  ok('401: signed-in token refreshes once and retries, a pasted token fails');
}

// server errors surface with their status, 404 reads as "not there"
{
  const g = fakeGitHub();
  const s = new GitHubSync({ token: 't', fetchImpl: g.fetchImpl });
  assert.equal(await s.getJson('missing.json'), null);
  g.fail.push(['GET', /x\.json/, 502]);
  await assert.rejects(s.getJson('x.json'), (e) => e.status === 502 && /GitHub 502/.test(e.message));
  ok('404 is null, 5xx throws with the status');
}

// files over 1 MB come back without content: read through the blob API
{
  const g = fakeGitHub({ 'index.json': { sha: 'b1', text: '{"rides":[1,2,3]}', big: true } });
  const s = new GitHubSync({ token: 't', fetchImpl: g.fetchImpl });
  assert.deepEqual((await s.getJson('index.json')).json, { rides: [1, 2, 3] });
  assert.ok(g.calls.includes('GET /git/blobs/b1'));
  ok('big file read through the blob API');
}

// token checks in Settings > Sync
{
  const g = fakeGitHub();
  g.fail.push(['GET', /^$/, 404]);
  const s = new GitHubSync({ token: 't', repo: 'o/r', fetchImpl: g.fetchImpl });
  await assert.rejects(s.test(), /Repo o\/r not found/);
  const ro = new GitHubSync({ token: 't', fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ permissions: { push: false } }) }) });
  await assert.rejects(ro.test(), /can read but not write/);
  assert.ok(await s.test());
  ok('token test: repo not found, read-only token, good token');
}

// plan edits retry when the coach wrote in between, give up after 3, and don't retry other errors
{
  const g = fakeGitHub({ [PLAN_PATH]: { sha: 'p1', text: '{"n":0}' } });
  const s = new GitHubSync({ token: 't', fetchImpl: g.fetchImpl });
  g.fail.push(['PUT', /plan/, 409], ['PUT', /plan/, 422]);
  const plan = await s.updatePlan((p) => { p.n++; }, 'test');
  assert.equal(plan.n, 1);
  assert.equal(g.json(PLAN_PATH).n, 1, 'written once, from a fresh read each attempt');

  g.fail.push(['PUT', /plan/, 409], ['PUT', /plan/, 409], ['PUT', /plan/, 409]);
  await assert.rejects(s.updatePlan((p) => { p.n++; }, 'test'), /after 3 attempts/);
  assert.equal(g.json(PLAN_PATH).n, 1, 'nothing written');

  g.fail.push(['PUT', /plan/, 403]);
  const before = g.calls.length;
  await assert.rejects(s.updatePlan((p) => { p.n++; }, 'test'), (e) => e.status === 403);
  assert.equal(g.calls.filter((c, i) => i >= before && c.startsWith('PUT')).length, 1, '403 is not retried');

  await assert.rejects(new GitHubSync({ token: 't', fetchImpl: fakeGitHub().fetchImpl }).updatePlan(() => {}, 'x'), /not found/);
  ok('updatePlan: retries stale sha, stops after 3, no retry on 403, missing plan');
}

// updateJson creates the file when missing and retries a stale sha
{
  const g = fakeGitHub();
  const s = new GitHubSync({ token: 't', fetchImpl: g.fetchImpl });
  await s.updateJson('workouts/mine.json', (d) => { d.workouts.push('a'); }, 'm', () => ({ workouts: [] }));
  g.fail.push(['PUT', /mine/, 409]);
  await s.updateJson('workouts/mine.json', (d) => { d.workouts.push('b'); }, 'm', () => ({ workouts: [] }));
  assert.deepEqual(g.json('workouts/mine.json').workouts, ['a', 'b']);
  g.fail.push(['PUT', /mine/, 409], ['PUT', /mine/, 409], ['PUT', /mine/, 409]);
  await assert.rejects(s.updateJson('workouts/mine.json', () => {}, 'm'), /after 3 attempts/);
  ok('updateJson: creates, retries stale sha, stops after 3');
}

// a ride synced twice overwrites its file; index.json survives a concurrent write
{
  const g = fakeGitHub({ 'index.json': { sha: 'i1', text: JSON.stringify({ version: 1, rides: [{ id: '2026-11-01-a' }] }) } });
  const s = new GitHubSync({ token: 't', fetchImpl: g.fetchImpl });
  const ride = { summary: { id: '2026-11-17-x', name: 'VO2' }, streams: {} };
  await s.pushRide(ride);
  ride.summary.name = 'VO2 (edited)';
  g.fail.push(['PUT', /index\.json/, 409]);
  const index = await s.pushRide(ride);
  assert.equal(g.json('rides/2026/2026-11-17-x.json').summary.name, 'VO2 (edited)');
  assert.deepEqual(index.rides.map((r) => r.id), ['2026-11-01-a', '2026-11-17-x']);
  assert.equal(g.json('index.json').rides.length, 2, 'no duplicate entry');

  g.fail.push(['PUT', /index\.json/, 409], ['PUT', /index\.json/, 409], ['PUT', /index\.json/, 409]);
  await assert.rejects(s.pushRide(ride), /index\.json after 3 attempts/);
  g.fail.push(['PUT', /rides\//, 500]);
  await assert.rejects(s.pushRide(ride), (e) => e.status === 500);
  ok('pushRide: overwrites an existing ride, retries index, surfaces errors');
}

// putJsonFresh retries once on a stale sha, then gives up
{
  const g = fakeGitHub({ 'coach/x.json': { sha: 'x1', text: '{}' } });
  const s = new GitHubSync({ token: 't', fetchImpl: g.fetchImpl });
  g.fail.push(['PUT', /x\.json/, 409]);
  await s.putJsonFresh('coach/x.json', { a: 1 }, 'm');
  assert.deepEqual(g.json('coach/x.json'), { a: 1 });
  g.fail.push(['PUT', /x\.json/, 409], ['PUT', /x\.json/, 409]);
  await assert.rejects(s.putJsonFresh('coach/x.json', { a: 2 }, 'm'), (e) => e.status === 409);
  ok('putJsonFresh: one retry on a stale sha');
}

console.log(`sync errors: ${n} tests passed`);
