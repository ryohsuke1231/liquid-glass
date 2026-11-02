import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { MonitorGroup } from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';

import { isActorValid } from '../actors.js';
import { addBeforeRedraw, removeBeforeRedraw, startSyncLoop, stopStageLoop } from '../animation.js';
import type { Logger } from '../logger.js';
import { MENU_ANIMATION, type CursorShape, canCloneSource, resetHoverCursor, setHoverCursor } from '../shellVersion.js';
import { UIManager } from '../uiManager.js';
import { type DesktopItem, type ItemEnv, WeatherWidget, EventsWidget, MediaWidget } from './widgets.js';
import {
  type Anchor, type Rect, parseAnchors, parsePositions, placeAtFraction, fractionOf, sanitizeAnchor, stackAt,
  stackColumns, type Guide, snapMove, type HandleSide, placeBeside, resizeRect
} from './placement.js';
import { GlassClock } from './clock.js';

export const WIDGET_IDS = ['weather', 'events', 'media'] as const;

// The fields of the workspace switch animation's groups that the shell's typings leave out. Each workspace group
// draws its wallpaper and desktop windows in `_background`.
type SwitchMonitorGroup = MonitorGroup & {
  _monitor: { x: number, y: number },
  _workspaceGroups: { workspace: Meta.Workspace, _background: Clutter.Actor }[],
};

const ANCHOR_NAMES: [Anchor, string][] = [
  ['top-left', 'Top Left'], ['top-right', 'Top Right'], ['bottom-left', 'Bottom Left'], ['bottom-right', 'Bottom Right'],
  ['center', 'Center'],
];

/**
 * The glass clock and the desktop widgets, above the wallpaper and below
 * every window, so they are hidden with the windows in the overview. Each
 * sits at a corner or the center of the primary monitor's work area, stacked
 * with the others there, unless the user moved it somewhere else. A right
 * click on one opens its menu, from which it can be moved (and the clock
 * resized). They can be kept to the first workspace.
 */
export class DesktopLayer {
  private _container: St.Widget | null = null;
  private _items = new Map<string, DesktopItem>();
  private _settingsIds: number[] = [];
  private _signals: { target: any, id: number }[] = [];
  private _frameSyncId = 0;
  private _frameSignalId = 0;
  private _needsLayout = true;
  private _layoutLaterId = 0;
  private _env: ItemEnv;
  private _menu: PopupMenu.PopupMenu | null = null;
  private _menuManager: PopupMenu.PopupMenuManager | null = null;
  private _menuGlass: UIManager | null = null;
  private _edit: EditFrame | null = null;

  constructor(private _path: string, private _settings: Gio.Settings, private _logger: Logger,
              private _openPreferences: () => void) {
    this._env = {
      path: _path, settings: _settings, logger: _logger,
      menu: (item, x, y) => this._openMenu(item, x, y),
      relayout: () => this._queueLayout(),
    };
  }

  setup(): void {
    const watch = (key: string, fn: () => void) => this._settingsIds.push(this._settings.connect(`changed::${key}`, fn));
    for (const key of ['enable-desktop-widgets', 'desktop-widgets', 'enable-glass-clock'])
      watch(key, () => this._sync());
    for (const key of ['desktop-widgets-position', 'glass-clock-position', 'desktop-item-positions', 'desktop-widget-anchors'])
      watch(key, () => this._queueLayout());
    watch('desktop-items-first-workspace-only', () => this._syncWorkspace());
    this._sync();
  }

  private _wanted(): string[] {
    const ids: string[] = [];
    if (this._settings.get_boolean('enable-glass-clock')) ids.push('clock');
    if (this._settings.get_boolean('enable-desktop-widgets')) {
      const chosen = new Set(this._settings.get_strv('desktop-widgets'));
      ids.push(...WIDGET_IDS.filter(id => chosen.has(id)));
    }
    return ids;
  }

  private _create(id: string): DesktopItem {
    switch (id) {
    case 'clock': return new GlassClock(this._env);
    case 'weather': return new WeatherWidget(this._env);
    case 'events': return new EventsWidget(this._env);
    default: return new MediaWidget(this._env);
    }
  }

