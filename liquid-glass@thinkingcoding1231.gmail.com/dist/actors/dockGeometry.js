export function clipDockBounds(bounds, target) {
    let { absX, absY, baseW, baseH } = bounds;
    const { absX: tX, absY: tY, baseW: tW, baseH: tH } = target;
    // Cut off whatever sticks out of the target.
    if (absX < tX) {
        baseW -= (tX - absX);
        absX = tX;
    }
    if (absY < tY) {
        baseH -= (tY - absY);
        absY = tY;
    }
    if (absX + baseW > tX + tW)
        baseW = (tX + tW) - absX;
    if (absY + baseH > tY + tH)
        baseH = (tY + tH) - absY;
    return { absX, absY, baseW, baseH };
}

export function dockEdges(bounds, monitor) {
    let minCenterDist = -1;
    let distLeftCenter = 0, distRightCenter = 0, distTopCenter = 0, distBottomCenter = 0;
    if (monitor) {
        const dockCenterX = bounds.absX + bounds.baseW / 2;
        const dockCenterY = bounds.absY + bounds.baseH / 2;
        distLeftCenter = dockCenterX - monitor.x;
        distRightCenter = monitor.x + monitor.width - dockCenterX;
        distTopCenter = dockCenterY - monitor.y;
        distBottomCenter = monitor.y + monitor.height - dockCenterY;
        minCenterDist = Math.min(distLeftCenter, distRightCenter, distTopCenter, distBottomCenter);
    }
    return { minCenterDist, distLeftCenter, distRightCenter, distTopCenter, distBottomCenter };
}

// The gaps before and after the reference rect. On a flipped axis (a dock
// placed at the top, or a mirrored left/right dock) the reference's origin is
// at its far edge, so its real start is refStart - refSize.
function referenceGaps(start, size, refStart, refSize) {
    let before = refStart - start;
    let after = start + size - (refStart + refSize);
    if (before < 0 || after < 0) {
        const trueStart = refStart - refSize;
        before = trueStart - start;
        after = start + size - (trueStart + refSize);
    }
    return [before, after];
}

export function balanceDockBounds(bounds, reference, edges) {
    let { absX, absY, baseW, baseH } = bounds;
    const { absX: refX, absY: refY, baseW: refW, baseH: refH } = reference;
    if (Number.isNaN(refX) || Number.isNaN(refY) || !(refW > 0) || !(refH > 0))
        return bounds;
    const [topGap, bottomGap] = referenceGaps(absY, baseH, refY, refH);
    const [leftGap, rightGap] = referenceGaps(absX, baseW, refX, refW);
    if (baseW >= baseH) {
        // Horizontal dock (top or bottom). A difference larger than half the
        // height is bogus and ignored. Trim the larger gap: the bottom by
        // shrinking, the top by also moving the start down.
        const diff = Math.abs(bottomGap - topGap);
        if (diff > 0 && diff < baseH / 2) {
            if (!(bottomGap > topGap))
                absY += diff;
            baseH -= diff;
        }
    }
    else {
        // Vertical dock. Only the gap facing the screen center is trimmed: for a
        // left dock that is the right gap, and the start is never moved right.
        const diff = Math.abs(rightGap - leftGap);
        if (diff > 0 && diff < baseW / 2 &&
            (edges.minCenterDist !== edges.distLeftCenter || rightGap > leftGap)) {
            if (!(rightGap > leftGap))
                absX += diff;
            baseW -= diff;
        }
    }
    return { absX, absY, baseW, baseH };
}

// Trims the dock to `margin` from the screen edge it is closest to.
export function insetDockBounds(bounds, monitor, edges, margin, stableBaseW, stableBaseH) {
    let { absX, absY, baseW, baseH } = bounds;
    const { minCenterDist, distBottomCenter, distTopCenter, distRightCenter } = edges;
    if (minCenterDist === distBottomCenter) {
        [absY, baseH] = insetSpan(absY, baseH, monitor.y + monitor.height - margin, stableBaseH, false);
    }
    else if (minCenterDist === distTopCenter) {
        [absY, baseH] = insetSpan(absY, baseH, monitor.y + margin, stableBaseH, true);
    }
    else if (minCenterDist === distRightCenter) {
        [absX, baseW] = insetSpan(absX, baseW, monitor.x + monitor.width - margin, stableBaseW, false);
    }
    else {
        [absX, baseW] = insetSpan(absX, baseW, monitor.x + margin, stableBaseW, true);
    }
    return { absX, absY, baseW, baseH };
}

function insetSpan(start, size, edge, stableSize, leading) {
    if (leading) {
        if (start < edge) {
            size -= edge - start;
            start = edge;
        }
    }
    else if (start + size > edge) {
        size -= (start + size) - edge;
    }
    // Never grow past the last stable size.
    if (size > stableSize)
        size = stableSize;
    return [start, size];
}

export function visibleDockSize(bounds, monitor) {
    const { absX, absY, baseW, baseH } = bounds;
    let visibleW = baseW, visibleH = baseH;
    if (monitor) {
        if (absX < monitor.x)
            visibleW -= monitor.x - absX;
        if (absY < monitor.y)
            visibleH -= monitor.y - absY;
        if (absX + baseW > monitor.x + monitor.width)
            visibleW -= (absX + baseW) - (monitor.x + monitor.width);
        if (absY + baseH > monitor.y + monitor.height)
            visibleH -= (absY + baseH) - (monitor.y + monitor.height);
    }
    return [visibleW, visibleH];
}
