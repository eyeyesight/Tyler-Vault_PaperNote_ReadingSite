# Tyler-Vault Reading Site Agent Rules

## 目標

優先讓一般使用者能從Telegram完整操作PaperNote流程：

1. `process`產生候選。
2. decision reply建立pending plan。
3. `integrate`正式寫入Vault。
4. `publish`生成網站、部署、live QA並保存LKG。
5. `zotero`同步managed annotations。

先確保這些journeys能實際完成，再處理廣泛hardening、release ceremony或非阻塞重構。

## 產品邊界

- Tyler-Vault Markdown是正式研究內容來源。
- Repository build對Vault保持read-only；只有核准的integration workflow可寫入Vault。
- `site-content.yml`記錄公開source、route與layout。頁面數量是data-driven，沒有固定上限。
- 正式Literature notes、Syntheses、Reviews & Maps及直接連結的Knowledge support pages可進入publication。
- 未公開wikilink應投影為安全文字，不要求作者為每個link補manual alias。
- 合法workflow boundaries與Zotero managed metadata應在public projection中自動剝除。

## 必要護欄

保留以下限制：

- credentials、tokens、private keys與local paths不得進入公開輸出或logs；
- scripts、unsafe URL schemes、attachment embeds及真正active HTML不得公開；
- source、work、output與deployment roots不得危險重疊；
- GitHub／Pages權限與公開mutation必須使用已授權credentials；
- duplicate publish不得建立第二個operation或第二個Site child；
- Windows只能終止本workflow擁有的process tree；
- build與deployment失敗不得回寫或破壞Vault。

其他格式或工程限制若能安全自動推導、提供default或在projection處理，就不應要求使用者手動修正。

## 修改原則

- 修改authoritative source，不直接patch generated HTML。
- 優先補足真實user journey，而不是新增parallel framework。
- 使用最小、可回復的變更；非阻塞問題列為hardening debt。
- 不把private preview、dependency install、Git push或metadata preparation稱為publication成功。
- README與一般文件以安裝、操作、結果與故障處理為主；內部ticket與歷史設計不應主導產品說明。

## 最小驗收

依變更範圍執行：

```bash
npm run typecheck
npm run test:slim
npm run test:gh-pages   # 修改Pages preparation或workflow時
node --check scripts/slim-build.mjs
git diff --check
```

功能完成需另外驗證相關Telegram journey與真實本機build。只有涉及廣泛cross-cutting、release或security stack變更時，才將完整suite視為必要blocker。

## 禁止事項

- 不把HTML、CSS、JavaScript、JSON、logs、ZIP或runtime state寫進Tyler-Vault。
- 不在文件、stdout、stderr或Telegram輸出credentials；一律顯示`[REDACTED]`。
- 未經授權不改GitHub visibility、credentials、Pages設定或其他不可逆公開權限。
- 不以固定頁數、manual alias、非必要frontmatter或內部驗收格式阻塞正常已核准內容。

使用方式見 [`README.md`](README.md)，資料流見 [`CONTEXT.md`](CONTEXT.md)，renderer操作見 [`docs/quartz-toolchain.md`](docs/quartz-toolchain.md)。
