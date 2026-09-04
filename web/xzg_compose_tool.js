// -*- coding: utf-8 -*-
/**
 * utility.js —— 「组合处理」增强（不破解核心）
 *
 * 背景:
 *   工具把【选中节点】一次性打包进一个结果子图。
 *   若选中节点中间隔着【未选中的连接节点】(例如只选输入和输出、
 *   漏掉中间的中间件),打包后两者会在外部被"打回",形成环路,
 *   导致运行期悬空引用/无限递归报错。
 *
 * 方案(本次重写,不再用 DOM 事件拦截):
 *   拦截点改在菜单项的【回调】上 —— 所有菜单(Vue 菜单 / 原生
 *   LiteGraph ContextMenu)最终都调用 LGraphCanvas.prototype
 *   .getNodeMenuOptions 生成菜单项,并执行该项的 callback。
 *   因此本脚本在 getNodeMenuOptions 返回的数组里,找到
 *   对应这一项,把它的 callback 包一层:
 *     - 不存在连接节点 -> 原样调用原生回调(行为完全不变)。
 *     - 存在连接节点  -> 改为按"仅通过选中节点直接相连的连通分量"
 *       自动拆成多个被处理对象,逐个调用插件的组装接口处理。
 *   这样无论右键菜单是 Vue 组件还是 litegraph 原生的 div 菜单,
 *   点击都会命中我们包装后的回调,不再依赖菜单 DOM 结构。
 *
 * 依赖:
 *   核心已把组装接口 / 设置对话框 / 管理密码导出到 window.__xzgTools。
 *
 * 时序处理:
 *   核心在 setup() 阶段才 patch getNodeMenuOptions,且本脚本加载在
 *   main.js 之前,因此用轮询 + 仅当"当前实现不是我的包装"时重新包装,
 *   保证无论谁在何时改写 getNodeMenuOptions,我的包装都处于最外层。
 */

import { app } from "../../../scripts/app.js";

// 匹配组合菜单的识别词（unicode 转义，不落明文）
const MENU_KEYWORDS = ["\u52a0\u5bc6\u8282\u70b9\u7ec4"];

let busy = false;        // 避免重复处理(连点)
let currentMask = null;  // 保证同时只有一个遮罩

// ---------- 目标节点宽度修复(复用"小珠光"通用铁律) ----------
// 现象:属性面板打开时,ComfyUI 会把面板侧行宽度(约368px)写入控件
//      hiddenJson 的 .width(实测成为自有的数据属性 value=378),节点 reflow
//      后该元素溢出节点边界,底部出现与面板同宽的灰色长条。
// 修复:把 hiddenJson(及目标节点上所有自定义控件)的 .width 重定义为只读
//      访问器,恒返回 node.size[0],忽略属性面板的写宽,防止元素超宽。
function protectNodeWidths(node) {
  if (!node || !node.widgets) return;
  const type = String(node.type || "");
  const title = String(node.title || "");
  const isKind =
    type.indexOf("\u004c\u0047\u005f\u004c") === 0 ||   // 目标节点类型前缀
    title.indexOf("\u52a0\u5bc6") >= 0;                  // 中文兜底
  if (!isKind) return;

  for (const w of node.widgets) {
    if (!w) continue;
    try {
      const d = Object.getOwnPropertyDescriptor(w, "width");
      // 只重定义"自有可配置"的 width,避免破坏标准控件(prototype 上的 width 不动)
      if (d && d.configurable) {
        Object.defineProperty(w, "width", {
          configurable: true,
          get() {
            return (node.size && node.size[0]) || 0;
          },
          set() {
            /* 忽略属性面板写入的宽度 */
          },
        });
      }
    } catch (err) {
      console.warn("[util] width 防护失败", err);
    }
  }
}

// 周期性兜底:无论目标节点何时/Object 创建,都保持宽度访问器只读 + 标题伪装
function ensureWidthProtected() {
  try {
    const graph = app.canvas && app.canvas.graph;
    const nodes = (graph && graph._nodes) || [];
    for (const n of nodes) {
      protectNodeWidths(n);
      neutralizeNodeTitle(n);
    }
  } catch (err) {
    // 静默,下一轮再试
  }
}

// ---------- 目标节点上的采样预览缩略图 widget 处理(不挂载、不撑高) ----------
// 前端(settingStore)在采样时会反复给 IMAGE 输出节点动态创建名为
// "$$canvas-image-preview" 的 custom widget(ImagePreviewWidget,computeLayoutSize 固定
// 返回 minHeight:220)来显示实时采样缩略图。该 widget 每生成一帧预览就会被重建,
// 若只是"跳过绘制"或"改实例布局",节点仍会因它占位而被反复撑高。
//
// 根治做法:在 addCustomWidget 这一最底层入口拦截(见 dropPreviewWidget),
// 让预览 widget 根本不进入目标节点的 widgets 数组 —— 同步生效、不受重建影响,
// 既不占布局高度(不撑高)也不被绘制。同时兜底清空预览数据池并移除已挂入的旧实例。
function suppressPreviewLayout() {
  try {
    const graph = app.canvas && app.canvas.graph;
    const nodes = (graph && graph._nodes) || [];
    for (const n of nodes) {
      if (!isTargetNode(n) || !n.widgets) continue;
      // 从源头拦截:凡是采样预览 widget 用 addCustomWidget 挂到目标节点,直接丢弃,
      // 不进入 node.widgets —— 同步生效,既不占布局高度(不撑高)也不会被绘制,
      // 而且不受前端"每帧预览重建 widget"的影响。
      dropPreviewWidget(n);
      // 兜底:清掉预览数据池(showCanvasImagePreview 以 t.imgs?.length 判断)
      if (Array.isArray(n.imgs) && n.imgs.length) n.imgs = [];
      if (Array.isArray(n.preview) && n.preview.length) n.preview = [];
      if (Array.isArray(n.previewImages) && n.previewImages.length) n.previewImages = [];
      // 兜底:若某个 preview widget 在拦截安装前已进入 widgets,直接移除它
      for (let i = n.widgets.length - 1; i >= 0; i--) {
        const w = n.widgets[i];
        const wn = w && String(w.name || "").toLowerCase();
        if (wn && wn.indexOf("$$canvas-image-preview") === 0) {
          try { w.onRemove && w.onRemove(); } catch (err) { /* 忽略 */ }
          n.widgets.splice(i, 1);
        }
      }
    }
  } catch (err) {
    // 静默,下一轮再试
  }
}

