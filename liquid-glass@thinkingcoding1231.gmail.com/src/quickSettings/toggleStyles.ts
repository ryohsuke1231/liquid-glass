import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import type { Logger } from '../logger.js';

/** Owns adopted toggle styles, their native colours and sampling lifetime. */
export class ToggleStyles {
  constructor(private _logger: Logger, private _isOpen: () => boolean) {}

  sync(root: Clutter.Actor): Clutter.Actor[] {
    const toggles = this._findAllToggleContainers(root);
    this._ensureToggleStyles(toggles);
    return toggles;
  }

  colorFor(actor: Clutter.Actor): { readonly baseColor: readonly number[]; readonly baseAlpha: number } | undefined {
    return this._toggleRegions.get(actor);
  }

  resetDiagnostics(): void {
    this._debugToggleColorLogFrames = 15;
  }


  // How often each pod's own (base) color is re-read from its live theme
  // node. This is what makes a toggle's glass follow its ON/OFF and hover
  // state, so it is felt directly as "how quickly the glass reacts".
  //
  // [PERF] Lowered from 400ms to 100ms. The naive version of that would have
  // quadrupled a genuinely expensive pass (see stateKey on _toggleRegions),
  // so the pass now short-circuits on pods whose style state is unchanged;
  // in the steady state — nothing hovered, nothing toggled — a tick costs a
  // handful of pseudo-class reads and no style invalidation at all.
  private static readonly TOGGLE_COLOR_SAMPLE_MS = 100;


  // Every Nth pass ignores that short-circuit and re-samples unconditionally,
  // catching color changes that leave the pseudo-classes untouched — a
  // gnome-shell theme switch above all, which repaints every pod (and can
  // flip whether a `.quick-slider` is a glass pod at all — see
  // _resampleToggleColors()) without any state change to notice. 8 × 100ms
  // keeps that worst case at ~800ms, roughly where the old flat 400ms
  // cadence already put it.
  private static readonly TOGGLE_COLOR_FULL_PASS_EVERY = 8;


  // Per-toggle-pod tracked state: the sampled background color of the pod's
  // "primary" button (used for tinting; re-sampled periodically since it
  // changes with ON/OFF and hover state), plus the list of every actor
  // inside the pod whose own background we've forced transparent, along
  // with each one's original inline style (to restore on cleanup).
  //
  // A "pod" is either a standalone `.quick-toggle` button (e.g. Night
  // Light, Do Not Disturb — styledSubs has exactly one entry, the button
  // itself) or a `.quick-toggle-has-menu` wrapper (split toggles like
  // Wi-Fi/Bluetooth that have a separate arrow/expand button beside the
  // main button — styledSubs has one entry per interactive child: the main
  // `.quick-toggle` button, the `.quick-toggle-separator` line, and the
  // `.quick-toggle-menu-button` arrow). See _findAllToggleContainers() and
  // _getStylableSubActors() below.
  private _toggleRegions: Map<Clutter.Actor, {
    destroyId: number;
    baseColor: [number, number, number];
    // [FIX] mactahoe theme: has-menu pods (Wi-Fi/Bluetooth) render their
    // visible pill background on the `.quick-toggle-has-menu` WRAPPER, while
    // Adwaita renders it on the inner `.quick-toggle` button instead (see
    // _samplePodColor() below). We used to sample only the inner button and
    // trust its RGB unconditionally — under mactahoe that button reports
    // rgba(0,0,0,0.00) (a fully transparent black), and since only the RGB
    // was kept (never the alpha), baseColor became a "real" opaque black,
    // which the tint blend below then painted solidly over the whole pod.
    // baseAlpha now records how much we should actually trust baseColor;
    // a near-zero alpha means "this sample carries no real color" and the
    // previous baseColor is kept instead of being overwritten with noise.
    baseAlpha: number;
    styledSubs: { actor: Clutter.Actor; origStyle: string }[];
    // [PERF] Snapshot of every style pseudo-class that can change this pod's
    // color (checked / hover / active / insensitive / focus / selected),
    // across the same actors _samplePodColor() looks at. Re-sampling means
    // briefly lifting our transparency override off the pod's whole subtree
    // and putting it back, which dirties every one of those widgets' style —
    // affordable at the old 400ms cadence, wasteful at 100ms. When this key
    // is unchanged since the last pass, the theme node would resolve to the
    // very same color, so the whole restore/sample/re-apply dance is skipped.
    // See _podStateKey() and _resampleToggleColors().
    stateKey: string;
  }> = new Map();

  private _toggleColorTimerId: number = 0;

  // [PERF] Counts _resampleToggleColors() passes so every Nth one can ignore
  // the stateKey short-circuit above — a theme change repaints every pod
  // without touching a single pseudo-class, so state alone can't be trusted
  // as the only trigger. See TOGGLE_COLOR_FULL_PASS_EVERY.
  private _resamplePassCount: number = 0;

