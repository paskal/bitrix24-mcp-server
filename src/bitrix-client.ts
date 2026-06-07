const MIN_REQUEST_INTERVAL_MS = 500; // 2 req/sec for webhooks

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// bitrix24 wraps list responses with total/next at the top level alongside result
interface BitrixRawResponse {
  result: unknown;
  total?: number;
  next?: number;
  time?: Record<string, unknown>;
  error?: string;
  error_description?: string;
}

export class BitrixClient {
  private webhookUrl: string;
  private queue: Promise<void> = Promise.resolve();
  private lastRequestTime = 0;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl.endsWith("/") ? webhookUrl : webhookUrl + "/";
  }

  async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<{ result: T } & BitrixRawResponse> {
    return new Promise((resolve, reject) => {
      this.queue = this.queue
        .then(async () => {
          const elapsed = Date.now() - this.lastRequestTime;
          if (elapsed < MIN_REQUEST_INTERVAL_MS) {
            await sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
          }
          this.lastRequestTime = Date.now();

          const url = `${this.webhookUrl}${method}`;
          const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params ?? {}),
          });

          if (!response.ok) {
            const text = await response.text();
            throw new Error(`Bitrix24 API ${response.status}: ${text}`);
          }

          const data = (await response.json()) as BitrixRawResponse;

          if (data.error) {
            throw new Error(`Bitrix24: ${data.error} — ${data.error_description ?? ""}`);
          }

          resolve(data as { result: T } & BitrixRawResponse);
        })
        .catch(reject);
    });
  }

  async callList<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    maxPages = 20,
    extractItems?: (result: unknown) => T[],
  ): Promise<{ items: T[]; total: number }> {
    const allItems: T[] = [];
    let start = 0;
    let total = 0;

    const defaultExtract = (result: unknown): T[] => {
      if (Array.isArray(result)) return result as T[];
      if (result && typeof result === "object" && "tasks" in result) {
        return (result as { tasks: T[] }).tasks;
      }
      throw new Error(`Unexpected list response shape: ${JSON.stringify(result).substring(0, 200)}`);
    };

    const extract = extractItems ?? defaultExtract;

    for (let page = 0; page < maxPages; page++) {
      const response = await this.call(method, { ...params, start });

      allItems.push(...extract(response.result));
      total = response.total ?? allItems.length;

      if (!response.next) break;
      start = response.next;
    }

    return { items: allItems, total };
  }

  // Upload a local file to a Bitrix24 disk folder via the standard 2-step REST flow.
  // Returns the new disk-file ID, suitable for use as "n<id>" in UF_TASK_WEBDAV_FILES.
  async uploadFileToFolder(
    folderId: number,
    filePath: string,
    fileName?: string,
  ): Promise<{ diskFileId: number; name: string; size: number }> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");

    const absPath = path.resolve(filePath);
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) throw new Error(`Not a file: ${absPath}`);
    const buf = await fs.readFile(absPath);
    const name = fileName ?? path.basename(absPath);

    // Step 1: request an upload URL from B24
    const step1 = await this.call<{ field: string; uploadUrl: string }>(
      "disk.folder.uploadfile",
      { id: folderId, data: { NAME: name, generateUniqueName: 1 } },
    );
    const uploadUrl = step1.result.uploadUrl;
    if (!uploadUrl) throw new Error("disk.folder.uploadfile returned no uploadUrl");

    // Step 2: POST file binary as multipart/form-data
    const form = new FormData();
    const blob = new Blob([new Uint8Array(buf)], { type: "application/octet-stream" });
    form.append(step1.result.field ?? "file", blob, name);
    const upResp = await fetch(uploadUrl, { method: "POST", body: form });
    if (!upResp.ok) {
      const text = await upResp.text();
      throw new Error(`disk upload ${upResp.status}: ${text.substring(0, 300)}`);
    }
    const upJson = (await upResp.json()) as { result?: { ID?: number; NAME?: string; SIZE?: string } };
    if (!upJson.result?.ID) throw new Error(`disk upload bad response: ${JSON.stringify(upJson).substring(0, 300)}`);

    return {
      diskFileId: Number(upJson.result.ID),
      name: upJson.result.NAME ?? name,
      size: Number(upJson.result.SIZE ?? stat.size),
    };
  }

  // Post an IM message into a chat with an inline-rendered IMAGE preview.
  //
  // Bitrix renders an image preview in chat ONLY for IM-message ATTACH blocks of shape
  //   [{ IMAGE: [{ NAME, LINK }] }]
  // — ONE image per message. Stacking multiple parallel attaches in a single message renders
  // visually broken (the second image's preview placeholder shows as a torn-paper icon with
  // a large empty area, even when the second file is accessible — verified 2026-05-19 in
  // task chat 183218). Callers wanting multiple images should call this once per image.
  //
  // Other shapes that look right but silently fail:
  //   - Multiple images inside one IMAGE array → "Incorrect attach params"
  //   - Explicit BLOCKS wrapper around IMAGE → "Incorrect attach params"
  //   - FILE_ID[] / UPLOAD_FILE_ID params → silently dropped, message posts as plain text
  //
  // The LINK must be a B24 disk showFile URL: https://<portal>/disk/showFile/<diskFileId>/
  // — the chat client knows how to fetch a preview from this in the user's auth context.
  async postChatMessageWithImage(
    chatId: number,
    message: string,
    image: { diskFileId: number; name: string },
  ): Promise<{ messageId: number }> {
    const portalBase = this.webhookUrl.replace(/\/rest\/.*$/, "");
    const resp = await this.call<number>("im.message.add", {
      CHAT_ID: chatId,
      MESSAGE: message,
      ATTACH: [{
        IMAGE: [{ NAME: image.name, LINK: `${portalBase}/disk/showFile/${image.diskFileId}/` }],
      }],
    });
    return { messageId: resp.result };
  }

  // Resolve the recording disk-file id for a call activity (Voximplant/Mango).
  // Returns null when the call has no recording (missed/declined).
  async getCallRecordingFileId(activityId: number): Promise<number | null> {
    const resp = await this.call<Array<{ RECORD_FILE_ID?: string | number | null }>>(
      "voximplant.statistic.get",
      { FILTER: { CRM_ACTIVITY_ID: activityId } },
    );
    const rows = resp.result ?? [];
    for (const r of rows) {
      if (r.RECORD_FILE_ID) return Number(r.RECORD_FILE_ID);
    }
    return null;
  }

  // Get a disk file's authenticated download URL + name.
  async getDiskFileDownloadUrl(fileId: number): Promise<{ name: string; url: string }> {
    const resp = await this.call<{ NAME?: string; DOWNLOAD_URL?: string }>("disk.file.get", { id: fileId });
    const url = resp.result?.DOWNLOAD_URL;
    if (!url) throw new Error(`disk.file.get(${fileId}) returned no DOWNLOAD_URL`);
    return { name: resp.result?.NAME ?? `file-${fileId}`, url };
  }

  // Download a (typically auth-tokened) URL to a temp file; returns the local path.
  async downloadToTemp(url: string, suffix = ".mp3"): Promise<string> {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`download ${resp.status}: ${(await resp.text()).substring(0, 200)}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "b24rec-"));
    const out = path.join(dir, `recording${suffix}`);
    await fs.writeFile(out, buf);
    return out;
  }

  async batch<T = unknown>(commands: Record<string, string>): Promise<Record<string, T>> {
    const response = await this.call<{
      result: Record<string, T>;
      result_error: Record<string, unknown>;
    }>("batch", { cmd: commands });

    const batchResult = response.result;
    const errors = batchResult.result_error;
    if (errors && Object.keys(errors).length > 0) {
      throw new Error(`Batch errors: ${JSON.stringify(errors)}`);
    }

    return batchResult.result;
  }
}
