# 同步（M4）：轮询 issue / PR 状态与新评论

> 代码：`src/server/sync.ts`（纯函数 + 薄 IO，`http` / `run` 可注入）。
> 测试：`test/sync.test.ts`（31 个用例，全部离线：真响应样本 fixtures + 注入的假 HTTP / 假 tea）。
> **全程只读**：只发 `GET`，没有 `POST/PATCH/PUT/DELETE`，不改仓库、不改 issue/PR、不动用户配置、不装工具。

## 1. 传输选择：为什么是 REST API（而不是 RSS / 只用 tea CLI）

| 传输 | 判定 | 理由 |
|---|---|---|
| **Gitea/GitHub REST API**（`Authorization: token …`） | **主路** | 三个端点各给到我们要的全部字段：`issues`（`state`/`updated_at`/`comments` 条数）、`pulls`（`merged`、`head`/`base`）、`issues/comments`（**支持 `since` 增量** + 评论 `id`/正文/作者）。10 s 超时、只读 GET，凭据直接用 tea 已存的那一个。 |
| `tea` CLI（`tea issues ls` / `tea pulls ls --output json`） | **后备**（仅当没有任何可用 token） | 本机已装已登录，能拿 issue/PR 列表；但 **PR 字段里没有 `merged`**（`--fields merged` 直接报 `invalid field`），**没有评论增量接口**，`since` 也没有（`issues ls` 的 `--from` 是活动时间、`pulls ls` 根本没有）。所以它只能算兜底，不能当主路。 |
| **RSS**（`https://gitea.example.com/git/owner/repo.rss`） | **不采用（实测不可用，且信息贫乏）** | ① **该地址实测 HTTP 404**：匿名请求 404，带 `Authorization: token …` 也 404；同形态的**公开**仓库 feed（`https://gitea.com/gitea/tea.rss`）返回 200 —— 说明是「私有仓库不暴露 feed」而不是路径写错，也就是这个仓根本没有可用的 feed 入口（Gitea 的 feed 没有可用的鉴权方式）。② 就算 feed 可用（拿公开仓库样本核对过），条目只有 `title`（形如 `mfk1 opened issue <a href=…>` 的 **HTML 文案**）/`link`/`description`/`content:encoded`/`author`/`guid`/`pubDate`：**没有 `state`、没有 `merged`**，状态只能从自然语言文案里正则猜（"opened issue" / "commented on pull request" …）。③ feed 永远是最新 N 条，**没有 `since` 游标**、翻不了历史。④ 评论 id 虽然藏在 `guid`/`#issuecomment-N` 里，能勉强去重，但正文是 HTML 片段、没有作者 id、没有 PR 的 head/base。结论：API 能给 `since` 增量、`merged` 与结构化评论，RSS 一样都给不了 → 不用 RSS。 |

选择顺序写死在 `resolveSyncTarget` 里（见 §2），调用方不需要判断。

## 2. 凭据与目标解析（纯函数 `resolveSyncTarget`）

`project.remote`（如 `https://gitea.example.com/git/owner/repo`）→ `{forge, apiBase, owner, repo, token, source}`：

| 顺序 | 条件 | 结果 |
|---|---|---|
| 1 | `~/.config/tea/config.yml` 里存在登录项，其 `url` 是 remote 的**前缀**（整段 path 保留，所以 Gitea 的 `/git` 根路径前缀照样匹配；`git@host:owner/repo` 这种 scp 形态会先规范化成 `https://host/owner/repo`） | `source:"tea"`，`apiBase = {login.url}/api/v1`，`{owner}/{repo}` = remote 去掉前缀与 `.git` 后的最后两段 |
| 2 | `FLOWCARD_GITEA_ROOT` + `FLOWCARD_GITEA_TOKEN`（**且 root 主机与 remote 主机一致**） | `source:"env-gitea"`，`apiBase = {root}/api/v1` |
| 3 | `FLOWCARD_GITHUB_TOKEN`（仅 `github.com` / `*.github.com`） | `source:"env-github"`，`apiBase = https://api.github.com`（企业版走 `https://{host}/api/v3`） |
| 4 | 都没有 | `{ok:false, reason:"no-credentials"}`（**返回结果、不抛**）；remote 认不出 → `reason:"no-remote"` |

