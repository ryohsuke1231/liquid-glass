// Whether the "top bar in the dock" mode holds the top bars hidden, for what else is laid out by the top bar.
let held = false;

export function setTopBarsHeld(value) {
    held = value;
}

export function topBarsHeld() {
    return held;
}
