# Rendering notes

Historical explanations retained during the renderer decomposition. The implementation is in `src/rendering/`; `src/liquidEffect.ts` coordinates it. Some historical field names below refer to the pre-refactor implementation.

## Rendering contract

src/liquidEffect.ts

─── Design overview ───────────────────────────────────────────────────────

 Old implementation: subclassed Clutter.ShaderEffect and did refraction,
         rim lighting, and shadowing all in a single glass.frag shader.
         Blur relied solely on ShaderEffect's cogl_sampler texture
         sampling, with no dedicated blur pass.

 New implementation: subclasses Clutter.OffscreenEffect and overrides
         vfunc_paint_target to run a custom multi-pass FBO pipeline.

 Rendering pipeline (per frame):

   ┌──────────────────────────────────────────────────────┐
   │  OffscreenEffect automatically captures the actor's   │
   │  painted content into an internal FBO                │
   │  (retrievable via get_texture())                      │
   └────────────────────┬─────────────────────────────────┘
                        │ srcTex (full monitor resolution)
                        ▼
   ┌──────────────── Downsample ──────────────────────────┐
   │  Pass 0: srcTex    → _blurFbos[0]  (w/2  × h/2)      │
   │  Pass 1: _tex[0]   → _blurFbos[1]  (w/4  × h/4)      │
   │  Pass 2: _tex[1]   → _blurFbos[2]  (w/8  × h/8)      │
   │  Pass 3: _tex[2]   → _blurFbos[3]  (w/16 × h/16)     │
   │  (shaders/downsample.frag – Dual Kawase, 5-tap)       │
   └────────────────────┬─────────────────────────────────┘
                        │
   ┌──────────────── Upsample ────────────────────────────┐
   │  Pass 3→2: _tex[3] → _blurFbos[2]                    │
   │  Pass 2→1: _tex[2] → _blurFbos[1]                    │
   │  Pass 1→0: _tex[1] → _blurFbos[0]  (w/2 × h/2)       │
   │  (shaders/upsample.frag – Dual Kawase tent, 8-tap)    │
   └────────────────────┬─────────────────────────────────┘
                        │ _blurTextures[0] (blurred, w/2 × h/2)
                        ▼
   ┌──────────────── Glass composite ─────────────────────┐
   │  shaders/glass.frag is parsed at runtime into a Cogl  │
   │  snippet. cogl_sampler0 = the blurred texture.        │
   │  Applies refraction / chromatic aberration / rim      │
   │  lighting / shadow, then draws into screenFb (the     │
   │  on-screen framebuffer Clutter has prepared).          │
   └─────────────────────────────────────────────────────┘

 The texture pool is rebuilt whenever the resolution changes.
 Cogl pipelines are compiled once on the first frame and reused after that.

─────────────────────────────────────────────────────────────────────────────

 RENDERING MODEL — READ THIS BEFORE CHANGING ANY DRAWING CODE

 Every pass in this effect is issued as a Clutter PAINT NODE. None of it may
 be drawn with Cogl's immediate-mode API. This is not a style preference; it
 is the fix for a long-standing bug, and reverting it silently reintroduces
 that bug. Four traps are involved, all of them found the hard way.

 ── Trap 1: paint_target runs BEFORE the capture exists ─────────────────────

 Clutter paints in two phases: it BUILDS a ClutterPaintNode tree, then
 EXECUTES it. ClutterOffscreenEffect adds a LayerNode that renders the actor
 into the capture texture, and that node runs in the EXECUTE phase — but
 vfunc_paint_target() is called during the BUILD phase, when the node has
 only been added to the tree. So at the moment paint_target runs,
 get_texture() still holds the PREVIOUS frame's content.

 Immediate-mode drawing (draw_textured_rectangle + flush) executes right
 there, in the build phase, and therefore samples that stale capture. That
 was the cause of the "background inside the window lags one frame behind
 while dragging" bug. Clutter's own default paint_target implementation adds
 nodes rather than drawing, precisely for this reason.

 Drawing straight to the screen framebuffer APPEARED to work, but only by
 accident: Cogl journals those draws and flushes them later, by which time
 the capture has landed. It is not a guarantee. Adding a single flush()
 after such a draw reproduced the identical one-frame lag with no
 intermediate framebuffer involved at all — that experiment is what finally
 identified the cause. Do not rely on it.

 ── Trap 2: deferred passes cannot share a Cogl pipeline ────────────────────

 With immediate drawing, "set uniforms, draw, overwrite uniforms for the
 next pass" worked. Nodes execute after paint_target returns, so a shared
 pipeline means every pass draws with whatever the LAST pass left behind.
 Each pass gets its own copy via _passPipeline().

 ── Trap 3: deferred passes must form an acyclic framebuffer graph ──────────

 With immediate drawing, ping-ponging between framebuffers was harmless.
 Deferred nodes make Cogl build a real dependency graph, and ping-ponging is
 a CYCLE in it (e.g. Gaussian: temp reads blur0, then blur0 reads temp).
 Cogl rejects the dependency with
   "_cogl_framebuffer_add_dependency: assertion '!find_cycle (...)' failed"
 and the passes lose their ordering, so the composite samples a
 never-written blur texture. On screen: a flat tint with no background in it,
 while rim lighting (which does not read the blur layer) still works.

 Hence the separate _upTextures/_upFbos output targets: no pass ever writes
 into a framebuffer that an earlier pass read from.

 ── Trap 4: add_multitexture_rectangle() segfaults the shell ────────────────

 Clutter.PaintNode.add_multitexture_rectangle() has a broken introspection
 annotation on this stack: text_coords is exposed as a plain `number`
 instead of an array, so passing an array makes the native side read a JS
 object as a float pointer -> SIGSEGV. The TypeScript error it produces is
 CORRECT and must not be silenced with a cast.

 (Cogl.Framebuffer.draw_multitextured_rectangle IS annotated correctly, so
 the two are easy to confuse.)

 Consequence: all composite layers must share one UV range, which is why the
 capture's padding is removed by a crop pass instead of by per-layer UVs.

