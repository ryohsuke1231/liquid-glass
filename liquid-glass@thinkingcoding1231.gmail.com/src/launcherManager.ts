import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

import { BackdropGlass } from './rendering/backdropGlass.js';
import { ContentLens } from './rendering/pipelines.js';
import { ensureGlassAllocated, isActorValid } from './actors.js';
import { startSyncLoop, stopStageLoop, hexToColorArray, RectTween, RectSpring } from './animation.js';
import { AdaptiveTextColor, sanitizeColorPreference } from './contrastSampler.js';
import { verticalBoxParams } from './shellVersion.js';
import type { Logger } from './logger.js';
import type { IconStyler } from './iconStyle/iconStyler.js';

// The pinned items' page is this much wider than the search.
const PINNED_EXTRA_WIDTH = 80;
// The least room left at either side of the panel.
const SIDE_MARGIN = 16;
// The search field's top, as a fraction of the monitor's height.
const TOP = 0.2;
const MAX_RESULTS = 8;
const PER_PROVIDER = 5;
const ICON_SIZE = 32;
const SEARCH_DELAY_MS = 120;
// How long the previous results stay up while slow providers are still answering.
const SETTLE_MS = 400;
const SHADER_PADDING = 20;
const SHADOW_MARGIN = 60;
const FADE_MS = 150;
// The glass opens from this much larger, like SwiftUI's materialize.
const OPEN_SCALE = 1.06;
const SHAPE_MS = 220;
// Frames asked for past the glass's tween, and after the panel changes size.
const TICK_MS = 50;
const HINT_OPACITY = 178;
// The pinned page's content scrolls past this share of the monitor's height.
const PINNED_MAX_HEIGHT = 0.7;
const GRID_SPACING = 8;
const PIN_ICON_SIZE = 16;
// What a tile's pin takes at each side of its icon: the pin, its padding and the tile's padding in stylesheet.css.
const TILE_SIDE_ROOM = PIN_ICON_SIZE + 4 + 8;
// Changing page: the old content goes over SWITCH_OUT_MS, then the new comes over SWITCH_IN_MS.
const SWITCH_OUT_MS = 110;
const SWITCH_IN_MS = 280;
// Results that change from one search to the next have nothing worth keeping.
const UNPINNABLE = new Set(['org.gnome.Calculator.desktop']);
// The panel's padding in stylesheet.css.
const PANEL_PADDING = 10;
// The search field's height, to place the panel before it has been laid out, and the least room for results.
const ENTRY_HEIGHT = 56;
// Between the field and the results: .lg-launcher-page in stylesheet.css.
const PAGE_SPACING = 6;
const MIN_RESULTS_HEIGHT = 240;

type View = 'search' | 'pinned';

interface Result {
  // Null for the launcher's own calculation.
  provider: any;
  order: number;
  meta: any;
  // Found by GNOME Software and not installed yet.
  install?: boolean;
}

// A row or tile that the arrow keys move between and Enter opens.
interface Item {
  actor: St.Button;
  activate: () => void;
}

interface Switch {
  view: View;
  morph: boolean;
  phase: 'out' | 'in';
  startUs: number;
}

