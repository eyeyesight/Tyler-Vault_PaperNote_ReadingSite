# Tyler-Vault PaperNote Reading Site

Tyler-Vault PaperNote Reading Site 將已核准的論文筆記與知識頁轉成可搜尋、可瀏覽的公開網站。

**[開啟 Reading Site](https://eyeyesight.github.io/Tyler-Vault_PaperNote_ReadingSite/)**

日常 PaperNote 流程在 Telegram 完成，不需要手動執行 build、Git 或 GitHub Pages 指令：

```text
process → decision reply → integrate → publish
```

Zotero annotations 同步是獨立操作，不是上述四步 workflow 的其中一步。

## 日常流程

### 1. 產生候選

```text
/vault_papernote_process
```

系統會讀取待處理的論文筆記、同步必要的 Zotero 資料，並回傳本批次的候選與 decision template。候選以 `A`、`B`、`C`…標示，每篇論文以 `P1`、`P2`…標示。

### 2. 貼回決策

在同一個 Telegram 對話貼上編輯後的 template，不需要額外指令。例如：

```text
Batch: VP-20260813-01
P1 keep: A
P1 rename: B => Knowledge/Concepts/Driving Expertise
P1 merge: C, D => Knowledge/Methods/Vehicle Sensor Synchronization
Unlisted: exclude
```

可用動作包括 `keep`、`rename`、`merge`、`split` 與 `defer`。未列出的候選依 `Unlisted: exclude` 排除，但仍保留決策紀錄。成功時會看到 `Pending integration` 與 `Ready: yes`。

### 3. 正式整合

```text
/vault_papernote_integrate
```

只有這一步會把 pending plan 正式寫入 Tyler-Vault。完成後會回報整合的論文筆記、目標頁與 checkpoint 位置。

### 4. 發布 Reading Site

```text
/vault_papernote_publish
```

系統會先回覆 operation ID，再於背景建立安全的公開版本、更新 GitHub Pages、執行 live verification，並保存最近一次可用版本（LKG）。GitHub Pages 更新可能需要約 2 分鐘傳播；系統會自動等待。

同一筆 publish 重複送出時只會讀回或繼續原 operation，不會建立第二個發布工作。Telegram 最後會顯示以下其中一種結果：

| Terminal status | 代表意思 |
| --- | --- |
| `published` | 網站已更新，live verification 通過。 |
| `no_change` | 核准內容沒有變更，不需要重新部署。 |
| `needs_attention` | 系統已安全停止；依 error code 與 next action 處理。 |

## Zotero annotations 同步

```text
/vault_papernote_zotero
```

這個指令只同步 Zotero annotations 到 Vault 筆記中的 managed section，不會執行整合或發布。若沒有變更，系統會明確回覆 `no change`。

## 結果在哪裡看

- **正式 Markdown**：Tyler-Vault 中已整合的 Literature 與 Knowledge 頁。
- **公開網站**：[Tyler-Vault PaperNote Reading Site](https://eyeyesight.github.io/Tyler-Vault_PaperNote_ReadingSite/)。
- **操作結果**：原 Telegram 對話中的 terminal message。
- **公開內容與 routes**：[`site-content.yml`](site-content.yml)。

公開頁面由 `site-content.yml` 動態產生，沒有固定頁數上限。發布時會自動移除或安全轉換不應公開的 Vault 與 local metadata。

## 初次設定

需要：

- 已連線 Telegram Gateway 的 Hermes Agent。
- Node.js 22+、npm 10.9.2+、Python 3.11+。
- 可讀寫的 Tyler-Vault 工作副本。
- 已設定的 Zotero、Google Workspace、GitHub 與 Pages 權限。

在目前 Hermes profile 啟用 plugin：

```bash
hermes plugins enable vault-paper-workflow --no-allow-tool-override
hermes plugins list
hermes doctor
```

Plugin 載入後，Telegram menu 應提供 `process`、`integrate`、`publish` 與 `zotero` 四個 PaperNote commands。完整設定、secret storage 與 publication diagnostics 請看 [`docs/publication-operations.md`](docs/publication-operations.md)。

## 常見問題

### 沒有待處理論文

確認 Vault 的 `Inbox/Literature Drafts` 是否有符合流程的 draft，以及 Google Drive 工作副本是否為最新。

### Decision reply 沒有建立 pending plan

確認 `Batch: <batch-id>`、至少一條候選動作與 `Unlisted: exclude` 都存在。Batch ID 必須與最近一次 `process` 結果相同。

### Integrate 找不到 pending plan

重新執行 `process`、貼回 decision template，確認收到 `Ready: yes` 後再執行 `integrate`。不要手動建立 pending manifest。

### Publish 回覆 `needs_attention`

這是 terminal state。重新送出同一個 publish command 不代表系統會假設問題已修好；請依 Telegram 顯示的 error code 與 next action 處理。若 next action 要求 manual review，請使用 [publication recovery guide](docs/publication-operations.md#needs_attention-與人工恢復)，不要自行繞過安全狀態。

### 出現 `REMOTE_DRIFT`

遠端 publication state 在操作期間改變，因此系統安全停止。先停止重送，依 [recovery guide](docs/publication-operations.md#remote_drift) 完成人工檢查。

### Reading Site 沒有更新

先確認 terminal result 是 `published`，而不是 `no_change` 或 `needs_attention`。`published` 後可等待約 2 分鐘；若仍未更新，再查看 GitHub Pages deployment 與 [publication diagnostics](docs/publication-operations.md#部署與-live-qa)。

## 文件與開發入口

- 系統資料流、內容投影與安全邊界：[`CONTEXT.md`](CONTEXT.md)
- Publication setup、recovery 與 diagnostics：[`docs/publication-operations.md`](docs/publication-operations.md)
- Quartz、renderer 與本機 preview：[`docs/quartz-toolchain.md`](docs/quartz-toolchain.md)

一般使用者不需要本機 build。修改 renderer 或 publication code 時，先閱讀上述文件與 [`AGENTS.md`](AGENTS.md)，再依變更範圍執行測試。