  private _sync(): void {
    const wanted = this._wanted();
    for (const [id, item] of this._items) {
      if (wanted.includes(id)) continue;
      if (this._edit?.item === item) this._edit.end();
      item.destroy();
      this._items.delete(id);
    }
    if (wanted.length === 0) {
      this._removeContainer();
      return;
    }
    this._ensureContainer();
    for (const id of wanted) {
      if (this._items.has(id)) continue;
      const item = this._create(id);
      this._items.set(id, item);
      this._container!.add_child(item.actor);
    }
    this._queueLayout();
  }

  private _ensureContainer(): void {
    if (this._container) return;
    const container = new St.Widget({ name: 'liquid-glass-desktop', x: 0, y: 0 });
    this._container = container;
    (Main.layoutManager as any)._backgroundGroup.add_child(container);
    this._restack();
    const relayout = () => {
      this._edit?.end();
      this._queueLayout();
    };
    this._signals.push({ target: Main.layoutManager, id: Main.layoutManager.connect('monitors-changed', relayout) });
    this._signals.push({ target: global.display, id: global.display.connect('workareas-changed', relayout) });
    this._signals.push({ target: Main.overview, id: Main.overview.connect('showing', () => this._edit?.end()) });
    this._signals.push({
      target: global.workspace_manager, id: global.workspace_manager.connect('active-workspace-changed', () => {
        this._edit?.end();
        this._syncWorkspace();
      }),
    });
    // The workspace switch animation covers the desktop with pictures of the workspaces until it ends.
    this._signals.push({ target: Main.uiGroup, id: Main.uiGroup.connect('child-added', (_group, actor) => this._addToSwitch(actor)) });
    this._signals.push({
      target: Main.uiGroup, id: Main.uiGroup.connect('child-removed', (_group, actor) => {
        if (actor instanceof MonitorGroup) this._syncWorkspace();
      }),
    });
    // Mutter restacks the windows without telling; this runs before every
    // frame is drawn, so the items are back in place before anyone sees them.
    this._signals.push({ target: global.stage, id: global.stage.connect('before-update', () => this._restack()) });
    startSyncLoop(this._frameSignalSlot, this._frameSlot, {
      alive: () => !!this._container,
      honourFreeze: true,
      errorTag: 'DesktopLayer',
      step: () => this._step(),
    });

    const menu = new PopupMenu.PopupMenu(Main.layoutManager.dummyCursor, 0, St.Side.TOP);
    Main.layoutManager.uiGroup.add_child(menu.actor);
    menu.actor.hide();
    this._menu = menu;
    this._menuManager = new PopupMenu.PopupMenuManager(container);
    this._menuManager.addMenu(menu);
    this._menuGlass = new UIManager(this._path, this._settings, this._logger, { menu }, false,
      'enable-extra-menu-glass', 'panel-menu', 'menu:desktop', false, 'desktop-widget-menu-animation');
    this._menuGlass.setup();
    this._syncWorkspace();
  }

  private _firstWorkspaceOnly(): boolean {
    return this._settings.get_boolean('desktop-items-first-workspace-only');
  }

  private _syncWorkspace(): void {
    if (this._container)
      this._container.visible = !this._firstWorkspaceOnly() || global.workspace_manager.get_active_workspace_index() === 0;
  }

  // Puts a clone of the items on each workspace's wallpaper in the switch animation, so they move with it instead of
  // disappearing under it. The clones draw their glass with the backdrop it last copied, which is the same wallpaper.
  private _addToSwitch(actor: Clutter.Actor): void {
    const container = this._container;
    if (!container || !(actor instanceof MonitorGroup) || !canCloneSource(container)) return;
    const group = actor as SwitchMonitorGroup;
    const firstOnly = this._firstWorkspaceOnly();
    let cloned = false;
    for (const { workspace, _background: background } of group._workspaceGroups) {
      if (firstOnly && workspace.index() !== 0) continue;
      background.add_child(new Clutter.Clone({
        source: container, x: -group._monitor.x, y: -group._monitor.y, width: container.width, height: container.height,
      }));
      cloned = true;
    }
    // A hidden source would be mapped and unmapped by every clone paint. The animation covers the items until it
    // ends, and child-removed hides them again.
    if (cloned) container.show();
  }