function isCancelled(e: unknown): boolean {
  return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/**
 * A search field on glass in the middle of the screen, like Spotlight, that
 * opens with a shortcut and asks the same search providers as the overview
 * (applications, settings, files, the calculator and whatever else is
 * installed and enabled in Settings).
 */
export class Launcher {
  // The open launcher, for the test driver.
  static instance: Launcher | null = null;

  private _settingsIds: number[] = [];
  // The look's watchers, while the launcher is open.
  private _materialIds: number[] = [];
  private _keybinding = false;
  private _root: St.Widget | null = null;
  private _panel: St.BoxLayout | null = null;
  // What the clear icons' glass copies the stage from: see open().
  private _iconBackdropHost: St.Widget | null = null;
  private _entry: St.Entry | null = null;
  private _list: St.BoxLayout | null = null;
  private _resultsBox: St.ScrollView | null = null;
  private _searchBox: St.BoxLayout | null = null;
  private _pinnedBox: St.ScrollView | null = null;
  private _view: View = 'search';
  private _switch: Switch | null = null;
  private _lens: InstanceType<typeof ContentLens> | null = null;
  // The glass's spring while it morphs between pages; the tween the rest of the time.
  private _spring: RectSpring | null = null;
  private _pins: PinStore;
  private _refreshId = 0;
  private _glass: BackdropGlass | null = null;
  private _grab: any = null;
  private _shape = new RectTween(SHAPE_MS);
  private _shapeStarted = false;
  private _ticker: Clutter.Timeline | null = null;
  private _frameSyncId = 0;
  private _frameSignalId = 0;
  private _searchId = 0;
  private _cancellable: Gio.Cancellable | null = null;
  // The running search's results so far, the providers it still waits for, and its deadline.
  private _found: Result[] = [];
  private _waiting = 0;
  private _settleId = 0;
  private _results: Result[] = [];
  private _items: Item[] = [];
  // Of _items on the pinned page, how many are application tiles before the list, and in how many columns.
  private _tileCount = 0;
  private _columns = 1;
  private _selected = 0;
  private _terms: string[] = [];
  private _text: AdaptiveTextColor;
  // The panel's top and height its text color was last chosen for.
  private _coloredFor = '';

  constructor(private _path: string, private _settings: Gio.Settings, private _logger: Logger, private _icons: IconStyler) {
    // One color for the field and the results, set on the panel. Rows that come in take it at once, and the
    // color for the panel's new size is chosen as they come, while the glass is still growing to it.
    this._text = new AdaptiveTextColor(() => (this._panel ? [this._panel] : []),
      () => (this._glass ? [this._glass] : []), _logger, 'launcher',
      { ownColor: true, held: () => this._shapeRemaining(GLib.get_monotonic_time()) > 0 });
    this._pins = new PinStore(_settings);
  }

  setup(): void {
    Launcher.instance = this;
    const watch = (key: string, fn: () => void) => this._settingsIds.push(this._settings.connect(`changed::${key}`, fn));
    watch('enable-launcher', () => this._syncKeybinding());
    this._syncKeybinding();
  }

  private _syncKeybinding(): void {
    const wanted = this._settings.get_boolean('enable-launcher');
    if (wanted && !this._keybinding) {
      Main.wm.addKeybinding('launcher-shortcut', this._settings, Meta.KeyBindingFlags.NONE,
        Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.toggle());
      this._keybinding = true;
    } else if (!wanted && this._keybinding) {
      Main.wm.removeKeybinding('launcher-shortcut');
      this._keybinding = false;
      this.close();
    }
  }

  toggle(): void {
    if (this._root) this.close();
    else this.open();
  }

  open(): void {
    if (this._root) return;
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return;

    const root = new St.Widget({
      name: 'liquid-glass-launcher', reactive: true,
      x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height, opacity: 0
    });

    const glass = new BackdropGlass({
      extensionPath: this._path, settings: this._settings, logger: this._logger, owner: 'launcher', outline: 'launcher',
    } as any);
    glass.setPadding(SHADER_PADDING);
    glass.setIsDock(false);
    glass.setShadowMaxRadius(SHADOW_MARGIN - 10);
    root.add_child(glass);

    const width = this._panelWidth(false, monitor.width);
    const panel = new St.BoxLayout({
      style_class: 'liquid-glass-launcher', reactive: true, can_focus: true, width,
      x: Math.round((monitor.width - width) / 2), y: this._panelTop(monitor.height), ...verticalBoxParams()
    } as any);
    // Keys on the pinned page, where the panel has the focus.
    panel.connect('key-press-event', (_actor: Clutter.Actor, event: Clutter.Event) => this._onPinnedKey(event));
    // A click outside the field closes it. Presses inside must not be stopped: from GNOME 49 a button clicks
    // through a gesture, and an actor that stops the press cancels it.
    root.connect('button-press-event', (_actor: Clutter.Actor, event: Clutter.Event) => {
      if (panel.contains(global.stage.get_event_actor(event)!)) return Clutter.EVENT_PROPAGATE;
      this.close();
      return Clutter.EVENT_STOP;
    });
    // The glass follows the panel from before-update, which does not ask for frames and runs ahead of the layout
    // that resizes the panel. Without the ticker, an idle stage leaves the glass, and the clip that also limits
    // where rows can be hovered and clicked, at the old size. It runs for a set time, so that it stops even when
    // no JS can run.
    const ticker = new Clutter.Timeline({ actor: root, duration: TICK_MS });
    ticker.connect('completed', () => this._keepTicking());
    panel.connect('notify::allocation', () => {
      if (ticker.is_playing()) return;
      ticker.set_duration(TICK_MS);
      ticker.start();
    });
    const entry = new St.Entry({
      style_class: 'lg-launcher-entry', hint_text: 'Search', can_focus: true, x_expand: true,
      primary_icon: new St.Icon({ icon_name: 'edit-find-symbolic', style_class: 'lg-launcher-entry-icon' })
    });
    // The hint takes the panel's color too, dimmed the way the theme dims it.
    entry.hint_actor!.opacity = HINT_OPACITY;
    const list = new St.BoxLayout({ style_class: 'lg-launcher-list', x_expand: true, ...verticalBoxParams() } as any);
    // Hidden while empty, so the panel's spacing does not add room below the field. Its height is limited in
    // _limitResults(), as St.BoxLayout ignores max-height.
    const resultsBox = new St.ScrollView({
      style_class: 'lg-launcher-results', x_expand: true, visible: false,
      hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true
    });
    resultsBox.set_child(list);
    const searchBox = new St.BoxLayout({ style_class: 'lg-launcher-page', x_expand: true, ...verticalBoxParams() } as any);
    searchBox.add_child(entry);
    searchBox.add_child(resultsBox);
    const pinnedBox = new St.ScrollView({
      style_class: 'lg-launcher-pinned', x_expand: true, visible: false,
      hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true,
      // On the scroll view, as St.BoxLayout ignores min-height; inside the panel's padding.
      style: this._pinnedStyle(monitor.height)
    });
    panel.add_child(searchBox);
    panel.add_child(pinnedBox);
    // Painted just before the panel, which is drawn through an offscreen while
    // it fades and bends to another page; the stage cannot be read in there, so
    // the clear icons' backdrop is copied here and they stay glass meanwhile.
    const iconBackdropHost = new St.Widget({ name: 'liquid-glass-launcher-icons', width: monitor.width, height: monitor.height });
    root.add_child(iconBackdropHost);
    this._icons.prepareLauncherHost(iconBackdropHost);
    root.add_child(panel);
    Main.layoutManager.uiGroup.add_child(root);

    this._root = root;
    this._panel = panel;
    this._iconBackdropHost = iconBackdropHost;
    this._entry = entry;
    this._list = list;
    this._resultsBox = resultsBox;
    this._searchBox = searchBox;
    this._pinnedBox = pinnedBox;
    this._view = 'search';
    this._switch = null;
    this._spring = null;
    this._glass = glass;
    this._ticker = ticker;
    this._results = [];
    this._items = [];
    this._selected = 0;
    this._applyMaterial();
    this._materialIds = (['tint-color', 'tint-strength', 'blur-radius', 'corner-radius', 'brightness', 'contrast',
      'saturation']).map(key => this._settings.connect(`changed::launcher-${key}`, () => this._applyMaterial()));
    this._limitResults();
    for (const key of ['width', 'pinned-height', 'pinned-icon-size'])
      this._materialIds.push(this._settings.connect(`changed::launcher-${key}`, () => this._applySize()));

    entry.clutter_text.connect('text-changed', () => this._queueSearch());
    entry.clutter_text.connect('key-press-event', (_a: Clutter.Actor, event: Clutter.Event) => this._onKey(event));

    this._grab = Main.pushModal(root, { actionMode: Shell.ActionMode.POPUP });
    global.stage.set_key_focus(entry.clutter_text);
    this._shapeStarted = false;
    startSyncLoop(this._frameSignalSlot, this._frameSlot, {
      alive: () => !!this._root,
      honourFreeze: true,
      errorTag: 'Launcher',
      step: () => this._sync(),
    });
    (root as any).ease({ opacity: 255, duration: FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    this._coloredFor = '';
    if (this._settings.get_boolean('launcher-enable-adaptive-text-color')) {
      this._text.start(this._settings.get_int('launcher-sample-interval-ms'),
        sanitizeColorPreference(this._settings.get_string('launcher-adaptive-text-preference')));
    }
    this._colorText();
  }

  close(): void {
    const root = this._root;
    if (!root) return;
    this._root = null;
    stopStageLoop(this._frameSignalSlot, this._frameSlot);
    this._ticker?.stop();
    this._ticker = null;
    this._cancelSearch();
    this._text.clear();
    if (this._grab) Main.popModal(this._grab);
    this._grab = null;
    for (const id of this._materialIds) this._settings.disconnect(id);
    this._materialIds = [];
    const glass = this._glass;
    this._glass = null;
    this._panel = null;
    this._iconBackdropHost = null;
    this._entry = null;
    this._list = null;
    this._resultsBox = null;
    this._searchBox = null;
    this._pinnedBox = null;
    this._lens = null;
    this._switch = null;
    this._spring = null;
    this._items = [];
    this._results = [];
    if (this._refreshId) global.compositor.get_laters().remove(this._refreshId);
    this._refreshId = 0;
    root.remove_all_transitions();
    glass?.cleanup();
    if (isActorValid(root)) root.destroy();
  }

  /** Types `text` into the field, for the test driver. */
  setText(text: string): void {
    if (this._entry) this._entry.text = text;
  }

  /** The pinned items' page, or the search again. */
  showView(view: View): void {
    if (!this._root || view === (this._switch?.view ?? this._view)) return;
    const morph = this._settings.get_string('launcher-pinned-transition') === 'morph';
    const sw = this._switch;
    if (sw) {
      // Turned back midway: the content goes again from as far as it had come, or comes back from as far as
      // it had gone.
      sw.view = view;
      if (sw.phase === 'in' && view !== this._view) {
        const now = GLib.get_monotonic_time();
        const shown = 1 - (1 - Math.min((now - sw.startUs) / 1000 / SWITCH_IN_MS, 1)) ** 3;
        sw.phase = 'out';
        sw.startUs = now - (1 - shown) * SWITCH_OUT_MS * 1000;
      }
      return;
    }
    this._switch = { view, morph, phase: 'out', startUs: GLib.get_monotonic_time() };
    if (morph) {
      this._lens = new ContentLens();
      this._panel!.add_effect(this._lens);
    }
    this._keepTicking();
  }

  // The search's width is a setting; the pinned page is wider. Neither outgrows a small screen.
  private _panelWidth(pinned: boolean, monitorWidth: number): number {
    const width = this._settings.get_int('launcher-width') + (pinned ? PINNED_EXTRA_WIDTH : 0);
    return Math.min(width, monitorWidth - SIDE_MARGIN * 2);
  }

  private _pinnedStyle(monitorHeight: number): string {
    const max = Math.round(monitorHeight * PINNED_MAX_HEIGHT);
    const min = Math.min(this._settings.get_int('launcher-pinned-height') - PANEL_PADDING * 2, max);
    return `min-height: ${min}px; max-height: ${max}px;`;
  }

  // The field sits at TOP of the screen's height, and higher on a screen too short to leave MIN_RESULTS_HEIGHT below it.
  private _panelTop(monitorHeight: number): number {
    const lowest = monitorHeight - SIDE_MARGIN - PANEL_PADDING * 2 - PAGE_SPACING - ENTRY_HEIGHT - MIN_RESULTS_HEIGHT;
    return Math.max(SIDE_MARGIN, Math.min(Math.round(monitorHeight * TOP), lowest));
  }

  // The results scroll past what is left of the screen below the field, so that they never run off it.
  private _limitResults(): void {
    const panel = this._panel!;
    const room = this._root!.height - panel.y - SIDE_MARGIN - PANEL_PADDING * 2 - PAGE_SPACING - this._entry!.get_preferred_height(-1)[1];
    this._resultsBox!.set_style(`max-height: ${Math.max(Math.floor(room), 0)}px;`);
  }

  private _applySize(): void {
    this._pinnedBox!.set_style(this._pinnedStyle(this._root!.height));
    this._setView(this._view);
    this._coloredFor = '';
  }

  private _applyMaterial(): void {
    const glass = this._glass;
    if (!glass) return;
    const s = this._settings;
    glass.setTintColor(...hexToColorArray(s.get_string('launcher-tint-color')));
    glass.setTintStrength(s.get_double('launcher-tint-strength'));
    glass.setBlurRadius(s.get_int('launcher-blur-radius'));
    glass.setCornerRadius(s.get_double('launcher-corner-radius'));
    glass.setBrightness(s.get_double('launcher-brightness'));
    glass.setContrast(s.get_double('launcher-contrast'));
    glass.setSaturation(s.get_double('launcher-saturation'));
  }

  // Every frame: the glass eases to the field and its results, which are cut
  // off where the glass ends.
  private _sync(): void {
    const glass = this._glass!;
    const panel = this._panel!;
    const root = this._root!;
    const [w, h] = [panel.width, panel.height];
    if (!(w >= 1) || !(h >= 1)) return;
    const rest = [panel.x, panel.y, w, h];
    const now = GLib.get_monotonic_time();
    if (!this._shapeStarted) {
      this._shapeStarted = true;
      const grow = (OPEN_SCALE - 1) / 2;
      this._shape.start([rest[0] - w * grow, rest[1] - h * grow, w * OPEN_SCALE, h * OPEN_SCALE], rest, now);
    }
    let x: number, y: number, gw: number, gh: number;
    if (this._spring) {
      this._spring.setTarget(rest, now);
      [x, y, gw, gh] = this._spring.rect(now);
    } else {
      this._shape.setTarget(rest, now);
      [x, y, gw, gh] = this._shape.rect(now);
    }
    const p = SHADER_PADDING;
    glass.set_position(0, 0);
    glass.set_size(root.width, root.height);
    glass.setResolution(root.width, root.height);
    glass.setGlassGeometry(x - p, y - p, gw + p * 2, gh + p * 2);
    const clip = [x - panel.x, y - panel.y, gw, gh];
    panel.set_clip(clip[0], clip[1], clip[2], clip[3]);
    this._stepSwitch(now, [x, y, gw, gh], clip);
    this._keepTicking();
    ensureGlassAllocated(glass);
    glass.syncSources();
  }

  private _shapeRemaining(nowUs: number): number {
    if (this._switch) return TICK_MS;
    if (this._spring) return this._spring.settled() ? 0 : TICK_MS;
    return this._shape.remaining(nowUs);
  }

  private _keepTicking(): void {
    const ticker = this._ticker;
    const left = this._shapeRemaining(GLib.get_monotonic_time());
    if (!ticker || ticker.is_playing() || left <= 0) return;
    ticker.set_duration(Math.ceil(left) + TICK_MS);
    ticker.start();
  }

  // Changing page: the content goes (in a morph, sinking deep into the glass), the page is swapped, the glass
  // takes the new page's shape, and the new content comes up.
  private _stepSwitch(now: number, rect: number[], clip: number[]): void {
    const sw = this._switch;
    if (!sw) {
      if (this._spring?.settled()) {
        this._shape.start(rect, rect, now);
        this._spring = null;
      }
      return;
    }
    const panel = this._panel!;
    const elapsed = (now - sw.startUs) / 1000;
    let shown: number;
    if (sw.phase === 'out') {
      const k = Math.min(elapsed / SWITCH_OUT_MS, 1);
      shown = 1 - k;
      if (k >= 1 && sw.view === this._view) {
        // Turned back before the swap: the same page comes back.
        sw.phase = 'in';
        sw.startUs = now;
      } else if (k >= 1) {
        this._setView(sw.view);
        sw.phase = 'in';
        sw.startUs = now;
        const springResponse = this._settings.get_double('launcher-spring-response');
        const springDampingFraction = this._settings.get_double('launcher-spring-damping-fraction');
        if (sw.morph) this._spring = new RectSpring(rect, springResponse, springDampingFraction);
      }
    } else {
      const k = Math.min(elapsed / SWITCH_IN_MS, 1);
      shown = 1 - (1 - k) ** 3;
      if (k >= 1) {
        this._switch = null;
        if (this._lens) panel.remove_effect(this._lens);
        this._lens = null;
        panel.opacity = 255;
        return;
      }
    }
    panel.opacity = Math.round(255 * shown);
    this._lens?.shape(clip, 1, this._settings.get_double('launcher-corner-radius'), 1 - shown);
  }

  private _setView(view: View): void {
    const panel = this._panel!;
    const root = this._root!;
    this._view = view;
    const pinned = view === 'pinned';
    const width = this._panelWidth(pinned, root.width);
    panel.set_width(width);
    panel.x = Math.round((root.width - width) / 2);
    this._searchBox!.visible = !pinned;
    this._pinnedBox!.visible = pinned;
    if (pinned) {
      this._showPinned();
      global.stage.set_key_focus(panel);
    } else {
      this._showResults();
      global.stage.set_key_focus(this._entry!.clutter_text);
    }
  }

  private _isPinnedShortcut(event: Clutter.Event): boolean {
    const key = event.get_key_symbol();
    return (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0 && (key === Clutter.KEY_p || key === Clutter.KEY_P);
  }

  private _isEnter(key: number): boolean {
    return key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter || key === Clutter.KEY_ISO_Enter;
  }

  private _onKey(event: Clutter.Event): boolean {
    const key = event.get_key_symbol();
    if (key === Clutter.KEY_Escape) {
      this.close();
      return Clutter.EVENT_STOP;
    }
    if (this._isPinnedShortcut(event)) {
      this.showView('pinned');
      return Clutter.EVENT_STOP;
    }
    if (key === Clutter.KEY_Down || key === Clutter.KEY_Up) {
      const n = this._items.length;
      if (n > 0) this._select((this._selected + (key === Clutter.KEY_Down ? 1 : n - 1)) % n);
      return Clutter.EVENT_STOP;
    }
    if (this._isEnter(key)) {
      this._items[this._selected]?.activate();
      return Clutter.EVENT_STOP;
    }
    return Clutter.EVENT_PROPAGATE;
  }

  // The tiles are moved between as a grid, then the list below them row by row.
  private _onPinnedKey(event: Clutter.Event): boolean {
    if (this._view !== 'pinned') return Clutter.EVENT_PROPAGATE;
    const key = event.get_key_symbol();
    if (key === Clutter.KEY_Escape || key === Clutter.KEY_BackSpace || this._isPinnedShortcut(event)) {
      this.showView('search');
      return Clutter.EVENT_STOP;
    }
    if (this._isEnter(key)) {
      this._items[this._selected]?.activate();
      return Clutter.EVENT_STOP;
    }
    const n = this._items.length, tiles = this._tileCount, cols = this._columns, i = this._selected;
    let next = i;
    if (key === Clutter.KEY_Right) next = Math.min(i + 1, n - 1);
    else if (key === Clutter.KEY_Left) next = Math.max(i - 1, 0);
    else if (key === Clutter.KEY_Down) next = i < tiles ? (i + cols < tiles ? i + cols : Math.min(tiles, n - 1)) : Math.min(i + 1, n - 1);
    else if (key === Clutter.KEY_Up) next = i < tiles ? (i >= cols ? i - cols : i) : i === tiles ? Math.max(tiles - 1, 0) : i - 1;
    else {
      // Typing goes back to the search, with what was typed in the field.
      const text = event.get_key_unicode() as unknown as string;
      if ((event.get_state() & Clutter.ModifierType.CONTROL_MASK) || !/^[^\p{C}]$/u.test(text)) return Clutter.EVENT_PROPAGATE;
      this._entry!.text = text;
      this.showView('search');
      return Clutter.EVENT_STOP;
    }
    if (n > 0) this._select(next);
    return Clutter.EVENT_STOP;
  }

  // Scrolls to the item only when the keys moved to it; with the pointer, the rows would move under it.
  private _select(index: number, reveal = true): void {
    this._items[this._selected]?.actor.remove_style_pseudo_class('selected');
    this._selected = index;
    const item = this._items[index];
    if (!item) return;
    item.actor.add_style_pseudo_class('selected');
    if (reveal) this._scrollTo(item.actor);
  }

  private _scrollTo(actor: Clutter.Actor): void {
    const view = this._view === 'pinned' ? this._pinnedBox! : this._resultsBox!;
    const page = view.get_child() as unknown as Clutter.Actor;
    const adjustment = view.get_vadjustment();
    // Both are moved by the scrolling alike, so their difference is the actor's place on the page.
    const y1 = actor.get_transformed_position()[1] - page.get_transformed_position()[1];
    const y2 = y1 + actor.height;
    if (y1 < adjustment.value) adjustment.value = y1;
    else if (y2 > adjustment.value + adjustment.page_size) adjustment.value = y2 - adjustment.page_size;
  }

  private _activateResult(result: Result): void {
    const { provider, meta } = result;
    const terms = this._terms;
    this.close();
    if (!provider) {
      // The calculation: its value goes to the clipboard.
      St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, meta.value);
    } else if (provider.isRemoteProvider) {
      provider.activateResult(meta.id, terms);
    } else if (meta.id.endsWith('.desktop')) {
      Shell.AppSystem.get_default().lookup_app(meta.id)?.activate();
    } else {
      (SystemActions.getDefault() as any).activateAction(meta.id);
    }
  }

  private _activatePin(pin: Pin): void {
    this.close();
    if (pin.provider === 'applications') {
      if (pin.id.endsWith('.desktop')) Shell.AppSystem.get_default().lookup_app(pin.id)?.activate();
      else (SystemActions.getDefault() as any).activateAction(pin.id);
      return;
    }
    const provider = this._providers().find(p => p.id === pin.provider);
    if (provider) provider.activateResult(pin.id, []);
    else this._logger.log(`[Liquid Glass] No search provider ${pin.provider} for pinned ${pin.id}`);
  }

  private _cancelSearch(): void {
    if (this._searchId) GLib.Source.remove(this._searchId);
    this._searchId = 0;
    if (this._settleId) GLib.Source.remove(this._settleId);
    this._settleId = 0;
    this._cancellable?.cancel();
    this._cancellable = null;
  }

  private _queueSearch(): void {
    this._cancelSearch();
    this._searchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DELAY_MS, () => {
      this._searchId = 0;
      this._search();
      return GLib.SOURCE_REMOVE;
    });
  }

  // The overview's providers, applications first.
  private _providers(): any[] {
    return (Main.overview as any).searchController._searchResults._providers;
  }

  // The previous results stay up until every provider has answered, or SETTLE_MS have passed, so that the glass
  // does not shrink and grow back on each keystroke. Answers after the deadline are shown as they come.
  private _search(): void {
    const text = this._entry?.text.trim() ?? '';
    this._terms = text ? text.split(/\s+/) : [];
    const providers = this._terms.length ? this._providers() : [];
    this._found = [];
    const value = evaluate(text);
    if (value !== null) this._found.push(this._calculation(text, value));
    this._waiting = providers.length;
    if (!this._waiting) {
      this._commit();
      return;
    }
    const cancellable = new Gio.Cancellable();
    this._cancellable = cancellable;
    if (this._settleId) GLib.Source.remove(this._settleId);
    this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
      this._settleId = 0;
      this._commit();
      return GLib.SOURCE_REMOVE;
    });
    providers.forEach((provider, order) => this._ask(provider, order, cancellable));
  }

  private async _ask(provider: any, order: number, cancellable: Gio.Cancellable): Promise<void> {
    const terms = this._terms;
    let metas: any[] = [];
    try {
      let ids: string[] = await provider.getInitialResultSet(terms, cancellable);
      // GNOME Software also finds what is installed, which the applications' own results already show.
      if (provider.id === SOFTWARE_PROVIDER) ids = ids.filter(id => !this._isInstalled(id));
      // Pinned results go first, so that the cut to PER_PROVIDER keeps them.
      const pinned = this._pins.idsOf(provider.id);
      const ordered = pinned.size ? [...ids.filter(id => pinned.has(id)), ...ids.filter(id => !pinned.has(id))] : ids;
      const wanted = provider.filterResults(ordered, PER_PROVIDER);
      if (wanted.length > 0 && !cancellable.is_cancelled())
        metas = await provider.getResultMetas(wanted, cancellable);
    } catch (e) {
      if (!isCancelled(e)) this._logger.log(`[Liquid Glass] Search provider failed: ${e}`);
    }
    if (cancellable.is_cancelled()) return;
    const software = provider.id === SOFTWARE_PROVIDER;
    this._found.push(...metas.map(meta => ({ provider, order, meta, install: software && softwareDesktopId(meta.id) !== null })));
    this._waiting--;
    if (this._waiting === 0 || !this._settleId) this._commit();
  }

  private _isInstalled(softwareId: string): boolean {
    const desktopId = softwareDesktopId(softwareId);
    return !!desktopId && !!Shell.AppSystem.get_default().lookup_app(desktopId);
  }

  // The calculation, first of all results, with the value as its name.
  private _calculation(text: string, value: number): Result {
    const formatted = formatNumber(value);
    return {
      provider: null, order: -1, meta: {
        id: 'liquid-glass-calculation', name: formatted, value: formatted,
        description: `${text.replace(/=\s*$/, '').trim()} = ${formatted} · Enter copies the result`,
        createIcon: (size: number) => new St.Icon({ icon_name: 'accessories-calculator-symbolic', icon_size: size }),
      }
    };
  }

  private _isPinned(result: Result): boolean {
    return !!result.provider && this._pins.has(result.provider.id, result.meta.id);
  }

  private _commit(): void {
    if (this._settleId) GLib.Source.remove(this._settleId);
    this._settleId = 0;
    // The calculation first, then pinned results, then each provider's in the overview's order.
    const rank = (r: Result) => (r.provider ? (this._isPinned(r) ? 1 : 2) : 0);
    this._results = [...this._found].sort((a, b) => rank(a) - rank(b) || a.order - b.order).slice(0, MAX_RESULTS);
    if (this._view === 'search' && !this._switch) this._showResults();
  }

  private _showResults(): void {
    const list = this._list;
    if (!list) return;
    list.destroy_all_children();
    this._items = this._results.map((result, i) => {
      const icon = this._resultIcon(result, ICON_SIZE);
      const activate = () => this._activateResult(result);
      const row = this._row(icon, result.meta.name ?? '', result.meta.description || result.provider?.appInfo?.get_name() || '',
        this._pinOf(result, icon), activate, () => { }, result.install ? 'Install' : '');
      row.connect('notify::hover', () => { if (row.hover) this._select(i, false); });
      list.add_child(row);
      return { actor: row, activate };
    });
    this._resultsBox!.visible = this._items.length > 0;
    this._resultsBox!.get_vadjustment().value = 0;
    this._tileCount = 0;
    this._select(Math.min(this._selected, Math.max(this._items.length - 1, 0)), false);
    this._text.invalidate();
    this._colorText();
  }

  private _resultIcon(result: Result, size: number): Clutter.Actor | null {
    // A remote provider's result may come without an icon; its application's icon stands in.
    const gicon = result.provider?.appInfo?.get_icon();
    const icon = result.meta.createIcon(size) ?? (gicon ? new St.Icon({ gicon, icon_size: size }) : null);
    if (icon instanceof St.Icon && result.provider?.id === 'applications') this._icons.styleLauncherIcon(icon, result.meta.id, this._iconBackdropHost!);
    return icon;
  }

  // What a result is kept as when pinned, or null when it cannot be.
  private _pinOf(result: Result, icon: Clutter.Actor | null): Pin | null {
    const { provider, meta } = result;
    if (!provider || UNPINNABLE.has(provider.id)) return null;
    const gicon = (icon instanceof St.Icon ? icon.gicon : null) ?? provider.appInfo?.get_icon() ?? null;
    return {
      provider: provider.id, id: meta.id, name: meta.name ?? '', description: meta.description ?? '',
      icon: gicon?.to_string() ?? ''
    };
  }

  // The pin to the left of a row or in a tile's corner: an outline while not pinned, shown on hover, and filled
  // while pinned, shown all the time. A click on it flips it; a click on the rest of the owner activates that.
  private _pinToggle(owner: St.Button, pin: Pin, activate: () => void, onChange: () => void): St.Bin {
    const icon = new St.Icon({ icon_size: PIN_ICON_SIZE });
    const toggle = new St.Bin({
      style_class: 'lg-launcher-pin', reactive: true, track_hover: true, child: icon,
      y_align: Clutter.ActorAlign.CENTER
    });
    const sync = () => {
      const pinned = this._pins.has(pin.provider, pin.id);
      icon.gicon = Gio.FileIcon.new(Gio.File.new_for_path(`${this._path}/media/${pinned ? 'pinned' : 'pin'}-symbolic.svg`));
      toggle.opacity = pinned || owner.hover ? 255 : 0;
    };
    owner.connect('notify::hover', sync);
    owner.connect('clicked', () => {
      // By position rather than toggle.hover: a pin that was transparent when the pointer came is not picked
      // until the pointer moves again.
      const [px, py] = global.get_pointer();
      const [x, y] = toggle.get_transformed_position();
      const [w, h] = toggle.get_transformed_size();
      if (!(px >= x && px < x + w && py >= y && py < y + h)) {
        activate();
        return;
      }
      this._pins.toggle(pin);
      sync();
      onChange();
    });
    sync();
    return toggle;
  }

  private _row(icon: Clutter.Actor | null, title: string, detail: string, pin: Pin | null, activate: () => void,
    onPinChange: () => void, badge = ''): St.Button {
    const row = new St.Button({ style_class: 'lg-launcher-result', can_focus: false, x_expand: true });
    const box = new St.BoxLayout({ style_class: 'lg-launcher-result-box', x_expand: true });
    // The pin's room is kept on every row, so that the icons line up.
    if (pin) {
      box.add_child(this._pinToggle(row, pin, activate, onPinChange));
    } else {
      box.add_child(new St.Widget({ style_class: 'lg-launcher-pin', width: PIN_ICON_SIZE }));
      row.connect('clicked', activate);
    }
    const text = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER, x_expand: true, ...verticalBoxParams() } as any);
    const name = new St.Label({ text: title, style_class: 'lg-launcher-name' });
    name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    text.add_child(name);
    if (detail) {
      const label = new St.Label({ text: detail, style_class: 'lg-launcher-detail' });
      label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
      text.add_child(label);
    }
    if (icon) box.add_child(icon);
    box.add_child(text);
    if (badge) box.add_child(new St.Label({ text: badge, style_class: 'lg-launcher-badge', y_align: Clutter.ActorAlign.CENTER }));
    row.set_child(box);
    return row;
  }

  private _pinIcon(pin: Pin, size: number): St.Icon {
    if (pin.provider === 'applications' && pin.id.endsWith('.desktop')) {
      const app = Shell.AppSystem.get_default().lookup_app(pin.id);
      if (app) {
        const icon = app.create_icon_texture(size) as St.Icon;
        this._icons.styleLauncherIcon(icon, pin.id, this._iconBackdropHost!);
        return icon;
      }
    }
    let gicon: Gio.Icon | null = null;
    try {
      if (pin.icon) gicon = Gio.icon_new_for_string(pin.icon);
    } catch (e) {
      this._logger.log(`[Liquid Glass] Pinned ${pin.id} has an unreadable icon: ${e}`);
    }
    return new St.Icon({ gicon: gicon ?? Gio.ThemedIcon.new('text-x-generic-symbolic'), icon_size: size });
  }

  // The pinned page: a back button, the applications in a grid of square tiles, and the rest as a list.
  private _showPinned(): void {
    const view = this._pinnedBox!;
    (view.get_child() as unknown as Clutter.Actor | null)?.destroy();
    const page = new St.BoxLayout({ style_class: 'lg-launcher-page', x_expand: true, ...verticalBoxParams() } as any);
    const header = new St.BoxLayout({ style_class: 'lg-launcher-header' });
    const back = new St.Button({
      style_class: 'lg-launcher-back', can_focus: false, accessible_name: 'Back to the search',
      child: new St.Icon({ icon_name: 'go-previous-symbolic', icon_size: PIN_ICON_SIZE })
    });
    back.connect('clicked', () => this.showView('search'));
    header.add_child(back);
    header.add_child(new St.Label({ text: 'Pinned', style_class: 'lg-launcher-title', y_align: Clutter.ActorAlign.CENTER }));
    page.add_child(header);

    const pins = this._pins.all();
    const apps = pins.filter(p => p.provider === 'applications');
    const rest = pins.filter(p => p.provider !== 'applications');
    this._items = [];
    // After the click that unpinned an item has been handled: the page is built again without it.
    const refresh = () => {
      if (this._refreshId) return;
      this._refreshId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
        this._refreshId = 0;
        if (this._view === 'pinned' && this._pinnedBox) this._showPinned();
        return GLib.SOURCE_REMOVE;
      });
    };
    if (apps.length) {
      page.add_child(new St.Label({ text: 'Applications', style_class: 'lg-launcher-section' }));
      const iconSize = this._settings.get_int('launcher-pinned-icon-size');
      const { columns, tile } = pinnedGrid(this._panelWidth(true, this._root!.width) - PANEL_PADDING * 2, iconSize, GRID_SPACING,
        TILE_SIDE_ROOM);
      this._columns = columns;
      let line: St.BoxLayout | null = null;
      apps.forEach((pin, i) => {
        if (i % columns === 0) {
          line = new St.BoxLayout({ style_class: 'lg-launcher-grid-row' });
          page.add_child(line);
        }
        const app = pin.id.endsWith('.desktop') ? Shell.AppSystem.get_default().lookup_app(pin.id) : null;
        const button = new St.Button({ style_class: 'lg-launcher-tile', can_focus: false, width: tile });
        const content = new St.BoxLayout({
          style_class: 'lg-launcher-tile-box', x_align: Clutter.ActorAlign.CENTER,
          y_align: Clutter.ActorAlign.CENTER, x_expand: true, y_expand: true, ...verticalBoxParams()
        } as any);
        const icon = this._pinIcon(pin, iconSize);
        icon.x_align = Clutter.ActorAlign.CENTER;
        content.add_child(icon);
        const name = new St.Label({
          text: app?.get_name() ?? pin.name, style_class: 'lg-launcher-tile-name',
          x_align: Clutter.ActorAlign.CENTER
        });
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        content.add_child(name);
        const toggle = this._pinToggle(button, pin, () => this._activatePin(pin), refresh);
        toggle.set({ x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.START, x_expand: true, y_expand: true });
        const stack = new St.Widget({ layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true });
        stack.add_child(content);
        stack.add_child(toggle);
        button.set_child(stack);
        const index = this._items.length;
        button.connect('notify::hover', () => { if (button.hover) this._select(index, false); });
        line!.add_child(button);
        this._items.push({ actor: button, activate: () => this._activatePin(pin) });
      });
    }
    this._tileCount = this._items.length;
    if (rest.length) {
      page.add_child(new St.Label({ text: 'Files', style_class: 'lg-launcher-section' }));
      const list = new St.BoxLayout({ style_class: 'lg-launcher-list', ...verticalBoxParams() } as any);
      for (const pin of rest) {
        const provider = this._providers().find(p => p.id === pin.provider);
        const row = this._row(this._pinIcon(pin, ICON_SIZE), pin.name,
          pin.description || provider?.appInfo?.get_name() || '', pin, () => this._activatePin(pin), refresh);
        const index = this._items.length;
        row.connect('notify::hover', () => { if (row.hover) this._select(index, false); });
        list.add_child(row);
        this._items.push({ actor: row, activate: () => this._activatePin(pin) });
      }
      page.add_child(list);
    }
    if (!pins.length) {
      page.add_child(new St.Label({
        text: 'Nothing pinned yet. Point at a search result and click the pin on its left.',
        style_class: 'lg-launcher-empty', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, y_expand: true
      }));
    }
    view.set_child(page);
    this._select(Math.min(this._selected, Math.max(this._items.length - 1, 0)));
    this._text.invalidate();
    this._colorText();
  }

  // Chooses the text color for where the panel is about to be, from its size with the rows it has now, before
  // the next layout gives it that size.
  private _colorText(): void {
    const root = this._root!;
    const panel = this._panel!;
    const width = this._panelWidth(this._view === 'pinned', root.width);
    const [, height] = panel.get_preferred_height(width);
    const rect = { x: root.x + panel.x, y: root.y + panel.y, width, height: Math.ceil(height) };
    const key = `${rect.y},${rect.height}`;
    if (key === this._coloredFor) return;
    this._coloredFor = key;
    this._text.colorFor(rect);
  }

  cleanup(): void {
    this.close();
    if (this._keybinding) Main.wm.removeKeybinding('launcher-shortcut');
    this._keybinding = false;
    for (const id of this._settingsIds) this._settings.disconnect(id);
    this._settingsIds = [];
    Launcher.instance = null;
  }

  private get _frameSlot() {
    return { get: () => this._frameSyncId, set: (id: number) => { this._frameSyncId = id; } };
  }

  private get _frameSignalSlot() {
    return { get: () => this._frameSignalId, set: (id: number) => { this._frameSignalId = id; } };
  }
}