细节：

- **多登录项都能前缀匹配时，最长前缀胜出**（`https://gitea.example.com/git` 比 `https://gitea.example.com` 更具体）。
- 第 2 条要求主机一致是有意的：否则等于把 token 发到别的主机去。
- 纯函数：配置文本与环境变量都从参数进来（`teaConfig` / `env`），磁盘读取只在 `readTeaConfig()` 这一层 —— 单测因此不需要真配置文件。
- 配置解析（`parseTeaConfig`）手写扫描 `logins:` 块（只认 `name`/`url`/`token` 三个键，去引号，缺 `url`/`token` 的块丢掉），**不引 YAML 依赖**。
- **token 从不进日志/返回值以外的地方**：`SyncAuth.token` 只用于 `authHeaders`；`SyncSnapshot` 里没有 token 字段。

## 3. 轮询与解析

三个端点，每页 50 条，**最多 5 页/端点**（上限 250 条，防一次同步打爆内存/时间）：

| 端点 | 关键参数 | 解析成 |
|---|---|---|
| `GET {apiBase}/repos/{o}/{r}/issues` | Gitea：`state=all&type=issues&since=<ISO>&limit=50&page=N`（`type=issues` 排掉混进来的 PR）；GitHub：`state=all&since=…&per_page=50`（PR 靠响应里的 `pull_request` 字段过滤） | `{number,title,state:"open"\|"closed",updatedAt,comments}`（`comments` 是**条数**） |
| `GET …/pulls` | `state=all`（Gitea 额外 `sort=recentupdate`）。**两边都不支持 `since`**，所以不带（带上去 Gitea 直接忽略，实测仍返回全量） | `{number,state:"open"\|"closed"\|"merged",merged,head,base,updatedAt,url}` |
| `GET …/issues/comments` | `since=<ISO>` + `limit=50`（Gitea）/`per_page=50`（GitHub） | `{id,issueNumber,author,body,at,url}` |

解析上的几个**真实坑**（都在 fixtures 里覆盖了）：

- **`merged` 判定**：`merged === true` → `"merged"`（Gitea 合并后 `state` 仍然是 `closed`）；`state === "closed"` 且没有 `merged` 位 → `"closed"`；其余 `"open"`。`tea` CLI 拿不到 `merged` 时写 **`merged: null`**，不瞎填。
- **PR 的分支名在 `label` 里**：Gitea 同仓 PR 的 `head.ref` 是 `refs/pull/745/head`，`head.label` 才是 `codex/trim-native-shell-tests`；`base.label` 是 `master`。
- **评论的 `issue_url` 常常是空串**：PR 评论挂在 `pull_request_url` 上，两者都缺时降级到 `html_url`（`…/pulls/735#issuecomment-7438`）。三个都抠不出编号的评论**直接丢弃**（无法路由到卡片）。
- **时间归一化**：Gitea 给 `2026-10-09T17:21:33+08:00`，`tea` CLI 给 UTC `Z`；统一成 `toISOString()` 的 UTC 形态再进幂等键，否则同一个事实会因为偏移写法不同而重复。
- 单条精确读：`fetchIssue(auth, 742)` / `fetchPull(auth, 745)` → `GET …/issues/{n}` / `…/pulls/{n}`，比整页列表便宜得多（一个 PR ≈ 17 KB，一页 PR 列表 ≈ 0.5 MB）。**卡片已绑定的编号优先走它**。

## 4. 幂等键（事件库的 `dedupeKey`）

`factKey(fact)` 是唯一实现：

| fact | 幂等键 |
|---|---|
| `remote.comment` | `sync:comment:{id}` |
| `issue.state` | `sync:issue:{number}:{updatedAt}` |
| `pr.state` | `sync:pr:{number}:{state}:{updatedAt}` |

同一事实重复同步 → 同一 key → 只落一次；issue/PR 的 `updatedAt` 变了（被编辑/评论/状态变化）→ 换 key → 落一条新的状态事实（重复设同样的值是无害的）。

## 5. 差异：`toFacts(prev, next, opts?)`

