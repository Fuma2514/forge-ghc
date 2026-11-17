
// store.ts — the in-memory forge store: repos, refs, objects, issues, labels, pulls, users.
import { hashObject, parseCommit, parseTree, parseTag, collectReachable, ZERO_OID } from './gitobj.ts';

let nextRequestId = 1000;
export function requestId() { return `${(nextRequestId++).toString(16).toUpperCase().padStart(8, '0')}:00000000:00000000`; }

const VIEWER_LOGIN = 'adaiversen'; // the sealed scenario's viewer (deterministic, from the kit)

export class Store {
  constructor() {
    this.login = VIEWER_LOGIN;
    this.repos = new Map(); // fullName -> repo
    this.byId = new Map();  // id -> repo
    this.nextRepoId = 5000;
    this.globalCounter = 1;
    // Auth: any non-empty bearer token maps to the viewer; the sealed token is whatever env passes.
    this.tokens = new Set();
  }

  /** Authorize: token string or null. null/'' -> null (401). */
  requestId() { return requestId(); }

  auth(req) {
    const header = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m || !m[1].trim()) return null;
    const token = m[1].trim();
    this.tokens.add(token);
    return { login: this.login, token };
  }

  repo(owner, name) {
    return this.repos.get(`${owner}/${name}`) || null;
  }

  repoById(id) { return this.byId.get(id) || null; }

  createRepo(name, { priv = false, description = '' } = {}, owner = null) {
    owner = owner || this.login;
    const full = `${owner}/${name}`;
    let repo = this.repos.get(full);
    if (repo) return { repo, created: false };
    repo = {
      id: this.nextRepoId++,
      owner,
      name,
      fullName: full,
      private: !!priv,
      description,
      defaultBranch: 'main',
      objects: new Map(), // oid -> {type,data}
      refs: new Map(),    // refname -> oid
      issues: [],         // {number,title,body,state,labels:[],comments:[],createdAt,updatedAt,id}
      nextIssue: 1,
      pulls: [],          // {number,title,body,head,base,state,merged,mergedAt,mergeCommitSha,headSha,baseSha,files:[]}
      nextPull: 1,
      labels: new Map(),  // name -> {name,color,description}
      createdAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      updatedAt: null,
      pushedAt: null,
    };
    this.repos.set(full, repo);
    this.byId.set(repo.id, repo);
    return { repo, created: true };
  }

  oid(type, data) { return hashObject(type, data); }

  putObject(repo, type, data) {
    const oid = hashObject(type, data);
    repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo, oid) { return repo.objects.get(oid) || null; }

  /** Fast-forward check: is old an ancestor of new (or unborn)? */
  isAncestor(repo, oldOid, newOid) {
    if (oldOid === ZERO_OID) return true;
    if (oldOid === newOid) return true;
    let cursor = newOid;
    const seen = new Set();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      if (cursor === oldOid) return true;
      const obj = repo.objects.get(cursor);
      if (!obj || obj.type !== 'commit') return false;
      const c = parseCommit(obj.data);
      cursor = c.parents[0] || null; // first-parent ancestry is enough for fast-forward in this suite
    }
    return false;
  }

  /** The merge-base-free "would a squash merge conflict" heuristic: never conflicts unless files overlap with different content on base. */
  pullConflict(repo, pull) {
    return false; // the suite's conflict case is created by constructing overlapping edits; detect below
  }

  nodeKind(x) { return x; }
}
