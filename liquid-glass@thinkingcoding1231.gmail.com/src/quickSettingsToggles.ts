import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Cogl from 'gi://Cogl';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';

import type { Logger } from './logger.js';
import {
  QS_MENU_TOGGLE_CLASS, offscreenFormat, paintNodeWithContext, setUniformVector, uniformDeclarations
} from './shellVersion.js';
import {
  GlassActor, type GlassActorParams, StageCopier, addBlit, createTarget, isPaintingView, RelaySet,
  localToStage
} from './rendering/backdropGlass.js';
import { configureSamplerLayer } from './rendering/pipelines.js';
import { setTranslationIfChanged, setScaleIfChanged, isActorValid } from './actors.js';

// Quick Settings' toggle-button mode: every toggle pod gets its own piece of
// glass. This finds the pods, samples each pod's own color (it changes with
// ON/OFF and hover) for the glass's base color, and makes the pod's own
// backgrounds transparent so the glass shows through.

const TRANSPARENT_OVERRIDE = 'background-color: transparent !important;';

type ToggleEntry = {
  destroyId: number;
  baseColor: [number, number, number];
  // How much real paint the sample found; near zero means the sample carries
  // no color and baseColor keeps its previous value.
  baseAlpha: number;
  styledSubs: { actor: Clutter.Actor; origStyle: string }[];
  // The pod's color-relevant pseudo-classes as of the last sample; while
  // they are unchanged, re-sampling (which restyles the whole pod) is skipped.
  stateKey: string;
};

function _withOverride(origStyle: string): string {
  return origStyle ? `${origStyle} ${TRANSPARENT_OVERRIDE}` : TRANSPARENT_OVERRIDE;
}

function _releaseEntry(pod: Clutter.Actor, entry: ToggleEntry): void {
  if (entry.destroyId)
    pod.disconnect(entry.destroyId);
  for (const { actor, origStyle } of entry.styledSubs) {
    if (actor instanceof St.Widget)
      actor.set_style(origStyle || null);
  }
}

export class ToggleStyles {
  constructor(private _logger: Logger, private _isOpen: () => boolean) { }

  sync(root: Clutter.Actor): Clutter.Actor[] {
    const toggles = this._findAllToggleContainers(root);
    this._ensureToggleStyles(toggles);
    return toggles;
  }

  colorFor(actor: Clutter.Actor): { readonly baseColor: readonly number[]; readonly baseAlpha: number } | undefined {
    return this._toggleRegions.get(actor);
  }

  // Logs the sampled colors for the next few passes (with logging on).
  resetDiagnostics(): void {
    this._debugToggleColorLogFrames = 15;
  }

  // How often each pod's color is re-read, i.e. how quickly the glass
  // follows a toggle's ON/OFF and hover state. Pods whose state is unchanged
  // are skipped, so a steady tick is cheap.
  private static readonly TOGGLE_COLOR_SAMPLE_MS = 100;

  // Every Nth pass re-samples every pod anyway, to catch a theme change,
  // which changes colors without changing any state.
  private static readonly TOGGLE_COLOR_FULL_PASS_EVERY = 8;

  // Pod -> its sampled color and the actors whose backgrounds were made
  // transparent, with their original inline styles.
  private _toggleRegions: Map<Clutter.Actor, ToggleEntry> = new Map();

  private _toggleColorTimerId: number = 0;

  private _resamplePassCount: number = 0;

  private _debugToggleColorLogFrames: number = 15;

  // Finds the pods under `actor`, without descending into a pod:
  //  - a `.quick-toggle-has-menu` wrapper (`.quick-menu-toggle` before GNOME
  //    48; Wi-Fi, Bluetooth): the main button, the separator and the arrow
  //    button together form one shape;
  //  - a standalone `.quick-toggle` (Night Light, Do Not Disturb, ...);
  //  - an `.icon-button` inside `.quick-settings-system-item` (screenshot,
  //    settings, lock, power), which themes also draw as pills. Elsewhere
  //    `.icon-button` is also used by slider and submenu buttons;
  //  - a `.quick-slider` row, but only on themes that paint a pill around it
  //    (see _paintsOwnBackground()).
  private _findAllToggleContainers(
    actor: Clutter.Actor,
    found: Clutter.Actor[] = [],
    inSystemItem: boolean = false
  ): Clutter.Actor[] {
    if (!actor) return found;

    const leaf = this._toggleLeafKind(actor, inSystemItem);
    if (leaf === 'slider') {
      if (actor.visible && this._paintsOwnBackground(actor)) found.push(actor);
      return found;
    }
    if (leaf === 'toggle') {
      if (actor.visible) found.push(actor);
      return found;
    }

    let entersSystemItem = inSystemItem ||
      (actor instanceof St.Widget && actor.has_style_class_name('quick-settings-system-item'));

    for (let child of actor.get_children()) this._findAllToggleContainers(child, found, entersSystemItem);
    return found;
  }

