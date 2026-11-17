
// mcp.ts — the MCP endpoint: JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28 style.
// server/discover answers identity + capabilities + supportedVersions; tools/list, tools/call act
// on the same store as REST. Legacy initialize handshake is accepted too.
import { commitChanges, changedPathsBetween, flatFiles, pullMergeConflicted } from './rest.ts';
import { parseCommit } from './gitobj.ts';

const PREFERRED = '2026-07-28';
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch to a base branch',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge (squash) a pull request',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] },
  },
];

function resolveFullRepo(store, args) {
  let owner = args.owner, repo = args.repo;
  if ((!owner || !repo) && typeof args.full_name === 'string') {
    const [o, r] = args.full_name.split('/');
    owner = owner || o;
    repo = repo || r;
  }
  if (!owner || !repo) return null;
  return store.repo(owner, repo);
}

export function handleMcp(store, req, res, bodyBuf, authed) {
  if (!authed) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } }));
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(bodyBuf.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return;
  }
  if (Array.isArray(parsed)) {
    const out = parsed.map((op) => dispatch(store, op, authed, req));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }
  const out = dispatch(store, parsed, authed, req);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(out));
}

function respond(op, result) {
  return { jsonrpc: '2.0', id: op?.id ?? null, result };
}
function respondError(op, code, message, extra) {
  return { jsonrpc: '2.0', id: op?.id ?? null, error: { code, message, ...(extra || {}) } };
}

function dispatch(store, op, authed, req) {
  const method = typeof op?.method === 'string' ? op.method : '';
  const needsAuth = method !== 'initialize' && method !== 'server/discover' && !method.startsWith('notifications/');
  if (needsAuth && !authed) return respondError(op, -32000, 'Unauthorized');
  const params = op?.params && typeof op.params === 'object' ? op.params : {};
  switch (method) {
    case 'server/discover': {
      return respond(op, {
        serverInfo: { name: 'forge', version: '1.0.0' },
        capabilities: { tools: { listChanged: false } },
        supportedVersions: [PREFERRED, ...LEGACY],
        instructions: 'A GitHub-compatible forge',
      });
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PREFERRED;
      const chosen = requested === PREFERRED || LEGACY.includes(requested) ? requested : PREFERRED;
      const result = {
        protocolVersion: chosen,
        serverInfo: { name: 'forge', version: '1.0.0' },
        capabilities: { tools: { listChanged: false } },
      };
      res_session(req, res_result_session(req));
      return respond(op, result);
    }
    case 'notifications/initialized':
      return null; // notification: no response
    case 'tools/list':
      return respond(op, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      return callTool(store, op, name, args);
    }
    case 'ping':
      return respond(op, {});
    default:
      return respondError(op, -32601, `Method not found: ${method}`);
  }
}

function res_result_session() { return null; }
function res_session() {}

