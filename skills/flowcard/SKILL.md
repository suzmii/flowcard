---
name: flowcard
description: 用 flowcard 工作台干活（看板 + 一张卡=一次会话）。当你要开卡、绑 Issue/PR/worktree、认领会话、推进卡片状态、或做代码评审（diff/行级评论/判定）时用。CLI 是模型唯一的写入口。
---

# flowcard 是什么

个人工作台：**一张卡片 = 一次 agent 会话**，卡片必须携带 **Issue / worktree / WIP PR / 推送 / 验收 / 清理** 六项交付要件。流程是固定的状态机，卡在哪一步由事实驱动；缺东西时命令**不会静默成功**，会按退出码告诉你缺什么。

- 服务地址：`http://127.0.0.1:47825`（也可用 `FLOWCARD_URL` / `FLOWCARD_PORT` 覆盖）
- CLI：`flowcard <命令> <card> [选项…]`（stdout 恒为一行 JSON）
- 设计细节：`~/workspace/flowcard/docs/design.md`

# 铁律

1. **别自己编造状态**：卡片状态只能靠命令推进，命令会校验前置条件。
2. **退出码 4 = 缺必要条件**，不是报错：事实已经落库，只是状态没前进；照着 JSON 里的 `blocked.missing` 补齐再重试。
3. **会话必须待在 worktree 里**：`cwd` 不在卡片的 worktree 内就不算开工（`ready → working` 会被拦）。omp 用 `/wt <分支>` 或 `/move <路径>` 把会话移进去。
4. **远程写要人批**：想 push / 开 PR / 合并 / 远程评论，先申请确认（见下"远程写确认"），一次批准**只覆盖一次动作**，执行完要 `--consume`。
5. **验收与门禁只能人点**：`accept`（验收）、`gate --approve`（批准方案）、`cleanup`（清理）这些是**人的动作**，模型不要代点；`cleanup` 还要先由人批准 G4。
6. **PR 合并前不许拆现场**：worktree、夹具、临时脚本在 PR 合并前一律保留。
7. **不要动别人的 `/tmp`**；自己的临时物自己清。

# 命令速查

```bash
# 立项
flowcard open --body "需求正文（标题可省，服务端会派生）" [--title "…"] [--project <id>]
flowcard issue <card> --number 742                 # 只填数字：repo/url 由项目基址拼
flowcard triage <card> [--body "备注"]             # 收件箱 → 立 Issue（人确认要做）

# 开工
flowcard worktree <card> --path .worktrees/x --branch feat/x
flowcard pr <card> --number 7 --url <PR 链接> --branch feat/x
flowcard claim <card> --harness omp --session <id> --cwd <worktree 路径>
flowcard beat <card> --session <id> --cwd <worktree 路径>     # 心跳（适配器会自动发）

# 干活与交付
flowcard push <card> --sha <sha>
flowcard comment <card> --body "…"
flowcard block <card> --reason "缺什么"   /   flowcard unblock <card>
flowcard end <card> --session <id> --summary "做完什么"
flowcard spawn <card> --title "…"                  # 同一 Issue 下再开一片（新 PR、新会话）

# 探测（只读，自动回写）
flowcard detect <card>                             # 从 cwd 反查 worktree/分支，读 PR 与 CI
flowcard probe <card> --number 7 --state merged …   # 汇报 PR 状态（merged 会推动状态）

# 代码评审（本地记录，不发远程）
flowcard diff <card> [--patch]                     # 看改动
flowcard review <card> --comment --path a.ts --line 12 --side new --body "…"
flowcard review <card> --approve | --request-changes [--body "…"]
flowcard review <card> --list

# 看
flowcard list / flowcard show <card> [--json 恒开]
```

`--harness <omp|codex|claude|other> --session-id <id>` 用来标注归属；`claim`/`beat`/`end` 里会话身份由参数给出。

# 状态机

```
inbox ──确认要做/绑 Issue──▶ issue ──G1 人批方案 + Issue──▶ ready
ready ──会话 claim（且 cwd 在 worktree 内）──▶ working
working ──会话结束──▶ review ──人验收 + PR merged──▶ merged ──G4 人批清理──▶ done
任意未完成 ──drop──▶ dropped        缺前置 ──block──▶ blocked ──unblock──▶ working
```

硬门禁（缺了就按退出码 4 回来）：

| 转换 | 缺什么会拦 |
|---|---|
| `issue → ready` | 必须有 Issue 且 G1 已批 |
| `ready → working` | 必须有 worktree、有 PR、**会话 cwd 在 worktree 内** |
| `working → review` | 必须有 PR、至少一条推送记录 |
| `review → merged` | 必须有人验收、PR 已 merged |
| `merged → done` | 清理必须已（经人批准后）执行 |

# 远程写确认（一事一议）

```bash
flowcard confirm <card> --request --for push --detail "git push -u origin feat/x"
flowcard confirm <card> --list                      # 看有没有批过、批的是哪一次
flowcard confirm <card> --consume cf1               # 执行完回报：这张授权作废
```

- 只在 `--list` 看到某条是 `approved` 且**没用过**时才能执行对应动作；
- 批准的是**那一条确切命令**，换命令要重新申请；
- 被驳回就停下问人，不要换个说法再申请一遍。

# 什么时候必须停下来问人

- 需要批准（G1/G3/G4）、需要远程写授权、需要**验收**
- 命令连续两次因同一个缺项被拦（说明前提不成立，不是重试能解决的）
- 要动别人的分支/PR/Issue、要清理现场、要删数据
- PR 合并前想拆复现环境（一律先报告再等人点头）
