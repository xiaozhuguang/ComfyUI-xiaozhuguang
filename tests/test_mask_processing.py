import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

import numpy as np
from scipy import ndimage as ndi
import torch


def load_node(filename):
    spec = importlib.util.spec_from_file_location(filename, Path(__file__).resolve().parents[1] / "nodes" / (filename + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


Cleanup = load_node("xzg_mask_cleanup_repair").XiaozhuguangMaskCleanupRepair
ATBC = load_node("xzg_atbc").XiaozhuguangATBC


class MaskProcessingTest(unittest.TestCase):
    def setUp(self):
        self.node = Cleanup()
        management = types.ModuleType("comfy.model_management")
        management.throw_exception_if_processing_interrupted = lambda: None
        self.stubs = patch.dict(sys.modules, {"comfy": types.ModuleType("comfy"), "comfy.model_management": management})
        self.stubs.start()
        self.addCleanup(self.stubs.stop)

    def process(self, mask=None, **options):
        return self.node.execute(mask=mask, cleanup_enabled=False, **options)[0]

    def test_no_mask_is_allowed_with_every_operation_enabled(self):
        self.assertEqual(self.node.execute(mask=None, mask_binarize=True, erode_dilate=8, repair_enabled=True), (None,))
        self.assertEqual(self.node.execute(mask=torch.empty(0, 9, 9), mask_binarize=True), (None,))
        self.assertIn("mask", Cleanup.INPUT_TYPES()["optional"])

    def test_disabled_operations_pass_through(self):
        mask = torch.rand(2, 5, 7)
        self.assertIs(self.process(mask), mask)

    def test_binary_only_and_exact_threshold(self):
        mask = torch.tensor([[[0., .3, .5, .51, 1.]]], dtype=torch.float64)
        output = self.process(mask, mask_binarize=True, mask_threshold=.5)
        torch.testing.assert_close(output, torch.tensor([[[0., 0., 0., 1., 1.]]], dtype=mask.dtype))
        self.assertEqual(self.process(mask, mask_binarize=True, mask_threshold=0).sum().item(), 4)
        self.assertEqual(self.process(mask, mask_binarize=True, mask_threshold=1).sum().item(), 0)

    def test_expand_is_independent_and_preserves_soft_values(self):
        mask = torch.zeros(1, 9, 9)
        mask[0, 4, 4] = .4
        square = self.process(mask, erode_dilate=2)
        tapered = self.process(mask, erode_dilate=2, tapered_corners=True)
        self.assertEqual(torch.count_nonzero(square).item(), 25)
        self.assertEqual(torch.count_nonzero(tapered).item(), 13)
        self.assertEqual(square.max().item(), mask.max().item())
        self.assertEqual(tapered.max().item(), mask.max().item())
        self.assertEqual(torch.count_nonzero(self.process(mask, erode_dilate=-1)).item(), 0)

    def test_binarization_runs_after_blur(self):
        mask = torch.zeros(1, 9, 9)
        mask[:, 3:6, 3:6] = 1
        soft = self.process(mask, repair_enabled=True, blur=2)
        binary = self.process(mask, repair_enabled=True, blur=2, mask_binarize=True, mask_threshold=.3)
        torch.testing.assert_close(binary, (soft > .3).to(dtype=mask.dtype))

    def test_expansion_does_not_enable_other_repairs(self):
        mask = torch.zeros(1, 9, 9)
        mask[0, 4, 4] = 1
        output = self.process(mask, erode_dilate=1, blur=4, fill_holes=3)
        torch.testing.assert_close(output, self.process(mask, erode_dilate=1))

    def test_torch_morphology_matches_scipy_without_allocating_cuda(self):
        values = np.random.default_rng(42).random((2, 7, 9), dtype=np.float32)
        cpu_device = torch.device("cpu")
        for expansion in (-2, 2):
            for tapered in (False, True):
                with self.subTest(expansion=expansion, tapered=tapered):
                    expected = self.node._repair_cpu(values.copy(), expansion, 0, 0, 0, 0, ndi, lambda: None, tapered)
                    with patch.object(torch, "device", return_value=cpu_device), \
                            patch.object(torch.cuda, "current_device", return_value=0), \
                            patch.object(torch.cuda, "mem_get_info", return_value=(1024**3, 1024**3)):
                        actual = self.node._repair_gpu(values.copy(), expansion, 0, 0, 0, 0, lambda: None, tapered)
                    np.testing.assert_array_equal(actual, expected)

    def test_atbc_only_exposes_mask_and_no_binary_controls(self):
        optional = ATBC.INPUT_TYPES()["optional"]
        self.assertEqual(optional["mask"][0], "MASK")
        self.assertNotIn("mask_binarize", optional)
        self.assertNotIn("mask_threshold", optional)
        with self.assertRaises(ValueError):
            ATBC._normalize_mask_input(torch.rand(1, 8, 8, 3))

    def test_atbc_no_mask_uses_full_image(self):
        image = torch.rand(1, 8, 12, 3)
        output, boxes, mask = ATBC().crop_and_resize(image, mask=None, kilopixels=.096, divisible_by=1)
        self.assertEqual(output.shape[0], 1)
        self.assertEqual(mask.shape, output.shape[:3])
        self.assertEqual(torch.count_nonzero(mask).item(), 0)
        self.assertEqual(boxes["batch_size"], 1)


if __name__ == "__main__":
    unittest.main()
