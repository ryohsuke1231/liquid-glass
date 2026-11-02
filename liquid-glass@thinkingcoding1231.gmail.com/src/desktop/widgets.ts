import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import GWeather from 'gi://GWeather';
import Soup from 'gi://Soup?version=3.0';
import Cairo from 'cairo';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { formatTime } from 'resource:///org/gnome/shell/misc/dateUtils.js';

import { BackdropGlass } from '../rendering/backdropGlass.js';
import { ensureGlassAllocated, isActorValid } from '../actors.js';
import { hexToColorArray, addFrameTicker, removeFrameTicker } from '../animation.js';
import { AdaptiveTextColor, sanitizeColorPreference } from '../contrastSampler.js';
import type { Logger } from '../logger.js';
import { verticalBoxParams } from '../shellVersion.js';
import { ContentLens } from '../rendering/pipelines.js';

// Room around the glass rect for the shader's edge effects.
const SHADER_PADDING = 20;
// Room around a card for its shadow.
const SHADOW_MARGIN = 40;
// A press that moves further than this (px) before it is let go is no click.
const CLICK_SLOP = 6;
// The text on the desktop stays in the preferred color down to this contrast
// ratio (WCAG's for large text), so a busy wallpaper does not keep flipping it.
export const PREFERRED_MIN_CONTRAST = 3;
export const CARD_WIDTH = 300;

export interface ItemEnv {
  path: string;
  settings: Gio.Settings;
  logger: Logger;
  // A right click on the item at (x, y), in stage coordinates.
  menu: (item: DesktopItem, x: number, y: number) => void;
  // The item changed size or was shown or hidden: lay the items out on the
  // next frame, and make sure there is one.
  relayout: () => void;
}

/** Something the desktop layer places and stacks, and the user can move. */
export interface DesktopItem {
  readonly id: string;
  readonly actor: St.Widget;
  // Whether it has anything to show; a hidden item leaves its place in the stack.
  readonly shown: boolean;
  // [width, height] as placed.
  size(): [number, number];
  // The part of the actor that shows, [x, y, width, height] in its own
  // coordinates: the edit frame goes round it.
  bounds(): [number, number, number, number];
  // Every frame. True when the size or `shown` changed, so the stack is laid out again.
  sync(): boolean;
  destroy(): void;
}

/**
 * A left click on `actor` calls `onClick` and a right click opens its menu.
 * Items move only in the menu's edit mode, so a stray drag does nothing.
 */
