import importlib.util
from pathlib import Path
import unittest
import torch

spec = importlib.util.spec_from_file_location('image_from_list', Path(__file__).resolve().parents[1] / 'nodes/xzg_image_from_list.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ImageFromListTest(unittest.TestCase):
    def test_images_and_masks(self):
        node = module.XiaozhuguangImageFromList()
        for shape in [(4, 5, 3, 3), (4, 5, 3), (4, 5, 1)]:
            source = torch.arange(torch.tensor(shape).prod()).reshape(shape)
            for wrapped in [source, [source[:2], source[2:]], [[source]]]:
                selected = node.get_image(wrapped, [1], [2])[0]
                self.assertEqual(len(selected), 2)
                torch.testing.assert_close(torch.cat(selected), source[1:3])
                batch = node.get_image(wrapped, [1], [2], ['批次'])[0]
                self.assertEqual(len(batch), 1)
                torch.testing.assert_close(batch[0], source[1:3])
            torch.testing.assert_close(node.get_image(source, 99, 9)[0][0], source[-1:])
            torch.testing.assert_close(node.get_image(source, -1, 1)[0][0], source[:1])

    def test_mask_and_variable_sizes(self):
        node = module.XiaozhuguangImageFromList()
        mask = torch.rand(5, 3)
        self.assertEqual(node.get_image(mask, 0, 1)[0][0].shape, (1, 5, 3))
        images = [torch.rand(1, 5, 3, 3), torch.rand(1, 8, 6, 3)]
        self.assertEqual(len(node.get_image(images, 0, 2)[0]), 2)
        with self.assertRaisesRegex(ValueError, '尺寸一致'):
            node.get_image(images, 0, 2, '批次')
        with self.assertRaises(ValueError):
            node.get_image([], 0, 1)

if __name__ == '__main__':
    unittest.main()
