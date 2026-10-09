// How a menu's glass grows out of its panel button and goes back into it, as
// one body of glass all the way. Opening, the button's capsule draws itself
// into a round drop as it drops out of the button, and the drop is thrown out
// to where the menu will be and swells to the menu's size, rounding off less
// and less; each time it is also given a push of its own, somewhere
// downwards, so no two openings are quite the same. Closing, the menu shrinks
// back into a drop that rises into the button, stretching into its capsule on
// the way, and fades there. The springs follow liquid-dom's menu demo.
const STEP_S = 0.002;
const MAX_FRAME_S = 0.05;

class Spring {
    value;
    _stiffness;
    _damping;
    velocity = 0;
    target;

    constructor(value, _stiffness, _damping) {
        this.value = value;
        this._stiffness = _stiffness;
        this._damping = _damping;
        this.target = value;
    }

    step(dt) {
        const acc = -this._stiffness * (this.value - this.target) - this._damping * this.velocity;
        this.velocity += acc * dt;
        this.value += this.velocity * dt;
    }

    settled(within) {
        return Math.abs(this.value - this.target) < within && Math.abs(this.velocity) < within * 10;
    }
}

// [stiffness, damping], unit mass, as liquid-dom's demo has them.
const OPEN_MOVE = [144, 14];
const CLOSE_MOVE = [130, 18];
const CONTENT_FADE = [137, 20];
// The demo throws the menu out at 2400 px/s over about 150 px; here the
// throw is that many times the distance, per second.
const THROW = 16;
// The push each opening gets on top of the throw, px/s per px of the menu's
// shorter side, at its strongest: the menu swings aside or dips by at most
// about 6% of that side before it settles. Its strength is drawn from
// PUSH_MIN to 1 of that, its direction from anywhere in the lower half.
const PUSH = 1.3;
const PUSH_MIN = 0.3;
// The capsule draws into a drop this many times the button's height across,
// while it drops this many heights below the button.
const DROP_SIZE = 1.15;
const DROP_FALL = 2;
const CAPSULE_S = 0.14;
// The springs swing the drop past the menu; as it swells to the menu's size,
// all but this much of the swing is taken out, so the grown glass does not
// shoot back over the menu.
const SETTLED_SWING = 0.25;
const OPEN_SIZE_S = 0.3;
const CLOSE_SIZE_S = 0.25;
const CONTENT_SCALE_S = 0.3;
// The content starts twice its size.
const CONTENT_CLOSED_SCALE = 2;
// The content is seen through the glass as if it were deep inside it when
// the menu opens, and comes up to the surface over this long.
const LENS_S = 0.3;
// Closing: the drop starts to turn into the capsule once it is this many
// button heights from where the capsule rests, or this long after closing
// began whatever, and rises into place as it does over CLOSE_CAPSULE_S. It
// fades over FADE_S from FADE_DELAY_S after it starts to, so it is still
// plainly seen as the capsule, and then goes: on the button it only hides
// the clock, bent by the glass.
const ARRIVE_HEIGHTS = 2;
const ARRIVE_MAX_S = 0.6;
const CLOSE_CAPSULE_S = 0.16;
const FADE_DELAY_S = 0.14;
const FADE_S = 0.12;
// Over the button the bent, blurred clock looks muddy, so the refraction and
// the blur are taken down (MorphFrame.soften) as the drop comes back to the
// button, from this many button heights away, and are all the way down when
// it touches the button. Once on its way into the capsule, they are down
// SOFTEN_S after that at the latest.
const SOFTEN_HEIGHTS = 1.5;
const SOFTEN_S = 0.1;

function cubicBezier(x1, y1, x2, y2) {
    const at = (t, a, b) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
    const slope = (t, a, b) => 3 * a * (1 - t) ** 2 + 6 * (b - a) * t * (1 - t) + 3 * (1 - b) * t * t;
    return x => {
        if (x <= 0 || x >= 1)
            return Math.min(Math.max(x, 0), 1);
        let t = x;
        for (let i = 0; i < 8; i++) {
            const d = slope(t, x1, x2);
            if (Math.abs(d) < 1e-6)
                break;
            t = Math.min(Math.max(t - (at(t, x1, x2) - x) / d, 0), 1);
        }
        return at(t, y1, y2);
    };
}

// Slow out of the drop, then quick to the menu's size.
const openSize = cubicBezier(0.8, 0.3, 0.5, 0.8);

const easeOut = (t) => 1 - (1 - t) ** 2;

const easeInOut = (t) => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

