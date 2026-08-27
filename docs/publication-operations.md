# Publication operations and recovery

本文件供維護 Tyler-Vault PaperNote Reading Site 的 operator 使用。一般 PaperNote 操作請看 [`README.md`](../README.md)；資料流、內容投影與安全邊界請看 [`CONTEXT.md`](../CONTEXT.md)。

## 初次設定

### 需求

- 已連線 Telegram Gateway 的 Hermes Agent。
- Node.js 22+、npm 10.9.2+、Python 3.11+。
- 可讀寫的 Tyler-Vault 工作副本。
- Zotero 與 Google Workspace 存取。
- 目標 GitHub repository 與 Pages 的必要權限。

在目前 Hermes profile 啟用 plugin：

```bash
hermes plugins enable vault-paper-workflow --no-allow-tool-override
hermes plugins list
hermes doctor
```

Plugin 不需要覆寫 Hermes 內建 tools。Gateway 載入後，Telegram menu 應提供：

```text
/vault_papernote_process
/vault_papernote_integrate
/vault_papernote_publish
/vault_papernote_zotero
```

Runtime settings 需為四個 commands 提供 bounded argv、working directory 與 timeout。路徑和非秘密設定放在目前 profile 的 runtime settings；tokens、API keys 與 credentials 只放在 Hermes 支援的 secret store。文件與 logs 一律以 `[REDACTED]` 代替秘密值。

## Publication lifecycle

`/vault_papernote_publish`會建立或讀回一筆 durable operation。每筆 operation 綁定準備時的 source、mapping 與 remote baseline，並沿用同一個 operation ID 完成後續工作。

1. 從已核准的 Vault Markdown 建立全新的公開 candidate；不重用舊 output root。
2. 若 `site-content.yml` 需要更新，建立 `publication/map/<operation-id>` proposal branch 與 PR，通過 CI 後合併。
3. 生成精確的 site commit，更新 `gh-pages`，並派送對應的 GitHub Pages workflow。
4. 核對 workflow、Pages deployment target 與公開網站。
5. 對 candidate 執行 headless QA；全部通過後才把版本寫入 immutable LKG record。
6. 回傳 `published`、`no_change` 或 `needs_attention` terminal result。

`preparing`只表示請求已被接受。Git push、workflow dispatch、private preview 或 dependency install 都不是 publication success。

## 部署與 live QA

Live smoke 必須同時符合：

- homepage 回傳 `200`；
- `site-content.yml` 中每一個核准 route 回傳 `200`；
- candidate 中受檢的 CSS 與 JavaScript assets 回傳 `200`；
- 專用 missing sentinel 回傳 `404`；
- 回應所屬的 deployment ID、workflow run、site commit 與 URL 符合本次 target。

GitHub Pages workflow 完成後，新的 route 或 asset 仍可能短暫回傳 `404`。只有在 homepage 已為`200`、missing sentinel 已為`404`，且完整 route／asset matrix 僅包含`200`與暫時`404`時，系統才會每5秒重試，最多24次（約2分鐘）。

以下情況立即 fail closed，不當成 propagation：

- homepage 不是`200`或 missing sentinel 不是`404`；
- `500`、`503`或其他非`200`／`404`回應；
- route／asset數量不完整；
- deployment target不符；
- transport、authentication、credential或response schema錯誤。

## LKG 與 rollback

LKG 是最近一次已通過 deployment、live smoke 與 headless QA 的網站版本。LKG record不可原地改寫。

Candidate 已推到 `gh-pages`但後續 critical QA 失敗時，rollback只能在以下條件成立時執行：

- 已存在可驗證的 LKG；
- remote `gh-pages`仍由該失敗 candidate擁有；
- rollback commit的tree與LKG tree完全相同；
- rollback workflow、Pages read-back與live smoke都能再次核對。

如果 remote head已由其他合法操作移動，系統不得 force-push或盲目 rollback；應回報 drift／rollback failure並要求人工檢查。Candidate失敗但rollback成功時，terminal code會清楚區分「candidate未發布」與「live網站已恢復」。