export function connectClicks(actor: St.Widget, onClick: () => void, onMenu: (x: number, y: number) => void): void {
  let start: [number, number] | null = null;
  actor.connect('button-press-event', (_a: Clutter.Actor, event: Clutter.Event) => {
    const button = event.get_button();
    if (button === Clutter.BUTTON_SECONDARY) {
      onMenu(...(event.get_coords() as [number, number]));
      return Clutter.EVENT_STOP;
    }
    if (button !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
    // A button inside gets the press: stopping it here would also cancel the
    // button's click gesture.
    if (global.stage.get_event_actor(event) !== actor) return Clutter.EVENT_PROPAGATE;
    start = event.get_coords() as [number, number];
    return Clutter.EVENT_STOP;
  });
  actor.connect('button-release-event', (_a: Clutter.Actor, event: Clutter.Event) => {
    if (!start || event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
    const [x, y] = event.get_coords();
    const moved = Math.hypot(x - start[0], y - start[1]);
    start = null;
    if (moved < CLICK_SLOP) onClick();
    return Clutter.EVENT_STOP;
  });
}

/**
 * A desktop widget: content on a rounded card of glass. Subclasses fill
 * `box` and may hide the card (`shown`) when they have nothing to show.
 */
export abstract class GlassCard implements DesktopItem {
  readonly actor: St.Widget;
  protected readonly box: St.BoxLayout;
  protected readonly glass: BackdropGlass;
  protected env: ItemEnv;
  private _settingsIds: number[] = [];
  private _lastSize = '';
  private _lastShown = false;
  private _text: AdaptiveTextColor;
  private _shown = true;

  constructor(readonly id: string, env: ItemEnv, width: number) {
    this.env = env;
    this.actor = new St.Widget({ name: `liquid-glass-desktop-${id}`, reactive: true, track_hover: true });
    this.glass = new BackdropGlass({
      extensionPath: env.path, settings: env.settings, logger: env.logger, owner: `desktop-${id}`,
      outline: 'desktop-widget', underWindows: true,
    } as any);
    this.glass.setPadding(SHADER_PADDING);
    this.glass.setIsDock(false);
    this.glass.setShadowMaxRadius(SHADOW_MARGIN - 8);
    this.actor.add_child(this.glass);
    this.box = new St.BoxLayout({ style_class: 'liquid-glass-desktop-card', width, ...verticalBoxParams() } as any);
    this.actor.add_child(this.box);
    connectClicks(this.actor, () => this.activate(), (x, y) => env.menu(this, x, y));

    this._text = new AdaptiveTextColor(() => [this.box], () => [this.glass], env.logger, `desktop ${id}`);
    const watch = (key: string, fn: () => void) =>
      this._settingsIds.push(env.settings.connect(`changed::${key}`, fn));
    for (const key of ['tint-color', 'tint-strength', 'blur-radius', 'corner-radius', 'brightness', 'contrast', 'saturation'])
      watch(`desktop-widget-${key}`, () => this._applyMaterial());
    for (const key of ['enable-adaptive-text-color', 'sample-interval-ms', 'adaptive-text-preference'])
      watch(`desktop-widget-${key}`, () => this._syncText());
    this._applyMaterial();
    this._syncText();
  }

  protected activate(): void {
  }

  get shown(): boolean {
    return this._shown;
  }

  set shown(shown: boolean) {
    if (shown === this._shown) return;
    this._shown = shown;
    this.env.relayout(); // defined in desktopLayer.ts (connects to the _queueLayout() in the DesktopLayer)
  }

  private _applyMaterial(): void {
    const s = this.env.settings;
    const g = this.glass;
    g.setTintColor(...hexToColorArray(s.get_string('desktop-widget-tint-color')));
    g.setTintStrength(s.get_double('desktop-widget-tint-strength'));
    g.setBlurRadius(s.get_int('desktop-widget-blur-radius'));
    g.setCornerRadius(s.get_double('desktop-widget-corner-radius'));
    g.setBrightness(s.get_double('desktop-widget-brightness'));
    g.setContrast(s.get_double('desktop-widget-contrast'));
    g.setSaturation(s.get_double('desktop-widget-saturation'));
    this.box.set_style(`border-radius: ${s.get_double('desktop-widget-corner-radius')}px;`);
  }

  private _syncText(): void {
    const s = this.env.settings;
    if (!s.get_boolean('desktop-widget-enable-adaptive-text-color')) {
      this._text.clear();
      return;
    }
    this._text.start(s.get_int('desktop-widget-sample-interval-ms'),
      sanitizeColorPreference(s.get_string('desktop-widget-adaptive-text-preference')), PREFERRED_MIN_CONTRAST);
  }

  // The content changed; measure the text color again.
  protected contentChanged(): void {
    this._text.invalidate();
    this.env.relayout();
  }

  size(): [number, number] {
    const [, natW] = this.box.get_preferred_width(-1);
    const [, natH] = this.box.get_preferred_height(natW);
    return [Math.ceil(Math.max(natW, this.box.width)), Math.ceil(natH)];
  }

  bounds(): [number, number, number, number] {
    return [0, 0, ...this.size()];
  }

  sync(): boolean {
    const shown = this.shown;
    this.actor.visible = shown;
    const [w, h] = this.size();
    const key = `${w}x${h}`;
    const changed = key !== this._lastSize || shown !== this._lastShown;
    this._lastShown = shown;
    if (key !== this._lastSize) {
      this._lastSize = key;
      const m = SHADOW_MARGIN;
      const p = SHADER_PADDING;
      this.glass.set_position(-m, -m);
      this.glass.set_size(w + m * 2, h + m * 2);
      this.glass.setResolution(w + m * 2, h + m * 2);
      this.glass.setGlassGeometry(m - p, m - p, w + p * 2, h + p * 2);
      this.actor.set_size(w, h);
      this._text.invalidate();
    }
    if (shown && this.actor.mapped) {
      ensureGlassAllocated(this.glass);
      this.glass.syncSources();
    }
    return changed;
  }

  destroy(): void {
    for (const id of this._settingsIds) this.env.settings.disconnect(id);
    this._settingsIds = [];
    this._text.clear();
    this.glass.cleanup();
    if (isActorValid(this.actor)) this.actor.destroy();
  }
}

const MAX_EVENTS = 4;
const CALENDAR_APP = 'org.gnome.Calendar.desktop';

function startOfDay(date: Date, days = 0): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * The rest of today's events and tomorrow's, from the calendars the shell's
 * calendar menu shows. It reads the events the menu has already loaded
 * rather than asking for its own range, which would change what the menu
 * shows.
 */
export class EventsWidget extends GlassCard {
  private _title: St.Label;
  private _list: St.BoxLayout;
  private _source: any = null;
  private _sourceId = 0;
  private _timerId = 0;

  constructor(env: ItemEnv) {
    super('events', env, CARD_WIDTH);
    this._title = new St.Label({ style_class: 'lg-title', text: 'Up Next' });
    this._list = new St.BoxLayout({ style_class: 'lg-list', ...verticalBoxParams() } as any);
    this.box.add_child(this._title);
    this.box.add_child(this._list);
    // The times move on even when the events do not.
    this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
      this._update();
      return GLib.SOURCE_CONTINUE;
    });
    this._update();
  }

  protected activate(): void {
    Shell.AppSystem.get_default().lookup_app(CALENDAR_APP)?.activate();
  }

  // The menu's event source, which the shell replaces when the session mode changes.
  private _eventSource(): any {
    const source = (Main.panel.statusArea as any).dateMenu._eventSource;
    if (source !== this._source) {
      if (this._source && this._sourceId) this._source.disconnect(this._sourceId);
      this._source = source;
      this._sourceId = source ? source.connect('changed', () => this._update()) : 0;
    }
    return source;
  }

  private _row(time: string, summary: string): St.BoxLayout {
    const row = new St.BoxLayout({ style_class: 'lg-event' });
    row.add_child(new St.Label({ text: time, style_class: 'lg-event-time', y_align: Clutter.ActorAlign.START }));
    const label = new St.Label({ text: summary, style_class: 'lg-event-summary', x_expand: true });
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    row.add_child(label);
    return row;
  }

  private _update(): void {
    const source = this._eventSource();
    this._list.destroy_all_children();
    if (!source?.hasCalendars) {
      this._list.add_child(new St.Label({ text: 'No calendars', style_class: 'lg-dim' }));
      this.contentChanged();
      return;
    }
    const now = new Date();
    const today = startOfDay(now);
    const tomorrow = startOfDay(now, 1);
    const after = startOfDay(now, 2);
    const events = (source.getEvents(now, after) as any[]).slice(0, MAX_EVENTS);
    let day: Date | null = null;
    for (const event of events) {
      const starts: Date = event.date;
      const ends: Date = event.end;
      const heading = starts < tomorrow ? today : tomorrow;
      if (heading !== day && heading === tomorrow) {
        this._list.add_child(new St.Label({ text: 'Tomorrow', style_class: 'lg-small lg-heading' }));
      }
      day = heading;
      const dayStart = heading;
      const dayEnd = startOfDay(heading, 1);
      const allDay = starts <= dayStart && ends >= dayEnd;
      this._list.add_child(this._row(allDay ? 'All day' : formatTime(starts, { timeOnly: true }), event.summary));
    }
    if (events.length === 0)
      this._list.add_child(new St.Label({ text: 'Nothing else today or tomorrow', style_class: 'lg-dim' }));
    this.contentChanged();
  }

  destroy(): void {
    if (this._timerId) GLib.Source.remove(this._timerId);
    this._timerId = 0;
    if (this._source && this._sourceId) this._source.disconnect(this._sourceId);
    this._source = null;
    super.destroy();
  }
}

