/**
 * Issue 绑定入口：**只填数字**。repo 与 url 由项目的 Issue 基址（`issueRepo` / `issueUrlTemplate`）
 * 拼出来，输入数字时实时预览要绑的链接；要绑特殊链接时才展开「高级（可选覆盖）」手填 repo / url。
 * 项目没设基址又没有 url 覆盖 → 前端直接拦下并说明该做什么（服务端也会再校验一次）。
 */
import { useState } from "react";
import { CircleDot } from "lucide-react";
import type { CommandRunner } from "@/components/detail/GatePanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { issueUrlFromTemplate, templateHasNumber, type IssueBase } from "@/lib/projects";
import type { CardView } from "@/lib/schema";

/** 项目没基址时的统一出路：两条，别让用户猜。 */
const NO_BASE_HINT = "这个项目还没有 Issue 基址：去项目面板填模板，或展开高级手动填 url";

/** Issue 编号：正整数，且不带前导零（`007` 这种基本是手滑）。 */
function parseIssueNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return null;
  return Number(trimmed);
}

export function IssueBinder({
  card,
  issueBase,
  busy,
  onRun,
}: {
  card: CardView;
  /** 当前项目的 Issue 基址（repo 短形 + URL 模板）；没有就是空对象 */
  issueBase?: IssueBase | null;
  busy: string | null;
  onRun: CommandRunner;
}) {
  const base = issueBase ?? {};
  const hasTemplate = Boolean(base.urlTemplate && templateHasNumber(base.urlTemplate));

  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState("");
  const [title, setTitle] = useState("");
  const [repo, setRepo] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  // null = 还没人手动开合过：默认按「有没有基址」展开（没基址时直接露出手填 url）
  const [advancedOpen, setAdvancedOpen] = useState<boolean | null>(null);

  const parsedNumber = parseIssueNumber(number);
  const repoOverride = repo.trim();
  const urlOverride = url.trim();
  const previewRepo = repoOverride !== "" ? repoOverride : (base.repo ?? "");
  const previewUrl =
    urlOverride !== "" ? urlOverride : issueUrlFromTemplate(base.urlTemplate, number);
  const previewLabel = `${previewRepo ? `${previewRepo}#` : "#"}${parsedNumber ?? "?"}`;
  // 前端先拦两种情况：连链接都拼不出来（缺基址），和链接有了但 repo 没处来（服务端也会再校验）
  const blockedReason =
    !hasTemplate && urlOverride === ""
      ? NO_BASE_HINT
      : previewRepo === ""
        ? "还差 repo（owner/name）：去项目面板填 Issue 基址，或展开高级填 repo"
        : null;
  const canSubmit = parsedNumber !== null && blockedReason === null;
  // 没基址时把「该做什么」一直摆在眼前，不用等提交失败才知道
  const errorText = error ?? blockedReason;

  const submit = async () => {
    setError(null);
    if (parsedNumber === null) {
      setError(`Issue 编号必须是正整数（当前是「${number.trim()}」）。`);
      return;
    }
    if (blockedReason !== null) {
      setError(blockedReason);
      return;
    }
    const command: Record<string, unknown> = {
      cmd: "bindIssue",
      actor: { kind: "human", name: "me" },
      card: card.id,
      number: parsedNumber,
    };
    // 高级覆盖才带字段：其余交给服务端按项目基址补齐
    if (repoOverride !== "") command.repo = repoOverride;
    if (urlOverride !== "") command.url = urlOverride;
    if (title.trim() !== "") command.title = title.trim();
    await onRun("绑定 Issue", command);
    setOpen(false);
  };

  if (!open) {
    return (
      <div className="space-y-1">
        <Button
          size="xs"
          variant="outline"
          data-testid="issue-bind-toggle"
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
        >
          <CircleDot />
          绑定 Issue
        </Button>
        <div className="text-[11px] text-muted-foreground">
          只填数字：链接由项目的 Issue 基址拼出来（没有基址时展开高级手填 url）
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_6rem] gap-2">
        <label className="block min-w-0 space-y-1">
          <span className="text-[11px] text-muted-foreground">标题（可选）</span>
          <Input
            data-testid="issue-title"
            value={title}
            placeholder="Issue 标题（服务端不抓取，纯记录）"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[11px] text-muted-foreground">编号 *</span>
          <Input
            data-testid="issue-number"
            inputMode="numeric"
            value={number}
            placeholder="742"
            onChange={(event) => setNumber(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
        </label>
      </div>

      <div
        data-testid="issue-preview"
        className="space-y-0.5 rounded border bg-muted/40 px-2 py-1.5 text-[11px]"
      >
        <div className="font-mono">{previewLabel}</div>
        <div className="break-all text-muted-foreground">
          {previewUrl !== null
            ? `${previewUrl}${urlOverride !== "" ? "（高级覆盖生效）" : "（由项目模板拼出）"}`
            : hasTemplate
              ? "填上编号就会拼出链接"
              : "还没有模板 —— 展开高级手填 url"}
        </div>
      </div>

      <details
        data-testid="issue-advanced"
        className="text-[11px]"
        open={advancedOpen ?? blockedReason !== null}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer text-muted-foreground">高级（可选覆盖）</summary>
        <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
          <label className="block min-w-0 space-y-1">
            <span className="text-[11px] text-muted-foreground">repo（owner/name）</span>
            <Input
              data-testid="issue-repo"
              value={repo}
              placeholder={base.repo ?? "owner/name（默认取项目基址）"}
              onChange={(event) => setRepo(event.target.value)}
            />
          </label>
          <label className="block min-w-0 space-y-1">
            <span className="text-[11px] text-muted-foreground">url</span>
            <Input
              data-testid="issue-url"
              value={url}
              placeholder="https://…/issues/742（默认按项目模板拼）"
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          只有链接不按模板走（别的仓库、别的 host）时才填；填了优先用这里的值。
        </div>
      </details>

      {errorText ? (
        <div data-testid="issue-error" role="alert" className="text-[11px] text-red-700">
          {errorText}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          size="xs"
          data-testid="issue-submit"
          disabled={busy !== null || !canSubmit}
          title={blockedReason ?? "用项目基址拼出链接并绑定"}
          onClick={() => void submit()}
        >
          {busy === "绑定 Issue" ? "绑定中…" : "绑定"}
        </Button>
        <Button size="xs" variant="ghost" onClick={() => setOpen(false)}>
          取消
        </Button>
      </div>
    </div>
  );
}
