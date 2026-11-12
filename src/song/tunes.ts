/**
 * The Song page's tunes: original melodies (written for this app) that anyone's words are fitted
 * to (fit.ts). Each phrase is one line of lyrics; a song longer than the tune goes round again.
 * Notes are [midi, beats], at the female voice's pitch; `octave` shifts the other bodies, as the
 * demo songs do. Phrases end on a long note: the breath before the next line comes out of it.
 */
export interface Tune {
  id: string;
  name: string;
  bpm: number;
  octave: { male: number; female: number; child: number };
  phrases: [number, number][][];
}

export const TUNES: readonly Tune[] = [
  {
    id: "sunrise",
    name: "Sunrise",
    bpm: 104,
    octave: { male: -1, female: 0, child: 0 },
    phrases: [
      [[64, 1], [64, 1], [67, 1], [69, 1], [67, 1.5], [64, 0.5], [62, 2]],
      [[60, 1], [62, 1], [64, 1], [67, 1], [64, 1.5], [62, 0.5], [60, 2]],
      [[69, 1], [69, 1], [72, 1], [69, 1], [67, 1.5], [64, 0.5], [67, 2]],
      [[65, 1], [64, 1], [62, 1], [64, 1], [62, 1], [59, 1], [60, 2]],
    ],
  },
  {
    id: "night-drive",
    name: "Night drive",
    bpm: 88,
    octave: { male: -1, female: 0, child: 0 },
    phrases: [
      [[57, 1], [60, 1], [64, 1.5], [62, 0.5], [60, 1], [59, 1], [57, 2]],
      [[57, 1], [60, 1], [64, 1], [67, 1], [65, 1.5], [64, 0.5], [64, 2]],
      [[65, 1], [64, 1], [62, 1], [60, 1], [62, 1.5], [60, 0.5], [59, 2]],
      [[57, 1], [59, 1], [60, 1], [62, 1], [64, 1], [59, 1], [57, 2]],
    ],
  },
  {
    id: "bounce",
    name: "Bounce",
    bpm: 120,
    octave: { male: -1, female: 0, child: 0 },
    phrases: [
      [[67, 0.5], [67, 0.5], [64, 0.5], [67, 0.5], [69, 1], [67, 1], [64, 0.5], [62, 0.5], [60, 1], [62, 2]],
      [[60, 0.5], [60, 0.5], [62, 0.5], [64, 0.5], [67, 1], [64, 1], [62, 0.5], [60, 0.5], [62, 1], [64, 2]],
      [[67, 0.5], [67, 0.5], [69, 0.5], [71, 0.5], [72, 1], [71, 1], [69, 0.5], [67, 0.5], [64, 1], [67, 2]],
      [[69, 0.5], [67, 0.5], [64, 0.5], [62, 0.5], [60, 1], [62, 1], [64, 0.5], [62, 0.5], [60, 1], [60, 2]],
    ],
  },
  {
    id: "lullaby",
    name: "Lullaby",
    bpm: 96,
    octave: { male: -1, female: 0, child: 0 },
    phrases: [
      [[65, 2], [69, 1], [72, 2], [69, 1], [67, 2], [65, 1], [67, 3]],
      [[65, 2], [69, 1], [72, 2], [74, 1], [72, 2], [69, 1], [67, 3]],
      [[70, 2], [69, 1], [67, 2], [65, 1], [64, 2], [65, 1], [67, 3]],
      [[65, 2], [69, 1], [67, 2], [64, 1], [62, 2], [64, 1], [65, 3]],
    ],
  },
];
