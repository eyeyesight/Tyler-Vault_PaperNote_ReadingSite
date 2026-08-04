# GitHub Pages `gh-pages` 操作手冊

本手冊給 Arke（準備與啟動）和 Tyler（部署核准）使用。這條路徑只把已驗證的靜態 candidate 從 `gh-pages` branch 交給 GitHub Pages；Pages workflow 不 build Quartz、不修改 candidate，也不自行宣稱 provider 成功。

## 0. 不可變更的操作邊界

- candidate 的 branch layout 固定為 `site/` 加 `.publication/`。`site/` 是要發布的靜態輸出；`.publication/` 放 G2 verifier 所需的 manifest、digest、rights 與 finalized launch audit 等發布證據。
- 只把 candidate push 到 `gh-pages`：不可把 candidate push 到 `main`，也不可用 `push`、PR 或其他自動事件觸發部署。部署 workflow 只能從 `refs/heads/main` 以 `workflow_dispatch` 啟動，而且 repository default branch 必須仍是 `main`；任一條件不符都會在使用 candidate 前 hard-fail。
- `site_commit` 必須是 exact、40 個小寫十六進位字元，且必須是同一 repository 的 `refs/heads/gh-pages` 歷史中的 commit。不要用 branch name、tag、短 SHA 或其他 branch 的 SHA。
- visibility approval（讓 repository/內容可見）和 `github-pages` environment deployment approval 是兩個不同核准；前者不能代替後者。
- workflow 的 action 都固定在可驗證的 40-hex 官方 commit pin。不要把 pin 改回 mutable tag，也不要加入 secrets、`contents: write`、自建 claim 或 retry。

### 0.1 單一 GitHub 帳號與操作角色

- Same GitHub account: `eyeyesight`。Arke 與 Tyler 是操作角色，不是 GitHub 可驗證的不同身分。
- Arke role: prepare、revalidate、推送隔離的 exact `gh-pages` candidate，並 dispatch exact workflow run。
- Tyler role: 在 repository/public content mutation 前做 visibility approval decision；在 validate 完成且 exact digest compare 通過後，於 `github-pages` 做分開的 deployment approval decision。
- GitHub records both roles as `eyeyesight`。這兩個人類決策事件仍須分開記錄；同一帳號紀錄不等於 account-level identity separation。
- Operative correlation evidence 必須依序保留：`workflow_run_id` → `run_started_at` → `environment_reviewed_at` → Telegram decision reference，並連同 exact SHA、`candidate_digest`、`launch_audit_digest`、fixed summary、provider readback 保存。時間與 Telegram 是 operator correlation，不是 GitHub cryptographic identity proof。
- `github-pages` 仍有 required reviewer；self-review prevention is disabled，否則同一 `eyeyesight` 帳號無法核准自己啟動的 run。若帳號或 credential 被 compromise，同一帳號可能同時 initiate and approve visibility 與 deployment 兩個事件；這是明確限制。

## 1. 本機 prepare

1. 從 approved source 和目前的 release/manifest 證據開始。先安裝依賴並照專案既有的 source build/verify 流程產生靜態輸出；不要把 canonical Vault Markdown、PDF、Queue、Logs、credentials 或未核准節點放進 candidate。`<sourceRoot>` 必須是 operator 明確提供的 canonical source-tree root（使用實際絕對、canonical 路徑）；它是 source custody 的 trusted authority，不是要複製進 candidate 的內容。

   用 prepare CLI 建立 fresh candidate；`--source-root` 是必要 flag，且輸出 root 必須與 source root、release custody、runtime custody disjoint，不可選在 source root 之內：

   ```bash
   node scripts/prepare-gh-pages-candidate.mjs \
     --runtime-root <runtimeRoot> \
     --releases-root <releasesRoot> \
     --manifest-id <manifestId> \
     --source-root <sourceRoot> \
     --output-root <candidateRoot>
   ```

   這個 CLI 只接受 named flags；缺少、重複或未知 flag 都應以 redacted `CLI_ARGUMENT_INVALID` 結束，不要從錯誤輸出推導本機路徑。