- `prev` = 上一轮快照（首次同步传 `null`）；`next` = 本轮快照的三个数组。
- **只算差异**：`state` 或 `updatedAt` 与上轮一样的 issue/PR 不发；评论按 `id` 去重（`prev.commentKeys` + 同轮内也去重）。
- `opts.numbers` = 看板上**真有卡片**的编号集合：给了就只为这些编号产出事实。**接线时必须给** —— 事件要挂 `cardId`，不给这个过滤会为仓库里每个条目各发一条（实测一次快照 12 个 issue + 250 个 PR，其中绝大多数没卡片）。
- 正确性不依赖 `prev`：即使每轮都传 `null`，`dedupeKey` 也会把重复事实挡在事件库外；`prev` 只是省掉无谓的引擎调用。

## 6. 降级矩阵（拿不到就降级，绝不抛）

| 情况 | 表现 |
|---|---|
| 没有可用凭据（tea 配置 / 两个环境变量都没有） | `pollRemote` → `{ok:false, reason:"no-credentials"}` + notes；**先试 tea CLI**（要 `repoPath`），CLI 也不行才认输 |
| remote 认不出 host/owner/repo | `{ok:false, reason:"no-remote"}`，不同步 |
| 401 / 403 | 该端点 `degraded:{reason:"unauthorized"\|"forbidden"}`，数组为空，其余端点照常 |
| 404（仓库不可见 / 权限不足） | `degraded:{reason:"not-found"}` |
| 网络错误 / 10 s 超时 | `degraded:{reason:"network"\|"timeout"}` |
| 2xx 但不是 JSON 数组（反向代理的错误页） | `degraded:{reason:"parse-error"}` |
| 第 2 页以后失败 | **保留已拿到的**，记 note，不整体降级 |
| 命中 5 页上限 | 保留 250 条 + note（PR 列表没有 `since`，老 PR 会滑出窗口 → 用 `fetchPull` 按号补） |
| `tea` 未安装 / 未登录 | note「tea 未安装」/「exit N: stderr 首行」；两个端点都没数据 → `{ok:false, reason:"no-transport"}` |
| 走 tea CLI 兜底 | `degraded` 固定带上 `comments:unavailable`；有 PR 时再加 `pulls:unavailable`（没有 `merged`） |

`SyncSnapshot.degraded` 为空数组 = 三个端点都完整；非空时 UI 应提示「本轮数据可能不全」（而不是当成同步失败）。

## 7. 轮询节奏与增量窗口

- **节奏：5 分钟一轮**，已内置 `setInterval`（接线见 §9.5；看板场景人的反应时间远大于 5 分钟）。可配 `FLOWCARD_SYNC_INTERVAL_MS`（默认 **300000**，`0` = 关）。
- **增量窗口**：`since = lastSyncAt - 60 s`（重叠 1 分钟防时钟漂移/跨事务漏事件，重复由 `dedupeKey` 吃掉）。`lastSyncAt` 由 store 按项目记住。
- **成本实测**（2026-10-10，Gitea，50 条/页，响应体大小是实测字节数）：单条 `issues/{n}` ≈ **5.8 KB**、单条 `pulls/{n}` ≈ **17 KB**（PR 对象里嵌套了 head/base 各自的完整 repo 对象）；一页 50 条 issue 列表 ≈ **290 KB**；一页 50 条 PR 列表 ≈ **525 KB**；一页 9 条评论 ≈ **25 KB**。因为 `/pulls` 没有 `since`，一次全量快照会翻满 5 页 ≈ **2.6 MB**，整轮实测 **8.6 s ~ 32 s**（服务端冷热差异；冷的那次就是撞上 `timeout` 降级的原因，见 §8）。所以：
  - 只想跟看板上已绑定的那几张卡 → **优先 `fetchPull`/`fetchIssue` 按号精确读**（每个 ≈ 17 KB / 5.8 KB），根本不拉全量列表；
  - 想发现「新 PR / 新 issue」才需要列表，建议频率降一档（如 15–30 分钟）或只在用户打开看板时拉一次。

## 8. 实测（2026-10-10，只读 GET，脱敏）

