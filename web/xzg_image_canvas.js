// Align the image and its transparency background to the same canvas pixels.
export function snapImageRect(ctx, x, y, width, height) {
    const { a, b, c, d, e, f } = ctx.getTransform();
    if (b || c || !a || !d) return [x, y, width, height];

    const left = Math.round(x * a + e);
    const top = Math.round(y * d + f);
    const right = Math.round((x + width) * a + e);
    const bottom = Math.round((y + height) * d + f);
    return [(left - e) / a, (top - f) / d, (right - left) / a, (bottom - top) / d];
}
