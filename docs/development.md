# 開發指南

[返回 README](../README.md) · [HTTP API](reference/http-api.md)

## 程式結構

| 位置 | 責任 |
| --- | --- |
| `dist/` | 瀏覽器頁面與前端程式 |
| `backend/config.py` | 路徑、取樣率、請求大小限制與模型常數 |
| `backend/deployment.py` | `mac`／`nvidia` 部署預設值與相容性檢查 |
| `backend/asr.py` | MLX、Transformers、vLLM 與測試轉錄後端；載入狀態 |
| `backend/llm.py` | MLX、Transformers CUDA 與測試摘要後端；載入狀態 |
| `backend/meeting/` | 會議狀態、提示預算、主題封存、排程、SQLite 與 finalizer |
| `backend/media.py` | YouTube 網域限制與 `yt-dlp` 音訊下載 |
| `backend/http_app.py` | HTTP 路由及伺服器建立 |
| `backend/server.py` | 命令列入口，負責載入模型與啟動服務 |
| `tests/` | 不下載模型的自動化測試 |

詳細資料流程見[音訊來源與轉錄](features/audio.md)及[會議摘要機制](features/meeting-summary.md)。

## 測試

在已安裝測試所需 Python 套件的環境中，從專案根目錄執行：

```bash
python -m unittest discover -s tests -t .
```

測試使用 `fixture` 與 `fixture-streaming` 後端，分別覆蓋分段及串流 HTTP 路線，不需 GPU 或模型權重。HTTP 測試會綁定本機埠。

`dist/` 的靜態頁面可用於 UI 預覽；即時轉錄必須透過本機後端服務。部署及模型選擇方式見 [macOS](deployment/mac.md) 或 [NVIDIA](deployment/nvidia.md) 文件。