真项目 `~/workspace/repo`，remote `https://gitea.example.com/git/owner/repo`：

```
resolved : {forge:'gitea', apiBase:'https://gitea.example.com/git/api/v1',
            owner:'owner', repo:'repo', source:'tea', token:'<redacted len=40>'}
since    : 2026-10-09T05:58:35.637Z（脚本取的「昨天」）
GET issues/742  HTTP 200 {"number":742,"title":"游玩页大体积单文件作品启动超时：包体启动耗时与超时窗口贴边（重试可进）",
                          "state":"open","updatedAt":"2026-10-09T09:21:33.000Z","comments":0}
GET pulls/745   HTTP 200 {"number":745,"state":"merged","merged":true,
                          "head":"codex/trim-native-shell-tests","base":"master",
                          "updatedAt":"2026-10-10T04:42:54.000Z","url":"…/pulls/745"}
snapshot        : {source:'api', issues:12, pulls:250, comments:8, degraded:[]}   # pulls 命中 5 页上限
comment 样本    : {"id":7471,"issueNumber":738,"author":"lhk229","at":"2026-10-09T07:22:19.000Z",
                   "url":"…/pulls/738#issuecomment-7471","body":"已将两条审查问题的修复直接提交到本 PR 分支：474c4f2f…"}
facts 首轮      : {issue:12, pr:250, comment:8}      # 未给 opts.numbers
二次同步(prev=本轮快照) : 0 条差异 ✅
```

结论：**解析出的 apiBase/owner/repo 正确；issue 742 = open；PR 745 判为 merged（closed+merged → merged）；`since` 取昨天时评论 8 条**；全程只有 `GET`，没有任何远程写。

同一天顺手验的几条硬事实（第 3 条是真跑逼出来的）：

- `curl https://gitea.example.com/git/owner/repo.rss` → **404**（匿名 404；带 `Authorization: token …` 也 404）；`https://gitea.com/gitea/tea.rss`（公开仓库）→ **200**。私有仓库的 feed 拿不到。
- `tea pulls ls -R origin --output json --fields …,merged` → `Error: invalid field 'merged'`（可用的字段里确实没有 `merged` / 没有评论），所以 CLI 兜底只能给 `merged: null`。
- **真跑抓到过一个真 bug 并已修**：`AbortSignal.timeout` 如果在**读 body 途中**触发（大页 PR 列表会），旧写法会把拒绝漏成异常抛给调用方 —— 现在是 `defaultHttpGet` 整段 `try`，一律折成 `{ok:false, reason:"timeout"}`；`test/sync.test.ts` 用本地假服务（`/partial` 写完响应头就永不 `end`）把这个分支钉住了。
- `tea issues ls` 的 JSON 里 `index`/`comments` 是**字符串**、`updated` 是 **UTC**（`2026-10-10T04:58:46Z`），`author` 是**显示名**（「董羽秦」）而不是 login —— 解析时都按字符串处理并归一化时间。

## 9. 接线（已落地：服务端 / CLI / 前端 / 测试）

下面写的是**实际接线方式**（原清单里的"建议"若与这里不同，以这里为准；偏离的地方都在 §9.7 里点明）。
代码：`src/server/syncer.ts`（一轮同步 + 内置调度器）、`src/server/engine.ts`（`applySync` 命令）、
`src/server/project.ts`（投影）、`src/server/{store,app,main}.ts`、`src/cli/{sync,main}.ts`、`web/src/**`。
测试：`test/sync-wire.test.ts`（23 例，全离线：注入假 http / 假 run）。

### 9.1 事件（事实 → 事件：`applySync` 命令）

事实进引擎**只有一条路**：`cmd applySync { card, facts: SyncFact[] }`（同步器按编号解析好 `cardId`，一张卡一条命令）。
引擎把它翻成事件，`actor` 一律 `{kind:"system"}`，`dedupeKey` 一律 `factKey(fact)`（**唯一来源**，同步器不另起规则）：

