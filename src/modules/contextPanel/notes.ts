import { renderMarkdownForNote } from "../../utils/markdown";
import {
  sanitizeText,
  escapeNoteHtml,
  getCurrentLocalTimestamp,
  getSelectedTextSourceIcon,
  normalizeSelectedTextSource,
} from "./textUtils";
import { normalizeAttachmentContentHash } from "./normalizers";
import { MAX_SELECTED_IMAGES } from "./constants";
import {
  getTrackedAssistantNoteForParent,
  removeAssistantNoteMapEntry,
  rememberAssistantNoteForParent,
} from "./prefHelpers";
import {
  ensureAttachmentBlobFromPath,
  extractManagedBlobHash,
  isManagedBlobPath,
} from "./attachmentStorage";
import { toFileUrl } from "../../utils/pathFileUrl";
import {
  ATTACHMENT_GC_MIN_AGE_MS,
  collectAndDeleteUnreferencedBlobs,
  replaceOwnerAttachmentRefs,
} from "../../utils/attachmentRefStore";
import type { ChatAttachment, Message, SelectedTextSource } from "./types";
import {
  isGlobalPortalItem,
  isPaperPortalItem,
  resolveNoteParentItem,
  resolveNoteTitle,
  resolvePaperPortalBaseItem,
} from "./portalScope";

export type NoteSnapshot = {
  noteId: number;
  noteItemKey?: string;
  title: string;
  html: string;
  text: string;
  libraryID: number;
  parentItemId?: number;
  parentItemKey?: string;
  noteKind: "item" | "standalone";
};

export function stripNoteHtml(html: string): string {
  if (!html) return "";
  let text = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function decodeNoteHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function isLikelyHtmlNoteContent(text: string): boolean {
  if (!text || !/[<>]/.test(text)) return false;
  return /<\/?(?:p|div|span|strong|b|em|i|u|a|ul|ol|li|blockquote|h[1-6]|br|hr|code|pre)\b/i.test(
    text,
  );
}

export function normalizeNoteSourceText(contentText: string): string {
  const raw = sanitizeText(contentText || "").trim();
  if (!raw) return "";
  if (!isLikelyHtmlNoteContent(raw)) return raw;

  let normalized = raw.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");

  normalized = normalized.replace(
    /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, _quote, href, text) => {
      const label = stripNoteHtml(text).trim();
      const decodedHref = decodeNoteHtmlEntities(`${href || ""}`).trim();
      if (!label) return decodedHref;
      return decodedHref ? `[${label}](${decodedHref})` : label;
    },
  );
  normalized = normalized.replace(
    /<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi,
    (_match, _tag, text) => `**${stripNoteHtml(text).trim()}**`,
  );
  normalized = normalized.replace(
    /<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi,
    (_match, _tag, text) => `*${stripNoteHtml(text).trim()}*`,
  );
  normalized = normalized.replace(
    /<code[^>]*>([\s\S]*?)<\/code>/gi,
    (_match, text) => `\`${stripNoteHtml(text).trim()}\``,
  );
  normalized = normalized.replace(
    /<pre[^>]*>([\s\S]*?)<\/pre>/gi,
    (_match, text) => `\n\n\`\`\`\n${decodeNoteHtmlEntities(stripNoteHtml(text))}\n\`\`\`\n\n`,
  );
  normalized = normalized.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");
  normalized = normalized.replace(/<br\s*\/?>/gi, "\n");
  normalized = normalized.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_match, level, text) =>
      `\n\n${"#".repeat(Number(level) || 1)} ${stripNoteHtml(text).trim()}\n\n`,
  );
  normalized = normalized.replace(/<li[^>]*>/gi, "\n- ");
  normalized = normalized.replace(/<\/li>/gi, "");
  normalized = normalized.replace(/<blockquote[^>]*>/gi, "\n\n> ");
  normalized = normalized.replace(/<\/blockquote>/gi, "\n\n");
  // Strip remaining HTML tags, but preserve <img> tags (for embedded figures)
  normalized = normalized.replace(/<(?!img\b)[^>]+>/g, "");
  normalized = decodeNoteHtmlEntities(normalized)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return normalized || stripNoteHtml(raw);
}

