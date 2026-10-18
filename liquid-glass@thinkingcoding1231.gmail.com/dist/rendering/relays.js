// Relays keep a reused backdrop copy correct. Every actor painted before a
// glass gets an invisible clone (a relay) whose paint volume is the glass's
// sample area, so a redraw anywhere in that actor, which Clutter forwards to
// its clones, puts the whole sample area into the same frame's redraw clip,
// and the glass copies its backdrop again.
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import { UnpickableActor } from '../actors/unpickable.js';
import { setTranslationIfChanged, setScaleIfChanged } from '../actors/writes.js';
import { undoCloneScale } from '../shellVersion.js';
// Room around the sample rect, so the rect can shift a little at paint time
// (the live geometry hook) and still be inside the redrawn area.
export const SAMPLE_MARGIN = 32;
// The fixed size of the sample area actor and of every relay. The area is
// fitted to the sample rect by translation and scale only: moving or resizing
// an actor through its position or size goes through a relayout, and
// redrawing an actor whose relayout is still pending redraws the whole stage.
const SAMPLE_BASE = 256;
// Room for a server-side shadow around a window that moved this frame, whose
// paint volume is not known yet (see windowReaches()).
const WINDOW_SHADOW_MARGIN = 80;
// A relay is hidden only once its source is this much further away than it
// had to come to be shown, so a source on the edge of a growing or moving
// area does not toggle every frame. Kept small: a source inside the margin
// still costs a copy whenever it redraws.
const RELAY_KEEP_MARGIN = 16;

/**
 * Its paint volume is its own box (the sample area), not the source's: a
 * redraw anywhere in the source then damages exactly the sample area,
 * whatever happens to the source's size in that frame.
 */
const BackdropRelay = GObject.registerClass(class BackdropRelay extends Clutter.Clone {
    _init(params) {
        super._init(params);
        Shell.util_set_hidden_from_pick(this, true);
        this._allocated = false;
    }

    vfunc_allocate(box) {
        super.vfunc_allocate(box);
        this._allocated = true;
    }

    // A clone is relaid out whenever its source is, every frame for a
    // dragged window, and the request climbs to the glass, which then waits
    // for an allocation in every frame. A relay's box never changes, so once
    // it has one the requests stop here.
    vfunc_queue_relayout() {
        if (!this._allocated)
            super.vfunc_queue_relayout();
    }

    vfunc_pick(_pickContext) {
    }

    vfunc_get_paint_volume(volume) {
        if (!volume.set_from_allocation(this))
            return false;
        undoCloneScale(this, volume);
        return true;
    }
});

// Actors that only carry relays for a backdrop read inside another actor's
// paint (relayHolder()). They draw nothing, so no glass reads them.
const holders = new WeakSet();

/**
 * A parent for the relays of a RelaySet whose owner is not ours to add
 * children to. It goes on top of the UI group, which is at the stage's
 * origin, so its coordinates are the stage's.
 */
export function relayHolder() {
    const holder = new UnpickableActor({ name: 'liquid-glass-relay-holder' });
    holders.add(holder);
    return holder;
}

export class RelaySet {
    _owner;
    _exclude;
    _holder;
    // Parent of the relays, covering the sample rect (see SAMPLE_BASE). It
    // draws nothing itself; it is painted (opacity 255) so that its children
    // are visited and Clutter keeps forwarding their sources' redraws.
    area;
    _relays = new Map();
    changes = 0;

    // `exclude` names actors painted before the owner that are not part of
    // its backdrop. The relays go in `holder`, the owner itself by default.
    constructor(_owner, _exclude = () => false, _holder = _owner) {
        this._owner = _owner;
        this._exclude = _exclude;
        this._holder = _holder;
        this.area = new UnpickableActor({ name: 'liquid-glass-sample-area', width: SAMPLE_BASE, height: SAMPLE_BASE });
        _holder.add_child(this.area);
    }

    /**
     * Fits the sample area to `rect` [x, y, w, h] in the holder's coordinates
     * and updates the relays. Returns whether the set of relayed actors
     * changed, which changes the backdrop without necessarily redrawing all
     * of it; the caller then redraws the area.
     */
    sync(rect) {
        const [x, y, w, h] = rect;
        setTranslationIfChanged(this.area, x, y);
        setScaleIfChanged(this.area, w / SAMPLE_BASE, h / SAMPLE_BASE);
        // A relay out of reach is hidden rather than destroyed, and shown again
        // when its source comes back: Clutter redraws the whole stage for an
        // actor's first frame on stage, since it has no previous paint volume to
        // damage.
        const near = this._localToStage(x, y, x + w, y + h);
        const m = RELAY_KEEP_MARGIN;
        const keep = [near[0] - m, near[1] - m, near[2] + m, near[3] + m];
        const sources = this._collectSources(near, keep);
        let changed = false;
        for (const [source, relay] of this._relays) {
            const reach = sources.get(source);
            if (reach === undefined) {
                if (relay.visible)
                    changed = true;
                relay.destroy();
                this._relays.delete(source);
                continue;
            }
            const show = relay.visible ? reach.keep : reach.near;
            if (relay.visible !== show) {
                relay.visible = show;
                changed = true;
            }
        }
        for (const [source, reach] of sources) {
            if (this._relays.has(source) || !reach.near)
                continue;
            const relay = new BackdropRelay({ source, opacity: 0, width: SAMPLE_BASE, height: SAMPLE_BASE });
            this.area.add_child(relay);
            this._relays.set(source, relay);
            changed = true;
        }
        if (changed)
            this.changes++;
        return changed;
    }