─────────────────────────────────────────────────────────────────────────────

## Paint counters

── [DIAG] Black-background investigation ──
Tracks whether/how often vfunc_paint_target actually gets invoked by
Clutter for this instance, and whether it ever renders a frame that
doesn't fall back to super.vfunc_paint_target() (i.e. an actual glass
composite). If this instance's window is showing the black-background
bug and _diagPaintCount never advances (or never reaches "composited"),
that's direct evidence Clutter is skipping/culling this actor's paint
entirely rather than the content being wrong.

## Diagnostic cost

[PERF] Mirrors the glass-debug-diagnostics GSettings key. Everything the
block above describes used to run unconditionally on every paint,
including a closure that walked get_actor().get_meta_window().get_title()
for a string that is thrown away unless logging is on, and a fresh
_diagLast object built with .map()/.toFixed(). That is per paint, per
glass surface, and paint runs more than once per frame per surface.

Kept separate from output-logs on purpose: someone turning logging on to
read a message should not silently take on per-paint diagnostic work.

## Same-frame reuse

[PERF] Frame serial of the paint that last ran this instance's blur chain.
A paint carrying the same serial is a repeat within one frame — see the
frameSerial comment above.

Keying on the serial ALONE is deliberate. An earlier attempt also compared
the paint context's framebuffer, on the theory that a nested clone paint
would share the real paint's framebuffer; it does not, and that mistake
silently disabled the whole optimization (measured: blurSkips 0 across the
board). ClutterActorNode's draw handler calls clutter_actor_continue_paint()
during the EXECUTION phase, by which point the enclosing LayerNode has
pushed its offscreen — so a nested paint sees that offscreen, not the
stage view's framebuffer.

That same fact gives the reuse its ordering guarantee, and it is stronger
than "clones paint after their source": the stage's node tree is BUILT
completely and only then executed, and an effect's own paint_target runs
during the build. So within one stage paint every real paint_target
happens before every nested one, and the pool is always written before a
repeat reads it.

## Nested glass invalidation

Bumped every time Clutter re-renders this effect's offscreen, i.e. every
time the capture actually changes rather than being blitted from cache.

This is the signal the nested-glass repair needs. A glass whose capture
contains a clone of a window that owns a glass of its own gets its
capture blanked at the moment that INNER effect re-renders its own
offscreen — measured 2026-09-16: a static inner glass never triggers it
(0/14 black frames), an inner glass that keeps re-rendering does
(11/14), and once blanked the outer capture stays blank until something
marks the outer actor dirty again. Counting re-renders here is what lets
ApplicationManager notice an inner re-render and repair the outer.

## Paint logging

