import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, HelpCircle } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { Badge } from "@/components/ui/badge";
import { SESSION_STATE_LABELS, type Session } from "@/lib/contract";
import type { CardView } from "@/lib/schema";
import { timeAgo } from "@/lib/utils";

/**
 * omp 上报扩展的路径。这是"单机自用"的部署事实：flowcard 的仓库就是适配器所在处。
 * 换成 omp 扩展安装后（`omp install <这个目录>`），会话里就不再需要 `-e` 了。
 */
const OMP_ADAPTER_PATH = "~/workspace/flowcard/src/adapters/omp/flowcard-omp-adapter.ts";

const SESSION_TONE: Record<string, "success" | "warning" | "danger" | "muted"> = {
  idle: "muted",
  running: "success",
  ended: "muted",
  lost: "danger",
};

/** 恢复命令：session.resumeHint 优先，其次按 harness 约定生成。 */
function resumeCommand(session: Session): string {
  if (session.resumeHint) return session.resumeHint;
  if (session.harness === "omp") return `omp -r ${session.id}`;
  return `${session.harness} -r ${session.id}`;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2 py-0.5">
      <span className="w-16 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 text-xs">{children}</span>
    </div>
  );
}

export function SessionPanel({ card }: { card: CardView }) {
  const session = card.session;
  const worktree = card.worktree;

  if (!session) {
    // 卡片天生就有"它自己的会话"——只是那次会话还没启动。
    // 会话是 harness 里的一个真实进程（omp 的 session id 只有它启动时才存在），
    // flowcard 造不出来，所以这里给的是**确切可复制的启动命令**。
    const startHere = worktree ? worktree.path : null;
    const startCommand = startHere ? `cd ${startHere} && omp` : null;
    const startWithAdapter = startHere
      ? `cd ${startHere} && omp -e ${OMP_ADAPTER_PATH}`
      : null;

    return (
      <div className="space-y-2 rounded-lg border border-dashed bg-muted/40 p-2.5 text-xs">
        <p className="text-muted-foreground">
          这张卡的会话<strong className="font-medium text-foreground">还没启动</strong>
          。会话就是干这活儿的那个 agent 进程——在卡片的 worktree 里启动它，
          它会自动认到这张卡（按 cwd 解析，不用手填卡片 id）。
        </p>
        {startCommand && startWithAdapter ? (
          <>
            <div className="flex items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate rounded bg-background px-1.5 py-1 font-mono">{startCommand}</code>
              <CopyButton value={startCommand} label="复制启动命令" />
            </div>
            <p className="text-muted-foreground">
              还没把上报扩展装进 omp？那就显式带上它（同样在 worktree 里跑）：
            </p>
            <div className="flex items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate rounded bg-background px-1.5 py-1 font-mono">{startWithAdapter}</code>
              <CopyButton value={startWithAdapter} label="复制（带扩展）" />
            </div>
          </>
        ) : (
          <p className="text-muted-foreground">
            这张卡还没有 worktree：先在「必要项目」里绑一个（
            <code className="font-mono">flowcard worktree {card.id} --path .worktrees/{card.id} --branch &lt;前缀&gt;/{card.id}</code>
            ），再回到这里启动会话。
          </p>
        )}
      </div>
    );
  }

  const inside = worktree ? session.cwd.startsWith(worktree.path) : null;

  return (
    <div className="space-y-2 rounded-lg border bg-background p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">{session.harness}</Badge>
        <Badge variant={SESSION_TONE[session.state] ?? "muted"}>
          {SESSION_STATE_LABELS[session.state] ?? session.state}
        </Badge>
        <Badge variant="muted">{session.agentKind === "sub" ? "子会话" : "主会话"}</Badge>
        <span className="ml-auto text-xs text-muted-foreground">
          心跳 {timeAgo(session.lastSeenAt)}
        </span>
      </div>

      <Row label="会话 id">
        <span className="break-all font-mono">{session.id}</span>
      </Row>
      <Row label="cwd">
        <span className="break-all font-mono">{session.cwd}</span>
      </Row>
      {session.file ? (
        <Row label="会话文件">
          <span className="break-all font-mono">{session.file}</span>
        </Row>
      ) : null}
      <Row label="开始">
        <span className="font-mono">{session.startedAt}</span>
      </Row>

      {inside === null ? (
        <div className="flex items-center gap-1.5 rounded border border-dashed p-2 text-xs text-muted-foreground">
          <HelpCircle className="size-3.5" />
          没有 worktree，无法判定会话是否在 worktree 内
        </div>
      ) : inside ? (
        <div className="flex items-center gap-1.5 rounded border border-emerald-600/30 bg-emerald-50 p-2 text-xs text-emerald-800">
          <CheckCircle2 className="size-3.5" />
          会话在 worktree 内（cwd 落在 {worktree?.path}）
        </div>
      ) : (
        <div className="flex items-start gap-1.5 rounded border-2 border-red-600 bg-red-50 p-2 text-xs font-medium text-red-800">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <span className="font-bold">会话不在 worktree 内！</span> cwd 与 worktree.path 不一致，改动会落在主仓库上。
            <span className="mt-0.5 block break-all font-mono text-[11px]">
              cwd={session.cwd} ≠ worktree={worktree?.path}
            </span>
          </span>
        </div>
      )}

      <div className="flex items-center gap-2 rounded border bg-muted/40 p-2">
        <span className="min-w-0 flex-1 break-all font-mono text-xs">{resumeCommand(session)}</span>
        <CopyButton value={resumeCommand(session)} label="复制恢复命令" />
      </div>
    </div>
  );
}