2. 確認 prepare 完成後，candidate 根目錄只有這兩個發布面：

   ```text
   candidate/
   ├── site/
   │   ├── index.html
   │   ├── 404.html
   │   └── ... generated static assets ...
   └── .publication/
       └── ... manifest, digests, rights, finalized launch audit ...
   ```

3. 在本機使用 G2 verifier，要求 launch audit 並把輸出 stage 到一個全新的暫存目錄。`<candidateRoot>` 和 `<freshRoot>` 使用實際絕對路徑：

   ```bash
   node scripts/verify-gh-pages-candidate.mjs \
     --candidate-root <candidateRoot> \
     --expected-candidate-digest <candidateDigest> \
     --expected-launch-audit-digest <launchAuditDigest> \
     --require-launch-audit \
     --stage-output <freshRoot>
   ```

   verifier 成功才可進入下一步；不要以「有 index.html」取代 manifest、rights、digest 或 launch-audit 驗證。

   Prepare/verifier 的失敗清理是 best-effort filesystem hygiene，不是 absolute atomic replacement safety：parent 和 output staging root 被視為不會遭 cooperating same-user writer 在清理期間替換的 trusted boundary。程式只在 `rmdir` 前立即檢查 no-link ancestry 與 dev/ino ownership，並以 non-recursive `rmdir` 限制為同一個空目錄；它不宣稱能抵抗 compromised 或 cooperating same-user writer，不能當作 atomic handle-bound deletion。不要加入 race hook，也不要把清理擴大成 recursive deletion。

4. **不可在shared／dirty source worktree執行 `git switch gh-pages`。** Do not switch or use a shared worktree for publication. 使用一個專供本次publication、可刪除的隔離worktree。先fetch遠端publication branch；若已存在，從該remote-tracking ref建立detached worktree。首次發布且遠端branch尚不存在時，才可在同樣隔離的worktree建立orphan `gh-pages`。以下為更新既有branch的範例：

   ```bash
   git fetch --no-tags origin refs/heads/gh-pages:refs/remotes/origin/gh-pages
   GH_PAGES_WORKTREE="${TMPDIR:-/tmp}/tvrs-gh-pages-$$"
   test ! -e "$GH_PAGES_WORKTREE"
   git worktree add --detach "$GH_PAGES_WORKTREE" refs/remotes/origin/gh-pages

   rm -rf -- "$GH_PAGES_WORKTREE/site" "$GH_PAGES_WORKTREE/.publication"
   cp -R -- <candidateRoot>/site "$GH_PAGES_WORKTREE/site"
   cp -R -- <candidateRoot>/.publication "$GH_PAGES_WORKTREE/.publication"
   git -C "$GH_PAGES_WORKTREE" add --all -- site .publication
   test -d "$GH_PAGES_WORKTREE/site"
   test -f "$GH_PAGES_WORKTREE/.publication/gh-pages-candidate-v1.json"
   test -f "$GH_PAGES_WORKTREE/.publication/github-launch-audit-v1.json"
   while IFS= read -r staged_path; do
     case "$staged_path" in
       site/*|.publication/gh-pages-candidate-v1.json|.publication/github-launch-audit-v1.json) ;;
       *) printf 'unexpected publication path: %s\n' "$staged_path" >&2; exit 1 ;;
     esac
   done < <(git -C "$GH_PAGES_WORKTREE" diff --cached --name-only)
   git -C "$GH_PAGES_WORKTREE" status --short
   git -C "$GH_PAGES_WORKTREE" commit -m "publish: prepare verified Pages candidate"
   SITE_SHA="$(git -C "$GH_PAGES_WORKTREE" rev-parse HEAD)"
   printf '%s\n' "$SITE_SHA"
   ```

   這裡的 `rm -rf` 只可作用於Main本次建立之isolated worktree內的兩個固定publication paths；不得對shared worktree、Vault、release custody或未驗證路徑執行。每次commit前都必須通過上面的exact root allowlist：任一staged path只能位於`site/`，或是兩個固定`.publication/` JSON；首次建立orphan branch亦同。完成push與remote readback後，用 `git worktree remove "$GH_PAGES_WORKTREE"` 只移除這個隔離worktree。

