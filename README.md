# Murmur realtime transcript

Murmur captures audio in the browser, sends voice-activity-gated 16 kHz PCM chunks
(roughly 1-16 seconds, cut at natural pauses) to a local inference service, and appends
each Qwen3-ASR result to the transcript panel. Audio never leaves the machine as a file.
The source can be a played media file (local MP3, other browser-supported audio,
browser-supported video, or YouTube audio) or a **live audio device** — see 收音來源 below.

No demo clip ships with this repository, so the page starts with an empty player: upload
your own audio/video or paste a YouTube link to begin.

## 快速轉錄

載入音訊或影片後，可按 `⚡ 快速轉錄`，不播放聲音便直接解碼整個檔案並送往本機 ASR。它會顯示目前進度，也可以再次按下按鈕停止。

- `vLLM streaming CUDA`：以 stateful streaming session 處理，每段最多 25 秒。
- 其他 backend（例如 Transformers CUDA）：沿用既有 `/api/transcribe`，每段最多 10 秒。

Transcript segments then feed a **bounded meeting state** instead of an ever-growing
rolling summary. Raw ASR is stored verbatim and queued; once the queue crosses a token or
time threshold, one rollout sends a fixed-size prompt to the local 8B model:

```
instructions + one-line index of earlier topics + the full current topic + new transcript
```

The model answers with a structured state update classified as `continue`, `new_section`
or `return_to_section`. Finished topics are archived in full and represented in later
prompts by a single index line, so a three-hour meeting costs the same context as a
three-minute one. Returning to an earlier topic reloads that topic from the archive — it
is never reconstructed from its index descriptor. Nothing is silently truncated: segments
that do not fit stay queued, compaction is explicit and reported, and a prompt that still
does not fit raises instead of being cut. A failed or malformed model response leaves both
the committed state and the pending queue untouched.

State, the section archive and every raw ASR segment live in a SQLite file, so a restart
resumes from the last committed version. At the end of a meeting the pending queue is
flushed and a provider-neutral finalizer produces the actual minutes; today it runs on the
local model, and a larger API model can be dropped in behind the same interface.

## Platform support

Murmur runs on Apple Silicon and on NVIDIA GPUs, but the two are **not** feature-equivalent.
Pick a row by the hardware you have, then read the limitations below — they decide which
half of the product you actually get.

| | Apple Silicon | NVIDIA, native Windows | NVIDIA, Linux or WSL2 |
| --- | --- | --- | --- |
| `--backend` | `mlx` | `transformers` | `vllm` |
| Runtime | MLX / Metal | Qwen `transformers` + CUDA | Qwen `transformers` + vLLM |
| Default ASR model | `mlx-community/Qwen3-ASR-1.7B-8bit` | `Qwen/Qwen3-ASR-0.6B` | `Qwen/Qwen3-ASR-0.6B` |
| Live caption | re-transcribes the pending utterance | re-transcribes the pending utterance | **stateful streaming** |
| Meeting summary / minutes | **yes** | no | no |
| `/api/health` `streaming` | `false` | `false` | `true` |

### What each platform gives up

**NVIDIA has no meeting summary.** The bounded meeting state, the section archive and the
finalizer all run through `backend/llm.py`, whose only real runtime is `MLXChatLLM`. Both
CUDA paths therefore require `--summary-backend off`, and the footer will correctly report
摘要功能已停用. You get live transcription and the raw transcript, not minutes. Running
without that flag on a non-Apple machine fails at model load rather than falling back.

**Apple Silicon has no stateful streaming.** `MLXQwenBackend` exposes no `streaming`
attribute, so `/api/health` reports `streaming: false` and the browser falls back to
`queueProvisional()`: while you are still speaking, it re-transcribes the *entire growing
buffer* every few seconds. It works and the final per-utterance text is unaffected, but the
work grows with the square of the utterance length, so the caption lags noticeably on long
sentences. Only the `vllm` backend keeps a persistent KV cache and decodes one second at a
time.

**vLLM wants the GPU to itself.** It pre-reserves `--vllm-gpu-memory-utilization` (default
0.75) of VRAM at startup. On a Windows machine with WSL2, stop the native Windows service
before starting the WSL one.

**Two known defects in the vLLM backend**, neither yet fixed. They only bite with
concurrent streams or a long-lived server, which is why single-user testing passes:
`VllmStreamingBackend._sessions` has no idle timeout, so a browser tab closed without
`finish`/`abort` leaks a session and its KV cache; and `push_stream` holds its lock across
the whole GPU inference, so concurrent streams fully serialize.

