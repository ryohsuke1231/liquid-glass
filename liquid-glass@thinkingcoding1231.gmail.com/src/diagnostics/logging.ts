
/**
 * Diagnostic sink for this module. utils.ts has no Gio.Settings of its own,
 * and logging must stay behind the extension's `output-logs` switch like
 * everything else — so extension.js hands the shared Logger in once, and
 * everything here stays a no-op until it does.
 */
type UtilsLogger = { log: (...args: any[]) => void };
export let _utilsLogger: UtilsLogger | null = null;
export function setUtilsLogger(logger: UtilsLogger | null): void {
  _utilsLogger = logger;
}
export function utilsLog(msg: string): void {
  try { _utilsLogger?.log(msg); } catch (_) { /* noop */ }
}

/**
 * Reports an exception that escaped one of the per-frame sync loops.
 *
 * Deliberately NOT routed through the Logger: every one of those loops is a
 * self-rescheduling Meta.LaterType.BEFORE_REDRAW chain, and an exception
 * that reaches the `later` callback used to skip the reschedule at the end
 * of the tick — which silently froze that glass instance's clones (they
 * keep painting their source's live content at whatever position they were
 * last given) until the menu/dock was hidden and shown again, because
 * `startFrameSync()` is only reachable from 'notify::mapped'. That is a
 * hard failure, not diagnostics, so it must be visible with `output-logs`
 * off too.
 *
 * Rate-limited per tag: the throw is usually a per-frame condition (a
 * disposed actor that stays disposed), and 60 identical backtraces a second
 * is what makes a journal useless.
 */
const _frameLoopErrorLastLogged: Map<string, number> = new Map();
const FRAME_LOOP_ERROR_LOG_INTERVAL_MS = 5000;
export function reportFrameLoopError(tag: string, e: unknown): void {
  try {
    const now = Date.now();
    const last = _frameLoopErrorLastLogged.get(tag) ?? 0;
    if (now - last < FRAME_LOOP_ERROR_LOG_INTERVAL_MS) return;
    _frameLoopErrorLastLogged.set(tag, now);
    console.error(`[Liquid Glass] exception in ${tag} frame sync (loop kept alive): ${e}`);
    const stack = (e as any)?.stack;
    if (stack) console.error(`[Liquid Glass] ${stack}`);
  } catch (_) { /* noop */ }
}