  private _toggleLeafKind(actor: Clutter.Actor, inSystemItem: boolean): 'toggle' | 'slider' | null {
    if (!(actor instanceof St.Widget)) return null;
    if (actor.has_style_class_name(QS_MENU_TOGGLE_CLASS)) return 'toggle';
    if (actor.has_style_class_name('quick-toggle')) return 'toggle';
    // Screenshot, settings, lock and power.
    if (inSystemItem && actor.has_style_class_name('icon-button')) return 'toggle';
    if (actor.has_style_class_name('quick-slider')) return 'slider';
    return null;
  }

  // Whether a slider row paints its own pill. An adopted pod carries our
  // transparency override, so its theme node would say no; it keeps its
  // verdict here, and _releaseIfSliderLostPill() re-checks it while the
  // override is lifted.
  private _paintsOwnBackground(actor: Clutter.Actor): boolean {
    if (this._toggleRegions.has(actor)) return true;
    let bg = this._readThemeBg(actor);
    return !!(bg && bg.a > 0.02);
  }

  // Every St.Widget in the pod, at any depth. All of them get the
  // transparency override, which is harmless for icons and labels and does
  // not depend on the theme's exact structure.
  private _getStylableSubActors(pod: Clutter.Actor): Clutter.Actor[] {
    const found: Clutter.Actor[] = [];
    const walk = (actor: Clutter.Actor) => {
      if (actor instanceof St.Widget) found.push(actor);
      for (let child of actor.get_children()) walk(child);
    };
    walk(pod);
    return found;
  }

