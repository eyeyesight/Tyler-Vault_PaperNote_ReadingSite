# Quartz Toolchain

Quartz是Reading Site的HTML renderer。一般使用者透過Telegram發布，不需要直接操作Quartz；本文件供修改theme、template或renderer的開發者使用。

## 需求

- Node.js 22或更新版本。
- npm 10.9.2或更新版本。
- 一份可讀取的Tyler-Vault本機工作副本。

## 安裝

從repository root執行：

```bash
npm ci
```

`package.json`與`package-lock.json`已固定Quartz及其他dependencies。請使用`npm ci`，不要改成floating Quartz版本。

## 本機preflight與build

```bash
npm run slim:preflight -- --vault-root 'C:/absolute/Tyler-Vault'
npm run slim:build -- --vault-root 'C:/absolute/Tyler-Vault'
```

- `slim:preflight`確認content map中的source可讀，並列出將生成的routes。
- `slim:build`建立公開projection並生成本機網站。
- Vault只會被讀取；snapshot、work與output位於repository artifacts或temporary directories。
- 公開頁數由`site-content.yml`決定，沒有固定數量。

若要檢查GitHub Pages將收到的檔案，可建立本機preview：

```bash
npm run gh-pages:prepare -- \
  --built-site '.artifacts/slim-site' \
  --baseline-site 'C:/absolute/gh-pages-copy' \
  --output '.artifacts/gh-pages-preview'
```

這只產生本機preview與檔案差異，不會push或deploy。

## 修改後的最小檢查

```bash
npm run typecheck
npm run test:slim
git diff --check
```

若修改GitHub Pages preparation或workflow，再加跑：

```bash
npm run test:gh-pages
```

完整test suite可在release或廣泛cross-cutting變更時執行；單純content、template或projection修正先以相關journey test與本機build為準。

## 常見問題

### Package tree不一致

刪除自行修改的dependency狀態後重新執行`npm ci`。不要手動patch`node_modules`。

### 找不到Vault

使用完整的`--vault-root`路徑，並確認工作副本已同步。Build不會自動從Google Drive下載內容。

### SOURCE_ACTIVE_CONTENT_NOT_ALLOWED

先確認source是否真的含script、iframe、event handler、unsafe raw HTML或不應公開的annotation metadata。合法integration boundaries與Zotero managed blocks應由public projection清除，不需作者手動刪除。

### Build成功但網站未更新

本機build不會部署。日常正式發布請用Telegram的`/vault_papernote_publish`，並以terminal result與live QA結果判定成功。
