import { useEffect, useRef, useState, type PointerEvent } from "react";
import { usePhosphor } from "../usePhosphor.ts";
import { useStore } from "../store.ts";
import {
  useSing,
  takeBlocks,
  moveTakeNote,
  retimeTakeNote,
  auditionTake,
  takePlayhead,
  backingNotes,
  addTakeNote,
  removeTakeNote,
  setTakeBpm,
  takeGrid,
  snap,
  GRIDS,
  DEFAULT_BPM,
  DRAWN,
  type Take,
  type TakeBlock,
} from "../singing.ts";
import { Menu } from "./Controls.tsx";
import { TEXT, V } from "../colors.ts";
import { beam, label, seg } from "../render/vector.ts";

const SPAN = 25;
const LEFT = 34;
const MAP = 13;
const TOP = 30;
const BLACK = [1, 3, 6, 8, 10];
const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const ZOOM_MIN = 0.03;
const ZOOM_MAX = 0.6;
const EDGE = 6;

type NoteDrag = { kind: "note"; block: TakeBlock; end: boolean; x0: number; y0: number; midi: number; t0: number; t1: number; ctrl: boolean; ripple: boolean; moved: boolean };
type DrawDrag = { kind: "draw"; x0: number; t0: number; t1: number; min: number; midi: number; moved: boolean };
type Drag = NoteDrag | DrawDrag | { kind: "pan"; x0: number; y0: number; t: number; bottom: number; moved: boolean } | { kind: "seek" } | { kind: "cue" };

/**
 * The take as a piano roll on its own timeline, each note singing the next syllable in time order:
 * drag on empty grid to draw a note (it starts on the grid line under the pointer and stretches as
 * you drag), right-click a note to delete it, drag a block up or down to change its pitch (it sings
 * at the new pitch on release) and sideways to move it in time, drag its right end to change its
 * length, hold Ctrl while dragging to move everything after it too. Notes land on the grid (Grid
 * picks the step, BPM its beat) unless Alt is held. Wheel through time, Shift+wheel through pitch,
 * Ctrl+wheel to zoom, middle-drag or Shift+drag to pan. The playhead follows the take while Sing plays it. The strip
 * along the top is the whole take: click or drag it to jump there. Click the time ruler under it to
 * set where Sing starts (double-click: from the top again); Home and End jump to the ends.
 */