const HOURS = 5;
// Open-Meteo is asked again after this long.
const REFRESH_S = 30 * 60;
const CONTACT = 'https://github.com/ryohsuke1231/liquid-glass';
const USER_AGENT = `Liquid Glass GNOME Shell extension (${CONTACT})`;

interface Hour { label: string; icon: string; temp: string; }

interface Report {
  place: string;
  temp: string;
  summary: string;
  icon: string;
  range: string;
  hours: Hour[];
  // The source's notice that has to be shown with its data.
  credit: string;
}

type Unit = 'auto' | 'celsius' | 'fahrenheit';

function sanitizeUnit(value: string): Unit {
  return value === 'celsius' || value === 'fahrenheit' ? value : 'auto';
}

function degrees(value: number): string {
  return `${Math.round(value)}°`;
}

// WMO weather codes, as Open-Meteo reports them.
const CODES: Record<number, [string, string, string?]> = {
  0: ['Clear', 'weather-clear-symbolic', 'weather-clear-night-symbolic'],
  1: ['Mostly Clear', 'weather-few-clouds-symbolic', 'weather-few-clouds-night-symbolic'],
  2: ['Partly Cloudy', 'weather-few-clouds-symbolic', 'weather-few-clouds-night-symbolic'],
  3: ['Cloudy', 'weather-overcast-symbolic'],
  45: ['Fog', 'weather-fog-symbolic'],
  48: ['Rime Fog', 'weather-fog-symbolic'],
  51: ['Light Drizzle', 'weather-showers-scattered-symbolic'],
  53: ['Drizzle', 'weather-showers-scattered-symbolic'],
  55: ['Heavy Drizzle', 'weather-showers-scattered-symbolic'],
  56: ['Freezing Drizzle', 'weather-showers-scattered-symbolic'],
  57: ['Freezing Drizzle', 'weather-showers-scattered-symbolic'],
  61: ['Light Rain', 'weather-showers-scattered-symbolic'],
  63: ['Rain', 'weather-showers-symbolic'],
  65: ['Heavy Rain', 'weather-showers-symbolic'],
  66: ['Freezing Rain', 'weather-showers-symbolic'],
  67: ['Freezing Rain', 'weather-showers-symbolic'],
  71: ['Light Snow', 'weather-snow-symbolic'],
  73: ['Snow', 'weather-snow-symbolic'],
  75: ['Heavy Snow', 'weather-snow-symbolic'],
  77: ['Snow Grains', 'weather-snow-symbolic'],
  80: ['Rain Showers', 'weather-showers-scattered-symbolic'],
  81: ['Rain Showers', 'weather-showers-symbolic'],
  82: ['Violent Showers', 'weather-showers-symbolic'],
  85: ['Snow Showers', 'weather-snow-symbolic'],
  86: ['Heavy Snow Showers', 'weather-snow-symbolic'],
  95: ['Thunderstorm', 'weather-storm-symbolic'],
  96: ['Thunderstorm, Hail', 'weather-storm-symbolic'],
  99: ['Thunderstorm, Hail', 'weather-storm-symbolic'],
};

function wmo(code: number, isDay: boolean): [string, string] {
  const [text, icon, night] = CODES[code] ?? ['Unknown', 'weather-severe-alert-symbolic'];
  return [text, !isDay && night ? night : icon];
}

// A summary for the weather an icon stands for, where libgweather gives no
// conditions or sky (MET Norway's forecasts have neither).
const ICON_SUMMARIES: [string, string][] = [
  ['weather-clear', 'Clear'], ['weather-few-clouds', 'Partly Cloudy'], ['weather-overcast', 'Cloudy'],
  ['weather-fog', 'Fog'], ['weather-showers-scattered', 'Showers'], ['weather-showers', 'Rain'],
  ['weather-snow', 'Snow'], ['weather-storm', 'Thunderstorm'],
];

function iconSummary(icon: string): string {
  return ICON_SUMMARIES.find(([prefix]) => icon.startsWith(prefix))?.[1] ?? '';
}

// The place chosen in the preferences, or null for GNOME Weather's.
interface Place { name: string; lat: number; lon: number; }

function placeOf(settings: Gio.Settings): Place | null {
  const [name, lat, lon] = settings.get_value('weather-place').deepUnpack() as [string, number, number];
  return name ? { name, lat, lon } : null;
}