## Terminal states

- `published`：candidate已部署，live QA通過，LKG已保存。
- `no_change`：核准輸入與已發布版本相同，沒有建立第二次部署。
- `needs_attention`：operation已安全停止，需要依error code與next action判斷是否人工介入。

同一 command重送時只會讀回或繼續原operation。`needs_attention`不會因為重送而自動變成可重試狀態。

## needs_attention 與人工恢復

收到`needs_attention`時先保留 terminal message中的：

- operation ID；
- error code與stage；
- next action；
- site、rollback與LKG commit（若有）；
- live verified與LKG verified狀態。

停止重複派送，依序核對：

1. `origin/main`與`origin/gh-pages`的實際 heads。
2. 對應 GitHub Actions run與精確 site commit。
3. 公開 homepage、核准route與missing sentinel。
4. immutable LKG record及其commit／tree。
5. operation lease與terminal notification是否已settled。

Repository目前沒有獨立的recovery slash command。需要解除`needs_attention` current slot時，maintainer必須使用Hermes plugin的正式 `DurablePublicationStore.record_reconciliation()` 與 `acknowledge_needs_attention()` 路徑；不得以臨時SQL或檔案修改替代。

### `REMOTE_DRIFT`

`REMOTE_DRIFT`表示operation凍結的remote baseline與準備執行公開變更時看到的實際state不同。常見情境包括：

- operation進行期間，另一個核准PR更新了`main`；
- 另一筆publication或人工操作移動了`gh-pages`；
- mapping proposal合併後，operation使用的baseline尚未完成一致核對。

這個error是安全攔截，不等於內容build失敗。Operator應確認是哪一個合法操作移動remote、目前live版本是否安全，以及原operation是否仍能繼續。不得直接force-push回舊baseline。

### 正式 reconciliation

Reconciliation receipt必須綁定原operation的frozen input digest、terminal error metadata與notification state，並記錄：

- operator與理由；
- remote `gh-pages` SHA；
- live site commit SHA；
- LKG commit SHA；
- live與LKG均已驗證的布林結果。

Acknowledgement只能在operation無active lease、terminal notification已settled、receipt完整且live／LKG均verified時成立。成功後會解除current slot，但不會改寫原本的`needs_attention`歷史結果。

禁止：

- 直接修改publication SQLite；
- 手動變更LKG pointer或verified flags；
- force-push `main`或`gh-pages`以配合舊operation；
- 沒有read-back evidence就將operation標成已處理。

## Branch lifecycle

`publication/map/<operation-id>`是`site-content.yml` mapping proposal ref，不是deployment branch。Operation仍在執行、PR仍開啟、durable state仍引用該ref，或LKG／rollback核對尚未完成時，不得刪除。

Mapping或fix branch只有在以下條件都成立後才可清理：

1. 對應PR已merged或明確closed且不再使用。
2. Branch patch已被`main`吸收，或不再含任何需要保留的獨有內容。
3. 沒有open PR以它為head。
4. 沒有active／`needs_attention` operation、reconciliation或rollback仍引用它。
5. `main`、`gh-pages`與immutable LKG不依賴刪除該ref才能核對。

刪除remote branch後再清理local branch與stale remote-tracking ref。永遠不要把`main`或`gh-pages`當成temporary branch刪除。

## Publication完成後的獨立驗證

在宣稱publication成功前，至少核對：

- terminal operation為`published`；
- GitHub Actions run成功且對應精確site commit；
- homepage與一個以上新route為`200`，missing sentinel為`404`；
- `origin/gh-pages`指向published site commit；
- remote tree與LKG site commit tree相同；
- durable LKG記錄headless QA通過；
- 沒有未處理的active lease或`needs_attention` operation。

只有rollback後網站恢復安全時，應回報「rollback成功、candidate未發布」，不能回報publication成功。