── [DIAG] Black-background investigation ──────────────────────────────
If Clutter culls/skips this actor entirely (e.g. because it decides
it's fully occluded by the window content painted above it), this
function never runs at all -- which would show up here as a call count
that never advances past whatever it was when the window opened, even
though _frameTick keeps calling set_size()/queue_redraw() at 60fps.

[PERF] The counter itself is one increment and stays unconditional so
dump()'s "paints" figure remains exact. Everything below it — a
monotonic-time read and a closure that resolves the window title — is
gated: the title is only ever used inside a log line that the logger
discards unless output-logs is on, yet it was being built on every
paint of every glass surface regardless.

## Frame ordering

── [PERF] Is this a repeat paint of the same frame? ───────────────────
See frameSerial. The frame's FIRST paint of this instance runs the
whole chain; the repeats reuse what it produced.

Correctness rests on two facts:

  1. The input is identical. Every paint of this instance in this frame
     renders the same actor subtree into the same capture texture, so
     the blur of it cannot differ.
  2. The first paint's nodes execute first. Paint nodes run in tree
     order, and a Clutter.Clone is always painted after its source (the
     dock sits above the windows it clones; a window sits above the
     windows below it). So the pool is written before any repeat reads
     it — the reuse is same-frame, not last-frame, and a change in what
     is behind the glass shows up with zero frames of delay.
Retried here rather than only in _init(): an effect can be constructed
before global.stage is reachable, and one failed attempt must not
disable the optimization for the rest of the session.

## Capture padding

── Handle the capture's padding ────────────────────────────────────────

get_texture() is sized to the actor's PAINT BOX, not its allocation, so
it carries a few pixels of padding (measured: 964x563 capture for a
961x560 actor). computeCaptureLayout() derives exactly where the actor's own
pixels sit inside that padded texture, and where the composite quad has
to be drawn so it lands back on the actor. See that function (utils.ts)
for why the padding is NOT centred and why the draw rect is not
(0, 0, w, h).
The capture itself, padding and all. Nothing copies it any more; every
consumer works on it directly and sampling is confined to the valid
sub-rect by srcUV below.

## Nested blur origin

[FIX] Publish where the actor's own pixels start inside the capture.

ClutterOffscreenEffect sizes its offscreen to the actor's PAINT BOX,
which mutter enlarges by a fixed 3px (2 on the left/top, 1 on the
right/bottom — see computeCaptureLayout and memo.md's first addendum).
So actor-local (0, 0) is NOT texel (0, 0) of the framebuffer everything
inside this effect draws into; it is texel (dest[0], dest[1]).

That matters to anything inside our subtree that samples the
FRAMEBUFFER by stage coordinates rather than by its own — which is
exactly what a background-mode blur does. Without this correction such
an effect reads a region shifted up and to the left, whose first rows
are the cleared padding, and a blur then smears that transparency down
over its whole radius. See UILayerSampler._syncBmsReplica().

## Shared sampling coordinates

[PERF] When the crop is off. It used to copy the capture into a
padding-free texture of its own, at FULL resolution, once per paint per
glass surface — 1920x1080 for every full-screen surface.

Its only purpose was to make the composite's two layers agree on a
texture-coordinate range. Layer 1 (a pool texture) is padding-free and
wants 0..1; layer 0 (the raw capture) carries the padding
ClutterOffscreenEffect adds and wants the sub-rect. One
add_texture_rectangle() carries a single range, and the per-layer
variant (add_multitexture_rectangle) is not safely callable from GJS —
its annotation types the coordinate array as a bare number, and passing
an array through it segfaults the shell (memo.md 6.1). So the crop
existed to erase the difference.

The difference can be erased for free instead: glass.frag samples ONLY
cogl_sampler1, so layer 0's contents are irrelevant, and binding the
blur result to BOTH layers makes one range correct for both. The blur
chain never needed the crop either — its first pass already samples the
capture over srcUV (see _runGaussianBlur / _runDualKawaseBlur).

This is not a new code path: it is the one A1's reuse case has been
taking for the majority of paints, verified on hardware.

## Composite destination

─────────────────────────────────────────────────────────────────────
Final pass: glass composite.
  Binds _blurTextures[0] (blurred, w/2 × h/2) as cogl_sampler0 and runs
  glass.frag (refraction / rim lighting / shadow) to draw onto the screen.

  Clutter has already set up the actor's model-view transform on
  screenFb — but with the capture's FBO offset folded in, so this
  space is measured in capture TEXELS from the texture's top-left
  corner, not in actor-local pixels from the actor's. The rect to draw
  is therefore layout.dest, not (0, 0, effectiveW, effectiveH); see
  computeCaptureLayout() in utils.ts.
─────────────────────────────────────────────────────────────────────

## Composite layers

[PERF] Both layers are bound to the SAME texture so that one
texture-coordinate range is correct for both — see the note where the
crop pass used to be. Whenever a blur exists that is the blur result
(0..1); with blur disabled it is the raw capture (srcUV).

Sound only because glass.frag samples cogl_sampler1 and never
cogl_sampler0. If a future revision starts reading layer 0 as "the
sharp capture", it needs its own coordinate range again, and that means
either bringing the crop back or finding a working per-layer
coordinate call.

## Premultiplied opacity

[FIX] Feed the actor's real, cascaded paint opacity into the pipeline
color used for the final draw. glass.frag's very last line already
does `cogl_color_out = vec4(finalRgb, finalAlpha) * cogl_color_in;`
— i.e. it was ALWAYS ready to respect the actor's opacity — but
nothing on the JS/Cogl side was ever setting this pipeline's color,
so Cogl defaulted it to opaque white (255,255,255,255) and that
multiply was a permanent no-op. get_paint_opacity() (rather than the
actor's own local .opacity) is used because it already returns the
value cascaded through the actor's ancestors, so a child of an
animating windowActor fades correctly without any extra plumbing.

IMPORTANT — this must be (op, op, op, op), NOT (255, 255, 255, op):
finalRgb is already PREMULTIPLIED by the shape's own alpha (see
`finalRgb = litColor * alpha + shadowColor * shadowContribution`
above). Fading premultiplied color by an additional opacity factor
requires scaling BOTH the color and the alpha by that same factor —
`vec4(finalRgb, finalAlpha) * vec4(1,1,1,op)` only scales alpha and
leaves finalRgb at full brightness, which breaks the premultiplied
invariant (rgb should never exceed alpha) and — combined with the
ADD-based premultiplied blend function above — reads as abnormally
bright/washed-out at any opacity below 255, exactly matching the
"glass looks way too bright while the window is fading" symptom seen
during open/close animations. Scaling all four channels by the same
factor keeps it correctly premultiplied at every opacity level.

## Composite clipping

[FIX round 10] The push_matrix()/pop_matrix() pair that used to wrap
this draw is gone: nothing modified the matrix between them (so it was
already a no-op), and now that the draw is queued as a node rather than
issued here, bracketing immediate framebuffer state around it would not
affect it anyway. The node inherits the actor's model-view transform
from the paint context at execution time, which is what positions it.
[FIX round 13] The draw rect is layout.dest, NOT (0, 0, w, h).
vfunc_paint_target runs inside the transform node ClutterOffscreenEffect
wraps around it, whose translation is the capture's own FBO offset —
i.e. the coordinate space here has its origin at the capture texture's
top-left corner, not at the actor's. Drawing at (0, 0) therefore put
the whole glass ~2-3px up and to the left of the actor. See
computeCaptureLayout() in utils.ts for how the correct rect is derived.
[PERF] Draw only the part of the quad that can be non-transparent.

The rect is in the shader's coordinate space, and the quad is in
capture-texel space; the two are related by layout.dest. `uv` doubles
as the shader's notion of "where am I in the actor"
(`pixel_coord = uv * resolution`), so the sub-range handed to the draw
has to be interpolated with `resolution` as the denominator, or
pixel_coord would no longer agree with where the quad actually lands.
That is only exactly true when the two spaces coincide, so the rect is
dropped unless they do — a sub-pixel disagreement here is a visible
clip, not a sampling error.

## Diagnostic snapshots

[DIAG] "Blur is not visible — the background inside the glass stays
sharp — but changing the blur radius does change the look, and
refraction works." glass.frag reads ONLY cogl_sampler1 for the body
(cogl_sampler0 and blur_strength are declared but unused), so a sharp
body means layer 1 is bound to something sharp — which happens exactly
when _blurResultTex is null and the fallback below binds the raw
capture. This records the state that decides it, per instance, for
global._lgGlass.dump().

[PERF] Two allocations for the arrays, one for the object, four
toFixed() strings, two get_width()/get_height() round trips and a
closure — per paint, per glass surface. With diagnostics off this is
throttled to roughly once a second instead of being dropped entirely,
so dump() still answers (very slightly stale) without anyone having to
enable a setting first and reproduce the problem again.

## Repaint batching

[PERF] Batches every queue_repaint() call made between beginBatch()
and endBatch() into at most one. _syncState() in applicationManager.ts
calls roughly a dozen individual setXxx() methods per window per
frame — several of them (see setSurfaceLightEnabled, setMultiRegionMode
above, and others below) each call queue_repaint() independently, so a
single frame's worth of updates for one window was queuing that many
separate repaint requests. Clutter itself coalesces same-frame
queue_redraw()s on a plain actor, but queue_repaint() is Clutter.Effect
API with its own per-call bookkeeping (walking to the effect's actor
and invalidating it), so the per-call overhead here was real, not just
theoretical — this was the direct cause the FPS counter's rising
average frame time pointed at.
