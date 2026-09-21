import Clutter from 'gi://Clutter';
import Mtk from 'gi://Mtk';
/**
 * Captures a small rectangle of the screen (the panel area) into a
 * `Clutter.Content`, for use as the "blurred panel" backdrop inside the
 * glass, while structurally guaranteeing the glass never captures itself.
 *
 * Background: Blur My Shell (BMS) blurs the real top panel using a native
 * (non-JS) Clutter effect. That effect has no public API to read its result,
 * and — critically — it assumes it is the *only* consumer of its target
 * actor's paint output. Cloning the BMS target directly (`Clutter.Clone`)
 * makes BMS think a second consumer has taken over, and the *real* panel
 * loses its blur. So we never clone or paint the BMS actor at all; instead
 * we take an independent snapshot of "what the screen looks like there".
 *
 * Why `paint_to_content()` specifically: it performs a one-off, synchronous
 * render of a stage rectangle into an offscreen buffer, completely separate
 * from the actual on-screen frame. That gives us two things a live
 * `Clutter.Clone` cannot:
 *   1. Self-exclusion: our own glass root (`bgActor`) sits directly above
 *      the panel in z-order and can visually overlap it (e.g. when a
 *      panel-anchored popup is open). If we captured "the whole composited
 *      screen" while our own glass was visible, we would capture our own
 *      glass along with the panel — and since we redraw using that captured
 *      image every frame, this becomes a runaway feedback loop: each new
 *      capture already contains yesterday's capture, nested one level
 *      deeper, forever. (Diagnostic tip that confirmed this: the nesting
 *      alternated right-side-up / upside-down with each additional level,
 *      matching a V-flip correction from an older capture method being
 *      compounded once per loop iteration.)
 *      We avoid this entirely by hiding our own root actor for the single
 *      synchronous `paint_to_content()` call, then restoring it immediately
 *      — so the glass structurally cannot appear in its own snapshot.
 *   2. No visible flicker: hide → capture → show all happens synchronously,
 *      before control returns to Clutter's normal repaint cycle, so the
 *      actual displayed frame is never affected.
 *
 * We also always pass `Clutter.PaintFlag.NO_CURSORS`. GNOME Shell's own
 * screenshot code (shell-screenshot.c) does the same for this exact API —
 * without it, the mouse pointer sprite gets composited into the snapshot,
 * which shows up as cursor smearing inside the glass.
 */
export class SelfExcludingSnapshotCapture {
  private _content: any = null;
  private _rectGetter: () => [number, number, number, number];

  private _hideActors: Set<Clutter.Actor> = new Set();
  private _stage: Clutter.Stage;
  private _refCount: number = 0;
  private _afterPaintId: number = 0;
  private _destroyed: boolean = false;

  // Re-capture on every 'after-paint' rather than a fixed timer: this way
  // updates only happen (and only cost anything) while the screen is
  // actually changing, and are as fresh as the display's own refresh rate.
  // Raise FRAME_SKIP if this ever proves too expensive on slower hardware
  // (2 = every other frame, etc.) — 1 keeps it perfectly in sync.
  private static readonly FRAME_SKIP = 1;
  private _frameCounter: number = 0;

  // [DIAG] Every failure path in _captureOnce() used to be swallowed by a
  // bare `catch (e) {}`, so a capture that never produced anything looked
  // from the outside exactly like a capture that worked — the glass simply
  // showed whatever was layered beneath it (the wallpaper/window clones)
  // with no hint as to why. These make the first failure of each kind, and
  // then every 300th, visible in the journal.
  private _label: string;
  private _failCount: number = 0;
  private _okCount: number = 0;

  // When set and it returns false, _captureOnce() is a no-op (and reports
  // nothing): the capture is dormant rather than failing. Without it, a
  // capture created for a popup keeps hiding its hide-actor and re-painting
  // the whole stage into an offscreen on every single frame for as long as it
  // lives, popup open or not.
  private _activeCheck: (() => boolean) | null;

  constructor(
    stage: Clutter.Stage, hideActor: Clutter.Actor,
    rectGetter: () => [number, number, number, number],
    label: string = 'snapshot',
    activeCheck: (() => boolean) | null = null
  ) {
    this._stage = stage;
    this._label = label;
    this._activeCheck = activeCheck;
    if (hideActor) this._hideActors.add(hideActor);
    this._rectGetter = rectGetter;
    this._captureOnce();
    try {
      this._afterPaintId = (this._stage as any).connect('after-paint', () => {
        if (this._destroyed) return;
        this._frameCounter++;
        if (this._frameCounter % SelfExcludingSnapshotCapture.FRAME_SKIP !== 0) return;
        this._captureOnce();
      });
    } catch (e) {
    }
  }

  retain(): void { this._refCount++; }
  release(): boolean {
    this._refCount--;
    if (this._refCount <= 0) { this.destroy(); return true; }
    return false;
  }

