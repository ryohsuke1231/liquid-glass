import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import { BackdropGlass } from './rendering/backdropGlass.js';
import type { GlassRegion } from './rendering/glassRenderer.js';
import { ensureGlassAllocated } from './actors/allocation.js';
import { isActorValid } from './actors/lifecycle.js';
import { startSyncLoop, stopStageLoop } from './animation/frameLoops.js';
import { hexToColorArray } from './animation/colors.js';
import { sanitizeColorPreference } from './contrastSampler.js';
import { AdaptiveTextColor } from './adaptiveText.js';
import type { Logger } from './logger.js';

export type TopBarStyle = 'off' | 'pill' | 'islands' | 'center';

// Extra space for shader edge effects.
const SHADER_PADDING = 20;
// Space for the pill shadow.
const SHADOW_ROOM = 48;
const SIDES = ['top', 'bottom', 'left', 'right'] as const;
type Insets = Record<typeof SIDES[number], number>;
// PopupMenu keeps the alignment it hands its box pointer on open in a field the shell's typings leave out.
type ArrowAlignedMenu = { _arrowAlignment: number };

function sanitizeStyle(value: string): TopBarStyle {
  return value === 'pill' || value === 'islands' || value === 'center' ? value : 'off';
}

/**
 * Width at which the shell's Panel fits its boxes at their natural widths. It puts the center box in the
 * middle and gives both sides the same room, shifted by the work area's offset when a dock is fixed to a side.
 */
export function centeredBarWidth(left: number, center: number, right: number, centerOffset: number): number {
  return Math.ceil(center + 2 * Math.max(left, right) + Math.abs(centerOffset));
}

/** The shell's top bar, or one that another extension builds the same way for a further monitor. */
export interface TopBarPanel extends St.Widget {
  _leftBox: St.BoxLayout;
  _centerBox: St.BoxLayout;
  _rightBox: St.BoxLayout;
  // Multi Monitors Bar lines its center items up in a row inside _centerBox.
  _centerBin?: St.BoxLayout;
}

/** Glass behind the top bar: one pill, separate islands for its three button groups, or one pill the bar shrinks to. */
export class TopBarManager {
  private _style: TopBarStyle = 'off';
  private _glass: BackdropGlass | null = null;
  private _settingsIds: number[] = [];
  private _frameSyncId = 0;
  private _frameSignalId = 0;
  private _lastKey = '';
  private _lastIslandRects: number[][] = [];
  private _islandGeometryHoldFrames = 0;
  private _text: AdaptiveTextColor;
  // Original styles for the panel and its boxes.
  private _savedStyles: [St.Widget, string | null][] = [];
  private _childrenStyles: [St.Widget, string | null][] = [];
  private _panelStyleId = 0;
  private _margin: Insets = { top: 0, bottom: 0, left: 0, right: 0 };
  private _padding: Insets = { top: 0, bottom: 0, left: 0, right: 0 };
  private _boxSignalIds: [St.Widget, number][] = [];
  private _containerSignalIds: [St.Widget, number][] = [];
  private _containerTargets: [St.Widget, St.Widget][] = [];
  private _forwardedPresses = new Map<St.Widget, { touch: boolean, native: boolean }>();
  private _stagePointerSignalId = 0;
  private _applyingLayout = false;
  // The bar's width while the centered style shrinks it, and what it replaced on the bar and quick settings.
  private _centeredWidth = 0;
  private _savedXAlign: Clutter.ActorAlign = 0;
  private _savedQuickSettingsAlignment = 0;

  constructor(private _path: string, private _settings: Gio.Settings, private _logger: Logger,
    // The panel's boxes are not part of the shell's typings.
    private _panel: TopBarPanel = Main.panel as unknown as TopBarPanel,
    private _panelBox: St.Widget = Main.layoutManager.panelBox,
    // Names this glass in diagnostics.
    private _owner: string = 'top-bar') {
    this._text = new AdaptiveTextColor(() => this._textRoots(), () => (this._glass ? [this._glass] : []),
      _logger, 'top bar');
  }