export function TakeEditor() {
  const cache = useRef<{ take: Take | null; blocks: TakeBlock[]; lo: number; hi: number }>({ take: null, blocks: [], lo: 0, hi: 1 });
  const view = useRef({ t: -250, bottom: NaN, pxPerMs: 0.12, follow: false, tail: false, wasPlaying: false });
  const geo = useRef({ w: 0, h: 0, rowH: 1 });
  const drag = useRef<Drag | null>(null);
  const lastLen = useRef(0);
  const grid = (free = false) => (free ? null : takeGrid(useSing.getState().take, useSing.getState().grid));

  const blocks = (): TakeBlock[] => {
    const take = useSing.getState().take;
    const c = cache.current;
    if (c.take !== take) {
      const v = view.current;
      const grew = !!take && !!c.take && !take.source && !c.take.source && take.events.length > c.take.events.length;
      const drawn = !c.take && take?.source === DRAWN;
      const fresh = !drawn && (!take || !c.take || take.source !== c.take.source || (!take.source && take.events.length === 1));
      c.take = take;
      c.blocks = take ? takeBlocks(take) : [];
      let lo = 0;
      let hi = 0;
      for (const b of c.blocks) hi = Math.max(hi, b.t1);
      for (const n of take ? backingNotes(take) : []) {
        lo = Math.min(lo, n.t);
        hi = Math.max(hi, n.t + n.dur);
      }
      c.lo = lo;
      c.hi = Math.max(lo + 1, hi);
      if (grew) v.tail = true;
      else if (fresh) {
        v.t = c.lo - 250;
        v.bottom = NaN;
        v.follow = false;
        v.tail = false;
      }
    }
    return c.blocks;
  };
  const span = () => (geo.current.w - LEFT) / view.current.pxPerMs;
  const mapX = (t: number) => LEFT + ((t - cache.current.lo) / (cache.current.hi - cache.current.lo)) * (geo.current.w - LEFT - 4);
  const mapT = (px: number) => cache.current.lo + ((px - LEFT) / Math.max(1, geo.current.w - LEFT - 4)) * (cache.current.hi - cache.current.lo);
  const seek = (t: number) => {
    const v = view.current;
    v.t = t - span() / 2;
    v.follow = false;
    v.tail = false;
  };
  const x = (t: number) => LEFT + (t - view.current.t) * view.current.pxPerMs;
  const y = (m: number) => geo.current.h - 4 - (m - view.current.bottom + 0.5) * geo.current.rowH;
  const barH = () => Math.max(4, geo.current.rowH - 3);
  const midiAt = (py: number) => Math.max(24, Math.min(96, Math.round((geo.current.h - 4 - py) / geo.current.rowH + view.current.bottom - 0.5)));

  const ref = usePhosphor(({ ctx, w, h }) => {
    const v = view.current;
    const bs = blocks();
    geo.current = { w, h, rowH: (h - TOP - 4) / SPAN };
    if (!Number.isFinite(v.bottom)) {
      const ms = bs.map((b) => b.midi);
      v.bottom = (ms.length ? (Math.min(...ms) + Math.max(...ms)) / 2 : 54) - SPAN / 2;
    }
    const span = (w - LEFT) / v.pxPerMs;
    const head = takePlayhead();
    if (head !== null && !v.wasPlaying) v.follow = true;
    if (head === null && v.wasPlaying) v.follow = false;
    v.wasPlaying = head !== null;
    if (v.follow && head !== null && (head > v.t + span * 0.85 || head < v.t)) v.t = head - span * 0.15;
    if (v.tail && head === null && bs.length) {
      const end = bs[bs.length - 1].t1;
      if (end > v.t + span * 0.9) v.t = end - span * 0.7;
      v.tail = false;
    }
    const cue = useSing.getState().cue;
    const { lo, hi } = cache.current;
    const { rowH } = geo.current;

    const dotted = new Path2D();
    for (let m = Math.floor(v.bottom) - 1; m <= Math.ceil(v.bottom + SPAN) + 1; m++) {
      const pc = ((m % 12) + 12) % 12;
      const yc = y(m);
      if (yc < TOP || yc > h) continue;
      if (BLACK.includes(pc)) {
        dotted.moveTo(LEFT, yc);
        dotted.lineTo(w, yc);
      }
      if (pc === 0) {
        seg(ctx, LEFT, yc + rowH / 2, w, yc + rowH / 2, V.frame, 1);
        if (yc + 5 <= h) label(ctx, `${NAMES[pc]}${Math.floor(m / 12) - 1}`, 6, yc + 3, { size: 9, color: TEXT.secondary, ls: 0.1 });
      }
    }
    beam(ctx, dotted, V.frame, 1, { dash: [1, 5] });

    const g = grid();
    const fine = g && g.step * v.pxPerMs >= 5 ? g.step : g && g.beat * v.pxPerMs >= 5 ? g.beat : 0;
    const step = v.pxPerMs > 0.2 ? 500 : v.pxPerMs > 0.06 ? 1000 : 5000;
    for (let t = Math.ceil(v.t / step) * step; t < v.t + span; t += step) {
      const xt = x(t);
      if (xt < LEFT) continue;
      seg(ctx, xt, MAP + 3, xt, fine ? TOP : h, V.frame, 1, { dash: [1, 7], alpha: 0.7 });
      if (t % 1000 === 0) label(ctx, `${t / 1000}s`, xt + 3, TOP - 6, { size: 9, color: TEXT.secondary, ls: 0.1 });
    }
    if (g && fine) {
      const thin = new Path2D();
      const beats = new Path2D();
      const bars = new Path2D();
      for (let n = Math.ceil((v.t - g.at) / fine); g.at + n * fine < v.t + span; n++) {
        const t = g.at + n * fine;
        const xt = x(t);
        if (xt < LEFT) continue;
        const beat = (t - g.at) / g.beat;
        const on = Math.abs(beat - Math.round(beat)) < 1e-3;
        const path = on && Math.round(beat) % 4 === 0 ? bars : on ? beats : thin;
        path.moveTo(xt, TOP);
        path.lineTo(xt, h);
      }
      beam(ctx, thin, V.frame, 1, { alpha: 0.35 });
      beam(ctx, beats, V.frame, 1, { alpha: 0.8 });
      beam(ctx, bars, V.blue, 1, { alpha: 0.45 });
    }
    seg(ctx, LEFT, MAP + 2, w, MAP + 2, V.frame, 1);
    seg(ctx, LEFT, TOP - 1, w, TOP - 1, V.frame, 1, { alpha: 0.6 });
    label(ctx, "ALL", 6, MAP - 3, { size: 8, color: TEXT.secondary, ls: 0.1 });
    label(ctx, "FROM", 6, TOP - 6, { size: 8, color: TEXT.secondary, ls: 0.1 });

    if (bs.length) {
      let mLo = Infinity;
      let mHi = -Infinity;
      for (const b of bs) {
        mLo = Math.min(mLo, b.midi);
        mHi = Math.max(mHi, b.midi);
      }
      const dots = new Path2D();
      for (const b of bs) {
        const yy = MAP - 1 - ((b.midi - mLo) / Math.max(1, mHi - mLo)) * (MAP - 4);
        const a = mapX(b.t0);
        dots.moveTo(a, yy);
        dots.lineTo(Math.max(a + 1, mapX(b.t1)), yy);
      }
      beam(ctx, dots, V.green, 1, { alpha: 0.6 });
      const win = new Path2D();
      const wa = Math.max(LEFT, mapX(v.t));
      const wb = Math.min(w - 2, mapX(v.t + span));
      win.rect(wa, 1, Math.max(3, wb - wa), MAP);
      beam(ctx, win, V.white, 1, { alpha: 0.8 });
      if (head !== null) seg(ctx, mapX(head), 1, mapX(head), MAP + 1, V.white, 1.4);
    }
    if (cue !== null && cue > lo && cue < hi) {
      const xm = mapX(cue);
      seg(ctx, xm, 1, xm, MAP + 1, V.amber, 1.4);
      const xc = x(cue);
      if (xc >= LEFT && xc <= w) {
        const tri = new Path2D();
        tri.moveTo(xc - 5, MAP + 4);
        tri.lineTo(xc + 5, MAP + 4);
        tri.lineTo(xc, TOP - 2);
        tri.closePath();
        beam(ctx, tri, V.amber, 1.4, { hot: true });
        seg(ctx, xc, TOP, xc, h, V.amber, 1, { dash: [4, 4], alpha: 0.8 });
      }
    }

    const d = drag.current;
    const nd = d?.kind === "note" ? d : null;
    const bh = barH();
    for (const b of bs) {
      const moving = nd?.block.on === b.on;
      const shift = nd && !moving && nd.ripple && b.on > nd.block.on ? nd.t0 - nd.block.t0 : 0;
      const x0 = x(moving ? nd.t0 : b.t0 + shift), x1 = Math.max(x0 + 4, x(moving ? nd.t1 : b.t1 + shift));
      if (x1 < LEFT || x0 > w) continue;
      const midi = moving ? nd.midi : b.midi;
      const yc = y(midi);
      const live = head !== null && head >= b.t0 && head <= b.t1;
      const r = new Path2D();
      const cx0 = Math.max(LEFT, x0);
      r.rect(cx0, yc - bh / 2, x1 - cx0, bh);
      if (live || moving) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = moving ? "rgba(255, 196, 92, 0.16)" : "rgba(91, 227, 129, 0.12)";
        ctx.fill(r);
        ctx.restore();
      }
      beam(ctx, r, moving ? V.amber : V.green, live || moving ? 1.6 : 1.2, { alpha: live || moving ? 1 : 0.75, hot: live || moving });
      if (b.text && b.text !== "~" && x0 >= LEFT) label(ctx, b.text.toUpperCase(), x0 + 1, yc - bh / 2 - 4, { size: 10, color: live || moving ? V.white : TEXT.secondary, ls: 0.12 });
    }

    const dd = d?.kind === "draw" ? d : null;
    if (dd) {
      const x0 = Math.max(LEFT, x(dd.t0));
      const r = new Path2D();
      r.rect(x0, y(dd.midi) - bh / 2, Math.max(4, x(dd.t1) - x0), bh);
      beam(ctx, r, V.amber, 1.6, { hot: true });
    }

    if (head !== null) {
      const xh = x(head);
      if (xh >= LEFT && xh <= w) seg(ctx, xh, TOP, xh, h, V.white, 1, { dash: [3, 4], alpha: 0.7 });
    }
    if (!bs.length && !dd) label(ctx, "DRAG ON THE GRID TO DRAW NOTES, OR PLAY THE KEYS", LEFT + 12, h / 2, { size: 10, color: TEXT.secondary, ls: 0.12 });
  });

  const hit = (px: number, py: number): { block: TakeBlock; end: boolean } | null => {
    const bs = cache.current.blocks;
    const bh = barH();
    for (let k = bs.length - 1; k >= 0; k--) {
      const b = bs[k];
      const x0 = x(b.t0), x1 = Math.max(x0 + 6, x(b.t1));
      if (px >= x0 - 2 && px <= x1 + 3 && Math.abs(py - y(b.midi)) <= bh / 2 + 3) return { block: b, end: b.off >= 0 && px >= x1 - EDGE && x1 - x0 > EDGE * 2 };
    }
    return null;
  };
  const cursorFor = (h: { end: boolean } | null) => (h ? (h.end ? "ew-resize" : "move") : "grab");
  const at = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  const tAt = (px: number) => view.current.t + (px - LEFT) / view.current.pxPerMs;
  const setCue = (px: number) => {
    const { lo, hi } = cache.current;
    const t = Math.max(lo, Math.min(hi, tAt(px)));
    useSing.getState().setCue(t <= lo + 1 ? null : Math.round(t));
  };

  const pan = (px: number, py: number) => ({ kind: "pan" as const, x0: px, y0: py, t: view.current.t, bottom: view.current.bottom, moved: false });

  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    const [px, py] = at(e);
    if (e.button === 2) {
      const h = py >= TOP ? hit(px, py) : null;
      if (h) removeTakeNote(h.block);
      return;
    }
    if (e.button === 1) {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = pan(px, py);
      e.currentTarget.style.cursor = "grabbing";
      return;
    }
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (py <= MAP + 2 && px >= LEFT) {
      drag.current = { kind: "seek" };
      seek(mapT(px));
      return;
    }
    if (py < TOP && px >= LEFT) {
      drag.current = { kind: "cue" };
      if (e.detail >= 2) useSing.getState().setCue(null);
      else setCue(px);
      return;
    }
    const h = hit(px, py);
    if (h) {
      const b = h.block;
      drag.current = { kind: "note", block: b, end: h.end, x0: px, y0: py, midi: b.midi, t0: b.t0, t1: b.t1, ctrl: e.ctrlKey || e.metaKey, ripple: e.ctrlKey || e.metaKey, moved: false };
      e.currentTarget.style.cursor = cursorFor(h);
      return;
    }
    if (e.shiftKey || px < LEFT) {
      drag.current = pan(px, py);
      e.currentTarget.style.cursor = "grabbing";
      return;
    }
    const g = grid(e.altKey);
    const t0 = Math.max(0, g ? snap(tAt(px), g, true) : tAt(px));
    const min = g ? g.step : 40;
    drag.current = { kind: "draw", x0: px, t0, t1: t0 + Math.max(min, lastLen.current || (g ? g.step : 250)), min, midi: midiAt(py), moved: false };
    e.currentTarget.style.cursor = "crosshair";
  };
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    const [px, py] = at(e);
    const d = drag.current;
    const rowH = geo.current.rowH;
    if (!d) {
      const h = hit(px, py);
      e.currentTarget.style.cursor = py < TOP && px >= LEFT ? "pointer" : h ? cursorFor(h) : px >= LEFT ? "crosshair" : "grab";
      return;
    }
    if (d.kind === "draw") {
      if (Math.abs(px - d.x0) > 3) d.moved = true;
      if (!d.moved) return;
      const g = grid(e.altKey);
      d.t1 = Math.max(d.t0 + d.min, g ? snap(tAt(px), g) : tAt(px));
      return;
    }
    if (d.kind === "seek") {
      seek(mapT(px));
      return;
    }
    if (d.kind === "cue") {
      setCue(px);
      return;
    }
    if (d.kind === "note") {
      const b = d.block;
      if (Math.abs(px - d.x0) > 2 || Math.abs(py - d.y0) > 2) d.moved = true;
      if (!d.moved) return;
      const dt = (px - d.x0) / view.current.pxPerMs;
      const g = grid(e.altKey);
      d.ripple = d.ctrl || e.ctrlKey || e.metaKey;
      if (d.end) {
        const t1 = snap(b.t1 + dt, g);
        d.t1 = t1 > b.t0 + 10 ? t1 : b.t0 + (g ? g.step : 20);
      } else {
        d.midi = Math.max(24, Math.min(96, b.midi + Math.round((d.y0 - py) / rowH)));
        d.t0 = Math.max(0, snap(b.t0 + dt, g));
        d.t1 = d.t0 + (b.t1 - b.t0);
      }
      return;
    }
    const v = view.current;
    v.t = d.t - (px - d.x0) / v.pxPerMs;
    v.bottom = d.bottom + (py - d.y0) / rowH;
    v.follow = false;
    d.moved = true;
  };
  const up = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    e.currentTarget.style.cursor = "grab";
    if (d?.kind === "draw") {
      if (!addTakeNote(d.t0, d.t1, d.midi)) return;
      lastLen.current = d.t1 - d.t0;
      const take = useSing.getState().take;
      const made = take ? takeBlocks(take).find((b) => b.midi === d.midi && Math.abs(b.t0 - d.t0) < 1) : undefined;
      if (made) auditionTake(made, made.midi, useStore.getState().body);
      return;
    }
    if (d?.kind !== "note") return;
    const b = d.block;
    if (d.midi !== b.midi) moveTakeNote(b, d.midi);
    const timed = Math.abs(d.t0 - b.t0) >= 1 || Math.abs(d.t1 - b.t1) >= 1;
    if (timed) retimeTakeNote(b, d.t0, d.t1, d.ripple);
    if (d.midi !== b.midi || !d.moved) auditionTake(b, d.midi, useStore.getState().body);
  };
  const cancel = () => {
    drag.current = null;
  };

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = view.current;
      v.follow = false;
      const px = e.clientX - canvas.getBoundingClientRect().left;
      if (e.ctrlKey) {
        const tAt = v.t + (px - LEFT) / v.pxPerMs;
        v.pxPerMs = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v.pxPerMs * Math.exp(-e.deltaY * 0.002)));
        v.t = tAt - (px - LEFT) / v.pxPerMs;
      } else if (e.shiftKey) v.bottom -= Math.sign(e.deltaY || e.deltaX) * 2;
      else v.t += (e.deltaY + e.deltaX) / v.pxPerMs / 2;
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Home" && e.key !== "End") return;
      e.preventDefault();
      const v = view.current;
      const { lo, hi } = cache.current;
      v.follow = false;
      v.t = e.key === "Home" ? lo - 250 : hi - span() * 0.8;
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("keydown", key);
    return () => {
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("keydown", key);
    };
  }, [ref]);

  return (
    <canvas
      ref={ref}
      className="instrument-canvas roll-canvas"
      tabIndex={0}
      style={{ cursor: "grab", touchAction: "none", outline: "none" }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
      aria-label="Take editor: your take's notes as a piano roll, each note singing the next syllable. Drag on empty grid to draw a note, right-click a note to delete it, drag a note up or down to change its pitch and sideways to move it in time, drag its right end to change its length, hold Ctrl to move everything after it too, hold Alt to place off the grid; middle-drag or Shift+drag to pan, scroll to move through time, Shift+scroll for pitch, Ctrl+scroll to zoom. Click the strip along the top to jump anywhere in the take, click the time ruler to set where Sing starts, double-click it to start from the top; Home and End jump to the ends."
    />
  );
}

/** The editor's grid step and the beats a minute it counts in (an imported file brings its own). */
export function GridTools() {
  const division = useSing((s) => s.grid);
  const setGrid = useSing((s) => s.setGrid);
  const bpm = useSing((s) => s.take?.bpm ?? DEFAULT_BPM);
  const hasTake = useSing((s) => !!s.take);
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && Number(draft) > 0) setTakeBpm(Number(draft));
    setDraft(null);
  };
  return (
    <>
      <Menu label="Grid" value={String(division)} options={GRIDS.map((g) => ({ value: String(g), label: g ? `Grid 1/${g}` : "Grid off" }))} onChange={(v) => setGrid(Number(v))} />
      <label className="menu bpm" title="Beats a minute the grid counts in (an imported MIDI brings its own)">
        <input
          type="number"
          min={20}
          max={400}
          aria-label="Grid tempo in beats a minute"
          disabled={!hasTake}
          value={draft ?? String(Math.round(bpm * 100) / 100)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
        <span>BPM</span>
      </label>
    </>
  );
}