/**
 * Today's weather and the next hours, for the place chosen in the
 * preferences or else the location GNOME Weather has set up (the one the
 * shell's calendar menu shows the weather for). With GNOME Weather installed
 * the forecasts come from libgweather, as in GNOME Weather; without it, from
 * Open-Meteo.
 */
export class WeatherWidget extends GlassCard {
  private _place: St.Label;
  private _icon: St.Icon;
  private _temp: St.Label;
  private _summary: St.Label;
  private _hours: St.BoxLayout;
  private _credit: St.Label;
  // The shell's weather client: GNOME Weather's location.
  private _client: any = null;
  private _clientId = 0;
  // Our own libgweather forecasts, for a chosen place.
  private _info: any = null;
  private _infoId = 0;
  private _weatherSettingsIds: number[] = [];
  private _session: any = null;
  private _cancellable: Gio.Cancellable | null = null;
  private _timerId = 0;

  constructor(env: ItemEnv) {
    super('weather', env, CARD_WIDTH);
    this._place = new St.Label({ style_class: 'lg-title' });
    const row = new St.BoxLayout({ style_class: 'lg-row' });
    this._icon = new St.Icon({ icon_size: 44, y_align: Clutter.ActorAlign.CENTER });
    this._temp = new St.Label({ style_class: 'lg-big', y_align: Clutter.ActorAlign.CENTER });
    this._summary = new St.Label({ style_class: 'lg-dim', y_align: Clutter.ActorAlign.CENTER, x_expand: true });
    row.add_child(this._icon);
    row.add_child(this._temp);
    row.add_child(this._summary);
    this._hours = new St.BoxLayout({ style_class: 'lg-hours', x_expand: true });
    this._credit = new St.Label({ style_class: 'lg-small', visible: false });
    for (const child of [this._place, row, this._hours, this._credit]) this.box.add_child(child);

    for (const key of ['weather-place', 'weather-temperature-unit'])
      this._weatherSettingsIds.push(env.settings.connect(`changed::${key}`, () => this._refresh()));
    this._refresh();
  }

  private _unit(): Unit {
    return sanitizeUnit(this.env.settings.get_string('weather-temperature-unit'));
  }

  // The shell's weather client, or null without GNOME Weather.
  private _shellClient(): any {
    const client = (Main.panel.statusArea as any).dateMenu._weatherItem._weatherClient;
    return client.available ? client : null;
  }

  private _stopSources(): void {
    if (this._client && this._clientId) this._client.disconnect(this._clientId);
    this._client = null;
    this._clientId = 0;
    if (this._info) {
      this._info.disconnect(this._infoId);
      this._info.abort();
    }
    this._info = null;
    this._infoId = 0;
    this._cancellable?.cancel();
    this._cancellable = null;
    if (this._timerId) GLib.Source.remove(this._timerId);
    this._timerId = 0;
  }

  private _refresh(): void {
    this._stopSources();
    const place = placeOf(this.env.settings);
    const client = this._shellClient();
    if (place && client) {
      this._startOwnGWeather(place);
    } else if (place) {
      this._startOpenMeteo(place);
    } else if (client) {
      this._client = client;
      this._clientId = client.connect('changed', () => this._showShellWeather());
      client.update();
      this._showShellWeather();
    } else {
      this._show('Install GNOME Weather, or choose a place in the Liquid Glass preferences');
    }
  }

  protected activate(): void {
    this._shellClient()?.activateApp();
  }