  setup(): void {
    const watch = (key: string, fn: () => void) =>
      this._settingsIds.push(this._settings.connect(`changed::${key}`, fn));
    watch('top-bar-style', () => this._apply());
    for (const key of ['tint-color', 'tint-strength', 'blur-radius', 'corner-radius', 'brightness', 'contrast', 'saturation'])
      watch(`top-bar-${key}`, () => this._applyMaterial());
    for (const key of ['enable-adaptive-text-color', 'sample-interval-ms', 'adaptive-text-preference'])
      watch(`top-bar-${key}`, () => this._syncText());
    for (const side of SIDES) {
      watch(`top-bar-margin-${side}`, () => this._applyLayout());
      watch(`top-bar-padding-${side}`, () => this._applyLayout());
    }
    watch('top-bar-attach-to-edge', () => {
      this._applyAttach();
      this._applyLayout();
    });
    watch('top-bar-edge-radius', () => this._applyAttach());
    this._apply();
  }

  private _key(suffix: string): string {
    return `top-bar-${suffix}`;
  }

  private _apply(): void {
    const style = sanitizeStyle(this._settings.get_string('top-bar-style'));
    if (style === this._style) return;
    this._remove();
    this._style = style;
    if (style !== 'off') this._create();
  }

  private _create(): void {
    const panel = this._panel;
    const panelBox = this._panelBox;
    panel.add_style_class_name('liquid-glass-transparent');

    const glass = new BackdropGlass({
      extensionPath: this._path, settings: this._settings, logger: this._logger, owner: this._owner, outline: 'top-bar',
    } as any);
    this._glass = glass;
    glass.reactive = false;
    glass.setPadding(SHADER_PADDING);
    glass.setIsDock(false);
    glass.setMultiRegionMode(this._style === 'islands');
    glass.setShadowMaxRadius(SHADOW_ROOM - 8);
    // Draw the glass below the panel.
    Main.layoutManager.uiGroup.insert_child_below(glass, panelBox);
    this._applyMaterial();
    this._applyAttach();
    this._lastKey = '';
    this._lastIslandRects = [];
    this._islandGeometryHoldFrames = 0;
    const styled = new Set<St.Widget>([panel, panel._leftBox, panel._centerBox, ...this._sections()]);
    this._savedStyles = [...styled].map(actor => [actor, actor.get_style()]);
    this._childrenStyles = [];
    if (this._style === 'center') {
      // panelBox keeps the monitor's width, so the bar stays above maximized windows.
      this._savedXAlign = panel.x_align;
      panel.x_align = Clutter.ActorAlign.CENTER;
      // Quick settings opens from its button's left edge and counts on the screen edge to push it back, so in
      // the middle of the screen it would hang past the bar. The other monitors' bars open this same menu.
      if (this._owner === 'top-bar') {
        const menu = Main.panel.statusArea.quickSettings.menu as unknown as ArrowAlignedMenu;
        this._savedQuickSettingsAlignment = menu._arrowAlignment;
        menu._arrowAlignment = 0.5;
      }
    }
    // Reapply layout when the theme changes the bar height.
    this._panelStyleId = panel.connect('style-changed', () => this._applyLayout());
    this._applyLayout();
    this._connectBoxSignals();
    this._stagePointerSignalId = global.stage.connect('captured-event', (_actor, event: Clutter.Event) => this._onStageEvent(event));

    startSyncLoop(this._frameSignalSlot, this._frameSlot, {
      // The glass may be destroyed before shutdown cleanup runs.
      alive: () => !!this._glass && isActorValid(this._glass),
      honourFreeze: true,
      errorTag: 'TopBarManager',
      step: () => {
        ensureGlassAllocated(this._glass);
        this._sync();
      },
    });
    ensureGlassAllocated(this._glass);
    this._sync();
    this._syncText();
  }

  private _connectBoxSignals(): void {
    for (const box of this._sections()) {
      const addedId = box.connect('child-added', () => this._applyLayout());
      // A removed button may be re-added elsewhere, so it gets its own styles back.
      const removedId = box.connect('child-removed', (_box: St.Widget, child: Clutter.Actor) => this._releaseChild(child));
      this._boxSignalIds.push([box, addedId], [box, removedId]);
    }
  }

