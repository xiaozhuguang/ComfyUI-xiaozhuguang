import importlib
import json
from pathlib import Path
import sys
import types
import unittest

sys.path.insert(0, str(Path(__file__).parent))
from test_core import fixture

package = types.ModuleType('pose_test_package')
package.__path__ = [str(Path(__file__).resolve().parents[1])]
sys.modules['pose_test_package'] = package
nodes = importlib.import_module('pose_test_package.nodes')
store = importlib.import_module('pose_test_package.session_store')


class NodeTests(unittest.TestCase):
    def test_saved_edits_replay_without_accumulation(self):
        editor = nodes.PoseSequenceEditor()
        frames = fixture()
        edits = json.dumps({'version':1,'operations':[{'type':'translate','start':1,'end':3,
                            'person':0,'dx':.1,'dy':0}]})
        first=editor.execute(frames,25,edits)
        second=editor.execute(frames,25,edits)
        self.assertEqual(first['result'],second['result'])
        self.assertEqual(len(first['result']),1)
        self.assertEqual(store.get(first['ui']['pose_session'][0])['frames'],frames)

    def test_cache_is_bounded(self):
        tokens=[store.put(fixture(),None,25,'test') for _ in range(6)]
        self.assertIsNone(store.get(tokens[0]))
        self.assertIsNotNone(store.get(tokens[-1]))



if __name__=='__main__':unittest.main()