  // The actor whose color represents the pod: for a has-menu pod, its main
  // `.quick-toggle` button, which may sit more than one level down.
  private _getPrimaryToggleButton(pod: Clutter.Actor): Clutter.Actor {
    if (pod instanceof St.Widget && pod.has_style_class_name(QS_MENU_TOGGLE_CLASS)) {
      let found: Clutter.Actor | null = null;
      const search = (actor: Clutter.Actor) => {
        if (found) return;
        for (let child of actor.get_children()) {
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

  // Some themes put a toggle's ON/OFF color on its `.quick-toggle-icon`.
  private _getToggleIconActors(root: Clutter.Actor): Clutter.Actor[] {
    const found: Clutter.Actor[] = [];
    const walk = (actor: Clutter.Actor) => {
      if (actor instanceof St.Widget && actor.has_style_class_name('quick-toggle-icon')) {
        found.push(actor);
      }
      for (let child of actor.get_children()) walk(child);
    };
    if (root) walk(root);
    return found;
  }

  // The theme background as normalized {r, g, b, a}, falling back to the
  // average of a background gradient when the flat color is transparent.
  private _readThemeBg(actor: Clutter.Actor | null): { r: number; g: number; b: number; a: number } | null {
    if (!(actor instanceof St.Widget)) return null;
    actor.ensure_style();
    let themeNode = actor.get_theme_node();

    let bg = themeNode.get_background_color();
    if (bg.alpha / 255 > 0.02)
      return { r: bg.red / 255, g: bg.green / 255, b: bg.blue / 255, a: bg.alpha / 255 };

    let [gradType, start, end] = themeNode.get_background_gradient();
    if (gradType !== St.GradientType.NONE) {
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

    return { r: bg.red / 255, g: bg.green / 255, b: bg.blue / 255, a: bg.alpha / 255 };
  }

  // What is actually visible at `actor`: its own background composited over
  // its ancestors' until opaque. A transparent background still reports RGB
  // (usually black) that the theme never paints; this replaces it with the
  // color really showing there. `a` is the accumulated coverage.
  private _compositeOverAncestors(
    actor: Clutter.Actor | null,
    own: { r: number; g: number; b: number; a: number } | null
  ): { r: number; g: number; b: number; a: number } {
    // Front-to-back "over" accumulation.
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
    // Bounds the walk, which runs on every sampling pass.
    let guard = 32;
    while (node && outA < 0.995 && guard-- > 0) {
      if (node instanceof St.Widget) add(this._readThemeBg(node));
      node = node.get_parent();
    }

    if (outA <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    return { r: outR / outA, g: outG / outA, b: outB / outA, a: outA };
  }

  // The pod's visible color. Themes put a toggle's state color in different
  // places: Adwaita on the inner `.quick-toggle`, MacTahoe on the has-menu
  // wrapper (whose inner button is `background: none`) or only on the
  // `.quick-toggle-icon`. Every candidate is read, the most opaque wins
  // (ties go to the earlier one), and the result is composited over what is
  // behind it. `a` only tells the caller whether any real paint was found.
  private _samplePodColor(pod: Clutter.Actor, primary: Clutter.Actor): { r: number; g: number; b: number; a: number } {
    let isHasMenu = pod instanceof St.Widget && pod.has_style_class_name(QS_MENU_TOGGLE_CLASS);

    let candidates: Clutter.Actor[] = [primary];
    if (isHasMenu && pod !== primary) candidates.push(pod);
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

    // Nothing in the pod paints; its color is whatever shows through.
    return this._compositeOverAncestors(pod, null);
  }

  // Tracks every pod and keeps the transparency override on each of its
  // current sub-actors. Runs every frame, and checks each actor's own style
  // rather than remembering a pod as done, because the shell rebuilds the
  // inner actors of has-menu pods (on connection changes, for example).
  private _ensureToggleStyles(toggles: Clutter.Actor[]) {
    for (let pod of toggles) {
      if (!(pod instanceof St.Widget)) continue;
      const entry = this._ensureEntry(pod);
      const primary = this._getPrimaryToggleButton(pod);
      // Once overridden the theme reports our transparency, so only a fresh
      // actor is sampled here.
      if (primary instanceof St.Widget && !this._hasOverride(primary)) this._updateBaseColor(entry, pod, primary);
      this._overrideSubStyles(entry, pod);
    }
  }

  private _ensureEntry(pod: Clutter.Actor): ToggleEntry {
    let entry = this._toggleRegions.get(pod);
    if (entry) return entry;
    // baseAlpha 0 until a real color has been sampled.
    entry = { destroyId: 0, baseColor: [1.0, 1.0, 1.0], baseAlpha: 0, styledSubs: [], stateKey: '' };
    this._toggleRegions.set(pod, entry);
    entry.destroyId = pod.connect('destroy', () => {
      this._toggleRegions.delete(pod);
    });
    return entry;
  }

  private _hasOverride(actor: St.Widget): boolean {
    const style = actor.get_style();
    return !!style && style.includes(TRANSPARENT_OVERRIDE);
  }

  private _updateBaseColor(entry: ToggleEntry, pod: Clutter.Actor, primary: St.Widget) {
    const sampled = this._samplePodColor(pod, primary);
    // A near-transparent sample says nothing about the color.
    if (sampled.a > 0.02) {
      entry.baseColor = [sampled.r, sampled.g, sampled.b];
      entry.baseAlpha = sampled.a;
    }
    return sampled;
  }

  private _overrideSubStyles(entry: ToggleEntry, pod: Clutter.Actor) {
    const known = new Set(entry.styledSubs.map(s => s.actor));
    for (let sub of this._getStylableSubActors(pod)) {
      if (!(sub instanceof St.Widget) || this._hasOverride(sub)) continue;
      const origStyle = sub.get_style() || '';
      sub.set_style(_withOverride(origStyle));
      if (!known.has(sub)) entry.styledSubs.push({ actor: sub, origStyle });
    }
  }

  // Re-samples each pod's color: lifts the override from its sub-actors,
  // reads the theme color, and puts the override back.
  private _resampleToggleColors() {
    let forceFull = (this._resamplePassCount++ % ToggleStyles.TOGGLE_COLOR_FULL_PASS_EVERY) === 0;
    for (const [pod, entry] of this._toggleRegions.entries())
      this._resamplePod(pod, entry, forceFull);
    if (this._debugToggleColorLogFrames > 0) this._debugToggleColorLogFrames--;
  }

  private _resamplePod(pod: Clutter.Actor, entry: ToggleEntry, forceFull: boolean) {
    const primary = this._getPrimaryToggleButton(pod);
    const stateKey = this._podStateKey(pod, primary);
    if (!forceFull && stateKey === entry.stateKey) return;
    entry.stateKey = stateKey;

    for (const { actor, origStyle } of entry.styledSubs) {
      if (actor instanceof St.Widget) actor.set_style(origStyle || null);
    }

    if (this._releaseIfSliderLostPill(pod, entry)) return;

    if (primary instanceof St.Widget) {
      const sampled = this._updateBaseColor(entry, pod, primary);
      if (this._debugToggleColorLogFrames > 0) this._logPodColor(pod, primary, entry, sampled);
    }

    for (const { actor, origStyle } of entry.styledSubs) {
      if (actor instanceof St.Widget) actor.set_style(_withOverride(origStyle));
    }
  }

  // A theme switch does not rebuild the Quick Settings actors, so a slider
  // adopted under a theme that draws a pill would stay glassed after
  // switching to one that does not. While the override is lifted its real
  // theme is readable: if it no longer paints a pill, it is released (its
  // styles are already restored).
  private _releaseIfSliderLostPill(pod: Clutter.Actor, entry: ToggleEntry): boolean {
    if (!(pod instanceof St.Widget) || !pod.has_style_class_name('quick-slider')) return false;
    const pill = this._readThemeBg(pod);
    if (pill && pill.a > 0.02) return false;
    this._logger.log(
      `[Liquid Glass][toggle-color] releasing .quick-slider pod — theme no longer paints a pill ` +
      `(bg=${JSON.stringify(pill)})`
    );
    if (entry.destroyId)
      pod.disconnect(entry.destroyId);
    this._toggleRegions.delete(pod);
    return true;
  }

  private _logPodColor(pod: Clutter.Actor, primary: St.Widget, entry: ToggleEntry, sampled: { a: number }) {
    let isHasMenu = pod instanceof St.Widget && pod.has_style_class_name(QS_MENU_TOGGLE_CLASS);
    let podCls = pod instanceof St.Widget ? (pod.get_style_class_name() || '') : '';
    let primaryCls = primary.get_style_class_name() || '';
    let checked = primary.has_style_pseudo_class('checked');
    // Every candidate, not only the winner (see _samplePodColor()).
    let wrapperBg = isHasMenu ? this._readThemeBg(pod) : null;
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

  // The pseudo-classes of the actors _samplePodColor() can pick from.
  private _podStateKey(pod: Clutter.Actor, primary: Clutter.Actor): string {
    const STATES = ['checked', 'hover', 'active', 'insensitive', 'focus', 'selected'];

    let actors: Clutter.Actor[] = [pod];
    if (primary !== pod) actors.push(primary);
    for (let icon of this._getToggleIconActors(pod !== primary ? primary : pod)) actors.push(icon);

    let key = '';
    for (let actor of actors) {
      if (!(actor instanceof St.Widget)) {
        key += '?|';
        continue;
      }
      for (let state of STATES)
        key += actor.has_style_pseudo_class(state) ? '1' : '0';
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

  // Restores the original inline styles and forgets every pod.
  clear() {
    this.stop();
    for (const [pod, entry] of this._toggleRegions.entries()) _releaseEntry(pod, entry);
    this._toggleRegions.clear();
  }
}

// Quick Settings' toggle mode puts a piece of glass behind each toggle, inside
// the menu: over the panel's own background and under the toggles' labels.
// The menu (a BoxPointer) is always drawn through an offscreen, where the
// glass cannot read the stage, so the work is split in two:
//
// - BackdropReader sits outside the menu, just below it in uiGroup. It draws
//   nothing; it copies the stage behind the toggles while the stage is
//   painted, before the menu is.
// - ToggleBackdropGlass sits inside the menu. It copies the panel background
//   already drawn into the menu's offscreen, lays it over the reader's copy,
//   blurs that and draws the toggles' glass.
//
// The glass holds the relays. A change behind the toggles then both puts the
// area into the redraw clip, so the reader copies it, and dirties the menu,
// whose offscreen would otherwise be reused without painting the glass.

// The reader's fixed size; it is fitted to its rect by translation and scale
// for the same reason as the sample area (rendering/backdropGlass.ts).
const READER_BASE = 256;

type Target = { texture: Cogl.Texture2D, framebuffer: Cogl.Offscreen, width: number, height: number };

export const BackdropReader = GObject.registerClass(paintNodeWithContext(
  class BackdropReader extends Clutter.Actor {
    declare copier: StageCopier;
    declare private _rect: number[] | null;

    _init(logger?: Logger) {
      super._init({ name: 'liquid-glass-backdrop-reader', reactive: false, width: READER_BASE, height: READER_BASE });
      Shell.util_set_hidden_from_pick(this, true);
      this.copier = new StageCopier(logger);
      this._rect = null;
    }

    vfunc_pick(_pickContext: any): void {
    }

    // The stage rect [x0, y0, x1, y1] to copy. The actor covers it, so it is
    // painted whenever the rect is redrawn.
    setStageRect(rect: number[]): void {
      // The glass maps its rect through its own transform, which is not
      // finite before its first allocation.
      if (!rect.every(Number.isFinite)) return;
      this._rect = rect;
      const parent = this.get_parent();
      if (!parent) return;
      const [ok0, x0, y0] = parent.transform_stage_point(rect[0], rect[1]);
      const [ok1, x1, y1] = parent.transform_stage_point(rect[2], rect[3]);
      if (!ok0 || !ok1 || ![x0, y0, x1, y1].every(Number.isFinite)) return;
      setTranslationIfChanged(this, x0, y0);
      setScaleIfChanged(this, Math.max(x1 - x0, 1) / READER_BASE, Math.max(y1 - y0, 1) / READER_BASE);
    }

    vfunc_paint_node(root: Clutter.PaintNode, paintContext: Clutter.PaintContext): void {
      if (this._rect) this.copier.take(this, root, paintContext, this._rect);
    }
  }
));

export type BackdropReader = InstanceType<typeof BackdropReader>;

// "Over" for premultiplied colors: the panel material (layer 1) over the
// desktop (layer 0). Each layer has its own rect within the composed quad.
const COMPOSE_DECL = 'uniform vec4 d_rect;\nuniform vec4 m_rect;\n';
const COMPOSE_BODY =
  'vec2 uv = cogl_tex_coord_in[0].st;\n' +
  'vec4 d = texture2D(cogl_sampler0, mix(d_rect.xy, d_rect.zw, uv));\n' +
  'vec4 m = texture2D(cogl_sampler1, mix(m_rect.xy, m_rect.zw, uv));\n' +
  'cogl_color_out = m + d * (1.0 - m.a);\n';

export const ToggleBackdropGlass = GObject.registerClass(paintNodeWithContext(
  class ToggleBackdropGlass extends GlassActor {
    declare reader: BackdropReader;
    declare private _relays: RelaySet;
    declare private _wasPainted: boolean;
    // The panel background behind the sample rect, and where the rect lies
    // in it as [u0, v0, u1, v1].
    declare private _material: Target | null;
    declare private _materialUV: number[] | null;
    declare private _materialCopies: number;
    declare private _composed: Target | null;
    declare private _composeSerial: number;
    declare private _composeBase: Cogl.Pipeline | null;

    _init(params: GlassActorParams = {}) {
      super._init(params);
      this.reader = new BackdropReader(params.logger as any);
      this.reader.hide();
      this._relays = new RelaySet(this, actor => actor === this.reader);
      this._wasPainted = false;
      this._material = null;
      this._materialUV = null;
      this._materialCopies = 0;
      this._composed = null;
      this._composeSerial = 0;
      this._composeBase = null;
    }

    // The reader works only while the glass is shown, and nothing behind it
    // was tracked while it was hidden.
    vfunc_map(): void {
      super.vfunc_map();
      this.reader.show();
      this._relays.redrawArea();
    }

    vfunc_unmap(): void {
      this.reader.hide();
      super.vfunc_unmap();
    }

    protected _onShadersLoaded(): void {
      super._onShadersLoaded();
      this._relays.redrawArea();
    }

    /** See BackdropGlass.syncSources(); also places the reader. */
    syncSources(): void {
      const area = this._sampleAreaRect();
      if (!area) return;
      const changed = this._relays.sync(area);
      this.reader.setStageRect(localToStage(this, area[0], area[1], area[0] + area[2], area[1] + area[3]));
      const painted = this.get_paint_opacity() > 0;
      if (changed || (painted && !this._wasPainted)) this._relays.redrawArea();
      this._wasPainted = painted;
      this.reader.copier.prune(this.reader.peek_stage_views());
    }

    vfunc_paint_node(root: Clutter.PaintNode, paintContext: Clutter.PaintContext): void {
      const ctx = this._beginPaint();
      if (!ctx) return;
      const scale = this._paintScale();
      const s = this._sampleShaderRect();
      if (!scale || !s) return;
      const { kx, ky, resW, resH } = scale;
      const local = [s[0] * kx, s[1] * ky, (s[0] + s[2]) * kx, (s[1] + s[3]) * ky];

      const desktop = this.reader.copier.lastCopy;
      if (!desktop?.rect) {
        // Nothing copied yet; the next frame redraws the whole area.
        this._relays.redrawArea();
        return;
      }
      this._takeMaterial(root, paintContext, local);
      if (!this._material || !this._materialUV) return;

      const composed = this._compose(root, ctx, desktop.texture, desktop.rect, local);
      if (!composed) return;
      this._runBlur(root, ctx, composed.texture, s, [composed.texture, this._composeSerial]);
      const compositeRect = this._composite(root, composed.texture, s, kx, ky, resW, resH);
      this._snapshot(() => {
        const round = (v: number) => +v.toFixed(2);
        return {
          mode: 'toggle-backdrop',
          desktop: `${desktop.width}x${desktop.height}`,
          desktopStageRect: desktop.rect?.map(round) ?? null,
          material: `${this._material!.width}x${this._material!.height}`,
          blurRect: s.map(round),
          compositeRect: compositeRect.map(round),
        };
      });
    }

    // The nearest ancestor drawn through an offscreen: the menu's BoxPointer.
    private _offscreenAncestor(): Clutter.Actor | null {
      for (let a = this.get_parent(); a; a = a.get_parent()) {
        if (a.get_offscreen_redirect() & Clutter.OffscreenRedirect.ALWAYS) return a;
      }
      return null;
    }

    /**
     * Copies the panel background behind `local` [x0, y0, x1, y1] out of the
     * menu's offscreen, which at this point holds everything the menu drew
     * before the glass. ClutterOffscreenEffect renders the actor in its own
     * coordinates, offset by its enlarged paint box and scaled by the ceiled
     * resource scale; the same arithmetic finds the rect in the offscreen.
     * Any other paint (on stage, in a clone, a screenshot) keeps the last copy.
     */
    private _takeMaterial(root: Clutter.PaintNode, paintContext: Clutter.PaintContext, local: number[]): void {
      if (this.is_in_clone_paint() || !isPaintingView()) return;
      const fb = paintContext.get_framebuffer();
      if (!(fb instanceof Cogl.Offscreen) || StageCopier.liveView(this, paintContext)) return;
      const menu = this._offscreenAncestor();
      const pv = menu?.get_paint_volume();
      if (!menu || !pv) return;

      // _clutter_actor_box_enlarge_for_effects()
      const origin = pv.get_origin();
      const width = Math.round(pv.get_width());
      const height = Math.round(pv.get_height());
      const offX = Math.trunc(Math.ceil(origin.x + pv.get_width() + 0.75) - width - 3);
      const offY = Math.trunc(Math.ceil(origin.y + pv.get_height() + 0.75) - height - 3);
      const cs = menu.get_resource_scale();

      const a = this.apply_relative_transform_to_point(menu, new Graphene.Point3D({ x: local[0], y: local[1], z: 0 }));
      const b = this.apply_relative_transform_to_point(menu, new Graphene.Point3D({ x: local[2], y: local[3], z: 0 }));
      const sx0 = (Math.min(a.x, b.x) - offX) * cs;
      const sy0 = (Math.min(a.y, b.y) - offY) * cs;
      const sx1 = (Math.max(a.x, b.x) - offX) * cs;
      const sy1 = (Math.max(a.y, b.y) - offY) * cs;
      const fx0 = Math.max(0, Math.floor(sx0));
      const fy0 = Math.max(0, Math.floor(sy0));
      const fx1 = Math.min(fb.get_width(), Math.ceil(sx1));
      const fy1 = Math.min(fb.get_height(), Math.ceil(sy1));
      const w = fx1 - fx0;
      const h = fy1 - fy0;
      if (!(w >= 1) || !(h >= 1)) return;

      if (!this._material || this._material.width !== w || this._material.height !== h) {
        const target = createTarget(w, h, offscreenFormat(fb), this._logger);
        this._material = target ? { ...target, width: w, height: h } : null;
        if (!this._material) return;
      }
      addBlit(root, fb, this._material.framebuffer, this.color_state, [fx0, fy0, w, h]);
      this._materialUV = [(sx0 - fx0) / w, (sy0 - fy0) / h, (sx1 - fx0) / w, (sy1 - fy0) / h];
      this._materialCopies++;
    }

    // The material over the desktop, for the blur, at the material's
    // resolution and covering exactly the sample rect `local`.
    private _compose(root: Clutter.PaintNode, ctx: Cogl.Context, desktop: Cogl.Texture, desktopRect: number[],
      local: number[]): Target | null {
      const material = this._material!;
      const w = material.width;
      const h = material.height;
      if (!this._composed || this._composed.width !== w || this._composed.height !== h) {
        const target = createTarget(w, h, null, this._logger);
        this._composed = target ? { ...target, width: w, height: h } : null;
        if (!this._composed) return null;
      }

      if (!this._composeBase) {
        this._composeBase = Cogl.Pipeline.new(ctx);
        configureSamplerLayer(this._composeBase, 0);
        configureSamplerLayer(this._composeBase, 1);
        const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, uniformDeclarations(COMPOSE_DECL), null);
        snippet.set_replace(COMPOSE_BODY);
        this._composeBase.add_snippet(snippet);
      }
      const pipeline = this._renderer.passes.pipeline('toggle-compose', this._composeBase);
      pipeline.set_layer_texture(0, desktop);
      pipeline.set_layer_texture(1, material.texture);

      // Where the sample rect lies in the desktop copy, by stage position.
      const st = localToStage(this, local[0], local[1], local[2], local[3]);
      const dw = desktopRect[2] - desktopRect[0];
      const dh = desktopRect[3] - desktopRect[1];
      setUniformVector(pipeline, 'd_rect', [
        (st[0] - desktopRect[0]) / dw, (st[1] - desktopRect[1]) / dh,
        (st[2] - desktopRect[0]) / dw, (st[3] - desktopRect[1]) / dh,
      ]);
      setUniformVector(pipeline, 'm_rect', this._materialUV!);

      this._renderer.passes.add(root, this._composed.framebuffer, pipeline, w, h, [0, 0, 1, 1]);
      this._composeSerial++;
      return this._composed;
    }

    /** Counters for the test driver and the dump. */
    get stats(): { paints: number, copies: number, reuses: number, misses: number, offStage: number,
      materialCopies: number } {
      const c = this.reader.copier;
      return {
        paints: this._paints, copies: c.copyCount, reuses: c.reuseCount, misses: c.missCount,
        offStage: c.offStageCount, materialCopies: this._materialCopies,
      };
    }

    describe(): object {
      return {
        ...super.describe(),
        ...this.stats,
        relays: this._relays.names(),
        relayChanges: this._relays.changes,
        sampleArea: this._relays.areaRect(),
      };
    }

    // The reader lives outside the glass (in uiGroup), so it goes here; at
    // shell shutdown the stage may have destroyed it already.
    cleanup(): void {
      super.cleanup();
      this._relays.clear();
      this.reader.copier.clear();
      if (isActorValid(this.reader)) this.reader.destroy();
      this._material = null;
      this._composed = null;
      this._composeBase = null;
    }
  }
));

export type ToggleBackdropGlass = InstanceType<typeof ToggleBackdropGlass>;