  /** Registers another Liquid Glass instance's root as needing to be hidden during capture. */
  addHideActor(actor: Clutter.Actor | null | undefined): void {
    if (actor) this._hideActors.add(actor);
  }

  /** Unregisters a previously-added hide actor (called when that instance releases the capture). */
  removeHideActor(actor: Clutter.Actor | null | undefined): void {
    if (actor) this._hideActors.delete(actor);
  }

  /** [DIAG] Throttled: reports the 1st, 2nd and then every 300th occurrence. */
  private _report(kind: string, detail: string): void {
    this._failCount++;
    if (this._failCount <= 2 || this._failCount % 300 === 0) {
      console.warn(
        `[Liquid Glass][snapshot:${this._label}] ${kind} (failures=${this._failCount}, ` +
        `successes=${this._okCount}): ${detail}`
      );
    }
  }

  private _captureOnce(): void {
    if (this._activeCheck) {
      try {
        if (!this._activeCheck()) return;
      } catch (e) {
        return;
      }
    }

    const [x, y, w, h] = this._rectGetter();
    if (w <= 0 || h <= 0) {
      this._report('empty capture rect', `x=${x} y=${y} w=${w} h=${h}`);
      return;
    }

    // Hide every registered instance's root, not just a single
    // one, so a shared capture never leaks any glass instance into itself.
    const hidden: Clutter.Actor[] = [];
    try {
      for (const actor of this._hideActors) {
        try {
          if (actor && actor.visible) {
            actor.hide();
            hidden.push(actor);
          }
        } catch (_) { /* actor may have been destroyed; skip it */ }
      }

      const rect = new Mtk.Rectangle({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
      const scale = 1; // TODO: honor per-monitor resource scale if this is ever used on HiDPI setups.

      // Signature is (rect, scale, color_state, paint_flags); color_state
      // of null uses the default color space. NO_CURSORS excludes the
      // mouse pointer sprite from the snapshot (see class doc comment).
      // CLEAR matters: clutter_stage_paint_to_framebuffer() only clears the
      // offscreen when this flag is set, and the texture it allocates starts
      // out with undefined contents — anything the stage does not paint over
      // is garbage without it.
      const NO_CURSORS = (Clutter as any).PaintFlag?.NO_CURSORS ?? 0;
      const CLEAR = (Clutter as any).PaintFlag?.CLEAR ?? 0;
      const paintFlags = NO_CURSORS | CLEAR;
      const content = (this._stage as any).paint_to_content?.(rect, scale, null, paintFlags);
      if (content) {
        this._content = content;
        this._okCount++;
      } else {
        this._report('paint_to_content returned null',
          `rect=${rect.x},${rect.y} ${rect.width}x${rect.height}`);
      }
    } catch (e) {
      this._report('paint_to_content threw', `${e}`);
    } finally {
      for (const actor of hidden) {
        try { actor.show(); } catch (_) { /* actor may have been destroyed; skip it */ }
      }
    }
  }

  getContent(): any | null {
    return this._content;
  }

  destroy(): void {
    this._destroyed = true;
    if (this._afterPaintId) {
      try { (this._stage as any).disconnect(this._afterPaintId); } catch (_) { /* noop */ }
      this._afterPaintId = 0;
    }
  }
}

// Shared pool: multiple UILayerSampler instances (e.g. a permanent dock glass
// and a popup-menu glass) may want to capture the same BMS target. Keying by
// source actor lets them share a single capture instead of duplicating work.
const _selfExcludingSnapshotRegistry: Map<Clutter.Actor, SelfExcludingSnapshotCapture> = new Map();

export function acquireSelfExcludingSnapshot(
  sourceActor: Clutter.Actor,
  stage: Clutter.Stage,
  hideActor: Clutter.Actor,
  rectGetter: () => [number, number, number, number],
  label: string = 'bms'
): SelfExcludingSnapshotCapture {
  let cap = _selfExcludingSnapshotRegistry.get(sourceActor);
  if (!cap) {
    cap = new SelfExcludingSnapshotCapture(stage, hideActor, rectGetter, label);
    _selfExcludingSnapshotRegistry.set(sourceActor, cap);
  } else {
    cap.addHideActor(hideActor);
  }
  cap.retain();
  return cap;
}

export function releaseSelfExcludingSnapshot(sourceActor: Clutter.Actor, hideActor?: Clutter.Actor): void {
  const cap = _selfExcludingSnapshotRegistry.get(sourceActor);
  if (!cap) return;
  // Unregister our hide actor first so a capture that outlives us (still
  // retained by another instance) doesn't keep trying to hide an actor we
  // no longer care about.
  cap.removeHideActor(hideActor);
  if (cap.release()) {
    _selfExcludingSnapshotRegistry.delete(sourceActor);
  }
}
