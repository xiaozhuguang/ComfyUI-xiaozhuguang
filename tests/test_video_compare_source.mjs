import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
const source = fs.readFileSync(new URL('../web/xzg_video_sync_preview.js', import.meta.url), 'utf8').replace(/^import\s[\s\S]*?;\r?\n/gm, '');
const ctx = vm.createContext({ app: { registerExtension() {} }, window: {}, URLSearchParams, URL, location: { origin: 'http://localhost' } });
vm.runInContext(source, ctx);
function resolve(node) { ctx.node = node; return vm.runInContext('getVideoFromNode(node)', ctx); }
test('saved video comparison uses latest output while player still contains old source', () => {
  for (const type of ['XiaozhuguangVideoCombine', 'XiaozhuguangVideoSaveDaVinci']) {
    const item = resolve({ type, _xzgVideoPlayer: { getSrc: () => '/view?filename=old.mp4', _skipFrames: 90, _frameLimit: 10, _videoInfo: { filename: 'new.mp4', subfolder: 'node/644', preview_id: 'new-version' } } });
    const url = new URL(item.url, 'http://localhost');
    assert.equal(url.searchParams.get('filename'), 'new.mp4');
    assert.equal(url.searchParams.get('subfolder'), 'node/644');
    assert.equal(url.searchParams.get('v'), 'new-version');
    assert.equal(item.skipFrames, undefined);
  }
});
test('absolute saved output preserves access token and version', () => {
  const item = resolve({ type: 'XiaozhuguangVideoSaveDaVinci', _xzgVideoPlayer: { _videoInfo: { filename: 'custom.mp4', abs_token: 'token', preview_id: 'version' } } });
  assert.equal(item.url, '/xzg/davinci/view-abs?token=token&v=version');
});
test('loader comparison retains current preview and range behavior', () => {
  const player = { getSrc: () => '/view?filename=loader.mp4', _skipFrames: 20, _frameLimit: 30 };
  const item = resolve({ type: 'XiaozhuguangVideoLoader', _xzgVideoPlayer: player });
  assert.equal(item.skipFrames, 20);
  player._previewLoaded = true;
  assert.equal(resolve({ type: 'XiaozhuguangVideoLoader', _xzgVideoPlayer: player }).skipFrames, undefined);
});
