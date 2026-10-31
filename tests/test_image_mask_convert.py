import importlib.util
from pathlib import Path
import unittest

import torch


spec = importlib.util.spec_from_file_location("xzg_image_mask_convert", Path(__file__).resolve().parents[1] / "nodes" / "xzg_image_mask_convert.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
Converter = module.XiaozhuguangImageMaskConvert


class ImageMaskConvertTest(unittest.TestCase):
    def setUp(self):
        self.node = Converter()

    def test_single_input_and_output(self):
        inputs = Converter.INPUT_TYPES()
        # source 为可选输入：未连接图像/遮罩时不报错，输出空值
        self.assertEqual(inputs["optional"]["source"][0], "IMAGE,MASK")
        self.assertNotIn("source", inputs["required"])
        self.assertEqual(len(Converter.RETURN_TYPES), 1)

    def test_image_luminance_and_channels(self):
        image = torch.tensor([[[[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]]]])
        (mask,) = self.node.execute(image)
        torch.testing.assert_close(mask, torch.tensor([[[.299, .587, .114]]]))
        for channel, index in [("红通道", 0), ("绿通道", 1), ("蓝通道", 2)]:
            with self.subTest(channel=channel):
                torch.testing.assert_close(self.node.execute(image, channel)[0], image[..., index])

    def test_mask_batch_with_narrow_width_is_not_mistaken_for_image(self):
        for width in (1, 3, 4, 8):
            mask = torch.rand(2, 5, width)
            (image,) = self.node.execute(mask)
            self.assertEqual(image.shape, (2, 5, width, 3))
            for channel in range(3):
                torch.testing.assert_close(image[..., channel], mask)

    def test_two_dimensional_mask(self):
        mask = torch.rand(5, 7)
        (image,) = self.node.execute(mask)
        self.assertEqual(image.shape, (1, 5, 7, 3))
        torch.testing.assert_close(image[0, ..., 0], mask)

    def test_round_trip_and_grayscale_rgba(self):
        mask = torch.rand(2, 5, 7, dtype=torch.float64)
        image = self.node.execute(mask)[0]
        torch.testing.assert_close(self.node.execute(image)[0], mask)
        self.assertEqual(image.dtype, mask.dtype)
        torch.testing.assert_close(self.node.execute(mask.unsqueeze(-1))[0], mask)
        rgba = torch.cat([image, torch.zeros_like(image[..., :1])], dim=-1)
        torch.testing.assert_close(self.node.execute(rgba)[0], mask)

    def test_absent_and_invalid_input(self):
        self.assertEqual(self.node.execute(None), (None,))
        for value in [torch.rand(5), torch.rand(1, 2, 3, 2), torch.rand(1, 2, 3, 4, 5)]:
            with self.subTest(shape=value.shape), self.assertRaises(ValueError):
                self.node.execute(value)


if __name__ == "__main__":
    unittest.main()
