# Tyler-Vault PaperNote Reading Site

將 Tyler-Vault 中已核准的論文筆記與知識頁，轉成可搜尋、可瀏覽的公開 Reading Site。日常操作在 Telegram 完成；不需要手動執行 build、Git 或 GitHub Pages 指令。

## 可以做什麼

- 從待處理的論文筆記產生 A、B、C…候選整合項目。
- 在 Telegram 貼回決策，先建立待確認的 integration plan。
- 經最後確認後，把核准內容正式整合到 Tyler-Vault。
- 同步 Zotero annotations 到筆記中的 managed section。
- 發布已核准的論文頁、知識頁與直接連結的正式支援頁。
- 部署後檢查公開網站；若部署失敗，使用上一個可用版本恢復。

公開頁面由 [`site-content.yml`](site-content.yml) 的內容動態產生，沒有固定頁數上限。

## 日常使用：Telegram 四個指令

### 1. 產生候選

```text
/vault_papernote_process
```

系統會讀取待處理的論文筆記、同步必要的 Zotero 資料，並回傳本批次的候選與可編輯的 decision template。

候選以 `A`、`B`、`C`…標示。每篇論文以 `P1`、`P2`…標示。

### 2. 貼回決策

直接在同一個 Telegram 對話貼上編輯後的template，不需要額外指令。例如：

```text
Batch: VP-20260813-01
P1 keep: A
P1 rename: B => Knowledge/Concepts/Driving Expertise
P1 merge: C, D => Knowledge/Methods/Vehicle Sensor Synchronization
Unlisted: exclude
```

可用動作：

- `keep`：沿用候選路徑。
- `rename`：改成指定頁面。
- `merge`：將多個候選合併到一頁。
- `split`：將一個候選拆成多頁。
- `defer`：暫緩；本批次不會進入integration。
- 未列出的候選依 `Unlisted: exclude`排除，但保留決策紀錄。

成功時會看到 `Pending integration`、`Ready: yes`，以及最後確認指令。

### 3. 正式整合

```text
/vault_papernote_integrate
```

只有這一步會把pending plan正式寫入 Tyler-Vault。完成後會回報整合的論文筆記、目標頁與checkpoint位置。

### 4. 發布Reading Site

```text
/vault_papernote_publish
```

指令會先立即回覆同一筆operation ID，接著在背景完成：

1. 找出已核准的新內容與直接連結的正式支援頁。
2. 建立公開projection並排除私人metadata、local paths與credentials。
3. 生成Reading Site。
4. 更新GitHub Pages。
5. 執行critical live QA。
6. 保存最近一次可用版本（LKG）；必要時自動恢復。

同一筆publish重複送出時，只會讀回或繼續原operation，不會建立第二個網站發布工作。每個operation最多主動送一次terminal結果。

### Zotero同步

```text
/vault_papernote_zotero
```

同步Zotero annotations到Vault筆記中的managed section。若沒有變更，會明確回覆no change。

## 成功後在哪裡看結果

- **整合後Markdown**：Tyler-Vault中的正式Literature與Knowledge頁。
- **公開Reading Site**：<https://eyeyesight.github.io/Tyler-Vault_PaperNote_ReadingSite/>
- **發布結果**：原Telegram對話中的operation terminal message。
- **公開內容清單與routes**：[`site-content.yml`](site-content.yml)。

## 初次安裝與設定

### 需求

- Hermes Agent與已連線的Telegram Gateway。
- Node.js 22+、npm 10.9.2+。
- Python 3.11+。
- 可讀寫的Tyler-Vault工作副本。
- 已設定的Zotero與Google Workspace存取。
- 對目標GitHub repository及Pages的必要權限。

### Hermes Plugin

將`vault-paper-workflow` plugin安裝到目前Hermes profile後啟用：

```bash
hermes plugins enable vault-paper-workflow --no-allow-tool-override
hermes plugins list
hermes doctor
```

Plugin不需要覆寫Hermes內建tools。Gateway載入後，Telegram menu應只有以下四個PaperNote commands：

```text
/vault_papernote_process
/vault_papernote_integrate
/vault_papernote_publish
/vault_papernote_zotero
```

Runtime settings需提供四個commands的bounded argv、working directory與timeout。路徑和非秘密設定放在Hermes profile的runtime settings；tokens、API keys與credentials只放在Hermes支援的secret store，文件與logs中一律顯示為`[REDACTED]`。

## 常見問題

### 沒有待處理論文

先確認Vault的`Inbox/Literature Drafts`是否有符合流程的draft，以及Google Drive工作副本是否為最新。

### 貼上decision後沒有建立pending plan

確認以下三部分都存在且未改錯：

- `Batch: <batch-id>`
- 至少一條`P1 keep:`、`rename:`、`merge:`、`split:`或`defer:`
- `Unlisted: exclude`

Batch ID必須和最近一次`process`結果相同。所有候選必須有唯一決策；有`defer`時不會進入integration。

### integrate回覆沒有pending plan

重新執行`process`，貼回decision template，確認收到`Ready: yes`後再執行`integrate`。不要手動建立pending manifest。

### publish停在needs_attention

查看Telegram中的error code與next action。常見原因是：

- GitHub／Pages權限或credentials不可用。
- Vault、Git或renderer路徑不可讀。
- 內容含真正不應公開的active HTML、unsafe URL、attachment embed或local path。
- GitHub deployment或live QA失敗。

修正原因後再次送出同一個publish command；系統應讀回或恢復同一筆operation，而不是建立第二筆。

### 網站沒有更新

先確認terminal result是否為`published`而非`no_change`或`needs_attention`，再查看GitHub Pages deployment。不要以private preview、dependency install或Git push本身當作發布成功。

## 本機開發與preview

一般使用者不需要這一節。修改renderer或樣式時：

```bash
npm ci
npm run slim:preflight -- --vault-root 'C:/absolute/Tyler-Vault'
npm run slim:build -- --vault-root 'C:/absolute/Tyler-Vault'
npm run typecheck
npm run test:slim
```

Build只讀取Vault，輸出位於repository的artifacts，不會把HTML或runtime檔案寫回Vault。Quartz安裝與本機build細節見 [`docs/quartz-toolchain.md`](docs/quartz-toolchain.md)；資料流與安全邊界見 [`CONTEXT.md`](CONTEXT.md)。