function clamp01(t) {
    return Math.min(Math.max(t, 0), 1);
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

export class MenuMorphMotion {
    opening;
    _buttonRect;
    _menu;
    _menuRadius;
    _t = 0;
    _x;
    _y;
    _opacity;
    // Opening: how long the capsule takes to draw into a drop (0 when the
    // motion takes over from another). The rest of the motion starts after it.
    _capsuleS;
    _sizeFrom;
    // Opening, how round the corners start, as a fraction of the roundest they
    // can be; closing, the radius they start from.
    _radiusFrom;
    _contentFrom;
    _lensFrom;
    // Closing: when the drop came near the button, and its size then.
    _arrivedAt = -1;
    _arrivedSize = [];
    // Closing: the furthest the body has been from the button, and how far the
    // refraction and blur are down; they never come back up.
    _furthest = 0;
    _soften = 0;
    _frame;

    /**
     * Starts towards the menu (`opening`) or back to the button, from `from`
     * (the frame a reversed motion had got to) or from where that motion rests.
     * `random` gives the opening its push.
     */
    constructor(opening, _buttonRect, _menu, _menuRadius, from = null, velocities = null, random = Math.random) {
        this.opening = opening;
        this._buttonRect = _buttonRect;
        this._menu = _menu;
        this._menuRadius = _menuRadius;
        const start = from ?? (opening
            ? { body: [..._buttonRect], bodyRadius: _buttonRect[3] / 2, contentScale: CONTENT_CLOSED_SCALE,
                contentOpacity: 0, lens: 1, glassOpacity: 1, soften: 0, done: false }
            : { body: [..._menu], bodyRadius: _menuRadius, contentScale: 1, contentOpacity: 1, lens: 0, glassOpacity: 1,
                soften: 0, done: false });
        this._frame = start;
        this._capsuleS = opening && !from ? CAPSULE_S : 0;
        const [stiffness, damping] = opening ? OPEN_MOVE : CLOSE_MOVE;
        // The drop is thrown from where it fell to.
        const [cx, y] = centre(start.body);
        const cy = y + (this._capsuleS ? this._fall() : 0);
        this._x = new Spring(cx, stiffness, damping);
        this._y = new Spring(cy, stiffness, damping);
        this._opacity = new Spring(start.contentOpacity, CONTENT_FADE[0], CONTENT_FADE[1]);
        if (velocities)
            [this._x.velocity, this._y.velocity] = velocities;
        const drop = this._drop();
        this._sizeFrom = this._capsuleS ? [drop, drop] : [start.body[2], start.body[3]];
        this._radiusFrom = opening ? (from ? start.bodyRadius / Math.max(Math.min(start.body[2], start.body[3]) / 2, 1) : 1)
            : start.bodyRadius;
        this._contentFrom = start.contentScale;
        this._lensFrom = start.lens;
        this._aim();
        if (opening && !velocities) {
            for (const s of [this._x, this._y])
                s.velocity = (s.target - s.value) * THROW;
            const angle = random() * Math.PI;
            const push = PUSH * Math.min(_menu[2], _menu[3]) * lerp(PUSH_MIN, 1, random());
            this._x.velocity += Math.cos(angle) * push;
            this._y.velocity += Math.sin(angle) * push;
        }
    }

    /** The body's velocity, for a motion that reverses this one. */
    get velocities() {
        return [this._x.velocity, this._y.velocity];
    }

    get frame() {
        return this._frame;
    }

    /** Where the button and the menu are now; they may move while it runs. */
    retarget(button, menu, menuRadius) {
        this._buttonRect = button;
        if (menu)
            this._menu = menu;
        this._menuRadius = menuRadius;
        this._aim();
    }

    _fall() {
        return this._buttonRect[3] * DROP_FALL;
    }

    // The round drop between the capsule and the menu, px across.
    _drop() {
        const [, , w, h] = this._buttonRect;
        return Math.max(Math.min(h * DROP_SIZE, w), 1);
    }

    _aim() {
        [this._x.target, this._y.target] = centre(this.opening ? this._menu : this._buttonRect);
        this._opacity.target = this.opening ? 1 : 0;
    }

    /** Advances by `elapsed` seconds. */
    step(elapsed) {
        const dt = Math.min(Math.max(elapsed, 0), MAX_FRAME_S);
        this._t += dt;
        this._frame = this.opening ? this._open(dt) : this._close(dt);
        return this._frame;
    }

    _stepSprings(dt) {
        for (let t = 0; t < dt; t += STEP_S) {
            const h = Math.min(STEP_S, dt - t);
            for (const s of [this._x, this._y, this._opacity])
                s.step(h);
        }
    }

    _open(dt) {
        if (this._t < this._capsuleS) {
            // The capsule draws into a drop where it is.
            const t = this._t / this._capsuleS;
            // It leaves the button as a capsule and rounds off on the way down,
            // falling faster and faster into the throw.
            const k = easeInOut(clamp01((t - 0.3) / 0.7));
            const [bx, by, bw, bh] = this._buttonRect;
            const drop = this._drop();
            const w = lerp(bw, drop, k), h = lerp(bh, drop, k);
            const y = by + bh / 2 + this._fall() * t ** 1.5;
            return { body: [bx + bw / 2 - w / 2, y - h / 2, w, h], bodyRadius: Math.min(w, h) / 2,
                contentScale: CONTENT_CLOSED_SCALE, contentOpacity: 0, lens: 1, glassOpacity: 1, soften: 0, done: false };
        }
        this._stepSprings(Math.min(dt, this._t - this._capsuleS));
        const t = this._t - this._capsuleS;
        const k = openSize(clamp01(t / OPEN_SIZE_S));
        const w = lerp(this._sizeFrom[0], this._menu[2], k);
        const h = lerp(this._sizeFrom[1], this._menu[3], k);
        // The corners square off as the glass grows, and are the menu's once it has.
        const radius = lerp(this._radiusFrom * Math.min(w, h) / 2, this._menuRadius, k);
        const moving = !this._x.settled(0.5) || !this._y.settled(0.5);
        const swing = lerp(1, SETTLED_SWING, k);
        const x = this._x.target + (this._x.value - this._x.target) * swing;
        const y = this._y.target + (this._y.value - this._y.target) * swing;
        return {
            body: [x - w / 2, y - h / 2, w, h],
            bodyRadius: Math.min(radius, w / 2, h / 2),
            contentScale: lerp(this._contentFrom, 1, easeOut(clamp01(t / CONTENT_SCALE_S))),
            contentOpacity: clamp01(this._opacity.value),
            lens: this._lensFrom * (1 - clamp01(t / LENS_S) ** 2),
            glassOpacity: 1,
            soften: 0,
            done: !moving && t >= OPEN_SIZE_S,
        };
    }

    _close(dt) {
        this._stepSprings(dt);
        const t = this._t;
        const drop = this._drop();
        const k = easeOut(clamp01(t / CLOSE_SIZE_S));
        const w = lerp(this._sizeFrom[0], drop, k);
        const h = lerp(this._sizeFrom[1], drop, k);
        // Rounding off into the drop as it shrinks, as the opening squares off as it grows.
        const radius = lerp(this._radiusFrom, Math.min(w, h) / 2, k);
        let body = [this._x.value - w / 2, this._y.value - h / 2, w, h];
        let bodyRadius = Math.min(radius, w / 2, h / 2);
        const [hx, hy] = centre(this._buttonRect);
        const near = Math.hypot(this._x.value - hx, this._y.value - hy) <= this._buttonRect[3] * ARRIVE_HEIGHTS;
        if (this._arrivedAt < 0 && ((near && t >= CLOSE_SIZE_S) || t >= ARRIVE_MAX_S)) {
            this._arrivedAt = t;
            this._arrivedSize = [w, h];
        }
        let glassOpacity = 1;
        let since = -1;
        if (this._arrivedAt >= 0) {
            // Into the capsule as it rises, ending on the button wherever the springs are.
            since = t - this._arrivedAt;
            const c = easeInOut(clamp01(since / CLOSE_CAPSULE_S));
            const [aw, ah] = this._arrivedSize;
            const [, , bw, bh] = this._buttonRect;
            const cw = lerp(aw, bw, c), ch = lerp(ah, bh, c);
            const cx = lerp(this._x.value, hx, c), cy = lerp(this._y.value, hy, c);
            body = [cx - cw / 2, cy - ch / 2, cw, ch];
            bodyRadius = Math.min(cw, ch) / 2;
            glassOpacity = 1 - easeInOut(clamp01((since - FADE_DELAY_S) / FADE_S));
        }
        // Measured from the furthest it got, so a menu that opened right below
        // the button does not start out half way down.
        const gap = rectGap(body, this._buttonRect);
        this._furthest = Math.max(this._furthest, gap);
        const ramp = Math.min(this._buttonRect[3] * SOFTEN_HEIGHTS, this._furthest);
        const closeness = ramp > 0 ? 1 - gap / ramp : 1;
        this._soften = Math.max(this._soften, clamp01(closeness), since >= 0 ? clamp01(since / SOFTEN_S) : 0);
        const soften = this._soften;
        return {
            body,
            bodyRadius,
            contentScale: lerp(this._contentFrom, CONTENT_CLOSED_SCALE, easeOut(clamp01(t / CONTENT_SCALE_S))),
            contentOpacity: clamp01(this._opacity.value),
            lens: 0,
            glassOpacity,
            soften,
            done: glassOpacity === 0,
        };
    }
}

// How far apart two rects are, 0 when they touch or overlap.
function rectGap(a, b) {
    const dx = Math.max(b[0] - (a[0] + a[2]), a[0] - (b[0] + b[2]), 0);
    const dy = Math.max(b[1] - (a[1] + a[3]), a[1] - (b[1] + b[3]), 0);
    return Math.hypot(dx, dy);
}

function centre(r) {
    return [r[0] + r[2] / 2, r[1] + r[3] / 2];
}