| fact | 事件 | payload | 幂等键 |
|---|---|---|---|
| `issue.state` | **新增** `issue.state.changed` | `{number, state, title, updatedAt}` | `sync:issue:{n}:{updatedAt}` |
| `pr.state`（`merged:true` 或 `state:"merged"`） | 复用 `pr.merged`（让引擎走合并那条自动节点） | `{pr: PrRef}` | `sync:pr:{n}:{state}:{updatedAt}` |
| `pr.state`（其余） | 复用 `pr.updated` | `{pr: PrRef}` | 同上 |
| `remote.comment` | **新增** `remote.comment.added` | `{id, issueNumber, author, body, at, url}` | `sync:comment:{id}` |

- 事实 → `PrRef.state` 的换算写在引擎的纯函数 `nextPrState(pr, fact)` 里，三条规矩（都是为了不拿更弱的信息覆盖更强的已知事实）：
  1. 事实确认合并 → `merged`；
  2. 事实说 `open` 而卡片已经是 `draft` → **保留 `draft`**（不能让 draft 降级成 open）；
  3. 事实是 `closed` 但 `merged` 未知（tea CLI 兜底拿不到这个位）而卡片已知 `merged` → **保留 `merged`**。
- 评论正文原样落库：实测最长 ~3 900 字（一条事件几 KB），**不做截断**。
- 编号与卡片对不上就跳过（同步器已按已绑编号过滤，投影层只兜底）。

### 9.2 投影（`PROJECTION_VERSION` → **v6**）

- `issue.state.changed`：只改 `issue.state` / `issue.title`，`repo`/`url` **原样保留**（closed ≠ 清空）。`IssueRef` 不加 `updatedAt`（它只服务幂等键与差异比较）。
- `remote.comment.added` → **新槽位** `Card.remoteComments: Array<{id, issueNumber, author, body, at, url, read}>`：与本地评论分开存（`card.comments` 是本地事实），同 id 只投影一次。
- `remote.comments.read`：把 payload `{ids}` 里那些置 `read:true`（只置位，不删记录）。
- pr 三个事件**不用改投影**：payload 就是完整 `PrRef`（沿用原有 `pr.bound/pr.updated/pr.merged` 分支）。

### 9.3 已读（新命令）

`cmd markRemoteCommentsRead { card, ids? }` → 事件 `remote.comments.read { ids }`（`ids` 不给 = 当前全部未读）。
**一条未读都没有时不发事件**，所以连着调两次的第二次是空操作（幂等）；幂等键 `remote-read:{card}:{sha1(ids)}`。
前端在**打开卡片详情**时自动调它（`actor = {kind:"human", name:"看板"}`）。

### 9.4 store 记住的东西（`meta` 表，按项目，**不进事件流**）

键 `sync:{projectId}` → `{ at, degraded, notes, counts, prev?, lastError? }`：

| 字段 | 用途 |
|---|---|
| `at` | `lastSyncAt`；`since` 游标 = `at - 60 s`（`SINCE_OVERLAP_MS`） |
| `prev` | 上一轮的 `{issues, pulls, commentKeys}`，喂 `toFacts(prev, next, {numbers})`；丢了也能跑（`dedupeKey` 兜底） |
| `degraded` / `notes` / `counts` | 给 UI 显示「最后同步 / 本轮数据可能不全」 |
| `lastError` | 整体没跑成的原因（没凭据等）；成功一轮后清掉 |

两条自保规则（都有测试钉住）：
- **值被写坏**（坏 JSON / 形状不对）→ 当"没同步过"，不让一次坏值把同步卡死；
- **游标只在该前进时前进**：整体没跑成（`reason != null`）→ 完全不动 `at`；**评论端点降级** → 也不动 `at`（那段窗口还没读到，推进等于永久丢掉，下轮重读同一窗口）。

### 9.5 调度（`src/server/syncer.ts` + `src/server/main.ts`）

- `setInterval`，`FLOWCARD_SYNC_INTERVAL_MS` 默认 **300000**（`0` = 关，定时器 `unref()`，不拖住退出）；
  启动日志会写「同步 每 600s / 已关闭」。
- 每轮只跑「非虚拟 + 有 remote + **至少一张卡绑了编号**」的项目；上一轮没跑完就跳过这一拍（远程慢时宁可少跑，不排长队）；
  **启动时不立刻同步**（不拿启动时间赌网络）。
