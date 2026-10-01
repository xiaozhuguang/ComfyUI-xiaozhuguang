// Run with: node --test --test-isolation=none tests/test_config_backup.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = readFileSync(new URL('../web/xzg_theme_panel.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function method(start, end, context) {
    return vm.runInNewContext(`({${source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))}})`, context);
}

for (const format of ['zip', 'json']) {
    test(`${format} picker passes configuration and releases uploaded ZIP`, async () => {
        let input;
        const requests = [];
        const config = { format: 'xiaozhuguang-config', mediaLibrary: { files: [] } };
        const context = {
            document: {
                body: { appendChild() {} },
                createElement() {
                    input = { style: {}, listeners: {}, files: [{ name: `backup.${format}`, text: async () => JSON.stringify(config) }],
                        addEventListener(name, action) { this.listeners[name] = action; }, remove() {}, click() {} };
                    return input;
                },
            },
            api: { fetchApi: async (...args) => { requests.push(args); return { ok: true }; } },
            xzgT: text => text,
            alert: message => { throw new Error(message); },
        };
        const panel = method('    openConfigImportPicker() {', '    /**\n     * 显示导出选项对话框', context);
        panel.uploadConfigArchive = async () => ({ config, token: 'temporary-token' });
        panel.importAllConfig = async (obj, token) => {
            assert.equal(obj.format, config.format);
            assert.equal(token, format === 'zip' ? 'temporary-token' : null);
            return { applied: false };
        };
        panel.openConfigImportPicker();
        assert.match(input.accept, /\.zip/);
        assert.match(input.accept, /\.json/);
        await input.listeners.change();
        assert.equal(requests.length, format === 'zip' ? 1 : 0);
        if (format === 'zip') {
            assert.equal(requests[0][1].method, 'DELETE');
            assert.equal(JSON.parse(requests[0][1].body).token, 'temporary-token');
        }
    });
}

test('restore reuses token without uploading file again', async () => {
    const requests = [];
    const context = { xzgT: text => text,
        api: { fetchApi: async (...args) => { requests.push(args); return { ok: true, json: async () => ({ restored: 2 }) }; } } };
    const panel = method('    async uploadConfigArchive(', '    /** 选择并应用统一配置文件。 */', context);
    panel.configTransfer = async (label, action) => action();
    const file = { name: 'backup.zip' };
    await panel.uploadConfigArchive(file);
    const restored = await panel.uploadConfigArchive('temporary-token', true);
    assert.equal(requests[0][1].body, file);
    assert.equal(requests[0][1].headers['Content-Type'], 'application/zip');
    assert.equal(requests[1][0], '/xzg/media-library/archive/restore');
    assert.equal(JSON.parse(requests[1][1].body).token, 'temporary-token');
    assert.equal(restored.restored, 2);
});

for (const selected of [
    { mediaLibrary: true, videoLibrary: false },
    { mediaLibrary: false, videoLibrary: true },
    { mediaLibrary: true, videoLibrary: true },
    { mediaLibrary: false, videoLibrary: false, audioLibrary: true },
]) {
    test(`restore selected libraries once: ${JSON.stringify(selected)}`, async () => {
        const saved = [];
        const requests = [];
        const context = {
            window: {}, localStorage: { setItem() {} },
            xzgExportCategoryForKey: () => null, xzgT: text => text,
            cloudSave: async (...args) => saved.push(args), cloudUIQueueGeometry() {},
        };
        const panel = method('    async importAllConfig(', '    renderPresets() {', context);
        panel.showImportDialog = async () => ({ categories: selected, includeComfySettings: false });
        panel.uploadConfigArchive = async (...args) => { requests.push(args); return { restored: 2, restoredVideos: 1, restoredAudios: 3 }; };
        const result = await panel.importAllConfig({ format: 'xiaozhuguang-config', localStorage: {},
            mediaLibrary: { files: [], geometry: { width: 900, height: 600 } },
            videoLibrary: { files: [], geometry: { width: 1000, height: 700 } },
            audioLibrary: { files: [], geometry: { width: 1000, height: 700 } },
        }, 'temporary-token');
        assert.equal(requests.length, 1);
        assert.deepEqual(JSON.parse(JSON.stringify(requests[0][2])), { audioLibrary: false, ...selected });
        assert.equal(result.restoredMediaCount, selected.mediaLibrary ? 2 : null);
        assert.equal(result.restoredVideoCount, selected.videoLibrary ? 1 : null);
        assert.equal(result.restoredAudioCount, selected.audioLibrary ? 3 : null);
        assert.equal(saved.some(([key]) => key === 'xzg_media_library_geometry'), selected.mediaLibrary);
        assert.equal(saved.some(([key]) => key === 'xzg_video_media_library_geometry'), selected.videoLibrary);
    });
}