// 给目标节点安装 addCustomWidget 拦截:拒绝挂载采样预览 widget。
// 注意只拦截挂载(不拦截 addDOMWidget),因此 hiddenJson 查看器等正常 widget 不受影响。
function dropPreviewWidget(n) {
  if (!n || n.__xzgAddCustomWrapped) return;
  const orig = n.addCustomWidget;
  if (typeof orig !== "function") return;
  n.__xzgAddCustomWrapped = true;
  n.addCustomWidget = function (w) {
    const wname = w && (typeof w.name === "string" ? w.name : "");
    if (wname && wname.indexOf("$$canvas-image-preview") === 0) {
      // 目标节点不挂采样预览 widget,避免撑高与显影
      return w;
    }
    return orig.apply(this, arguments);
  };
}

// ---------- 目标节点"隐形占位"修复 ----------
// 现象:早期预览 widget($$canvas-image-preview, computeLayoutSize 固定 minHeight:220)
//      或 hiddenJson 被按多行计算高度后,节点高度被撑大并随工作流保存。
//      预览取消后这些 widget 已不挂载/不绘制,但保存的 node.size[1] 没人缩回去,
//      节点矩形仍覆盖下方那截空白 —— 鼠标落上去命中节点本体,拖不动画布。
// 修复:把隐形 widget(hiddenJson / 预览类)临时移出 widgets 后计算内容真实高度,
//      若节点当前高度更大则收缩到内容高度(只缩不放,高度无变化时零开销)。
function shrinkNodeToContent(node) {
  if (!node || !node.widgets || !isTargetNode(node)) return;
  if (!node.size || typeof node.computeSize !== "function") return;
  // 已初始化(收缩过一次)的节点:完全尊重用户手动调整的大小,
  // 不再每 200ms 强制收缩(否则用户拖大后会被立刻拉回最小)。
  if (node.__xzgSizeInit) return;
  // 用户正在拖动该节点的 resize 手柄时暂停收缩。
  // 否则每 200ms 的收缩会与手动调整右下角大小互相打架,表现为"拖动时跳动"。
  try {
    const canvas = app.canvas;
    if (canvas && canvas.resizing_node === node) return;
  } catch (err) { /* 静默 */ }
  // 仅在高度变化后才重新评估,平时轮询零布局开销
  const key = `${node.size[0]}x${node.size[1]}`;
  if (node.__xzgSizeKey === key) return;
  node.__xzgSizeKey = key;

  const ws = node.widgets;
  const saved = [];
  for (let i = ws.length - 1; i >= 0; i--) {
    const w = ws[i];
    if (!w) continue;
    const t = String(w.type || "");
    const nm = String(w.name || "").toLowerCase();
    const isPreview =
      nm.indexOf("$$canvas-image-preview") === 0 ||
      nm.indexOf("image-preview") >= 0 ||
      nm.indexOf("imgpreview") >= 0;
    if (t === "hidden" || nm.indexOf("hiddenjson") >= 0 || isPreview) {
      saved.push({ i, item: w });
      ws.splice(i, 1);
    }
  }
  try {
    const sz = node.computeSize();
    if (sz && node.size[1] > sz[1] + 1) {
      node.setSize([node.size[0], sz[1]]);
      const graph = node.graph || app.canvas.graph;
      if (graph && typeof graph.setDirtyCanvas === "function") graph.setDirtyCanvas(true, true);
    }
  } catch (err) {
    // 静默
  } finally {
    for (let j = saved.length - 1; j >= 0; j--) ws.splice(saved[j].i, 0, saved[j].item);
  }
  // 收缩完成 → 标记已初始化,之后轮询尊重用户尺寸
  node.__xzgSizeInit = true;
}

function shrinkTargetNodes() {
  try {
    const graph = app.canvas && app.canvas.graph;
    const nodes = (graph && graph._nodes) || [];
    for (const n of nodes) shrinkNodeToContent(n);
  } catch (err) {
    // 静默,下一轮再试
  }
}

// ---------- 加密节点默认外观修复 ----------
// 混淆核心在 LG_Lock_Local.onNodeCreated 里把节点 bgcolor 硬编码为深红 "#6f0c0c"
// (运行时拼接,故源码里搜不到该色值)。需求:加密节点默认应为"无色"——即保持
// ComfyUI 默认节点外观(renderingBgColor 回退到 NODE_DEFAULT_BGCOLOR)。
// 这里在轮询里兜底:只要 bgcolor 仍是该插件默认红就清空恢复默认;
// 用户手动设置的其它颜色(如 node_colors 预设)不受影响。
const _PLUGIN_DEFAULT_BGCOLOR = "#6f0c0c";
function restoreNodeDefaultColor(node) {
  if (!node || !isTargetNode(node)) return;
  try {
    if (node.bgcolor === _PLUGIN_DEFAULT_BGCOLOR) {
      node.bgcolor = undefined;
      const graph = node.graph || app.canvas.graph;
      if (graph && typeof graph.setDirtyCanvas === "function") graph.setDirtyCanvas(true, true);
    }
  } catch (err) {
    // 静默
  }
}

