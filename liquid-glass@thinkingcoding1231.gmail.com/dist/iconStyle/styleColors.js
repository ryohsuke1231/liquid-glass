// The colors icon-style.frag draws a style map in, per look, after macOS 26's
// tinted, white and clear icons. Pure, so that the contact sheet and the
// preferences can use it too.
// Per look: the rim's width (map px), its light on the sides away from the light, the sheen, and how far the plates'
// tones spread.
const GLASS = {
    dark: [7, 0.2, 0.1, 1], light: [9, 0, 0.42, 1], mono: [9, 0, 0.42, 1],
};
// The clear look's plates are glass drawn with the glass settings over what is behind the icon. Until that is known
// they are drawn as light added to it, with a rim lit on two sides as the glass's is.
const CLEAR_WITHOUT_BACKDROP = { rim: 0.8, rimWidth: 12, rimBase: 0, sheen: 0.5, edgeShade: 0.2 };
export const ICON_TUNING = [
    ...Object.entries(GLASS).flatMap(([look, [width, base, sheen, spread]]) => [
        { key: `${look}RimWidth`, title: 'Rim width', looks: [look], min: 1, max: 16, value: width },
        { key: `${look}RimBase`, title: 'Rim light away from the light', looks: [look], min: 0, max: 1, value: base },
        { key: `${look}Sheen`, title: 'Sheen (top lighter than bottom)', looks: [look], min: 0, max: 0.5, value: sheen },
        { key: `${look}ToneSpread`, title: 'Plates in different colors: how far apart', looks: [look], min: 0, max: 2,
            value: spread },
    ]),
    { key: 'darkGlass', title: 'Glass lightness', looks: ['dark'], min: 0, max: 0.6, value: 0.12 },
    { key: 'darkGlassAlpha', title: 'Glass opacity', looks: ['dark'], min: 0, max: 1, value: 1 },
    { key: 'darkTintReach', title: 'Color in the glass at full tint strength', looks: ['dark'], min: 0, max: 1, value: 0.38 },
    { key: 'darkInnerWhite', title: 'Plates: white mixed into the color', looks: ['dark'], min: 0, max: 1, value: 0.11 },
    { key: 'darkInnerAlpha', title: 'Plates: opacity', looks: ['dark'], min: 0, max: 1, value: 1 },
    { key: 'darkSymbolWhite', title: 'Symbol: white mixed into the color', looks: ['dark'], min: 0, max: 1, value: 0.15 },
    { key: 'darkLightTint', title: 'Colors lighter than this get a dark symbol on plates', looks: ['dark'], min: 0, max: 1,
        value: 0.15 },
    { key: 'darkSymbolOnLight', title: 'Dark symbol on plates: color mixed into the glass', looks: ['dark'], min: 0, max: 1,
        value: 0 },
    { key: 'darkSymbolOnDark', title: 'Light symbol on plates: white mixed into the color', looks: ['dark'], min: 0, max: 1,
        value: 0.75 },
    { key: 'darkRim', title: 'Rim brightness', looks: ['dark'], min: 0, max: 1, value: 0.55 },
    { key: 'lightGlassBlack', title: 'Glass: black mixed into the color', looks: ['light'], min: 0, max: 1, value: 0.21 },
    { key: 'lightGlassAlpha', title: 'Glass opacity', looks: ['light'], min: 0, max: 1, value: 1 },
    { key: 'lightInnerAlpha', title: 'Plates: white over the glass', looks: ['light'], min: 0, max: 1, value: 0.26 },
    { key: 'lightSymbolTint', title: 'Symbol: color mixed into white', looks: ['light'], min: 0, max: 1, value: 0.21 },
    { key: 'lightRim', title: 'Rim brightness', looks: ['light'], min: 0, max: 1, value: 0.6 },
    { key: 'monoGlass', title: 'Glass lightness', looks: ['mono'], min: 0, max: 0.6, value: 0.12 },
    { key: 'monoInner', title: 'Plates: lightness', looks: ['mono'], min: 0, max: 1, value: 0.64 },
    { key: 'monoInnerAlpha', title: 'Plates: opacity', looks: ['mono'], min: 0, max: 1, value: 0.92 },
    { key: 'monoSymbol', title: 'Symbol: lightness', looks: ['mono'], min: 0, max: 1, value: 1 },
    { key: 'monoRim', title: 'Rim brightness', looks: ['mono'], min: 0, max: 1, value: 0.55 },
    { key: 'clearGlassAlpha', title: 'Glass: white frost', looks: ['clear'], min: 0, max: 1, value: 0.02 },
    { key: 'clearInnerAlpha', title: 'Plates: white frost', looks: ['clear'], min: 0, max: 1, value: 0.02 },
    { key: 'clearRimScale', title: 'Rim: width against the glass\'s', looks: ['clear'], min: 1, max: 4, value: 1.6 },
    { key: 'clearToneSpread', title: 'Plates in different colors: how far apart', looks: ['clear'], min: 0, max: 2,
        value: 1 },
    { key: 'clearSymbolShadow', title: 'Symbol: shadow under it', looks: ['clear'], min: 0, max: 1, value: 0.4 },
];
const WHITE = [1, 1, 1];

