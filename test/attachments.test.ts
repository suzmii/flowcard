/**
 * 附件（图片）：白名单 / 大小上限 / 内容 sha 命名与去重 / 幂等 / 存取一致 / HTTP 头。
 * 用的是**真图片字节**（PNG 是真 1×1 PNG；其余是各自格式的合法文件头，校验只看文件头）。
 */
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { personalFlow } from "../src/flow/personal.ts";
import { createApp } from "../src/server/app.ts";
import {
  EXT_BY_MIME,
  MAX_ATTACHMENT_BYTES,
  MIME_BY_EXT,
  attachmentIdFor,
  attachmentRef,
  checkAttachment,
  sniffImageMime,
} from "../src/server/attachments.ts";
import { createStore, type Store } from "../src/server/store.ts";
import { IMAGE_MIMES, type ImageMime } from "../src/shared/types.ts";

/** 1×1 透明 PNG（合法文件头 + IHDR/IDAT/IEND）。 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
// 其余三种只保证文件头合法（校验只嗅探文件头，不解码图像）。
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const GIF = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // "GIF89a"
  0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x3b,
]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from("WEBPVP8 ", "ascii"),
  Buffer.from([0x0e, 0x00, 0x00, 0x00]),
]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const TEXT = Buffer.from("这其实是一个文本文件\n", "utf8");

const FIXTURE: Record<ImageMime, Buffer> = {
  "image/png": PNG,
  "image/jpeg": JPEG,
  "image/gif": GIF,
  "image/webp": WEBP,
};

function harness(): { store: Store; app: Hono } {
  const store = createStore({
    dataDir: mkdtempSync(join(tmpdir(), "flowcard-attach-")),
    flow: personalFlow,
  });
  return { store, app: createApp(store) };
}

async function upload(
  app: Hono,
  body: Buffer | Uint8Array,
  opts: { mime: string; name?: string },
): Promise<{ status: number; data: Record<string, unknown> }> {
  const path = `/api/attachments?name=${encodeURIComponent(opts.name ?? "shot.png")}`;
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": opts.mime },
    body: new Uint8Array(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  return { status: res.status, data };
}

describe("附件校验（纯）", () => {
  it("按文件头认类型：四种图都对，文本/svg/空文件都不认", () => {
    for (const [mime, bytes] of Object.entries(FIXTURE)) {
      expect(sniffImageMime(bytes)).toBe(mime);
    }
    expect(sniffImageMime(SVG)).toBeNull();
    expect(sniffImageMime(TEXT)).toBeNull();
    expect(sniffImageMime(new Uint8Array())).toBeNull();
  });

  it("扩展名 ↔ MIME 两张表自洽（CLI 按扩展名定 Content-Type）", () => {
    for (const mime of IMAGE_MIMES) {
      expect(MIME_BY_EXT[EXT_BY_MIME[mime]]).toBe(mime);
      expect(FIXTURE[mime].byteLength).toBeGreaterThan(0);
    }
    expect(MIME_BY_EXT.jpeg).toBe("image/jpeg");
  });

  it("svg 与文本一律拒绝（声明成图片也没用）", () => {
    // svg 走白名单就出局；文本即使声明成 image/png，也被文件头嗅探拦住。
    expect(checkAttachment({ mime: "image/svg+xml", bytes: SVG }).ok).toBe(false);
    expect(checkAttachment({ mime: "text/plain", bytes: TEXT }).ok).toBe(false);

    const textAsPng = checkAttachment({ mime: "image/png", bytes: TEXT });
    expect(textAsPng.ok).toBe(false);
    if (!textAsPng.ok) expect(textAsPng.error.code).toBe("UNSUPPORTED_MEDIA");

    const noContentType = checkAttachment({ mime: undefined, bytes: PNG });
    expect(noContentType.ok).toBe(false);
    if (!noContentType.ok) expect(noContentType.error.code).toBe("UNSUPPORTED_MEDIA");
  });

  it("声明与内容不符 → MISMATCHED_CONTENT", () => {
    const mismatched = checkAttachment({ mime: "image/jpeg", bytes: PNG });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.error.code).toBe("MISMATCHED_CONTENT");
  });

  it("大小上限 10MB：正好 10MB 放行，多一个字节就 TOO_LARGE", () => {
    const atLimit = Buffer.alloc(MAX_ATTACHMENT_BYTES);
    atLimit.set(PNG.subarray(0, 8));
    expect(checkAttachment({ mime: "image/png", bytes: atLimit }).ok).toBe(true);

    const over = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
    over.set(PNG.subarray(0, 8));
    const tooLarge = checkAttachment({ mime: "image/png", bytes: over });
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) {
      expect(tooLarge.error.code).toBe("TOO_LARGE");
      expect(tooLarge.error.message).toContain("10 MB");
    }
  });
});

describe("附件存取（store）", () => {
  it("id = 内容 sha256 前 16 位；同内容重复上传幂等且保留第一次的文件名", () => {
    const { store } = harness();
    const expectedId = createHash("sha256").update(PNG).digest("hex").slice(0, 16);

    const first = store.appendAttachment({ name: "第一次.png", mime: "image/png", bytes: PNG });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.created).toBe(true);
    expect(first.attachment.id).toBe(expectedId);
    expect(first.attachment.id).toBe(attachmentIdFor(PNG));
    expect(first.attachment.bytes).toBe(PNG.byteLength);
    expect(first.attachment.ext).toBe("png");

    const again = store.appendAttachment({ name: "另一个名字.png", mime: "image/png", bytes: PNG });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.created).toBe(false);
    expect(again.attachment.id).toBe(expectedId);
    expect(again.attachment.name).toBe("第一次.png");

    store.close();
  });

  it("校验不过就什么都不落盘（也不写元数据）", () => {
    const { store } = harness();
    expect(store.appendAttachment({ name: "x.svg", mime: "image/svg+xml", bytes: SVG }).ok).toBe(false);
    expect(store.getAttachment(attachmentIdFor(SVG))).toBeUndefined();
    store.close();
  });

  it("读回来的字节与 MIME 与存进去的一致（四种格式都过一遍）", () => {
    const { store } = harness();
    for (const mime of IMAGE_MIMES) {
      const bytes = FIXTURE[mime];
      const saved = store.appendAttachment({ name: `x.${EXT_BY_MIME[mime]}`, mime, bytes });
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      const back = store.getAttachment(saved.attachment.id);
      expect(back?.attachment.mime).toBe(mime);
      expect(Buffer.from(back?.bytes ?? new Uint8Array())).toEqual(bytes);
    }
    expect(store.getAttachment("不存在的id")).toBeUndefined();
    store.close();
  });
});

describe("附件 HTTP", () => {
  it("上传回 url/markdown/bytes/mime；GET 回的 Content-Type 与字节一致且可长缓存", async () => {
    const { store, app } = harness();
    const id = attachmentIdFor(PNG);

    const res = await upload(app, PNG, { mime: "image/png", name: "看板截图.png" });
    expect(res.status).toBe(200);
    expect(res.data.id).toBe(id);
    expect(res.data.mime).toBe("image/png");
    expect(res.data.bytes).toBe(PNG.byteLength);
    expect(res.data.name).toBe("看板截图.png");

    const ref = attachmentRef(id);
    expect(res.data.url).toBe(ref.url);
    expect(res.data.url).toBe(`/api/attachments/${id}`);
    expect(res.data.markdown).toBe(ref.markdown);
    expect(res.data.markdown).toBe(`![](${ref.url})`);

    const got = await app.request(ref.url);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("cache-control")).toContain("max-age=31536000");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await got.arrayBuffer())).toEqual(PNG);

    // 同一张图再传一次：还是 200，但 created:false，id 不变（内容寻址）
    const again = await upload(app, PNG, { mime: "image/png", name: "另一个名字.png" });
    expect(again.status).toBe(200);
    expect(again.data.id).toBe(id);
    expect(again.data.created).toBe(false);
    store.close();
  });

  it("svg / 文本 / 类型不符 → 415；超 10MB → 413；不存在的 id → 404", async () => {
    const { store, app } = harness();
    expect((await upload(app, SVG, { mime: "image/svg+xml", name: "x.svg" })).status).toBe(415);
    expect((await upload(app, TEXT, { mime: "text/plain", name: "x.txt" })).status).toBe(415);
    expect((await upload(app, TEXT, { mime: "image/png", name: "x.png" })).status).toBe(415);
    expect((await upload(app, PNG, { mime: "image/gif", name: "x.gif" })).status).toBe(415);

    const over = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
    over.set(PNG.subarray(0, 8));
    expect((await upload(app, over, { mime: "image/png", name: "big.png" })).status).toBe(413);

    expect((await app.request("/api/attachments/deadbeefdeadbeef")).status).toBe(404);
    store.close();
  });
});