  private _removeContainer(): void {
    this._edit?.end();
    stopStageLoop(this._frameSignalSlot, this._frameSlot);
    removeBeforeRedraw(this._layoutLaterId);
    this._layoutLaterId = 0;
    for (const { target, id } of this._signals) target.disconnect(id);
    this._signals = [];
    this._menuGlass?.cleanup();
    this._menuGlass = null;
    this._menu?.destroy();
    this._menu = null;
    this._menuManager = null;
    const container = this._container;
    this._container = null;
    if (container && isActorValid(container)) container.destroy();
  }

  // The topmost window of desktop icons (DING and the like): it covers the
  // whole desktop and would take every click meant for the items. DING hides
  // its window from global.get_window_actors(), hence the window group.
  private _desktopWindow(): Clutter.Actor | null {
    let top: Clutter.Actor | null = null;
    for (const actor of global.window_group.get_children()) {
      if (!(actor instanceof Meta.WindowActor)) continue;
      const window = actor.get_meta_window() as any;
      if (window && (window.customJS_ding || window.get_window_type() === Meta.WindowType.DESKTOP)) top = actor;
    }
    return top;
  }

  // Right above the desktop icons' window when there is one, so the items
  // get the pointer; otherwise on top of the wallpaper.
  private _restack(): void {
    const container = this._container;
    if (!container) return;
    const icons = this._desktopWindow();
    const parent: Clutter.Actor = icons ? global.window_group : (Main.layoutManager as any)._backgroundGroup;
    if (container.get_parent() !== parent) {
      container.get_parent()?.remove_child(container);
      parent.add_child(container);
    }
    if (icons) {
      if (container.get_previous_sibling() !== icons) parent.set_child_above_sibling(container, icons);
    } else if (container.get_next_sibling()) {
      parent.set_child_above_sibling(container, null);
    }
  }

  // Lays the items out before the next frame, and makes sure there is one.
  private _queueLayout(): void {
    this._needsLayout = true;
    if (this._layoutLaterId || !this._container) return;
    this._layoutLaterId = addBeforeRedraw(() => {
      this._layoutLaterId = 0;
      if (this._container) this._step();
      return GLib.SOURCE_REMOVE;
    });
  }

  private _step(): void {
    for (const item of this._items.values()) {
      if (item.sync()) this._needsLayout = true;
    }
    if (this._needsLayout) {
      this._needsLayout = false;
      this._layout();
    }
    this._edit?.sync();
  }

  private _workArea(): Rect {
    return Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
  }

  private _anchorOf(id: string): Anchor {
    if (id === 'clock') return sanitizeAnchor(this._settings.get_string('glass-clock-position'), 'center');
    return parseAnchors(this._settings.get_string('desktop-widget-anchors'))[id] ??
      sanitizeAnchor(this._settings.get_string('desktop-widgets-position'));
  }

  // Places every item: where it was moved to, or stacked at its anchor.
  private _layout(): void {
    const area = this._workArea();
    const moved = parsePositions(this._settings.get_string('desktop-item-positions'));
    const stacks = new Map<Anchor, DesktopItem[]>();
    const movedItems: { item: DesktopItem, saved: Rect, size: [number, number], shown: boolean }[] = [];
    for (const [id, item] of this._items) {
      // The frame holds the item while it is being dragged.
      if (this._edit?.dragging && this._edit.item === item) continue;
      const fraction = moved[id];
      // A hidden item still counts for which of the others sit in its column.
      if (fraction) {
        const [w, h] = item.size();
        const [x, y] = placeAtFraction([fraction[0], fraction[1]], area, [w, fraction[2] ?? h]);
        movedItems.push({ item, saved: { x, y, width: w, height: fraction[2] ?? h }, size: [w, h], shown: item.shown });
        continue;
      }
      if (!item.shown) continue;
      const anchor = this._anchorOf(id);
      if (!stacks.has(anchor)) stacks.set(anchor, []);
      stacks.get(anchor)!.push(item);
    }
    const positions = stackColumns(movedItems, area);
    movedItems.forEach(({ item, shown }, i) => {
      if (shown) item.actor.set_position(...positions[i]);
    });
    for (const [anchor, items] of stacks) {
      const stacked = stackAt(anchor, area, items.map(item => item.size()));
      items.forEach((item, i) => item.actor.set_position(...stacked[i]));
    }
  }