  // The boxes the buttons sit in.
  private _sections(): St.BoxLayout[] {
    const panel = this._panel;
    return [panel._leftBox, panel._centerBin ?? panel._centerBox, panel._rightBox];
  }

  private _releaseChild(child: Clutter.Actor): void {
    const target = this._containerTargets.find(([container]) => container === child)?.[1];
    for (const [actor, style] of this._childrenStyles) {
      if (actor === child || actor === target) actor.set_style(style);
    }
    this._childrenStyles = this._childrenStyles.filter(([actor]) => actor !== child && actor !== target);
    if (!target) return;
    for (const [actor, id] of this._containerSignalIds) {
      if (actor === child || actor === target) actor.disconnect(id);
    }
    this._containerSignalIds = this._containerSignalIds.filter(([actor]) => actor !== child && actor !== target);
    this._containerTargets = this._containerTargets.filter(([container]) => container !== child);
    this._forwardedPresses.delete(child as St.Widget);
    child.reactive = false;
    target.remove_style_pseudo_class('hover');
    target.remove_style_pseudo_class('active');
  }

  private _disconnectBoxSignals(): void {
    for (const [box, id] of this._boxSignalIds) {
      if (isActorValid(box)) {
        box.disconnect(id);
      }
    }
    this._boxSignalIds = [];
  }

  private _applyMaterial(): void {
    const glass = this._glass;
    if (!glass) return;
    glass.setTintColor(...hexToColorArray(this._settings.get_string(this._key('tint-color'))));
    glass.setTintStrength(this._settings.get_double(this._key('tint-strength')));
    glass.setBlurRadius(this._settings.get_int(this._key('blur-radius')));
    glass.setCornerRadius(this._settings.get_double(this._key('corner-radius')));
    glass.setBrightness(this._settings.get_double(this._key('brightness')));
    glass.setContrast(this._settings.get_double(this._key('contrast')));
    glass.setSaturation(this._settings.get_double(this._key('saturation')));
  }

  private _applyAttach(): void {
    const attached = this._settings.get_boolean(this._key('attach-to-edge'));
    this._glass?.setAttachedEdge(attached ? 'top' : 'none', this._settings.get_double(this._key('edge-radius')));
  }

  private _insets(kind: 'margin' | 'padding'): Insets {
    return Object.fromEntries(SIDES.map(side => [side, this._settings.get_int(this._key(`${kind}-${side}`))])) as Insets;
  }

  // Buttons made without a menu carry a dummy one and act on their own handlers.
  private _targetMenu(target: St.Widget): PopupMenu.PopupMenuBase | null {
    const anyTarget = target as any;
    const menu = anyTarget.menu ?? anyTarget._delegate?.menu;
    return menu instanceof PopupMenu.PopupMenuBase ? menu : null;
  }

  private _eventComesFromTarget(target: St.Widget, event: Clutter.Event): boolean {
    let source: Clutter.Actor | null = event.get_source();
    while (source) {
      if (source === target) return true;
      source = source.get_parent();
    }
    return false;
  }

  // A bounds test rather than a pick: this runs every frame and a pick walks the whole stage.
  private _pointerIsOverContainer(container: St.Widget): boolean {
    if (!container.mapped) return false;
    const [px, py] = global.get_pointer();
    const [x, y] = container.get_transformed_position();
    const [w, h] = container.get_transformed_size();
    return px >= x && px < x + w && py >= y && py < y + h;
  }

  private _syncForwardedHover(): void {
    for (const [container, target] of this._containerTargets) {
      if (!isActorValid(container) || !isActorValid(target)) continue;
      if (this._pointerIsOverContainer(container)) {
        target.add_style_pseudo_class('hover');
      } else {
        // Overlays can suppress leave-event, so the state is also cleared here.
        target.remove_style_pseudo_class('hover');
        target.remove_style_pseudo_class('active');
        this._forwardedPresses.delete(container);
      }
    }
  }

