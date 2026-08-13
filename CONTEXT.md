# Project Context

## 產品

Tyler-Vault PaperNote Reading Site把已核准的研究筆記轉成公開、可搜尋、可瀏覽的靜態網站。一般使用者在Telegram完成候選整理、整合、Zotero同步與發布；repository負責產生網站與部署到GitHub Pages。

## 資料流

```text
Zotero與論文draft
  → /vault_papernote_process
  → Telegram decision reply
  → pending integration plan
  → /vault_papernote_integrate
  → Tyler-Vault正式Markdown
  → /vault_papernote_publish
  → Reading Site build
  → GitHub Pages
  → live QA與LKG
```

`process`只建立候選；貼回decision reply只建立pending plan；只有`integrate`會正式寫入Vault。`publish`讀取已核准內容並生成公開網站，不修改研究內容。

## 內容與routes

[`site-content.yml`](site-content.yml)記錄目前公開的source、route與layout。內容數量是data-driven，沒有固定頁數。

Publication可加入：

- 已整合的`Literature/Notes`論文筆記。
- 直接連結的正式`Literature/Syntheses`。
- 直接連結的正式`Literature/Reviews & Maps`。
- 直接連結的`Knowledge/Authors`、`Concepts`、`Methods`與`Tasks`頁。

頁面共同提供search、Explorer、graph與backlinks。未列入公開內容的wikilink會轉成安全文字，不會洩露Vault path。

## Source與output

- **正式研究內容**：Tyler-Vault Markdown。
- **公開內容清單**：`site-content.yml`。
- **版型與樣式**：本repository的templates、Quartz設定與styles。
- **生成網站**：repository artifacts與`gh-pages`內容。

Build期間Vault是read-only。HTML、CSS、JavaScript、logs、workspaces或deployment state不得寫進Vault。

## 隱私與安全

公開projection會排除：

- workflow-only metadata與integration boundary comments；
- Zotero local identifiers、local links與attachment metadata；
- credentials、tokens、private keys與local filesystem paths；
- drafts、queues、logs、PDF與未核准頁面；
- scripts、unsafe URL schemes、attachment embeds與其他active content。

正常Markdown、已核准的integration內容及可安全顯示的wikilink basename不應因工程格式要求而阻塞發布。

## 發布與恢復

`/vault_papernote_publish`建立一筆durable operation後立即回覆operation ID。背景工作生成網站、更新GitHub Pages並執行critical live QA。

- Duplicate只讀回或恢復同一operation。
- 每個operation最多主動送一次terminal result。
- 成功部署後保存最近一次可用版本（LKG）。
- live QA失敗時，在同一次授權內恢復LKG並重新驗證。

`preparing`只表示請求已被接收；只有terminal result為`published`且live QA通過，才代表公開網站已完成更新。

## 開發入口

```bash
npm ci
npm run slim:preflight -- --vault-root 'C:/absolute/Tyler-Vault'
npm run slim:build -- --vault-root 'C:/absolute/Tyler-Vault'
npm run typecheck
npm run test:slim
```

日常操作與故障處理請看 [`README.md`](README.md)；Quartz依賴與preview說明請看 [`docs/quartz-toolchain.md`](docs/quartz-toolchain.md)。
