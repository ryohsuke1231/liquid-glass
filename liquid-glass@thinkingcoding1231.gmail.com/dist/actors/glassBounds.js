import { setClipIfChanged } from './writes.js';
export const GLASS_CLIP_PADDING = 200;
export const GLASS_SHADOW_MAX_RADIUS = GLASS_CLIP_PADDING - 20;

export function placeScreenGlass(glass, x, y, screenW, screenH, clip) {
    // The glass covers the whole monitor; the clip limits drawing to the glass
    // rect plus room for its shadow.
    glass.remove_transition('size');
    glass.remove_transition('position');
    glass.set_position(x, y);
    glass.set_size(screenW, screenH);
    glass.remove_transition('size');
    glass.remove_transition('position');
    setClipIfChanged(glass, clip.x - GLASS_CLIP_PADDING, clip.y - GLASS_CLIP_PADDING, clip.w + GLASS_CLIP_PADDING * 2, clip.h + GLASS_CLIP_PADDING * 2);
}

// The content actor's stage position. It can be NaN on the first frame of an
// animation, so fall back to the last good position, then to the caller's
// prediction.
export function resolveGlassOrigin(actor, memory, fallback) {
    const [x, y] = actor.get_transformed_position();
    if (!Number.isNaN(x) && !Number.isNaN(y)) {
        memory._lastValidAnimAbsX = x;
        memory._lastValidAnimAbsY = y;
        return [x, y];
    }
    if (memory._lastValidAnimAbsX !== undefined && memory._lastValidAnimAbsY !== undefined)
        return [memory._lastValidAnimAbsX, memory._lastValidAnimAbsY];
    return fallback();
}

export function applyGlassScale(effect, cornerRadius, scaleX, scaleY) {
    if (!effect)
        return;
    // The smaller scale keeps the corners round while the menu scales unevenly.
    const currentScale = Math.min(scaleX, scaleY);
    effect.setCornerRadius(cornerRadius * currentScale);
    effect.setAnimationScale(currentScale);
}
