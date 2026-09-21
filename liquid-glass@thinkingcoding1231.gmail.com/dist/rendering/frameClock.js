// ─── Frame serial ────────────────────────────────────────────────────────────
//
// [PERF] Counts painted frames, so an effect can tell "this is the first time
// I have been asked to paint this frame" from "I am being painted again".
//
// The second case is not rare — it is the dominant cost of this extension.
// A glass surface is a child of its window actor, and every OTHER glass
// surface that shows this window renders it through a Clutter.Clone, which
// repaints the whole source subtree including its effect. The dock clones
// every window; each window clones every window below it. Measured with
// dock + 3 windows, per frame:
//
//     dock              0.98 paints
//     top window        1.97
//     middle window     5.90
//     bottom window    13.78
//     ---------------------------
//     total            22.63 blur+composite chains for 4 glass surfaces
//
// Each of those re-ran the full crop -> downsample -> H -> V chain to produce
// a texture bit-identical to the one the frame's first paint had already
// produced from the very same capture. Only the composite genuinely differs
// (it draws into a different framebuffer).
//
// Incremented on the stage's 'after-paint'. Multi-monitor is handled by
// construction rather than by special-casing: the signal fires once per stage
// view, so each view's first paint re-runs the chain into that view's frame.
export let frameSerial = 0;
let _frameSerialStage = null;
let _frameSerialHandler = 0;
export function ensureFrameSerialHook() {
    if (_frameSerialHandler)
        return true;
    try {
        const stage = globalThis.global?.stage;
        if (!stage)
            return false;
        _frameSerialStage = stage;
        _frameSerialHandler = stage.connect('after-paint', () => { frameSerial++; });
    }
    catch (e) {
        _frameSerialStage = null;
        _frameSerialHandler = 0;
    }
    return _frameSerialHandler !== 0;
}
// Whether the counter is actually advancing. Load-bearing: without the hook
// frameSerial is frozen at 0, every paint after the first would look like a
// repeat, and the blur would be computed once and then reused forever — the
// glass would freeze on whatever the first frame contained. The reuse is
// therefore gated on this rather than assuming the connect() worked.
export function frameSerialIsLive() {
    return _frameSerialHandler !== 0;
}
export function releaseFrameSerialHook() {
    if (!_frameSerialHandler)
        return;
    try {
        _frameSerialStage?.disconnect(_frameSerialHandler);
    }
    catch (e) { }
    _frameSerialStage = null;
    _frameSerialHandler = 0;
}
