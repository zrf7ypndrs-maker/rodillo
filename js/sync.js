// Push rides to the private rodillo-data repo through the GitHub contents API.

export const DEFAULT_REPO = 'zrf7ypndrs-maker/rodillo-data';
// Plan and custom workouts the coach writes into the data repo; they override the public library.
export const PLAN_PATH = 'coach/plan.json';
export const WORKOUTS_PATH = 'coach/workouts.json';

function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function unb64(s) {
  const bin = atob(s.replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export class GitHubSync {
  // token: a string (pasted fine-grained token) or async (force) => string (GitHub sign-in, refreshes itself)
  constructor({ token, repo = DEFAULT_REPO, branch = 'main', fetchImpl } = {}) {
    this.token = token;
    this.repo = repo;
    this.branch = branch;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
  }

  get configured() { return !!this.token; }

  async api(path, opts = {}, retried = false) {
    const token = typeof this.token === 'function' ? await this.token(retried) : this.token;
    const res = await this.fetch(`https://api.github.com/repos/${this.repo}${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      cache: 'no-store',
    });
    // signed-in token revoked or expired early: refresh once and retry
    if (res.status === 401 && typeof this.token === 'function' && !retried) return this.api(path, opts, true);
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`GitHub ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /** Verifies the token can write to the repo. */
  async test() {
    const r = await this.api('');
    if (!r) throw new Error(`Repo ${this.repo} not found (or the token has no access to it)`);
    if (r.permissions && !r.permissions.push) throw new Error('Token can read but not write. Set Contents to "Read and write".');
    return r;
  }

  async getJson(path) {
    const r = await this.api(`/contents/${path}?ref=${this.branch}`);
    if (!r) return null;
    let text;
    if (r.content) text = unb64(r.content);
    else if (r.download_url || r.git_url) {
      // files > 1 MB come back without inline content: use the blob API
      const blob = await this.api(`/git/blobs/${r.sha}`);
      text = unb64(blob.content);
    }
    return { sha: r.sha, json: JSON.parse(text) };
  }

  async putJson(path, obj, message, sha) {
    return this.api(`/contents/${path}`, {
      method: 'PUT',
      body: JSON.stringify({ message, content: b64(JSON.stringify(obj, null, path.endsWith('index.json') || path.startsWith('coach/') ? 2 : 0)), branch: this.branch, ...(sha ? { sha } : {}) }),
    });
  }

  /** Overwrite a file whatever its current sha (retries once if it changed underneath). */
  async putJsonFresh(path, obj, message) {
    for (let attempt = 0; ; attempt++) {
      const cur = await this.api(`/contents/${path}?ref=${this.branch}`);
      try { return await this.putJson(path, obj, message, cur?.sha); }
      catch (e) { if (attempt >= 1 || (e.status !== 409 && e.status !== 422)) throw e; }
    }
  }

  /**
   * Read-modify-write coach/plan.json (retries when the coach or another device wrote it in between).
   * fn(plan) edits the plan in place. Returns the plan as written.
   */
  async updatePlan(fn, message) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await this.getJson(PLAN_PATH);
      if (!cur) throw new Error(`${PLAN_PATH} not found in ${this.repo}`);
      fn(cur.json);
      try {
        await this.putJson(PLAN_PATH, cur.json, message, cur.sha);
        return cur.json;
      } catch (e) {
        if (e.status !== 409 && e.status !== 422) throw e;
      }
    }
    throw new Error(`Could not update ${PLAN_PATH} after 3 attempts`);
  }

  /** Write the full ride file, then upsert its summary into index.json. */
  async pushRide(ride) {
    const s = ride.summary;
    const path = `rides/${s.id.slice(0, 4)}/${s.id}.json`;
    try {
      await this.putJson(path, ride, `Ride ${s.id}: ${s.name}`);
    } catch (e) {
      if (e.status !== 422 && e.status !== 409) throw e;
      const cur = await this.getJson(path); // already exists: overwrite
      await this.putJson(path, ride, `Ride ${s.id}: ${s.name} (update)`, cur?.sha);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await this.getJson('index.json');
      const index = cur?.json || { version: 1, rides: [] };
      index.rides = index.rides.filter((r) => r.id !== s.id);
      index.rides.push(s);
      index.rides.sort((a, b) => (a.id < b.id ? -1 : 1));
      try {
        await this.putJson('index.json', index, `Index: ${s.id}`, cur?.sha);
        return index;
      } catch (e) {
        if (e.status !== 409 && e.status !== 422) throw e; // stale sha: retry
      }
    }
    throw new Error('Could not update index.json after 3 attempts');
  }

  /**
   * Adds many rides in ONE commit (history import) through the git data API, with index.json
   * merged. Files go inline in tree requests, a few MB at a time, so a big import costs a handful
   * of API calls instead of two commits per ride. Retries if someone else pushed in between.
   */
  async pushRides(docs, message, onProgress = () => {}) {
    const CHUNK = 3e6;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ref = await this.api(`/git/ref/heads/${this.branch}`);
      const head = ref.object.sha;
      const commit = await this.api(`/git/commits/${head}`);
      const cur = await this.api(`/contents/index.json?ref=${head}`);
      const index = cur ? JSON.parse(unb64(cur.content || (await this.api(`/git/blobs/${cur.sha}`)).content)) : { version: 1, rides: [] };
      const ids = new Set(docs.map((d) => d.summary.id));
      index.rides = index.rides.filter((r) => !ids.has(r.id)).concat(docs.map((d) => d.summary));
      index.rides.sort((a, b) => (a.id < b.id ? -1 : 1));
      const files = docs.map((d) => ({ path: `rides/${d.summary.id.slice(0, 4)}/${d.summary.id}.json`, content: JSON.stringify(d) }));
      files.push({ path: 'index.json', content: JSON.stringify(index, null, 2) });
      let tree = commit.tree.sha, batch = [], size = 0, done = 0;
      const flush = async () => {
        if (!batch.length) return;
        const t = await this.api('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: tree, tree: batch.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })) }) });
        tree = t.sha; done += batch.length; batch = []; size = 0;
        onProgress(Math.min(done, docs.length), docs.length);
      };
      for (const f of files) {
        if (size + f.content.length > CHUNK) await flush();
        batch.push(f); size += f.content.length;
      }
      await flush();
      const c = await this.api('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree, parents: [head] }) });
      try {
        await this.api(`/git/refs/heads/${this.branch}`, { method: 'PATCH', body: JSON.stringify({ sha: c.sha, force: false }) });
        return index;
      } catch (e) {
        if (e.status !== 422 && e.status !== 409) throw e; // not a fast-forward: someone pushed, start over
      }
    }
    throw new Error('Could not commit the import after 3 attempts');
  }

  async fetchIndex() {
    const r = await this.getJson('index.json');
    return r?.json?.rides || [];
  }
}
