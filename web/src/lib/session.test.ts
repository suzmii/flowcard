/** 托管会话的事件归并：按 id 追加/覆盖、按 callId 合并工具块、快照 vs 本地流。纯函数，不需要浏览器。 */
import { describe, expect, it } from "vitest";
import {
  applySessionEvent,
  initialSessionView,
  mergeSessionSnapshot,
  mergeToolOutput,
  parseSessionEvent,
  type SessionView,
} from "./session.ts";

function feed(view: SessionView, name: string, payload: Record<string, unknown>): SessionView {
  const event = parseSessionEvent(name, JSON.stringify(payload));
  if (!event) throw new Error(`认不出的 ${name} 帧：${JSON.stringify(payload)}`);
  return applySessionEvent(view, event, "2026-10-10T12:00:00.000Z");
}

describe("parseSessionEvent", () => {
  it("坏 JSON / 缺关键字段的帧直接丢掉", () => {
    expect(parseSessionEvent("message", "{oops")).toBeNull();
    expect(parseSessionEvent("message", JSON.stringify({ textDelta: "hi" }))).toBeNull();
    expect(parseSessionEvent("tool", JSON.stringify({ callId: "c1", phase: "start" }))).toBeNull();
    expect(parseSessionEvent("unknown", JSON.stringify({ id: "m1" }))).toBeNull();
  });

  it("工具输出是对象时归一化成文本", () => {
    const event = parseSessionEvent("tool", JSON.stringify({ callId: "c1", name: "bash", phase: "update", output: { stdout: "ok" } }));
    expect(event).toMatchObject({ type: "tool", output: '{\n  "stdout": "ok"\n}' });
  });
});

describe("applySessionEvent", () => {
  it("message 追加 textDelta，message_end 用权威文本覆盖同一条", () => {
    let view = initialSessionView();
    view = feed(view, "message", { id: "m1", role: "assistant", textDelta: "你" });
    view = feed(view, "message", { id: "m1", role: "assistant", textDelta: "好" });
    expect(view.session.messages).toHaveLength(1);
    expect(view.session.messages[0]?.text).toBe("你好");

    view = feed(view, "message_end", { id: "m1", role: "assistant", text: "你好！", at: "2026-10-10T12:00:01.000Z" });
    expect(view.session.messages).toHaveLength(1);
    expect(view.session.messages[0]?.text).toBe("你好！");
    expect(view.session.messages[0]?.at).toBe("2026-10-10T12:00:01.000Z");
  });

  it("不跨 id 合并", () => {
    let view = initialSessionView();
    view = feed(view, "message", { id: "m1", role: "assistant", textDelta: "A" });
    view = feed(view, "message", { id: "m2", role: "assistant", textDelta: "B" });
    expect(view.session.messages.map((message) => message.text)).toEqual(["A", "B"]);
  });

  it("工具块按 callId 归并：start 建块 → update 追加 → end 收尾", () => {
    let view = initialSessionView();
    view = feed(view, "tool", { callId: "c1", name: "bash", phase: "start", args: { cmd: "ls" } });
    view = feed(view, "tool", { callId: "c1", name: "bash", phase: "update", output: "a\n" });
    view = feed(view, "tool", { callId: "c1", name: "bash", phase: "update", output: "b\n" });
    view = feed(view, "tool", { callId: "c1", name: "bash", phase: "end", output: "a\nb\n", isError: true });

    expect(view.session.messages).toHaveLength(1);
    const tool = view.session.messages[0]?.tool;
    expect(tool?.name).toBe("bash");
    expect(tool?.status).toBe("end");
    expect(tool?.output).toBe("a\nb\n");
    expect(tool?.isError).toBe(true);
  });

  it("state 帧更新 busy/status/cost，notice/error 进提示流", () => {
    let view = initialSessionView();
    view = feed(view, "state", { busy: true, status: "running", cost: { total: 0.1234 } });
    expect(view.session).toMatchObject({ busy: true, status: "running", cost: { total: 0.1234 } });

    view = feed(view, "notice", { level: "warning", message: "没有 worktree" });
    view = feed(view, "error", { message: "会话挂了" });
    expect(view.notices.map((notice) => [notice.level, notice.message])).toEqual([
      ["warn", "没有 worktree"],
      ["error", "会话挂了"],
    ]);
  });
});

describe("mergeToolOutput", () => {
  it("累计快照替换、增量追加、重复片段忽略", () => {
    expect(mergeToolOutput("a\n", "a\nb\n")).toBe("a\nb\n");
    expect(mergeToolOutput("a\n", "b\n")).toBe("a\nb\n");
    expect(mergeToolOutput("a\nb\n", "b\n")).toBe("a\nb\n");
    expect(mergeToolOutput("a\n", "")).toBe("a\n");
  });
});

describe("mergeSessionSnapshot", () => {
  it("流到一半的文本不被落后一步的快照打回去，本地独有的消息留在尾部", () => {
    let view = initialSessionView();
    view = feed(view, "message", { id: "m1", role: "assistant", textDelta: "流到一半的更长文本" });
    view = feed(view, "message", { id: "m2", role: "assistant", textDelta: "还没落盘" });

    const merged = mergeSessionSnapshot(view.session, {
      status: "running",
      cwd: "/tmp/wt",
      busy: false,
      messages: [
        { id: "m1", role: "assistant", at: "2026-10-10T11:59:00.000Z", text: "旧" },
        { id: "m0", role: "user", at: "2026-10-10T11:58:00.000Z", text: "在吗" },
      ],
    });

    expect(merged.cwd).toBe("/tmp/wt");
    expect(merged.messages.map((message) => [message.id, message.text])).toEqual([
      ["m1", "流到一半的更长文本"],
      ["m0", "在吗"],
      ["m2", "还没落盘"],
    ]);
  });
});