// Arithmetic typed into the launcher, such as "3*8", "3*8=" or "1-5": + - * / % ^, parentheses, decimals,
// and the × ÷ − signs. Parsed by hand rather than evaluated, so nothing typed can run as code.

const OPERATORS = '+-*/%^()';

function tokenize(text: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ') {
      i++;
    } else if (OPERATORS.includes(c)) {
      tokens.push(c);
      i++;
    } else {
      const number = /^(\d+\.?\d*|\.\d+)/.exec(text.slice(i));
      if (!number) return null;
      tokens.push(number[0]);
      i += number[0].length;
    }
  }
  return tokens;
}

class Parser {
  private _at = 0;
  // Whether a binary operator was read: a lone number is not a calculation.
  binary = false;

  constructor(private _tokens: string[]) {}

  parse(): number | null {
    const value = this._sum();
    return this._at === this._tokens.length ? value : null;
  }

  private _peek(): string | undefined {
    return this._tokens[this._at];
  }

  private _sum(): number | null {
    let value = this._product();
    while (value !== null && (this._peek() === '+' || this._peek() === '-')) {
      const op = this._tokens[this._at++];
      const right = this._product();
      if (right === null) return null;
      this.binary = true;
      value = op === '+' ? value + right : value - right;
    }
    return value;
  }