  // [FIX] Arms _resampleToggleColors()'s diagnostic logging for the next
  // N calls (see there) — decremented once per call, so N * 400ms of
  // logging. Re-armed each time _applyToggleEffect() runs, so
  // disabling/re-enabling Quick Settings' Toggles mode (or the whole
  // extension) gets a fresh logging window.
  private _debugToggleColorLogFrames: number = 15;


  // Discovers the top-level toggle "pods" under `actor`. A pod is either:
  //
  //  - a `.quick-toggle-has-menu` wrapper: GNOME's split/menu toggles
  //    (Wi-Fi, Bluetooth, ...) are actually THREE siblings under this
  //    wrapper — the main `.quick-toggle` button, a `.quick-toggle-separator`
  //    divider line, and a separate `.quick-toggle-menu-button` arrow/expand
  //    button (confirmed via Looking Glass actor-tree probe: the wrapper's
  //    own bounding box, e.g. 176×48, exactly equals the sum of the main
  //    button (139) + separator (1) + arrow button (36)). The arrow button
  //    does NOT carry the `quick-toggle` class itself, so it was previously
  //    invisible to this traversal entirely, and its own background color
  //    (which — unlike the main button's — genuinely does swing between a
  //    dim, low-contrast gray when off/unchecked and a solid, high-contrast
  //    accent color when checked) was never neutralized. That is what
  //    produced BOTH the "glass only covers the left half" artifact and the
  //    "glass strength inversely tracks the toggle's own background" one:
  //    they're the same untouched element. We now detect the WRAPPER itself
  //    as the pod (checked before the plain `.quick-toggle` case below, so
  //    its inner main button is never also collected as a second, separate
  //    region) and treat its full bounding box as one glass shape.
  //
  //  - a standalone `.quick-toggle` button with no such wrapper (Night
  //    Light, Dark Style, Do Not Disturb, ...).
  //
  //  - [EXTEND] one of the SystemItem action buttons: the screenshot,
  //    settings, lock and shutdown buttons that sit in the row above the
  //    sliders. In the actor tree they are ScreenshotItem / SettingsItem /
  //    LockItem / ShutdownItem, all plain `.icon-button` St.Buttons parented
  //    (at some depth) by the `.quick-settings-system-item` widget, and both
  //    themes give them a real pill background of their own (Adwaita
  //    #48484b, mactahoe rgba(255,255,255,.15)) — i.e. exactly the same
  //    "solid chip that should become glass" shape as a quick toggle.
  //
  //    The `.icon-button` class alone is NOT a sufficient test: the sliders'
  //    mute/level buttons carry `icon-button flat`, a split toggle's arrow
  //    carries `quick-toggle-menu-button icon-button`, and the keyboard
  //    brightness submenu's level buttons carry a bare `icon-button` too.
  //    Descent therefore only treats `.icon-button` as a pod once it is
  //    inside a `.quick-settings-system-item` subtree (tracked by the
  //    `inSystemItem` flag below), which is precisely the four buttons above
  //    — the toggle arrows are unreachable anyway, since a matched toggle
  //    pod is never descended into.
  //
  //  - [EXTEND] a `.quick-slider` row (volume / input / brightness) — but
  //    ONLY on themes that actually paint a pill around it. mactahoe wraps
  //    the volume bar in a rgba(255,255,255,.15) rounded container (the
  //    thing the user sees "surrounding" the slider); Adwaita paints nothing
  //    there at all (`ThemeColor:#00000000`), and putting a glass chip
  //    behind a slider that has no container of its own would invent a
  //    surface the theme never had. So the decision is made from the live
  //    theme node rather than from a theme name — see _paintsOwnBackground().
  //
  //    A `.quick-slider` is never descended into either way, so on Adwaita
  //    its inner `icon-button flat` mute buttons stay untouched rather than
  //    becoming four stray chips.
  //
  // In every case this does NOT descend into a matched pod's children — the
  // whole pod is treated as one shape; see _getStylableSubActors() for how
  // its interactive children get their backgrounds neutralized.
  private _findAllToggleContainers(
    actor: Clutter.Actor,
    found: Clutter.Actor[] = [],
    inSystemItem: boolean = false
  ): Clutter.Actor[] {
    if (!actor) return found;

    let isHasMenuPod = actor instanceof St.Widget && actor.has_style_class_name('quick-toggle-has-menu');
    if (isHasMenuPod) {
      if (actor.visible) found.push(actor);
      return found;
    }

    let isToggle = actor instanceof St.Widget && actor.has_style_class_name('quick-toggle');
    if (isToggle) {
      if (actor.visible) found.push(actor);
      return found;
    }

    // [EXTEND] Screenshot / Settings / Lock / Shutdown.
    if (inSystemItem && actor instanceof St.Widget && actor.has_style_class_name('icon-button')) {
      if (actor.visible) found.push(actor);
      return found;
    }

    // [EXTEND] The slider's surrounding container, on themes that draw one.
    if (actor instanceof St.Widget && actor.has_style_class_name('quick-slider')) {
      if (actor.visible && this._paintsOwnBackground(actor)) found.push(actor);
      return found;
    }

    let entersSystemItem = inSystemItem ||
      (actor instanceof St.Widget && actor.has_style_class_name('quick-settings-system-item'));

    let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
    for (let child of children) this._findAllToggleContainers(child, found, entersSystemItem);
    return found;
  }


