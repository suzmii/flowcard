---
name: flowcard
description: 用 flowcard 工作台干活（一张卡 = 一次会话）。当你要开卡、绑 Issue/PR/worktree、启动/接续会话、推进卡片状态、做代码评审（diff/行级评论/判定）时用。CLI 是模型唯一的写入口。
---

# flowcard 是什么

个人工作台：**一张卡片 = 一次 agent 会话**。卡片上固定挂着六个"必要项目"——Issue、worktree、WIP PR、推送记录、验收、清理；**列只表示状态，不表示流程阶段**，状态由事实自动推进。

**人只做三件事**：远程写授权、验收、清理确认。其余全部由事实推进——你干活，状态自己走。

- 服务：`http://127.0.0.1:47825`（`FLOWCARD_URL` / `FLOWCARD_PORT` 可覆盖）
- CLI：`flowcard <命令> <card> [选项…]`，stdout 恒为一行 JSON
- 细节：`~/workspace/flowcard/docs/design.md`

# 干活的主线（就这四步）

```bash
flowcard open --body "需求正文（标题可省，服务端派生）"     # ① 开卡：直接落「待开工」
flowcard worktree <card> --path .worktrees/x --branch feat/x   # ② 绑 worktree
cd .worktrees/x && omp -e ~/workspace/flowcard/src/adapters/omp/flowcard-omp-adapter.ts
                                                          # ③ 在 worktree 里启动会话：
                                                          #    按 cwd 自动认卡 → 自动进「实施中」
flowcard issue <card> --number 742    # Issue 只填数字，repo/url 由项目基址拼出来
flowcard pr <card> --number 7 --url <链接> --branch feat/x     # WIP PR（交付要件）
flowcard push <card> --sha <sha>      # 推送记录（进度要看得见）
flowcard end <card> --summary "做完什么"                       # ④ 交回 → 自动进「待验收」
```

- **不要**自己编造状态，也别把"卡片状态"当成需要你去推进的流程——你只负责产生事实（worktree/PR/推送/会话）。
- 会话必须是**在卡片的 worktree 里**跑的那个（`cwd` 不在 worktree 内会被拦）；omp 用 `/wt <分支>` 或 `/move <路径>` 进去。
- subagent 会话**不绑卡片**（一张卡只有一个主会话）；它们归 harness 自己管。

# 状态与门禁（只有这四条会拦你）

```
待开工 ──会话在 worktree 里起来──▶ 实施中 ──会话结束──▶ 待验收
待验收 ──人验收 + PR merged──▶ 已合并待清理 ──G4 人批清理──▶ 完成
任意未完成 ──drop──▶ 已放弃            缺前置 ──block──▶ 阻塞 ──unblock──▶ 实施中
```

| 转换 | 缺什么会被拦（退出码 4） |
|---|---|
| `待开工 → 实施中` | 卡片的 worktree、**会话 cwd 在 worktree 内** |
| `实施中 → 待验收` | 有 PR、至少一条推送记录 |
| `待验收 → 已合并` | 人已验收、PR 已 merged |
| `已合并 → 完成` | 清理已（经人批准 G4 后）执行 |

**退出码 4 不是报错**：事实已经落库，只是状态没前进；照着 JSON 的 `blocked.missing` 补齐再重试（同一缺项连拦两次就停下来问人，别硬试）。

# 远程写（一事一议）

```bash
flowcard confirm <card> --request --for push --detail "git push -u origin feat/x"
flowcard confirm <card> --list      # 只有 approved 且没用过的授权才能执行
flowcard confirm <card> --consume cf1   # 执行完回报：作废
```

一次批准**只覆盖那一条确切命令**；换命令（哪怕改一个字、换分支）都要重新申请；被驳回就停下问人。

# 代码评审（本地记录，不发远程）

```bash
flowcard diff <card> [--patch]
flowcard review <card> --comment --path a.ts --line 12 --side new --body "…"
flowcard review <card> --approve | --request-changes [--body "…"]
flowcard review <card> --list
```

`approve` 只是记录意见，**不改卡片状态**——验收仍然只能人点。

# 探测

```bash
flowcard detect <card>     # 从 cwd 反查 worktree/分支，只读读 PR 与 CI，把能拿到的回写卡片
flowcard probe <card> --number 7 --state merged …   # 汇报 PR 状态（merged 会推动状态）
```

# 什么时候必须停下来问人

- 需要**远程写授权**、**验收**（G3）、**清理批准**（G4）
- 同一缺项**连续两次**被拦（前提不成立，重试无用）
- 要动别人的分支/PR/Issue、要清理现场、要删数据
- **PR 合并前想拆复现环境**：一律先报告再等人点头
