"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pinnedGrid = pinnedGrid;
/**
 * The columns of the pinned page for a row `width` wide. A tile is as wide as its icon plus the room the pin in
 * its corner needs at each side, and the tiles grow to use up what is left over.
 */

function pinnedGrid(width, iconSize, gap, sideRoom) {
    const least = iconSize + sideRoom * 2;
    const columns = Math.max(1, Math.floor((width + gap) / (least + gap)));
    return { columns, tile: Math.floor((width - gap * (columns - 1)) / columns) };
}