  // [EXTEND] "Does this widget paint a background of its OWN?" — used to
  // decide whether a `.quick-slider` row is a glass pod (mactahoe: yes, it
  // has a visible rgba(255,255,255,.15) container; Adwaita: no, the row is
  // bare and only its children paint).
  //
  // The `_toggleRegions` check first is essential, not an optimization: once
  // a pod has been adopted, _ensureToggleStyles() forces
  // `background-color: transparent !important` onto its whole subtree, and
  // the theme node reflects that inline override — so re-asking this question
  // here on the next frame would read back OUR OWN transparency and un-adopt
  // the pod, making it flicker in and out of the region set every frame.
  //
  // [EXTEND-FIX] An adopted pod therefore keeps its verdict as far as THIS
  // function is concerned, but the verdict is no longer permanent: it is
  // re-checked by _resampleToggleColors(), in the one moment per pass where
  // the override is lifted and the pod's real theme is readable again, and a
  // slider that stopped painting its own pill is released there. Pinning it
  // forever is what let a slider adopted under mactahoe stay glassed after
  // switching to Adwaita — see the comment at that check for the full story.
  private _paintsOwnBackground(actor: Clutter.Actor): boolean {
    if (this._toggleRegions.has(actor)) return true;
    let bg = this._readThemeBg(actor);
    return !!(bg && bg.a > 0.02);
  }


  // Returns every St.Widget descendant of a pod (the pod itself, plus its
  // icon/title/subtitle/separator/menu-button children, at any depth).
  //
  // This used to special-case `.quick-toggle-has-menu` by class name and
  // only return its direct children — but a fresh Looking-Glass probe still
  // showed the Wi-Fi pod's main button (139×48, checked=true) with an
  // empty inlineStyle even after that fix, while the region/glass geometry
  // for the SAME pod was confirmed correct — meaning class-name-based
  // detection was silently missing this pod's children for a reason not
  // yet root-caused (possibly a GNOME-version difference in exact
  // structure/class names). Rather than keep guessing specific class
  // names, this walks the ENTIRE subtree unconditionally: every St.Widget
  // under the pod gets the transparent-background override — harmless for
  // icons/labels (which already paint no background of their own) and
  // robust to whatever internal structure GNOME actually uses, since it no
  // longer depends on matching a specific class string at all.
  private _getStylableSubActors(pod: Clutter.Actor): Clutter.Actor[] {
    const found: Clutter.Actor[] = [];
    const walk = (actor: Clutter.Actor) => {
      if (actor instanceof St.Widget) found.push(actor);
      let children = typeof (actor as any).get_children === 'function' ? (actor as any).get_children() : [];
      for (let child of children) walk(child);
    };
    walk(pod);
    return found;
  }


  // Returns the sub-actor whose color should represent the pod for tinting
  // purposes — the main `.quick-toggle` button (the one whose color
  // genuinely reflects ON/OFF state), not the separator or arrow button.
  //
  // [FIX] "Wi-Fi/Bluetooth tint never changes with ON/OFF state, unlike
  // standalone toggles" — root-caused via the [toggle-color] diagnostic
  // log: for has-menu pods, this returned `pod` itself (the WRAPPER) as
  // `primary`, meaning every sample just read back OUR OWN transparent
  // override on the wrapper's own background (rgba(0,0,0,0.00) — see
  // _getStylableSubActors(), which forces every St.Widget in the pod's
  // subtree transparent, wrapper included) rather than any real
  // checked-state color. That happened because this only checked DIRECT
  // children for `.quick-toggle` — a separate Looking Glass probe (a
  // full recursive walk) found the real main button (style class
  // "quick-toggle button") existing further down, not as a direct child
  // of the wrapper. Searching the whole subtree (excluding `pod` itself,
  // so a has-menu pod can never trivially "match itself") fixes this
  // regardless of how many levels of wrapping GNOME actually uses.
  private _getPrimaryToggleButton(pod: Clutter.Actor): Clutter.Actor {
    if (pod instanceof St.Widget && pod.has_style_class_name('quick-toggle-has-menu')) {
      let found: Clutter.Actor | null = null;
      const search = (actor: Clutter.Actor) => {
        if (found) return;
        let children = typeof (actor as any).get_children === 'function' ? (actor as any).get_children() : [];
        for (let child of children) {
          if (found) return;
          if (child instanceof St.Widget && child.has_style_class_name('quick-toggle')) {
            found = child;
            return;
          }
          search(child);
        }
      };
      search(pod);
      if (found) return found;
    }
    return pod;
  }


