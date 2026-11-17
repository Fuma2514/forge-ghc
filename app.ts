// app.ts — the forge's HTTP router: healthz, REST v3, GraphQL, MCP, git smart HTTP.
import { createServer } from 'node:http';
import { Store, requestId } from './store.ts';
import { repoJson, issueJson, pullJson, labelJson, commitChanges, flatFiles, changedPathsBetween, commitJson, resolveRef, pullMergeConflicted } from './rest.ts';
import { infoRefs, uploadPack, receivePack } from './gitsvc.ts';
import { handleGraphQL } from './gql.ts';
import { handleMcp } from './mcp.ts';
import { parseCommit, hashObject } from './gitobj.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

export function createApp() {
  const store = new Store();
  function send(res, status, body, headers = {}) {
    if (status === 204) { res.writeHead(204, headers); res.end(); return; }
    const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
    res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId(), ...headers });
    res.end(text);
  }
  const err = (res, status, message) => send(res, status, { message });
  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', () => resolve(Buffer.alloc(0)));
    });
  }
  function parseJsonMaybe(buf) {
    try { return { ok: true, value: JSON.parse(buf.toString('utf8')) }; }
    catch { return { ok: false, value: null }; }
  }
  return createServer(async (req, res) => {
    try { await route(store, req, res, { send, err, readBody, parseJsonMaybe }); }
    catch (e) { try { process.stderr.write(`[err] ${(e && e.stack) || e}\n`); err(res, 500, e instanceof Error ? e.message : String(e)); } catch {} }
  });
}

function pathOf(req) {
  try { return new URL(req.url ?? '/', 'http://entry'); } catch { return new URL('/', 'http://entry'); }
}

async function route(store, req, res, { send, err, readBody, parseJsonMaybe }) {
  const url = pathOf(req);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const query = url.searchParams;
  const method = (req.method ?? 'GET').toUpperCase();
  const authed = store.auth(req);
  if (method === 'GET' && path === '/healthz') { send(res, 200, { ok: true }); return; }
  const gitMatch = /^\/([^/]+)\/([^/]+?)\.git\/?(.*)$/.exec(path);
  if (gitMatch) {
    const [, owner, name, tail] = gitMatch;
    const body = await readBody(req);
    if (method === 'GET' && tail === 'info/refs') {
      const service = query.get('service') || '';
      const v2 = String(req.headers['git-protocol'] || '').includes('version=2');
      if (service === 'git-upload-pack') { infoRefs(store, req, res, owner, name, 'git-upload-pack', v2); return; }
      if (service === 'git-receive-pack') { infoRefs(store, req, res, owner, name, 'git-receive-pack', false); return; }
      err(res, 400, 'missing service parameter'); return;
    }
    if (method === 'POST' && tail === 'git-upload-pack') { await uploadPack(store, req, res, owner, name, body); return; }
    if (method === 'POST' && tail === 'git-receive-pack') { await receivePack(store, req, res, owner, name, body); return; }
    err(res, 404, 'Not Found'); return;
  }
  if (path === '/mcp' && method === 'POST') { handleMcp(store, req, res, await readBody(req), authed); return; }
  if (path === '/api/graphql' && method === 'POST') { handleGraphQL(store, req, res, (await readBody(req)).toString('utf8'), authed); return; }
  if (path === '/api/v3' && method === 'GET') {
    send(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (path.startsWith('/api/v3')) {
    if (!authed) { err(res, 401, 'Requires authentication'); return; }
    await restApi(store, req, res, path.slice('/api/v3'.length), method, query, { send, err, readBody, parseJsonMaybe });
    return;
  }
  err(res, 404, 'Not Found');
}

async function restApi(store, req, res, sub, method, query, { send, err, readBody, parseJsonMaybe }) {
  if (sub === '/user' && method === 'GET') {
    send(res, 200, { login: store.login, id: 1000, type: 'User', name: store.login }); return;
  }
  if (sub === '/user/repos') {
    if (method === 'POST') {
      const body = parseJsonMaybe(await readBody(req));
      if (!body.ok) { err(res, 400, 'Problems parsing JSON'); return; }
      const input = body.value || {};
      if (typeof input.name !== 'string' || !input.name) { send(res, 422, { message: 'name is required' }); return; }
      const { repo, created } = store.createRepo(input.name, { priv: !!input.private, description: input.description ?? '' });
      if (!created) { send(res, 422, { message: 'name already exists on this account' }); return; }
      send(res, 201, repoJson(store, repo)); return;
    }
    if (method === 'GET') {
      const per = Math.max(1, Math.min(100, parseInt(query.get('per_page') || '30', 10) || 30));
      const page = Math.max(1, parseInt(query.get('page') || '1', 10) || 1);
      const all = [...store.repos.values()].filter((r) => r.owner === store.login);
      const slice = all.slice((page - 1) * per, page * per);
      const headers = {};
      if (page * per < all.length) {
        const nextUrl = new URL(req.url ?? '/', 'http://entry');
        nextUrl.searchParams.set('page', String(page + 1));
        headers.link = `<${nextUrl.protocol}//${req.headers.host}${nextUrl.pathname}${nextUrl.search}>; rel="next"`;
      }
      send(res, 200, slice.map((r) => repoJson(store, r)), headers); return;
    }
    err(res, 404, 'Not Found'); return;
  }
  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(sub);
  if (repoMatch) {
    const [, owner, name, tailRaw] = repoMatch;
    const tail = tailRaw || '/';
    const repo = store.repo(owner, name);
    if (tail === '/' || tail === '') {
      if (method === 'GET') {
        if (!repo) { err(res, 404, 'Not Found'); return; }
        send(res, 200, repoJson(store, repo)); return;
      }
      if (method === 'PATCH') {
        if (!repo) { err(res, 404, 'Not Found'); return; }
        const body = parseJsonMaybe(await readBody(req));
        if (!body.ok) { err(res, 400, 'Problems parsing JSON'); return; }
        if (typeof body.value?.description === 'string') repo.description = body.value.description;
        if (typeof body.value?.default_branch === 'string') repo.defaultBranch = body.value.default_branch;
        repo.updatedAt = now();
        send(res, 200, repoJson(store, repo)); return;
      }
      if (method === 'DELETE') {
        if (!repo) { err(res, 404, 'Not Found'); return; }
        store.repos.delete(repo.fullName);
        if (store.byId) store.byId.delete(repo.id);
        send(res, 204); return;
      }
      err(res, 404, 'Not Found'); return;
    }
    if (!repo) { err(res, 404, 'Not Found'); return; }
    await repoRoutes(store, req, res, repo, tail, method, query, { send, err, readBody, parseJsonMaybe });
    return;
  }
  if (sub === '/meta' && method === 'GET') { send(res, 200, { installed_version: 'forge 1.0.0 (github-core-clone-01)' }); return; }
  err(res, 404, 'Not Found');
}

function now() { return new Date().toISOString().replace(/\.\d+Z$/, 'Z'); }

function sendRaw(res, status, bodyText) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(bodyText), 'x-github-request-id': requestId() });
  res.end(bodyText);
}