function restoreTargetNodeColors() {
  try {
    const graph = app.canvas && app.canvas.graph;
    const nodes = (graph && graph._nodes) || [];
    for (const n of nodes) restoreNodeDefaultColor(n);
  } catch (err) {
    // 静默,下一轮再试
  }
}

// ---------- 加密节点"默认无色"源头修复(onNodeCreated 层面) ----------
// 场景:切换/加载工作流时,节点被创建 → 混淆核心的 onNodeCreated 立即把 bgcolor
// 染成插件默认红 #6f0c0c,而 200ms 轮询要等下一拍才清掉,导致"先红后无色"闪一下。
// 这里直接包装 LG_Lock_Local.prototype.onNodeCreated:原始逻辑执行完(染红之后)
// 立即同步清掉默认红,加载即无色,不经过轮询。轮询的 restoreTargetNodeColors
// 保留作兜底(覆盖绕过 onNodeCreated 的极端路径)。
function installColorFix() {
  try {
    const ctor = LiteGraph.registered_node_types["LG_Lock_Local"];
    if (!ctor || !ctor.prototype || ctor.prototype.__xzgColorFixInstalled) return;
    const proto = ctor.prototype;
    const orig = proto.onNodeCreated;
    if (typeof orig !== "function") return;
    proto.onNodeCreated = function (...args) {
      let ret;
      try {
        ret = orig.apply(this, args);
      } catch (err) {
        // 原始 onNodeCreated 异常不影响节点创建,继续
      }
      try {
        if (this.bgcolor === _PLUGIN_DEFAULT_BGCOLOR) this.bgcolor = undefined;
      } catch (err) {
        // 静默
      }
      return ret;
    };
    // 加载/切换工作流走 configure 路径,同样会把保存过的默认红恢复到节点上,
    // 因此也在 configure 后立即清掉,保证"加载即无色",不留闪红窗口。
    const origConf = proto.configure;
    if (typeof origConf === "function") {
      proto.configure = function (...args) {
        let ret;
        try {
          ret = origConf.apply(this, args);
        } catch (err) {
          // 原始 configure 异常继续
        }
        try {
          if (this.bgcolor === _PLUGIN_DEFAULT_BGCOLOR) this.bgcolor = undefined;
          // configure 加载的节点:尊重序列化中保存的节点尺寸(用户拖过的宽度/高度),
          // 标记为"已初始化",让 shrinkNodeToContent 不再强制收缩。
          this.__xzgSizeInit = true;
        } catch (err) {
          // 静默
        }
        return ret;
      };
    }
    proto.__xzgColorFixInstalled = true;
  } catch (err) {
    // 静默,下一轮重试
  }
}

// ---------- 低缩放"多余黑框"修复(复用"小珠光"通用铁律) ----------
// 根因(通过 Canvas hook + widget 采样最终定位,用户"nonono"提示正确方向):
//   目标节点有 3 个 widget: [seed, control_after_generate, hiddenJson(type=hidden)].
//   hiddenJson 的 value 是一段 30KB 处理 JSON 文本, LiteGraph 在 layout 阶段把它
//   当成普通 widget 计算了多行高度(约 68px × 超宽 540px)。尽管 type=hidden,
//   drawNodeWidgets 依然给它按标准 widget 画了背景+黑色外框横条。3 条黑框 = 多行
//   widget 行的外框,跟"小珠光视频加载器多行横条"绘制方法完全一致。
//
// 之前尝试 Canvas 2D shadow* / fillRect / stroke 上下文拦截完全无效,用户反馈正确:
//   黑框根本不是 Canvas 上下文"多渲染了一层投影/填充",而是业务层"多调用了"
//   drawNodeWidgets 对 hidden widget 的逐行绘制。方向完全反了!
//
// v2.5 正确修复(从 widget 源头抑制,不碰 Canvas 上下文):
//   1) drawNode 进入时,如果是目标节点,遍历其 widget,对 type=="hidden"
//      或名字含"hiddenJson"的 widget 打 __xzgSkipDraw 标记。
//   2) 包装 LGraphCanvas.prototype.drawNodeWidgets:在每个 widget 循环最开头加
//      `if (w.__xzgSkipDraw) continue;` → 整行 widget 背景/外框/控件文本都不画。
//   3) drawNode 出口清理 __xzgSkipDraw 标记,避免残留影响其他使用场景。
//   4) 同时仍保留"widget.width 只读访问器"铁律,防止属性面板把超宽 width 写
//      回造成其他溢出,但对 hidden widget 只是辅助,不再靠它解决黑框。
function isTargetNode(n) {
  if (!n) return false;
  const type = String(n.type || "");
  const title = String(n.title || "");
  return (
    type.indexOf("\u004c\u0047\u005f\u004c") === 0 ||   // 目标类型前缀
    title.indexOf("\u52a0\u5bc6") >= 0                   // 中文兜底
  );
}

// 节点标题伪装:让被处理节点在画布上显示为普通辅助节点名,不暴露其真实用途。
// 仅当标题为空或仍含可疑默认名时才覆盖,避免强行改掉用户自定义的标题。
const _STEALTH_TITLE = "\u5de5\u4f5c\u6d41\u5de5\u5177"; // "工作流工具"
function neutralizeNodeTitle(node) {
  if (!node || !isTargetNode(node)) return;
  if (node.__xzgTitleFixed) return;
  const t = String(node.title || "");
  if (!t || t.indexOf("\u52a0\u5bc6") >= 0 || t === node.type) {
    try {
      node.title = _STEALTH_TITLE;
      node.__xzgTitleFixed = true;
      const graph = node.graph || app.canvas.graph;
      if (graph && typeof graph.setDirtyCanvas === "function") graph.setDirtyCanvas(true, true);
    } catch (err) { /* 静默 */ }
  }
}
const _HID_MARK = "__xzgSkipDraw";

