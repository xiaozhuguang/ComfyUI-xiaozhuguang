from dataclasses import dataclass

import torch
from comfy_execution.graph_utils import ExecutionBlocker, GraphBuilder, is_link
from nodes import NODE_CLASS_MAPPINGS as COMFY_NODE_CLASSES


class _AnyType(str):
    def __ne__(self, other):
        return False


ANY = _AnyType("*")
FLOW = "XZG_LOOP_FLOW"
START = "XiaozhuguangLoopStart"
END = "XiaozhuguangLoopEnd"
STEP = "XiaozhuguangLoopStep"
STEP_START = "XiaozhuguangLoopStepStart"
REPEAT = "循环"
EACH = "遍历数据"
FOLLOW_START = "跟随开始"
EXTRA_CHANNELS = range(2, 21)


@dataclass(frozen=True)
class _Iteration:
    mode: str
    total: int
    items: tuple
    index: int
    state: object
    products: tuple | None = None
    graph_root: str | None = None
    extra: tuple = (None,) * len(EXTRA_CHANNELS)


def _items(values):
    for value in values:
        if isinstance(value, torch.Tensor) and value.ndim in (3, 4):
            # 保留 IMAGE / MASK 的批次维度，供下一节点直接使用。
            for index in range(value.shape[0]):
                yield value[index:index + 1]
        elif isinstance(value, (list, tuple)):
            yield from value
        else:
            yield value


def _single(values, label, default=None):
    if values is None:
        return default
    if len(values) != 1:
        raise ValueError(f"「{label}」需要一个值。多个值可以先打包成一个状态。")
    return values[0]


