/**
 * 附件（图片）：校验 + 落盘 + 读取。
 *
 * 三条硬规矩：
 *   1. **MIME 白名单**（png/jpeg/gif/webp）——**不收 svg**：svg 里能塞脚本，等于把 XSS 面挂上看板；
 *      而且声明什么不算数，**按文件头字节嗅探**，与声明不符一律拒（`text/plain` 改名成 .png 也进不来）。
 *   2. 单文件 ≤ 10 MB。
 *   3. `id` = 内容 sha256 前 16 位 → 内容寻址：同一张图重复上传是同一个 id（天然去重 + 幂等）。
 *
 * 落盘路径 `<dir>/<id>.<ext>`；路径由 id + 扩展名推出，所以元数据表里不用存路径。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGE_MIMES, type Attachment, type ImageMime } from "../shared/types.ts";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** id 取内容 sha256 的前 16 个十六进制字符。 */
const ID_LEN = 16;

export const EXT_BY_MIME: Record<ImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** 反向表（CLI 上传时按文件扩展名定 Content-Type；jpeg/jpg 都算 image/jpeg）。 */
export const MIME_BY_EXT: Record<string, ImageMime> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export type AttachmentRejection = {
  code: "UNSUPPORTED_MEDIA" | "TOO_LARGE" | "MISMATCHED_CONTENT";
  message: string;
  hint?: string;
};

export type AttachmentCheck = { ok: true; mime: ImageMime } | { ok: false; error: AttachmentRejection };

/** 附件目录（`<dataDir>/attachments`）：建一次，存/取都走它。 */
export function attachmentsDir(dataDir: string): string {
  const dir = join(dataDir, "attachments");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 内容 sha256 前 16 位。 */
export function attachmentIdFor(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, ID_LEN);
}

/** 只认前几个字节：png/jpeg/gif/webp 的文件头都是无歧义的。 */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  const at = (i: number): number => bytes[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif";
  if (
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** `image/png; charset=utf-8` → `image/png`。 */
function normalizeMime(raw: string | undefined): string {
  return (raw ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * 校验：大小 → 声明类型在白名单里 → 文件头嗅探出来的类型与声明一致。
 * 三步分开报错，因为人需要知道**哪一条**不满足（是选错文件还是改错了名）。
 */
export function checkAttachment(input: { mime: string | undefined; bytes: Uint8Array }): AttachmentCheck {
  const { bytes } = input;
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: {
        code: "TOO_LARGE",
        message: `附件 ${bytes.byteLength} 字节，超过上限 ${MAX_ATTACHMENT_BYTES} 字节（10 MB）`,
        hint: "先压缩或裁剪再传",
      },
    };
  }

  const declared = normalizeMime(input.mime);
  if (!(IMAGE_MIMES as readonly string[]).includes(declared)) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_MEDIA",
        message: `只接受 ${IMAGE_MIMES.join(" / ")}，收到 "${declared === "" ? "(没给 Content-Type)" : declared}"`,
        hint: "不收 svg（可执行脚本）与文本：换成 png/jpeg/gif/webp",
      },
    };
  }

  const sniffed = sniffImageMime(bytes);
  if (sniffed === null) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_MEDIA",
        message: `字节看起来不是图片（没有 png/jpeg/gif/webp 的文件头）`,
        hint: "声明成图片但内容是别的格式/文本：先把文件本身处理成真图片",
      },
    };
  }
  if (sniffed !== declared) {
    return {
      ok: false,
      error: {
        code: "MISMATCHED_CONTENT",
        message: `声明的类型 ${declared} 与实际内容 ${sniffed} 不符`,
        hint: `按内容存不会算错：把 Content-Type 改成 ${sniffed} 再传`,
      },
    };
  }

  return { ok: true, mime: sniffed };
}

export type AttachmentInput = { name: string; mime: string | undefined; bytes: Uint8Array };

export type SaveOutcome =
  | { ok: true; attachment: Attachment; created: boolean }
  | { ok: false; error: AttachmentRejection };

/** 原始文件名只作记录：去掉目录分隔与控制字符，空则给个占位名。 */
function safeName(raw: string, mime: ImageMime): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]+/g, "_")
    .trim();
  return (cleaned === "" ? `image.${EXT_BY_MIME[mime]}` : cleaned).slice(0, 200);
}

/**
 * 校验 + 落盘 + 组装元数据。**幂等**：内容一样 → id 一样 → 文件已在就什么都不写，
 * `created:false`（元数据表也由 store 侧按 id 去重）。
 */
export function saveAttachment(dir: string, input: AttachmentInput, now: string): SaveOutcome {
  const checked = checkAttachment({ mime: input.mime, bytes: input.bytes });
  if (!checked.ok) return { ok: false, error: checked.error };

  const ext = EXT_BY_MIME[checked.mime];
  const id = attachmentIdFor(input.bytes);
  const file = join(dir, `${id}.${ext}`);
  let created = false;
  try {
    // wx：已存在就说明内容早就存过（内容寻址），不算错。
    writeFileSync(file, input.bytes, { flag: "wx" });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  return {
    ok: true,
    created,
    attachment: {
      id,
      mime: checked.mime,
      ext,
      name: safeName(input.name, checked.mime),
      bytes: input.bytes.byteLength,
      at: now,
    },
  };
}

/** 按 id + 扩展名读字节；文件不在（比如手工删了）返回 undefined，由调用方回 404。 */
export function readAttachmentBytes(dir: string, attachment: Attachment): Uint8Array | undefined {
  try {
    return readFileSync(join(dir, `${attachment.id}.${attachment.ext}`));
  } catch {
    return undefined;
  }
}

/** 附件对外的地址与可贴进正文/评论的 markdown：**唯一定义处**（URL 形状只在这里写一次）。 */
export function attachmentRef(id: string): { url: string; markdown: string } {
  const url = `/api/attachments/${id}`;
  return { url, markdown: `![](${url})` };
}