  // Returns every `.quick-toggle-icon` widget under `root`. Some themes put
  // a toggle's ON/OFF color on this chip rather than on the button or the
  // has-menu wrapper — see _samplePodColor() for the concrete CSS.
  private _getToggleIconActors(root: Clutter.Actor): Clutter.Actor[] {
    const found: Clutter.Actor[] = [];
    const walk = (actor: Clutter.Actor) => {
      if (actor instanceof St.Widget && actor.has_style_class_name('quick-toggle-icon')) {
        found.push(actor);
      }
      let children = typeof (actor as any).get_children === 'function' ? (actor as any).get_children() : [];
      for (let child of children) walk(child);
    };
    if (root) walk(root);
    return found;
  }


  // [FIX] Reads a theme-node background color as normalized {r,g,b,a}
  // (0..1), or null if the actor can't be sampled at all. Used by
  // _samplePodColor() so alpha is never silently discarded.
  //
  // [FIX-7] Also falls back to the theme node's background GRADIENT when the
  // flat background-color is fully transparent. St resolves
  // `background-gradient-start`/`-end` into a separate property, so a theme
  // that paints a pod with a gradient reports background-color rgba(0,0,0,0)
  // — indistinguishable, to the old code, from a pod that paints nothing at
  // all, and the "black" the user could see the tint drifting towards. The
  // gradient's two stops averaged is a fair single representative color for
  // tinting purposes (the glass chip gets one flat tint per region anyway).
  private _readThemeBg(actor: Clutter.Actor | null): { r: number; g: number; b: number; a: number } | null {
    if (!(actor instanceof St.Widget)) return null;
    actor.ensure_style();
    let themeNode = actor.get_theme_node();
    if (!themeNode) return null;

    let bg = themeNode.get_background_color();
    if (bg && bg.alpha / 255 > 0.02)
      return { r: bg.red / 255, g: bg.green / 255, b: bg.blue / 255, a: bg.alpha / 255 };

    try {
      let [gradType, start, end] = themeNode.get_background_gradient();
      if (gradType !== St.GradientType.NONE && start && end) {
        let a = ((start.alpha + end.alpha) / 2) / 255;
        if (a > 0.02) {
          return {
            r: ((start.red + end.red) / 2) / 255,
            g: ((start.green + end.green) / 2) / 255,
            b: ((start.blue + end.blue) / 2) / 255,
            a,
          };
        }
      }
    } catch (e) {
      // Older/newer St without the gradient getter — the flat color below
      // is still a valid answer, just a transparent one.
    }

    if (!bg) return null;
    return { r: bg.red / 255, g: bg.green / 255, b: bg.blue / 255, a: bg.alpha / 255 };
  }