class XiaozhuguangLoopStart:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": ([REPEAT, EACH], {"tooltip": "按指定次数循环，或按输入数据逐项循环。"}),
            },
            "optional": {
                "count": ("INT", {"default": 3, "min": 1, "max": 10000, "tooltip": "循环执行次数，至少执行 1 次。"}),
                "state": (ANY, {"tooltip": "循环模式下作为首次循环输入。遍历模式下接入列表或批次，每轮取一项。"}),
                **{f"state_{i}": (ANY,) for i in EXTRA_CHANNELS},
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    INPUT_IS_LIST = True
    RETURN_TYPES = (FLOW, "INT", ANY) + (ANY,) * len(EXTRA_CHANNELS)
    RETURN_NAMES = ("循环标记", "索引", "循环开始 1") + tuple(f"循环开始 {i}" for i in EXTRA_CHANNELS)
    OUTPUT_TOOLTIPS = (
        "接到同一组循环结束的「循环标记」。",
        "当前索引，从 0 开始，每轮加 1。",
        "循环模式下输出本轮状态，遍历模式下输出当前元素。",
    ) + tuple(f"第 {i} 路循环状态。" for i in EXTRA_CHANNELS)
    FUNCTION = "start"
    CATEGORY = "小珠光/流程"
    DESCRIPTION = "输入数据在循环模式下作为首次循环输入，在遍历模式下逐项提供给循环体。"

    def start(self, mode, count=None, unique_id=None, items=None, state=None, _iteration=None,
              **channels):
        if _iteration is None:
            mode = _single(mode, "循环模式")
            if mode == EACH and state is None:
                raise ValueError("遍历模式需要连接「遍历数据」输入。")
            elements = tuple(_items(state)) if mode == EACH else ()
            if mode == EACH:
                total = len(elements)
            else:
                total = _single(count, "次数", 3)
            initial = None if mode == EACH else _single(state, "本轮输入")
            extra = tuple(_single(channels.get(f"state_{i}"), f"输入数据 {i}") for i in EXTRA_CHANNELS)
            iteration = _Iteration(mode, total, elements, 0, initial, extra=extra)
        else:
            iteration = _iteration[0]
        element = iteration.items[iteration.index] if iteration.items else None
        state = element if iteration.mode == EACH else iteration.state
        return (unique_id[0], iteration), iteration.index, state, *iteration.extra

def _clone_round(dynprompt, start_id, end_id, iteration):
    # 从结束反查依赖，然后沿开始节点向下走，只复制两者之间的节点。
    children = {}
    pending = [end_id]
    visited = {start_id}
    while pending:
        node_id = pending.pop()
        if node_id in visited:
            continue
        visited.add(node_id)
        for value in dynprompt.get_node(node_id)["inputs"].values():
            if is_link(value):
                children.setdefault(value[0], []).append(node_id)
                pending.append(value[0])

    contained = {}
    pending = [start_id]
    while pending:
        node_id = pending.pop()
        if node_id not in contained:
            contained[node_id] = dynprompt.get_node(node_id)
            pending.extend(children.get(node_id, ()))

    # Find every branch downstream of the loop start, including output nodes
    # that are not part of the state-feedback path to the loop end.
    all_children = {}
    for node_id in dynprompt.all_node_ids():
        for value in dynprompt.get_node(node_id)["inputs"].values():
            if is_link(value):
                all_children.setdefault(value[0], []).append(node_id)

    reachable = set()
    pending = [start_id]
    while pending:
        node_id = pending.pop()
        if node_id == end_id or node_id in reachable:
            continue
        reachable.add(node_id)
        pending.extend(all_children.get(node_id, ()))

    output_nodes = {
        node_id for node_id in reachable - contained.keys()
        if getattr(COMFY_NODE_CLASSES.get(dynprompt.get_node(node_id)["class_type"]), "OUTPUT_NODE", False)
    }
    for output_id in output_nodes:
        pending = [output_id]
        output_ancestors = set()
        while pending:
            node_id = pending.pop()
            if node_id in output_ancestors:
                continue
            output_ancestors.add(node_id)
            for value in dynprompt.get_node(node_id)["inputs"].values():
                if is_link(value):
                    pending.append(value[0])

        for node_id in output_ancestors & reachable:
            contained[node_id] = dynprompt.get_node(node_id)

    graph = GraphBuilder(prefix=GraphBuilder.alloc_prefix(
        root=iteration.graph_root, call_index=iteration.index,
    ))
    clones = {}
    for node_id, node in contained.items():
        class_type = node["class_type"]
        if node_id == end_id:
            class_type = STEP
        elif node_id == start_id:
            class_type = STEP_START
        clone = graph.node(class_type)
        clone.set_override_display_id(dynprompt.get_display_node_id(node_id))
        clones[node_id] = clone

    for node_id, node in contained.items():
        clone = clones[node_id]
        if node_id == start_id:
            clone.set_input("mode", iteration.mode)
            clone.set_input("count", 0)
            clone.set_input("_iteration", iteration)
            continue
        for name, value in node["inputs"].items():
            if is_link(value) and value[0] in clones:
                value = clones[value[0]].out(value[1])
            clone.set_input(name, value)
    return {
        "expand": graph.finalize(),
        "result": tuple(
            clones[end_id].out(index) for index in range(1 + len(EXTRA_CHANNELS))
        ),
    }


class XiaozhuguangLoopEnd:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "flow": (FLOW, {"tooltip": "直接连接对应循环开始的「循环标记」。"}),
            },
            "optional": {
                "stop": ("BOOLEAN", {
                    "lazy": True, "forceInput": True,
                    "tooltip": "连接后为真时，在本轮结束后提前停止。未连接时按循环次数或遍历数据完成。",
                }),
                "data": (ANY, {"lazy": True, "tooltip": "循环模式下作为下一轮状态，遍历模式下作为本轮产物。"}),
                **{f"data_{i}": (ANY, {"lazy": True}) for i in EXTRA_CHANNELS},
            },
            "hidden": {"dynprompt": "DYNPROMPT", "unique_id": "UNIQUE_ID"},
        }

    INPUT_IS_LIST = True
    RETURN_TYPES = (ANY,) * (1 + len(EXTRA_CHANNELS))
    RETURN_NAMES = ("输出 1",) + tuple(f"输出 {i}" for i in EXTRA_CHANNELS)
    OUTPUT_TOOLTIPS = (
        "循环模式返回最终状态，遍历模式返回所有轮产物。",
    ) + tuple(f"第 {i} 路循环的最终状态。" for i in EXTRA_CHANNELS)
    OUTPUT_IS_LIST = (True,) + (False,) * len(EXTRA_CHANNELS)
    FUNCTION = "finish"
    CATEGORY = "小珠光/流程"
    DESCRIPTION = "循环模式传递下一轮状态，遍历模式自动收集每轮产物。可选接入停止条件提前结束。"

    def check_lazy_status(self, flow, dynprompt, unique_id, **kwargs):
        _, iteration = _single(flow, "循环标记")
        if iteration.total == 0:
            return []
        inputs = dynprompt[0].get_node(unique_id[0])["inputs"]
        names = ("data", "stop") + tuple(f"data_{i}" for i in EXTRA_CHANNELS)
        return [name for name in names if name in inputs and (
            kwargs.get(name) is None or (len(kwargs[name]) == 1 and kwargs[name][0] is None)
        )]

    def finish(self, flow, dynprompt, unique_id, data=None, stop=None, **channels):
        start_id, iteration = _single(flow, "循环标记")
        end_id = unique_id[0]
        dynprompt = dynprompt[0]
        if dynprompt.get_node(end_id)["inputs"]["flow"] != [start_id, 0]:
            raise ValueError("请把循环开始的「循环标记」直接接到对应的循环结束。")
        if iteration.total == 0:
            return ([] if iteration.mode == EACH else [iteration.state]), *iteration.extra

        state = _single(data, "当前数据", iteration.state)
        extra = tuple(
            _single(channels.get(f"data_{i}"), f"循环结束 {i}", previous)
            for i, previous in zip(EXTRA_CHANNELS, iteration.extra)
        )
        products = iteration.products
        if iteration.mode == EACH and data:
            products = (products, tuple(data))

        completed = iteration.index + 1
        stopped = stop is not None and _single(stop, "现在停止？")
        if completed >= iteration.total or stopped:
            chunks = []
            while products is not None:
                products, chunk = products
                chunks.append(chunk)
            result = [value for chunk in reversed(chunks) for value in chunk] if iteration.mode == EACH else [state]
            return result, *extra

        next_iteration = _Iteration(
            iteration.mode, iteration.total, iteration.items, completed, state,
            products, iteration.graph_root or end_id, extra,
        )
        return _clone_round(dynprompt, start_id, end_id, next_iteration)