function mix(a, b, t) {
    return [0, 1, 2].map(i => a[i] + (b[i] - a[i]) * t);
}

// A grey a little cooler than neutral.
function glass(lightness) {
    return [lightness - 0.01, lightness, lightness + 0.02].map(v => Math.min(Math.max(v, 0), 1));
}

/**
 * @param tint The accent or chosen color, 0 to 1 a channel.
 * @param strength How much of the tint the outer plate of a dark tinted icon takes, 0 (the dark glass alone) to 1.
 * @param symbolOpacity How strongly the symbol shows, 0 to 1.
 * @param tuning Values that replace ICON_TUNING's, by key.
 */
export function iconStyleColors(mode, tint, strength, symbolOpacity, variant = 'light', tuning = {}) {
    const v = (key) => tuning[key] ?? ICON_TUNING.find(p => p.key === key).value;
    if (mode === 'clear') {
        // Barely frosted, so that the white symbol stands apart from the plates. The frost is light added, which keeps
        // the colors of what is behind.
        return { ...CLEAR_WITHOUT_BACKDROP, toneSpread: v('clearToneSpread'), additive: 1, symbolShadow: v('clearSymbolShadow'),
            rimScale: v('clearRimScale'),
            plate: [1, 1, 1, v('clearGlassAlpha')], inner: [1, 1, 1, v('clearInnerAlpha')],
            symbol: [1, 1, 1, symbolOpacity], symbolInner: [1, 1, 1, symbolOpacity], tint: [0.75, 0.75, 0.78] };
    }
    const look = mode === 'tinted' ? variant : mode;
    const shared = { rimWidth: v(`${look}RimWidth`), rimBase: v(`${look}RimBase`), sheen: v(`${look}Sheen`),
        toneSpread: v(`${look}ToneSpread`), additive: 0, edgeShade: 0, symbolShadow: 0, rimScale: 1 };
    if (mode === 'mono') {
        return { ...shared, plate: [...glass(v('monoGlass')), 1], inner: [...glass(v('monoInner')), v('monoInnerAlpha')],
            symbol: [...glass(v('monoSymbol')), symbolOpacity], symbolInner: [...glass(v('monoGlass')), symbolOpacity],
            rim: v('monoRim'), tint: [0.62, 0.62, 0.64] };
    }
    const t = tint.slice(0, 3);
    if (variant === 'light') {
        const symbol = [...mix(WHITE, t, v('lightSymbolTint')), symbolOpacity];
        return { ...shared, plate: [...mix(t, [0, 0, 0], v('lightGlassBlack')), v('lightGlassAlpha')],
            inner: [1, 1, 1, v('lightInnerAlpha')], symbol, symbolInner: symbol, rim: v('lightRim'), tint: [t[0], t[1], t[2]] };
    }
    const dark = glass(v('darkGlass'));
    // On a plate in a light color the symbol is dark, as the cut-outs in it would be; on a dark one, light.
    const light = 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2] > v('darkLightTint');
    return { ...shared, plate: [...mix(dark, t.map(c => c * v('darkTintReach')), strength), v('darkGlassAlpha')],
        inner: [...mix(t, WHITE, v('darkInnerWhite')), v('darkInnerAlpha')],
        symbol: [...mix(t, WHITE, v('darkSymbolWhite')), symbolOpacity],
        symbolInner: [...(light ? mix(dark, t, v('darkSymbolOnLight')) : mix(t, WHITE, v('darkSymbolOnDark'))), symbolOpacity],
        rim: v('darkRim'), tint: [t[0], t[1], t[2]] };
}

/** The shader's uniforms for `colors`, by name. */
export function iconStyleUniforms(colors) {
    const out = [['rim_a', colors.rim], ['rim_width', colors.rimWidth], ['rim_base', colors.rimBase],
        ['sheen', colors.sheen], ['tone_spread', colors.toneSpread], ['additive', colors.additive],
        ['edge_shade', colors.edgeShade], ['symbol_shadow', colors.symbolShadow], ['rim_scale', colors.rimScale]];
    for (const name of ['plate', 'inner', 'symbol', 'symbolInner']) {
        const uniform = name === 'symbolInner' ? 'symbol_inner' : name;
        colors[name].forEach((c, i) => out.push([`${uniform}_${'rgba'[i]}`, c]));
    }
    colors.tint.forEach((c, i) => out.push([`tint_${'rgb'[i]}`, c]));
    return out;
}
