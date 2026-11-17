
// pkt.ts — pkt-line codec and sideband framing helpers.
export function encodePktLine(payload) {
  if (payload === null) return Buffer.from('0000'); // flush
  if (payload === 'DELIM') return Buffer.from('0001');
  if (payload === 'END') return Buffer.from('0003');
  const buf = typeof payload === 'string' ? Buffer.from(payload) : payload;
  const len = buf.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'));
  return Buffer.concat([head, buf]);
}

export function encodePktLines(items) {
  return Buffer.concat(items.map((i) => (i === 'FLUSH' ? Buffer.from('0000') : encodePktLine(i))));
}

/** Decode a pkt-line stream into packets. */
export function decodePktLines(buf) {
  const packets = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const hex = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      // Malformed: stop (server side, we are tolerant and discard).
      break;
    }
    const len = parseInt(hex, 16);
    if (len === 0) { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); pos += 4; continue; }
    if (len === 1) { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); pos += 4; continue; }
    if (len === 2) { packets.push({ kind: 'response-end', payload: Buffer.alloc(0) }); pos += 4; continue; }
    if (len === 3) { packets.push({ kind: 'event-end', payload: Buffer.alloc(0) }); pos += 4; continue; }
    if (len < 4 || pos + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return packets;
}

/** Wrap band-1 data in side-band-64k frames. */
export function sidebandEncode(data, band = 1) {
  const out = [];
  const MAX = 65515;
  for (let pos = 0; pos < data.length; pos += MAX) {
    out.push(encodePktLine(Buffer.concat([Buffer.from([band]), data.subarray(pos, pos + MAX)])));
  }
  return Buffer.concat(out);
}

export function sb(x) { return `${x}\n`; }