- 有凭据时一轮的调用面（`test/sync-wire.test.ts` 用注入假 http 钉死）：
  每个已绑编号一次 `GET /issues/{n}`、`GET /pulls/{n}`（实测 ~5.8 KB / ~17 KB）+ **每仓库一次** `GET /issues/comments?since=…` 后按已绑编号过滤；
  **断言过：一轮里没有 `/issues?` / `/pulls?` 列表请求**。
  **接了通知 hook 时**再给每个已绑 PR 加一次只读的 CI 读（Gitea `GET /commits/{head分支}/status`；
  GitHub 先 `GET /commits/{ref}/check-runs`，没有 check run 再退回 `/status`）—— 只为「CI 结束」通知判状态变化，
  没接 hook（或 `dry-run`）时**连这一次都不发**；读不到就只留一句 `notes`，**不进 `degraded[]`**（它不牵着游标）。
- `--list`（手动）才走 `pollRemote` 的全量列表：实测 250 条 PR ≈ 15 s（对照：3 个精确读一轮 ≈ 5–10 s）。默认路径**不翻列表**。

### 9.6 HTTP / CLI

| 形态 | 名字 | 实际行为 |
|---|---|---|
| HTTP | `POST /api/projects/:id/sync` | body `{since?, list?, dryRun?}` → `SyncRoundReport`：`{projectId, fetchedAt, since, reason, source, counts{issues,pulls,comments}, facts, applied, duplicates, degraded, notes, numbers{issues,pulls}, dryRun, cardIds, types, factList?(dryRun)}` |
| HTTP | `GET /api/projects/:id/sync` | `{lastSyncAt, degraded, notes, counts, lastError, tracked{issues,pulls}}`（纯读，不联网） |
| CLI | `node src/cli/sync.ts <项目 id 或路径 \| 卡片 id> [--since ISO] [--list] [--dry-run] [--port]` | 独立入口；`flowcard sync …` 由 `src/cli/main.ts` 转发到它 |
| 后台 | `FLOWCARD_SYNC_INTERVAL_MS` | 见 §9.5 |

- **永不返回 token**：`SyncAuth.token` 只进请求头，报告/状态里没有凭据字段（测试断言响应体、事件流、卡片投影里都没有 token 值）。
- **整体跑不成不是 HTTP 错误**：没凭据/没传输 → 200 + `reason` + `notes`（端点级问题进 `degraded[]`，那不是失败）。
- 退出码：`0` 成功 / `2` 用法错 / `3` 项目或卡片不存在、remote 认不出 / `4` 无凭据（`no-credentials` / `no-transport`）/ `5` 服务不可达。
- 项目参数接受三种形态：项目 id、仓库路径（走 `/api/project/current`）、**卡片 id**（用卡片的 `projectId`）。

### 9.7 前端

- **磁贴**：`card.remoteComments` 里未读条数 > 0 → 「N 条新评论」徽标（`data-testid="tile-remote-unread"`）。
- **详情「远端动态」**：作者 / 时间 / markdown 正文 /「在远端打开」链接 + 已读·未读标记（未读的那条带浅蓝底）；进详情**自动 `markRemoteCommentsRead`** → 磁贴徽标随之清零（幂等：已全读时服务端不发事件）。
- **项目面板**：「最后同步 刚刚 / 还没同步过 / 同步失败：<reason>」+「本轮数据可能不全（N）」（悬停看每个降级端点的 reason/detail）+「已绑 N issue / M PR」+「立即同步」按钮，结果写在提示行（成功会报这一轮读了什么、落了什么、挡住多少重复）。

### 9.8 与 §9 原清单的偏离（都是接线时定的）

- 新增命令 `markRemoteCommentsRead` + 事件 `remote.comments.read`（原清单只说"通过新命令置位"）；
- 同步状态进 **`meta` 表**而不是事件流（它是"我们什么时候看过远程"，不是业务事实）；
- `dryRun`、`list`、`lastError`、「评论降级时卡住游标」、「首次同步没有游标」的提醒，都是接线时补的；
- 首次同步的坑写在 §10 的最后一条（评论端点没有 `since` 时给的是**最早**一页）。

