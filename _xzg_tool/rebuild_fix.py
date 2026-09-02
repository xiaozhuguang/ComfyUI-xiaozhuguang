# -*- coding: utf-8 -*-
"""
rebuild_fix.py —— 子图构建器(纯机制, 无策略逻辑)

职责分离说明(重要):
    权限校验(设备绑定 / 不绑定模式 / endTime 时间失效)
    属于"策略"逻辑, 全部位于受保护的内部载荷 hidden_nodes 中。
    本文件只负责"机制"——把内部子图数据搭建成 GraphBuilder 图,
    因此单独分发本文件也不影响安全性:
        删除/篡改本文件只会让目标节点无法构建子图(执行报错),
        不存在可以"绕过"的校验代码。

构建策略(两阶段, 修复循环/反馈边问题):
    原实现的递归 DFS 建图在子图存在循环边(A 依赖 B, B 也依赖 A)时
    会无限递归 -> RecursionError。
    两阶段构建完全不依赖递归顺序:
      阶段一: 为每个节点创建 GraphBuilder 句柄(只填常量输入和
              hidden->kwargs 输入, 跳过所有节点间链接)。
      阶段二: 按任意顺序给每个节点接线, 通过句柄 .out() 建立链接。
    因为阶段二只引用已创建好的句柄, 循环边不会导致递归, 构建必然终止;
    循环结构以合法子图形式交给 ComfyUI 引擎处理。
"""

import json

try:
    from comfy_execution.graph_utils import GraphBuilder
except Exception:  # pragma: no cover - 载荷侧也会导入, 双保险
    GraphBuilder = None


def is_link(obj):
    """判断输入值是否为节点间链接 [node_id, slot]。"""
    if not isinstance(obj, list):
        return False
    if len(obj) != 2:
        return False
    if not isinstance(obj[0], str):
        return False
    if not isinstance(obj[1], int) and not isinstance(obj[1], float) and not isinstance(obj[1], str):
        return False
    return True


def build(nnoutput, kwargs):
    """
    两阶段构建子图。

    参数:
        nnoutput: 已通过权限校验、已剥离管理字段的子图数据
                  {node_id: {class_type, inputs, outputs, ...}}
                  (若含 endTime 包裹, 已由载荷解包为纯节点字典)
        kwargs:   节点 hidden 输入 (如 seed), 用于 hidden->常量注入

    返回:
        {"result": tuple(输出值), "expand": graph.finalize()}
    """
    graph = GraphBuilder()
    handles = {}

    # 阶段一: 为每个节点创建句柄。只填入常量输入和 hidden->kwargs 输入,
    #         节点间的链接先跳过(阶段二处理)。
    for node_id, node_data in nnoutput.items():
        inputs = node_data.get('inputs', {})
        new_inputs = {}
        for ikey in inputs.keys():
            if is_link(inputs[ikey]):
                # hidden -> kwargs 的常量注入, 立即填上
                if inputs[ikey][0] == 'hidden' and inputs[ikey][1] in kwargs:
                    new_inputs[ikey] = kwargs[inputs[ikey][1]]
                # 节点间链接(S[...]/str,int)留到阶段二
            else:
                new_inputs[ikey] = inputs[ikey]
        # node() 返回已创建(或已存在)的 Node 句柄
        node = graph.node(node_data['class_type'], node_id, **new_inputs)
        handles[node_id] = node

    # 阶段二: 按任意顺序接线, 只引用阶段一已创建好的句柄。
    for node_id, node_data in nnoutput.items():
        node = handles[node_id]
        inputs = node_data.get('inputs', {})
        for ikey in inputs.keys():
            if is_link(inputs[ikey]):
                src_id, src_idx = inputs[ikey][0], inputs[ikey][1]
                if src_id == 'hidden':
                    continue  # 已由阶段一处理
                if src_id in handles:
                    node.set_input(ikey, handles[src_id].out(src_idx))
                else:
                    # 引用不存在的节点: 保留原始链接, 交给引擎判断
                    node.set_input(ikey, inputs[ikey])

    # 组织输出值
    values = []
    for key in nnoutput.keys():
        if 'outputs' not in nnoutput[key]:
            nnoutput[key]['outputs'] = []
        if len(nnoutput[key]['outputs']) > 0:
            node = handles[key]
            for i in nnoutput[key]['outputs']:
                if isinstance(i, list) and len(i) >= 2:
                    if i[0] >= len(values):
                        values.extend([None] * (i[0] - len(values) + 1))
                    values[i[0]] = node.out(i[1])

    values = [v for v in values if v is not None]

    return {
        "result": tuple(values),
        "expand": graph.finalize(),
    }