## 2. 只 push candidate 到 `gh-pages`

先確認隔離worktree只包含本次candidate，然後明確指定exact commit與目的ref；不要push shared worktree的`HEAD`：

```bash
git push origin "$SITE_SHA":refs/heads/gh-pages
```

push 後重新確認遠端 `gh-pages` 的完整 SHA。若為了補 `.publication/` 的 final audit 又產生新 commit，舊 SHA 立即失效，必須以新 commit 重新做後續檢查。

## 3. visibility audit、approval、readback 與 final audit

這一段是把「可以被看見的 repository 內容」和「可以被部署的 candidate」分開證明：

1. **Pre-visibility audit**：在 visibility 改變前，檢查 approved output allowlist、site inventory/digest、manifest、rights、排除項目和 credentials scan。
2. **Visibility approval**：由 Tyler 在 repository/public content mutation 前明確批准公開；把決策 reference、時間和 `eyeyesight` actor 放入 launch-audit 證據，不要把部署核准寫成 visibility 核准。這是第一個人類事件，必須早於 public mutation。
3. **Post-visibility readback**：visibility 改變後，以完整分頁的 authenticated GitHub API lane 讀回 repository、default branch、Actions/Pages/environment 控制面，並做 anonymous repository readback。UI 只能作為可讀 corroboration，不能取代 machine lane。
4. **加入 final audit**：將 post-visibility readback 的結果和 digest 寫入 finalized launch audit，放進 `.publication/`，再由 `gh-pages` 產生一個新的 commit。新的 final-audit commit 才是可部署的 candidate；重新執行 G2 verifier，並重新確認沒有 secrets 或不允許輸出。

若 readback、rights 或 launch audit 任何一項不清楚，停止，不要先啟動 Pages。未知不等於 clear。

## 4. Arke 以 exact SHA 啟動 workflow

Arke 以同一 `eyeyesight` 帳號在 GitHub Actions 頁面執行 **Deploy GitHub Pages candidate**：

1. `Run workflow` 的 branch/ref 選 repository 的 default branch（目前是 `main`）；不要從 `gh-pages` 或任意 feature branch 啟動。
2. `site_commit` 填入剛完成 final audit、重新驗證後的完整小寫 40-hex SHA。不要貼短 SHA、含換行的值、tag 或 branch 名稱。
3. `candidate_digest`與`launch_audit_digest`分別填入本機重新驗證過的64個小寫hex expected values。這兩個GitHub-authenticated workflow inputs獨立於branch bytes；verifier會將它們與exact commit內的candidate及final audit比對。
4. 啟動前可在本機再次做最小 readback：

   ```bash
   git fetch --no-tags origin refs/heads/gh-pages:refs/remotes/origin/gh-pages
   git merge-base --is-ancestor "$SITE_SHA" refs/remotes/origin/gh-pages
   ```

   workflow會重新checkout exact SHA，並只fetch `refs/heads/gh-pages`來證明containment；只存在其他branch的SHA會被拒絕。validate job也會比對兩個expected digests、執行G2 `--require-launch-audit`，並把不存在的fresh child交給verifier建立後，只上傳該stage目錄。

## 5. Tyler 核准 `github-pages` environment

validate job 綠燈後，deploy job 會停在 `github-pages` environment。Tyler 檢查：

- run 的 branch 是 default branch，`site_commit` 是 final-audit commit；
- Compare `candidate_digest`與`launch_audit_digest` against the Telegram/out-of-band approved values；兩者必須逐字相等；
- validate log 顯示 candidate checkout、gh-pages ancestry/containment、G2 launch-audit 驗證和 stage 成功；
- 沒有把 source build、Quartz build 或 candidate mutation 放在 workflow 中。

確認無誤後由 Tyler 以同一 `eyeyesight` 帳號、不同的 approver role，在 `github-pages` environment approve。這是第二個人類事件；environment reviewer 是 deployment approval，不能由 visibility、Telegram 或 launch-audit 核准代替。若輸入、log、`workflow_run_id`、時間或 candidate 不對，拒絕並重新準備一個新的 exact SHA。

