"""Exercise installed ComfyUI dependency scheduling without loading GPU models."""
import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]


def definitions(path, names, namespace):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    selected = [n for n in tree.body if isinstance(n, (ast.ClassDef, ast.FunctionDef)) and n.name in names]
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(path), "exec"), namespace)


class ManualTrackingLazyTest(unittest.TestCase):
    def setUp(self):
        ns = {"_LAZY_SWITCH_ANY": "*", "MANUAL_MODEL_NAME": "手工跟踪", "_param_tooltip": lambda key: key}
        definitions(ROOT / "_xzg_watermark/nodes.py", {"VideoWatermarkDetector", "XZGManualTrackingLoadPreview"}, ns)
        definitions(ROOT / "nodes/xzg_lazy_switch.py", {"AnyType", "XiaozhuguangLazySwitch"}, ns)
        # The switch schema uses the module's wildcard instance.
        ns["_LAZY_SWITCH_ANY"] = "*"
        self.mapping = {key: ns[key] for key in ("VideoWatermarkDetector", "XZGManualTrackingLoadPreview", "XiaozhuguangLazySwitch")}
        ns.update(asyncio=asyncio, nodes=SimpleNamespace(NODE_CLASS_MAPPINGS=self.mapping),
                  _ComfyNodeInternal=type("V3", (), {}), is_link=lambda x: isinstance(x, list) and len(x) == 2)
        graph_path = ROOT.parents[1] / "comfy_execution/graph.py"
        # Remove annotations only; execute the actual installed scheduler methods.
        tree = ast.parse(graph_path.read_text(encoding="utf-8"))
        selected = [n for n in tree.body if isinstance(n, (ast.ClassDef, ast.FunctionDef)) and n.name in {"DynamicPrompt", "TopologicalSort", "get_input_info", "NodeInputError"}]
        module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)] + selected, type_ignores=[])
        exec(compile(ast.fix_missing_locations(module), str(graph_path), "exec"), ns)
        self.ns = ns

    def plan(self, preview=False):
        prompt = {
            "load": {"class_type": "Source", "inputs": {}},
            "track": {"class_type": "XZGManualTrackingLoadPreview" if preview else "VideoWatermarkDetector", "inputs": {"image": ["load", 0]}},
            "direct": {"class_type": "Source", "inputs": {}},
            "switch": {"class_type": "XiaozhuguangLazySwitch", "inputs": {"boolean": False, "ON_TRUE": ["track", 0], "ON_FALSE": ["direct", 0]}},
        }
        sorter = self.ns["TopologicalSort"](self.ns["DynamicPrompt"](prompt))
        sorter.is_cached = lambda _: False
        sorter.add_node("switch")
        for key in ("track",):
            if self.mapping[prompt[key]["class_type"]].OUTPUT_NODE:
                sorter.add_node(key)
        return sorter

    def test_false_branch_does_not_schedule_tracking_or_its_loader(self):
        sorter = self.plan()
        needed = self.mapping["XiaozhuguangLazySwitch"]().check_lazy_status(False)
        self.assertEqual(needed, ["ON_FALSE"])
        sorter.make_input_strong_link("switch", needed[0])
        self.assertEqual(set(sorter.pendingNodes), {"switch", "direct"})

    def test_true_branch_requests_tracking_and_loader(self):
        sorter = self.plan()
        needed = self.mapping["XiaozhuguangLazySwitch"]().check_lazy_status(True)
        sorter.make_input_strong_link("switch", needed[0])
        self.assertEqual(set(sorter.pendingNodes), {"switch", "track", "load"})

    def test_explicit_load_remains_an_output_root(self):
        sorter = self.plan(preview=True)
        self.assertIn("track", sorter.pendingNodes)
        self.assertIn("load", sorter.pendingNodes)
        self.assertEqual(self.mapping["VideoWatermarkDetector"].INPUT_TYPES(), self.mapping["XZGManualTrackingLoadPreview"].INPUT_TYPES())


class PointsEditorLazyTest(ManualTrackingLazyTest):
    def setUp(self):
        super().setUp()
        definitions(ROOT / "__init__.py", {"XiaozhuguangPointsEditor", "XZGPointsEditorLoadPreview"}, self.ns)
        self.mapping["VideoWatermarkDetector"] = self.ns["XiaozhuguangPointsEditor"]
        self.mapping["XZGManualTrackingLoadPreview"] = self.ns["XZGPointsEditorLoadPreview"]


if __name__ == "__main__":
    unittest.main()
