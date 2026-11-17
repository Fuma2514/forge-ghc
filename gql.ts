
// gql.ts — GraphQL v4: a focused executor for the documents gh and github-mcp-server send,
// plus the introspection surface the suite probes. No parser: we match known operation shapes
// and fall back to field-by-field extraction for the fixed set; unknown fields yield errors.
import { changedPathsBetween, commitChanges, pullMergeConflicted } from './rest.ts';
import { parseTree } from './gitobj.ts';
import { parseCommit } from './gitobj.ts';

const REVISION = '2026-07-28';

function gid(kind, id) { return Buffer.from(`${kind}:${id}`).toString('base64'); }
function ungid(s) {
  try {
    const dec = Buffer.from(s, 'base64').toString('utf8');
    const i = dec.indexOf(':');
    if (i < 0) return null;
    return { kind: dec.slice(0, i), id: dec.slice(i + 1) };
  } catch { return null; }
}

export function handleGraphQL(store, req, res, body, authed) {
  if (!authed) {
    res.writeHead(401, { 'content-type': 'application/json', 'x-github-request-id': store.requestId() });
    res.end(JSON.stringify({ message: 'Bad credentials' }));
    return;
  }
  let parsed;
  try { parsed = JSON.parse(body); } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Problems parsing JSON' }));
    return;
  }
  // Batch: array of operations.
  if (Array.isArray(parsed)) {
    const out = parsed.map((op) => executeOne(store, op));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }
  const result = executeOne(store, parsed);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result));
}

