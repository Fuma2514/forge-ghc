
// gitsvc.ts — git smart HTTP: info/refs advertisements, upload-pack v2/v0, receive-pack v0.
import { Store } from './store.ts';
import { encodePktLine, encodePktLines, decodePktLines, sidebandEncode } from './pkt.ts';
import { readPack, writePack, hashObject, parseCommit, parseTree, collectReachable, ZERO_OID, applyDelta } from './gitobj.ts';

const SERVICE_UPLOAD = 'git-upload-pack';
const SERVICE_RECEIVE = 'git-receive-pack';

function advert(repo) {
  // v0 advertisement lines: "<oid> <ref>\0caps" first, then refs, peeled tags, flush.
  const lines = [];
  const caps = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';
  const refs = [...repo.refs.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
  // HEAD symref
  const headSym = `HEAD:refs/heads/${repo.defaultBranch}`;
  const all = refs.filter(([name]) => name.startsWith('refs/heads/') || name.startsWith('refs/tags/'));
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const firstLine = all.length
    ? `${all[0][1]} ${all[0][0]}\0${caps} symref=HEAD:${headSym}`
    : `${ZERO_OID} capabilities^{}\0${caps} symref=HEAD:${headSym}`;
  lines.push(firstLine);
  for (let i = all.length ? 1 : 0; i < all.length; i++) lines.push(`${all[i][1]} ${all[i][0]}`);
  // peeled tags
  const peeled = [];
  for (const [name, oid] of all) {
    if (!name.startsWith('refs/tags/')) continue;
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (m) peeled.push(`${m[1]} ${name}^{}`);
    }
  }
  for (const p of peeled) lines.push(p);
  return encodePktLines(lines.map((l) => `${l}\n`)).toString() === '' ? '' : encodePktLines(lines.map((l) => `${l}\n`));
}

export function infoRefs(store, req, res, owner, name, service, v2Requested) {
  const repo = store.repo(owner, name);
  if (!repo) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: 'Not Found' })); return; }
  const contentType = `application/x-${service}-advertisement`;
  res.writeHead(200, { 'content-type': contentType });
  const body = Buffer.concat([
    Buffer.from(encodePktLine(Buffer.from(`# service=${service}\n`))),
    Buffer.from('0000'),
  ]);
  if (service === SERVICE_UPLOAD && v2Requested) {
    const caps = [
      encodePktLine(Buffer.from('version 2\n')),
      encodePktLine(Buffer.from('agent=forge/1.0\n')),
      encodePktLine(Buffer.from('ls-refs=unborn\n')),
      encodePktLine(Buffer.from('fetch=shallow\n')),
      encodePktLine(Buffer.from('object-format=sha1\n')),
      Buffer.from('0000'),
    ];
    res.end(Buffer.concat([body, ...caps]));
    return;
  }
  // v0 advertisement
  const repoLines = [];
  const refs = [...repo.refs.entries()].filter(([n]) => n.startsWith('refs/')).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const caps = service === SERVICE_RECEIVE
    ? 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge/1.0'
    : 'multi_ack_detailed multi_ack side-band-64k thin-pack ofs-delta agent=forge/1.0';
  if (refs.length === 0) {
    repoLines.push(`${ZERO_OID} capabilities^{}\0${caps} symref=HEAD:refs/heads/${repo.defaultBranch}`);
  } else {
    const headSym = service === SERVICE_UPLOAD ? ` symref=HEAD:refs/heads/${repo.defaultBranch}` : '';
    repoLines.push(`${refs[0][1]} ${refs[0][0]}\0${caps}${headSym}`);
    for (let i = 1; i < refs.length; i++) repoLines.push(`${refs[i][1]} ${refs[i][0]}`);
    for (const [n, oid] of refs) {
      if (!n.startsWith('refs/tags/')) continue;
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
        if (m) repoLines.push(`${m[1]} ${n}^{}`);
      }
    }
  }
  res.end(Buffer.concat([body, encodePktLines(repoLines.map((l) => `${l}\n`)), Buffer.from('0000')]));
}

// ---------------------------------------------------------------- upload-pack POST

function parseFetchRequestV2(packets) {
  const state = { command: null, wants: [], haves: [], shallow: [], depth: null, done: false, filter: null };
  let section = 'commands';
  for (const p of packets) {
    if (p.kind === 'delim') { section = 'args'; continue; }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (section === 'commands') {
      if (line.startsWith('command=')) state.command = line.slice(8);
      continue;
    }
    if (line === '') continue;
    if (line.startsWith('want ')) state.wants.push(line.slice(5));
    else if (line.startsWith('have ')) state.haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) state.shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) state.depth = parseInt(line.slice(7), 10);
    else if (line === 'done') state.done = true;
    else if (line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta' || line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    else if (line.startsWith('filter ')) state.filter = line.slice(7);
  }
  return state;
}

