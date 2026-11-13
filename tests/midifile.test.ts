/**
 * src/ui/midifile.ts on small hand-built files: ticks become ms through tempo changes, running status
 * and note-on velocity 0 end notes, drums are dropped, and a chord sings its top note.
 */
import { describe, expect, test } from "bun:test";
import { parseMidi, midiBeat, melodyLine, underLine, inRange } from "../src/ui/midifile.ts";

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

  test("a lower note under a held tune note is left to the piano", () => {
    const notes = [
      { t: 0, dur: 1000, midi: 72, vel: 90 },
      { t: 10, dur: 400, midi: 48, vel: 70 },
      { t: 500, dur: 400, midi: 55, vel: 70 },
      { t: 1000, dur: 500, midi: 71, vel: 90 },
      { t: 1500, dur: 500, midi: 60, vel: 90 },
    ];
    const line = melodyLine(notes);
    expect(line.map((x) => x.midi)).toEqual([72, 71, 60]);
    expect(underLine(notes, line).map((x) => x.midi)).toEqual([48, 55]);
  });

  test("legato holds each note into the next, short of a long rest", () => {
    const line = melodyLine(
      [
        { t: 0, dur: 200, midi: 60, vel: 90 },
        { t: 500, dur: 200, midi: 62, vel: 90 },
        { t: 1000, dur: 200, midi: 62, vel: 90 },
        { t: 5000, dur: 200, midi: 64, vel: 90 },
      ],
      1200,
    );
    expect(line.map((x) => x.dur)).toEqual([540, 470, 200, 200]);
  });
});

test("a one-track file splits into a layer per channel, named by instrument", () => {
  const one = (t: number[][]) => {
    const head = chunk("MThd", [0, 0, 0, 1, 1, 224]);
    return new Uint8Array(head.concat(...t)).buffer;
  };
  const split = parseMidi(
    one([
      track([
        [0, 0xc0, 52],
        [0, 0xc1, 33],
        [0, 0x90, 67, 90],
        [0, 0x91, 40, 80],
        [0, 0x92, 60, 70],
        [0, 0x99, 36, 100],
        [480, 0x80, 67, 0],
        [0, 0x81, 40, 0],
        [0, 0x82, 60, 0],
        [0, 0x89, 36, 0],
      ]),
    ]),
  );
  expect(split.map((t) => [t.name, t.channel, t.notes.length])).toEqual([
    ["Ensemble", 0, 1],
    ["Bass", 1, 1],
    ["Channel 3", 2, 1],
  ]);
  const named = parseMidi(one([track([name("Song"), [0, 0xc0, 0], [0, 0x90, 60, 90], [0, 0x91, 48, 90], [480, 0x80, 60, 0], [0, 0x81, 48, 0]])]));
  expect(named.map((t) => t.name)).toEqual(["Song: Piano", "Song: Channel 2"]);
});

test("inRange folds by octaves", () => {
  expect(inRange(12)).toBe(24);
  expect(inRange(110)).toBe(98 - 12);
  expect(inRange(60)).toBe(60);
});

test("pickVocal takes a track named like a voice, else the busiest", async () => {
  const { pickVocal } = await import("../src/ui/midifile.ts");
  const n = (k: number) => Array.from({ length: k }, (_, i) => ({ t: i * 100, dur: 90, midi: 60, vel: 90 }));
  expect(pickVocal([{ name: "Strings", notes: n(9) }, { name: "Lead Vox", notes: n(3) }] as never)).toBe(1);
  expect(pickVocal([{ name: "Strings", notes: n(2) }, { name: "Piano", notes: n(5) }] as never)).toBe(1);
});

describe("midiBeat", () => {
  test("the first tempo gives the beat in ms, 500 when the file sets none", () => {
    expect(midiBeat(file([track([[0, 0xff, 0x51, 3, 0x09, 0x27, 0xc0], [0, 0x90, 60, 100], [480, 0x80, 60, 0]])]))).toBe(600);
    expect(midiBeat(file([track([[0, 0x90, 60, 100], [480, 0x80, 60, 0]])]))).toBe(500);
  });
});