    redrawArea() {
        this.area.queue_redraw();
    }

    // The relays go with the owner when it is destroyed; at shell shutdown they
    // can already be gone by the time the owner is cleaned up.
    clear() {
        this._relays.clear();
    }

    // The relayed actors, for the dump. Through the relay, whose source is
    // null once the source is gone.
    names() {
        return [...this._relays.values()].filter(relay => relay.visible).map(relay => {
            const a = relay.source;
            if (!a)
                return '(destroyed)';
            if (a instanceof Meta.WindowActor)
                return `window:${a.get_meta_window()?.get_title() ?? '?'}`;
            return a.get_name() || a.constructor.$gtype.name;
        });
    }

    areaRect() {
        return [this.area.translation_x, this.area.translation_y,
            this.area.scale_x * SAMPLE_BASE, this.area.scale_y * SAMPLE_BASE].map(v => Math.round(v));
    }

    _localToStage(x0, y0, x1, y1) {
        return localToStage(this._holder, x0, y0, x1, y1);
    }

    // Everything painted before the owner, and whether it reaches the sample
    // area (`near`) or the wider area a shown relay is kept for (`keep`): the
    // earlier siblings of the owner and of each of its ancestors, and the
    // children of the window group. Never an ancestor itself, whose paint
    // volume would contain the relays. A window's glass meets the windows
    // below it as earlier siblings of its own window.
    _collectSources(near, keep) {
        const wanted = new Map();
        let child = this._owner;
        let parent = child.get_parent();
        while (parent) {
            for (let s = parent.get_first_child(); s && s !== child; s = s.get_next_sibling()) {
                if (!s.mapped || s.opacity === 0 || holders.has(s) || this._exclude(s))
                    continue;
                if (s === global.window_group)
                    this._collectWindowGroup(s, near, keep, wanted);
                else
                    wanted.set(s, sourceReach(s, near, keep));
            }
            child = parent;
            parent = parent.get_parent();
        }
        return wanted;
    }

    _collectWindowGroup(group, near, keep, wanted) {
        for (let a = group.get_first_child(); a; a = a.get_next_sibling()) {
            if (!a.mapped || a.opacity === 0)
                continue;
            wanted.set(a, sourceReach(a, near, keep));
        }
    }
}

function sourceReach(actor, near, keep) {
    if (actor instanceof Meta.WindowActor)
        return { near: windowReaches(actor, near), keep: windowReaches(actor, keep) };
    return { near: actorReaches(actor, near), keep: actorReaches(actor, keep) };
}

// The stage rect [x0, y0, x1, y1] of a rect in `actor`'s coordinates.
export function localToStage(actor, x0, y0, x1, y1) {
    const a = actor.apply_transform_to_point(new Graphene.Point3D({ x: x0, y: y0, z: 0 }));
    const b = actor.apply_transform_to_point(new Graphene.Point3D({ x: x1, y: y1, z: 0 }));
    return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
}

// Moving an actor queues its redraw at once but changes its allocation only
// in the coming relayout, so an actor waiting for one may be about to enter
// the area and counts as reaching it. Otherwise its paint volume (which
// already includes this frame's transitions) tells.
function actorReaches(actor, area) {
    if (!actor.has_allocation())
        return true;
    const pv = actor.get_transformed_paint_volume(global.stage);
    return !pv || volumeReaches(pv, area);
}

function volumeReaches(pv, area) {
    const o = pv.get_origin();
    return o.x < area[2] && o.x + pv.get_width() > area[0] &&
        o.y < area[3] && o.y + pv.get_height() > area[1];
}

// A window's paint volume includes the shadow mutter draws around it. A
// window moved this frame has last frame's volume until the relayout, so
// its buffer rect, already moved, decides, with room for a shadow.
function windowReaches(actor, area) {
    if (actor.has_allocation()) {
        const pv = actor.get_transformed_paint_volume(global.stage);
        if (pv)
            return volumeReaches(pv, area);
    }
    const r = actor.get_meta_window()?.get_buffer_rect();
    if (!r)
        return true;
    const m = WINDOW_SHADOW_MARGIN;
    return r.x - m < area[2] && r.x + r.width + m > area[0] &&
        r.y - m < area[3] && r.y + r.height + m > area[1];
}