const packCache = new Map();

function repoEpoch(repo) {
  // any push or commit bumps repo.epoch; refs included so a moved ref invalidates too
  let refSum = 0;
  for (const [n, o] of repo.refs) { for (let i = 0; i < n.length; i++) refSum = (refSum * 31 + n.charCodeAt(i)) | 0; refSum = (refSum * 31 + o.length) | 0; }
  return `${repo.epoch || 0}:${repo.refs.size}:${refSum}`;
}

function buildPackFor(repo, wantOids, haveOids, depth, shallowList = []) {
  const key = `${repo.fullName}|${repoEpoch(repo)}|${depth}|${[...wantOids].sort().join(',')}|${[...haveOids].sort().join(',')}|${[...(shallowList || [])].sort().join(',')}`;
  const hit = packCache.get(key);
  if (hit) return hit;
  // Collect objects reachable from wants minus those reachable from haves.
  const wantSet = new Set(wantOids);
  const missing = wantOids.filter((o) => !repo.objects.has(o));
  if (missing.length) return { pack: null, missing };
  const haveClosure = new Set();
  const shallowSet = new Set(shallowList || []);
  for (const have of haveOids) {
    if (!repo.objects.has(have)) continue;
    // walk ancestors, stopping at the client's declared shallow boundary
    const stack = [have]; const seenH = new Set();
    const walkHave = (oid) => {
      if (!oid || seenH.has(oid) || shallowSet.has(oid)) return;
      seenH.add(oid);
      haveClosure.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj) return;
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        walkHave(c.tree);
        for (const p of c.parents) walkHave(p);
      } else if (obj.type === 'tag') {
        const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
        if (m) walkHave(m[1]);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) walkHave(e.oid);
      }
    };
    walkHave(have);
  }
  const send = [];
  const seen = new Set();
  const walk = (oid, generation) => {
    if (!oid || seen.has(oid) || haveClosure.has(oid)) return;
    if (depth !== null && generation > depth) return;
    const obj = repo.objects.get(oid);
    if (!obj) return;
    seen.add(oid);
    send.push({ oid, type: obj.type, data: obj.data });
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (depth !== null && generation === depth) return; // shallow cut: don't walk parents/trees? Trees must go; parents stop.
      walk(c.tree, generation + 1);
      for (const p of c.parents) walk(p, generation + 1);
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (m) walk(m[1], generation);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) walk(e.oid, generation + 1);
    }
  };
  for (const want of wantOids) walk(want, 1);
  // Shallow: trees and blobs of tip commits must be complete even when cutting parents.
  if (depth !== null) {
    const deep = [];
    const seen2 = new Set();
    const walk2 = (oid, generation) => {
      if (!oid || seen2.has(oid) || generation > depth) return;
      seen2.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj) return;
      if (obj.type === 'commit') {
        if (generation === depth) { deep.push(oid); return; }
        const c = parseCommit(obj.data);
        for (const p of c.parents) walk2(p, generation + 1);
      }
    };
    for (const want of wantOids) walk2(want, 1);
    // for shallow boundary commits, send their tree+blobs
    for (const tip of deep) {
      const obj = repo.objects.get(tip);
      if (!obj) continue;
      const c = parseCommit(obj.data);
      const treeOid = c.tree;
      const stack = [treeOid];
      const seen3 = new Set();
      while (stack.length) {
        const o = stack.pop();
        if (!o || seen3.has(o) || haveClosure.has(o)) continue;
        seen3.add(o);
        const t = repo.objects.get(o);
        if (!t) continue;
        send.push({ oid: o, type: t.type, data: t.data });
        if (t.type === 'tree') for (const e of parseTree(t.data)) stack.push(e.oid);
      }
    }
  }
  // Deduplicate by oid, reusing the oid when we already know it.
  const byOid = new Map();
  for (const s of send) {
    const oid = s.oid || hashObject(s.type, s.data);
    if (!byOid.has(oid)) byOid.set(oid, s);
  }
  const uniq = [...byOid.values()];
  const result = uniq.length ? { pack: writePack(uniq).pack, missing: [] } : { pack: Buffer.alloc(0), missing: [] };
  if (packCache.size > 24) packCache.clear();
  packCache.set(key, result);
  return result;
}

