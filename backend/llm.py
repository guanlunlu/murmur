"""Chat-completion runtimes used by the meeting-state updater and the finalizer."""

from __future__ import annotations

import threading
import time
from typing import Protocol


class ChatLLM(Protocol):
    name: str

    def chat(self, messages: list[dict[str, str]], max_tokens: int) -> str: ...

    def count_tokens(self, text: str) -> int | None: ...


class MLXChatLLM:
    """Local MLX model; one generation at a time, matching the single-process GPU."""

    def __init__(self, model_name: str):
        from mlx_lm import generate, load

        self.name = f"{model_name} · MLX"
        self.model, self.tokenizer = load(model_name)
        self._generate = generate
        self._lock = threading.Lock()

    def chat(self, messages: list[dict[str, str]], max_tokens: int) -> str:
        prompt = self.tokenizer.apply_chat_template(
            messages,
            add_generation_prompt=True,
            enable_thinking=False,
        )
        with self._lock:
            response = self._generate(
                self.model,
                self.tokenizer,
                prompt=prompt,
                max_tokens=max_tokens,
                verbose=False,
            )
        text = str(response).strip()
        if "</think>" in text:
            text = text.split("</think>", 1)[1].strip()
        return text

    def count_tokens(self, text: str) -> int | None:
        try:
            return len(self.tokenizer.encode(text))
        except (AttributeError, TypeError, ValueError):
            return None


class TransformersChatLLM:
    """Local CUDA chat model for meeting updates and final minutes."""

    def __init__(self, model_name: str):
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is required for the transformers summary backend")
        self.name = f"{model_name} · Transformers CUDA"
        self.tokenizer = AutoTokenizer.from_pretrained(model_name)
        self.model = AutoModelForCausalLM.from_pretrained(
            model_name,
            torch_dtype=torch.float16,
            device_map="cuda:0",
        )
        self._torch = torch
        self._lock = threading.Lock()

    def chat(self, messages: list[dict[str, str]], max_tokens: int) -> str:
        input_ids = self.tokenizer.apply_chat_template(
            messages,
            tokenize=True,
            return_tensors="pt",
            add_generation_prompt=True,
            enable_thinking=False,
        ).to(self.model.device)
        with self._lock, self._torch.inference_mode():
            generated = self.model.generate(
                input_ids,
                max_new_tokens=max_tokens,
                do_sample=False,
            )
        response_ids = generated[0][input_ids.shape[-1]:]
        text = self.tokenizer.decode(response_ids, skip_special_tokens=True).strip()
        if "</think>" in text:
            text = text.split("</think>", 1)[1].strip()
        return text

    def count_tokens(self, text: str) -> int | None:
        try:
            return len(self.tokenizer.encode(text))
        except (AttributeError, TypeError, ValueError):
            return None


class ScriptedChatLLM:
    """Deterministic runtime for tests: replies come from a queue or a callable."""

    name = "fixture-llm"

    def __init__(self, responses=None):
        self._responses = list(responses or [])
        self.calls: list[list[dict[str, str]]] = []

    def chat(self, messages: list[dict[str, str]], max_tokens: int) -> str:
        self.calls.append(messages)
        if not self._responses:
            raise RuntimeError("ScriptedChatLLM ran out of responses")
        response = self._responses.pop(0)
        if callable(response):
            response = response(messages)
        if isinstance(response, Exception):
            raise response
        return str(response)

    def count_tokens(self, text: str) -> int | None:
        return None


class LLMState:
    """Tracks background loading of a chat runtime so the UI can show progress."""

    def __init__(self, label: str = "summary"):
        self.label = label
        self.llm: ChatLLM | None = None
        self.status = "loading"
        self.error: str | None = None
        self.loaded_at: float | None = None
        self._lock = threading.Lock()

    def load(self, backend_name: str, model_name: str) -> None:
        if backend_name == "off":
            with self._lock:
                self.llm = None
                self.status = "disabled"
                self.error = None
                self.loaded_at = None
            return
        try:
            if backend_name == "fixture":
                llm: ChatLLM = ScriptedChatLLM()
            elif backend_name == "transformers":
                llm = TransformersChatLLM(model_name)
            elif backend_name == "mlx":
                llm = MLXChatLLM(model_name)
            else:
                raise ValueError(f"unknown summary backend: {backend_name}")
            with self._lock:
                self.llm = llm
                self.status = "ready"
                self.loaded_at = time.time()
        except Exception as exc:
            with self._lock:
                self.status = "error"
                self.error = f"{type(exc).__name__}: {exc}"

    def adopt(self, llm: ChatLLM) -> None:
        with self._lock:
            self.llm = llm
            self.status = "ready"
            self.loaded_at = time.time()

    def snapshot(self) -> dict[str, object]:
        with self._lock:
            return {
                "status": self.status,
                "model": self.llm.name if self.llm else None,
                "error": self.error,
            }