  // Asks again every REFRESH_S.
  private _every(fn: () => void): void {
    fn();
    if (this._timerId) GLib.Source.remove(this._timerId);
    this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_S, () => {
      fn();
      return GLib.SOURCE_CONTINUE;
    });
  }

  private _show(report: Report | string): void {
    if (typeof report === 'string') {
      this._place.text = 'Weather';
      this._icon.icon_name = 'weather-severe-alert-symbolic';
      this._temp.text = '';
      this._summary.text = report;
      this._summary.clutter_text.line_wrap = true;
      this._hours.destroy_all_children();
      this._credit.visible = false;
      this.contentChanged();
      return;
    }
    this._place.text = report.place;
    this._icon.icon_name = report.icon;
    this._temp.text = report.temp;
    this._summary.text = report.range ? `${report.summary}\n${report.range}` : report.summary;
    this._hours.destroy_all_children();
    for (const hour of report.hours) {
      const column = new St.BoxLayout({ style_class: 'lg-hour', x_expand: true, ...verticalBoxParams() } as any);
      column.add_child(new St.Label({ text: hour.label, style_class: 'lg-small', x_align: Clutter.ActorAlign.CENTER }));
      column.add_child(new St.Icon({ icon_name: hour.icon, icon_size: 18, x_align: Clutter.ActorAlign.CENTER }));
      column.add_child(new St.Label({ text: hour.temp, style_class: 'lg-small', x_align: Clutter.ActorAlign.CENTER }));
      this._hours.add_child(column);
    }
    this._credit.text = report.credit;
    this._credit.visible = !!report.credit;
    this.contentChanged();
  }

  private _gweatherUnit(): number {
    const unit = this._unit();
    return unit === 'celsius' ? GWeather.TemperatureUnit.CENTIGRADE
      : unit === 'fahrenheit' ? GWeather.TemperatureUnit.FAHRENHEIT : GWeather.TemperatureUnit.DEFAULT;
  }

  private _gweatherTemp(info: any): number | null {
    const [ok, value] = info.get_value_temp(this._gweatherUnit());
    return ok ? value : null;
  }

  // A report from libgweather's `info`, for `place` (its own name when null).
  private _gweatherReport(info: any, place: string | null, credit: string): Report {
    const icon = info.get_symbolic_icon_name();
    const conditions = info.get_conditions();
    const [hasSky] = info.get_value_sky();
    const summary = conditions && conditions !== '-' ? conditions : hasSky ? info.get_sky() : iconSummary(icon);
    const now = GLib.DateTime.new_now_local();
    const today = now.format('%F');
    let last = GLib.DateTime.new_from_unix_local(0);
    let high = -Infinity, low = Infinity;
    const hours: Hour[] = [];
    for (const forecast of info.get_forecast_list()) {
      const [valid, timestamp] = forecast.get_value_update();
      if (!valid || timestamp === 0) continue;
      const time = GLib.DateTime.new_from_unix_local(timestamp);
      const temp = this._gweatherTemp(forecast);
      if (temp !== null && time.format('%F') === today) {
        high = Math.max(high, temp);
        low = Math.min(low, temp);
      }
      // Only the hours to come, at least an hour apart.
      if (now.difference(time) > 0 || time.difference(last) < GLib.TIME_SPAN_HOUR || hours.length === HOURS) continue;
      last = time;
      hours.push({
        label: formatTime(new Date(timestamp * 1000), { timeOnly: true }),
        icon: forecast.get_symbolic_icon_name(),
        temp: temp === null ? '' : degrees(temp),
      });
    }
    const temp = this._gweatherTemp(info);
    return {
      place: place ?? info.get_location_name(), temp: temp === null ? '' : degrees(temp), summary, icon, hours,
      range: Number.isFinite(high) ? `H ${degrees(high)}  L ${degrees(low)}` : '', credit,
    };
  }

  private _showShellWeather(): void {
    const client = this._client;
    if (!client) return;
    const info = client.info;
    if (!client.hasLocation) {
      this._show('Choose a location in GNOME Weather, or a place in the Liquid Glass preferences');
      return;
    }
    if (!info.is_valid()) {
      this._show(client.loading ? 'Loading…' : 'Weather is not available right now');
      return;
    }
    this._show(this._gweatherReport(info, null, ''));
  }

  // libgweather's forecasts for exactly `place`, which GNOME Weather may not
  // know: its own locations are the larger cities with weather stations.
  private _startOwnGWeather(place: Place): void {
    const info = new GWeather.Info({
      application_id: 'org.gnome.Shell', contact_info: CONTACT, enabled_providers: GWeather.Provider.MET_NO,
    });
    info.set_location(GWeather.Location.new_detached(place.name, null, place.lat, place.lon));
    this._info = info;
    this._infoId = info.connect('updated', () => {
      if (!info.is_valid()) {
        this._show('Weather is not available right now');
        return;
      }
      this._show(this._gweatherReport(info, place.name, 'Weather data by MET Norway'));
    });
    this._show('Loading…');
    this._every(() => info.update());
  }

  private _startOpenMeteo(place: Place): void {
    this._session ??= new Soup.Session({ user_agent: USER_AGENT, timeout: 20 });
    const cancellable = new Gio.Cancellable();
    this._cancellable = cancellable;
    this._every(() => this._fetchOpenMeteo(place, cancellable));
  }

  private _getJson(url: string, cancellable: Gio.Cancellable): Promise<any> {
    const message = Soup.Message.new('GET', url);
    return new Promise((resolve, reject) => {
      this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (session: any, res: any) => {
        try {
          const bytes = session.send_and_read_finish(res);
          if (message.get_status() !== Soup.Status.OK) throw new Error(`HTTP ${message.get_status()}`);
          resolve(JSON.parse(new TextDecoder().decode(bytes.get_data())));
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  private async _fetchOpenMeteo(place: Place, cancellable: Gio.Cancellable): Promise<void> {
    try {
      const fahrenheit = this._unit() === 'fahrenheit' ||
        (this._unit() === 'auto' && /_US\b/.test(GLib.get_language_names()[0] ?? ''));
      const json = await this._getJson('https://api.open-meteo.com/v1/forecast' +
        `?latitude=${place.lat}&longitude=${place.lon}&timezone=auto&forecast_days=2` +
        '&current=temperature_2m,weather_code,is_day&hourly=temperature_2m,weather_code,is_day' +
        `&daily=temperature_2m_max,temperature_2m_min${fahrenheit ? '&temperature_unit=fahrenheit' : ''}`,
      cancellable);
      const current = json.current;
      const [summary, icon] = wmo(current.weather_code, current.is_day === 1);
      // The hourly times are local to the place, as is current.time.
      const start = (json.hourly.time as string[]).findIndex(t => t > current.time);
      const hours: Hour[] = [];
      for (let i = Math.max(start, 0); i < json.hourly.time.length && hours.length < HOURS; i++) {
        const [, hourIcon] = wmo(json.hourly.weather_code[i], json.hourly.is_day[i] === 1);
        hours.push({ label: (json.hourly.time[i] as string).slice(11, 16), icon: hourIcon,
          temp: degrees(json.hourly.temperature_2m[i]) });
      }
      this._show({
        place: place.name, temp: degrees(current.temperature_2m), summary, icon, hours,
        range: `H ${degrees(json.daily.temperature_2m_max[0])}  L ${degrees(json.daily.temperature_2m_min[0])}`,
        credit: 'Weather data by Open-Meteo.com',
      });
    } catch (e) {
      if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
      this.env.logger.log(`[Liquid Glass] Open-Meteo request failed: ${e}`);
      this._show('Weather is not available right now');
    }
  }

  destroy(): void {
    this._stopSources();
    for (const id of this._weatherSettingsIds) this.env.settings.disconnect(id);
    this._weatherSettingsIds = [];
    this._session?.abort();
    this._session = null;
    super.destroy();
  }
}

const ART_SIZE = 56;
const ART_RADIUS = 10;
// The bars beside the title (px): their width, the room between them, and
// how tall they are when silent and when loudest.
const BAR_WIDTH = 4;
const BAR_GAP = 4;
const BAR_MIN = 4;
const BAR_MAX = 30;
// How long (s) a bar takes to rise most of the way to a louder level, and to fall to a quieter one.
const BAR_RISE_S = 0.04;
const BAR_FALL_S = 0.16;
const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

interface Player {
  name: string;
  proxy: Gio.DBusProxy | null;
  changedId: number;
  // When it last started playing, to pick the most recent one.
  playedAt: number;
}

/**
 * The song or video that is playing (or was last), with buttons for the
 * previous track, play/pause and the next track. Talks to the players over
 * MPRIS directly; the card hides itself while no player is running.
 */
export class MediaWidget extends GlassCard {
  private _art: St.Icon;
  private _bars: St.DrawingArea;
  private _levels: number[] = new Array(BAR_COUNT).fill(0);
  private _targets: number[] = new Array(BAR_COUNT).fill(0);
  private _barsTickId = 0;
  private _barsLastUs = 0;
  private _spectrum: AudioSpectrum;
  private _settingsId: number;
  private _title: St.Label;
  private _artist: St.Label;
  private _playButton: St.Button;
  private _players = new Map<string, Player>();
  private _ownerChangedId = 0;
  private _cancellable = new Gio.Cancellable();
  private _current: Player | null = null;

  constructor(env: ItemEnv) {
    super('media', env, CARD_WIDTH);
    this.shown = false;
    const row = new St.BoxLayout({ style_class: 'lg-row' });
    this._art = new St.Icon({ icon_size: ART_SIZE, fallback_icon_name: 'audio-x-generic-symbolic' });
    const rounded = new ContentLens();
    this._art.add_effect(rounded);
    this._art.connect('notify::allocation', () => rounded.shape([0, 0, this._art.width, this._art.height], 1, ART_RADIUS, 0));
    const text = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER, x_expand: true, ...verticalBoxParams() } as any);
    this._title = new St.Label({ style_class: 'lg-title' });
    this._artist = new St.Label({ style_class: 'lg-dim' });
    for (const label of [this._title, this._artist]) label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    text.add_child(this._title);
    text.add_child(this._artist);
    this._bars = new St.DrawingArea({ width: BAR_COUNT * BAR_WIDTH + (BAR_COUNT - 1) * BAR_GAP, height: BAR_MAX,
      y_align: Clutter.ActorAlign.CENTER });
    this._bars.connect('repaint', () => this._drawBars());
    // The bars are drawn in the title's color, which automatic contrast sets
    // on the labels only.
    this._title.connect('style-changed', () => this._bars.queue_repaint());
    row.add_child(this._art);
    row.add_child(text);
    row.add_child(this._bars);
    this._spectrum = new AudioSpectrum(env.logger, levels => {
      this._targets = levels;
      this._animateBars();
    });
    this._settingsId = env.settings.connect('changed::media-visualizer', () => this._update());

    const controls = new St.BoxLayout({ style_class: 'lg-controls', x_align: Clutter.ActorAlign.CENTER });
    const button = (icon: string, method: string) => {
      const b = new St.Button({ style_class: 'lg-control', can_focus: true,
        child: new St.Icon({ icon_name: icon, icon_size: 20 }) });
      b.connect('clicked', () => this._call(method));
      controls.add_child(b);
      return b;
    };
    button('media-skip-backward-symbolic', 'Previous');
    this._playButton = button('media-playback-start-symbolic', 'PlayPause');
    button('media-skip-forward-symbolic', 'Next');
    this.box.add_child(row);
    this.box.add_child(controls);

    this._ownerChangedId = Gio.DBus.session.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus',
      'NameOwnerChanged', '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
      (_c: any, _s: any, _p: any, _i: any, _sig: any, params: GLib.Variant) => {
        const [name, , newOwner] = params.deepUnpack() as string[];
        if (!name.startsWith(MPRIS_PREFIX)) return;
        if (newOwner) this._addPlayer(name);
        else this._removePlayer(name);
      });
    Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
      null, null, Gio.DBusCallFlags.NONE, -1, this._cancellable, (conn: any, res: any) => {
        try {
          const [names] = conn.call_finish(res).deepUnpack() as [string[]];
          for (const name of names) if (name.startsWith(MPRIS_PREFIX)) this._addPlayer(name);
        } catch (e) {
          if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
            env.logger.log(`[Liquid Glass] Could not list media players: ${e}`);
        }
      });
  }

  private _addPlayer(name: string): void {
    if (this._players.has(name)) return;
    const player: Player = { name, proxy: null, changedId: 0, playedAt: 0 };
    this._players.set(name, player);
    Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null, name, MPRIS_PATH, PLAYER_IFACE,
      this._cancellable, (_o: any, res: any) => {
        try {
          player.proxy = Gio.DBusProxy.new_for_bus_finish(res);
        } catch (e) {
          if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
            this.env.logger.log(`[Liquid Glass] Could not reach media player ${name}: ${e}`);
          return;
        }
        if (this._players.get(name) !== player) return;
        player.changedId = player.proxy.connect('g-properties-changed', () => this._update());
        this._update();
      });
  }

  private _removePlayer(name: string): void {
    const player = this._players.get(name);
    if (!player) return;
    this._players.delete(name);
    if (player.proxy && player.changedId) player.proxy.disconnect(player.changedId);
    if (this._current === player) this._current = null;
    this._update();
  }

  private _property(player: Player, name: string): any {
    return player.proxy?.get_cached_property(name)?.recursiveUnpack() ?? null;
  }

  // The player that is playing, or the one that played last.
  private _pick(): Player | null {
    let best: Player | null = null;
    const now = GLib.get_monotonic_time();
    for (const player of this._players.values()) {
      if (!player.proxy) continue;
      if (this._property(player, 'PlaybackStatus') === 'Playing') player.playedAt = now;
      if (!best || player.playedAt > best.playedAt) best = player;
    }
    return best;
  }

  private _update(): void {
    const player = this._pick();
    this._current = player;
    const metadata = player ? this._property(player, 'Metadata') ?? {} : {};
    const title: string = metadata['xesam:title'] ?? '';
    const artists = metadata['xesam:artist'];
    this.shown = !!player && !!title;
    if (!this.shown) {
      this._listen(false);
      return;
    }
    this._title.text = title;
    this._artist.text = Array.isArray(artists) ? artists.join(', ') : (artists ?? '');
    const art: string = metadata['mpris:artUrl'] ?? '';
    this._art.gicon = art ? new Gio.FileIcon({ file: Gio.File.new_for_uri(art) }) : null;
    const playing = this._property(player!, 'PlaybackStatus') === 'Playing';
    (this._playButton.child as St.Icon).icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
    this._listen(playing);
    this.contentChanged();
  }

  // The bars follow the sound while a player plays, and lie down otherwise.
  private _listen(playing: boolean): void {
    const on = this.env.settings.get_boolean('media-visualizer');
    this._bars.visible = on;
    if (on && playing && this.shown) {
      this._spectrum.start();
      return;
    }
    this._spectrum.stop();
    this._targets = new Array(BAR_COUNT).fill(0);
    this._animateBars();
  }

  private _animateBars(): void {
    if (this._barsTickId) return;
    this._barsLastUs = GLib.get_monotonic_time();
    this._barsTickId = addFrameTicker(() => {
      const now = GLib.get_monotonic_time();
      const dt = (now - this._barsLastUs) / 1e6;
      this._barsLastUs = now;
      let moving = false;
      this._levels = this._levels.map((level, i) => {
        const target = this._targets[i] ?? 0;
        const next = target + (level - target) * Math.exp(-dt / (target > level ? BAR_RISE_S : BAR_FALL_S));
        if (Math.abs(next - target) < 0.002) return target;
        moving = true;
        return next;
      });
      this._bars.queue_repaint();
      if (moving || this._spectrum.listening) return true;
      this._barsTickId = 0;
      return false;
    }, 16);
  }

  // Rounded lines standing on the same baseline, in the title's color.
  private _drawBars(): void {
    const cr = this._bars.get_context();
    const [, height] = this._bars.get_surface_size();
    const color = this._title.get_theme_node().get_foreground_color();
    cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineWidth(BAR_WIDTH);
    const cap = BAR_WIDTH / 2;
    this._levels.forEach((level, i) => {
      const x = i * (BAR_WIDTH + BAR_GAP) + cap;
      const h = BAR_MIN + (BAR_MAX - BAR_MIN) * level;
      cr.moveTo(x, height - cap);
      cr.lineTo(x, height - h + cap);
    });
    cr.stroke();
    cr.$dispose();
  }

  private _call(method: string): void {
    this._current?.proxy?.call(method, null, Gio.DBusCallFlags.NONE, -1, null, null);
  }

  destroy(): void {
    this.env.settings.disconnect(this._settingsId);
    this._cancellable.cancel();
    if (this._ownerChangedId) Gio.DBus.session.signal_unsubscribe(this._ownerChangedId);
    this._ownerChangedId = 0;
    for (const name of [...this._players.keys()]) this._removePlayer(name);
    this._spectrum.stop();
    if (this._barsTickId) removeFrameTicker(this._barsTickId);
    this._barsTickId = 0;
    super.destroy();
  }
}