export function renderRawNoteHtml(contentText: string): string {
  const raw = normalizeNoteSourceText(contentText);
  if (!raw) return "<p></p>";
  try {
    return renderMarkdownForNote(raw);
  } catch (err) {
    ztoolkit.log("Note markdown render error:", err);
    return escapeNoteHtml(raw).replace(/\n/g, "<br/>");
  }
}

export function readNoteSnapshot(
  item: Zotero.Item | null | undefined,
): NoteSnapshot | null {
  if (!(item as any)?.isNote?.()) return null;
  const noteId = Number(item?.id);
  if (!Number.isFinite(noteId) || noteId <= 0) return null;
  const html = String((item as any).getNote?.() || "");
  const parentItem = resolveNoteParentItem(item);
  return {
    noteId: Math.floor(noteId),
    noteItemKey:
      typeof (item as any)?.key === "string" && (item as any).key.trim()
        ? (item as any).key.trim().toUpperCase()
        : undefined,
    title: resolveNoteTitle(item),
    html,
    text: stripNoteHtml(html),
    libraryID: Number(item?.libraryID) || 0,
    parentItemId: parentItem?.id,
    parentItemKey:
      typeof (parentItem as any)?.key === "string" && (parentItem as any).key.trim()
        ? (parentItem as any).key.trim().toUpperCase()
        : undefined,
    noteKind: parentItem ? "item" : "standalone",
  };
}

function resolveParentItemForNote(item: Zotero.Item): Zotero.Item | null {
  if (isGlobalPortalItem(item)) {
    return null;
  }
  if (isPaperPortalItem(item)) {
    return resolvePaperPortalBaseItem(item);
  }
  const noteParentItem = resolveNoteParentItem(item);
  if (noteParentItem) {
    return noteParentItem;
  }
  if ((item as any).isNote?.()) {
    return null;
  }
  if (item.isAttachment() && item.parentID) {
    return Zotero.Items.get(item.parentID) || null;
  }
  return item;
}

function buildAssistantNoteHtml(
  contentText: string,
  modelName: string,
): string {
  const response = sanitizeText(contentText || "").trim();
  const source = modelName.trim() || "unknown";
  const timestamp = getCurrentLocalTimestamp();
  const responseHtml = renderRawNoteHtml(response);
  return `<p><strong>${escapeNoteHtml(timestamp)}</strong></p><p><strong>${escapeNoteHtml(source)}:</strong></p><div>${responseHtml}</div><hr/><p>Written by LLM-for-Zotero plugin</p>`;
}

function renderChatMessageHtmlForNote(text: string): string {
  const safeText = sanitizeText(text || "").trim();
  if (!safeText) return "";
  // Reuse the same markdown-to-note rendering path as single-response save.
  return renderRawNoteHtml(safeText);
}

function normalizeScreenshotImagesForNote(images: unknown): string[] {
  if (!Array.isArray(images)) return [];
  const out: string[] = [];
  for (const raw of images) {
    if (typeof raw !== "string") continue;
    const src = raw.trim();
    if (!src) continue;
    // Persist only embedded image data URLs; blob/object URLs are ephemeral.
    if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(src)) continue;
    out.push(src);
    if (out.length >= MAX_SELECTED_IMAGES) break;
  }
  return out;
}

function formatScreenshotEmbeddedLabel(count: number): string {
  return `Screenshots (${count}/${MAX_SELECTED_IMAGES}) are embedded below`;
}

function normalizeFileAttachmentsForNote(
  attachments: unknown,
): ChatAttachment[] {
  if (!Array.isArray(attachments)) return [];
  return attachments.filter(
    (entry): entry is ChatAttachment =>
      Boolean(entry) &&
      typeof entry === "object" &&
      (entry as ChatAttachment).category !== "image" &&
      typeof (entry as ChatAttachment).name === "string",
  );
}