// drawNode 入口:给目标节点"不应显示的 widget"打跳过绘制标记。
// 两类被隐藏:
//   1) hiddenJson(type=hidden) —— 处理数据,不该被画成多行外框(黑框)。
//   2) $$canvas-image-preview —— 采样运行时前端动态加上的"缩略图预览"widget,
//      它把目标节点内部 KSampler 生成的实时预览画在节点上;处理后我们不想暴露
//      这个采样过程,所以一并跳过绘制(数据仍正常流过节点输出)。
function markHiddenWidgets(node) {
  const marks = [];
  if (!node || !node.widgets) return marks;
  if (!isTargetNode(node)) return marks;
  for (const w of node.widgets) {
    if (!w) continue;
    const t = String(w.type || "");
    const n = String(w.name || "").toLowerCase();
    const isPreview = n.indexOf("$$canvas-image-preview") === 0 ||
                      n.indexOf("image-preview") >= 0 ||
                      n.indexOf("imgpreview") >= 0;
    if (t === "hidden" || n.indexOf("hiddenjson") >= 0 || isPreview) {
      if (!w[_HID_MARK]) {
        w[_HID_MARK] = true;
        marks.push(w);
      }
    }
  }
  return marks;
}

// drawNode 出口:清理标记
function unmarkHiddenWidgets(marks) {
  if (!marks || !marks.length) return;
  for (const w of marks) delete w[_HID_MARK];
}

// 包装 drawNode:draw 前后打/清标记
function installDrawNodeHook() {
  const proto = window.LGraphCanvas && window.LGraphCanvas.prototype;
  if (!proto) return;
  if (proto.drawNode && proto.drawNode.__xzgShadowGuard) return;
  const orig = proto.drawNode;
  if (typeof orig !== "function") return;
  proto.drawNode = function (node) {
    let marks = [];
    try { marks = markHiddenWidgets(node); } catch (err) { /* 静默 */ }
    try { return orig.apply(this, arguments); }
    finally { try { unmarkHiddenWidgets(marks); } catch (err) { /* 静默 */ } }
  };
  proto.drawNode.__xzgShadowGuard = true;
}

// 包装 drawNodeWidgets:真正决定 widget 每一行是否被绘制的入口
function installDrawWidgetHook() {
  const proto = window.LGraphCanvas && window.LGraphCanvas.prototype;
  if (!proto) return;
  if (proto.drawNodeWidgets && proto.drawNodeWidgets.__xzgSkipGuard) return;
  const orig = proto.drawNodeWidgets;
  if (typeof orig !== "function") return;
  proto.drawNodeWidgets = function (node) {
    if (!node || !node.widgets) return orig.apply(this, arguments);
    // 防御:打一次标记(如果 drawNodeGuard 因时序还没来得及打)
    const extra = isTargetNode(node) ? markHiddenWidgets(node) : [];
    // 把 __xzgSkipDraw 的 widget 在函数入口原地隐藏掉:临时从数组里移除,
    // 调用完原函数再塞回去,避免改原型/影响其他代码对 widgets 长度的依赖。
    const ws = node.widgets;
    const saved = [];
    for (let i = ws.length - 1; i >= 0; i--) {
      if (ws[i] && ws[i][_HID_MARK]) {
        saved.push({ i, item: ws[i] });
        ws.splice(i, 1);
      }
    }
    try { return orig.apply(this, arguments); }
    finally {
      for (let j = saved.length - 1; j >= 0; j--) {
        ws.splice(saved[j].i, 0, saved[j].item);
      }
      try { unmarkHiddenWidgets(extra); } catch (err) { /* 静默 */ }
    }
  };
  proto.drawNodeWidgets.__xzgSkipGuard = true;
}

// 空占位(之前 Canvas 上下文拦截失败废弃)
function installShadowHook() {}

// ---------- 拓扑分析 ----------
// 注意:本插件(以及新版 ComfyUI)的节点 id / 链接的 origin_id / target_id
// 都是【字符串】,且 node.outputs[i].links 经常为 null(实时验证过)。
// 因此所有连接信息一律以 graph.links 为唯一权威来源,不依赖 outputs.links。

// 从 graph.links 构建两套邻接:
//   feedsFrom[srcId]  = Set(它向哪些节点输出)
//   recvFrom[tgtId]   = Set(它接收哪些节点的输入)
function buildLinkAdjacency() {
  const graph = app.canvas.graph;
  const feedsFrom = new Map();
  const recvFrom = new Map();
  for (const l of Object.values((graph && graph.links) || {})) {
    if (!l) continue;
    const s = String(l.origin_id), t = String(l.target_id);
    if (!feedsFrom.has(s)) feedsFrom.set(s, new Set());
    feedsFrom.get(s).add(t);
    if (!recvFrom.has(t)) recvFrom.set(t, new Set());
    recvFrom.get(t).add(s);
  }
  return { feedsFrom, recvFrom };
}

// 桥接节点:未被选中,却同时"接收选中节点的输出"并且"向选中节点输出"。
// 这种节点若留在处理组外部,会把 目标节点的输出又打回它的输入,形成环路。
function findBridgeNodes() {
  const graph = app.canvas.graph;
  const nodes = (graph && graph._nodes) || [];
  const sel = app.canvas.selected_nodes || {};
  const selIds = new Set(Object.keys(sel));
  const isSel = (id) => selIds.has(String(id));

  const { feedsFrom, recvFrom } = buildLinkAdjacency();

  const bridges = [];
  for (const n of nodes) {
    if (isSel(n.id)) continue;
    const key = String(n.id);
    const feeds = feedsFrom.get(key);
    const recv = recvFrom.get(key);
    const feedsSel = feeds && [...feeds].some(isSel);
    const recvSel = recv && [...recv].some(isSel);
    if (feedsSel && recvSel) bridges.push(n);
  }
  return bridges;
}

