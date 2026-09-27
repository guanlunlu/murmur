<!-- dev-notes: {"id":"20260927T075534Z-refactor-local-deployment-profiles-and-documentation","created_at":"2026-09-27T07:55:34Z","title":"Refactor local deployment profiles and documentation","status":"completed","tags":["cuda","deployment","docs","mlx","summary"],"files":["README.md","backend/deployment.py","backend/llm.py","backend/server.py","docs/deployment/mac.md","docs/deployment/nvidia.md","docs/development.md","docs/features/audio.md","docs/features/meeting-summary.md","docs/reference/http-api.md","tests/test_deployment.py"],"branch":"main","commit":"f6c1fbb"} -->

# Refactor local deployment profiles and documentation

## Outcome
- Added `mac` and `nvidia` deployment profiles with platform-specific ASR and summary defaults. Both routes can enable or disable meeting summaries.
- Added a Transformers CUDA chat runtime for NVIDIA meeting updates and final minutes. On Linux/WSL2, enabling summary defaults ASR to Transformers to reduce vLLM memory contention; explicit vLLM remains possible.
- Replaced the long README with a short user entry point and moved deployment, audio, meeting, API, and development details into six linked documents.

## Decisions and rationale
- Mac defaults to MLX ASR and summary; NVIDIA defaults to summary off. Windows uses Transformers ASR; Linux/WSL2 uses vLLM ASR unless summary is enabled.
- NVIDIA summary defaults to Qwen3-1.7B to reduce GPU memory demand. Its structured output quality and concurrent GPU memory usage require target-hardware verification.
- Preserved the existing single-user vLLM implementation; its session cleanup and inference-lock limitations remain documented.

## Verification
- `python3 -m unittest discover -s tests -t .`: 37 tests passed on macOS.
- Checked all local Markdown links: no broken targets.
- `git diff --check`: passed.
- CUDA model loading and memory behavior were not tested here because this host has no NVIDIA GPU.