class _LoopStep(XiaozhuguangLoopEnd):
    # 图扩展的链接会展开源节点的输出流。内部轮次必须把产物列表包成一个值，
    # 只有公开的结束节点把它交给 ComfyUI 作为列表输出。
    OUTPUT_IS_LIST = (False,) * (1 + len(EXTRA_CHANNELS))
    CATEGORY = "_internal"
    DEPRECATED = True


class _LoopStepStart(XiaozhuguangLoopStart):
    @classmethod
    def IS_CHANGED(cls, _iteration=None, **kwargs):
        # Dynamic rounds reuse the same loop-start class and nearly identical
        # inputs. Include the iteration number in ComfyUI's cache key so the
        # index output and the body that depends on it are recomputed each round.
        if _iteration is None:
            return 0
        iteration = _iteration[0] if isinstance(_iteration, (list, tuple)) else _iteration
        return iteration.index

    @classmethod
    def INPUT_TYPES(cls):
        schema = super().INPUT_TYPES()
        schema["optional"]["_iteration"] = ("XZG_LOOP_ITERATION", {"forceInput": True})
        return schema

    CATEGORY = "_internal"
    DEPRECATED = True


NODE_CLASS_MAPPINGS = {
    START: XiaozhuguangLoopStart,
    END: XiaozhuguangLoopEnd,
    STEP: _LoopStep,
    STEP_START: _LoopStepStart,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    START: "小珠光循环开始",
    END: "小珠光循环结束",
}
