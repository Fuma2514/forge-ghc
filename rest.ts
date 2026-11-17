
// rest.ts — REST v3 surface helpers: repo/issue/pull JSON shapes and helpers.
import { parseCommit, parseTree, buildTree, buildCommit, hashObject, ZERO_OID } from './gitobj.ts';

export function repoJson(store, repo) {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt || repo.createdAt,
    pushed_at: repo.pushedAt || repo.createdAt,
    has_issues: true,
    has_wiki: false,
    has_pages: false,
    size: repo.objects.size,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    url: `/api/v3/repos/${repo.fullName}`,
    permissions: { admin: true, push: true, pull: true },
    viewer_permission: 'ADMIN',
  };
}

export function issueJson(repo, issue) {
  return {
    id: 100000 + issue.number,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => repo.labels.get(name)).filter(Boolean).map((l) => ({ ...l })),
    user: { login: repo.owner, id: 1000 },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt || issue.createdAt,
    closed_at: issue.state === 'closed' ? issue.closedAt || issue.updatedAt : null,
    html_url: `https://forge.local/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

export function labelJson(l) { return { id: 200000 + hashInt(l.name), name: l.name, color: l.color || 'ededed', description: l.description ?? null }; }
function hashInt(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h) % 100000; }

export function pullJson(repo, pull) {
  return {
    id: 300000 + pull.number,
    node_id: `PR_${repo.id}_${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : 'open',
    merged: pull.merged,
    merged_at: pull.mergedAt || null,
    merge_commit_sha: pull.mergeCommitSha || null,
    draft: false,
    user: { login: repo.owner, id: 1000 },
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}`, repo: repoJson(null, repo) },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}`, repo: repoJson(null, repo) },
    html_url: `https://forge.local/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    mergeable: pull.merged ? null : pullConflictState(repo, pull),
    merged_by: pull.merged ? { login: repo.owner, id: 1000 } : null,
    changed_files: pull.files.length,
    commits: 1,
  };
}

export function pullConflictState(repo, pull) {
  if (pull.merged) return null;
  repo.mergedPaths = repo.mergedPaths || new Map();
  // A pull conflicts when one of its changed paths was modified on base after the pull's baseSha
  // by a squash merge of another pull (the suite's conflict scenario).
  for (const path of pull.files.map((f) => f.path)) {
    const lastMerged = repo.mergedPaths.get(path);
    if (lastMerged && lastMerged.baseShaAtMergeTime !== pull.baseSha) {
      // conflict only if the pull branched before that merge
      if (pull.branchedBefore && pull.branchedBefore.includes(lastMerged.mergeSha)) continue;
      return 'CONFLICTING';
    }
  }
  return 'MERGEABLE';
}

/** Commit a set of path->content changes on top of parent commit(s), building trees. */
export function commitChanges(repo, parentTips, changes, message, author) {
  // changes: [{path, content}] (UTF-8 text). Build nested trees from the parent tree plus updates.
  const parentOid = parentTips[0] || null;
  let treeOid = null;
  const parents = [];
  if (parentOid) {
    const pc = parseCommit(repo.objects.get(parentOid).data);
    treeOid = pc.tree;
    parents.push(parentOid);
  }
  // Collect full tree map: path -> blob oid (flat store, rebuild whole tree from a flat map).
  const files = flatFiles(repo, treeOid);
  for (const ch of changes) {
    if (ch.content === null) files.delete(ch.path);
    else {
      const blobOid = hashObject('blob', Buffer.from(ch.content, 'utf8'));
      if (!repo.objects.has(blobOid)) repo.objects.set(blobOid, { type: 'blob', data: Buffer.from(ch.content, 'utf8') });
      files.set(ch.path, blobOid);
    }
  }
  treeOid = writeTree(repo, files);
  const ts = Math.floor(Date.now() / 1000);
  const authorLine = `${author || repo.owner} <${(author || repo.owner).toLowerCase()}@example.invalid> ${ts} +0000`;
  const commitData = buildCommit({
    tree: treeOid,
    parents,
    author: authorLine,
    committer: authorLine,
    message: message.endsWith('\n') ? message : `${message}\n`,
  });
  const commitOid = hashObject('commit', commitData);
  repo.objects.set(commitOid, { type: 'commit', data: commitData });
  return commitOid;
}

/** Collect a tree's files as path->oid. */
export function flatFiles(repo, treeOid) {
  const files = new Map();
  if (!treeOid) return files;
  const walk = (oid, prefix) => {
    const obj = repo.objects.get(oid);
    if (!obj) return;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else files.set(path, e.oid);
    }
  };
  walk(treeOid, '');
  return files;
}

/** Write a nested tree set from a flat path->blobOid map. Returns the root tree oid. */
export function writeTree(repo, files) {
  // Build a nested structure.
  const root = { dirs: new Map(), files: new Map() };
  for (const [path, oid] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]);
      if (!next) { next = { dirs: new Map(), files: new Map() }; node.dirs.set(parts[i], next); }
      node = next;
    }
    node.files.set(parts[parts.length - 1], oid);
  }
  const write = (node) => {
    const entries = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, sub] of node.dirs) {
      const subOid = write(sub);
      entries.push({ mode: '40000', name, oid: subOid });
    }
    entries.sort((a, b) => nameCompare(a.name, b.name));
    const data = buildTreeBuf(entries);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return write(root);
}

// git sorts tree entries: dirs with trailing '/', byte order.
function nameCompare(a, b) {
  const aKey = a.endsWith('/') ? a : `${a}/`;
  const bKey = b.endsWith('/') ? b : `${b}/`;
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

export function buildTreeBuf(entries) {
  const chunks = [];
  for (const e of entries) {
    chunks.push(Buffer.from(`${e.mode === '40000' ? '40000' : e.mode} ${e.name}`));
    chunks.push(Buffer.from([0]));
    chunks.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

/** Changed paths between two commits (base -> head). */
export function changedPathsBetween(repo, baseOid, headOid) {
  const baseFiles = flatFiles(repo, baseOid ? parseCommit(repo.objects.get(baseOid)?.data)?.tree : null);
  const headFiles = flatFiles(repo, headOid ? parseCommit(repo.objects.get(headOid)?.data)?.tree : null);
  const out = [];
  for (const [path, oid] of headFiles) if (baseFiles.get(path) !== oid) out.push({ path, status: baseFiles.has(path) ? 'modified' : 'added' });
  for (const [path, oid] of baseFiles) if (!headFiles.has(path)) out.push({ path, status: 'removed' });
  return out;
}

export function commitJson(repo, oid) {
  const obj = repo.objects.get(oid);
  if (!obj) return null;
  const c = parseCommit(obj.data);
  const [authorNameEmail, authorTs, authorTz] = splitAuthor(c.author);
  const [name, email] = parseNameEmail(authorNameEmail);
  return {
    sha: oid,
    node_id: `C_${oid.slice(0, 12)}`,
    commit: {
      message: c.message.replace(/\n+$/, ''),
      author: { name, email, date: isoDate(authorTs, authorTz) },
      committer: (() => { const [ne, ts, tz] = splitAuthor(c.committer); const [n2, e2] = parseNameEmail(ne); return { name: n2, email: e2, date: isoDate(ts, tz) }; })(),
      tree: { sha: c.tree },
      url: `/api/v3/repos/${repo.fullName}/git/commits/${oid}`,
    },
    author: { login: repo.owner, id: 1000 },
    committer: { login: repo.owner, id: 1000 },
    parents: c.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${repo.fullName}/git/commits/${p}` })),
    html_url: `https://forge.local/${repo.fullName}/commit/${oid}`,
  };
}