  // [FIX-7] Composites `actor`'s own background over its ancestors' until the
  // stack is opaque (or the walk runs out), i.e. resolves what a viewer
  // ACTUALLY sees at that actor's position.
  //
  // Why this is needed: a fully transparent background-color still carries
  // RGB, and CSS engines overwhelmingly leave that RGB at black — mactahoe's
  // `.quick-toggle-has-menu .quick-toggle { background: none }` reports
  // rgba(0,0,0,0.00), and Adwaita does the same for anything unstyled. Any
  // code path that reads such a sample and keeps its RGB is reading black
  // that the theme never intended to paint. Compositing over the ancestry
  // replaces that meaningless black with the color genuinely visible there
  // (for mactahoe: the pod's own translucent white sheen over
  // `.popup-menu-content`'s rgba(36,36,36,0.92)), so the tint calculation
  // always works from a real color.
  //
  // Returns the composited color plus `a` — the accumulated coverage, which
  // is 1.0 once an opaque ancestor was reached and less when the whole stack
  // really is see-through.
  private _compositeOverAncestors(
    actor: Clutter.Actor | null,
    own: { r: number; g: number; b: number; a: number } | null
  ): { r: number; g: number; b: number; a: number } {
    // Standard "source-over" accumulation, front to back: each layer further
    // back only contributes through whatever transparency is left above it.
    let outR = 0, outG = 0, outB = 0, outA = 0;

    const add = (c: { r: number; g: number; b: number; a: number } | null) => {
      if (!c || !(c.a > 0)) return;
      let w = c.a * (1 - outA);
      outR += c.r * w;
      outG += c.g * w;
      outB += c.b * w;
      outA += w;
    };

    add(own);

    let node: Clutter.Actor | null = actor ? actor.get_parent() : null;
    // The walk is bounded by the stage anyway; the counter is only a guard
    // against a pathologically deep (or cyclic, if something is very wrong)
    // actor tree being walked every sampling pass.
    let guard = 32;
    while (node && outA < 0.995 && guard-- > 0) {
      if (node instanceof St.Widget) add(this._readThemeBg(node));
      node = node.get_parent();
    }

    if (outA <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    // Un-premultiply so callers get a plain color plus a coverage figure.
    return { r: outR / outA, g: outG / outA, b: outB / outA, a: outA };
  }


  // [FIX] "Wi-Fi/Bluetooth glass renders solid black under mactahoe theme,
  // regardless of ON/OFF state". Root cause: for has-menu pods,
  // _getPrimaryToggleButton() always samples the inner `.quick-toggle`
  // button, which is correct for Adwaita (where THAT button carries the
  // real, opaque, checked-state color and the `.quick-toggle-has-menu`
  // wrapper itself stays transparent) — but mactahoe does the opposite: the
  // quick___.txt tree dump shows mactahoe's Wi-Fi/Bluetooth wrapper at
  // rgba(255,255,255,0.15) while its inner button is rgba(0,0,0,0.00) in
  // BOTH the checked and unchecked case. Sampling only the inner button
  // there always reads a fully transparent black, and because the caller
  // only kept the RGB (see baseAlpha comment above), that transparent black
  // was trusted as a real opaque color and painted solid.
  //
  // Fix: sample BOTH candidates (the resolved primary button, and — for
  // has-menu pods only — the wrapper itself) and keep whichever one is
  // actually painting something (higher alpha). If neither is painting
  // anything real, return alpha 0 so the caller knows not to trust the RGB.
  //
  // [FIX-7] "Under mactahoe the toggles' color comes back transparent, and
  // the tint then falls back to black." Confirmed against the theme's own
  // CSS: `.quick-toggle-has-menu .quick-toggle` is `background: none
  // !important` in EVERY state, so the primary button genuinely reports
  // rgba(0,0,0,0.00) — a transparent black whose RGB is an artifact of the
  // CSS engine, not a color the theme ever paints. The max-alpha pick above
  // already avoided trusting it whenever the wrapper painted something, but
  // it still returned that black verbatim whenever NO candidate painted
  // anything, and it still described a candidate's own translucent color as
  // if that color were what the eye sees.
  //
  // Both are now resolved through _compositeOverAncestors(), so the RGB
  // handed to the tint math is always a color that is genuinely visible at
  // the pod: the winning candidate's own paint composited over everything
  // behind it, or — when nothing in the pod paints at all — simply whatever
  // shows through from behind the pod (the panel), never black-by-default.
  //
  // [FIX-8] `a` is now simply the composited coverage — "how much real paint
  // did we actually find here" — and the caller only tests it against a noise
  // floor to decide whether a usable color was resolved at all. It is no
  // longer used to scale the tint: the strength of the base color is the
  // user's Base Color Strength slider alone, and the returned RGB is already
  // the color the pod genuinely composites to on screen, so weighting it a
  // second time by its own transparency would double-count.
  private _samplePodColor(pod: Clutter.Actor, primary: Clutter.Actor): { r: number; g: number; b: number; a: number } {
    let isHasMenu = pod instanceof St.Widget && pod.has_style_class_name('quick-toggle-has-menu');

    let candidates: Clutter.Actor[] = [primary];
    if (isHasMenu && pod !== primary) candidates.push(pod);
    // [FIX-9] "Under mactahoe the base color never changes with a toggle's
    // ON/OFF state, while the custom tint color works fine." Confirmed
    // against MacTahoe-Dark/gnome-shell/gnome-shell.css: for a has-menu pod
    // (Wi-Fi, Bluetooth) NEITHER of the two candidates above carries the
    // state at all —
    //
    //   .quick-toggle-has-menu          { background-color: rgba(255,255,255,.15) }
    //   .quick-toggle-has-menu:checked  { background-color: rgba(255,255,255,.15) }   ← identical
    //   .quick-toggle-has-menu .quick-toggle{,:hover,:active,:checked}
    //                                   { background: none !important }               ← always empty
    //
    // The only element that actually swings is the icon chip:
    //
    //   .quick-toggle-has-menu .quick-toggle .quick-toggle-icon          { rgba(255,255,255,.15) }
    //   .quick-toggle-has-menu .quick-toggle:checked .quick-toggle-icon  { white }
    //
    // so sampling the wrapper/button pair returns exactly the same color in
    // both states, which is what "the base color doesn't react to ON/OFF"
    // looks like. Adwaita puts the state on `.quick-toggle` itself (which is
    // why it has always worked there) and gives `.quick-toggle-icon` no
    // background at all, so adding the icon as a further candidate reads
    // alpha 0 there and can never displace the existing winner: the
    // max-alpha pick below breaks ties in favour of the EARLIER candidate.
    for (let icon of this._getToggleIconActors(pod !== primary ? primary : pod)) {
      if (icon !== primary && icon !== pod) candidates.push(icon);
    }

    let bestActor: Clutter.Actor | null = null;
    let bestOwn: { r: number; g: number; b: number; a: number } | null = null;
    for (let candidate of candidates) {
      let own = this._readThemeBg(candidate);
      if (!own) continue;
      if (!bestOwn || own.a > bestOwn.a) {
        bestOwn = own;
        bestActor = candidate;
      }
    }

    if (bestOwn && bestOwn.a > 0.02) {
      return this._compositeOverAncestors(bestActor, bestOwn);
    }

    // Nothing in the pod paints a background of its own — the pod's real
    // on-screen color is simply what shows through it. Composite from the
    // pod upwards (`own` = null) and report that as the color, with the
    // accumulated coverage as its alpha.
    return this._compositeOverAncestors(pod, null);
  }


  // Registers/maintains every toggle pod: samples the primary button's
  // color (for tinting) and forces the background of every CURRENT live
  // stylable sub-actor in the pod fully transparent.
  //
  // Unlike the original one-shot version, this re-derives each pod's
  // sub-actors and re-checks their OWN live style EVERY call (this
  // function runs every frame from _syncToggleRegions()), rather than
  // permanently marking a pod as "handled" the first time it's seen. A
  // second Looking-Glass probe run confirmed why the one-shot version
  // failed for split toggles: standalone `.quick-toggle` buttons kept
  // their `background-color: transparent !important;` override reliably,
  // but `.quick-toggle-has-menu` pods' inner button/menu-button stayed
  // PERMANENTLY un-styled (empty inlineStyle, native solid color) across
  // every sampled frame over several seconds — i.e. not a timing race,
  // but GNOME evidently replacing/rebuilding these pods' inner actors
  // (e.g. when connection state changes) with fresh, un-styled ones after
  // the pod was already marked "done". Checking each sub-actor's OWN
  // current style (rather than a cached per-pod flag) makes this
  // self-healing regardless of why a previously-styled actor stopped
  // being transparent.
  private _ensureToggleStyles(toggles: Clutter.Actor[]) {
    const OVERRIDE = 'background-color: transparent !important;';

    for (let pod of toggles) {
      if (!(pod instanceof St.Widget)) continue;

      let entry = this._toggleRegions.get(pod);
      if (!entry) {
        // [FIX] Default baseAlpha 0 means "no real sample yet" — a pod that
        // never manages to sample a real color falls through to the
        // caller's own neutral handling (see _syncToggleRegions()) instead
        // of an arbitrary hardcoded white ever being trusted as real.
        entry = { destroyId: 0, baseColor: [1.0, 1.0, 1.0], baseAlpha: 0, styledSubs: [], stateKey: '' };
        this._toggleRegions.set(pod, entry);
        entry.destroyId = pod.connect('destroy', () => {
          this._toggleRegions.delete(pod);
        });
      }

      let primary = this._getPrimaryToggleButton(pod);
      if (primary instanceof St.Widget) {
        // Sample from whatever the CURRENT inline style leaves as the
        // theme's own background — if we've already overridden it to
        // transparent, get_background_color() on this actor would just
        // report transparent, so only (re-)sample when it still looks
        // like a fresh, un-overridden actor.
        let curStyle = typeof primary.get_style === 'function' ? primary.get_style() : null;
        if (!curStyle || !curStyle.includes(OVERRIDE)) {
          let sampled = this._samplePodColor(pod, primary);
          // [FIX] Only trust this sample if it's actually painting
          // something (alpha above a small noise floor). A near-zero-alpha
          // read tells us nothing about the pod's real color — keep
          // whatever baseColor/baseAlpha we already had instead of
          // clobbering it with an effectively-random transparent RGB.
          if (sampled.a > 0.02) {
            entry.baseColor = [sampled.r, sampled.g, sampled.b];
            entry.baseAlpha = sampled.a;
          }
        }
      }

      let known = new Set(entry.styledSubs.map(s => s.actor));
      for (let sub of this._getStylableSubActors(pod)) {
        if (!(sub instanceof St.Widget)) continue;

        let style = typeof sub.get_style === 'function' ? sub.get_style() : null;
        if (style && style.includes(OVERRIDE)) continue; // already correctly overridden

        let origStyle = style || '';
        let newStyle = origStyle ? `${origStyle} ${OVERRIDE}` : OVERRIDE;
        sub.set_style(newStyle);

        if (!known.has(sub)) entry.styledSubs.push({ actor: sub, origStyle });
      }
    }
  }


  // Periodically re-samples each tracked pod's ORIGINAL color (it changes
  // with ON/OFF and hover state, e.g. Wi-Fi turning blue when enabled, or
  // its arrow/menu-button swinging between a dim gray and a solid accent
  // fill) by briefly restoring each sub-actor's original style, reading the
  // primary button's theme color, then re-applying the transparent override
  // to every sub-actor — same idiom as _updateSingleButtonAlpha() uses for
  // the Background-mode alpha-dim feature.
  //
  // [FIX] Investigating "has-menu pods (Wi-Fi/Bluetooth) don't reflect
  // their tint color, unlike standalone pods (DND/Dark Style)". Read
  // through _getPrimaryToggleButton()/the sampling logic here and in
  // _ensureToggleStyles() side by side and could not find an asymmetry
  // between the two pod shapes — both sample the same way, from the same
  // kind of actor (the inner `.quick-toggle` button either way). Logging
  // the actual sampled values (throttled to this method's own 400ms timer,
  // so it's not spammy) rather than guessing further — please share what
  // this prints for a has-menu pod (Wi-Fi/Bluetooth) vs a standalone one
  // (DND/Dark Style) next time this reproduces.
  private _resampleToggleColors() {
    // [PERF] See TOGGLE_COLOR_FULL_PASS_EVERY.
    let forceFull = (this._resamplePassCount++ % ToggleStyles.TOGGLE_COLOR_FULL_PASS_EVERY) === 0;

    for (const [pod, entry] of this._toggleRegions.entries()) {
      if (!pod) continue;

      let primary = this._getPrimaryToggleButton(pod);

      // [PERF] Nothing that can change this pod's color has changed since the
      // last pass, so its overrides are left exactly as they are — no style
      // invalidation, no theme-node resolution, no re-sample.
      let stateKey = this._podStateKey(pod, primary);
      if (!forceFull && stateKey === entry.stateKey) continue;
      entry.stateKey = stateKey;

      // Restore every sub-actor's original style first so the primary
      // button's sampled color reflects its real, un-overridden theme.
      for (const { actor, origStyle } of entry.styledSubs) {
        if (actor instanceof St.Widget) actor.set_style(origStyle || null);
      }

      // [EXTEND-FIX] "Adwaita でも音量バーにガラスが適用されてしまう."
      //
      // A `.quick-slider` only becomes a pod on themes that actually paint a
      // pill around it (mactahoe does, Adwaita does not) — but that verdict
      // was made once, from the live theme node, and then pinned for the
      // lifetime of the actor by _paintsOwnBackground()'s `_toggleRegions`
      // short-circuit. That short-circuit is unavoidable while our own
      // transparency override is in place (the theme node reports OUR
      // transparency, so re-asking would un-adopt the pod every frame and
      // make it flicker) — but it silently assumed a pod's theme never
      // changes under it.
      //
      // It does: switching the gnome-shell theme does NOT rebuild the
      // quick-settings actors, so the very same OutputStreamSlider adopted
      // under mactahoe stayed adopted after switching to Adwaita, glass and
      // all, with nothing left that could ever revoke it.
      //
      // Right here is the one moment per pass where the override is lifted
      // and the pod's REAL theme is readable again, so this is where the
      // verdict gets re-checked. A slider that no longer paints its own pill
      // is released outright: its original styles are already restored just
      // above, so simply dropping the entry (and skipping the re-apply below)
      // hands the actor back to the theme untouched. _findAllToggleContainers()
      // then re-reads the live theme node on the next frame — now finding a
      // bare Adwaita row — and stops emitting a region for it. The reverse
      // direction needs nothing extra: an unadopted slider is always judged
      // live, so switching back to mactahoe re-adopts it on the next frame.
      if (pod instanceof St.Widget && pod.has_style_class_name('quick-slider')) {
        let pill = this._readThemeBg(pod);
        if (!(pill && pill.a > 0.02)) {
          this._logger.log(
            `[Liquid Glass][toggle-color] releasing .quick-slider pod — theme no longer paints a pill ` +
            `(bg=${JSON.stringify(pill)})`
          );
          if (entry.destroyId) pod.disconnect(entry.destroyId);
          this._toggleRegions.delete(pod);
          continue;
        }
      }

      if (primary instanceof St.Widget) {
        let sampled = this._samplePodColor(pod, primary);
        if (sampled.a > 0.02) {
          entry.baseColor = [sampled.r, sampled.g, sampled.b];
          entry.baseAlpha = sampled.a;
        }

        if (this._debugToggleColorLogFrames > 0) {
          let isHasMenu = pod instanceof St.Widget && pod.has_style_class_name('quick-toggle-has-menu');
          let podCls = pod instanceof St.Widget && typeof pod.get_style_class_name === 'function' ? (pod.get_style_class_name() || '') : '';
          let primaryCls = typeof primary.get_style_class_name === 'function' ? (primary.get_style_class_name() || '') : '';
          let checked = typeof (primary as any).has_style_pseudo_class === 'function' ? (primary as any).has_style_pseudo_class('checked') : 'n/a';
          // [DEBUG] Also logs the wrapper's OWN background (for has-menu
          // pods) alongside the primary button's, and the raw sampled
          // alpha, since telling "a real transparent pod" apart from "a
          // theme that paints its color somewhere we're not looking yet"
          // requires seeing both candidates, not just the winner.
          let wrapperBg = isHasMenu ? this._readThemeBg(pod) : null;
          // [FIX-9] The icon chip is the only element some themes (mactahoe)
          // move the ON/OFF color onto — log it alongside the other two so a
          // "the base color never changes" report can be settled from the
          // journal alone.
          let iconBgs = this._getToggleIconActors(pod !== primary ? primary : pod)
            .map(a => JSON.stringify(this._readThemeBg(a))).join(' ');
          this._logger.log(
            `[Liquid Glass][toggle-color] pod class="${podCls}" isHasMenu=${isHasMenu} ` +
            `primary class="${primaryCls}" checked=${checked} ` +
            `primaryBg=${JSON.stringify(this._readThemeBg(primary))} ` +
            `wrapperBg=${wrapperBg ? JSON.stringify(wrapperBg) : 'n/a'} ` +
            `iconBg=[${iconBgs || 'none'}] ` +
            `chosen.a=${sampled.a.toFixed(2)} trusted=${sampled.a > 0.02} ` +
            `entry.baseColor=[${entry.baseColor.map(v => v.toFixed(2)).join(',')}] entry.baseAlpha=${entry.baseAlpha.toFixed(2)}`
          );
        }
      }

      for (const { actor, origStyle } of entry.styledSubs) {
        if (!(actor instanceof St.Widget)) continue;
        let newStyle = origStyle
          ? `${origStyle} background-color: transparent !important;`
          : `background-color: transparent !important;`;
        actor.set_style(newStyle);
      }
    }
    if (this._debugToggleColorLogFrames > 0) this._debugToggleColorLogFrames--;
  }


  start() {
    this._resampleToggleColors();
    if (this._toggleColorTimerId !== 0) return;

    this._toggleColorTimerId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT, ToggleStyles.TOGGLE_COLOR_SAMPLE_MS, () => {
      if (!this._isOpen()) {
        this._toggleColorTimerId = 0;
        return GLib.SOURCE_REMOVE;
      }
      this._resampleToggleColors();
      return GLib.SOURCE_CONTINUE;
    });
  }