## Backend layout

The backend is split by concern instead of living in one file:

| Module | Responsibility |
| --- | --- |
| `backend/config.py` | Paths, sample rate, request-size limits, default model names |
| `backend/asr.py` | `ASRBackend` protocol, MLX / Transformers / vLLM / fixture backends, load state |
| `backend/llm.py` | Chat runtimes (MLX, scripted) and background load state |
| `backend/meeting/` | Bounded meeting memory: models, budget, context builder, engine, store, finalizer |
| `backend/media.py` | YouTube allow-list and `yt-dlp` audio fetcher |
| `backend/http_app.py` | HTTP handler, routes, `create_server` |
| `backend/server.py` | CLI entry point only |

## Run on Apple Silicon

This is the only configuration with meeting summaries. The page reports ASR and summary
model readiness independently while they load. Install the language-model runtime once:

```bash
~/.pyenv/versions/murmur-qwen-asr-mlx/bin/pip install mlx-lm
```

```bash
~/.pyenv/versions/murmur-qwen-asr-mlx/bin/python backend/server.py
```

Then open <http://127.0.0.1:8787>. Keep the terminal open while testing. The first normal
startup downloads the configured MLX summary weights into the Hugging Face cache.

Optional configuration:

```bash
MURMUR_ASR_MODEL=mlx-community/Qwen3-ASR-1.7B-8bit \
MURMUR_SUMMARY_MODEL=Qwen/Qwen3-8B-MLX-4bit \
  ~/.pyenv/versions/murmur-qwen-asr-mlx/bin/python backend/server.py --port 8787
```

Budgets and rollout policy are configuration, not constants in the code. The defaults keep
each rollout inside a 3072-token application budget (2560 input, 512 reserved for output)
and can be overridden per run:

```bash
MURMUR_MAX_CONTEXT_TOKENS=3072 MURMUR_ROLLOUT_TRIGGER_TOKENS=500 \
MURMUR_ROLLOUT_MAX_INTERVAL_SECONDS=60 MURMUR_MEETING_DB=data/meetings.sqlite3 \
  ~/.pyenv/versions/murmur-qwen-asr-mlx/bin/python backend/server.py
```

## Run ASR only on Windows with NVIDIA CUDA

The Windows backend uses the official `qwen-asr` Transformers runtime. It deliberately
disables meeting summaries, so no Apple-only MLX model is loaded. An NVIDIA GPU with CUDA
support is required.

Create a clean virtual environment, then install CUDA-enabled PyTorch before the ASR
package. This example uses CUDA 12.6 wheels:

```powershell
python -m venv .venv-qwen-asr
.\.venv-qwen-asr\Scripts\python.exe -m pip install --upgrade pip
.\.venv-qwen-asr\Scripts\python.exe -m pip install torch==2.7.1+cu126 --index-url https://download.pytorch.org/whl/cu126
.\.venv-qwen-asr\Scripts\python.exe -m pip install qwen-asr numpy
```

Start with the smaller Qwen model, which downloads automatically on its first run:

```powershell
.\.venv-qwen-asr\Scripts\python.exe backend\server.py --backend transformers --model Qwen/Qwen3-ASR-0.6B --summary-backend off
```

Then open <http://127.0.0.1:8787>. The service health endpoint should show
`Qwen/Qwen3-ASR-0.6B · Transformers CUDA`. On the tested RTX 3060 Ti (8 GB), this model
used about 3.2 GB VRAM and transcribed five seconds of Chinese audio in 2.31 seconds.

## Run stateful streaming ASR on Linux

Qwen's official streaming mode uses vLLM, which runs on Linux rather than native Windows.
Native Ubuntu with an NVIDIA GPU is the straightforward host. On a Windows machine, use
WSL2 instead and keep the Windows Transformers service stopped so vLLM has exclusive
access to the GPU.

```bash
python3 -m venv ~/.venvs/murmur-qwen-vllm
~/.venvs/murmur-qwen-vllm/bin/pip install --upgrade pip
~/.venvs/murmur-qwen-vllm/bin/pip install 'qwen-asr[vllm]' yt-dlp
```

