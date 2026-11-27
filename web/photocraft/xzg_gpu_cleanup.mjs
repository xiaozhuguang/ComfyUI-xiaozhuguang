// This runs inside the editor iframe, before wgpu requests a rendering context.
export function installGpuCleanup(canvas) {
    let disposed = false;
    let gl = null;
    const devices = new Set();
    const adapterPrototype = globalThis.GPUAdapter?.prototype;
    if (adapterPrototype) {
        const requestDevice = adapterPrototype.requestDevice;
        adapterPrototype.requestDevice = async function (...args) {
            const device = await requestDevice.apply(this, args);
            if (disposed) {
                device.destroy();
            } else {
                devices.add(device);
                device.lost.then(() => devices.delete(device));
            }
            return device;
        };
    }
    const getContext = canvas.getContext;
    canvas.getContext = function (kind, ...args) {
        const context = getContext.call(this, kind, ...args);
        if (kind === "webgl2" && context) gl = context;
        return context;
    };
    const lifetime = new AbortController();
    const dispose = () => {
        lifetime.abort();
        disposed = true;
        for (const device of devices) device.destroy();
        devices.clear();
        gl?.getExtension("WEBGL_lose_context")?.loseContext();
        gl = null;
    };
    // Both names can arrive while a browser reloads the embedding page and its iframe.
    for (const event of ["xzg-image-editor-dispose", "xzg-photocraft-dispose"]) {
        window.addEventListener(event, dispose, { signal: lifetime.signal });
    }
}
