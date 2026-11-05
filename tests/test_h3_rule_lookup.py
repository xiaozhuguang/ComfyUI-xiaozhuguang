import ast
from pathlib import Path
import re
import unittest


class PromptRuleLookupTest(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[1] / 'nodes/xzg_h3_prompt.py'
        names = {'_xzg_load_saved_prompt_rule', '_xzg_prompt_rule_selection_names'}
        functions = [n for n in ast.parse(source.read_text(encoding='utf-8-sig')).body
                     if isinstance(n, ast.FunctionDef) and n.name in names]
        self.presets = {'rule': {'id': 'xzg-rule:original', 'name': 'replacement',
                                 'category': 'custom', 'rule': 'expected rule'}}
        scope = {'re': re, '_xzg_read_prompt_rule_presets': lambda: self.presets}
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), 'exec'), scope)
        self.load = scope['_xzg_load_saved_prompt_rule']

    def test_numeric_legacy_id_recovers_by_name(self):
        self.assertEqual(self.load('replacement', 'custom', '24'), 'expected rule')

    def test_valid_id_remains_authoritative(self):
        self.assertEqual(self.load('old name', 'custom', 'xzg-rule:original'), 'expected rule')
        self.assertIsNone(self.load('replacement', 'custom', 'xzg-rule:deleted'))

    def test_ambiguous_name_is_rejected(self):
        self.presets['other'] = {'id': 'other', 'name': 'replacement',
                                 'category': 'custom', 'rule': 'other rule'}
        with self.assertRaises(ValueError):
            self.load('replacement', 'custom', '24')

    def test_other_category_is_not_used(self):
        self.assertIsNone(self.load('replacement', 'other category', '24'))


if __name__ == '__main__':
    unittest.main()