// 把选中节点按"仅通过选中节点直接相连"拆成连通分量(即拆分后的处理组)。
function splitGroups(selectedNodes) {
  const graph = app.canvas.graph;
  const selIds = new Set(selectedNodes.map((n) => n.id));
  const idToNode = new Map(selectedNodes.map((n) => [n.id, n]));

  const adj = new Map();
  for (const n of selectedNodes) adj.set(n.id, new Set());

  for (const link of Object.values(graph.links || {})) {
    if (!link) continue;
    const s = link.origin_id, t = link.target_id;
    if (selIds.has(s) && selIds.has(t)) {
      adj.get(s).add(t);
      adj.get(t).add(s);
    }
  }

  const visited = new Set();
  const groups = [];
  for (const n of selectedNodes) {
    if (visited.has(n.id)) continue;
    const comp = [];
    const stack = [n.id];
    visited.add(n.id);
    while (stack.length) {
      const cid = stack.pop();
      comp.push(idToNode.get(cid));
      for (const nb of adj.get(cid) || []) {
        if (!visited.has(nb)) { visited.add(nb); stack.push(nb); }
      }
    }
    groups.push(comp);
  }
  return groups;
}

// 检查是否存在无法通过拆分解决的"同组环路":
// 若某个桥接节点既向某拆分组的节点输出、又接收该组节点的输出,
// 说明该组被外部打回成环,拆分无法解决,只能提示用户把桥接节点一并选上。
function hasInternalLoop(bridges, groups) {
  const groupOf = new Map();
  groups.forEach((g, i) => g.forEach((n) => groupOf.set(String(n.id), i)));
  const { feedsFrom, recvFrom } = buildLinkAdjacency();

  for (const b of bridges) {
    const key = String(b.id);
    const feeds = new Set();
    const recv = new Set();
    for (const tid of feedsFrom.get(key) || []) {
      if (groupOf.has(tid)) feeds.add(groupOf.get(tid));
    }
    for (const sid of recvFrom.get(key) || []) {
      if (groupOf.has(sid)) recv.add(groupOf.get(sid));
    }
    for (const gi of feeds) {
      if (recv.has(gi)) return true;
    }
  }
  return false;
}

// ---------- UI ----------

function showInfoDialog(title, bodyHtml) {
  if (currentMask) currentMask.remove();
  const mask = document.createElement("div");
  mask.style.cssText =
    "position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,0.6);" +
    "display:flex;align-items:center;justify-content:center;font-family:monospace;";

  const box = document.createElement("div");
  box.style.cssText =
    "background:#262626;border-radius:8px;padding:18px 20px;max-width:560px;" +
    "color:#ddd;box-shadow:0 4px 20px rgba(0,0,0,0.5);";

  box.innerHTML =
    `<h4 style="margin:0 0 10px;color:#ffd700;">${title}</h4>` +
    bodyHtml +
    `<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">` +
    `<button id="guard-ok" style="padding:4px 14px;background:#333;border:1px solid #555;color:#ddd;border-radius:4px;cursor:pointer;">确定</button>` +
    `</div>`;

  mask.appendChild(box);
  document.body.appendChild(mask);
  currentMask = mask;

  const close = () => {
    if (currentMask === mask) currentMask = null;
    mask.remove();
  };
  box.querySelector("#guard-ok").onclick = close;
  mask.onclick = (e) => { if (e.target === mask) close(); };
}

// ---------- 管理密码接口保护 ----------
// adminSecret 会返回管理密码。默认任何脚本 / 控制台都能读到,
// 是当前最直接的泄漏面。这里把它包一层:仅当处于 guard 自己的处理流程(accessGate 打开)
// 时可读,否则返回 undefined 并告警。accessGate 是闭包私有变量,外部脚本拿不到引用、
// 也无法自行打开,只有本文件的内部函数能操作。
const accessGate = { open: false };
let _expectedAdminSecret = null; // 受控版 adminSecret 的引用,供看门狗比对回滚
const _API_ORIG = { addHiddenNode: null, createGlobalSettingsDialog: null };

function readAccessKey() {
  if (!window.__xzgTools) return undefined;
  accessGate.open = true;
  try {
    return window.__xzgTools.adminSecret();
  } finally {
    accessGate.open = false;
  }
}

// 给 adminSecret 装上"仅处理流程可读"的受控版。
function mountAccessKeyGate() {
  const api = window.__xzgTools;
  if (!api || api.__xzgGateOn) return;
  const desc = Object.getOwnPropertyDescriptor(api, "adminSecret");
  const cur = (desc && desc.value && typeof desc.value === "function") ? desc.value
            : (typeof api.adminSecret === "function" ? api.adminSecret : null);
  if (!cur) return;
  const gated = function () {
    if (!accessGate.open) {
      console.warn("%c[util] 越权读取密码已拦截","color:#ffd700;font-weight:bold");
      return undefined;
    }
    return cur.call(this);
  };
  _expectedAdminSecret = gated;
  try {
    Object.defineProperty(api, "adminSecret", {
      configurable: true,
      enumerable: true,
      writable: false,
      value: gated,
    });
  } catch (err) {
    console.warn("[util] 密码读取保护失败", err);
    return;
  }
  api.__xzgGateOn = true;
}