export async function uploadPack(store, req, res, owner, name, body) {
  const repo = store.repo(owner, name);
  if (!repo) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: 'Not Found' })); return; }
  const packets = decodePktLines(body);
  const firstData = packets.find((p) => p.kind === 'data');
  const firstText = firstData ? firstData.payload.toString('utf8') : '';
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  if (firstText === 'command=ls-refs\n' || firstText.startsWith('command=ls-refs')) {
    // ls-refs: options until delim, then ref-prefix lines.
    const args = { prefixes: [], symrefs: false, peel: false, unborn: false, head: false };
    let afterDelim = false;
    for (const p of packets) {
      if (p.kind === 'delim') { afterDelim = true; continue; }
      if (p.kind !== 'data') continue;
      const line = p.payload.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('ref-prefix ')) { args.prefixes.push(line.slice(11)); continue; }
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line === 'head') args.head = true;
    }
    const out = [];
    const all = [...repo.refs.entries()].filter(([n]) => n.startsWith('refs/')).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const filtered = args.prefixes.length ? all.filter(([n]) => args.prefixes.some((pre) => n.startsWith(pre))) : all;
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const headMatches = !args.prefixes.length || args.prefixes.some((p) => 'HEAD'.startsWith(p) || p === 'HEAD');
    if (headOid !== undefined && headMatches && !args.prefixes.some((p) => p.startsWith('refs/')) ) {
      // HEAD included when prefix allows (prefix '' or 'HEAD')
    }
    if (headOid !== undefined && (!args.prefixes.length || args.prefixes.some((p) => p === 'HEAD'))) {
      out.push(`${headOid} HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}`);
    } else if (headOid === undefined && args.unborn && (!args.prefixes.length || args.prefixes.some((p) => p === 'HEAD'))) {
      out.push(`unborn HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}`);
    }
    for (const [n, oid] of filtered) {
      let line = `${oid} ${n}`;
      if (args.symrefs && n === 'HEAD') line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      if (args.peel && n.startsWith('refs/tags/')) {
        const obj = repo.objects.get(oid);
        if (obj && obj.type === 'tag') {
          const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
          if (m) line += ` peeled:${m[1]}`;
        }
      }
      out.push(line);
    }
    const chunks = out.map((l) => encodePktLine(Buffer.from(`${l}\n`)));
    chunks.push(Buffer.from('0000'));
    res.end(Buffer.concat(chunks));
    return;
  }
  if (firstText.startsWith('command=fetch')) {
    const f = parseFetchRequestV2(packets);
    const { pack } = buildPackFor(repo, f.wants, f.haves, f.depth, f.shallow);
    const chunks = [];
    // acknowledgments section
    const ackLines = [];
    if (f.done) {
      // with done, answer NAK (full pack follows) or nothing if no wants
      ackLines.push('NAK\n');
    }
    const secA = [encodePktLine(Buffer.from('acknowledgments\n')), ...ackLines.map((l) => encodePktLine(Buffer.from(l))), Buffer.from('0000')];
    chunks.push(...secA);
    // shallow-info when depth/shallow requested
    if (f.depth !== null || f.shallow.length) {
      const si = [];
      // shallow boundaries: the wants are cut at depth; report each want as shallow if its ancestry exceeds depth
      for (const want of f.wants) {
        // compute whether any ancestor beyond depth exists
        if (f.depth !== null) {
          let gen = 1; let cursor = want; let beyond = false; const seen = new Set();
          while (cursor) {
            const obj = repo.objects.get(cursor);
            if (!obj || obj.type !== 'commit') break;
            const c = parseCommit(obj.data);
            if (gen >= f.depth && c.parents.length) { beyond = true; break; }
            cursor = c.parents[0]; gen++;
            if (seen.has(cursor)) break; seen.add(cursor);
          }
          if (beyond) si.push(`shallow ${want}`);
          if (f.shallow.includes(want)) si.push(`unshallow ${want}`); // approx
        }
      }
      const sec = [encodePktLine(Buffer.from('shallow-info\n')), ...si.map((l) => encodePktLine(Buffer.from(`${l}\n`))), Buffer.from('0000')];
      chunks.push(...sec);
    }
    chunks.push(encodePktLine(Buffer.from('packfile\n')));
    if (pack && pack.length) {
      chunks.push(sidebandEncode(pack, 1));
    }
    chunks.push(Buffer.from('0000'));
    res.end(Buffer.concat(chunks));
    return;
  }
  // Unknown v2 command or v0 fetch negotiation body (want lines).
  if (firstText.startsWith('want ') || firstText.startsWith('git-upload-pack')) {
    const lines = [];
    const wants = [];
    let depth = null;
    let haves = [];
    for (const p of packets) {
      if (p.kind !== 'data') continue;
      const line = p.payload.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const sp = rest.indexOf(' ');
        wants.push(sp < 0 ? rest : rest.slice(0, sp));
        const capsPart = sp < 0 ? '' : rest.slice(sp + 1);
        const dm = /(?:^| )deepen(?:=| )(\d+)/.exec(capsPart);
        if (dm) depth = parseInt(dm[1], 10);
      } else if (line.startsWith('have ')) haves.push(line.slice(5));
      else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7), 10);
      else if (line.startsWith('shallow ')) {}
    }
    const { pack } = buildPackFor(repo, wants, haves, depth);
    // v0 answer: NAK + sideband pack
    const chunks = [encodePktLine(Buffer.from('NAK\n'))];
    if (pack && pack.length) chunks.push(sidebandEncode(pack, 1));
    chunks.push(Buffer.from('0000'));
    res.end(Buffer.concat(chunks));
    return;
  }
  // Unknown command: flush-only answer.
  res.end(Buffer.from('0000'));
}

