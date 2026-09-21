import Clutter from 'gi://Clutter';
import { UILayerSampler } from './uiLayerSampler.js';
import { WindowCloneManager } from './windowClones.js';
import { isActorValid } from '../actors/lifecycle.js';
import { isCaptureClipEnabled, isCloneCullEnabled, GlassRect } from './options.js';
import { unionRectInto } from '../actors/geometry.js';
import { setClipIfChanged } from '../actors/writes.js';
/**
 * [PERF ①/①b] Per-frame entry point for the capture clip and the clone cull.
 *
 * Call it from the manager's own sync, AFTER setResolution()/
 * setGlassGeometry() (so the effect's uniforms describe this frame) and
 * BEFORE uiSampler.sync()/windowCloneManager.sync() (so the cull rect this
 * computes is the one those two use this frame, not next frame).
 *
 * Coordinate spaces, because getting one of these wrong makes the glass show
 * an empty background and nothing else:
 *
 *   shader space  liquidBox-local pixels. What LiquidEffect works in
 *                 (resolution_x/y, dock_x/y/w/h, getCaptureClipRect()).
 *   screen space  absolute stage coordinates. What the clones are positioned
 *                 in — both WindowCloneManager and UILayerSampler place
 *                 their clones at the SOURCE's absolute position and let a
 *                 container-level translation map them into the FBO.
 *
 * They differ by the glass's own origin on screen, which the caller passes as
 * originX/originY (the monitor origin for every current caller).
 *
 * The clip goes on the clone container, whose own transform is identity, so
 * its local space IS shader space and the rect can be applied as-is.
 */
export function syncGlassCaptureClip(opts: {
  /** The actor holding bgClone / windowClones / uiClones. */
  cloneContainer: Clutter.Actor | null,
  /** The LiquidEffect driving this glass. */
  effect: any,
  /** Screen position of shader-space (0, 0), i.e. of the glass's bgActor. */
  originX: number,
  originY: number,
  uiSampler?: UILayerSampler | null,
  windowCloneManager?: WindowCloneManager | null,
}): void {
  const { cloneContainer, effect, originX, originY } = opts;
  const uiSampler = opts.uiSampler ?? null;
  const windowCloneManager = opts.windowCloneManager ?? null;

  const clear = () => {
    if (cloneContainer && isActorValid(cloneContainer) &&
        (cloneContainer as any)._lgClipW !== undefined) {
      (cloneContainer as any)._lgClipX = undefined;
      (cloneContainer as any)._lgClipY = undefined;
      (cloneContainer as any)._lgClipW = undefined;
      (cloneContainer as any)._lgClipH = undefined;
      try { cloneContainer.remove_clip(); } catch (_) { }
    }
    uiSampler?.setCullRect(null);
    windowCloneManager?.setCullRect(null);
    windowCloneManager?.applyBgCloneClip(null);
    if (effect) effect._lgCaptureClip = null;
  };

  if (!isCaptureClipEnabled() && !isCloneCullEnabled()) { clear(); return; }
  if (!effect || typeof effect.getCaptureClipRect !== 'function') { clear(); return; }

  let rect: GlassRect | null = null;
  try {
    const r = effect.getCaptureClipRect();
    if (r) rect = [r[0], r[1], r[2], r[3]];
  } catch (_) {
    clear();
    return;
  }
  if (!rect) { clear(); return; }

  // A BMS replica whose rect we have not measured yet: sit this frame out
  // rather than risk clipping the panel's band away for one frame. It costs
  // a single unclipped paint, once, right after the replica is built.
  if (uiSampler?.hasUnmeasuredBmsReplica()) { clear(); return; }

  // Widen to cover every BMS replica this glass draws. A BACKGROUND-mode BMS
  // blur reads the framebuffer over the panel's full stage rect, so any part
  // of that rect we stop painting into comes back as blurred transparency
  // smeared across the whole panel (memo.md 追記4). The panel is full width,
  // so with the dock at the top edge this widens the clip to the full screen
  // — the height still collapses, which is where the saving is.
  const bmsRects = uiSampler?.getBmsScreenRects() ?? [];
  for (const b of bmsRects) {
    unionRectInto(rect, [b[0] - originX, b[1] - originY, b[2], b[3]]);
  }

  const [resW, resH] = typeof effect.getResolution === 'function'
    ? effect.getResolution() : [0, 0];
  if (resW >= 1 && resH >= 1) {
    const x1 = Math.min(resW, rect[0] + rect[2]);
    const y1 = Math.min(resH, rect[1] + rect[3]);
    rect[0] = Math.max(0, rect[0]);
    rect[1] = Math.max(0, rect[1]);
    rect[2] = x1 - rect[0];
    rect[3] = y1 - rect[1];
    if (!(rect[2] >= 2) || !(rect[3] >= 2)) { clear(); return; }
  }

  if (isCaptureClipEnabled() && cloneContainer && isActorValid(cloneContainer)) {
    setClipIfChanged(cloneContainer, rect[0], rect[1], rect[2], rect[3]);
  } else if (cloneContainer && isActorValid(cloneContainer) &&
             (cloneContainer as any)._lgClipW !== undefined) {
    (cloneContainer as any)._lgClipW = undefined;
    try { cloneContainer.remove_clip(); } catch (_) { }
  }

  // [DIAG] Visible in global._lgGlass.dump() as `captureClip`.
  effect._lgCaptureClip = rect.slice();

  const screenRect: GlassRect = [rect[0] + originX, rect[1] + originY, rect[2], rect[3]];

  // The wallpaper clone is not under cloneContainer, so it needs its own
  // clip — in screen space. See applyBgCloneClip().
  windowCloneManager?.applyBgCloneClip(isCaptureClipEnabled() ? screenRect : null);

  uiSampler?.setCullRect(screenRect);
  windowCloneManager?.setCullRect(screenRect);
}