  private _product(): number | null {
    let value = this._power();
    while (value !== null && (this._peek() === '*' || this._peek() === '/' || this._peek() === '%')) {
      const op = this._tokens[this._at++];
      const right = this._power();
      if (right === null) return null;
      this.binary = true;
      value = op === '*' ? value * right : op === '/' ? value / right : value % right;
    }
    return value;
  }

  private _power(): number | null {
    const base = this._unary();
    if (base === null || this._peek() !== '^') return base;
    this._at++;
    const exponent = this._power();
    if (exponent === null) return null;
    this.binary = true;
    return base ** exponent;
  }

  private _unary(): number | null {
    const token = this._peek();
    if (token === '-' || token === '+') {
      this._at++;
      const value = this._unary();
      return value === null ? null : token === '-' ? -value : value;
    }
    if (token === '(') {
      this._at++;
      const value = this._sum();
      if (this._peek() !== ')') return null;
      this._at++;
      return value;
    }
    if (token === undefined || OPERATORS.includes(token)) return null;
    this._at++;
    return Number(token);
  }
}

/** The value of `text` when it is a calculation, else null. */
export function evaluate(text: string): number | null {
  const expression = text.replace(/[×✕]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-').trim().replace(/=$/, '');
  const tokens = tokenize(expression);
  if (!tokens || tokens.length < 3) return null;
  const parser = new Parser(tokens);
  const value = parser.parse();
  return value !== null && parser.binary && Number.isFinite(value) ? value : null;
}

/** `value` with no more digits than a double holds reliably, and no exponent for everyday sizes. */
export function formatNumber(value: number): string {
  const rounded = Number(value.toPrecision(12));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** A launcher result kept for later: what is needed to show it and to open it without searching again. */
export interface Pin {
  // The search provider's id ('applications', or a remote provider's application id) and the result's id in it.
  provider: string;
  id: string;
  name: string;
  description: string;
  // The icon as Gio.Icon.to_string() gives it; empty when it has no string form.
  icon: string;
}

const KEY = 'launcher-pinned';

export class PinStore {
  constructor(private _settings: Gio.Settings) {}

  all(): Pin[] {
    const stored = this._settings.get_value(KEY).deep_unpack() as Record<string, string>[];
    return stored.map(p => ({ provider: p.provider ?? '', id: p.id ?? '', name: p.name ?? '',
      description: p.description ?? '', icon: p.icon ?? '' })).filter(p => p.provider && p.id);
  }

  has(provider: string, id: string): boolean {
    return this.all().some(p => p.provider === provider && p.id === id);
  }

  /** The ids pinned from one provider. */
  idsOf(provider: string): Set<string> {
    return new Set(this.all().filter(p => p.provider === provider).map(p => p.id));
  }

  /** Pins `pin`, or unpins it if it is pinned already; true when it ends up pinned. */
  toggle(pin: Pin): boolean {
    const pins = this.all();
    const kept = pins.filter(p => p.provider !== pin.provider || p.id !== pin.id);
    const pinned = kept.length === pins.length;
    this._write(pinned ? [...kept, pin] : kept);
    return pinned;
  }

  private _write(pins: Pin[]): void {
    this._settings.set_value(KEY, new GLib.Variant('aa{ss}', pins.map(p => ({ ...p }))));
  }
}

export interface PinnedGrid {
  columns: number;
  // Of every tile, which share the row's width evenly.
  tile: number;
}

/**
 * The columns of the pinned page for a row `width` wide. A tile is as wide as its icon plus the room the pin in
 * its corner needs at each side, and the tiles grow to use up what is left over.
 */
export function pinnedGrid(width: number, iconSize: number, gap: number, sideRoom: number): PinnedGrid {
  const least = iconSize + sideRoom * 2;
  const columns = Math.max(1, Math.floor((width + gap) / (least + gap)));
  return { columns, tile: Math.floor((width - gap * (columns - 1)) / columns) };
}

export const SOFTWARE_PROVIDER = 'org.gnome.Software.desktop';

/**
 * The desktop file that an application found by GNOME Software's search has once it is installed, from its result id
 * (scope/kind/origin/id/branch). Null for kinds whose desktop file is not named after the id.
 */
export function softwareDesktopId(resultId: string): string | null {
  const [, kind, , appId] = resultId.split('/');
  if (!appId) return null;
  if (kind === 'flatpak') return appId.endsWith('.desktop') ? appId : `${appId}.desktop`;
  if (kind === 'package' && appId.endsWith('.desktop')) return appId;
  return null;
}