  private _savePosition(item: DesktopItem, pos: [number, number], size: [number, number]): void {
    const positions = parsePositions(this._settings.get_string('desktop-item-positions'));
    positions[item.id] = [...fractionOf(pos, this._workArea(), size), size[1]];
    this._settings.set_string('desktop-item-positions', JSON.stringify(positions));
  }

  private _resetPosition(id: string): void {
    const positions = parsePositions(this._settings.get_string('desktop-item-positions'));
    delete positions[id];
    this._settings.set_string('desktop-item-positions', JSON.stringify(positions));
  }

  // Puts an item back in the stack at `anchor`. A widget alone gets its own
  // anchor; the others keep the one they share.
  private _placeAt(id: string, anchor: Anchor): void {
    if (id === 'clock') {
      this._settings.set_string('glass-clock-position', anchor);
    } else {
      const anchors = parseAnchors(this._settings.get_string('desktop-widget-anchors'));
      anchors[id] = anchor;
      this._settings.set_string('desktop-widget-anchors', JSON.stringify(anchors));
    }
    this._resetPosition(id);
  }

  private _openMenu(item: DesktopItem, x: number, y: number): void {
    const menu = this._menu;
    if (!menu || this._edit) return;
    menu.removeAll();
    const clock = item instanceof GlassClock ? item : null;
    menu.addAction(clock ? 'Move and Resize' : 'Move', () => this._startEdit(item));
    if (clock?.resized) menu.addAction('Reset Size', () => clock.resetSize());
    const moved = item.id in parsePositions(this._settings.get_string('desktop-item-positions'));
    const position = new PopupMenu.PopupSubMenuMenuItem('Position', false);
    const current = this._anchorOf(item.id);
    for (const [anchor, name] of ANCHOR_NAMES) {
      const entry = position.menu.addAction(name, () => this._placeAt(item.id, anchor));
      entry.setOrnament(!moved && anchor === current ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
    }
    menu.addMenuItem(position);
    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    menu.addAction('Desktop Settings', () => this._openPreferences());
    Main.layoutManager.setDummyCursorGeometry(x, y, 0, 0);
    menu.open(MENU_ANIMATION);
  }

  private _startEdit(item: DesktopItem): void {
    if (this._edit || !this._items.has(item.id)) return;
    const clock = item instanceof GlassClock ? item : null;
    const edit = new EditFrame(item, {
      moved: (x, y) => this._savePosition(item, [x, y], item.size()),
      resized: clock ? (from, to) => this._resized(clock, from, to) : undefined,
      others: () => [...this._items.values()].filter(other => other !== item && other.shown).map(itemRect),
      ended: () => {
        if (this._edit === edit) this._edit = null;
      },
    });
    this._edit = edit;
    edit.start();
  }

  // Keeps the clock's center where the resized frame's is, as far as the
  // frame and the clock's shown part differ.
  private _resized(clock: GlassClock, from: Rect, to: Rect): void {
    const sx = to.width / from.width;
    const sy = to.height / from.height;
    const [w, h] = clock.size();
    const [bx, by, bw, bh] = clock.bounds();
    const size: [number, number] = [w * sx, h * sy];
    const center = [to.x + to.width / 2 + (w / 2 - bx - bw / 2) * sx, to.y + to.height / 2 + (h / 2 - by - bh / 2) * sy];
    this._savePosition(clock, [center[0] - size[0] / 2, center[1] - size[1] / 2], size);
    clock.resizeBy(sx, sy);
  }

  cleanup(): void {
    for (const id of this._settingsIds) this._settings.disconnect(id);
    this._settingsIds = [];
    this._edit?.end();
    for (const item of this._items.values()) item.destroy();
    this._items.clear();
    this._removeContainer();
  }

  private get _frameSlot() {
    return { get: () => this._frameSyncId, set: (id: number) => { this._frameSyncId = id; } };
  }

  private get _frameSignalSlot() {
    return { get: () => this._frameSignalId, set: (id: number) => { this._frameSignalId = id; } };
  }
}

// Room between the item and its frame, px.
const FRAME_GAP = 8;
const HANDLE_SIZE = 14;
// How far (px) from a handle's center a press still takes it.
const HANDLE_REACH = 12;
// The smallest the frame can be resized to, px.
const MIN_SIZE = 48;
// A moved item this near (px) to a guide goes onto it.
const SNAP_REACH = 6;
// How thick a guide is drawn, and how long the ticks at the ends of a gap are, px.
const GUIDE_WIDTH = 2;
const GAP_TICK = 9;

// The handles: which edges each one moves, and its cursor.
const HANDLES: [HandleSide, HandleSide, CursorShape][] = [
  [-1, -1, 'nw'], [0, -1, 'n'], [1, -1, 'ne'], [1, 0, 'e'],
  [1, 1, 'se'], [0, 1, 's'], [-1, 1, 'sw'], [-1, 0, 'w'],
];

export interface EditCallbacks {
  // The item was moved to (x, y), its actor's top left corner in stage coordinates.
  moved: (x: number, y: number) => void;
  // The item's shown part was resized from `from` to `to`, stage coordinates.
  resized?: (from: Rect, to: Rect) => void;
  // The shown parts of the other items, stage coordinates, to line the item up with.
  others: () => Rect[];
  // The frame is gone.
  ended: () => void;
}

interface Drag {
  start: [number, number];
  origin: [number, number];
  rect: Rect;
  hx: HandleSide;
  hy: HandleSide;
}

/**
 * A blue frame round a desktop item, over everything else, that moves the
 * item when dragged and resizes it by its handles (when `resized` is given).
 * It holds the pointer and keyboard until Escape, Enter, the Done button or
 * a click outside it.
 */
export class EditFrame {
  private _layer: St.Widget;
  private _frame: St.Widget;
  private _handles: St.Widget[] = [];
  private _done: St.Button;
  private _grab: any = null;
  private _drag: Drag | null = null;
  // The frame being resized, while it is.
  private _resizing: Rect | null = null;
  // Drawn guides, reused from one move to the next, and what each one shows.
  private _guideActors: St.DrawingArea[] = [];
  private _guides: Guide[] = [];

