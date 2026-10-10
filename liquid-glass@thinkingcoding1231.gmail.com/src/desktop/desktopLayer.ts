import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import { isActorValid } from '../actors/lifecycle.js';
import { addBeforeRedraw, removeBeforeRedraw, startSyncLoop, stopStageLoop } from '../animation/frameLoops.js';
import type { Logger } from '../logger.js';
import { MENU_ANIMATION } from '../shellVersion.js';
import { UIManager } from '../uiManager.js';
import { type DesktopItem, type ItemEnv } from './desktopItem.js';
import { EditFrame, itemRect } from './editFrame.js';
import { type Anchor, type Rect, parseAnchors, parsePositions, placeAtFraction, fractionOf, sanitizeAnchor, stackAt } from './placement.js';
import { WeatherWidget } from './weather.js';
import { EventsWidget } from './events.js';
import { MediaWidget } from './media.js';
import { GlassClock } from './clock.js';

export const WIDGET_IDS = ['weather', 'events', 'media'] as const;

const ANCHOR_NAMES: [Anchor, string][] = [
  ['top-left', 'Top Left'], ['top-right', 'Top Right'], ['bottom-left', 'Bottom Left'], ['bottom-right', 'Bottom Right'],
  ['center', 'Center'],
];

/**
 * The glass clock and the desktop widgets, above the wallpaper and below
 * every window, so they are hidden with the windows in the overview. Each
 * sits at a corner or the centre of the primary monitor's work area, stacked
 * with the others there, unless the user moved it somewhere else. A right
 * click on one opens its menu, from which it can be moved (and the clock
 * resized).
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
      'enable-extra-menu-glass', 'panel-menu', 'menu:desktop', false);
    this._menuGlass.setup();
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
    for (const [id, item] of this._items) {
      if (!item.shown) continue;
      // The frame holds the item while it is being dragged.
      if (this._edit?.dragging && this._edit.item === item) continue;
      const fraction = moved[id];
      if (fraction) {
        item.actor.set_position(...placeAtFraction(fraction, area, item.size()));
        continue;
      }
      const anchor = this._anchorOf(id);
      if (!stacks.has(anchor)) stacks.set(anchor, []);
      stacks.get(anchor)!.push(item);
    }
    for (const [anchor, items] of stacks) {
      const positions = stackAt(anchor, area, items.map(item => item.size()));
      items.forEach((item, i) => item.actor.set_position(...positions[i]));
    }
  }

  private _savePosition(item: DesktopItem, pos: [number, number], size: [number, number]): void {
    const positions = parsePositions(this._settings.get_string('desktop-item-positions'));
    positions[item.id] = fractionOf(pos, this._workArea(), size);
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

  // Keeps the clock's centre where the resized frame's is, as far as the
  // frame and the clock's shown part differ.
  private _resized(clock: GlassClock, from: Rect, to: Rect): void {
    const sx = to.width / from.width;
    const sy = to.height / from.height;
    const [w, h] = clock.size();
    const [bx, by, bw, bh] = clock.bounds();
    const size: [number, number] = [w * sx, h * sy];
    const centre = [to.x + to.width / 2 + (w / 2 - bx - bw / 2) * sx, to.y + to.height / 2 + (h / 2 - by - bh / 2) * sy];
    this._savePosition(clock, [centre[0] - size[0] / 2, centre[1] - size[1] / 2], size);
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
