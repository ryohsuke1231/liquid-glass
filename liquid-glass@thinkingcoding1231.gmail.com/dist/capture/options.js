// ─── [PERF ①/①b] Capture clipping and clone culling ──────────────────────────
//
// Every glass is a ClutterOffscreenEffect, so each paint is
//
//   1. bind the offscreen FBO and clear it
//   2. paint the whole clone subtree into it
//        (wallpaper clone + every window clone + UI clones + BMS replica)
//   3. run the blur and the composite (vfunc_paint_target)
//
// The blur sub-rect (phase 8) and the composite sub-rect (②) only ever
// shrank step 3. Step 2 is still paid in full, and for the dock / menus /
// notifications / OSD / quick settings it is paid over the WHOLE MONITOR,
// because their bgActor is monitor-sized on purpose (see landmine 9 in
// memo.md: shrinking it breaks Blur My Shell's stage-coordinate blit).
//
// Application windows already avoid this: applicationManager builds a
// `clipBox` with clip_to_allocation and sizes it to the glass box, so their
// clone subtree is clipped to the glass already. These two switches bring
// the same saving to the other five.
//
// ①  captureClip — set_clip() on the clone container.
//    Verified against mutter 50.1 rather than assumed:
//      * clutter-actor.c:3570  a clip becomes a ClutterClipNode wrapping the
//        actor's node, INSIDE the actor's own transform node. So the clip
//        rect is in the same local space the children are positioned in, and
//        it is pushed while the offscreen framebuffer is current — which is
//        exactly why the existing bgActor.set_clip() never helped: bgActor
//        sits OUTSIDE the effect, so its clip only ever scissored the
//        composite into the stage framebuffer.
//      * clutter-offscreen-effect.c:346 sizes the FBO from
//        clutter_actor_get_paint_volume() of the effect's actor, and
//        clutter-actor.c:5586 builds that volume starting FROM THE ACTOR'S
//        OWN ALLOCATION and only ever unions children into it. liquidBox is
//        set_size(monitor) already, so clipping a descendant cannot shrink
//        it. The FBO keeps its size AND its origin => computeCaptureLayout(),
//        _lgCaptureOffset and BMS's stage-coordinate blit are all untouched.
//        This is what keeps landmine 9 out of the picture.
//
// ①b cloneCull — hide clones that fall outside that same rect.
//    set_clip() only scissors: the clipped-out actors still build and run
//    their paint nodes, and a NESTED glass renders into its own FBO, which
//    the parent's scissor does not touch at all. A clone with visible=false,
//    on the other hand, makes clutter_actor_paint() return immediately, so
//    its source is never painted THROUGH IT and the nested glass never runs.
//
//    That is the part that matters: it turns the 2^N nesting into
//    2^(number of windows actually overlapping this glass) without removing
//    the nesting itself. Nothing changes visually — a window that does not
//    intersect the glass box contributed zero pixels to the capture anyway.
//
//    UILayerSampler.syncProperties() has always done this test, but against
//    the CONTAINER's bounds, which are the whole monitor — so it never culled
//    anything. setCullRect() gives it a rect that means something.
//
// A/B: global._lgGlass.captureClip(false) / .cloneCull(false).
//
// ─── MEASURED (2026-09-13, 3 glass windows + dock, while moving things) ───
//
//   both off (④ only, the previous baseline)   36-38%
//   ① on, ①b off                               40-42%   ← WORSE than neither
//   ① off, ①b on                               26-30%
//   both on                                    29%
//
// ① costs about 4 points and returns nothing, so it ships OFF. The reason is
// visible in the numbers rather than guessed at: the wallpaper and the window
// clones are a handful of large quads, and scissoring them saves far less
// fill than the extra clip push/pop and the batching it breaks costs — while
// the FBO is cleared at full size either way (clutter-paint-nodes.c:1034
// clears the whole layer node unconditionally).
//
// ①b is the one that pays, and for a different reason: it removes whole
// nested glass renders, which no amount of scissoring can.
//
// The ① code is kept, and kept working, because it is the only lever left if
// the capture's fill rate ever does become the bottleneck (a much larger
// monitor, say). Turn it on with global._lgGlass.captureClip(true).
let _captureClipEnabled = false;
let _cloneCullEnabled = true;
export function setCaptureClipEnabled(enabled) {
    _captureClipEnabled = !!enabled;
}
export function isCaptureClipEnabled() {
    return _captureClipEnabled;
}
export function setCloneCullEnabled(enabled) {
    _cloneCullEnabled = !!enabled;
}
export function isCloneCullEnabled() {
    return _cloneCullEnabled;
}
// [DIAG] ①b runs at three independent sites, and the cull log showed every
// decision to be geometrically correct — so the next question is not "is the
// rect wrong" but "which of the three breaks the picture". These split the
// master switch so one paste answers that:
//
//   global._lgGlass.cullApp(false)      ApplicationManager._syncClones()
//                                       (behind-window clones inside a
//                                        window's own glass)
//   global._lgGlass.cullWindows(false)  WindowCloneManager.sync()
//                                       (window clones inside dock / menu /
//                                        notification / OSD / quick settings)
//   global._lgGlass.cullUi(false)       UILayerSampler.syncProperties()
//                                       (uiGroup clones in those same five)
//
// Each is ANDed with the master cloneCull switch.
let _cullApp = true;
let _cullWindows = true;
let _cullUi = true;
export function setCullSiteEnabled(site, enabled) {
    if (site === 'app')
        _cullApp = !!enabled;
    else if (site === 'windows')
        _cullWindows = !!enabled;
    else
        _cullUi = !!enabled;
}
export function isCullSiteEnabled(site) {
    if (!_cloneCullEnabled)
        return false;
    if (site === 'app')
        return _cullApp;
    if (site === 'windows')
        return _cullWindows;
    return _cullUi;
}
