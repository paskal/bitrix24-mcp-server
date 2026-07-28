import type { BitrixClient } from "./bitrix-client.js";

// crm.activity.list returns FILES as bare {id, url} pairs with no name, size or type.
// Without the name an attachment is invisible to the reader: an outgoing email carrying
// «Счет - Спецификация № 727005.pdf» looks identical to one carrying only the signature
// logo. Every activity-listing tool therefore resolves the names through disk.file.get.

export type AttachmentKind = "document" | "call_recording" | "signature_image" | "image" | "other";

export interface ResolvedFile {
  id: number | string;
  url?: string;
  name?: string;
  size?: number;
  kind?: AttachmentKind;
  unresolved?: true;
}

export interface FilesSummary {
  documents: number;
  document_names: string[];
  call_recordings: number;
  signature_images: number;
  images: number;
  other: number;
}

const DOCUMENT_EXT = /\.(pdf|docx?|xlsx?|xlsm|csv|rtf|odt|ods|zip|rar|7z|dwg|dxf)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp|heic|tiff?)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|amr)$/i;

// Outlook/Bitrix inline signature logos arrive on nearly every outgoing email as
// image001.png, image002 (17).png and so on. They are not evidence of anything.
const SIGNATURE_IMAGE = /^image\d{2,}(\s*\(\d+\))?\.(png|jpe?g|gif)$/i;

function isCallActivity(activity: Record<string, unknown>): boolean {
  return String(activity.TYPE_ID) === "2" || activity.PROVIDER_TYPE_ID === "CALL";
}

export function classifyAttachment(name: string | undefined, onCallActivity: boolean): AttachmentKind {
  if (onCallActivity) return "call_recording";
  if (!name) return "other";
  if (DOCUMENT_EXT.test(name)) return "document";
  if (AUDIO_EXT.test(name)) return "call_recording";
  if (SIGNATURE_IMAGE.test(name)) return "signature_image";
  if (IMAGE_EXT.test(name)) return "image";
  return "other";
}

function summarise(files: ResolvedFile[]): FilesSummary {
  const summary: FilesSummary = {
    documents: 0,
    document_names: [],
    call_recordings: 0,
    signature_images: 0,
    images: 0,
    other: 0,
  };
  for (const file of files) {
    switch (file.kind) {
      case "document":
        summary.documents += 1;
        if (file.name) summary.document_names.push(file.name);
        break;
      case "call_recording":
        summary.call_recordings += 1;
        break;
      case "signature_image":
        summary.signature_images += 1;
        break;
      case "image":
        summary.images += 1;
        break;
      default:
        summary.other += 1;
    }
  }
  return summary;
}

// A batch that tolerates per-command failures: a deleted or permission-denied file id
// must not lose the names of the other 49 attachments in the same chunk.
async function tolerantBatch(
  client: BitrixClient,
  commands: Record<string, string>,
): Promise<Record<string, { NAME?: string; SIZE?: string | number } | undefined>> {
  const response = await client.call<{
    result: Record<string, { NAME?: string; SIZE?: string | number }>;
    result_error?: Record<string, unknown>;
  }>("batch", { cmd: commands });
  return response.result?.result ?? {};
}

/**
 * Enrich every FILES entry of the given activities with name, size and kind, and attach a
 * FILES_SUMMARY per activity. Mutates and returns the activities.
 *
 * Costs one extra REST round-trip per 50 attachments, and none at all when nothing in the
 * result set has an attachment.
 */
export async function resolveActivityAttachments(
  client: BitrixClient,
  activities: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const ids = new Set<string>();
  for (const activity of activities) {
    for (const file of (activity.FILES as ResolvedFile[] | undefined) ?? []) {
      if (file?.id !== undefined && file?.id !== null) ids.add(String(file.id));
    }
  }
  if (ids.size === 0) return activities;

  const idList = [...ids];
  const meta = new Map<string, { NAME?: string; SIZE?: string | number }>();
  for (let i = 0; i < idList.length; i += 50) {
    const chunk = idList.slice(i, i + 50);
    const commands: Record<string, string> = {};
    for (const id of chunk) commands[`f${id}`] = `disk.file.get?id=${encodeURIComponent(id)}`;
    let resolved: Record<string, { NAME?: string; SIZE?: string | number } | undefined> = {};
    try {
      resolved = await tolerantBatch(client, commands);
    } catch {
      // Whole-chunk failure: leave these ids unresolved rather than failing the listing.
      continue;
    }
    for (const id of chunk) {
      const row = resolved[`f${id}`];
      if (row) meta.set(id, row);
    }
  }

  for (const activity of activities) {
    const files = (activity.FILES as ResolvedFile[] | undefined) ?? [];
    if (files.length === 0) continue;
    const onCall = isCallActivity(activity);
    for (const file of files) {
      const row = meta.get(String(file.id));
      if (!row) {
        file.unresolved = true;
        file.kind = onCall ? "call_recording" : "other";
        continue;
      }
      file.name = row.NAME;
      if (row.SIZE !== undefined) file.size = Number(row.SIZE);
      file.kind = classifyAttachment(row.NAME, onCall);
    }
    activity.FILES_SUMMARY = summarise(files);
  }
  return activities;
}