// 快照原始 addHiddenNode / createGlobalSettingsDialog,供看门狗比对与回滚。
function snapshotProtectedApi() {
  const api = window.__xzgTools;
  if (!api) return;
  if (!_API_ORIG.addHiddenNode && typeof api.addHiddenNode === "function") {
    _API_ORIG.addHiddenNode = api.addHiddenNode;
  }
  if (!_API_ORIG.createGlobalSettingsDialog && typeof api.createGlobalSettingsDialog === "function") {
    _API_ORIG.createGlobalSettingsDialog = api.createGlobalSettingsDialog;
  }
  mountAccessKeyGate();
}

// 看门狗:关键方法若被第三方脚本改写,立即告警并回滚到受保护版本。
function watchdogProtectedApi() {
  const api = window.__xzgTools;
  if (!api) return;
  try {
    if (_API_ORIG.addHiddenNode && api.addHiddenNode !== _API_ORIG.addHiddenNode) {
      console.warn("%c[util] 接口被改写,已回滚","color:#ffd700;font-weight:bold");
      api.addHiddenNode = _API_ORIG.addHiddenNode;
    }
    if (_API_ORIG.createGlobalSettingsDialog &&
        api.createGlobalSettingsDialog !== _API_ORIG.createGlobalSettingsDialog) {
      console.warn("%c[util] 配置接口被改写,已回滚","color:#ffd700;font-weight:bold");
      api.createGlobalSettingsDialog = _API_ORIG.createGlobalSettingsDialog;
    }
    // adminSecret 必须始终是最新的受控版;若被整体替换、或 __xzgGateOn 假标记被清,重装受控。
    if (api.__xzgGateOn && api.adminSecret !== _expectedAdminSecret) {
      console.warn("%c[util] 密码接口被替换,已重新保护","color:#ffd700;font-weight:bold");
      api.__xzgGateOn = false;
      mountAccessKeyGate();
    }
  } catch (err) {
    // 静默,下一轮再试
  }
}

// ---------- 内容防外泄 ----------
// 目标节点的 payload(hiddenJson) 虽是数据,但若被"复制 / 克隆 / 导出"整块带出,
// 可被离线大量分析。这里在目标节点的右键菜单上移除复制 / 克隆 / 导出类条目,
// 并拦截复制 / 剪切快捷键,减少整块外带的向量。
const EXPOSURE_KEYWORDS = [
  "copy", "clone", "duplicate", "export", "save", "download",
  "复制", "克隆", "复制节点", "导出", "另存", "下载",
];

function isExposureItem(o) {
  if (!o) return false;
  let txt = "";
  if (typeof o.content === "string") txt = o.content;
  else if (o.content && typeof o.content === "object") {
    txt = String(o.content.content || o.content.label || "");
  }
  const c = txt.toLowerCase();
  return EXPOSURE_KEYWORDS.some((k) => c.indexOf(k) >= 0);
}

function stripExposureMenus(opts) {
  if (!Array.isArray(opts)) return opts;
  return opts.filter((o) => !(o && isExposureItem(o)));
}

// ---------- 下线已弃用的菜单入口 ----------
// 应需求移除某已弃用功能的两个右键菜单入口(单组 / 批量)。
// 两类菜单(Vue 组件 / 原生 LiteGraph)最终都经 getNodeMenuOptions 生成条目,
// 在 makeWrapper 里统一过滤即可,无需改动核心代码。含子菜单递归处理。
const RESTORE_MENU_RE = /\u8fd8\u539f\u8282\u70b9\u7ec4|\u6279\u91cf\u8fd8\u539f/;

function menuContentText(o) {
  if (!o) return "";
  if (typeof o.content === "string") return o.content;
  if (o.content && typeof o.content === "object") {
    return String(o.content.content || o.content.label || "");
  }
  return "";
}

function stripRestoreMenus(opts) {
  if (!Array.isArray(opts)) return opts;
  const out = [];
  for (const o of opts) {
    if (o && RESTORE_MENU_RE.test(menuContentText(o))) continue;
    // 子菜单同样过滤(不修改命中项,只清理其下级)
    if (o && o.submenu && Array.isArray(o.submenu.options)) {
      o.submenu.options = stripRestoreMenus(o.submenu.options);
    }
    out.push(o);
  }
  return out;
}

