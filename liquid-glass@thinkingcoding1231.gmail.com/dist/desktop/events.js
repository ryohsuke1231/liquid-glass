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
exports.EventsWidget = void 0;
const Main = __importStar(require("resource:///org/gnome/shell/ui/main.js"));
const dateUtils_js_1 = require("resource:///org/gnome/shell/misc/dateUtils.js");
const 1 = __importDefault(require("gi://Clutter"));
const 2 = __importDefault(require("gi://GLib"));
const 3 = __importDefault(require("gi://Pango"));
const 4 = __importDefault(require("gi://Shell"));
const 5 = __importDefault(require("gi://St"));
const desktopItem_js_1 = require("./desktopItem.js");
const shellVersion_js_1 = require("../shellVersion.js");
const CARD_WIDTH = 300;
const MAX_EVENTS = 4;
const CALENDAR_APP = 'org.gnome.Calendar.desktop';

function startOfDay(date, days = 0) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}
/**
 * The rest of today's events and tomorrow's, from the calendars the shell's
 * calendar menu shows. It reads the events the menu has already loaded
 * rather than asking for its own range, which would change what the menu
 * shows.
 */

class EventsWidget extends desktopItem_js_1.GlassCard {
    _title;
    _list;
    _source = null;
    _sourceId = 0;
    _timerId = 0;
    constructor(env) {
        super('events', env, CARD_WIDTH);
        this._title = new 5.default.Label({ style_class: 'lg-title', text: 'Up Next' });
        this._list = new 5.default.BoxLayout({ style_class: 'lg-list', ...(0, shellVersion_js_1.verticalBoxParams)() });
        this.box.add_child(this._title);
        this.box.add_child(this._list);
        // The times move on even when the events do not.
        this._timerId = 2.default.timeout_add_seconds(2.default.PRIORITY_DEFAULT, 60, () => {
            this._update();
            return 2.default.SOURCE_CONTINUE;
        });
        this._update();
    }
    activate() {
        4.default.AppSystem.get_default().lookup_app(CALENDAR_APP)?.activate();
    }
    // The menu's event source, which the shell replaces when the session mode changes.
    _eventSource() {
        const source = Main.panel.statusArea.dateMenu._eventSource;
        if (source !== this._source) {
            if (this._source && this._sourceId)
                this._source.disconnect(this._sourceId);
            this._source = source;
            this._sourceId = source ? source.connect('changed', () => this._update()) : 0;
        }
        return source;
    }
    _row(time, summary) {
        const row = new 5.default.BoxLayout({ style_class: 'lg-event' });
        row.add_child(new 5.default.Label({ text: time, style_class: 'lg-event-time', y_align: 1.default.ActorAlign.START }));
        const label = new 5.default.Label({ text: summary, style_class: 'lg-event-summary', x_expand: true });
        label.clutter_text.ellipsize = 3.default.EllipsizeMode.END;
        row.add_child(label);
        return row;
    }
    _update() {
        const source = this._eventSource();
        this._list.destroy_all_children();
        if (!source?.hasCalendars) {
            this._list.add_child(new 5.default.Label({ text: 'No calendars', style_class: 'lg-dim' }));
            this.contentChanged();
            return;
        }
        const now = new Date();
        const today = startOfDay(now);
        const tomorrow = startOfDay(now, 1);
        const after = startOfDay(now, 2);
        const events = source.getEvents(now, after).slice(0, MAX_EVENTS);
        let day = null;
        for (const event of events) {
            const starts = event.date;
            const ends = event.end;
            const heading = starts < tomorrow ? today : tomorrow;
            if (heading !== day && heading === tomorrow) {
                this._list.add_child(new 5.default.Label({ text: 'Tomorrow', style_class: 'lg-small lg-heading' }));
            }
            day = heading;
            const dayStart = heading;
            const dayEnd = startOfDay(heading, 1);
            const allDay = starts <= dayStart && ends >= dayEnd;
            this._list.add_child(this._row(allDay ? 'All day' : (0, dateUtils_js_1.formatTime)(starts, { timeOnly: true }), event.summary));
        }
        if (events.length === 0)
            this._list.add_child(new 5.default.Label({ text: 'Nothing else today or tomorrow', style_class: 'lg-dim' }));
        this.contentChanged();
    }
    destroy() {
        if (this._timerId)
            2.default.Source.remove(this._timerId);
        this._timerId = 0;
        if (this._source && this._sourceId)
            this._source.disconnect(this._sourceId);
        this._source = null;
        super.destroy();
    }
}
exports.EventsWidget = EventsWidget;
