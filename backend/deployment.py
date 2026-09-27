"""Resolve the two supported local deployment profiles before loading models."""

from __future__ import annotations

import sys
from dataclasses import dataclass

from backend.config import DEFAULT_ASR_MODEL, DEFAULT_SUMMARY_MODEL

NVIDIA_ASR_MODEL = "Qwen/Qwen3-ASR-0.6B"
NVIDIA_SUMMARY_MODEL = "Qwen/Qwen3-1.7B"


@dataclass(frozen=True)
class Deployment:
    profile: str
    backend: str
    model: str
    summary_backend: str
    summary_model: str


def resolve_deployment(
    *,
    profile: str | None = None,
    backend: str | None = None,
    model: str | None = None,
    summary_backend: str | None = None,
    summary_model: str | None = None,
    platform: str | None = None,
) -> Deployment:
    platform = platform or sys.platform
    profile = profile or ("mac" if platform == "darwin" else "nvidia")
    if profile not in {"mac", "nvidia"}:
        raise ValueError(f"unknown deployment profile: {profile}")
    if profile == "mac" and platform != "darwin":
        raise ValueError("the mac profile requires Apple Silicon macOS")
    if profile == "nvidia" and platform not in {"linux", "win32"}:
        raise ValueError("the nvidia profile requires Linux, WSL2, or Windows")

    summary_backend = summary_backend or ("mlx" if profile == "mac" else "off")
    default_backend = "mlx" if profile == "mac" else (
        "transformers" if platform == "win32" or summary_backend != "off" else "vllm"
    )
    backend = backend or default_backend
    allowed_backends = {"mlx", "fixture", "fixture-streaming"} if profile == "mac" else {
        "transformers", "fixture", "fixture-streaming"
    }
    if profile == "nvidia" and platform == "linux":
        allowed_backends.add("vllm")
    if backend not in allowed_backends:
        raise ValueError(f"{backend} ASR is unavailable in the {profile} profile on {platform}")

    allowed_summaries = {"mlx", "off", "fixture"} if profile == "mac" else {"transformers", "off", "fixture"}
    if summary_backend not in allowed_summaries:
        raise ValueError(f"{summary_backend} summary is unavailable in the {profile} profile")

    return Deployment(
        profile=profile,
        backend=backend,
        model=model or (DEFAULT_ASR_MODEL if profile == "mac" else NVIDIA_ASR_MODEL),
        summary_backend=summary_backend,
        summary_model=summary_model or (DEFAULT_SUMMARY_MODEL if profile == "mac" else NVIDIA_SUMMARY_MODEL),
    )