  constructor(readonly item: DesktopItem, private _callbacks: EditCallbacks) {
    this._layer = new St.Widget({ name: 'liquid-glass-edit', reactive: true, x: 0, y: 0 });
    this._layer.set_size(global.stage.width, global.stage.height);
    this._frame = new St.Widget({ style_class: 'liquid-glass-edit-frame', reactive: true });
    setHoverCursor(this._frame, 'move');
    this._layer.add_child(this._frame);
    if (_callbacks.resized) {
      for (const [, , cursor] of HANDLES) {
        const handle = new St.Widget({
          style_class: 'liquid-glass-edit-handle', reactive: true,
          width: HANDLE_SIZE, height: HANDLE_SIZE
        });
        setHoverCursor(handle, cursor);
        this._layer.add_child(handle);
        this._handles.push(handle);
      }
    }
    this._done = new St.Button({ style_class: 'liquid-glass-edit-done', label: 'Done', can_focus: true });
    this._done.connect('clicked', () => this.end());
    this._layer.add_child(this._done);

    // Presses are told apart by where they are, not by the actor they reach:
    // the actor under the pointer is only looked up again when the stage is
    // redrawn, and the handles move with the item.
    this._layer.connect('button-press-event', (_a: Clutter.Actor, event: Clutter.Event) => this._press(event));
    this._layer.connect('motion-event', (_a: Clutter.Actor, event: Clutter.Event) => this._motion(event));
    this._layer.connect('button-release-event', (_a: Clutter.Actor, event: Clutter.Event) => this._release(event));
    this._layer.connect('key-press-event', (_a: Clutter.Actor, event: Clutter.Event) => {
      const key = event.get_key_symbol();
      if (key !== Clutter.KEY_Escape && key !== Clutter.KEY_Return && key !== Clutter.KEY_KP_Enter)
        return Clutter.EVENT_PROPAGATE;
      this.end();
      return Clutter.EVENT_STOP;
    });
  }

