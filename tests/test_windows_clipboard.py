import importlib.util
from pathlib import Path
import struct
from types import SimpleNamespace
import unittest

from PIL import Image

path = Path(__file__).resolve().parents[1] / "xzg_windows_clipboard.py"
spec = importlib.util.spec_from_file_location("xzg_clipboard_test", path)
clipboard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(clipboard)


class ClipboardTests(unittest.TestCase):
    def test_straight_alpha_and_top_down_pixels(self):
        image = Image.new("RGBA", (1, 3))
        image.putdata([(200, 100, 50, 128), (7, 8, 9, 0), (255, 0, 0, 255)])
        data = clipboard.make_dibv5(image)
        self.assertEqual(struct.unpack_from("<IiiHHII", data), (124, 1, -3, 1, 32, 3, 12))
        self.assertEqual(struct.unpack_from("<IIIII", data, 40),
                         (0xFF0000, 0xFF00, 0xFF, 0xFF000000, 0x73524742))
        # Half-transparent colors must NOT be multiplied by 128/255.
        self.assertEqual(data[124:], bytes([50, 100, 200, 128, 9, 8, 7, 0, 0, 0, 255, 255]))

    def test_local_same_origin_only(self):
        for host, remote in [("localhost:8188", "127.0.0.1"), ("[::1]:8188", "::1")]:
            request = SimpleNamespace(host=host, remote=remote, headers={"Origin": f"http://{host}"})
            self.assertTrue(clipboard.is_local_clipboard_request(request))
        for host, remote, origin in [
            ("localhost:8188", "192.168.1.2", "http://localhost:8188"),
            ("localhost:8188", "127.0.0.1", "http://evil.example"),
            ("localhost:8188", "127.0.0.1", ""),
            ("example.com:8188", "127.0.0.1", "http://example.com:8188"),
            ("localhost:8188", None, "http://localhost:8188"),
        ]:
            request = SimpleNamespace(host=host, remote=remote, headers={"Origin": origin})
            self.assertFalse(clipboard.is_local_clipboard_request(request))


if __name__ == "__main__":
    unittest.main()