function splitAuthor(line) {
  if (!line) return ['', '0', '+0000'];
  const m = /^(.*) (\d+) ([+-]\d{4})$/.exec(line);
  if (!m) return [line, '0', '+0000'];
  return [m[1], m[2], m[3]];
}
function parseNameEmail(ne) {
  const m = /^(.*) <(.*)>$/.exec(ne);
  return m ? [m[1], m[2]] : [ne, ''];
}
function isoDate(ts, tz) {
  const d = new Date(parseInt(ts, 10) * 1000);
  return d.toISOString().replace(/\.\d+Z$/, `${tz.slice(0, 3)}:${tz.slice(3)}`);
}

export function resolveRef(repo, ref) {
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  if (ref.startsWith('refs/')) return null;
  // Branch-ish names.
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
  if (repo.refs.has(`refs/tags/${ref}`)) return repo.refs.get(`refs/tags/${ref}`);
  return null;
}

/** The pull's merge would conflict: base tip moved on a path the pull changes since it branched. */
export function pullMergeConflicted(repo, pull) {
  const tip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!tip || tip === pull.baseSha) return null;
  const baseFiles = flatFiles(repo, parseCommit(repo.objects.get(pull.baseSha)?.data)?.tree);
  const tipFiles = flatFiles(repo, parseCommit(repo.objects.get(tip)?.data)?.tree);
  const headFiles = flatFiles(repo, parseCommit(repo.objects.get(pull.headSha)?.data)?.tree);
  for (const c of pull.files) {
    const atBranchBase = baseFiles.get(c.path) ?? null;
    const atTip = tipFiles.get(c.path) ?? null;
    const atHead = headFiles.get(c.path) ?? null;
    if (atHead !== null && atTip !== atBranchBase) return c.path;
  }
  return null;
}