function installClipboardHook() {
  if (document.__xzgClipGuard) return;
  document.__xzgClipGuard = true;
  const rejectIfTargetSelected = (e) => {
    const sel = (app.canvas && app.canvas.selected_nodes) || {};
    for (const n of Object.values(sel)) {
      if (isTargetNode(n)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
    }
  };
  document.addEventListener("copy", rejectIfTargetSelected, true);
  document.addEventListener("cut", rejectIfTargetSelected, true);
}

// ---------- 智能拆分处理 ----------

// 判断一个(即将被处理的)节点是否带有"随机种子"控件。
// 只要它的某个 widget 名字里含 seed(如 seed / noise_seed)就视为有种子。
function hasSeedWidget(node) {
  if (!node || !node.widgets) return false;
  return node.widgets.some((w) => {
    const nm = String((w && w.name) || "").toLowerCase();
    return nm.indexOf("seed") >= 0;
  });
}

// 从目标节点上移除外露的种子上位 widget(seed + control_after_generate)。
// 当被处理的工作流本身没有任何种子控件时,这个 seed 毫无意义,应一并隐藏。
// 说明:目标节点的 expose seed / control_after_generate 控件名就是标准的
//       "seed"、"control_after_generate"(来自其 Python 类声明的输入,由 ComfyUI
//       自动 addWidget 动态创建),因此按名字精确比较即可稳定命中。
function stripHiddenSeed(node) {
  if (!node || !node.widgets) return;
  let removed = false;
  for (let i = node.widgets.length - 1; i >= 0; i--) {
    const nm = String((node.widgets[i] && node.widgets[i].name) || "");
    if (nm === "seed" || nm === "control_after_generate") {
      node.widgets.splice(i, 1);
      removed = true;
    }
  }
  if (!removed) return; // 没有可移除的控件,不再重排(幂等,轮询零开销)
  // 移除控件后立即重算节点高度,避免留下一截空白
  try {
    const graph = node.graph || app.canvas.graph;
    if (typeof node.setSize === "function") {
      const sz = typeof node.computeSize === "function" ? node.computeSize() : null;
      if (sz) node.setSize([node.size[0], sz[1]]);
    }
    if (graph && typeof graph.setDirtyCanvas === "function") graph.setDirtyCanvas(true, true);
  } catch (err) {
    // 静默
  }
}

// 周期兜底:对已标记"无种子"(__xzgNoSeed)的目标节点,持续移除 seed 控件。
// 因为该 seed 是 目标节点类自动创建的输入控件,配置/排队/重载时可能被重建,
// 一次性清除不够,必须在轮询里按标记持续兜底,保证它始终不被暴露。
function suppressHiddenSeed() {
  try {
    const graph = app.canvas && app.canvas.graph;
    const nodes = (graph && graph._nodes) || [];
    for (const n of nodes) {
      if (n && n.__xzgNoSeed && isTargetNode(n)) stripHiddenSeed(n);
    }
  } catch (err) {
    // 静默,下一轮再试
  }
}

async function doSmartGroup(bridges) {
  const api = window.__xzgTools;
  if (!api || typeof api.addHiddenNode !== "function") {
    showInfoDialog("⚠️ 未找到处理接口",
      `<p style="margin:0;font-size:12px;">未检测到增强补丁,已取消本次处理。</p>`);
    return;
  }

  // 确保有管理密码(与核心原生行为一致);走受控的 readAccessKey 读取
  if (!readAccessKey()) {
    const res = await api.createGlobalSettingsDialog();
    if (!res || !res.success || !readAccessKey()) return;
  }
  const secret = readAccessKey();

  const selectedNodes = Object.values(app.canvas.selected_nodes || {});
  if (selectedNodes.length === 0) return;

  const groups = splitGroups(selectedNodes);
  if (groups.length === 0) return;

  if (hasInternalLoop(bridges, groups)) {
    showInfoDialog("⚠️ 检测到无法自动拆分",
      `<p style="margin:0;font-size:12px;line-height:1.8;">存在连接节点在该组内"进进出出",拆分无法消除环路。<br/>请把该连接节点也一并选中后再处理(或将其纳入该组)。</p>`);
    return;
  }

  // 逐个处理(顺序执行;每个 addHiddenNode 会把组内节点从画布移除并接好外部连线)
  const graph = app.canvas && app.canvas.graph;
  const beforeIds = new Set(
    (graph && Array.isArray(graph._nodes) ? graph._nodes : []).map((n) => n.id)
  );
  for (const g of groups) {
    if (!g.length) continue;
    const groupHasSeed = g.some((n) => hasSeedWidget(n));
    await api.addHiddenNode(g, secret, 0);
    // 找到本次新生成的目标节点,若组内没有种子控件则移除其 seed/control_after_generate
    try {
      const created = (graph && graph._nodes || [])
        .filter((n) => !beforeIds.has(n.id) && isTargetNode(n));
      if (!groupHasSeed) {
        for (const ln of created) {
          ln.__xzgNoSeed = true;   // 标记:后续轮询持续隐藏 seed 控件
          stripHiddenSeed(ln);
        }
      }
      for (const ln of created) beforeIds.add(ln.id);
    } catch (err) {
      console.warn("[util] 处理节点控件失败", err);
    }
  }

  // 清掉指向已移除节点的残留选中,避免画布出现"幽灵选中"或误删
  app.canvas.selected_nodes = {};

  const groupNames = groups
    .map((g, i) => `第 ${i + 1} 组(${g.length} 个):${g.map((n) => n.title || n.type).join("、")}`)
    .join("<br/>");
  showInfoDialog("✅ 已自动分组处理,避免环路",
    `<p style="margin:0 0 8px;font-size:12px;">已按连通分量拆成 <b>${groups.length}</b> 组分别处理,连接节点保持原样:</p>` +
    `<div style="font-size:12px;line-height:1.8;">${groupNames}</div>`);
}

// ---------- 菜单回调包装(核心拦截点) ----------

// 包装「目标节点组（本地）」的原生回调:
//   存在桥接节点 -> 走智能拆分;否则 -> 原样调用原生回调。
function wrapGroupCallback(origCb) {
  const wrapped = async function (...args) {
    try {
      const bridges = findBridgeNodes();
      console.log(
        "[util] 处理菜单已命中本扩展, 桥接节点数 =",
        bridges.length,
        bridges.map((n) => n.title || n.type)
      );
      if (bridges.length > 0) {
        // 智能拆分路径内部已处理"无种子则不暴露 seed"的逻辑
        await doSmartGroup(bridges);
        return true; // 已由本扩展处理
      }
    } catch (err) {
      console.warn("[util] 处理异常,回退原生", err);
    }
    // 拓扑正常或拆分失败:放行原生处理,行为基本不变;
    // 但在原生处理前后记录节点集合,若本次处理的工作流没有任何种子控件,
    // 就把新目标节点上暴露的 seed/control_after_generate 一并隐藏。
    const graph = app.canvas && app.canvas.graph;
    const nodesBefore = new Set(
      (graph && Array.isArray(graph._nodes) ? graph._nodes : []).map((n) => n.id)
    );
    const preSel = Object.values(app.canvas.selected_nodes || {});
    const preHasSeed = preSel.some((n) => hasSeedWidget(n));
    const ret = origCb.apply(this, args);
    try {
      if (ret && typeof ret.then === "function") await ret;
      if (!preHasSeed) {
        const created = (graph && Array.isArray(graph._nodes) ? graph._nodes : [])
          .filter((n) => !nodesBefore.has(n.id) && isTargetNode(n));
        for (const ln of created) {
          ln.__xzgNoSeed = true;   // 标记:后续轮询持续隐藏 seed 控件
          stripHiddenSeed(ln);
        }
      }
    } catch (err) {
      console.warn("[util] 原生处理后失败", err);
    }
    return ret;
  };
  wrapped.__xzgGuardWrapped = true;
  return wrapped;
}

let myWrapper = null;

// 对当前 getNodeMenuOptions 包装一层:找到「目标节点组」项,包住其 callback。
function makeWrapper(cur) {
  return function (node) {
    let opts = cur.apply(this, arguments);
    try {
      // 下线已弃用功能:所有菜单移除对应条目
      opts = stripRestoreMenus(opts);
      // 防暴露:目标节点的右键菜单移除复制 / 克隆 / 导出类条目
      if (isTargetNode(node)) opts = stripExposureMenus(opts);
      const list = Array.isArray(opts) ? opts : [];
      for (const o of list) {
        if (
          o && typeof o === "object" &&
          o.content && MENU_KEYWORDS.some((k) => String(o.content).includes(k)) &&
          typeof o.callback === "function" && !o.callback.__xzgGuardWrapped
        ) {
          o.callback = wrapGroupCallback(o.callback);
        }
      }
    } catch (err) {
      console.warn("[util] 菜单包装异常", err);
    }
    return opts;
  };
}

// 轮询安装/维持最外层包装,处理与插件 setup 的时序竞态。
function ensureHookInstalled() {
  const proto = window.LGraphCanvas && window.LGraphCanvas.prototype;
  if (!proto) return;
  if (!window.__xzgTools) return; // 核心尚未加载,等待
  const cur = proto.getNodeMenuOptions;
  if (!cur) return;
  if (myWrapper && cur === myWrapper) return; // 已是最外层,无需再包

  try {
    const wrapper = makeWrapper(cur);
    proto.getNodeMenuOptions = wrapper;
    myWrapper = wrapper;
  } catch (err) {
    console.warn("[util] 安装菜单钩子失败", err);
  }
}

setInterval(() => {
  ensureHookInstalled();
  ensureWidthProtected();
  suppressPreviewLayout();
  suppressHiddenSeed();
  shrinkTargetNodes();
  installColorFix();
  restoreTargetNodeColors();
  snapshotProtectedApi();
  watchdogProtectedApi();
  installClipboardHook();
  installShadowHook();
  installDrawNodeHook();
  installDrawWidgetHook();
}, 200);

// ---------- 调试信息 ----------
window.__xzgGuard = {
  version: "3.2",
  ready: () => !!window.__xzgTools,
  installed: () => myWrapper !== null && window.LGraphCanvas?.prototype.getNodeMenuOptions === myWrapper,
  // 保护状态自检
  sec: () => {
    const api = window.__xzgTools;
    return {
      apiReady: !!api,
      gateClosed: !!api && api.__xzgGateOn,
      outsideRead: (() => {
        // 模拟越权读取(不打开 accessGate),应返回 undefined 而非真实密码
        try { return api.adminSecret && api.adminSecret(); } catch (e) { return "<throw:" + e + ">"; }
      })(),
      apiIntact:
        !!api &&
        (!_API_ORIG.addHiddenNode || api.addHiddenNode === _API_ORIG.addHiddenNode) &&
        (!_API_ORIG.createGlobalSettingsDialog ||
          api.createGlobalSettingsDialog === _API_ORIG.createGlobalSettingsDialog),
    };
  },
  // 纯诊断:不改图,返回当前选中节点的桥接/分组分析
  analyze: () => {
    const sel = Object.values(app.canvas.selected_nodes || {});
    const { feedsFrom, recvFrom } = buildLinkAdjacency();
    return {
      selected: sel.map((n) => n.title || n.type),
      bridges: findBridgeNodes().map((n) => n.title || n.type),
      groups: sel.length
        ? splitGroups(sel).map((g) => g.map((n) => n.title || n.type))
        : [],
      internalLoop: sel.length
        ? hasInternalLoop(findBridgeNodes(), splitGroups(sel))
        : false,
      linkCount: Object.keys(app.canvas.graph?.links || {}).length,
      feedsFromSize: feedsFrom.size,
      recvFromSize: recvFrom.size
    };
  },
  // 自测:不改图,按"选中节点"执行一次桥接/分组分析,返回详细链路信息,
  // 用于验证新版 link-based 检测在真实图上是否生效。
  testBridge: () => {
    const sel = Object.values(app.canvas.selected_nodes || {});
    const selIds = new Set(sel.map((n) => String(n.id)));
    const { feedsFrom, recvFrom } = buildLinkAdjacency();
    const graph = app.canvas.graph;
    const links = Object.values((graph && graph.links) || {}).filter(Boolean);
    const detail = links.map((l) => ({
      origin_id: String(l.origin_id),
      target_id: String(l.target_id),
      origin_sel: selIds.has(String(l.origin_id)),
      target_sel: selIds.has(String(l.target_id)),
      type: l.type
    }));
    return {
      selected: sel.map((n) => n.title || n.type),
      bridgeDetected: findBridgeNodes().map((n) => n.title || n.type),
      allLinks: detail
    };
  }
};

console.log(
  "%c[util] 已加载",
  "color:#ffd700;font-weight:bold"
);