function formatFileEmbeddedLabel(files: ChatAttachment[]): string {
  if (!files.length) return "";
  const names = files.map((entry) => entry.name).filter(Boolean);
  return `Files (${names.length}): ${names.join(", ")}`;
}

function formatSelectedTextQuoteMarkdown(
  selectedText: string,
  label = "Selected text",
): string {
  const quoted = selectedText
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  return `${label}:\n${quoted}`;
}

function normalizeSelectedTextsForNote(
  selectedTexts: unknown,
  selectedText: unknown,
  selectedTextSources: unknown,
): Array<{ text: string; source: SelectedTextSource }> {
  const normalizedTexts = (() => {
    if (Array.isArray(selectedTexts)) {
      return selectedTexts
        .map((entry) =>
          sanitizeText(typeof entry === "string" ? entry : "").trim(),
        )
        .filter(Boolean);
    }
    const legacy =
      typeof selectedText === "string" ? sanitizeText(selectedText).trim() : "";
    return legacy ? [legacy] : [];
  })();
  if (!normalizedTexts.length) return [];
  const rawSources = Array.isArray(selectedTextSources)
    ? selectedTextSources
    : [];
  return normalizedTexts.map((text, index) => ({
    text,
    source: normalizeSelectedTextSource(rawSources[index]),
  }));
}

function formatSelectedTextLabel(
  source: SelectedTextSource,
  index: number,
  total: number,
): string {
  const icon = getSelectedTextSourceIcon(source);
  if (source === "note") {
    return total === 1 ? `${icon} Note context` : `${icon} Note context (${index + 1})`;
  }
  if (source === "note-edit") {
    return total === 1 ? `${icon} Editing focus` : `${icon} Editing focus (${index + 1})`;
  }
  if (total === 1) return `${icon} Selected text`;
  return `${icon} Selected text (${index + 1})`;
}

function buildScreenshotImagesHtmlForNote(images: string[]): string {
  if (!images.length) return "";
  const label = formatScreenshotEmbeddedLabel(images.length);
  const blocks = images
    .map((src, index) => {
      const alt = `Screenshot ${index + 1}`;
      return `<p><img src="${escapeNoteHtml(src)}" alt="${escapeNoteHtml(alt)}"/></p>`;
    })
    .join("");
  return `<div><p>${escapeNoteHtml(label)}</p>${blocks}</div>`;
}

function buildFileListHtmlForNote(files: ChatAttachment[]): string {
  if (!files.length) return "";
  const items = files
    .map((entry) => {
      const href = toFileUrl(entry.storedPath);
      const typeText = escapeNoteHtml(
        (entry.mimeType || "application/octet-stream").trim(),
      );
      const sizeText = `${(entry.sizeBytes / 1024 / 1024).toFixed(2)} MB`;
      const escapedName = escapeNoteHtml(entry.name);
      const linkedName = href
        ? `<a href="${escapeNoteHtml(href)}">${escapedName}</a>`
        : `<strong>${escapedName}</strong>`;
      return `<li>${linkedName} (${typeText}, ${escapeNoteHtml(sizeText)})</li>`;
    })
    .join("");
  return `<div><p>${escapeNoteHtml(formatFileEmbeddedLabel(files))}</p><ul>${items}</ul></div>`;
}

function collectAttachmentHashes(messages: Message[]): string[] {
  const hashes = new Set<string>();
  for (const msg of messages) {
    const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
    for (const attachment of attachments) {
      if (!attachment || attachment.category === "image") continue;
      const hash =
        normalizeAttachmentContentHash(attachment.contentHash) ||
        extractManagedBlobHash(attachment.storedPath);
      if (!hash) continue;
      hashes.add(hash);
    }
  }
  return Array.from(hashes);
}