  get dragging(): boolean {
    return this._drag !== null;
  }

  start(): void {
    Main.layoutManager.uiGroup.add_child(this._layer);
    this._grab = Main.pushModal(this._layer, { actionMode: Shell.ActionMode.POPUP });
    this.sync();
  }

  // The frame round the item, or round the size it is being resized to.
  private _frameRect(): Rect {
    const r = this._resizing ?? itemRect(this.item);
    const g = FRAME_GAP;
    return { x: r.x - g, y: r.y - g, width: r.width + g * 2, height: r.height + g * 2 }; // Rect that includes FRAME_GAP
  }

  private _handleCenter(f: Rect, hx: HandleSide, hy: HandleSide): [number, number] {
    return [f.x + (hx + 1) / 2 * f.width, f.y + (hy + 1) / 2 * f.height]; // Maps handle side (-1, 0, 1) to position ratio (0, 0.5, 1). And then calculates the center of the handle.
  }

  sync(): void {
    const f = this._frameRect();
    this._frame.set_position(Math.round(f.x), Math.round(f.y));
    this._frame.set_size(Math.round(f.width), Math.round(f.height));
    const half = HANDLE_SIZE / 2;
    HANDLES.forEach(([hx, hy], i) => {
      const [cx, cy] = this._handleCenter(f, hx, hy);
      this._handles[i]?.set_position(Math.round(cx - half), Math.round(cy - half));
    });
    const [, doneW] = this._done.get_preferred_width(-1);
    const [, doneH] = this._done.get_preferred_height(doneW);
    this._done.set_position(...placeBeside(f, [doneW, doneH], HANDLE_SIZE, this._workArea(f), this._docks()));
  }

  private _showGuides(guides: Guide[]): void {
    this._guides = guides;
    while (this._guideActors.length < guides.length) {
      const actor = new St.DrawingArea({ style_class: 'liquid-glass-edit-guide' });
      const index = this._guideActors.length;
      actor.connect('repaint', () => this._drawGuide(actor, this._guides[index]));
      this._layer.insert_child_below(actor, this._frame);
      this._guideActors.push(actor);
    }
    this._guideActors.forEach((actor, i) => {
      const g = guides[i];
      actor.visible = !!g;
      if (!g) return;
      const thick = g.kind === 'spacing' ? GAP_TICK : GUIDE_WIDTH;
      const at = Math.round(g.at - thick / 2), from = Math.round(g.from), length = Math.max(Math.round(g.to - g.from), 1);
      if (g.vertical) {
        actor.set_position(at, from);
        actor.set_size(thick, length);
      } else {
        actor.set_position(from, at);
        actor.set_size(length, thick);
      }
      actor.queue_repaint();
    });
  }

  // A dotted line along the guide; a gap also gets a tick across each end.
  private _drawGuide(actor: St.DrawingArea, g: Guide | undefined): void {
    if (!g) return;
    const cr = actor.get_context();
    const [w, h] = actor.get_surface_size();
    const color = actor.get_theme_node().get_foreground_color();
    cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255);
    cr.setLineWidth(GUIDE_WIDTH);
    const [long, across] = g.vertical ? [h, w] : [w, h];
    const line = (a0: number, b0: number, a1: number, b1: number) => {
      if (g.vertical) {
        cr.moveTo(b0, a0);
        cr.lineTo(b1, a1);
      } else {
        cr.moveTo(a0, b0);
        cr.lineTo(a1, b1);
      }
    };
    if (g.kind === 'spacing') {
      line(GUIDE_WIDTH / 2, 0, GUIDE_WIDTH / 2, across);
      line(long - GUIDE_WIDTH / 2, 0, long - GUIDE_WIDTH / 2, across);
      cr.stroke();
    }
    cr.setDash([4, 4], 0);
    line(0, across / 2, long, across / 2);
    cr.stroke();
    cr.$dispose();
  }

