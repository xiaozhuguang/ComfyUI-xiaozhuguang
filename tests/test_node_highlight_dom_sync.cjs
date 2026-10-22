const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Nodes 2.0（Vue）场景：Vue 在节点状态/进度变化时会整体重写节点的 class 与内联样式，
// 采样器等上报读条的节点每次进度更新都会触发重渲染，外部加的类会被刷掉。
// 这里用最小 DOM 桩复现该行为，确认高亮类会被补回、关闭高亮后彻底清理。
function harness(runningId = '1') {
    const observed = [];
    const styleElements = new Map();

    const makeElement = (nodeId) => {
        const classes = new Set();
        const styles = new Map();
        return {
            nodeId,
            isConnected: true,
            classList: {
                add: (c) => classes.add(c),
                remove: (c) => classes.delete(c),
                contains: (c) => classes.has(c),
            },
            style: {
                setProperty: (k, v) => styles.set(k, v),
                removeProperty: (k) => styles.delete(k),
                getPropertyValue: (k) => styles.get(k) || '',
            },
            getAttribute(name) {
                return name === 'data-node-id' ? this.nodeId : null;
            },
            _classes: classes,
        };
    };

    const nodes = { 1: makeElement('1'), 2: makeElement('2') };
    const elementList = [nodes[1], nodes[2]];

    const document = {
        head: {
            appendChild(el) { styleElements.set(el.id, el); },
        },
        createElement(tag) {
            assert.equal(tag, 'style');
            return {
                id: '',
                textContent: '',
                remove() { styleElements.delete(this.id); },
            };
        },
        getElementById(id) {
            return styleElements.get(id) || null;
        },
        querySelectorAll(selector) {
            assert.equal(selector, '[data-node-id]');
            return elementList.slice();
        },
        querySelector() { return null; },
    };

    class MutationObserver {
        constructor(callback) { this.callback = callback; }
        observe(element, options) {
            // options 来自 vm realm，不能做跨 realm 的 deepEqual，按字段校验
            assert.equal(options.attributes, true);
            assert.equal(options.attributeFilter.join(','), 'class,style');
            this.element = element;
            observed.push(element);
        }
        disconnect() { this.element = null; }
        fire() { if (this.element && this.element.isConnected) this.callback(); }
    }

    const graph = { id: 'root' };
    const context = vm.createContext({
        console,
        performance: { now: () => 0 },
        document,
        MutationObserver,
        LiteGraph: { vueNodesMode: true },
        app: { graph, canvas: { graph }, runningNodeId: runningId },
    });
    context.window = context;
    const source = fs.readFileSync(path.join(__dirname, '../web/xzg_theme.js'), 'utf8')
        .replace(/^import .*;\r?\n/gm, '');
    vm.runInContext(source.slice(0, source.indexOf('(function initThemeWhenReady()')), context);

    const manager = context.XZGThemeManager;
    manager.nodeHighlightActive = true;
    manager.nodeHighlightColor = '#ff8800';
    manager._runningJob = { ownerGraph: graph, nodeId: String(runningId) };
    manager._runningNodeId = String(runningId);
    return { manager, nodes, elementList, styleElements, observed };
}

test('Nodes 2 re-applies the executing class after the renderer rewrites class/style', () => {
    const h = harness();
    const target = h.nodes[1];

    h.manager.refreshRunningNodeHighlight();
    assert.ok(target._classes.has('xzg-node-executing-highlight'));
    assert.equal(target.style.getPropertyValue('--xzg-node-exec-color'), '#ff8800');

    // 模拟 Vue 进度更新重渲染：整段 class 与内联样式被覆盖
    target.classList.remove('xzg-node-executing-highlight');
    target.style.removeProperty('--xzg-node-exec-color');

    h.manager.refreshRunningNodeHighlight();
    assert.ok(target._classes.has('xzg-node-executing-highlight'), '轮询兜底必须补回被刷掉的类');
    assert.equal(target.style.getPropertyValue('--xzg-node-exec-color'), '#ff8800');
});

test('Nodes 2 MutationObserver restores the class immediately without waiting for polling', () => {
    const h = harness();
    const target = h.nodes[1];
    h.manager.refreshRunningNodeHighlight();
    assert.deepEqual(h.observed, [target]);

    const observer = h.manager._runningNodeDOMObserver;
    target.classList.remove('xzg-node-executing-highlight');
    observer.fire();
    assert.ok(target._classes.has('xzg-node-executing-highlight'));

    // 元素被整体替换（旧元素移出文档）时不再重复补类，交给轮询重建
    target.isConnected = false;
    target.classList.remove('xzg-node-executing-highlight');
    observer.fire();
    assert.equal(target._classes.has('xzg-node-executing-highlight'), false);
});

test('Nodes 2 cleanup removes the class, the observer and the injected stylesheet', () => {
    const h = harness();
    const target = h.nodes[1];
    h.manager.refreshRunningNodeHighlight();
    assert.ok(h.styleElements.has('xzg-node-executing-highlight-style'));

    h.manager.nodeHighlightActive = false;
    h.manager.refreshRunningNodeHighlight();

    assert.equal(target._classes.has('xzg-node-executing-highlight'), false);
    assert.equal(h.manager._runningNodeDOMObserver, null);
    assert.equal(h.styleElements.has('xzg-node-executing-highlight-style'), false);
});

test('other nodes are never highlighted in Nodes 2', () => {
    const h = harness('2');
    h.manager.refreshRunningNodeHighlight();
    assert.equal(h.nodes[1]._classes.has('xzg-node-executing-highlight'), false);
    assert.ok(h.nodes[2]._classes.has('xzg-node-executing-highlight'));
});