// ---------------------------------------------------------------- receive-pack POST

export async function receivePack(store, req, res, owner, name, body) {
  const repo = store.repo(owner, name);
  if (!repo) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: 'Not Found' })); return; }
  const packets = decodePktLines(body);
  const commands = [];
  let flushSeen = false;
  let packStart = -1;
  // Reconstruct raw buffer offsets: simpler to re-scan body for pack start after first flush.
  for (const p of packets) {
    if (p.kind === 'flush') { flushSeen = true; break; }
    if (p.kind === 'data') {
      const text = p.payload.toString('utf8');
      const nul = text.indexOf('\0');
      const line = nul >= 0 ? text.slice(0, nul) : text.replace(/\n$/, '');
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\s]+)$/.exec(line.trim());
      if (m) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
    }
  }
  // Pack bytes: everything after the first flush pkt (0000).
  let pack = null;
  if (flushSeen) {
    const idx = body.indexOf(Buffer.from('0000'));
    // first flush is at offset 0 only if no commands... commands come first, so find flush after commands.
    // Walk pkt lengths to find the flush position:
    let pos = 0; let flushed = false;
    while (pos + 4 <= body.length) {
      const len = parseInt(body.toString('ascii', pos, pos + 4), 16);
      if (len === 0) { pos += 4; flushed = true; break; }
      if (len < 4) break;
      pos += len;
    }
    if (flushed && pos < body.length) pack = body.subarray(pos);
  }
  const results = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const newObjects = new Map();
  if (pack && pack.length) {
    try {
      const parsed = readPack(pack, (oid) => {
        const have = repo.objects.get(oid);
        return have ? { type: have.type, data: have.data } : null;
      });
      for (const [oid, obj] of parsed.objects) newObjects.set(oid, obj);
    } catch (err) {
      unpackOk = false;
      unpackDetail = `unpack error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (unpackOk) {
    for (const cmd of commands) {
      if (cmd.newOid === ZERO_OID) {
        // delete
        if (!repo.refs.has(cmd.ref)) { results.push([cmd.ref, 'missing ref']); continue; }
        const cur = repo.refs.get(cmd.ref);
        if (cmd.oldOid !== ZERO_OID && cur !== cmd.oldOid) { results.push([cmd.ref, 'unexpected old value']); continue; }
        repo.refs.delete(cmd.ref);
        results.push([cmd.ref, 'ok']);
      } else {
        if (!newObjects.has(cmd.newOid) && !repo.objects.has(cmd.newOid)) {
          results.push([cmd.ref, 'missing objects']);
          continue;
        }
        const cur = repo.refs.get(cmd.ref) || ZERO_OID;
        if (cur !== ZERO_OID && cur !== cmd.oldOid) { results.push([cmd.ref, 'unexpected old value']); continue; }
        const mergedObjects = new Map(repo.objects);
        for (const [oid, obj] of newObjects) mergedObjects.set(oid, obj);
        const ancestorRepo = { objects: mergedObjects };
        if (cur !== ZERO_OID && !store.isAncestor(ancestorRepo, cur, cmd.newOid)) {
          results.push([cmd.ref, 'non-fast-forward']);
          continue;
        }
        // Install objects.
        for (const [oid, obj] of newObjects) repo.objects.set(oid, obj);
        repo.epoch = (repo.epoch || 0) + 1;
        repo.refs.set(cmd.ref, cmd.newOid);
        repo.pushedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
        results.push([cmd.ref, 'ok']);
      }
    }
  } else {
    for (const cmd of commands) results.push([cmd.ref, unpackDetail]);
  }
  // report-status in sideband
  const report = [];
  report.push(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`);
  for (const [ref, status] of results) report.push(status === 'ok' ? `ok ${ref}\n` : `ng ${ref} ${status}\n`);
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
  const reportBuf = Buffer.concat(report.map((l) => encodePktLine(Buffer.from(l))));
  res.end(Buffer.concat([sidebandEncode(reportBuf, 1), Buffer.from('0000')]));
}
