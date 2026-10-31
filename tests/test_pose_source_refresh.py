import copy
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest


ROOT = Path(__file__).resolve().parents[1] / '_xzg_pose'
PACKAGE = '_pose_source_refresh_test'
package = types.ModuleType(PACKAGE)
package.__path__ = [str(ROOT)]
sys.modules[PACKAGE] = package
spec = importlib.util.spec_from_file_location(PACKAGE + '.nodes', ROOT / 'nodes.py')
nodes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nodes)


class PoseSourceRefreshTests(unittest.TestCase):
    def setUp(self):
        self.frames = [{'canvas_width': 100, 'canvas_height': 100,
                        'people': [{'pose_keypoints_2d': [20, 30, 1] * 18}]}]
        self.node = nodes.PoseSequenceEditor()
        self.node._render_images = lambda frames, *args: frames

    def test_changed_source_loads_session_without_stale_operations(self):
        original = copy.deepcopy(self.frames)
        edits = {'version': 1, 'source_digest': 'old-source',
                 'operations': [{'type': 'joint', 'joint': 0, 'frame': 99,
                                 'dx': .1, 'dy': 0}]}
        result = self.node.execute(self.frames, edits_json=json.dumps(edits))
        self.assertEqual(result['ui']['source_changed'], [True])
        self.assertEqual(result['result'][0], self.frames)
        session = nodes.session_store.get(result['ui']['pose_session'][0])
        self.assertEqual(session['source_digest'], nodes.digest(self.frames))
        self.assertEqual(self.frames, original)

    def test_matching_source_keeps_edits(self):
        edits = {'version': 1, 'source_digest': nodes.digest(self.frames),
                 'operations': [{'type': 'joint', 'joint': 0, 'frame': 0,
                                 'dx': .1, 'dy': 0}]}
        result = self.node.execute(self.frames, edits_json=json.dumps(edits))
        self.assertEqual(result['ui']['source_changed'], [False])
        self.assertEqual(result['result'][0][0]['people'][0]['pose_keypoints_2d'][0], 30)

    def test_invalid_current_edits_still_fail(self):
        with self.assertRaises(ValueError):
            self.node.execute(self.frames, edits_json='{"version":2,"operations":[]}')


if __name__ == '__main__':
    unittest.main()