這個邊界不宣稱能以密碼學方式抵抗惡意launcher：GitHub inputs證明run收到什麼，Tyler的out-of-band compare與environment approval決定是否允許該run部署。不得以custom signing、token、claim或自建deployment authority取代此人工核准。

Deployment approval只記錄在GitHub environment及provider deployment records。

Release custody中的sealed receipt永不因部署核准而修改。

## 6. provider readback 與 browser QA

`actions/deploy-pages` 成功後，才開始 post-deploy QA。保留並讀回同一次 workflow run 的：

- `workflow_run_id`、`run_attempt`、run commit SHA、`run_started_at`；
- `environment_reviewed_at` 與 Tyler 的 Telegram decision reference；
- Pages artifact ID；
- deployment ID、deployment status ID；
- `github-pages` environment URL 和 deploy action 的 `page_url`；
- provider 成功後實際提供的 URL/bytes。

然後由 operator 做 anonymous HTTP 和 browser QA：

- expected Pages base path、首頁、`404.html`；
- 代表性的 paper/support page、slug navigation；
- Explorer、search、global graph 及其 JSON/static assets；
- 連結沒有逃出 base path，served bytes 和 approved manifest/digest 沒有 rights 或 disallowed-output regression。

provider outcome 若是 timeout、沒有明確結論或本機看不到結果，標記為 **unknown**，先 read back 同一個 workflow run 和 GitHub provider deployment/status；不要把 unknown 當 failure 後盲目重送，也不要在 workflow 內自建 claim、retry 或第二次 provider mutation。若 readback 後確實需要再試，必須是新的 workflow run、新的 provider IDs、新的 exact `gh-pages` SHA，並重新通過同一個 environment approval。

## 7. HTML hotfix

GitHub 的 file editor 可以直接做緊急 HTML hotfix，但這會改變已封存 bytes：原有 manifest/digest 立即失效。處理規則如下：

1. 只在 `gh-pages/site/` 編輯必要 HTML；不要藉 hotfix 新增未核准研究內容或改 `.publication/` 來掩蓋差異。
2. 將變更 push 到 `gh-pages` 後，**不可直接用該 SHA 部署**。
3. 重新產生/ reseal manifest、site inventory、digest、rights 和 finalized audit，重新執行 G2 verifier（含 `--require-launch-audit`）與 revalidate。
4. 以 revalidated commit 的新 exact SHA 重新走同一 `eyeyesight` 帳號下的 Arke dispatch、validate/digest compare、Tyler 的新 environment approval、provider readback 和 browser QA；若 hotfix 同時改變 public visibility，仍須先有新的 visibility approval event。重新記錄新的 `workflow_run_id`、run/approval times 與 Telegram reference，不得沿用舊 run 的 approval。

## 8. 新頁面、slug、search、graph

新增頁面、改 slug、改 search index 或改 graph 都是 source-level 變更，不是 HTML hotfix。回到 canonical source，做 source build，再將產物放入 `site/`、更新 `.publication/`、重新 seal/revalidate，最後只 push 新 candidate 到 `gh-pages`。Pages workflow 不 build Quartz，也不在 deploy job 修補 generated site。

## 9. action pin 來源

以下 pin 是 official `actions/*` repository 的公開 tag commit；版本只以同一行 comment 標記，workflow contract test 會拒絕 tag、branch 或非 40-hex ref：

| Action | Version | Immutable commit |
|---|---:|---|
| `actions/checkout` | v4.2.2 | `11bd71901bbe5b1630ceea73d27597364c9af683` |
| `actions/setup-node` | v4.4.0 | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| `actions/configure-pages` | v5.0.0 | `983d7736d9b0ae728b81ab479565c72886d7745b` |
| `actions/upload-pages-artifact` | v3.0.1 | `56afc609e74202658d3ffba0e8f6dda462b719fa` |
| `actions/deploy-pages` | v4.0.5 | `d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e` |

來源是各官方 repository 的 `refs/tags/<version>` 公開 ref（可用 read-only `git ls-remote` 重新核對）；若官方 source 無法證明新 pin，保持 contract test RED，不要猜 SHA。