  // [PERF] The pseudo-class fingerprint described on _toggleRegions.stateKey.
  // Covers exactly the actors _samplePodColor() can pick as its winner (the
  // pod, its primary button, and any `.quick-toggle-icon` chip), since a
  // state change anywhere else in the subtree cannot alter the sampled color.
  private _podStateKey(pod: Clutter.Actor, primary: Clutter.Actor): string {
    const STATES = ['checked', 'hover', 'active', 'insensitive', 'focus', 'selected'];

    let actors: Clutter.Actor[] = [pod];
    if (primary !== pod) actors.push(primary);
    for (let icon of this._getToggleIconActors(pod !== primary ? primary : pod)) actors.push(icon);

    let key = '';
    for (let actor of actors) {
      if (!(actor instanceof St.Widget) || typeof (actor as any).has_style_pseudo_class !== 'function') {
        key += '?|';
        continue;
      }
      for (let state of STATES) {
        key += (actor as any).has_style_pseudo_class(state) ? '1' : '0';
      }
      key += '|';
    }
    return key;
  }


  stop() {
    if (this._toggleColorTimerId !== 0) {
      GLib.source_remove(this._toggleColorTimerId);
      this._toggleColorTimerId = 0;
    }
  }


  // Restores every tracked pod's sub-actors to their original inline style
  // and forgets them.
  clear() {
    this.stop();
    for (const [pod, entry] of this._toggleRegions.entries()) {
      if (entry.destroyId) {
        try { pod.disconnect(entry.destroyId); } catch (_) { }
      }
      for (const { actor, origStyle } of entry.styledSubs) {
        if (actor instanceof St.Widget && typeof actor.set_style === 'function') {
          try { actor.set_style(origStyle || null); } catch (e) { }
        }
      }
    }
    this._toggleRegions.clear();
  }
}