## 10. 已知限制

- **PR 列表没有 `since`**（两家都没有；Gitea 还会静默忽略这个参数）→ 只能取「最近更新在前」的 250 条，老 PR 会滑出窗口。绑定到卡片的编号请用 `fetchPull` 精确读。
- **`tea` CLI 兜底信息不全**：没有 `merged`（`merged:null`）、没有评论、没有 `since`；`author` 是显示名而不是 login（实测 CLI 给的是「董羽秦」这类名字，API 给的是 `suzmii`）。
- **Gitea 的 draft**：API 的 pull 对象有 `draft` 字段，但本实现没把它并进 `state`（规格只要求 `open`/`closed`/`merged`）；要 draft 的话在 `parsePull` 里加一个 `draft` 位即可。
- **评论的编辑**：`sync:comment:{id}` 只按 id 去重 —— 评论被**编辑**不会产生新事实（只有新评论会）。要跟编辑就得把 `updated_at` 并进幂等键。
- **`since` 只对 issues/comments 有效**：issue 的 `updated_at` 变了（改标题/加标签）也会进窗口，于是会发一条状态未变但 `updatedAt` 变了的 `issue.state` 事实 —— 无害（引擎设相同的值），但会多一次引擎调用。
- **删除的条目**：某条 issue/PR 从列表消失（被删/转私有）不会被发现，也不会发「消失」事实。
- **`toFacts` 的 `prev` 是内存/存储里的快照**：进程重启后 `prev` 若丢了，首轮会重发一遍（被 `dedupeKey` 挡住，不会重复落库）。
- 自建 Gitea 的 URL 可能是 `http://`（本机实测 PR 的 `html_url` 就是 http）——原样记录，不做规范化、不升级 scheme。
- **评论端点没有 `since` 时给的是"最早"一页（不是最新）**：接线时真跑发现的 —— 全新项目（还没有 `lastSyncAt`）第一轮拿不到新评论，
  只会拿到仓库最早的 50 条。对策已在接线里：这一轮的报告会带一句提醒，给人 `--since <ISO>`（或先 `--list`）这条明确出路；
  第二轮的 `since` 游标一起就正常了。
- **编号绑错类型**：把 PR 当 issue 绑（例如 #738 其实是 PR）→ `fetchIssue` 会因为响应里带 `pull_request` 而判 `parse-error`，
  该编号进 `degraded[]` 并在 notes 里说清；把那张卡改绑成 PR 即可（不会瞎猜、不会静默）。

## 11. 复现

```bash
npx tsc --noEmit                          # 全仓类型干净
npx vitest run test/sync.test.ts          # 31 个用例（传输层，离线）
npx vitest run test/sync-wire.test.ts     # 23 个用例（接线层，离线）
npx vitest run                            # 全量（含上面两个）

# 端到端（只读；临时实例 + 真项目）
FLOWCARD_DATA_DIR=/tmp/fc-sync-wire FLOWCARD_PORT=47846 npm start &
node src/cli/main.ts project add ~/workspace/repo
node src/cli/main.ts open --issue 742 --project <项目 id>
node src/cli/main.ts sync <项目 id> --since <ISO> --dry-run   # 只打印将产生的事实
node src/cli/main.ts sync <项目 id> --since <ISO>             # 真落一库（仍然只有 GET）

# 真跑（只读；用 /tmp 下的临时脚本，不往仓库加文件）
mkdir -p /tmp/fc-sync && cat > /tmp/fc-sync/real.ts <<'EOF'
import { execFileSync } from "node:child_process";
import { pollRemote, readTeaConfig, resolveSyncTarget } from "/home/<you>/workspace/flowcard/src/server/sync.ts";
const repo = "/home/<you>/workspace/repo";
const remote = execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
console.log(resolveSyncTarget({ remote, teaConfig: readTeaConfig(), env: process.env }));
const since = new Date(Date.now() - 86400_000).toISOString();
console.log(await pollRemote({ remote, repoPath: repo, since, teaConfig: readTeaConfig(), env: process.env }));
EOF
node /tmp/fc-sync/real.ts
```