// What the speakers are playing, as the loudness of a few bands of
// frequencies, for the Now Playing card's bars. GStreamer reads the monitor of
// the default output and runs an FFT on it; the extension only reads the
// result.

// Imported dynamically, so that the extension still loads where GStreamer's
// introspection data is not installed.
let Gst: any = null;
try {
  Gst = (await import('gi://Gst?version=1.0')).default;
} catch {
  // AudioSpectrum.start() says so when it is first needed.
}

const RATE = 48000;
const BANDS = 256;
const INTERVAL_MS = 25;
const THRESHOLD_DB = -90;
// The bars' bands (Hz), low to high.
const RANGES: [number, number][] = [[40, 150], [150, 400], [400, 1000], [1000, 2500], [2500, 7000]];
export const BAR_COUNT = RANGES.length;
// Music has less energy the higher it goes, about this much less per octave;
// it is given back so the high bars move as much as the low ones.
const TILT_DB_PER_OCTAVE = 4.5;
// The loudest bar sets the top of the scale, which falls this fast (dB/s)
// when the music gets quieter, and the bars show this many dB below it.
const CEILING_FALL_DB = 8;
const RANGE_DB = 42;
const MIN_CEILING_DB = -70;
// A pipeline that fails, or goes quiet (the sound server restarted, the default output changed), is
// started again after this many seconds; the check for a silent one runs this often.
const RETRY_S = 2;
const WATCHDOG_S = 3;