  private _isPress(event: Clutter.Event): boolean {
    const type = event.type();
    if (type === Clutter.EventType.TOUCH_BEGIN) return true;
    return type === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_PRIMARY;
  }

  private _toggleOverview(): void {
    if (Main.overview.shouldToggleByCornerOrButton()) Main.overview.toggle();
  }

  // A press on the wrapper above or below the button. Menus open on press, as the panel's own
  // buttons do, so their release needs no handling; Activities and plain buttons act on release.
  private _onWrapperPress(container: St.Widget, target: St.Widget, event: Clutter.Event): boolean {
    const touch = event.type() === Clutter.EventType.TOUCH_BEGIN;
    if (target.get_name() !== 'panelActivities') {
      const menu = this._targetMenu(target);
      const wasOpen = menu?.isOpen;
      const handled = target.emit(touch ? 'touch-event' : 'button-press-event', event.copy()) as unknown as boolean;
      if (menu) {
        // AppIndicator buttons toggle their menu in the press handler, at once or after the
        // double-click wait, and still propagate; a second toggle here closes it mid-animation.
        const selfToggled = menu.isOpen !== wasOpen
          || Boolean((target as St.Widget & { _waitDoubleClickPromise?: unknown })._waitDoubleClickPromise);
        if (handled !== Clutter.EVENT_STOP && !selfToggled) menu.toggle();
        return Clutter.EVENT_STOP;
      }
    }
    target.add_style_pseudo_class('active');
    this._forwardedPresses.set(container, { touch, native: false });
    return Clutter.EVENT_STOP;
  }

  // The stage sees every release first, also one that ends outside the wrapper.
  private _onStageEvent(event: Clutter.Event): boolean {
    const type = event.type();
    if (this._isPress(event)) {
      // Layout changes can move the picked actor between press and release.
      for (const [container, target] of this._containerTargets) {
        if (!this._eventComesFromTarget(target, event)) continue;
        if (!this._targetMenu(target))
          this._forwardedPresses.set(container, { touch: type === Clutter.EventType.TOUCH_BEGIN, native: true });
        break;
      }
      return Clutter.EVENT_PROPAGATE;
    }

    const touchEnd = type === Clutter.EventType.TOUCH_END;
    if (!touchEnd && (type !== Clutter.EventType.BUTTON_RELEASE || event.get_button() !== Clutter.BUTTON_PRIMARY))
      return Clutter.EVENT_PROPAGATE;

    for (const [container, press] of this._forwardedPresses) {
      if (press.touch !== touchEnd) continue;
      this._forwardedPresses.delete(container);
      const target = this._containerTargets.find(([candidate]) => candidate === container)?.[1];
      if (!target || !isActorValid(target)) return Clutter.EVENT_STOP;
      target.remove_style_pseudo_class('active');

      if (press.native && this._eventComesFromTarget(target, event)) return Clutter.EVENT_PROPAGATE;
      if (!this._pointerIsOverContainer(container)) return Clutter.EVENT_PROPAGATE;

      if (target.get_name() === 'panelActivities')
        this._toggleOverview();
      else if (target instanceof St.Button)
        target.emit('clicked', Clutter.BUTTON_PRIMARY);
      else
        target.emit(touchEnd ? 'touch-event' : 'button-release-event', event.copy());
      return Clutter.EVENT_STOP;
    }
    return Clutter.EVENT_PROPAGATE;
  }

  private _setupContainerForwarding(container: St.Widget, target: St.Widget): void {
    if (this._containerTargets.some(([actor]) => actor === container)) return;

    const clearHover = () => {
      if (!this._pointerIsOverContainer(container)) {
        target.remove_style_pseudo_class('hover');
        target.remove_style_pseudo_class('active');
      }
      return Clutter.EVENT_PROPAGATE;
    };
    const enterId = container.connect('enter-event', () => {
      target.add_style_pseudo_class('hover');
      return Clutter.EVENT_PROPAGATE;
    });
    const leaveId = container.connect('leave-event', clearHover);
    const targetLeaveId = target.connect('leave-event', clearHover);
    // Presses that reach the button itself keep their normal path.
    const pressId = container.connect('captured-event', (_actor, event: Clutter.Event) => {
      if (!this._isPress(event) || this._eventComesFromTarget(target, event)) return Clutter.EVENT_PROPAGATE;
      return this._onWrapperPress(container, target, event);
    });

    this._containerTargets.push([container, target]);
    this._containerSignalIds.push([container, enterId], [container, leaveId], [target, targetLeaveId], [container, pressId]);
  }

