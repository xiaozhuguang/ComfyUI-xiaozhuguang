// Check the graph after replacing each selected group with one node.
export function planEncryptedGroups(graph, selectedNodes) {
    const selected = new Map(selectedNodes.map(node => [String(node.id), node]));
    const links = Object.values(graph.links || {}).filter(Boolean);
    const neighbors = new Map([...selected.keys()].map(id => [id, new Set()]));
    for (const link of links) {
        const from = String(link.origin_id), to = String(link.target_id);
        if (selected.has(from) && selected.has(to)) {
            neighbors.get(from).add(to);
            neighbors.get(to).add(from);
        }
    }
    const groups = [], visited = new Set();
    for (const id of selected.keys()) {
        if (visited.has(id)) continue;
        const group = [], stack = [id];
        visited.add(id);
        while (stack.length) {
            const current = stack.pop();
            group.push(selected.get(current));
            for (const next of neighbors.get(current)) {
                if (!visited.has(next)) { visited.add(next); stack.push(next); }
            }
        }
        groups.push(group);
    }

    function isAcyclic(candidateGroups) {
        const owner = new Map();
        candidateGroups.forEach((group, index) => {
            for (const node of group) owner.set(String(node.id), `group:${index}`);
        });
        const key = id => owner.get(String(id)) ?? `node:${id}`;
        const outgoing = new Map(), degree = new Map();
        for (const node of graph._nodes || []) {
            outgoing.set(key(node.id), new Set());
            degree.set(key(node.id), 0);
        }
        for (const link of links) {
            const from = key(link.origin_id), to = key(link.target_id);
            if (from === to && owner.has(String(link.origin_id))) continue;
            if (!outgoing.has(from)) { outgoing.set(from, new Set()); degree.set(from, 0); }
            if (!outgoing.has(to)) { outgoing.set(to, new Set()); degree.set(to, 0); }
            if (!outgoing.get(from).has(to)) {
                outgoing.get(from).add(to);
                degree.set(to, degree.get(to) + 1);
            }
        }
        const queue = [...degree.keys()].filter(id => degree.get(id) === 0);
        for (let i = 0; i < queue.length; i++) {
            for (const next of outgoing.get(queue[i])) {
                degree.set(next, degree.get(next) - 1);
                if (degree.get(next) === 0) queue.push(next);
            }
        }
        return queue.length === degree.size;
    }

    if (!isAcyclic([])) throw new Error('当前工作流已有依赖循环，请先修正连接后再加密。');
    if (isAcyclic([selectedNodes])) return [selectedNodes];
    if (isAcyclic(groups)) return groups;
    throw new Error('所选节点加密后会形成依赖循环，已取消且未修改工作流。请把所选节点之间遗漏的中间节点一并选中，或缩小选择范围。');
}