/**
 * Listens while started, and calls `onLevels` with one level from 0 to 1 per
 * bar, low to high, every INTERVAL_MS.
 */
export class AudioSpectrum {
  private _pipeline: any = null;
  private _bus: any = null;
  private _busId = 0;
  private _ceiling = MIN_CEILING_DB;
  private _lastUs = 0;
  // Bands per bar, [first, end).
  private _bands: [number, number][];
  private _tilt: number[];
  // GStreamer lacks an element the pipeline needs; not tried again.
  private _unavailable = false;
  // Between start() and stop(), whether or not a pipeline is running right now.
  private _wanted = false;
  private _retryId = 0;
  private _watchdogId = 0;
  private _lastMessageUs = 0;

  constructor(private _logger: Logger, private _onLevels: (levels: number[]) => void) {
    const width = RATE / 2 / BANDS;
    this._bands = RANGES.map(([lo, hi]) => {
      const first = Math.floor(lo / width);
      return [first, Math.max(Math.ceil(hi / width), first + 1)];
    });
    const center = ([lo, hi]: [number, number]) => Math.sqrt(lo * hi);
    this._tilt = RANGES.map(r => TILT_DB_PER_OCTAVE * Math.log2(center(r) / center(RANGES[0])));
  }

  get listening(): boolean {
    return !!this._pipeline;
  }

