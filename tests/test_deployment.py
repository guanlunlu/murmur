import contextlib
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from backend.deployment import resolve_deployment
from backend.llm import TransformersChatLLM


class DeploymentTest(unittest.TestCase):
    def test_mac_defaults_and_summary_toggle(self):
        default = resolve_deployment(platform="darwin")
        self.assertEqual((default.backend, default.summary_backend), ("mlx", "mlx"))
        self.assertEqual(resolve_deployment(platform="darwin", summary_backend="off").summary_backend, "off")

    def test_nvidia_linux_selects_asr_for_summary_choice(self):
        asr_only = resolve_deployment(platform="linux")
        self.assertEqual((asr_only.backend, asr_only.summary_backend), ("vllm", "off"))
        with_summary = resolve_deployment(platform="linux", summary_backend="transformers")
        self.assertEqual((with_summary.backend, with_summary.summary_backend), ("transformers", "transformers"))
        self.assertEqual(with_summary.summary_model, "Qwen/Qwen3-1.7B")
        explicit_streaming = resolve_deployment(
            platform="linux", backend="vllm", summary_backend="transformers"
        )
        self.assertEqual(explicit_streaming.backend, "vllm")

    def test_nvidia_windows_and_incompatible_backends(self):
        self.assertEqual(resolve_deployment(platform="win32").backend, "transformers")
        with self.assertRaisesRegex(ValueError, "unavailable"):
            resolve_deployment(platform="win32", backend="vllm")
        with self.assertRaisesRegex(ValueError, "unavailable"):
            resolve_deployment(platform="linux", summary_backend="mlx")


class TransformersSummaryTest(unittest.TestCase):
    def test_chat_decodes_only_new_tokens_without_thinking(self):
        llm = TransformersChatLLM.__new__(TransformersChatLLM)
        input_ids = Mock()
        input_ids.shape = (1, 3)
        input_ids.to.return_value = input_ids
        llm.tokenizer = Mock()
        llm.tokenizer.apply_chat_template.return_value = input_ids
        llm.tokenizer.decode.return_value = '{"operation":"continue"}'
        llm.model = Mock(device="cuda:0")
        llm.model.generate.return_value = [[1, 2, 3, 4, 5]]
        llm._torch = SimpleNamespace(inference_mode=contextlib.nullcontext)
        llm._lock = contextlib.nullcontext()

        self.assertEqual(llm.chat([{"role": "user", "content": "test"}], 512), '{"operation":"continue"}')
        self.assertEqual(llm.tokenizer.decode.call_args.args[0], [4, 5])
        self.assertFalse(llm.tokenizer.apply_chat_template.call_args.kwargs["enable_thinking"])
        self.assertEqual(llm.model.generate.call_args.kwargs["max_new_tokens"], 512)


if __name__ == "__main__":
    unittest.main()
