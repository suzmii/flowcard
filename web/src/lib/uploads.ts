/**
 * 图片附件上传：`POST /api/attachments?name=<文件名>`（body = 原始字节，Content-Type = 图片 MIME）。
 * 客户端先拦一层（类型/大小），服务端还会再拒一次 —— 两边的理由都要能展示出来。
 */
import { z } from "zod";
import { apiUrl, readErrorBody, unreachableMessage } from "@/lib/api";
import { describeIssues } from "@/lib/schema";

/** 服务端上限；前端先挡，避免白白传 10MB+ 的字节。 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const ALLOWED_IMAGE_MIME = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

const attachmentSchema = z.looseObject({
  id: z.string(),
  url: z.string(),
  markdown: z.string(),
  bytes: z.number().optional(),
  mime: z.string().optional(),
});

export type UploadOutcome =
  | { ok: true; id: string; url: string; markdown: string }
  | { ok: false; message: string };

/** 客户端拦截理由；返回 null 表示放行（服务端可能还有别的意见）。 */
export function validateImage(file: File): string | null {
  const mime = file.type.toLowerCase();
  if (!ALLOWED_IMAGE_MIME.includes(mime as (typeof ALLOWED_IMAGE_MIME)[number])) {
    return `不是支持的图片类型（${mime || "未知类型"}）：只收 png / jpeg / gif / webp。`;
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return `图片太大（${mb} MB）：上限 10 MB。`;
  }
  return null;
}

export async function uploadImage(file: File, signal?: AbortSignal): Promise<UploadOutcome> {
  const invalid = validateImage(file);
  if (invalid) return { ok: false, message: invalid };

  const name = file.name.trim() === "" ? `paste-${Date.now()}` : file.name;
  let res: Response;
  try {
    res = await fetch(apiUrl(`/api/attachments?name=${encodeURIComponent(name)}`), {
      method: "POST",
      headers: { "content-type": file.type.toLowerCase() },
      body: file,
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { ok: false, message: unreachableMessage(error) };
  }

  if (res.status === 404) return { ok: false, message: "服务端还没有 POST /api/attachments（附件接口未实现）" };
  if (!res.ok) return { ok: false, message: `上传失败（HTTP ${res.status}）：${await readErrorBody(res)}` };

  const parsed = attachmentSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    return { ok: false, message: `附件响应不符合契约：${describeIssues(parsed.error)}` };
  }
  return { ok: true, id: parsed.data.id, url: parsed.data.url, markdown: parsed.data.markdown };
}