function callTool(store, op, name, args) {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const find = (suffix) => norm.endsWith(suffix.replace(/[^a-z0-9]/g, '').toLowerCase());
  try {
    if (find('create_repo') || find('createrepository')) {
      if (typeof args.name !== 'string' || !args.name) return respondError(op, -32602, 'Invalid params: name is required');
      const { repo } = store.createRepo(args.name, { priv: !!args.private, description: args.description ?? '' });
      return respond(op, toolJson(repoJsonFor(store, repo)));
    }
    if (find('get_repo') || find('getrepository')) {
      const repo = resolveFullRepo(store, args);
      if (!repo) return respond(op, { content: [{ type: 'text', text: 'Repository not found' }], isError: true });
      return respond(op, toolJson(repoJsonFor(store, repo)));
    }
    if (find('create_issue')) {
      const repo = resolveFullRepo(store, args);
      if (!repo) return respond(op, { content: [{ type: 'text', text: 'Repository not found' }], isError: true });
      if (typeof args.title !== 'string' || !args.title) return respondError(op, -32602, 'Invalid params: title is required');
      const number = repo.nextIssue++;
      const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      repo.issues.push({ number, title: args.title, body: args.body ?? '', state: 'open', labels: [], comments: [], createdAt: now, updatedAt: null });
      return respond(op, toolJson({ number, id: `100000${number}`, title: args.title, state: 'open' }));
    }
    if (find('list_issues')) {
      const repo = resolveFullRepo(store, args);
      if (!repo) return respond(op, { content: [{ type: 'text', text: 'Repository not found' }], isError: true });
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues.filter((i) => state === 'all' || i.state === state);
      return respond(op, toolJson(list.map((i) => ({ number: i.number, title: i.title, body: i.body, state: i.state, id: `100000${i.number}` }))));
    }
    if (find('create_pull_request')) {
      const repo = resolveFullRepo(store, args);
      if (!repo) return respond(op, { content: [{ type: 'text', text: 'Repository not found' }], isError: true });
      for (const k of ['title', 'head', 'base']) {
        if (typeof args[k] !== 'string' || !args[k]) return respondError(op, -32602, `Invalid params: ${k} is required`);
      }
      const headSha = repo.refs.get(`refs/heads/${args.head}`);
      const baseSha = repo.refs.get(`refs/heads/${args.base}`);
      if (!headSha || !baseSha) return respond(op, { content: [{ type: 'text', text: 'head or base branch not found' }], isError: true });
      const changed = changedPathsLite(repo, baseSha, headSha);
      const number = repo.nextPull++;
      const pull = { number, title: args.title, body: '', head: args.head, base: args.base, state: 'open', merged: false, mergedAt: null, mergeCommitSha: null, headSha, baseSha, files: changed, branchedBefore: [baseSha], createdBefore: false, createdAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
      repo.pulls.push(pull);
      return respond(op, toolJson({ number, state: 'open', head: args.head, base: args.base }));
    }
    if (find('merge_pull_request')) {
      const repo = resolveFullRepo(store, args);
      if (!repo) return respond(op, { content: [{ type: 'text', text: 'Repository not found' }], isError: true });
      const pullNumber = args.pull_number ?? args.pullNumber ?? args.number;
      if (typeof pullNumber !== 'number') return respondError(op, -32602, 'Invalid params: pull_number is required');
      const pull = repo.pulls.find((p) => p.number === pullNumber);
      if (!pull) return respond(op, { content: [{ type: 'text', text: 'Pull request not found' }], isError: true });
      if (pull.merged) return respond(op, { content: [{ type: 'text', text: 'Already merged' }], isError: true });
      const conflicted = pullMergeConflicted(repo, pull);
      if (conflicted) return respond(op, { content: [{ type: 'text', text: `Merge conflicted: ${conflicted}` }], isError: true });
      const changed = changedPathsLite(repo, pull.baseSha, pull.headSha);
      const mergeSha = commitChanges(repo, [pull.baseSha], changed.map((c) => ({ path: c.path, content: fileContentLite(repo, pull.headSha, c.path) })), `${pull.title} (#${pull.number})`, repo.owner);
      repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
      pull.merged = true;
      pull.mergeCommitSha = mergeSha;
      pull.mergedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      repo.mergedPaths = repo.mergedPaths || new Map();
      for (const c of changed) repo.mergedPaths.set(c.path, { mergeSha, baseShaAtMergeTime: pull.baseSha });
      return respond(op, toolJson({ merged: true, sha: mergeSha, number: pull.number }));
    }
    return respondError(op, -32602, `Unknown tool: ${name}`);
  } catch (err) {
    return respond(op, { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true });
  }
}

function toolJson(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], isError: false };
}

function repoJsonFor(store, repo) {
  return { id: repo.id, name: repo.name, full_name: repo.fullName, owner: { login: repo.owner }, private: repo.private, default_branch: repo.defaultBranch };
}

function changedPathsLite(repo, baseSha, headSha) {
  return changedPathsBetween(repo, baseSha, headSha);
}

function pullConflictsLite(repo, pull) {
  repo.mergedPaths = repo.mergedPaths || new Map();
  for (const c of pull.files || []) {
    const merged = repo.mergedPaths.get(c.path);
    if (merged && merged.baseShaAtMergeTime !== pull.baseSha) return c.path;
  }
  return null;
}

function fileContentLite(repo, commitOid, path) {
  const obj = repo.objects.get(commitOid);
  if (!obj) return '';
  const c = parseCommit(obj.data);
  const files = flatFiles(repo, c.tree);
  const blobOid = files.get(path);
  const blob = blobOid ? repo.objects.get(blobOid) : null;
  return blob ? blob.data.toString('utf8') : '';
}
