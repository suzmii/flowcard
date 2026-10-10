# flowcard

一个人用的工作台：**一张卡片 = 一次 agent 会话**，每张卡必须携带 **Issue / worktree / PR / 清理** 四项交付要件；流程是固定的一段可执行代码，节点分自动与人工两类。

- 设计：`docs/design.md`（先读这个）
- 选型与明确否决项：`docs/adr/0001-stack.md`
- omp 会话上报适配器实测与坑：`src/adapters/omp/README.md`
- git/PR 探测：`docs/probe.md`
- 提交图与代码评审（只读 + 本地记录）：`docs/design.md` §12

## 快速开始

```bash
npm start                       # 起服务，默认 http://127.0.0.1:47825
                                # 数据在 ~/.local/share/flowcard（可用 FLOWCARD_DATA_DIR 覆盖）
npm run cli -- list             # 或 node src/cli/main.ts list
```

看板由服务自己发（`GET /` → `web/dist`）。所以**第一次要先构建一次前端**：

```bash
npm run web:install && npm run web:build     # 之后改前端只需再跑 web:build 并重启服务
```

本机已装成用户级常驻服务：`systemctl --user status|restart flowcard`，开机/登录自启（`Linger=yes`，登出也不停）。
改完前端要 `npm run web:build && systemctl --user restart flowcard`。

CLI 是 agent 的唯一写入口，stdout 恒为一行 JSON：

```bash
node src/cli/main.ts project add ~/workspace/myrepo     # 先登记项目（看板 Metadata：读 git 远程/分支/最近提交）
node src/cli/main.ts open --body "## 修好登录页…"        # 建卡：标题可选（服务端按正文派生），项目按 cwd 解析
node src/cli/main.ts attach ~/shot.png                  # 传图，打印 ![](/api/attachments/<id>) 直接贴进正文
node src/cli/main.ts open --title "做点事" --issue myrepo#12 --url https://…/issues/12
node src/cli/main.ts worktree c1 --path .worktrees/x --branch <前缀>/x   # 前缀看改动性质：feat/fix/chore/…
node src/cli/main.ts claim c1 --harness omp --session <id> --cwd .worktrees/x
node src/cli/main.ts pr c1 --number 7 --url https://…/pulls/7 --branch <前缀>/x
node src/cli/main.ts push c1 --sha <sha>
node src/cli/main.ts confirm c1 --request --for push --detail "git push -u origin <分支>"
node src/cli/main.ts confirm c1 --list                  # 人看完 detail 再批：只覆盖这一次动作
node src/cli/main.ts confirm c1 --approve cf1 --reason "看过了"
node src/cli/main.ts confirm c1 --consume cf1           # agent 执行完回报：这条授权作废
node src/cli/main.ts end c1 --summary "做完了"
node src/cli/main.ts accept c1                          # 人验收
node src/cli/main.ts cleanup c1 --item "删 .worktrees/x" --item "删分支 <前缀>/x"
node src/cli/main.ts gate c1 --gate G4 --approve && node src/cli/main.ts cleanup c1
node src/cli/main.ts diff c1                            # 看这一片的 diff（JSON 摘要；--patch 打原始 unified diff）
node src/cli/main.ts review c1 --comment --path src/x.ts --line 12 --body "这里要判空"
node src/cli/main.ts review c1 --approve --body "看过了"  # 判定只记录，不改流程状态（验收仍走 accept）
node src/cli/main.ts review c1 --list                    # 看评论与判定（outdated = 锚的 sha 已经不是当前 head）
```

退出码：`0` 成功 / `2` 用法错 / `3` 状态或门禁不允许 / `4` **缺必要条件**（JSON 里写明缺哪项）/ `5` 服务不可达。

**缺必要条件不是报错而是回报**：命令带来的事实照样落库（比如会话记录），只是状态不前进——agent 拿到 `blocked.missing` 就能自己补齐。

## 卡片上的四项交付要件（永远是槽位，空着也显示）

Issue → worktree+分支 → WIP PR → 推送记录 → 验收 → 清理。硬门禁：**建卡即 `ready`（Issue 不是开工前置）**、**会话没进 worktree 不算开工**、无 PR 或没推送不许进 `review`（PR 挡交付、不挡开工）、人未验收或 PR 未合并不许进 `merged`、未清理不许 `done`、**PR 合并前绝不清理**。人只做三件事：远程写授权、验收、清理确认。

## 接 omp（会话自动上报）

```bash
# 在卡片的 worktree 里启动，卡片会自动 ready → working
FLOWCARD_CARD=c1 omp -e /path/to/workspace/flowcard/src/adapters/omp/flowcard-omp-adapter.ts
```

适配器在 `session_start` 上报 `claim`、按间隔上报心跳、退出时上报 `end`；端不上服务只写日志，绝不影响会话。细节见 `src/adapters/omp/README.md`。

## 结构

```
src/shared/    契约（zod 命令/事件类型）、流程原语、路径工具
src/flow/      流程定义（TS 代码：状态、门禁、requires、自动动作）
src/server/    引擎（纯函数）、投影、存储（SQLite 事件日志 + 投影表）、HTTP/SSE、探测
src/cli/       命令行入口
src/adapters/  harness 适配器（omp）
web/           看板前端
test/          引擎/存储/HTTP/探测/运行时测试
```

## 不做什么

不做 agent 编排（执行归 harness）、不做多用户与鉴权（只监听回环）、不做 CI 系统、也不做远程审查面（提交图/diff 只读本地 git，评审记录留在本地、不回写 forge）、不接 Jira/云同步/桌面壳、不引入 agent 框架。
