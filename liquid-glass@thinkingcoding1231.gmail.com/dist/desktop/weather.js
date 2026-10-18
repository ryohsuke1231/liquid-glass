"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WeatherWidget = void 0;
const Main = __importStar(require("resource:///org/gnome/shell/ui/main.js"));
const dateUtils_js_1 = require("resource:///org/gnome/shell/misc/dateUtils.js");
const 4 = __importDefault(require("gi://Clutter"));
const 5 = __importDefault(require("gi://GLib"));
const 6 = __importDefault(require("gi://Gio"));
const 7 = __importDefault(require("gi://GWeather"));
const 8 = __importDefault(require("gi://Soup?version=3.0"));
const 9 = __importDefault(require("gi://St"));
const desktopItem_js_1 = require("./desktopItem.js");
const shellVersion_js_1 = require("../shellVersion.js");
const CARD_WIDTH = 300;
const HOURS = 5;
// Open-Meteo is asked again after this long.
const REFRESH_S = 30 * 60;
const CONTACT = 'https://github.com/ryohsuke1231/liquid-glass';
const USER_AGENT = `Liquid Glass GNOME Shell extension (${CONTACT})`;

function sanitizeUnit(value) {
    return value === 'celsius' || value === 'fahrenheit' ? value : 'auto';
}

