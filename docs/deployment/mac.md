# 在 Apple Silicon Mac 上執行

[返回 README](../../README.md) · [NVIDIA 部署](nvidia.md)

Mac 使用 MLX／Metal 在本機執行 Qwen3-ASR；會議摘要預設開啟。需要 Apple Silicon 與 Python 3.12。

## 安裝與啟動

在專案根目錄執行：

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install numpy mlx-audio mlx-lm yt-dlp
.venv/bin/python backend/server.py --profile mac
```

開啟 <http://127.0.0.1:8787>，等待頁面顯示轉錄與摘要模型已就緒。第一次啟動會將所需權重下載到 Hugging Face 快取。測試時保持終端機開啟。

## 選擇摘要模式

| 需求 | 啟動參數 |
| --- | --- |
| 轉錄並產生會議摘要、紀錄（預設） | `--profile mac` |
| 只要逐字稿 | `--profile mac --summary-backend off` |

例如只做轉錄：

```bash
.venv/bin/python backend/server.py --profile mac --summary-backend off
```

轉錄模型預設為 `mlx-community/Qwen3-ASR-1.7B-8bit`；摘要模型預設為 `Qwen/Qwen3-8B-MLX-4bit`。可分別用 `--model` 和 `--summary-model` 換成相容模型，或透過 `MURMUR_ASR_MODEL`、`MURMUR_SUMMARY_MODEL` 設定。

`/api/health` 會分別回報轉錄與摘要模型的載入狀態。摘要關閉時，狀態為 `disabled`。

## 會議狀態設定

預設每次摘要更新的應用程式預算為 3072 tokens，其中輸入最多 2560 tokens、輸出保留 512 tokens。可用環境變數調整資料庫與更新頻率：

```bash
MURMUR_MAX_CONTEXT_TOKENS=3072 MURMUR_ROLLOUT_TRIGGER_TOKENS=500 \
MURMUR_ROLLOUT_MAX_INTERVAL_SECONDS=60 MURMUR_MEETING_DB=data/meetings.sqlite3 \
  .venv/bin/python backend/server.py --profile mac
```

各項預算的用途見[會議摘要機制](../features/meeting-summary.md)。

## 即時字幕的限制

MLX ASR 沒有有狀態的串流介面；`/api/health` 的 `streaming` 為 `false`。說話期間，瀏覽器會每隔幾秒重轉錄目前尚未結束的語句，所以長句的暫時字幕可能變慢。語句結束後仍會取得最後的逐字稿結果。