```bash
~/.venvs/murmur-qwen-vllm/bin/python backend/server.py \
  --port 8788 --backend vllm --model Qwen/Qwen3-ASR-0.6B --summary-backend off \
  --vllm-gpu-memory-utilization 0.75 --vllm-max-model-len 4096
```

Under WSL2, start from the WSL view of your Windows checkout
(`cd /mnt/<drive>/path/to/murmur`).

The browser then uses <http://127.0.0.1:8788>. When the health response exposes
`streaming: true`, it sends new one-second PCM audio to one stateful Qwen session. The model
manages its own rolling text and token rollback; at a natural pause the browser calls
`finish` and commits the final segment.

## HTTP API

The chunk endpoint accepts mono little-endian Float32 PCM at 16 kHz, up to 30 seconds per
request.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | ASR and summary model state, `streaming` capability, context budget |
| `POST /api/transcribe` | One audio chunk in, one transcript segment out |
| `POST /api/streams` | Open a stateful streaming session; streaming backends only |
| `POST /api/streams/{id}/chunk` | Push one second of audio, get the rolling text back |
| `POST /api/streams/{id}/finish` | Flush the tail and commit the final segment |
| `POST /api/streams/{id}/abort` | Discard the session |
| `POST /api/meetings` | Start a meeting, returns its id |
| `POST /api/meetings/{id}/segments` | Append ASR segments; they are stored and queued |
| `POST /api/meetings/{id}/rollout` | Force one rollout now |
| `POST /api/meetings/{id}/auto` | Pause or resume automatic rollouts (segments keep queueing) |
| `POST /api/meetings/{id}/finalize` | Flush the queue, then consolidate the minutes |
| `GET /api/meetings/{id}/state` | Current topic, index, pending queue and rollout metrics |
| `GET /api/meetings/{id}/transcript` | Every raw ASR segment, verbatim |

Rollout metrics feed the inference debug panel: per-block token counts, the operation the
model chose, any compaction that was applied, latency and retries.

## Capture from an audio device

The 收音來源 selector above the transport switches what the VAD listens to. Every mode
feeds the same chunking, `/api/transcribe` call and meeting-state pipeline; only the clock
and the gate differ.

| Mode | Source | Notes |
| --- | --- | --- |
| 播放檔案 | The `<audio>`/`<video>` element | Seekable; timestamps come from `currentTime` |
| 麥克風 | `getUserMedia` on the selected input | Device list is populated from `enumerateDevices` |
| 系統音／會議音 | `getDisplayMedia`, video track dropped | Tick "share tab/system audio" in the share dialog |
| 麥克風＋系統音 | Both of the above, mixed to mono | For two-way meetings |

A live source has no seekable timeline, so timestamps come from an elapsed-seconds session
clock; the timeline and mute controls are disabled and the duration reads `LIVE`. Changing
the input device mid-session keeps the clock running, so the transcript stays continuous.
Live input is never routed back to the speakers — monitoring a microphone would feed the
room into itself.

Browser audio conditioning (AGC, noise suppression, echo cancellation) is switched off:
AGC distorts the RMS gate, and echo cancellation would strip the far end out of a mixed
capture. Because system audio swings much more than a close microphone, the gate rides a
slowly tracked noise floor on top of a per-mode base threshold, and the level meter under
the selector shows what the gate currently sees.

On macOS a virtual input device such as BlackHole also works: select it under 輸入裝置 in
麥克風 mode and route the meeting app's output to it.

## Test against a YouTube video

Paste a YouTube link into the topbar field and press 載入 instead of uploading a local
file. The backend downloads audio-only via `yt-dlp` into `dist/uploads/` (gitignored,
cached by video id) and serves it back to the page as a same-origin file, which then
flows through the exact same capture/VAD/inference pipeline as a local upload. Only
`youtube.com`/`youtu.be` links are accepted.

Requires `yt-dlp` in the same environment that runs the backend:

```bash
~/.pyenv/versions/murmur-qwen-asr-mlx/bin/pip install yt-dlp
```

Downloading requires internet access, and is subject to YouTube's Terms of Service —
this is intended for local, personal testing of the transcription pipeline, not for
redistributing downloaded audio.

## Smoke test without loading a model

```bash
python -m unittest discover -s tests -t .
```

The `fixture` and `fixture-streaming` backends exercise the chunked and streaming request
paths respectively without any GPU or downloaded weights, which is what the test suite
uses. The deployed static prototype also remains useful as a UI preview, but realtime
inference must be run through a local server.
