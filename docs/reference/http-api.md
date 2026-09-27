# HTTP API

[返回 README](../../README.md) · [會議摘要機制](../features/meeting-summary.md)

後端預設監聽 `127.0.0.1:8787`，同時提供瀏覽器頁面與下列 API。所有音訊端點使用單聲道、16 kHz、小端序 Float32 PCM，`Content-Type` 為 `application/octet-stream`。每次請求最多 30 秒；一般音訊請求至少 1 秒，串流 `finish` 可以送空音訊。

## 狀態與媒體

| 方法與路徑 | 用途 |
| --- | --- |
| `GET /api/health` | 轉錄及摘要模型狀態、模型名稱、`streaming` 能力與摘要預算 |
| `POST /api/fetch-media` | 接收 JSON `{"url":"..."}`，取得 YouTube 音訊與標題；只接受 YouTube 網域 |

模型在背景載入時，`/api/health` 會顯示 `loading`；載入成功為 `ready`，失敗為 `error`。摘要未啟用時，其狀態為 `disabled`。

## 轉錄

| 方法與路徑 | 用途 |
| --- | --- |
| `POST /api/transcribe` | 送入一段 PCM，取得文字、語言、時間範圍與推論耗時 |
| `POST /api/streams` | 建立有狀態轉錄 session；僅串流後端可用 |
| `POST /api/streams/{id}/chunk` | 送入新的 PCM，取得持續更新的文字 |
| `POST /api/streams/{id}/finish` | 結束 session，提交最終文字 |
| `POST /api/streams/{id}/abort` | 丟棄 session |

`/api/transcribe` 可用 `X-Audio-Start`、`X-Audio-End` 指定片段在媒體中的秒數，用 `X-Language` 指定語言；語言預設為 `Chinese`。回應包含 `text`、`language`、`start`、`end`、`audio_seconds`、`context_samples`、`inference_seconds`。

`POST /api/streams` 回傳 `stream_id`。後續 `chunk` 與 `finish` 回應包含 `text`、`language`、`inference_seconds`。非串流後端的建立請求會回報 `streaming_not_ready`。

## 會議

| 方法與路徑 | 用途 |
| --- | --- |
| `POST /api/meetings` | 建立會議，回傳 `meeting_id` 與初始狀態 |
| `POST /api/meetings/{id}/segments` | 以 JSON 的 `segments` 陣列加入逐字稿 |
| `POST /api/meetings/{id}/rollout` | 立即執行一次摘要更新 |
| `POST /api/meetings/{id}/auto` | 以 JSON `{"enabled":true/false}` 切換自動更新 |
| `POST /api/meetings/{id}/finalize` | 處理剩餘片段並產生最終會議紀錄 |
| `GET /api/meetings/{id}/state` | 目前主題、索引、待處理佇列與最近更新指標 |
| `GET /api/meetings/{id}/transcript` | 所有原始逐字稿片段 |

`segments` 中每個項目需要 `segment_id` 與 `text`，也可包含 `started_at`、`ended_at`、`speaker_id`。暫停自動更新只會停止排程，後續片段仍會保存並排隊。`state` 中的 `rollouts` 提供 token 使用量、操作、壓縮、耗時及重試資訊，供頁面的推論資訊區顯示。
