import GLib from 'gi://GLib';
const KEY = 'launcher-pinned';
export class PinStore {
    _settings;
    constructor(_settings) {
        this._settings = _settings;
    }
    all() {
        const stored = this._settings.get_value(KEY).deep_unpack();
        return stored.map(p => ({ provider: p.provider ?? '', id: p.id ?? '', name: p.name ?? '',
            description: p.description ?? '', icon: p.icon ?? '' })).filter(p => p.provider && p.id);
    }
    has(provider, id) {
        return this.all().some(p => p.provider === provider && p.id === id);
    }
    /** The ids pinned from one provider. */
    idsOf(provider) {
        return new Set(this.all().filter(p => p.provider === provider).map(p => p.id));
    }
    /** Pins `pin`, or unpins it if it is pinned already; true when it ends up pinned. */
    toggle(pin) {
        const pins = this.all();
        const kept = pins.filter(p => p.provider !== pin.provider || p.id !== pin.id);
        const pinned = kept.length === pins.length;
        this._write(pinned ? [...kept, pin] : kept);
        return pinned;
    }
    _write(pins) {
        this._settings.set_value(KEY, new GLib.Variant('aa{ss}', pins.map(p => ({ ...p }))));
    }
}