  // The work area of the monitor the frame's center is on.
  private _workArea(f: Rect): Rect {
    const cx = f.x + f.width / 2, cy = f.y + f.height / 2;
    const layout = Main.layoutManager;
    const monitor = layout.monitors.find(m => cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height);
    return layout.getWorkAreaForMonitor(monitor?.index ?? layout.primaryIndex);
  }

  // Returns the docks' rects. One that hides itself leaves the work area as it is
  // but still covers the Done button when it slides in.
  private _docks(): Rect[] {
    const dockNames = ['dashtodockContainer', 'DhruvaContainer'];
    return Main.layoutManager.uiGroup.get_children()
      .filter(actor => dockNames.includes(actor.get_name() ?? '') && actor.visible)
      .map(actor => {
        const [x, y] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();
        return { x, y, width, height };
      });
  }

  // What a press at (x, y) takes: the handle there [hx, hy], the frame
  // [0, 0], or nothing.
  private _hit(x: number, y: number): [HandleSide, HandleSide] | null {
    const f = this._frameRect();
    for (let i = 0; i < this._handles.length; i++) {
      const [cx, cy] = this._handleCenter(f, HANDLES[i][0], HANDLES[i][1]);
      if (Math.abs(x - cx) <= HANDLE_REACH && Math.abs(y - cy) <= HANDLE_REACH)
        return [HANDLES[i][0], HANDLES[i][1]];
    }
    return x >= f.x && x < f.x + f.width && y >= f.y && y < f.y + f.height ? [0, 0] : null;
  }

  private _press(event: Clutter.Event): boolean {
    if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_STOP;
    const [x, y] = event.get_coords();
    const hit = this._hit(x, y);
    if (!hit) {
      this.end();
      return Clutter.EVENT_STOP;
    }
    this._drag = { start: [x, y], origin: itemOrigin(this.item), rect: itemRect(this.item), hx: hit[0], hy: hit[1] };
    return Clutter.EVENT_STOP;
  }

  private _motion(event: Clutter.Event): boolean {
    const drag = this._drag;
    if (!drag) return Clutter.EVENT_PROPAGATE;
    const [x, y] = event.get_coords();
    const dx = x - drag.start[0], dy = y - drag.start[1];
    if (drag.hx === 0 && drag.hy === 0) {
      const [px, py] = this.item.actor.get_parent()!.get_transformed_position();
      const moved = { ...drag.rect, x: drag.rect.x + dx, y: drag.rect.y + dy };
      const snap = snapMove(moved, this._callbacks.others(), this._workArea(moved), SNAP_REACH);
      this.item.actor.set_position(Math.round(drag.origin[0] + dx + snap.dx - px),
        Math.round(drag.origin[1] + dy + snap.dy - py));
      this._showGuides(snap.guides);
    } else {
      this._resizing = resizeRect(drag.rect, drag.hx, drag.hy, dx, dy, MIN_SIZE);
    }
    this.sync();
    return Clutter.EVENT_STOP;
  }

  private _release(event: Clutter.Event): boolean {
    const drag = this._drag;
    if (!drag || event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
    this._drag = null;
    this._showGuides([]);
    const resized = this._resizing;
    this._resizing = null;
    if (resized) this._callbacks.resized?.(drag.rect, resized);
    else this._callbacks.moved(...itemOrigin(this.item));
    this.sync();
    return Clutter.EVENT_STOP;
  }

  /** Takes the frame away. */
  end(): void {
    if (this._grab) {
      Main.popModal(this._grab);
      this._grab = null;
    }
    if (isActorValid(this._layer)) this._layer.destroy();
    resetHoverCursor();
    this._callbacks.ended();
  }
}

// An item's top left corner, stage coordinates. Its x and y, not its
// allocation, which lags a frame behind a new position.
function itemOrigin(item: DesktopItem): [number, number] {
  const [px, py] = item.actor.get_parent()!.get_transformed_position();
  return [px + item.actor.x, py + item.actor.y];
}

/** An item's shown part, stage coordinates. */
export function itemRect(item: DesktopItem): Rect {
  const [x, y] = itemOrigin(item);
  const [bx, by, width, height] = item.bounds();
  return { x: x + bx, y: y + by, width, height };
}
