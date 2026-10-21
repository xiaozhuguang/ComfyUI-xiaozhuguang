const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function createNode(vueNodesMode) {
    const source = fs.readFileSync(path.join(__dirname, '../web/xzg_video_loader.js'), 'utf8');
    const start = source.indexOf('    node.resizable = true;', source.indexOf('export function bindVideoLoaderInteractions'));
    const end = source.indexOf('    node.setSize([300, 500]);', start) + '    node.setSize([300, 500]);'.length;
    const node = {
        size: new Float32Array([300, 500]),
        computeSize() {
            assert.equal(vueNodesMode, true, 'Nodes 1 must retain its original size limits');
            return [300, 360];
        },
        setSize(size, flag) {
            assert.equal(typeof size[0], 'number');
            assert.equal(typeof size[1], 'number');
            this.size.set(size);
            this.lastFlag = flag;
        },
    };
    vm.runInNewContext(source.slice(start, end), { node, LiteGraph: { vueNodesMode } });
    return node;
}

for (const mode of [false, true]) {
    test(`Nodes ${mode ? 2 : 1} repeatedly resizes with LiteGraph typed arrays and numeric arguments`, () => {
        const node = createNode(mode);
        node.setSize(new Float32Array([800, 720]), true);
        assert.deepEqual([...node.size], [800, 720]);
        assert.equal(node.lastFlag, true);
        node.setSize(new Float32Array([420, 540]));
        assert.deepEqual([...node.size], [420, 540]);
        node.setSize(650, 680, true);
        assert.deepEqual([...node.size], [650, 680]);
        assert.equal(node.lastFlag, true);
        node.setSize([100, 100]);
        assert.deepEqual([...node.size], [300, mode ? 360 : 500]);
    });
}