const videoSource = readFileSync(new URL('../web/xzg_video_loader_davinci.js', import.meta.url), 'utf8');
test('video media buttons stay at top left; existing buttons stay on right', () => {
    const start = videoSource.indexOf('function _layoutPreviewActions(');
    const end = videoSource.indexOf('function _createVideoMediaLibraryButtons(', start);
    const layout = vm.runInNewContext(`${videoSource.slice(start, end)}; _layoutPreviewActions`);
    const button = width => ({ offsetWidth: width, style: { top: '6px' } });
    const node = { _xzgPreviewContainer: { clientWidth: 600 }, _xzgVideoMediaLibraryBtn: button(70), _xzgVideoMediaFavoriteBtn: button(44),
        _xzgLoaderExportDavinciBtn: button(50), _xzgDavinciBtn: button(60),
        _xzgLoaderQuickCutBtn: button(50), _xzgFastcutBtn: button(50) };
    layout(node);
    assert.equal(node._xzgVideoMediaLibraryBtn.style.left, '6px');
    assert.equal(node._xzgVideoMediaFavoriteBtn.style.left, '82px');
    assert.equal(node._xzgVideoMediaLibraryBtn.style.right, 'auto');
    assert.equal(node._xzgLoaderExportDavinciBtn.style.right, '6px');
    assert.equal(node._xzgFastcutBtn.style.right, '184px');
    node._xzgPreviewContainer.clientWidth = 360;
    layout(node);
    assert.equal(node._xzgVideoMediaFavoriteBtn.style.left, '6px');
    assert.equal(node._xzgVideoMediaFavoriteBtn.style.top, '34px');
    assert.equal(node._xzgVideoMediaLibraryBtn.style.top, '6px');
});

test('audio media buttons follow the waveform bottom left during canvas zoom', () => {
    const audioSource = readFileSync(new URL('../web/xzg_audio_loader.js', import.meta.url), 'utf8');
    const start = audioSource.indexOf('function _installAudioLoaderLayout(');
    const end = audioSource.indexOf('app.registerExtension(', start);
    const handlers = {};
    const canvas = { ds: { scale: 1, offset: [0, 0] }, canvas: {
        getBoundingClientRect: () => ({ left: 10, top: 20, right: 1000, bottom: 1000 }),
    } };
    const install = vm.runInNewContext(`${audioSource.slice(start, end)}; _installAudioLoaderLayout`, {
        app: { canvas }, document: { addEventListener: (key, fn) => handlers[key] = fn, removeEventListener() {} },
    });
    const button = width => ({ offsetWidth: width, style: {}, disabled: false,
        firstElementChild: { style: {} }, matches: () => false });
    const node = { pos: [50, 60], size: [360, 400],
        _xzgWaveformViewer: { _drawW: 360, _drawH: 120, _drawY: 40, drawOnNode() {} },
        _xzgAudioMediaLibraryBtn: button(70), _xzgAudioMediaFavoriteBtn: button(44) };
    install(node);
    handlers.pointermove({ clientX: 80, clientY: 90 });
    node._xzgAudioLayout();
    assert.equal(node._xzgAudioMediaLibraryBtn.style.left, '68px');
    assert.equal(node._xzgAudioMediaLibraryBtn.style.top, '218px');
    assert.equal(node._xzgAudioMediaLibraryBtn.style.opacity, '1');
    canvas.ds.scale = 2;
    node._xzgAudioLayout();
    assert.equal(node._xzgAudioMediaLibraryBtn.style.left, '126px');
    assert.equal(node._xzgAudioMediaLibraryBtn.style.top, '416px');
    assert.equal(node._xzgAudioMediaFavoriteBtn.style.left, '278px');
});
