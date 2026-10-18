export function resolveCaptureCameraParams(poseParams = {}, currentParams = {}) {
    const source = { ...currentParams, ...(poseParams || {}) };
    const number = (value, fallback) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    };
    return {
        zoom: number(source.zoom, 1),
        offset_x: number(source.offset_x, 0),
        offset_y: number(source.offset_y, 0),
        yaw_deg: number(source.yaw_deg, 0),
        pitch_deg: number(source.pitch_deg, 0),
        roll_deg: number(source.roll_deg, 0),
    };
}
