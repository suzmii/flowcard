/**
 * 卡片 git 事实的采集与**短缓存**（看板的阶段派生要用：`dirtyFiles` / `commitsSinceBase` / `baseBranch`）。
 *
 * 为什么要有缓存：`GET /api/cards` 会被 SSE 刷新反复打（`changed` 事件一来前端就重取），
 * 而一次 `probeGit` = 一串只读 git 子命令。卡片数量很少（个位数），但刷新很频繁，
 * 所以**每个 worktree 每 ~30s 只真正读一次 git**，期间所有请求复用同一份结果。
 *
 * 只读、只跑 git（不 fetch / 不写 config）；探测失败（worktree 被删、路径不是仓库、git 不在）
 * 一律记成「没有 git 事实」（`null`）—— 阶段派生会据此退化成只看卡片事实，而不是当成 0。
 */
import type { CardGitFacts } from "../shared/stage.ts";
import type { Card } from "../shared/types.ts";
import { defaultRun, probeGit, type Run } from "./probe.ts";

/** 缓存寿命：30 秒（够短到「刚改完代码再看一眼」是对的，够长到不拖慢 SSE 刷新）。 */
export const GIT_FACTS_TTL_MS = 30_000;

export type CardGitFactsCache = {
  /**
   * 取这批卡涉及的所有 worktree 的 git 事实。返回值按 **worktree 路径**索引
   * （同一 worktree 上的多张卡共用一份）；没有 worktree / 探测失败的路径**不在表里**。
   */
  collect: (cards: readonly Card[]) => Promise<Map<string, CardGitFacts>>;
  /** 缓存里有多少条 worktree（测试与排查用）。 */
  size: () => number;
  /** 清空缓存（测试用来模拟「缓存过期」）。 */
  clear: () => void;
};

export function createCardGitFactsCache(
  opts: { run?: Run; ttlMs?: number; now?: () => number } = {},
): CardGitFactsCache {
  const run = opts.run ?? defaultRun;
  const ttlMs = opts.ttlMs ?? GIT_FACTS_TTL_MS;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; facts: CardGitFacts | null }>();
  /** 同一个 worktree 的并发探测只跑一次（多张卡共用一个 worktree，或前后两个请求撞上）。 */
  const inflight = new Map<string, Promise<CardGitFacts | null>>();

  const readFacts = async (path: string): Promise<CardGitFacts | null> => {
    try {
      const probed = await probeGit(path, run);
      // `ok:false` = 这个 cwd 根本不在仓库里（路径没了 / 不是 worktree）→ 没有事实，别拿空值当 0。
      if (!probed.ok) return null;
      return {
        dirtyFiles: probed.signals.changedFiles,
        commitsSinceBase: probed.signals.commitsSinceBase,
        baseBranch: probed.signals.base,
      };
    } catch {
      // 执行器抛（超时上限之外的意外）不该把看板接口带崩：当作没有 git 事实。
      return null;
    }
  };

  const factsFor = async (path: string): Promise<CardGitFacts | null> => {
    const hit = cache.get(path);
    if (hit && now() - hit.at < ttlMs) return hit.facts;
    const running = inflight.get(path);
    if (running) return running;
    const task = readFacts(path).finally(() => inflight.delete(path));
    inflight.set(path, task);
    const facts = await task;
    cache.set(path, { at: now(), facts });
    return facts;
  };

  return {
    collect: async (cards) => {
      const paths = new Set<string>();
      for (const card of cards) {
        const path = card.worktree?.path;
        if (path) paths.add(path);
      }
      const facts = new Map<string, CardGitFacts>();
      await Promise.all(
        [...paths].map(async (path) => {
          const value = await factsFor(path);
          if (value) facts.set(path, value);
        }),
      );
      return facts;
    },
    size: () => cache.size,
    clear: () => {
      cache.clear();
    },
  };
}
