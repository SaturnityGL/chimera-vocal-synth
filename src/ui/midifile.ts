/**
 * Standard MIDI files (.mid) read into notes with times in ms, and a track's notes cut down to one
 * line the voice can sing: chords keep their top note, and a note ends where the next one starts.
 */

export interface MidiNote {
  t: number;
  dur: number;
  midi: number;
  vel: number;
}

export interface MidiTrack {
  name: string;
  channel: number;
  notes: MidiNote[];
}

interface RawNote {
  on: number;
  off: number;
  midi: number;
  vel: number;
  channel: number;
}

interface RawTrack {
  name: string;
  notes: RawNote[];
}

const DRUMS = 9;

export function parseMidi(buf: ArrayBuffer): MidiTrack[] {
  const d = new DataView(buf);
  const tag = (at: number) => String.fromCharCode(d.getUint8(at), d.getUint8(at + 1), d.getUint8(at + 2), d.getUint8(at + 3));
  if (d.byteLength < 14 || tag(0) !== "MThd") throw new Error("Not a MIDI file");
  const headLen = d.getUint32(4);
  const count = d.getUint16(10);
  const division = d.getUint16(12);
  const tempos: { tick: number; usPerQ: number }[] = [];
  const raw: RawTrack[] = [];
  let at = 8 + headLen;
  for (let n = 0; n < count && at + 8 <= d.byteLength; n++) {
    const len = d.getUint32(at + 4);
    const start = at + 8;
    const end = Math.min(d.byteLength, start + len);
    if (tag(at) === "MTrk") raw.push(readTrack(d, start, end, tempos));
    at = start + len;
  }
  const ms = clock(division, tempos);
  return raw
    .map((r) => {
      const notes = r.notes.map((x) => ({ t: ms(x.on), dur: Math.max(1, ms(x.off) - ms(x.on)), midi: x.midi, vel: x.vel, channel: x.channel }));
      const channels = new Map<number, number>();
      for (const x of notes) channels.set(x.channel, (channels.get(x.channel) ?? 0) + 1);
      const channel = [...channels.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
      return { name: r.name, channel, notes: notes.filter((x) => x.channel !== DRUMS).map(({ t, dur, midi, vel }) => ({ t, dur, midi, vel })) };
    })
    .filter((t) => t.notes.length > 0);
}

function readTrack(d: DataView, start: number, end: number, tempos: { tick: number; usPerQ: number }[]): RawTrack {
  let p = start;
  let tick = 0;
  let status = 0;
  let name = "";
  const notes: RawNote[] = [];
  const open = new Map<number, RawNote[]>();
  const vlq = () => {
    let v = 0;
    for (let k = 0; k < 4 && p < end; k++) {
      const b = d.getUint8(p++);
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const close = (channel: number, midi: number) => {
    const held = open.get(channel * 128 + midi);
    const x = held?.shift();
    if (x) x.off = tick;
  };
  while (p < end) {
    tick += vlq();
    if (p >= end) break;
    let b = d.getUint8(p);
    if (b & 0x80) {
      p++;
      if (b < 0xf0) status = b;
    } else b = status;
    if (b === 0xff) {
      const type = d.getUint8(p++);
      const len = vlq();
      if (type === 0x03 && !name) name = new TextDecoder().decode(new Uint8Array(d.buffer, d.byteOffset + p, Math.min(len, end - p))).trim();
      if (type === 0x51 && len >= 3) tempos.push({ tick, usPerQ: (d.getUint8(p) << 16) | (d.getUint8(p + 1) << 8) | d.getUint8(p + 2) });
      if (type === 0x2f) break;
      p += len;
      continue;
    }
    if (b === 0xf0 || b === 0xf7) {
      p += vlq();
      continue;
    }
    const kind = b & 0xf0;
    const channel = b & 0x0f;
    const a1 = d.getUint8(p++);
    const a2 = kind === 0xc0 || kind === 0xd0 ? 0 : d.getUint8(p++);
    if (kind === 0x90 && a2 > 0) {
      const x = { on: tick, off: -1, midi: a1, vel: a2, channel };
      notes.push(x);
      const key = channel * 128 + a1;
      open.set(key, [...(open.get(key) ?? []), x]);
    } else if (kind === 0x80 || kind === 0x90) close(channel, a1);
  }
  for (const x of notes) if (x.off < 0) x.off = tick;
  return { name, notes };
}

function clock(division: number, tempos: { tick: number; usPerQ: number }[]): (tick: number) => number {
  if (division & 0x8000) {
    const fps = 256 - (division >> 8);
    const perFrame = division & 0xff;
    return (tick) => (tick * 1000) / (fps * perFrame);
  }
  const ppq = division || 480;
  const map = tempos.slice().sort((a, b) => a.tick - b.tick);
  const segs: { tick: number; ms: number; usPerQ: number }[] = [{ tick: 0, ms: 0, usPerQ: 500000 }];
  for (const t of map) {
    const last = segs[segs.length - 1];
    const ms = last.ms + ((t.tick - last.tick) * last.usPerQ) / ppq / 1000;
    if (t.tick === last.tick) last.usPerQ = t.usPerQ;
    else segs.push({ tick: t.tick, ms, usPerQ: t.usPerQ });
  }
  return (tick) => {
    let s = segs[0];
    for (const x of segs) {
      if (x.tick > tick) break;
      s = x;
    }
    return Math.round(s.ms + ((tick - s.tick) * s.usPerQ) / ppq / 1000);
  };
}

/** A track's notes as one sung line: the top note of each chord, each cut off where the next begins. */
export function melodyLine(notes: MidiNote[]): MidiNote[] {
  const byStart = new Map<number, MidiNote>();
  for (const n of notes) {
    const top = byStart.get(n.t);
    if (!top || n.midi > top.midi) byStart.set(n.t, n);
  }
  const line = [...byStart.values()].sort((a, b) => a.t - b.t);
  return line.map((n, k) => {
    const next = line[k + 1];
    const dur = next ? Math.min(n.dur, next.t - n.t) : n.dur;
    return { ...n, dur: Math.max(1, dur) };
  });
}

/** The track most likely to be the sung one: named like a voice or melody, else the one with the most notes. */
export function pickVocal(tracks: MidiTrack[]): number {
  const named = tracks.findIndex((t) => /vocal|voice|vox|sing|melody|lead|soprano/i.test(t.name));
  if (named >= 0) return named;
  let best = 0;
  tracks.forEach((t, k) => {
    if (t.notes.length > tracks[best].notes.length) best = k;
  });
  return best;
}

/** Fold a note into the voice's range by octaves. */
export function inRange(midi: number, lo = 24, hi = 96): number {
  let m = midi;
  while (m < lo) m += 12;
  while (m > hi) m -= 12;
  return m;
}
