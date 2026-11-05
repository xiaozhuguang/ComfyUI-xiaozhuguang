import ast
import inspect
from pathlib import Path
import time
from types import SimpleNamespace
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'nodes/xzg_h3_prompt.py'

class PromptSamplingParamsTest(unittest.TestCase):
    def test_sampling_controls_reach_model(self):
        tree = ast.parse(SOURCE.read_text(encoding='utf-8-sig'))
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'XiaozhuguangNinimaxH3Prompt')
        optimize = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == 'optimize_prompt')
        assignment = next(n for n in optimize.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'params' for t in n.targets))
        scope = dict(safe_max_tokens=256, temperature=.7, top_p=.9, top_k=31,
                     repeat_penalty=1.15, frequency_penalty=.2, presence_penalty=.3)
        exec(compile(ast.Module(body=[assignment], type_ignores=[]), str(SOURCE), 'exec'), scope)
        call = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_xzg_call_chat_completion')
        scope.update(inspect=inspect, time=time, mm=SimpleNamespace(throw_exception_if_processing_interrupted=lambda: None))
        exec(compile(ast.Module(body=[call], type_ignores=[]), str(SOURCE), 'exec'), scope)
        captured = {}
        class Model:
            def create_chat_completion(self, **kwargs):
                captured.update(kwargs)
                yield {'choices': [{'delta': {'content': 'A quiet room.'}}]}
                yield {'choices': [{'delta': {'content': ' Soft daylight.'}}]}
        result = scope['_xzg_call_chat_completion'](Model(), [], scope['params'])
        for key in ('top_k', 'repeat_penalty', 'frequency_penalty', 'presence_penalty'):
            self.assertEqual(captured[key], scope[key])
        self.assertEqual(result['choices'][0]['message']['content'], 'A quiet room. Soft daylight.')
        defaults = dict(zip([a.arg for a in optimize.args.args][-len(optimize.args.defaults):], optimize.args.defaults))
        self.assertEqual(ast.literal_eval(defaults['repeat_penalty']), 1.1)

if __name__ == '__main__':
    unittest.main()
