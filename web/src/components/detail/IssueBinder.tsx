/**
 * Issue 绑定入口：Issue 不再在新建卡片时填，改在详情页 Issue 槽位的空位上绑。
 * 三件套（repo / number / url）要么都填要么都不填，客户端先校验，服务端还会再校验一次。
 */
import { useState } from "react";
import { CircleDot } from "lucide-react";
import type { CommandRunner } from "@/components/detail/GatePanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CardView } from "@/lib/schema";

/** 校验三件套；返回第一条可读错误，null = 放行。 */
function validateIssue(repo: string, number: string, url: string): string | null {
  if (repo.trim() === "" || number.trim() === "" || url.trim() === "") {
    return "Issue 三件套必须成套填写：repo / number / url 要么都填、要么都不填。";
  }
  const parsed = Number(number.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return `Issue number 必须是正整数（当前是「${number.trim()}」）。`;
  }
  return null;
}

export function IssueBinder({
  card,
  defaultRepo,
  busy,
  onRun,
}: {
  card: CardView;
  /** 当前项目的 remote 短形，用来预填 repo */
  defaultRepo: string;
  busy: string | null;
  onRun: CommandRunner;
}) {
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState(defaultRepo);
  const [number, setNumber] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const invalid = validateIssue(repo, number, url);
    if (invalid) {
      setError(invalid);
      return;
    }
    await onRun("绑定 Issue", {
      cmd: "bindIssue",
      actor: { kind: "human", name: "me" },
      card: card.id,
      issue: { repo: repo.trim(), number: Number(number.trim()), url: url.trim() },
    });
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
            setRepo((prev) => (prev === "" ? defaultRepo : prev));
            setOpen(true);
          }}
        >
          <CircleDot />
          绑定 Issue
        </Button>
        <div className="text-[11px] text-muted-foreground">远程写：Issue 先在 GitHub 建，再把三件套绑进来</div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <label className="block space-y-1">
          <span className="text-[11px] text-muted-foreground">repo（owner/name）</span>
          <Input
            data-testid="issue-repo"
            value={repo}
            placeholder="owner/name"
            onChange={(event) => setRepo(event.target.value)}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[11px] text-muted-foreground">number</span>
          <Input
            data-testid="issue-number"
            className="w-20"
            inputMode="numeric"
            value={number}
            placeholder="123"
            onChange={(event) => setNumber(event.target.value)}
          />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-[11px] text-muted-foreground">url</span>
        <Input
          data-testid="issue-url"
          value={url}
          placeholder="https://…/issues/123"
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>

      {error ? (
        <div data-testid="issue-bind-error" role="alert" className="text-[11px] text-red-700">
          {error}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          size="xs"
          data-testid="issue-bind-submit"
          disabled={busy !== null}
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
