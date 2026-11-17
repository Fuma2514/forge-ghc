// gitobj.ts — the git object model and packfile codec, dependency-free.
// SHA-1 object hashing, commit/tree/tag/blob parsing and building, packfile read
// (v2/3, zlib, OFS_DELTA and REF_DELTA) and packfile write (plain objects, no deltas).
import { createHash } from 'node:crypto';
import { inflateSync, deflateSync, Inflate } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

export function hashObject(type, data) {
  const store = Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data]);
  return createHash('sha1').update(store).digest('hex');
}

export function hashPackEntry(type, data) {
  return hashObject(type, data);
}

// ---------------------------------------------------------------- parsing

/** Parse `commit` or `tag` headers + message. */
export function parseCommitLike(data) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headerText = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const headers = [];
  for (const line of headerText.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    headers.push([line.slice(0, sp), line.slice(sp + 1)]);
  }
  return { headers, message };
}

export function parseCommit(data) {
  const { headers, message } = parseCommitLike(data);
  let tree = null;
  const parents = [];
  let author = null;
  let committer = null;
  for (const [key, value] of headers) {
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data) {
  const { headers, message } = parseCommitLike(data);
  let object = null, type = null, tag = null, tagger = null;
  for (const [key, value] of headers) {
    if (key === 'object') object = value;
    else if (key === 'type') type = value;
    else if (key === 'tag') tag = value;
    else if (key === 'tagger') tagger = value;
  }
  return { object, type, tag, tagger, message };
}

/** Parse a tree object into entries. */
export function parseTree(data) {
  const entries = [];
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    const mode = data.toString('ascii', pos, sp);
    const nul = data.indexOf(0, sp + 1);
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Build a tree object from entries (mode, name, oid hex). */
export function buildTree(entries) {
  const chunks = [];
  for (const e of entries) {
    chunks.push(Buffer.from(`${e.mode} ${e.name}`));
    chunks.push(Buffer.from([0]));
    chunks.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

/** Build a commit object. */
export function buildCommit({ tree, parents = [], author, committer, message }) {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${author}`);
  lines.push(`committer ${committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${message}`);
}

/** Build an annotated tag object. */
export function buildTag({ object, type, tag, tagger, message }) {
  return Buffer.from(`object ${object}\ntype ${type}\ntag ${tag}\ntagger ${tagger}\n\n${message}`);
}

// ---------------------------------------------------------------- pack read

class ByteReader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  byte() { return this.buf[this.pos++]; }
  u32be() { const v = this.buf.readUInt32BE(this.pos); this.pos += 4; return v; }
  skip(n) { this.pos += n; }
  eof() { return this.pos >= this.buf.length; }
  /** Read a git varint used by OFS_DELTA offsets. */
  ofsVarint() {
    let c = this.byte();
    let ofs = c & 0x7f;
    while (c & 0x80) {
      ofs = ((ofs + 1) << 7) | (this.byte() & 0x7f);
      c = this.byte();
    }
    return ofs;
  }
}

function inflateAt(buf, pos) {
  // zlib.inflateSync tolerates trailing garbage, so inflate from pos directly.
  return inflateSync(buf.subarray(pos));
}

/** Apply a delta to a base buffer. */
export function applyDelta(base, delta) {
  let pos = 0;
  // source size
  let c = delta[pos++]; let size = c & 0x7f; let shift = 7;
  while (c & 0x80) { c = delta[pos++]; size |= (c & 0x7f) << shift; shift += 7; }
  // target size
  c = delta[pos++]; let outSize = c & 0x7f; shift = 7;
  while (c & 0x80) { c = delta[pos++]; outSize |= (c & 0x7f) << shift; shift += 7; }
  const out = Buffer.alloc(outSize);
  let outPos = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let cpOff = 0, cpSize = 0;
      if (op & 0x01) cpOff |= delta[pos++];
      if (op & 0x02) cpOff |= delta[pos++] << 8;
      if (op & 0x04) cpOff |= delta[pos++] << 16;
      if (op & 0x08) cpOff |= delta[pos++] << 24;
      if (op & 0x10) cpSize |= delta[pos++];
      if (op & 0x20) cpSize |= delta[pos++] << 8;
      if (op & 0x40) cpSize |= delta[pos++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, outPos, cpOff, cpOff + cpSize);
      outPos += cpSize;
    } else if (op > 0) {
      delta.copy(out, outPos, pos, pos + op);
      outPos += op;
      pos += op;
    } else {
      throw new Error('bad delta opcode 0');
    }
  }
  if (outPos !== outSize) throw new Error(`delta produced ${outPos} bytes, expected ${outSize}`);
  return out;
}

export interface ParsedPack {
  version: number;
  entries: Array<{ oid: string; type: string; data: Buffer }>;
  objects: Map<string, { type: string; data: Buffer }>;
  deltaCount: number;
}

/** Read a packfile (v2/3) into objects. resolveBase supplies thin-pack bases. */
export function readPack(pack, resolveBase) {
  const r = new ByteReader(pack);
  const magic = pack.toString('ascii', 0, 4);
  if (magic !== 'PACK') throw new Error('bad pack magic');
  r.skip(4);
  const version = r.u32be();
  if (version !== 2 && version !== 3) throw new Error(`bad pack version ${version}`);
  const count = r.u32be();
  const entries = [];
  const raw = []; // { type, data or delta info, ofs, oidLater }
  for (let i = 0; i < count; i++) {
    const start = r.pos;
    let c = r.byte();
    const typeNum = (c >> 4) & 7;
    let size = c & 15;
    let shift = 4;
    while (c & 0x80) {
      c = r.byte();
      size |= (c & 0x7f) << shift;
      shift += 7;
    }
    let type;
    let deltaInfo = null;
    if (typeNum === 1) type = 'commit';
    else if (typeNum === 2) type = 'tree';
    else if (typeNum === 3) type = 'blob';
    else if (typeNum === 4) type = 'tag';
    else if (typeNum === 6) { // OFS_DELTA
      const ofs = r.ofsVarint();
      deltaInfo = { kind: 'ofs', baseOffset: start - ofs };
      type = 'ofs-delta';
    } else if (typeNum === 7) { // REF_DELTA
      const baseOid = pack.toString('hex', r.pos, r.pos + 20);
      r.skip(20);
      deltaInfo = { kind: 'ref', baseOid };
      type = 'ref-delta';
    } else {
      throw new Error(`bad pack object type ${typeNum}`);
    }
    const dataStart = r.pos;
    const inflated = inflateAt(pack, dataStart);
    // Skip past the compressed entry: find how many bytes zlib consumed via inflating incrementally.
    // inflateSync consumes the whole zlib stream; find its end by re-deflating? Not reliable.
    // Instead, use zlib's inflate engine to know consumed bytes:
    const consumed = zlibConsumed(pack, dataStart);
    r.pos = dataStart + consumed;
    raw.push({ type, deltaInfo, data: inflated, start });
  }
  // Trailer: 20-byte sha1 of everything before it.
  // Resolve deltas iteratively.
  const objects = new Map();
  const byOffset = new Map();
  const typeNames = { commit: 1, tree: 2, blob: 3, tag: 4 };
  function resolve(entry, stack) {
    if (objects.has(entry.oidIfKnown)) return entry.resolved;
    return entry.resolved;
  }
  // First pass: store plain objects.
  const pending = [];
  for (const entry of raw) {
    if (entry.type === 'commit' || entry.type === 'tree' || entry.type === 'blob' || entry.type === 'tag') {
      const oid = hashObject(entry.type, entry.data);
      objects.set(oid, { type: entry.type, data: entry.data });
      byOffset.set(entry.start, oid);
      entries.push({ oid, type: entry.type, data: entry.data });
    } else {
      pending.push(entry);
    }
  }
  let guard = 0;
  let deltaCount = 0;
  while (pending.length && guard++ < count * 4) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const entry = pending[i];
      let baseOid = null;
      if (entry.deltaInfo.kind === 'ref') {
        baseOid = entry.deltaInfo.baseOid;
        if (!objects.has(baseOid) && resolveBase) {
          const ext = resolveBase(baseOid);
          if (ext) objects.set(baseOid, ext);
        }
        if (!objects.has(baseOid)) continue;
      } else {
        baseOid = byOffset.get(entry.deltaInfo.baseOffset);
        if (!baseOid) continue;
      }
      const base = objects.get(baseOid);
      const data = applyDelta(base.data, entry.data);
      const oid = hashObject(base.type, data);
      objects.set(oid, { type: base.type, data });
      byOffset.set(entry.start, oid);
      entries.push({ oid, type: base.type, data });
      pending.splice(i, 1);
      deltaCount++;
    }
  }
  if (pending.length) throw new Error(`${pending.length} delta object(s) unresolved`);
  return { version, entries, objects, deltaCount, declaredCount: count };
}

/** How many bytes of buf from pos the zlib stream occupies. */
function zlibConsumed(buf, pos) {
  // _processChunk runs the stream synchronously and engine.bytesWritten is the exact
  // number of input bytes the zlib stream consumed, so trailing pack bytes are skipped precisely.
  const engine = new Inflate();
  engine._processChunk(buf.subarray(pos), 1 /* Z_SYNC_FLUSH */);
  const consumed = engine.bytesWritten;
  if (!consumed) throw new Error('could not size the zlib stream');
  return consumed;
}

/** Write a packfile (version 2) of plain objects, no deltas. Returns {pack, oids}. */
export function writePack(objects) {
  // objects: [{type, data}]
  const chunks = [];
  chunks.push(Buffer.from('PACK'));
  const header = Buffer.alloc(8);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(objects.length, 4);
  chunks.push(header);
  const hash = createHash('sha1');
  hash.update(Buffer.concat(chunks.slice(0, 2)));
  for (const obj of objects) {
    const typeNum = obj.type === 'commit' ? 1 : obj.type === 'tree' ? 2 : obj.type === 'blob' ? 3 : 4;
    let size = obj.data.length;
    let first = (typeNum << 4) | (size & 15);
    size >>= 4;
    let head = [];
    while (size) {
      head.push(first | 0x80);
      first = size & 0x7f;
      size >>= 7;
    }
    head.push(first);
    const headBuf = Buffer.from(head);
    chunks.push(headBuf);
    hash.update(headBuf);
    const compressed = deflateSync(obj.data, { level: 6 });
    chunks.push(compressed);
    hash.update(compressed);
  }
  const trailer = hash.digest();
  chunks.push(trailer);
  return { pack: Buffer.concat(chunks), trailer: trailer.toString('hex') };
}

// ---------------------------------------------------------------- reachability

/** Walk parents/trees/tags from tips; returns Set of oids reachable. */
export function collectReachable(tips, lookup) {
  const seen = new Set();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop();
    if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) throw Object.assign(new Error(`missing object ${oid} reachable from the tips`), { code: 'missing-object' });
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree, ...c.parents);
    } else if (obj.type === 'tag') {
      const t = parseTag(obj.data);
      stack.push(t.object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    }
  }
  return seen;
}