async function normalizeHistoryAttachmentsToSharedBlobs(
  history: Message[],
): Promise<Message[]> {
  const cloned: Message[] = [];
  for (const msg of history) {
    const attachments = Array.isArray(msg.attachments)
      ? msg.attachments
      : undefined;
    if (!attachments?.length) {
      cloned.push({ ...msg });
      continue;
    }
    const nextAttachments: ChatAttachment[] = [];
    for (const attachment of attachments) {
      if (
        attachment.category === "image" ||
        !attachment.storedPath ||
        !attachment.storedPath.trim()
      ) {
        nextAttachments.push({ ...attachment });
        continue;
      }
      try {
        const normalizedPath = attachment.storedPath.trim();
        const existingHash = normalizeAttachmentContentHash(
          attachment.contentHash,
        );
        if (existingHash && isManagedBlobPath(normalizedPath)) {
          nextAttachments.push({
            ...attachment,
            contentHash: existingHash,
            storedPath: normalizedPath,
          });
          continue;
        }
        const managedHash = extractManagedBlobHash(normalizedPath);
        if (managedHash) {
          nextAttachments.push({
            ...attachment,
            contentHash: managedHash,
            storedPath: normalizedPath,
          });
          continue;
        }
        const imported = await ensureAttachmentBlobFromPath(
          normalizedPath,
          attachment.name,
        );
        nextAttachments.push({
          ...attachment,
          storedPath: imported.storedPath,
          contentHash: imported.contentHash,
        });
      } catch (err) {
        ztoolkit.log("LLM: Failed to normalize note attachment blob", err);
        nextAttachments.push({
          ...attachment,
          storedPath: undefined,
          contentHash: undefined,
        });
      }
    }
    cloned.push({
      ...msg,
      attachments: nextAttachments,
    });
  }
  return cloned;
}

export function buildChatHistoryNotePayload(messages: Message[]): {
  noteHtml: string;
  noteText: string;
} {
  const timestamp = getCurrentLocalTimestamp();
  const textLines: string[] = [];
  const htmlBlocks: string[] = [];
  for (const msg of messages) {
    const text = sanitizeText(msg.text || "").trim();
    const selectedTextContexts = normalizeSelectedTextsForNote(
      msg.selectedTexts,
      msg.selectedText,
      msg.selectedTextSources,
    );
    const screenshotImages = normalizeScreenshotImagesForNote(
      msg.screenshotImages,
    );
    const fileAttachments = normalizeFileAttachmentsForNote(msg.attachments);
    const screenshotCount = screenshotImages.length;
    if (
      !text &&
      !selectedTextContexts.length &&
      !screenshotCount &&
      !fileAttachments.length
    )
      continue;
    let textWithContext = text;
    let htmlTextWithContext = text;
    if (msg.role === "user") {
      const userBlocks: string[] = [];
      const userHtmlBlocks: string[] = [];
      if (selectedTextContexts.length === 1) {
        const entry = selectedTextContexts[0];
        const label = formatSelectedTextLabel(
          entry.source,
          0,
          selectedTextContexts.length,
        );
        userBlocks.push(formatSelectedTextQuoteMarkdown(entry.text, label));
        userHtmlBlocks.push(formatSelectedTextQuoteMarkdown(entry.text, label));
      } else if (selectedTextContexts.length > 1) {
        selectedTextContexts.forEach((entry, index) => {
          const label = formatSelectedTextLabel(
            entry.source,
            index,
            selectedTextContexts.length,
          );
          userBlocks.push(formatSelectedTextQuoteMarkdown(entry.text, label));
          userHtmlBlocks.push(
            formatSelectedTextQuoteMarkdown(entry.text, label),
          );
        });
      }
      if (screenshotCount) {
        userBlocks.push(formatScreenshotEmbeddedLabel(screenshotCount));
      }
      if (fileAttachments.length) {
        userBlocks.push(formatFileEmbeddedLabel(fileAttachments));
      }
      if (text) {
        userBlocks.push(text);
        userHtmlBlocks.push(text);
      }
      textWithContext = userBlocks.join("\n\n");
      htmlTextWithContext = userHtmlBlocks.join("\n\n");
    }
    const speaker =
      msg.role === "user"
        ? "user"
        : sanitizeText(msg.modelName || "").trim() || "model";
    const screenshotHtml =
      msg.role === "user"
        ? buildScreenshotImagesHtmlForNote(screenshotImages)
        : "";
    const fileHtml =
      msg.role === "user" ? buildFileListHtmlForNote(fileAttachments) : "";
    const rendered = renderChatMessageHtmlForNote(
      msg.role === "user" ? htmlTextWithContext : textWithContext,
    );
    if (!rendered && !screenshotHtml && !fileHtml) continue;
    textLines.push(`${speaker}: ${textWithContext}`);
    const renderedBlock = rendered ? `<div>${rendered}</div>` : "";
    htmlBlocks.push(
      `<p><strong>${escapeNoteHtml(speaker)}:</strong></p>${renderedBlock}${screenshotHtml}${fileHtml}`,
    );
  }
  const noteText = textLines.join("\n\n");
  const bodyHtml = htmlBlocks.join("<hr/>");
  return {
    noteText,
    noteHtml: `<p><strong>Chat history saved at ${escapeNoteHtml(timestamp)}</strong></p><div>${bodyHtml}</div><hr/><p>Written by LLM-for-Zotero plugin</p>`,
  };
}

