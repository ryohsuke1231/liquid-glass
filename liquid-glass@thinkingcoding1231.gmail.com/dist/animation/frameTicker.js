"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.addFrameTicker = addFrameTicker;
exports.removeFrameTicker = removeFrameTicker;
exports.normalizeAnimationIntervalMs = normalizeAnimationIntervalMs;
const 1 = __importDefault(require("gi://GLib"));
const 2 = __importDefault(require("gi://Meta"));
const logging_js_1 = require("../diagnostics/logging.js");
const frameSync_js_1 = require("./frameSync.js");
const MAX_INTERVAL_MS = 50;
let _nextId = 0;
const _tickers = new Map();
// Steps an animation at most once per frame from a BEFORE_REDRAW later, which
// also keeps the frame clock running while the animation lives. A GLib timer
// would beat against the frame; smoothness comes from sub-stepping the physics
// (Spring.update()), not from writing the actors more often. `cb` returns true
// to keep going; the returned id stays valid across the reschedules.

function addFrameTicker(cb, minIntervalMs = 0) {
    const id = ++_nextId;
    const ticker = { laterId: 0, cb, minUs: Math.max(0, minIntervalMs || 0) * 1000, last: 0 };
    _tickers.set(id, ticker);
    const schedule = () => {
        ticker.laterId = global.compositor.get_laters().add(2.default.LaterType.BEFORE_REDRAW, () => {
            ticker.laterId = 0;
            if (_tickers.get(id) !== ticker)
                return 1.default.SOURCE_REMOVE;
            let keep = true;
            const now = 1.default.get_monotonic_time();
            // At most once per frame even when several stage views update in the
            // same one (SAME_FRAME_WINDOW_US), and a little slack so a 16ms minimum
            // does not drop a frame whose interval happened to measure 15.9ms.
            const due = ticker.last === 0 ||
                now - ticker.last >= Math.max(frameSync_js_1.SAME_FRAME_WINDOW_US, ticker.minUs - frameSync_js_1.SAME_FRAME_WINDOW_US);
            if (due) {
                ticker.last = now;
                try {
                    keep = !!ticker.cb();
                }
                catch (e) {
                    keep = false;
                    (0, logging_js_1.reportFrameLoopError)('frameTicker', e);
                }
            }
            if (_tickers.get(id) !== ticker)
                return 1.default.SOURCE_REMOVE;
            if (keep)
                schedule();
            else
                _tickers.delete(id);
            return 1.default.SOURCE_REMOVE;
        });
    };
    schedule();
    return id;
}

function removeFrameTicker(id) {
    const ticker = _tickers.get(id);
    if (!ticker)
        return;
    _tickers.delete(id);
    if (!ticker.laterId)
        return;
    global.compositor.get_laters().remove(ticker.laterId);
    ticker.laterId = 0;
}
/**
 * Maps animation-interval-ms onto what a frame-driven animation can do:
 * anything up to one 60Hz frame means every frame (0); larger values cap the
 * frame rate, bounded to what the preferences offer.
 */

function normalizeAnimationIntervalMs(v) {
    if (!Number.isFinite(v) || v <= 16)
        return 0;
    return Math.min(Math.round(v), MAX_INTERVAL_MS);
}
