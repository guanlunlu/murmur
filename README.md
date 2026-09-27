# Murmur

Murmur 在瀏覽器中擷取音訊，交給本機模型轉成逐字稿；你也可以開啟會議摘要，整理主題、決策、待辦事項與最終會議紀錄。

- **輸入來源：**本機音訊或影片、YouTube 連結、麥克風、系統音，或麥克風加系統音。
- **轉錄方式：**邊播放邊顯示文字，或使用「⚡ 快速轉錄」處理整個檔案。
- **模型執行：**Apple Silicon 使用 MLX；NVIDIA GPU 使用 CUDA。轉錄與摘要都在本機服務執行。載入 YouTube 連結時，服務會從網路下載音訊。

## 開始使用

需要 Python 3.12，以及下列其中一種硬體：

| 你的電腦 | 安裝與啟動說明 | 預設轉錄 | 預設摘要 |
| --- | --- | --- | --- |
| Apple Silicon Mac | [macOS 部署](docs/deployment/mac.md) | MLX | 開啟 |
| NVIDIA GPU，Windows | [NVIDIA 部署：Windows](docs/deployment/nvidia.md#windows-原生) | Transformers CUDA | 關閉 |
| NVIDIA GPU，Linux 或 WSL2 | [NVIDIA 部署：Linux／WSL2](docs/deployment/nvidia.md#linux-或-wsl2) | vLLM 串流 | 關閉 |

依照對應文件安裝並啟動後，開啟 <http://127.0.0.1:8787>。頁面會顯示模型載入狀態；第一次啟動需要下載模型。接著上傳自己的音訊或影片，或選擇收音來源。專案不附示範音檔，因此初始播放器是空的。

**兩種硬體都可以選擇是否開啟會議摘要。**Mac 預設開啟，可加上 `--summary-backend off` 關閉；NVIDIA 預設關閉，可加上 `--summary-backend transformers` 開啟。NVIDIA 開啟摘要後，Linux／WSL2 的預設轉錄後端會改為 Transformers；設定方式與顯存注意事項見 [NVIDIA 部署](docs/deployment/nvidia.md)。

## 使用與技術文件

| 想了解的內容 | 文件 |
| --- | --- |
| 檔案快速轉錄、麥克風／系統音、YouTube 載入 | [音訊來源與轉錄](docs/features/audio.md) |
| 摘要如何更新、保存與產生會議紀錄 | [會議摘要機制](docs/features/meeting-summary.md) |
| 模型選擇、平台限制與啟動參數 | [macOS 部署](docs/deployment/mac.md)、[NVIDIA 部署](docs/deployment/nvidia.md) |
| HTTP 路由與資料格式 | [HTTP API](docs/reference/http-api.md) |
| 程式結構與不載入模型的測試方式 | [開發指南](docs/development.md) |

目前只有 Linux／WSL2 的 vLLM 轉錄後端支援有狀態的即時串流。Mac 與 Windows 仍可顯示即時字幕，但長句可能較慢；詳細差異見部署文件。