function appendAssistantAnswerToNoteHtml(
  existingHtml: string,
  newAnswerHtml: string,
): string {
  const base = (existingHtml || "").trim();
  const addition = (newAnswerHtml || "").trim();
  if (!base) return addition;
  if (!addition) return base;
  return `${base}<hr/>${addition}`;
}

export async function createNoteFromAssistantText(
  item: Zotero.Item,
  contentText: string,
  modelName: string,
): Promise<"created" | "appended"> {
  const parentItem = resolveParentItemForNote(item);
  const parentId = parentItem?.id;
  if (!parentItem || !parentId) {
    throw new Error("No parent item available for note creation");
  }

  // Always render from the plain-text / markdown source via
  // renderMarkdownForNote.  This produces clean HTML that Zotero's
  // ProseMirror note-editor can reliably parse.  (The previous approach
  // of injecting rendered DOM HTML from the bubble was fragile — KaTeX
  // span trees and sanitised classless wrappers were mostly dropped by
  // ProseMirror.)
  const html = buildAssistantNoteHtml(contentText, modelName);

  // Try to find an existing tracked note for this parent item.
  // If one exists and is still valid, append the new content to it.
  const existingNote = getTrackedAssistantNoteForParent(parentId);
  if (existingNote) {
    try {
      const appendedHtml = appendAssistantAnswerToNoteHtml(
        existingNote.getNote() || "",
        html,
      );
      existingNote.setNote(appendedHtml);
      await existingNote.saveTx();
      ztoolkit.log(
        `LLM: Appended to existing note ${existingNote.id} for parent ${parentId}`,
      );
      return "appended";
    } catch (appendErr) {
      // If appending fails (e.g. note was deleted externally), fall through
      // to create a new note instead.
      ztoolkit.log(
        "LLM: Failed to append to existing note, creating new:",
        appendErr,
      );
      removeAssistantNoteMapEntry(parentId);
    }
  }

  // No existing tracked note (or append failed) – create a brand-new note.
  const note = new Zotero.Item("note");
  note.libraryID = parentItem.libraryID;
  note.parentID = parentId;
  note.setNote(html);
  const saveResult = await note.saveTx();
  // saveTx() returns the new item ID (number) on creation.
  // Also check note.id as a fallback.
  const newNoteId =
    typeof saveResult === "number" && saveResult > 0 ? saveResult : note.id;
  if (newNoteId && newNoteId > 0) {
    rememberAssistantNoteForParent(parentId, newNoteId);
    ztoolkit.log(`LLM: Created new note ${newNoteId} for parent ${parentId}`);
  } else {
    ztoolkit.log(
      "LLM: Warning – note was saved but could not determine note ID",
    );
  }
  return "created";
}

