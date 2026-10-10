import {
  CircleDot,
  GitBranch,
  GitPullRequest,
  HardDriveUpload,
  Trash2,
  UserCheck,
} from "lucide-react";
import type { ReactNode } from "react";
import { IssueBinder } from "@/components/detail/IssueBinder";
import type { CommandRunner } from "@/components/detail/GatePanel";
import { Badge } from "@/components/ui/badge";
import type { CardView } from "@/lib/schema";
import { cn, timeAgo } from "@/lib/utils";

/** 格子里的动作归属：本地动作（在这台机器上做）还是远程写（要到 GitHub 这类远端做）。 */
const KIND_LABEL = {
  local: "本地动作",
  remote: "远程写",
} as const;

function Slot({
  label,
  icon,
  kind,
  filled,
  emptyHint,
  children,
}: {
  label: string;
  icon: ReactNode;
  kind: keyof typeof KIND_LABEL;
  filled: boolean;
  emptyHint: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border p-2.5",
        filled ? "border-border bg-background" : "border-dashed bg-muted/40",
      )}
      data-slot={label}
      data-filled={filled}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">{icon}</span>
        <span className="text-xs font-medium">{label}</span>
        <Badge variant={kind === "remote" ? "info" : "muted"} className="ml-auto">
          {KIND_LABEL[kind]}
        </Badge>
      </div>
      <div className="text-sm">
        {filled ? (
          children
        ) : (
          <div className="space-y-1.5">
            <span className="text-xs text-muted-foreground">空 · {emptyHint}</span>
            {/* 空槽位也要能就地动作（例：Issue 槽位的「绑定 Issue」） */}
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

/** 六个必要项目格：空着也必须渲染，并在空槽位旁写明该动作是本地动作还是远程写。 */
export function SlotGrid({
  card,
  defaultIssueRepo,
  busy,
  onRun,
}: {
  card: CardView;
  /** 当前项目的 remote 短形：绑定 Issue 时预填 repo */
  defaultIssueRepo?: string;
  busy?: string | null;
  onRun?: CommandRunner;
}) {
  const latestPush = card.pushes.at(-1);

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Slot
        label="Issue"
        icon={<CircleDot className="size-3.5" />}
        kind="remote"
        filled={card.issue !== null}
        emptyHint="还没建/绑定 issue（先有人在 GitHub 建，再绑）"
      >
        {card.issue ? (
          <div className="space-y-0.5">
            <a
              className="font-mono text-sky-700 underline underline-offset-2"
              href={card.issue.url}
              target="_blank"
              rel="noreferrer"
            >
              {card.issue.repo}#{card.issue.number}
            </a>
            <div className="flex items-center gap-1.5">
              <Badge variant={card.issue.state === "open" ? "success" : "muted"}>
                {card.issue.state}
              </Badge>
              {card.issue.title ? (
                <span className="truncate text-xs text-muted-foreground" title={card.issue.title}>
                  {card.issue.title}
                </span>
              ) : null}
            </div>
          </div>
        ) : onRun ? (
          <IssueBinder
            card={card}
            defaultRepo={defaultIssueRepo ?? ""}
            busy={busy ?? null}
            onRun={onRun}
          />
        ) : null}
      </Slot>

      <Slot
        label="worktree"
        icon={<GitBranch className="size-3.5" />}
        kind="local"
        filled={card.worktree !== null}
        emptyHint="还没建 worktree（本机 .worktrees/<名字>）"
      >
        {card.worktree ? (
          <div className="space-y-1">
            <div className="break-all font-mono text-xs">{card.worktree.path}</div>
            <div className="flex items-center gap-1.5">
              <Badge variant="outline">{card.worktree.branch}</Badge>
              <Badge variant="muted" title="谁建的 worktree">
                source={card.worktree.source}
              </Badge>
            </div>
          </div>
        ) : null}
      </Slot>

      <Slot
        label="WIP PR"
        icon={<GitPullRequest className="size-3.5" />}
        kind="remote"
        filled={card.pr !== null}
        emptyHint="还没开 PR（任务一开始就该开草稿 PR）"
      >
        {card.pr ? (
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <a
                className="font-mono text-sky-700 underline underline-offset-2"
                href={card.pr.url}
                target="_blank"
                rel="noreferrer"
              >
                {card.pr.repo}#{card.pr.number}
              </a>
              <Badge variant={card.pr.state === "merged" ? "success" : "outline"}>
                {card.pr.state}
              </Badge>
              <Badge
                variant={
                  card.pr.ci === "pass" ? "success" : card.pr.ci === "fail" ? "danger" : "muted"
                }
              >
                CI {card.pr.ci ?? "未知"}
              </Badge>
            </div>
            <div className="truncate font-mono text-xs text-muted-foreground" title={card.pr.branch}>
              {card.pr.branch}
            </div>
          </div>
        ) : null}
      </Slot>

      <Slot
        label="推送记录"
        icon={<HardDriveUpload className="size-3.5" />}
        kind="remote"
        filled={card.pushes.length > 0}
        emptyHint="还没有推送记录（进度要能每天看到）"
      >
        <div className="flex items-center gap-1.5" title={card.pushes.map((p) => p.sha).join("\n")}>
          <span className="font-mono text-base font-semibold">{card.pushes.length}</span>
          <span className="text-xs text-muted-foreground">条</span>
          {latestPush ? (
            <Badge variant="outline" className="font-mono" title={`最新推送 ${latestPush.at}`}>
              {latestPush.sha.slice(0, 7)} · {timeAgo(latestPush.at)}
            </Badge>
          ) : null}
        </div>
      </Slot>

      <Slot
        label="验收状态"
        icon={<UserCheck className="size-3.5" />}
        kind="local"
        filled={card.acceptedAt !== undefined}
        emptyHint="还没由人验收（门禁 G3）"
      >
        <Badge variant="success">
          已验收 · {timeAgo(card.acceptedAt)}（{card.acceptedAt?.slice(0, 10)}）
        </Badge>
      </Slot>

      <Slot
        label="清理状态"
        icon={<Trash2 className="size-3.5" />}
        kind="local"
        filled={card.cleanedAt !== undefined}
        emptyHint="现场还没清理（worktree / 分支 / 门禁 G4）"
      >
        <Badge variant="success">
          已清理 · {timeAgo(card.cleanedAt)}（{card.cleanedAt?.slice(0, 10)}）
        </Badge>
      </Slot>
    </div>
  );
}