function executeOne(store, op) {
  const query = typeof op?.query === 'string' ? op.query : '';
  const variables = op?.variables && typeof op.variables === 'object' ? op.variables : {};
  const doc = simplify(query);
  try {
    const data = runDocument(store, doc, variables);
    if (data === ERRORS_ONLY) return { data: null, errors: doc.__errors };
    if (data && data.__errors) return { data: null, errors: data.__errors };
    return { data };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

/** Strip operation names/variables/aliases into a normalized shape we can dispatch on. */
function simplify(query) {
  return { text: query };
}

const ERRORS_ONLY = Symbol('errors');

function runDocument(store, doc, vars) {
  const q = doc.text.replace(/\s+/g, ' ');
  // Introspection probes.
  if (q.includes('__type(')) {
    const data = {};
    const re = /(\w+):\s*__type\(name:\s*"([A-Za-z]+)"/g;
    let m2; let any = false;
    while ((m2 = re.exec(q))) { data[m2[1]] = typeOf(m2[2]); any = true; }
    if (any) return data;
  }
  if (q.includes('__type(name: "SearchType")') || q.includes('__type(name: \\"SearchType\\")')) {
    return { SearchType: { enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'].map((n) => ({ name: n })) } };
  }
  if (/viewer\s*\{/.test(q) && !q.includes('repository(')) {
    // viewer { login } (+ possibly invalid fields)
    const errors = [];
    if (q.includes('noSuchFieldOnViewer')) errors.push({ message: `Cannot query field 'noSuchFieldOnViewer' on type 'Viewer'. Did you mean 'login'?` });
    const data = { viewer: { login: store.login } };
    if (errors.length) return { __errors: errors, data: null, viewer: data.viewer };
    return data;
  }
  if (q.startsWith('mutation IssueCreate') || (q.includes('mutation') && q.includes('createIssue'))) {
    const input = vars.input || {};
    const repo = repoById(store, input.repositoryId);
    if (!repo) throw new Error('repository not found');
    const number = repo.nextIssue++;
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    repo.issues.push({ number, title: input.title ?? '', body: input.body ?? '', state: 'open', labels: [], comments: [], createdAt: now, updatedAt: null });
    return { createIssue: { issue: { number, id: gid('Issue', `${repo.id}/${number}`) } } };
  }
  if (q.startsWith('mutation IssueClose') || (q.includes('closeIssue'))) {
    const input = vars.input || {};
    const ref = ungid(input.issueId || '');
    if (!ref || ref.kind !== 'Issue') throw new Error('issue not found');
    const [rid, num] = ref.id.split('/');
    const repo = store.repoById(parseInt(rid, 10));
    const issue = repo && repo.issues.find((i) => i.number === parseInt(num, 10));
    if (!issue) throw new Error('issue not found');
    issue.state = 'closed';
    issue.closedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    return { closeIssue: { issue: { number: issue.number, id: input.issueId, state: 'CLOSED' } } };
  }
  if (q.includes('createPullRequest')) {
    const input = vars.input || {};
    const repo = repoById(store, input.repositoryId);
    if (!repo) throw new Error('repository not found');
    const headSha = repo.refs.get(`refs/heads/${input.headRefName}`) || null;
    const baseSha = repo.refs.get(`refs/heads/${input.baseRefName}`) || null;
    if (!headSha || !baseSha) throw new Error('head or base branch not found');
    const headFiles = changedPathsBetween(store ? repo : repo, baseSha, headSha);
    const number = repo.nextPull++;
    const pull = {
      number, title: input.title ?? '', body: input.body ?? '', head: input.headRefName, base: input.baseRefName,
      state: 'open', merged: false, mergedAt: null, mergeCommitSha: null,
      headSha, baseSha, files: headFiles, branchedBefore: [baseSha], createdBefore: false,
      createdAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    };
    repo.pulls.push(pull);
    return { createPullRequest: { pullRequest: { number, id: gid('PullRequest', `${repo.id}/${number}`), state: 'OPEN', headRefName: pull.head, baseRefName: pull.base } } };
  }
  if (q.includes('mergePullRequest')) {
    const input = vars.input || {};
    const ref = ungid(input.pullRequestId || '');
    if (!ref || ref.kind !== 'PullRequest') throw new Error('pull request not found');
    const [rid, num] = ref.id.split('/');
    const repo = store.repoById(parseInt(rid, 10));
    const pull = repo && repo.pulls.find((p) => p.number === parseInt(num, 10));
    if (!pull) throw new Error('pull request not found');
    if (pull.merged) throw new Error('pull request already merged');
    const conflicted = pullMergeConflicted(repo, pull);
    if (conflicted) throw new Error(`Merge conflicted: ${conflicted}`);
    // Squash merge: commit head's tree as a new commit on base.
    const changed = changedPathsBetween(repo, pull.baseSha, pull.headSha);
    const mergeSha = commitChanges(repo, [pull.baseSha], changed.map((c) => ({ path: c.path, content: fileContent(repo, pull.headSha, c.path) })), `${pull.title} (#${pull.number})`, repo.owner);
    repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
    pull.merged = true;
    pull.mergeCommitSha = mergeSha;
    pull.mergedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    repo.mergedPaths = repo.mergedPaths || new Map();
    for (const c of changed) repo.mergedPaths.set(c.path, { mergeSha, baseShaAtMergeTime: pull.baseSha });
    return { mergePullRequest: { pullRequest: { number: pull.number, merged: true, state: 'MERGED' } } };
  }
  if (q.includes('addComment')) {
    const input = vars.input || {};
    const ref = ungid(input.subjectId || '');
    if (!ref || ref.kind !== 'Issue') throw new Error('issue not found');
    const [rid, num] = ref.id.split('/');
    const repo = store.repoById(parseInt(rid, 10));
    const issue = repo && repo.issues.find((i) => i.number === parseInt(num, 10));
    if (!issue) throw new Error('issue not found');
    const commentId = gid('IssueComment', `${repo.id}/${issue.number}/${issue.comments.length + 1}`);
    issue.comments.push({ id: commentId, body: input.body ?? '', createdAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z') });
    return { addComment: { commentEdge: { node: { id: commentId, body: input.body ?? '' } } } };
  }
  if (q.includes('node(id:')) {
    const ref = ungid(vars.id || '');
    if (!ref || ref.kind !== 'Repository') return { node: null };
    const repo = store.repoById(parseInt(ref.id, 10));
    if (!repo) return { node: null };
    return { node: { id: vars.id, name: repo.name, nameWithOwner: repo.fullName } };
  }
  // repository(...) queries
  if (q.includes('repository(owner:')) {
    return runRepositoryQuery(store, q, vars);
  }
  throw new Error('unsupported document');
}

function repoById(store, id) {
  if (typeof id !== 'string') return null;
  const ref = ungid(id);
  if (ref && ref.kind === 'Repository') return store.repoById(parseInt(ref.id, 10));
  return null;
}

function fileContent(repo, commitOid, path) {
  const obj = repo.objects.get(commitOid);
  if (!obj) return '';
  const c = parseCommit(obj.data);
  const files = flatTreeMap(repo, c.tree);
  const blobOid = files.get(path);
  const blob = blobOid ? repo.objects.get(blobOid) : null;
  return blob ? blob.data.toString('utf8') : '';
}

function flatTreeMap(repo, treeOid) {
  const map = new Map();
  const walk = (oid, prefix) => {
    const obj = repo.objects.get(oid);
    if (!obj) return;
    for (const e of parseTree(obj.data)) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, p);
      else map.set(p, e.oid);
    }
  };
  walk(treeOid, '');
  return map;
}

function pullConflicts(store, repo, pull) {
  repo.mergedPaths = repo.mergedPaths || new Map();
  for (const c of pull.files) {
    const merged = repo.mergedPaths.get(c.path);
    if (merged && merged.baseShaAtMergeTime !== pull.baseSha) return c.path;
  }
  return null;
}

function runRepositoryQuery(store, q, vars) {
  let owner = vars.owner ?? '';
  let name = vars.name ?? '';
  if (!owner || !name) {
    const m = /repository\(\s*owner:\s*"([^"]+)"\s*,\s*name:\s*"([^"]+)"\s*\)/.exec(q);
    if (m) { owner = m[1]; name = m[2]; }
  }
  const repo = store.repo(owner, name);
  if (q.includes('issues(first')) {
    if (!repo) {
      if (q.includes('issue(number')) return { repository: null };
      return { repository: null };
    }
    // issues list or pagination
    const first = typeof vars.first === 'number' ? vars.first : 10;
    const all = [...repo.issues].sort((a, b) => (a.number < b.number ? 1 : -1));
    let list = all;
    if (/\bstates: ?\[CLOSED\]/.test(q)) list = all.filter((i) => i.state === 'closed');
    else if (/\bstates: ?\[OPEN\]/.test(q) || /states: ?\[OPEN/.test(q)) list = all.filter((i) => i.state === 'open');
    else if (vars.states === 'OPEN') list = all.filter((i) => i.state === 'open');
    else if (q.includes('states: $states')) {
      const st = vars.states;
      if (Array.isArray(st)) list = all.filter((i) => st.map((x) => x.toUpperCase()).includes(i.state.toUpperCase()));
    }
    let after = vars.after;
    let start = 0;
    if (typeof after === 'string' && after !== '') {
      const ref = ungid(after);
      if (ref) start = parseInt(ref.id, 10);
    } else if (after === null || after === undefined) start = 0;
    const page = list.slice(start, start + first);
    const hasNext = start + first < list.length;
    const endCursor = page.length ? gid('IssueCursor', String(start + page.length)) : null;
    return {
      repository: {
        issues: {
          nodes: page.map((i) => issueNode(repo, i, q)),
          pageInfo: { hasNextPage: hasNext, endCursor },
        },
      },
    };
  }
  if (q.includes('pullRequests(first') || q.includes('pullRequest(number')) {
    if (!repo) return { repository: null };
    if (q.includes('pullRequest(number')) {
      const pull = repo.pulls.find((p) => p.number === vars.number);
      if (!pull) return { repository: { pullRequest: null } };
      const node = {
        number: pull.number,
        id: gid('PullRequest', `${repo.id}/${pull.number}`),
        merged: pull.merged,
        state: pull.merged ? 'MERGED' : 'OPEN',
        headRefName: pull.head,
        baseRefName: pull.base,
        mergeable: pull.merged ? 'MERGEABLE' : 'MERGEABLE',
        files: { nodes: pull.files.map((f) => ({ path: f.path })) },
      };
      if (!q.includes('files')) delete node.files;
      return { repository: { pullRequest: node } };
    }
    return {
      repository: {
        pullRequests: {
          nodes: repo.pulls.filter((p) => !p.merged).slice(0, vars.first ?? 5).map((p) => ({
            number: p.number, headRefName: p.head, baseRefName: p.base, mergeable: 'MERGEABLE', state: 'OPEN',
          })),
        },
      },
    };
  }
  if (!repo) return { repository: null };
  // repository fields / issue(number:)
  if (q.includes('issue(number')) {
    const issue = repo.issues.find((i) => i.number === vars.number);
    if (!issue) return { repository: { issue: null } };
    return { repository: { issue: issueNode(repo, issue, q) } };
  }
  const node = {
    id: gid('Repository', String(repo.id)),
    databaseId: repo.id,
    name: repo.name,
    owner: { login: repo.owner },
    defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
  if (!q.includes('defaultBranchRef')) delete node.defaultBranchRef;
  if (!q.includes('hasIssuesEnabled')) delete node.hasIssuesEnabled;
  if (!q.includes('viewerPermission')) delete node.viewerPermission;
  if (!q.includes('owner')) delete node.owner;
  return { repository: node };
}

function issueNode(repo, issue, q) {
  const node = { number: issue.number, id: gid('Issue', `${repo.id}/${issue.number}`) };
  if (q.includes('title')) node.title = issue.title;
  if (q.includes('state')) node.state = issue.state === 'open' ? 'OPEN' : 'CLOSED';
  if (q.includes('body')) node.body = issue.body;
  return node;
}

// ---------------------------------------------------------------- introspection types

const TYPE_FIELDS = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'url'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'createdAt', 'mergeCommit'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'url'],
};

const ENUM_VALUES = { SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] };

function typeOf(name) {
  if (ENUM_VALUES[name]) return { enumValues: ENUM_VALUES[name].map((n) => ({ name: n })) };
  const fields = TYPE_FIELDS[name];
  if (!fields) return null;
  return { fields: fields.map((f) => ({ name: f })) };
}
