# 會議摘要機制

[返回 README](../../README.md) · [HTTP API](../reference/http-api.md)

會議摘要是可選功能。開啟後，轉錄片段會持續保存，並定期更新目前主題、決策、待辦事項等會議狀態；結束時可產生最終會議紀錄。[macOS](../deployment/mac.md) 與 [NVIDIA](../deployment/nvidia.md) 都能選擇是否啟用摘要，但使用不同的本機模型執行器。

## 更新流程

逐字稿原文會先寫入 SQLite，再排入待處理佇列。當佇列超過 token 門檻或等待時間門檻，系統執行一次摘要更新。每次提供模型的內容包括：

```text
指令 + 舊主題的單行索引 + 目前主題完整內容 + 新逐字稿
```

模型回傳結構化的狀態更新，操作類型為 `continue`、`new_section` 或 `return_to_section`。完成的主題完整存檔，後續提示只保留一行索引；若討論回到先前主題，系統會從封存內容重新載入，不依賴索引描述來重建。這讓提示長度不必隨整場會議持續增加。

超出本次預算的片段會留在佇列中。內容壓縮會明確記錄；若提示仍超出上限，系統回報錯誤，不會默默截斷。模型呼叫失敗或格式不符時，已提交狀態與待處理佇列不會被更新。

結束會議時，系統先處理佇列中的剩餘片段，再由 finalizer 整理會議總結與各主題紀錄。finalizer 的介面不綁定特定模型供應商；目前使用所選的本機摘要模型。

## 保存與恢復

SQLite 保存會議狀態、主題封存以及每段未改寫的逐字稿。服務重啟後，可從最後提交的版本恢復。資料庫預設在 `data/meetings.sqlite3`，可用 `--meeting-db` 或 `MURMUR_MEETING_DB` 指定其他位置。

## 預算與更新頻率

預設每輪應用程式總預算為 3072 tokens，其中 512 tokens 保留給輸出，輸入上限為 2560 tokens。待處理逐字稿達到約 500 tokens，或最長等待 60 秒時，會觸發更新；實際執行還受其他最小片段條件限制。可設定的環境變數定義在 [`backend/meeting/config.py`](../../backend/meeting/config.py)：

| 設定 | 用途 |
| --- | --- |
| `MURMUR_MAX_CONTEXT_TOKENS` | 每輪總預算 |
| `MURMUR_OUTPUT_RESERVE_TOKENS` | 保留給模型輸出的 tokens |
| `MURMUR_MAX_INSTRUCTION_TOKENS` | 指令區塊上限 |
| `MURMUR_MAX_INDEX_TOKENS` | 舊主題索引上限 |
| `MURMUR_MAX_CURRENT_SECTION_TOKENS` | 目前主題上限 |
| `MURMUR_MAX_PENDING_ASR_TOKENS` | 本輪新逐字稿上限 |
| `MURMUR_SAFETY_MARGIN_TOKENS` | 預留安全空間 |
| `MURMUR_ROLLOUT_TRIGGER_TOKENS` | 佇列觸發門檻 |
| `MURMUR_ROLLOUT_MAX_INTERVAL_SECONDS` | 最長等待時間 |
| `MURMUR_ROLLOUT_MIN_TOKENS` | 執行一次更新所需的最少內容 |

頁面的推論資訊區會顯示每輪各區塊的 token 數、模型選擇的操作、壓縮記錄、延遲與重試情況。