  private _disconnectContainerSignals(): void {
    // The panel's wrappers are not reactive on their own.
    for (const [container] of this._containerTargets) {
      if (isActorValid(container)) container.reactive = false;
    }
    for (const [actor, id] of this._containerSignalIds) {
      if (isActorValid(actor)) actor.disconnect(id);
    }
    this._containerSignalIds = [];
    this._containerTargets = [];
    this._forwardedPresses.clear();
    if (this._stagePointerSignalId) global.stage.disconnect(this._stagePointerSignalId);
    this._stagePointerSignalId = 0;
  }

  // The bar grows by the margin and padding while each button keeps the theme's height. The
  // wrappers around the buttons fill the whole bar, so a press at the screen edge still lands.
  private _applyLayout(): void {
    // set_style() below emits style-changed on the panel, which calls back in here.
    if (!this._glass || this._applyingLayout) return;
    this._applyingLayout = true;
    try {
      const panel = this._panel;
      const sections: St.Widget[] = this._sections();
      const margin = this._margin = this._insets('margin');
      // Grown out of the screen's top, the glass starts at it.
      if (this._settings.get_boolean(this._key('attach-to-edge'))) margin.top = 0;
      const padding = this._padding = this._insets('padding');
      const top = margin.top + padding.top;
      const bottom = margin.bottom + padding.bottom;
      const own = (style: string | null) => style?.trim().replace(/;$/, '') || '';
      const withOwn = (style: string | null, extra: string) => (own(style) ? `${own(style)}; ${extra}` : extra);

      this._childrenStyles = this._childrenStyles.filter(([actor]) => isActorValid(actor));
      // Measure the theme's height with all of our styles removed.
      for (const [actor, original] of [...this._savedStyles, ...this._childrenStyles]) actor.set_style(own(original));
      const themeHeight = panel.get_theme_node().get_height();
      const baseHeight = themeHeight > 0 ? themeHeight : panel.get_preferred_height(-1)[1];
      const totalHeight = baseHeight + top + bottom;

      for (const [actor, original] of this._savedStyles) {
        if (actor === panel) {
          // Inline styles win over the stylesheet's transparent background, and Multi Monitors Bar
          // colours its bars with one.
          actor.set_style(withOwn(original, `height: ${totalHeight}px; min-height: ${totalHeight}px; padding-top: 0px; ` +
            'padding-bottom: 0px; background-color: transparent !important;'));
          continue;
        }
        const leftInset = actor === panel._leftBox ? margin.left + padding.left : 0;
        const rightInset = actor === panel._rightBox ? margin.right + padding.right : 0;
        actor.set_style(withOwn(original, `height: ${totalHeight}px; padding: 0px ${rightInset}px 0px ${leftInset}px;`));

        // Multi Monitors Bar's _centerBox only holds the row its buttons are in.
        if (!sections.includes(actor)) continue;
        for (const child of actor.get_children()) {
          if (!(child instanceof St.Widget)) continue;
          const target = this._findPanelButton(child) ?? child;
          if (target !== child) {
            child.reactive = true;
            this._setChildStyle(child, `height: ${totalHeight}px;`);
            this._setupContainerForwarding(child, target);
          }
          this._setChildStyle(target, `height: ${baseHeight}px; margin-top: ${top}px; margin-bottom: ${bottom}px;`);
        }
      }
    } finally {
      this._applyingLayout = false;
    }
  }