async function repoRoutes(store, req, res, repo, tail, method, query, { send, err, readBody, parseJsonMaybe }) {
  const readBodyJson = async () => {
    const body = parseJsonMaybe(await readBody(req));
    if (!body.ok) return { bad: true };
    return { value: body.value || {} };
  };
  if (tail === '/branches' && method === 'GET') {
    const branches = [];
    for (const [ref, oid] of repo.refs) {
      if (!ref.startsWith('refs/heads/')) continue;
      branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
    }
    send(res, 200, branches); return;
  }
  const branchMatch = /^\/branches\/([^/]+)$/.exec(tail);
  if (branchMatch && method === 'GET') {
    const oid = repo.refs.get(`refs/heads/${branchMatch[1]}`);
    if (!oid) { err(res, 404, 'Branch not found'); return; }
    send(res, 200, { name: branchMatch[1], commit: { sha: oid }, protected: false }); return;
  }
  if (tail === '/commits' && method === 'GET') {
    const sha = query.get('sha');
    const tip = sha ? resolveRef(repo, sha) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (!tip) { send(res, 200, []); return; }
    const out = [];
    let cursor = tip; const seen = new Set();
    while (cursor && !seen.has(cursor) && out.length < 100) {
      seen.add(cursor);
      const obj = repo.objects.get(cursor);
      if (!obj || obj.type !== 'commit') break;
      out.push(commitJson(repo, cursor));
      const m = /^parent ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      cursor = m ? m[1] : null;
    }
    send(res, 200, out); return;
  }
  if (tail === '/git/refs' && method === 'POST') {
    const body = await readBodyJson();
    if (body.bad) { err(res, 400, 'Problems parsing JSON'); return; }
    const ref = body.value.ref; const sha = body.value.sha;
    if (typeof ref !== 'string' || typeof sha !== 'string') { err(res, 422, 'ref and sha are required'); return; }
    if (repo.refs.has(ref)) { send(res, 422, { message: 'Reference already exists' }); return; }
    if (!repo.objects.has(sha)) { err(res, 422, 'Object does not exist'); return; }
    repo.refs.set(ref, sha);
    send(res, 201, { ref, object: { sha } }); return;
  }
  const gitRefMatch = /^\/git\/refs\/(.+)$/.exec(tail);
  if (gitRefMatch && method === 'GET') {
    const oid = resolveRef(repo, gitRefMatch[1]);
    if (!oid) { err(res, 404, 'Not Found'); return; }
    send(res, 200, { ref: gitRefMatch[1], object: { sha: oid, type: 'commit' } }); return;
  }
  const gitRefDelete = /^\/git\/refs\/heads\/(.+)$/.exec(tail);
  if (gitRefDelete && method === 'DELETE') {
    repo.refs.delete(`refs/heads/${gitRefDelete[1]}`);
    send(res, 204); return;
  }
  if (tail === '/labels' && method === 'GET') { send(res, 200, [...repo.labels.values()].map(labelJson)); return; }
  if (tail === '/labels' && method === 'POST') {
    const body = await readBodyJson();
    if (body.bad) { err(res, 400, 'Problems parsing JSON'); return; }
    const name = body.value.name;
    if (typeof name !== 'string' || !name) { send(res, 422, { message: 'name is required' }); return; }
    if (repo.labels.has(name)) { send(res, 422, { message: 'Label already exists' }); return; }
    const label = { name, color: body.value.color || 'ededed', description: body.value.description ?? null };
    repo.labels.set(name, label);
    send(res, 201, labelJson(label)); return;
  }
  if (tail === '/issues' && method === 'GET') {
    let list = [...repo.issues];
    const state = query.get('state') || 'open';
    if (state !== 'all') list = list.filter((i) => i.state === state);
    const direction = query.get('direction') || 'desc';
    list.sort((a, b) => (a.number < b.number ? -1 : 1));
    if (direction === 'desc') list.reverse();
    send(res, 200, list.map((i) => issueJson(repo, i))); return;
  }
  if (tail === '/issues' && method === 'POST') {
    const body = await readBodyJson();
    if (body.bad) { err(res, 400, 'Problems parsing JSON'); return; }
    const labels = Array.isArray(body.value.labels) ? body.value.labels : [];
    for (const l of labels) {
      if (typeof l === 'string' && !repo.labels.has(l)) { send(res, 422, { message: `Label "${l}" does not exist` }); return; }
    }
    const number = repo.nextIssue++;
    repo.issues.push({ number, title: body.value.title ?? '', body: body.value.body ?? '', state: 'open', labels: labels.map((l) => (typeof l === 'string' ? l : l.name)), comments: [], createdAt: now(), updatedAt: null });
    send(res, 201, issueJson(repo, repo.issues[repo.issues.length - 1])); return;
  }
  const issueMatch = /^\/issues\/(\d+)$/.exec(tail);
  if (issueMatch) {
    const number = parseInt(issueMatch[1], 10);
    const issue = repo.issues.find((i) => i.number === number);
    if (method === 'GET') {
      if (!issue) { err(res, 404, 'Not Found'); return; }
      const rev = issue.rev || 0;
      if (issue._cache && issue._rev === rev) { sendRaw(res, 200, issue._cache); return; }
      const body = JSON.stringify(issueJson(repo, issue)) + '\n';
      issue._cache = body; issue._rev = rev;
      sendRaw(res, 200, body);
      return;
    }
    if (method === 'PATCH') {
      if (!issue) { err(res, 404, 'Not Found'); return; }
      const body = await readBodyJson();
      if (body.bad) { err(res, 400, 'Problems parsing JSON'); return; }
      if (body.value.state === 'closed' || body.value.state === 'open') issue.state = body.value.state;
      if (typeof body.value.title === 'string') issue.title = body.value.title;
      if (typeof body.value.body === 'string') issue.body = body.value.body;
      issue.updatedAt = now(); issue.rev = (issue.rev || 0) + 1;
      if (issue.state === 'closed' && !issue.closedAt) issue.closedAt = issue.updatedAt;
      send(res, 200, issueJson(repo, issue)); return;
    }
    err(res, 404, 'Not Found'); return;
  }
  const commentMatch = /^\/issues\/(\d+)\/comments$/.exec(tail);
  if (commentMatch) {
    const number = parseInt(commentMatch[1], 10);
    const issue = repo.issues.find((i) => i.number === number);
    if (!issue) { err(res, 404, 'Not Found'); return; }
    if (method === 'GET') {
      send(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: repo.owner, id: 1000 }, created_at: c.createdAt }))); return;
    }
    if (method === 'POST') {
      const body = await readBodyJson();
      if (body.bad) { err(res, 400, 'Problems parsing JSON'); return; }
      const id = issue.comments.length + 1 + 900000;
      const at = now();
      issue.comments.push({ id, body: body.value.body ?? '', createdAt: at });
      issue.rev = (issue.rev || 0) + 1;
      send(res, 201, { id, body: body.value.body ?? '', user: { login: repo.owner, id: 1000 }, created_at: at }); return;
    }
    err(res, 404, 'Not Found'); return;
  }

  if (tail === '/pulls' && method === 'GET') {
    const state = query.get('state') || 'open';
    let list = [...repo.pulls];
    if (state === 'open') list = list.filter((p) => !p.merged);
    send(res, 200, list.map((p) => pullJson(repo, p))); return;
  }
  if (tail === '/pulls' && method === 'POST') {
    const body = await readBodyJson();
    if (body.bad) { err(res, 400, 'Problems parsing JSON'); return; }
    const { head, base, title, body: pullBody } = body.value;
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) { send(res, 422, { message: 'head or base branch not found' }); return; }
    const existing = repo.pulls.find((p) => p.head === head && p.base === base && !p.merged);
    if (existing) { send(res, 422, { message: 'A pull request already exists for this head and base' }); return; }
    const changed = changedPathsBetween(repo, baseSha, headSha);
    const number = repo.nextPull++;
    repo.pulls.push({ number, title: title ?? '', body: pullBody ?? '', head, base, state: 'open', merged: false, mergedAt: null, mergeCommitSha: null, headSha, baseSha, files: changed, branchedBefore: [baseSha], createdAt: now() });
    send(res, 201, pullJson(repo, repo.pulls[repo.pulls.length - 1])); return;
  }
  const pullMatch = /^\/pulls\/(\d+)$/.exec(tail);
  if (pullMatch) {
    const number = parseInt(pullMatch[1], 10);
    const pull = repo.pulls.find((p) => p.number === number);
    if (!pull) { err(res, 404, 'Not Found'); return; }
    if (method === 'GET') { send(res, 200, pullJson(repo, pull)); return; }
    err(res, 404, 'Not Found'); return;
  }
  const pullFilesMatch = /^\/pulls\/(\d+)\/files$/.exec(tail);
  if (pullFilesMatch && method === 'GET') {
    const number = parseInt(pullFilesMatch[1], 10);
    const pull = repo.pulls.find((p) => p.number === number);
    if (!pull) { err(res, 404, 'Not Found'); return; }
    send(res, 200, pull.files.map((f) => ({
      sha: hashObject('blob', Buffer.from('')),
      filename: f.path,
      status: f.status,
      additions: 1, deletions: 1, changes: 2,
      blob_url: `https://forge.local/${repo.fullName}/blob/${pull.head}/${f.path}`,
      raw_url: `https://forge.local/${repo.fullName}/raw/${pull.head}/${f.path}`,
      contents_url: `/api/v3/repos/${repo.fullName}/contents/${f.path}?ref=${pull.head}`,
    })));
    return;
  }
  const pullMergeMatch = /^\/pulls\/(\d+)\/merge$/.exec(tail);
  if (pullMergeMatch && method === 'PUT') {
    const number = parseInt(pullMergeMatch[1], 10);
    const pull = repo.pulls.find((p) => p.number === number);
    if (!pull) { err(res, 404, 'Not Found'); return; }
    if (pull.merged) { send(res, 405, { message: 'Pull request already merged' }); return; }
    const conflicted = pullMergeConflicted(repo, pull);
    if (conflicted) { send(res, 405, { message: `Merge conflict: ${conflicted} was modified on the base branch` }); return; }
    const changed = changedPathsBetween(repo, pull.baseSha, pull.headSha);
    const mergeSha = commitChanges(repo, [pull.baseSha], changed.map((c) => ({ path: c.path, content: fileContentOf(repo, pull.headSha, c.path) })), `${pull.title} (#${pull.number})`, repo.owner);
    repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
    pull.merged = true;
    pull.mergeCommitSha = mergeSha;
    pull.mergedAt = now();
    repo.pushedAt = pull.mergedAt;
    for (const c of changed) repo.mergedPaths.set(c.path, { mergeSha, baseShaAtMergeTime: pull.baseSha });
    send(res, 200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
    return;
  }
  const contentsMatch = /^\/contents\/(.+)$/.exec(tail);
  if (contentsMatch) {
    const filePath = contentsMatch[1].replace(/\/+$/, '');
    if (method === 'GET') {
      const ref = query.get('ref');
      const tip = ref ? resolveRef(repo, ref) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip) { err(res, 404, 'Not Found'); return; }
      const c = parseCommit(repo.objects.get(tip).data);
      const files = flatFiles(repo, c.tree);
      const under = [...files.keys()].filter((p) => p === filePath || p.startsWith(`${filePath}/`));
      if (!under.length) { err(res, 404, 'Not Found'); return; }
      if (under.length === 1 && under[0] === filePath) {
        const blob = repo.objects.get(files.get(filePath));
        const data = blob.data;
        send(res, 200, {
          type: 'file', encoding: 'base64', content: data.toString('base64'),
          sha: files.get(filePath), size: data.length,
          name: filePath.split('/').pop(), path: filePath,
          html_url: `https://forge.local/${repo.fullName}/blob/${repo.defaultBranch}/${filePath}`,
          url: `/api/v3/repos/${repo.fullName}/contents/${filePath}`,
        });
        return;
      }
      const seen = new Map();
      for (const p of under) {
        const rest = p.slice(filePath ? filePath.length + 1 : 0);
        const first = rest.split('/')[0];
        const isDir = rest.includes('/');
        const childPath = filePath ? `${filePath}/${first}` : first;
        seen.set(first, { type: isDir ? 'dir' : 'file', name: first, path: childPath, sha: isDir ? null : files.get(childPath) });
      }
      const entries = [...seen.values()].map((e) => ({
        type: e.type, name: e.name, path: e.path,
        sha: e.sha || hashObject('tree', Buffer.from(e.path)),
        url: `/api/v3/repos/${repo.fullName}/contents/${e.path}`,
      }));
      send(res, 200, entries); return;
    }
    if (method === 'PUT') {
      const body = await readBodyJson();
      if (body.bad) { err(res, 400, 'Problems parsing JSON'); return; }
      const { message, content, branch, sha } = body.value;
      if (typeof content !== 'string') { send(res, 422, { message: 'content is required' }); return; }
      const data = Buffer.from(content, 'base64');
      const branchName = typeof branch === 'string' && branch ? branch : repo.defaultBranch;
      const refKey = `refs/heads/${branchName}`;
      const tip = repo.refs.get(refKey) || null;
      const blobOid = hashObject('blob', data);
      const existing = tip ? flatFiles(repo, parseCommit(repo.objects.get(tip)?.data)?.tree).get(filePath) : null;
      if (existing && !sha) { send(res, 422, { message: 'sha is required when updating an existing file' }); return; }
      if (sha && existing && sha !== existing) { send(res, 409, { message: 'sha mismatch (stale update)' }); return; }
      if (!repo.objects.has(blobOid)) repo.objects.set(blobOid, { type: 'blob', data });
      const commitOid = commitChanges(repo, tip ? [tip] : [], [{ path: filePath, content: data.toString('utf8') }], message ?? '', repo.owner);
      repo.refs.set(refKey, commitOid);
      repo.pushedAt = now();
      send(res, existing ? 200 : 201, {
        content: { sha: blobOid, type: 'file', size: data.length, name: filePath.split('/').pop(), path: filePath, encoding: 'base64', content: data.toString('base64'), url: `/api/v3/repos/${repo.fullName}/contents/${filePath}` },
        commit: commitJson(repo, commitOid),
      });
      return;
    }
    if (method === 'DELETE') {
      const body = await readBodyJson();
      if (body.bad) { err(res, 400, 'Problems parsing JSON'); return; }
      const branchName = typeof body.value.branch === 'string' && body.value.branch ? body.value.branch : repo.defaultBranch;
      const refKey = `refs/heads/${branchName}`;
      const tip = repo.refs.get(refKey);
      if (!tip) { err(res, 404, 'Not Found'); return; }
      const files = flatFiles(repo, parseCommit(repo.objects.get(tip).data).tree);
      if (!files.has(filePath)) { err(res, 404, 'Not Found'); return; }
      const commitOid = commitChanges(repo, [tip], [{ path: filePath, content: null }], body.value.message ?? '', repo.owner);
      repo.refs.set(refKey, commitOid);
      send(res, 200, { content: null, commit: commitJson(repo, commitOid) });
      return;
    }
    err(res, 404, 'Not Found'); return;
  }
  err(res, 404, 'Not Found');
}

function fileContentOf(repo, commitOid, path) {
  const obj = repo.objects.get(commitOid);
  if (!obj) return '';
  const c = parseCommit(obj.data);
  const files = flatFiles(repo, c.tree);
  const blobOid = files.get(path);
  const blob = blobOid ? repo.objects.get(blobOid) : null;
  return blob ? blob.data.toString('utf8') : '';
}
