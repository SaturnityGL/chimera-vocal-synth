/**
 * src/ui/midifile.ts on small hand-built files: ticks become ms through tempo changes, running status
 * and note-on velocity 0 end notes, drums are dropped, and a chord sings its top note.
 */
import { describe, expect, test } from "bun:test";
import { parseMidi, melodyLine, inRange } from "../src/ui/midifile.ts";

function vlq(n: number): number[] {
  const out = [n & 0x7f];
  for (let v = n >> 7; v > 0; v >>= 7) out.unshift((v & 0x7f) | 0x80);
  return out;
}

function chunk(tag: string, body: number[]): number[] {
  const len = body.length;
  return [...tag].map((c) => c.charCodeAt(0)).concat([(len >> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255], body);
}

function track(events: [number, ...number[]][]): number[] {
  return chunk("MTrk", events.flatMap(([dt, ...bytes]) => [...vlq(dt), ...bytes]).concat([0, 0xff, 0x2f, 0]));
}

function file(tracks: number[][], ppq = 480): ArrayBuffer {
  const head = chunk("MThd", [0, 1, 0, tracks.length, (ppq >> 8) & 255, ppq & 255]);
  return new Uint8Array(head.concat(...tracks)).buffer;
}

const name = (s: string): [number, ...number[]] => [0, 0xff, 0x03, s.length, ...[...s].map((c) => c.charCodeAt(0))];

describe("parseMidi", () => {
  const buf = file([
    track([
      [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20],
      [960, 0xff, 0x51, 3, 0x0f, 0x42, 0x40],
    ]),
    track([
      name("Lead"),
      [0, 0x90, 60, 100],
      [0, 64, 90],
      [480, 0x80, 60, 0],
      [0, 0x90, 64, 0],
      [0, 67, 80],
      [480, 67, 0],
      [480, 72, 70],
      [480, 0x80, 72, 0],
    ]),
    track([
      [0, 0x99, 36, 100],
      [240, 0x89, 36, 0],
    ]),
  ]);
  const tracks = parseMidi(buf);

  test("drum-only tracks and the tempo track drop out", () => {
    expect(tracks.length).toBe(1);
    expect(tracks[0].name).toBe("Lead");
  });

  test("ticks follow the tempo map", () => {
    const n = tracks[0].notes;
    expect(n.map((x) => x.midi)).toEqual([60, 64, 67, 72]);
    expect(n.map((x) => x.t)).toEqual([0, 0, 500, 2000]);
    expect(n.map((x) => x.dur)).toEqual([500, 500, 500, 1000]);
  });

  test("a chord keeps its top note", () => {
    const line = melodyLine(tracks[0].notes);
    expect(line.map((x) => x.midi)).toEqual([64, 67, 72]);
  });

  test("not a MIDI file", () => {
    expect(() => parseMidi(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]).buffer)).toThrow();
  });
});

describe("melodyLine", () => {
  test("a note is cut off where the next begins", () => {
    const line = melodyLine([
      { t: 0, dur: 800, midi: 60, vel: 90 },
      { t: 500, dur: 300, midi: 62, vel: 90 },
    ]);
    expect(line.map((x) => x.dur)).toEqual([500, 300]);
  });
});

test("inRange folds by octaves", () => {
  expect(inRange(12)).toBe(24);
  expect(inRange(110)).toBe(98 - 12);
  expect(inRange(60)).toBe(60);
});
