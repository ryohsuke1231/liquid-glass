
/**
 * Safe helper to retrieve window actors, compatible with GNOME Shell
 * pre-48 (global.get_window_actors) and 48+/GNOME 50 (Mutter moved it to
 * global.compositor.get_window_actors). Every call site in this extension
 * that needs the current list of window actors should go through this
 * instead of calling either API directly.
 */
export function getWindowActors(): any[] {
  if (global.compositor && typeof (global.compositor as any).get_window_actors === 'function') {
    return (global.compositor as any).get_window_actors();
  }
  if (typeof (global as any).get_window_actors === 'function') {
    return (global as any).get_window_actors();
  }
  return [];
}