function degrees(value) {
    return `${Math.round(value)}°`;
}
// WMO weather codes, as Open-Meteo reports them.
const CODES = {
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

function wmo(code, isDay) {
    const [text, icon, night] = CODES[code] ?? ['Unknown', 'weather-severe-alert-symbolic'];
    return [text, !isDay && night ? night : icon];
}
// A summary for the weather an icon stands for, where libgweather gives no
// conditions or sky (MET Norway's forecasts have neither).
const ICON_SUMMARIES = [
    ['weather-clear', 'Clear'], ['weather-few-clouds', 'Partly Cloudy'], ['weather-overcast', 'Cloudy'],
    ['weather-fog', 'Fog'], ['weather-showers-scattered', 'Showers'], ['weather-showers', 'Rain'],
    ['weather-snow', 'Snow'], ['weather-storm', 'Thunderstorm'],
];

function iconSummary(icon) {
    return ICON_SUMMARIES.find(([prefix]) => icon.startsWith(prefix))?.[1] ?? '';
}

function placeOf(settings) {
    const [name, lat, lon] = settings.get_value('weather-place').deepUnpack();
    return name ? { name, lat, lon } : null;
}
/**
 * Today's weather and the next hours, for the place chosen in the
 * preferences or else the location GNOME Weather has set up (the one the
 * shell's calendar menu shows the weather for). With GNOME Weather installed
 * the forecasts come from libgweather, as in GNOME Weather; without it, from
 * Open-Meteo.
 */

class WeatherWidget extends desktopItem_js_1.GlassCard {
    _place;
    _icon;
    _temp;
    _summary;
    _hours;
    _credit;
    // The shell's weather client: GNOME Weather's location.
    _client = null;
    _clientId = 0;
    // Our own libgweather forecasts, for a chosen place.
    _info = null;
    _infoId = 0;
    _weatherSettingsIds = [];
    _session = null;
    _cancellable = null;
    _timerId = 0;
    constructor(env) {
        super('weather', env, CARD_WIDTH);
        this._place = new 9.default.Label({ style_class: 'lg-title' });
        const row = new 9.default.BoxLayout({ style_class: 'lg-row' });
        this._icon = new 9.default.Icon({ icon_size: 44, y_align: 4.default.ActorAlign.CENTER });
        this._temp = new 9.default.Label({ style_class: 'lg-big', y_align: 4.default.ActorAlign.CENTER });
        this._summary = new 9.default.Label({ style_class: 'lg-dim', y_align: 4.default.ActorAlign.CENTER, x_expand: true });
        row.add_child(this._icon);
        row.add_child(this._temp);
        row.add_child(this._summary);
        this._hours = new 9.default.BoxLayout({ style_class: 'lg-hours', x_expand: true });
        this._credit = new 9.default.Label({ style_class: 'lg-small', visible: false });
        for (const child of [this._place, row, this._hours, this._credit])
            this.box.add_child(child);
        for (const key of ['weather-place', 'weather-temperature-unit'])
            this._weatherSettingsIds.push(env.settings.connect(`changed::${key}`, () => this._refresh()));
        this._refresh();
    }
    _unit() {
        return sanitizeUnit(this.env.settings.get_string('weather-temperature-unit'));
    }
    // The shell's weather client, or null without GNOME Weather.
    _shellClient() {
        const client = Main.panel.statusArea.dateMenu._weatherItem._weatherClient;
        return client.available ? client : null;
    }
    _stopSources() {
        if (this._client && this._clientId)
            this._client.disconnect(this._clientId);
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
        if (this._timerId)
            5.default.Source.remove(this._timerId);
        this._timerId = 0;
    }
    _refresh() {
        this._stopSources();
        const place = placeOf(this.env.settings);
        const client = this._shellClient();
        if (place && client) {
            this._startOwnGWeather(place);
        }
        else if (place) {
            this._startOpenMeteo(place);
        }
        else if (client) {
            this._client = client;
            this._clientId = client.connect('changed', () => this._showShellWeather());
            client.update();
            this._showShellWeather();
        }
        else {
            this._show('Install GNOME Weather, or choose a place in the Liquid Glass preferences');
        }
    }
    activate() {
        this._shellClient()?.activateApp();
    }
    // Asks again every REFRESH_S.
    _every(fn) {
        fn();
        if (this._timerId)
            5.default.Source.remove(this._timerId);
        this._timerId = 5.default.timeout_add_seconds(5.default.PRIORITY_DEFAULT, REFRESH_S, () => {
            fn();
            return 5.default.SOURCE_CONTINUE;
        });
    }
    _show(report) {
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
            const column = new 9.default.BoxLayout({ style_class: 'lg-hour', x_expand: true, ...(0, shellVersion_js_1.verticalBoxParams)() });
            column.add_child(new 9.default.Label({ text: hour.label, style_class: 'lg-small', x_align: 4.default.ActorAlign.CENTER }));
            column.add_child(new 9.default.Icon({ icon_name: hour.icon, icon_size: 18, x_align: 4.default.ActorAlign.CENTER }));
            column.add_child(new 9.default.Label({ text: hour.temp, style_class: 'lg-small', x_align: 4.default.ActorAlign.CENTER }));
            this._hours.add_child(column);
        }
        this._credit.text = report.credit;
        this._credit.visible = !!report.credit;
        this.contentChanged();
    }
    _gweatherUnit() {
        const unit = this._unit();
        return unit === 'celsius' ? 7.default.TemperatureUnit.CENTIGRADE
            : unit === 'fahrenheit' ? 7.default.TemperatureUnit.FAHRENHEIT : 7.default.TemperatureUnit.DEFAULT;
    }
    _gweatherTemp(info) {
        const [ok, value] = info.get_value_temp(this._gweatherUnit());
        return ok ? value : null;
    }
    // A report from libgweather's `info`, for `place` (its own name when null).
    _gweatherReport(info, place, credit) {
        const icon = info.get_symbolic_icon_name();
        const conditions = info.get_conditions();
        const [hasSky] = info.get_value_sky();
        const summary = conditions && conditions !== '-' ? conditions : hasSky ? info.get_sky() : iconSummary(icon);
        const now = 5.default.DateTime.new_now_local();
        const today = now.format('%F');
        let last = 5.default.DateTime.new_from_unix_local(0);
        let high = -Infinity, low = Infinity;
        const hours = [];
        for (const forecast of info.get_forecast_list()) {
            const [valid, timestamp] = forecast.get_value_update();
            if (!valid || timestamp === 0)
                continue;
            const time = 5.default.DateTime.new_from_unix_local(timestamp);
            const temp = this._gweatherTemp(forecast);
            if (temp !== null && time.format('%F') === today) {
                high = Math.max(high, temp);
                low = Math.min(low, temp);
            }
            // Only the hours to come, at least an hour apart.
            if (now.difference(time) > 0 || time.difference(last) < 5.default.TIME_SPAN_HOUR || hours.length === HOURS)
                continue;
            last = time;
            hours.push({
                label: (0, dateUtils_js_1.formatTime)(new Date(timestamp * 1000), { timeOnly: true }),
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
    _showShellWeather() {
        const client = this._client;
        if (!client)
            return;
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
    _startOwnGWeather(place) {
        const info = new 7.default.Info({
            application_id: 'org.gnome.Shell', contact_info: CONTACT, enabled_providers: 7.default.Provider.MET_NO,
        });
        info.set_location(7.default.Location.new_detached(place.name, null, place.lat, place.lon));
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
    _startOpenMeteo(place) {
        this._session ??= new 8.default.Session({ user_agent: USER_AGENT, timeout: 20 });
        const cancellable = new 6.default.Cancellable();
        this._cancellable = cancellable;
        this._every(() => this._fetchOpenMeteo(place, cancellable));
    }
    _getJson(url, cancellable) {
        const message = 8.default.Message.new('GET', url);
        return new Promise((resolve, reject) => {
            this._session.send_and_read_async(message, 5.default.PRIORITY_DEFAULT, cancellable, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    if (message.get_status() !== 8.default.Status.OK)
                        throw new Error(`HTTP ${message.get_status()}`);
                    resolve(JSON.parse(new TextDecoder().decode(bytes.get_data())));
                }
                catch (e) {
                    reject(e);
                }
            });
        });
    }
    async _fetchOpenMeteo(place, cancellable) {
        try {
            const fahrenheit = this._unit() === 'fahrenheit' ||
                (this._unit() === 'auto' && /_US\b/.test(5.default.get_language_names()[0] ?? ''));
            const json = await this._getJson('https://api.open-meteo.com/v1/forecast' +
                `?latitude=${place.lat}&longitude=${place.lon}&timezone=auto&forecast_days=2` +
                '&current=temperature_2m,weather_code,is_day&hourly=temperature_2m,weather_code,is_day' +
                `&daily=temperature_2m_max,temperature_2m_min${fahrenheit ? '&temperature_unit=fahrenheit' : ''}`, cancellable);
            const current = json.current;
            const [summary, icon] = wmo(current.weather_code, current.is_day === 1);
            // The hourly times are local to the place, as is current.time.
            const start = json.hourly.time.findIndex(t => t > current.time);
            const hours = [];
            for (let i = Math.max(start, 0); i < json.hourly.time.length && hours.length < HOURS; i++) {
                const [, hourIcon] = wmo(json.hourly.weather_code[i], json.hourly.is_day[i] === 1);
                hours.push({ label: json.hourly.time[i].slice(11, 16), icon: hourIcon,
                    temp: degrees(json.hourly.temperature_2m[i]) });
            }
            this._show({
                place: place.name, temp: degrees(current.temperature_2m), summary, icon, hours,
                range: `H ${degrees(json.daily.temperature_2m_max[0])}  L ${degrees(json.daily.temperature_2m_min[0])}`,
                credit: 'Weather data by Open-Meteo.com',
            });
        }
        catch (e) {
            if (e instanceof 5.default.Error && e.matches(6.default.IOErrorEnum, 6.default.IOErrorEnum.CANCELLED))
                return;
            this.env.logger.log(`[Liquid Glass] Open-Meteo request failed: ${e}`);
            this._show('Weather is not available right now');
        }
    }
    destroy() {
        this._stopSources();
        for (const id of this._weatherSettingsIds)
            this.env.settings.disconnect(id);
        this._weatherSettingsIds = [];
        this._session?.abort();
        this._session = null;
        super.destroy();
    }
}
exports.WeatherWidget = WeatherWidget;
