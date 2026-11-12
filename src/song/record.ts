/**
 * A video of the head singing: the face screen's canvas copied each frame into a 9:16 frame (black
 * above and below, which the vector look already is) with the wordmark at the foot, and the voice
 * from the audio graph, through the browser's MediaRecorder. MP4 where the browser records it
 * (Safari, recent Chrome: what Instagram and TikTok take), else WebM. While a clip records, the
 * face screens leave out their measurements (`recording`), so what you see is what you get.
 */
import { label } from "../ui/render/vector.ts";
import { V } from "../ui/colors.ts";

const W = 720, H = 1280;
/** the band at the foot that holds the wordmark */
const FOOT = 150;
const TYPES = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];

function pickType(): string | null {
  if (typeof MediaRecorder === "undefined" || typeof HTMLCanvasElement === "undefined" || !("captureStream" in HTMLCanvasElement.prototype)) return null;
  return TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

/** a clip is recording: the face screens draw the head without readouts or measurements */
export const recording = { on: false };

/** whether this browser can record a clip at all */
export const canRecord = (): boolean => pickType() !== null;

export class Clip {
  private frame = document.createElement("canvas");
  private rec: MediaRecorder;
  private chunks: Blob[] = [];
  private raf = 0;
  private type: string;
  /** the frame's capture track: ours to stop (the audio track is the engine's, shared) */
  private video: MediaStreamTrack[];

  constructor(source: HTMLCanvasElement, audio: MediaStream) {
    this.type = pickType()!;
    recording.on = true;
    this.frame.width = W;
    this.frame.height = H;
    const ctx = this.frame.getContext("2d")!;
    const draw = () => {
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      const sw = source.width, sh = source.height;
      if (sw > 0 && sh > 0) {
        const k = Math.min(W / sw, (H - FOOT) / sh);
        ctx.drawImage(source, (W - sw * k) / 2, (H - FOOT - sh * k) / 2, sw * k, sh * k);
      }
      label(ctx, "CHIMERA", W / 2, H - FOOT / 2, { size: 30, color: V.blue, weight: "m", ls: 0.34, align: "center" });
      this.raf = requestAnimationFrame(draw);
    };
    draw();
    this.video = this.frame.captureStream(30).getVideoTracks();
    try {
      this.rec = new MediaRecorder(new MediaStream([...this.video, ...audio.getAudioTracks()]), { mimeType: this.type, videoBitsPerSecond: 5_000_000 });
    } catch (e) {
      this.release();
      throw e;
    }
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(500);
  }

  /** Finish: the clip as a file named `name` (the extension is added). */
  stop(name: string): Promise<File> {
    cancelAnimationFrame(this.raf);
    return new Promise((resolve) => {
      this.rec.onstop = () => {
        this.release();
        const type = this.type.split(";")[0];
        resolve(new File(this.chunks, `${name}.${type === "video/mp4" ? "mp4" : "webm"}`, { type }));
      };
      this.rec.stop();
    });
  }

  /** Throw it away. */
  cancel(): void {
    this.rec.onstop = null;
    if (this.rec.state !== "inactive") this.rec.stop();
    this.release();
  }

  private release(): void {
    recording.on = false;
    cancelAnimationFrame(this.raf);
    for (const t of this.video) t.stop();
  }
}