  start(): void {
    this._wanted = true;
    this._begin();
  }

  stop(): void {
    this._wanted = false;
    this._end();
  }

  private _begin(): void {
    if (this._pipeline || this._unavailable) return;
    if (!Gst) {
      this._unavailable = true;
      this._logger.log('[Liquid Glass] GStreamer is not installed; the media card\'s bars stay still');
      return;
    }
    if (!Gst.is_initialized()) Gst.init(null);
    let pipeline;
    try {
      pipeline = Gst.parse_launch(
        'pulsesrc device=@DEFAULT_MONITOR@ client-name="Liquid Glass" latency-time=10000 buffer-time=40000 ' +
        `! audio/x-raw,rate=${RATE},channels=1 ! audioconvert ` +
        `! spectrum bands=${BANDS} threshold=${THRESHOLD_DB} interval=${INTERVAL_MS * 1000000} ! fakesink sync=false`);
    } catch (e) {
      this._unavailable = true;
      this._logger.log(`[Liquid Glass] Cannot listen to the sound for the media card: ${e}`);
      return;
    }
    this._pipeline = pipeline;
    this._bus = pipeline.get_bus();
    this._bus.add_signal_watch();
    this._busId = this._bus.connect('message', (_bus: any, message: any) => this._message(message));
    this._lastUs = 0;
    this._lastMessageUs = GLib.get_monotonic_time();
    pipeline.set_state(Gst.State.PLAYING);
    if (this._watchdogId) GLib.Source.remove(this._watchdogId);
    this._watchdogId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, WATCHDOG_S, () => {
      if (GLib.get_monotonic_time() - this._lastMessageUs > WATCHDOG_S * 1e6) this._restart();
      return GLib.SOURCE_CONTINUE;
    });
  }

  // Stops the pipeline, and starts it again shortly if it is still wanted.
  private _restart(): void {
    this._end();
    if (this._retryId) GLib.Source.remove(this._retryId);
    this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RETRY_S, () => {
      this._retryId = 0;
      if (this._wanted) this._begin();
      return GLib.SOURCE_REMOVE;
    });
  }

  private _end(): void {
    if (this._watchdogId) GLib.Source.remove(this._watchdogId);
    this._watchdogId = 0;
    if (this._retryId) GLib.Source.remove(this._retryId);
    this._retryId = 0;
    if (!this._pipeline) return;
    this._bus.disconnect(this._busId);
    this._bus.remove_signal_watch();
    this._pipeline.set_state(Gst.State.NULL);
    this._pipeline = null;
    this._bus = null;
    this._busId = 0;
  }

  private _message(message: any): void {
    if (message.type === Gst.MessageType.ERROR) {
      const [error] = message.parse_error();
      this._logger.log(`[Liquid Glass] Lost the sound for the media card, trying again: ${error?.message}`);
      this._restart();
      return;
    }
    if (message.type !== Gst.MessageType.ELEMENT) return;
    this._lastMessageUs = GLib.get_monotonic_time();
    const structure = message.get_structure();
    if (structure?.get_name() !== 'spectrum') return;
    const [ok, magnitudes] = structure.get_list('magnitude');
    if (!ok) return;
    const db = this._bands.map(([first, end], i) => {
      let power = 0;
      for (let b = first; b < end; b++) power += 10 ** (magnitudes.get_nth(b) / 10);
      return 10 * Math.log10(power / (end - first)) + this._tilt[i];
    });

    const now = GLib.get_monotonic_time();
    const dt = this._lastUs ? (now - this._lastUs) / 1e6 : 0;
    this._lastUs = now;
    this._ceiling = Math.max(this._ceiling - CEILING_FALL_DB * dt, ...db, MIN_CEILING_DB);
    this._onLevels(db.map(v => Math.min(Math.max((v - this._ceiling + RANGE_DB) / RANGE_DB, 0), 1) ** 1.5));
  }
}
