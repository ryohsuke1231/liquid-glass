import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import type Gio from 'gi://Gio';
import St from 'gi://St';

import { isActorValid } from './actors.js';
import { startSyncLoop, stopStageLoop } from './animation.js';
import { BarGrowth } from './barGrowth.js';

const TRANSPARENT = 'liquid-glass-transparent';
const DASH_NAME = 'dashtodockDashContainer';
// How often a dock is looked over again for items it added, while the pointer is on it (ms).
const RESCAN_MS = 1000;

/** Dash to Dock's dash `actor` is in, or null. */
export function dashOf(actor: Clutter.Actor | null): Clutter.Actor | null {
  for (let a = actor; a; a = a.get_parent())
    if (a.get_name() === DASH_NAME) return a;
  return null;
}

// A Dash to Dock item container, which owns a name label.
interface DockItem extends St.Widget {
  label: St.Label;
  child: Clutter.Actor | null;
  showLabel(): void;
  hideLabel(): void;
}

function dockItems(dash: Clutter.Actor): DockItem[] {
  const items: DockItem[] = [];
  const walk = (actor: any) => {
    if (actor.label instanceof St.Label && typeof actor.showLabel === 'function' && typeof actor.hideLabel === 'function') {
      items.push(actor);
      return;
    }
    for (const child of actor.get_children()) walk(child);
  };
  walk(dash);
  return items;
}

function actorRect(actor: Clutter.Actor | null): number[] | null {
  if (!actor || !isActorValid(actor) || !actor.mapped) return null;
  const [x, y] = actor.get_transformed_position();
  const [w, h] = actor.get_transformed_size();
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(w >= 1) || !(h >= 1)) return null;
  return [x, y, w, h];
}

/** The name label of one dock item, which grows out of the dock's glass in place of Dash to Dock's fade. */
class LabelGrowth {
  private _label: St.Label;
  private _growth: BarGrowth;
  private _drawn = false;
  showing = false;

  constructor(settings: Gio.Settings, private _item: DockItem, private _shown: (label: LabelGrowth) => void) {
    this._label = _item.label;
    this._growth = new BarGrowth({
      key: 'top-bar-menus-grow',
      content: () => (isActorValid(this._label) ? this._label : null),
      shown: () => isActorValid(this._label) && this._label.mapped,
      scale: () => 1,
      source: () => this._source(),
      button: () => actorRect(this._source()),
      expand: () => 0,
      radius: () => settings.get_double('panel-menu-corner-radius'),
      intervalMs: () => settings.get_int('panel-menu-animation-interval-ms'),
      speed: () => settings.get_double('panel-menu-morph-speed'),
      // The growth fades the label in and out itself.
      hold: () => this._label.remove_transition('opacity'),
      closed: () => {
        this._setDrawn(false);
        if (!this.showing && isActorValid(this._label)) this._label.hide();
      },
    });
    _item.showLabel = () => this._show();
    _item.hideLabel = () => this._hide();
  }

  private _source(): Clutter.Actor | null {
    const item = this._item;
    if (!isActorValid(item)) return null;
    return item.child && isActorValid(item.child) && item.child.mapped ? item.child : item;
  }

  private _show(): void {
    const animate = St.Settings.get().enable_animations;
    Object.getPrototypeOf(this._item).showLabel.call(this._item);
    this.showing = true;
    if (!isActorValid(this._label) || !this._label.visible) return;
    // Dash to Dock has started its fade, which the growth takes over.
    this._setDrawn(animate ? this._growth.start(true) : this._growth.holdAtRest());
    this._shown(this);
  }

  private _hide(): void {
    this.showing = false;
    if (this._growth.holding && St.Settings.get().enable_animations && isActorValid(this._label)) {
      this._label.remove_all_transitions();
      if (this._growth.start(false)) return;
    }
    this._growth.release();
    this._setDrawn(false);
    if (isActorValid(this._label)) Object.getPrototypeOf(this._item).hideLabel.call(this._item);
  }

  /** At rest, the glass follows the label and the dock, and lets the label go when the dock's glass goes. */
  sync(): void {
    if (!this.showing || !isActorValid(this._label) || !this._label.mapped) return;
    this._setDrawn(this._growth.holdAtRest());
  }

  // Whether the dock's glass is the label's background, rather than the theme's.
  private _setDrawn(drawn: boolean): void {
    if (drawn === this._drawn || !isActorValid(this._label)) return;
    this._drawn = drawn;
    if (drawn) this._label.add_style_class_name(TRANSPARENT);
    else this._label.remove_style_class_name(TRANSPARENT);
  }

  cleanup(): void {
    this._growth.release();
    this._setDrawn(false);
    if (isActorValid(this._item)) {
      delete (this._item as Partial<DockItem>).showLabel;
      delete (this._item as Partial<DockItem>).hideLabel;
    }
    if (!this.showing && isActorValid(this._label)) this._label.hide();
  }
}

/**
 * Makes the name labels of the docks' apps grow out of the dock's glass, as the dock's menus do, while
 * dock-menus-grow is on. A dock's items are hooked as the pointer comes onto it: moving from one app to the next,
 * Dash to Dock shows the next name at once.
 */
export class DockLabels {
  private _items = new Map<DockItem, { growth: LabelGrowth, destroyId: number }>();
  private _scanned = new WeakMap<Clutter.Actor, number>();
  private _showing = new Set<LabelGrowth>();
  private _eventId = 0;
  private _frameSyncId = 0;
  private _frameSignalId = 0;

  constructor(private _settings: Gio.Settings) {}

  setup(): void {
    this._eventId = global.stage.connect('captured-event', (_stage, event: Clutter.Event) => {
      const type = event.type();
      if (type === Clutter.EventType.MOTION || type === Clutter.EventType.ENTER)
        this._scan(dashOf(global.stage.get_event_actor(event)));
      return Clutter.EVENT_PROPAGATE;
    });
  }

  private _scan(dash: Clutter.Actor | null): void {
    if (!dash) return;
    const now = GLib.get_monotonic_time();
    if (now - (this._scanned.get(dash) ?? -Infinity) < RESCAN_MS * 1000) return;
    this._scanned.set(dash, now);
    for (const item of dockItems(dash)) this._hook(item);
  }

  private _hook(item: DockItem): void {
    if (this._items.has(item)) return;
    const growth = new LabelGrowth(this._settings, item, shown => this._follow(shown));
    const destroyId = item.connect('destroy', () => {
      this._items.delete(item);
      this._showing.delete(growth);
      growth.cleanup();
    });
    this._items.set(item, { growth, destroyId });
  }

  // Follows the labels that are up, each frame, until none is.
  private _follow(growth: LabelGrowth): void {
    this._showing.add(growth);
    startSyncLoop(this._frameSignalSlot, this._frameSlot, {
      alive: () => this._showing.size > 0,
      honourFreeze: false,
      errorTag: 'DockLabels',
      step: () => {
        for (const label of this._showing) {
          if (label.showing) label.sync();
          else this._showing.delete(label);
        }
      },
    });
  }

  cleanup(): void {
    stopStageLoop(this._frameSignalSlot, this._frameSlot);
    global.stage.disconnect(this._eventId);
    for (const [item, { growth, destroyId }] of this._items) {
      item.disconnect(destroyId);
      growth.cleanup();
    }
    this._items.clear();
    this._showing.clear();
  }

  private get _frameSlot() {
    return { get: () => this._frameSyncId, set: (id: number) => { this._frameSyncId = id; } };
  }

  private get _frameSignalSlot() {
    return { get: () => this._frameSignalId, set: (id: number) => { this._frameSignalId = id; } };
  }
}
