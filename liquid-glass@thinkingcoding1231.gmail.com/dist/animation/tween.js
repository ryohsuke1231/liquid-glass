// A rectangle that eases to each new target in a fixed time, without the
// overshoot of a spring.
function easeOutCubic(t) {
    return 1 - (1 - t) ** 3;
}

export class RectTween {
    _durationMs;
    _from = [0, 0, 1, 1];
    _to = [0, 0, 1, 1];
    _startUs = 0;

    constructor(_durationMs) {
        this._durationMs = _durationMs;
    }

    /** Puts it at `rect` [x, y, w, h] and eases from there to `target`. */
    start(rect, target, nowUs) {
        this._from = [...rect];
        this._to = [...target];
        this._startUs = nowUs;
    }

    /** Eases from where it is now to `target`, unless it is already heading there. */
    setTarget(target, nowUs) {
        if (target.every((v, i) => Math.abs(v - this._to[i]) < 0.5))
            return;
        this.start(this.rect(nowUs), target, nowUs);
    }

    /** Milliseconds until it lands, 0 once it has. */
    remaining(nowUs) {
        return Math.max(this._durationMs - (nowUs - this._startUs) / 1000, 0);
    }

    rect(nowUs) {
        const t = Math.min(Math.max((nowUs - this._startUs) / (this._durationMs * 1000), 0), 1);
        const k = easeOutCubic(t);
        return this._from.map((v, i) => v + (this._to[i] - v) * k);
    }
}
