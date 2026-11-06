import importlib.util
import json
from pathlib import Path
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("api_translate", Path(__file__).resolve().parents[1] / "nodes/xzg_api_translate.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class TranslationTest(unittest.TestCase):
    def test_gguf_delegates_to_installed_node(self):
        class Backend:
            @classmethod
            def INPUT_TYPES(cls):
                return {"required": {
                    "model": (["Hy-MT2.gguf"], {"default": "Hy-MT2.gguf"}),
                    "translate_style": (["Default"],),
                    "translate_to": (["Auto", "Japanese"],),
                    "unload_after_run": ("BOOLEAN", {"default": False}),
                }}

        node = m.XiaozhuguangAPITranslate()
        with patch.object(m, "gguf_backend", return_value=Backend), \
                patch.object(Backend, "translate", return_value=("こんにちは",), create=True) as translate, \
                patch.object(m.requests, "post") as post:
            self.assertEqual(node.INPUT_TYPES()["optional"]["gguf_model"][0], ["Hy-MT2.gguf"])
            result = node.translate("Hello", "", "", "", "English", provider=m.GGUF_PROVIDER,
                                    gguf_target="Japanese", gguf_unload=True)
            self.assertEqual(result, ("こんにちは",))
            translate.assert_called_once_with(model="Hy-MT2.gguf", translate_style="Default",
                                              translate_to="Japanese", text="Hello", unload_after_run=True)
            with self.assertRaises(ValueError):
                node.translate("Hello", "", "", "", "English", provider=m.GGUF_PROVIDER,
                               gguf_model="../other.gguf")
            post.assert_not_called()

    def test_provider_presets_and_model_override(self):
        node = m.XiaozhuguangAPITranslate()
        for provider, (address, default_model) in m.PROVIDERS.items():
            if address is None:
                continue
            for model in ("", "my-model"):
                with self.subTest(provider=provider, model=model), patch.object(m.requests, "post") as post:
                    response = post.return_value.__enter__.return_value
                    response.ok = True
                    response.json.return_value = {"choices": [{"message": {"content": "你好"}}]}
                    self.assertEqual(node.translate("Hello", "ignored", "key", model, "简体中文", provider=provider)[0], "你好")
                    self.assertEqual(post.call_args.args[0], address + "/chat/completions")
                    self.assertEqual(post.call_args.kwargs["json"]["model"], model or default_model)

    def test_mixed_language_over_http(self):
        received = {}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                received.update(path=self.path, auth=self.headers.get("Authorization"),
                                body=json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                body = json.dumps({"choices": [{"message": {"content": "保留《作品名》的角色。"},
                                              "finish_reason": "stop"}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            original = "Keep the character from《作品名》.\nKeep paragraphs."
            result = m.XiaozhuguangAPITranslate().translate(
                original, f"http://127.0.0.1:{server.server_port}/v1/", "test-key", "test-model", "简体中文")
            self.assertEqual(result, ("保留《作品名》的角色。",))
            self.assertEqual(received["path"], "/v1/chat/completions")
            self.assertEqual(received["auth"], "Bearer test-key")
            self.assertEqual(received["body"]["messages"][1]["content"], original)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_empty_input_no_request(self):
        with patch.object(m.requests, "post") as post:
            self.assertEqual(m.XiaozhuguangAPITranslate().translate("", "", "", "", "English"), ("",))
            post.assert_not_called()

    def test_failures_do_not_return_original_or_expose_key(self):
        node = m.XiaozhuguangAPITranslate()
        for status, data in [(401, {}), (200, {}), (200, {"choices": [{"message": {"content": "partial"}, "finish_reason": "length"}]})]:
            with self.subTest(status=status, data=data), patch.object(m.requests, "post") as post:
                response = post.return_value.__enter__.return_value
                response.ok = status == 200
                response.status_code = status
                response.json.return_value = data
                with self.assertRaises(RuntimeError) as error:
                    node.translate("Hello 中文", "https://example.com/v1", "secret-key", "model", "简体中文")
                self.assertNotIn("secret-key", str(error.exception))


if __name__ == "__main__":
    unittest.main()