  private _findPanelButton(root: St.Widget): St.Widget | null {
    const queue: Clutter.Actor[] = [root];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current instanceof St.Widget && current.has_style_class_name('panel-button')) return current;
      queue.push(...current.get_children());
    }
    return null;
  }

  private _setChildStyle(actor: St.Widget, extra: string): void {
    let entry = this._childrenStyles.find(([a]) => a === actor);
    if (!entry) {
      entry = [actor, actor.get_style()];
      this._childrenStyles.push(entry);
    }
    const own = entry[1]?.trim().replace(/;$/, '');
    actor.set_style(own ? `${own}; ${extra}` : extra);
  }

  private _syncText(): void {
    if (!this._glass || !this._settings.get_boolean(this._key('enable-adaptive-text-color'))) {
      this._text.clear();
      return;
    }
    this._text.start(this._settings.get_int(this._key('sample-interval-ms')),
      sanitizeColorPreference(this._settings.get_string(this._key('adaptive-text-preference'))));
  }

  private _textRoots(): Clutter.Actor[] {
    return this._sections().filter(box => box.mapped);
  }

  // Visible child extent in bar coordinates.
  private _boxExtent(box: Clutter.Actor): number[] | null {
    let x0 = Infinity, x1 = -Infinity;
    // A section may sit inside another box (Multi Monitors Bar's center row).
    let bx = 0;
    for (let actor: Clutter.Actor | null = box; actor && actor !== this._panel; actor = actor.get_parent())
      bx += actor.get_position()[0];
    for (const child of box.get_children()) {
      if (!child.visible || child.width < 1) continue;
      const alloc = child.get_allocation_box();
      x0 = Math.min(x0, bx + alloc.x1);
      x1 = Math.max(x1, bx + alloc.x2);
    }
    return x1 > x0 ? [x0, x1] : null;
  }

  // Sync the glass beneath the panel, hiding it with the bar.
  private _sync(): void {
    // Lays the stage out now if this bar waits for it, so the reads below see allocations. On a bar queued for
    // relayout, size getters re-measure part of its tree mid-frame, and Multi Monitors Bar's mirrored buttons then
    // miss their next resize.
    const panelAllocation = this._panel.get_allocation_box();
    // Modal overlays may suppress leave-event; reconcile hover each frame.
    this._syncForwardedHover();
    const glass = this._glass!;
    const panelBox = this._panelBox;
    const panel = this._panel;
    const shown = panelBox.visible && panelBox.mapped && panel.mapped;
    if (!shown) {
      if (glass.visible) glass.hide();
      return;
    }
    if (!glass.visible) glass.show();
    glass.opacity = Math.round(panelBox.opacity * panel.opacity / 255);

    const [x, y] = panelBox.get_transformed_position();
    const width = Math.round(panelBox.allocation.get_width());
    const height = Math.round(panelAllocation.get_height());
    if (!Number.isFinite(x) || !Number.isFinite(y) || width < 1 || height < 1) return;

    const { top, bottom } = this._margin;
    const pillHeight = height - top - bottom;
    let left = this._margin.left, right = width - this._margin.right;
    if (this._style === 'center') {
      const barWidth = this._fitCenteredWidth(width);
      // Where panelBox puts the bar once it lays out this frame, so the glass does not lag a frame behind.
      left += Math.floor((width - barWidth) / 2);
      right = left - this._margin.left + barWidth - this._margin.right;
    }
    const rects: number[][] = [];
    const textAnimating = this._style === 'islands' && this._text.isAnimating();
    if (textAnimating) this._islandGeometryHoldFrames = 4;
    else if (this._islandGeometryHoldFrames > 0) this._islandGeometryHoldFrames--;
    const holdIslandGeometry = textAnimating || this._islandGeometryHoldFrames > 0;
    if (this._style === 'pill' || this._style === 'center') {
      rects.push([left, top, right - left, pillHeight]);
    } else if (holdIslandGeometry && this._lastIslandRects.length > 0) {
      // Text tweens can briefly disturb allocations; hold island geometry steady until they settle.
      rects.push(...this._lastIslandRects.map(rect => [...rect]));
    } else {
      for (const box of this._sections()) {
        const extent = this._boxExtent(box);
        if (!extent) continue;
        const x0 = Math.max(extent[0] - this._padding.left, left);
        const x1 = Math.min(extent[1] + this._padding.right, right);
        if (x1 > x0) rects.push([x0, top, x1 - x0, pillHeight]);
      }
    }
    if (this._style === 'islands' && !holdIslandGeometry) {
      this._lastIslandRects = rects.map(rect => [...rect]);
    } else if (this._style === 'islands' && this._lastIslandRects.length === 0 && rects.length > 0) {
      this._lastIslandRects = rects.map(rect => [...rect]);
    }

    const key = `${x},${y},${width},${height},${rects.flat().join(',')}`;
    if (key !== this._lastKey) {
      this._lastKey = key;
      glass.set_position(x, y);
      glass.set_size(width, height + SHADOW_ROOM);
      glass.setResolution(width, height + SHADOW_ROOM);
      const p = SHADER_PADDING;
      if (this._style !== 'islands') {
        const [rx, ry, rw, rh] = rects[0];
        glass.setGlassGeometry(rx - p, ry - p, rw + p * 2, rh + p * 2);
      } else {
        const regions: GlassRegion[] = rects.map(([rx, ry, rw, rh]) => ({
          x: rx - p, y: ry - p, w: rw + p * 2, h: rh + p * 2, tintR: 1, tintG: 1, tintB: 1,
        }));
        glass.setGlassRegions(regions);
        glass.setGlassGeometry(0, 0, width, height);
      }
      this._text.invalidate();
    }
    glass.syncSources();
  }

  private _fitCenteredWidth(maxWidth: number): number {
    const panel = this._panel;
    const natural = (box: St.Widget) => box.get_preferred_width(-1)[1];
    // Panel adds the work area's offset when it centers its middle box, as for a dock fixed to a side.
    const monitor = Main.layoutManager.findMonitorForActor(panel);
    let centerOffset = 0;
    if (monitor) {
      const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
      centerOffset = 2 * (workArea.x - monitor.x) + workArea.width - monitor.width;
    }
    const barWidth = Math.min(maxWidth,
      centeredBarWidth(natural(panel._leftBox), natural(panel._centerBox), natural(panel._rightBox), centerOffset));
    if (barWidth !== this._centeredWidth) {
      this._centeredWidth = barWidth;
      panel.width = barWidth;
    }
    return barWidth;
  }

  private _remove(): void {
    stopStageLoop(this._frameSignalSlot, this._frameSlot);
    this._text.clear();
    const glass = this._glass;
    this._glass = null;
    this._disconnectBoxSignals();
    this._disconnectContainerSignals();
    if (glass) {
      glass.cleanup();
      if (isActorValid(glass)) glass.destroy();
      this._panel.remove_style_class_name('liquid-glass-transparent');
    }
    if (this._panelStyleId) this._panel.disconnect(this._panelStyleId);
    this._panelStyleId = 0;
    if (this._style === 'center') {
      this._panel.width = -1;
      this._panel.x_align = this._savedXAlign;
      this._centeredWidth = 0;
      if (this._owner === 'top-bar')
        (Main.panel.statusArea.quickSettings.menu as unknown as ArrowAlignedMenu)._arrowAlignment = this._savedQuickSettingsAlignment;
    }
    for (const [actor, style] of this._savedStyles)
      if (isActorValid(actor)) actor.set_style(style);
    for (const [actor, style] of this._childrenStyles)
      if (isActorValid(actor)) actor.set_style(style);
    this._savedStyles = [];
    this._childrenStyles = [];
    this._lastIslandRects = [];
    this._islandGeometryHoldFrames = 0;
    this._style = 'off';
  }

  cleanup(): void {
    for (const id of this._settingsIds) this._settings.disconnect(id);
    this._settingsIds = [];
    this._remove();
  }

  private get _frameSlot() {
    return { get: () => this._frameSyncId, set: (id: number) => { this._frameSyncId = id; } };
  }

  private get _frameSignalSlot() {
    return { get: () => this._frameSignalId, set: (id: number) => { this._frameSignalId = id; } };
  }
}
