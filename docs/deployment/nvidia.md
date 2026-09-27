# 在 NVIDIA GPU 上執行

[返回 README](../../README.md) · [macOS 部署](mac.md)

NVIDIA 路線需要支援 CUDA 的 GPU。Windows 原生使用 Transformers 轉錄；Linux 或 WSL2 預設使用 vLLM 有狀態串流。兩種環境都可以選擇是否開啟會議摘要。

| 環境 | 預設轉錄後端 | 摘要開啟時的預設轉錄後端 | 摘要後端 |
| --- | --- | --- | --- |
| Windows 原生 | Transformers CUDA | Transformers CUDA | Transformers CUDA |
| Linux／WSL2 | vLLM CUDA | Transformers CUDA | Transformers CUDA |

轉錄模型預設為 `Qwen/Qwen3-ASR-0.6B`。摘要預設關閉；用 `--summary-backend transformers` 開啟後，摘要模型預設為 `Qwen/Qwen3-1.7B`。這個較小的摘要模型仍須用自己的會議內容檢查結構化輸出品質。可用 `--model`、`--summary-model` 分別換模型。

## Windows 原生

建立 Python 虛擬環境，先安裝與驅動程式相容的 CUDA PyTorch，再安裝其餘套件。以下是先前使用過的 CUDA 12.6 wheel 組合：

```powershell
python -m venv .venv-qwen-asr
.\.venv-qwen-asr\Scripts\python.exe -m pip install --upgrade pip
.\.venv-qwen-asr\Scripts\python.exe -m pip install torch==2.7.1+cu126 --index-url https://download.pytorch.org/whl/cu126
.\.venv-qwen-asr\Scripts\python.exe -m pip install qwen-asr numpy transformers accelerate yt-dlp
```

只做轉錄：

```powershell
.\.venv-qwen-asr\Scripts\python.exe backend\server.py --profile nvidia
```

要開啟摘要，停止前一個服務，再以此指令啟動：

```powershell
.\.venv-qwen-asr\Scripts\python.exe backend\server.py --profile nvidia --summary-backend transformers
```

開啟 <http://127.0.0.1:8787>。`/api/health` 的轉錄模型名稱應顯示 `Qwen/Qwen3-ASR-0.6B · Transformers CUDA`。先前在 RTX 3060 Ti（8 GB）上，只開啟 ASR 時約使用 3.2 GB 顯存，五秒中文音訊的轉錄時間為 2.31 秒；這不是同時開啟摘要的效能數據。

Windows 原生不支援這個專案的 vLLM 串流路線。如需該路線，請使用 Linux 或 WSL2。

## Linux 或 WSL2

在專案根目錄建立 Python 3.12 環境：

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install transformers accelerate yt-dlp
```

**有狀態串流轉錄，摘要關閉：**

```bash
.venv/bin/python -m pip install 'qwen-asr[vllm]'
.venv/bin/python backend/server.py --profile nvidia
```

**轉錄加會議摘要：**這組設定使用 Transformers ASR，減少與摘要模型同時佔用顯存時的衝突。

```bash
.venv/bin/python -m pip install qwen-asr
.venv/bin/python backend/server.py --profile nvidia --summary-backend transformers
```

開啟 <http://127.0.0.1:8787>。vLLM 就緒時，`/api/health` 的 `streaming` 為 `true`，瀏覽器會把一秒長的音訊逐段送入同一個串流 session，並在停頓時提交最終文字。Transformers ASR 的 `streaming` 為 `false`，瀏覽器改用非串流轉錄。

在 Windows 電腦上使用 WSL2 時，從 WSL 路徑進入專案（例如 `cd /mnt/<drive>/path/to/murmur`）；同一張 GPU 上的 Windows 原生服務應先停止。

## 顯存與後端選擇

摘要模型與轉錄模型會同時留在 GPU 記憶體。若無法一起載入，請選較小的 `--summary-model`、使用顯存較大的 GPU，或以 `--summary-backend off` 執行。模型載入失敗會顯示在 `/api/health`，不會自動切換後端。

Linux 預設在開啟摘要時改用 Transformers ASR。你仍可明確指定 `--backend vllm --summary-backend transformers`，但 vLLM 啟動時會預留 `--vllm-gpu-memory-utilization` 指定比例的顯存（預設 0.75）；需要替摘要模型留下足夠空間。`--vllm-max-model-len` 預設為 4096。

兩項 vLLM 已知限制與長時間、多使用者執行有關：未正常 `finish`／`abort` 的 session 沒有閒置逾時清理；`push_stream` 會在整段 GPU 推論期間持有鎖，讓並行串流序列化。

## 設定方式

啟動參數可用環境變數指定：`MURMUR_PROFILE`、`MURMUR_ASR_BACKEND`、`MURMUR_ASR_MODEL`、`MURMUR_SUMMARY_BACKEND`、`MURMUR_SUMMARY_MODEL`、`MURMUR_VLLM_GPU_MEMORY_UTILIZATION`、`MURMUR_VLLM_MAX_MODEL_LEN`。命令列旗標優先於環境變數。服務啟動時會列出選定的 profile 與後端；`/api/health` 會回報模型狀態與名稱。