export async function createStandaloneNoteFromAssistantText(
  libraryID: number,
  contentText: string,
  modelName: string,
): Promise<"created"> {
  const normalizedLibraryID = Number.isFinite(libraryID)
    ? Math.floor(libraryID)
    : 0;
  if (normalizedLibraryID <= 0) {
    throw new Error("Invalid library ID for standalone note creation");
  }
  const html = buildAssistantNoteHtml(contentText, modelName);
  const note = new Zotero.Item("note");
  note.libraryID = normalizedLibraryID;
  note.setNote(html);
  await note.saveTx();
  return "created";
}

export async function createNoteFromChatHistory(
  item: Zotero.Item,
  history: Message[],
): Promise<void> {
  const parentItem = resolveParentItemForNote(item);
  const parentId = parentItem?.id;
  if (!parentItem || !parentId) {
    throw new Error("No parent item available for note creation");
  }
  // Chat history export always creates a brand-new, standalone note.
  // It does NOT append to the tracked assistant note and does NOT
  // update the tracked note ID, so single-response "Save as note"
  // keeps its own append chain undisturbed.
  const note = new Zotero.Item("note");
  note.libraryID = parentItem.libraryID;
  note.parentID = parentId;
  // Create first to get stable note ID for attachment reference ownership.
  note.setNote("<p>Preparing chat history export...</p>");
  const saveResult = await note.saveTx();
  const noteId =
    typeof saveResult === "number" && saveResult > 0 ? saveResult : note.id;
  if (!noteId || noteId <= 0) {
    throw new Error("Unable to resolve new note ID for chat history export");
  }
  const normalizedHistory =
    await normalizeHistoryAttachmentsToSharedBlobs(history);
  note.setNote(buildChatHistoryNotePayload(normalizedHistory).noteHtml);
  await note.saveTx();
  const attachmentHashes = collectAttachmentHashes(normalizedHistory);
  try {
    await replaceOwnerAttachmentRefs("note", noteId, attachmentHashes);
  } catch (err) {
    ztoolkit.log("LLM: Failed to persist note attachment refs", err);
  }
  void collectAndDeleteUnreferencedBlobs(ATTACHMENT_GC_MIN_AGE_MS).catch(
    (err) => {
      ztoolkit.log("LLM: Attachment GC after note export failed", err);
    },
  );
  ztoolkit.log(
    `LLM: Created chat history note ${noteId} for parent ${parentId}`,
  );
}

export async function createStandaloneNoteFromChatHistory(
  libraryID: number,
  history: Message[],
): Promise<void> {
  const normalizedLibraryID = Number.isFinite(libraryID)
    ? Math.floor(libraryID)
    : 0;
  if (normalizedLibraryID <= 0) {
    throw new Error("Invalid library ID for standalone note export");
  }
  const note = new Zotero.Item("note");
  note.libraryID = normalizedLibraryID;
  note.setNote("<p>Preparing chat history export...</p>");
  const saveResult = await note.saveTx();
  const noteId =
    typeof saveResult === "number" && saveResult > 0 ? saveResult : note.id;
  if (!noteId || noteId <= 0) {
    throw new Error(
      "Unable to resolve new standalone note ID for chat history export",
    );
  }
  const normalizedHistory =
    await normalizeHistoryAttachmentsToSharedBlobs(history);
  note.setNote(buildChatHistoryNotePayload(normalizedHistory).noteHtml);
  await note.saveTx();
  const attachmentHashes = collectAttachmentHashes(normalizedHistory);
  try {
    await replaceOwnerAttachmentRefs("note", noteId, attachmentHashes);
  } catch (err) {
    ztoolkit.log("LLM: Failed to persist standalone note attachment refs", err);
  }
  void collectAndDeleteUnreferencedBlobs(ATTACHMENT_GC_MIN_AGE_MS).catch(
    (err) => {
      ztoolkit.log(
        "LLM: Attachment GC after standalone note export failed",
        err,
      );
    },
  );
  ztoolkit.log(
    `LLM: Created standalone chat history note ${noteId} in library ${normalizedLibraryID}`,
  );
}
