import { unzipSync } from "fflate";

export type MinerUZipFile = {
  relativePath: string;
  data: Uint8Array;
};

export type MinerUZipInspectionFailureReason =
  | "not_zip"
  | "zip_extract_failed"
  | "md_missing";

type MinerUZipInspectionBase = {
  byteLength: number;
  entryNames: string[];
  files: MinerUZipFile[];
  firstBytesHex: string;
  zipSignature: boolean;
};

export type MinerUZipInspectionSuccess = MinerUZipInspectionBase & {
  ok: true;
  mdContent: string;
};

export type MinerUZipInspectionFailure = MinerUZipInspectionBase & {
  ok: false;
  reason: MinerUZipInspectionFailureReason;
  error?: string;
};

export type MinerUZipInspectionResult =
  | MinerUZipInspectionSuccess
  | MinerUZipInspectionFailure;

function hasZipSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  return (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08))
  );
}

function formatFirstBytesHex(bytes: Uint8Array, count = 4): string {
  return Array.from(bytes.subarray(0, count))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
}

function pickMarkdownFile(files: MinerUZipFile[]): MinerUZipFile | undefined {
  return (
    files.find((file) => /(^|[\\/])full\.md$/i.test(file.relativePath)) ||
    files.find((file) => file.relativePath.toLowerCase().endsWith(".md"))
  );
}

function truncateErrorMessage(value: string | undefined): string | undefined {
  const normalized = (value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > 160
    ? `${normalized.slice(0, 157)}...`
    : normalized;
}

export function inspectMineruZipBytes(
  zipBytes: Uint8Array,
): MinerUZipInspectionResult {
  const zipSignature = hasZipSignature(zipBytes);
  const byteLength = zipBytes.length;
  const firstBytesHex = formatFirstBytesHex(zipBytes);

  if (!zipSignature) {
    return {
      ok: false,
      reason: "not_zip",
      error: "Missing ZIP signature",
      files: [],
      entryNames: [],
      byteLength,
      firstBytesHex,
      zipSignature,
    };
  }

  try {
    const unzipped = unzipSync(zipBytes);
    const entryNames = Object.keys(unzipped);
    const files: MinerUZipFile[] = [];

    for (const entryName of entryNames) {
      if (entryName.endsWith("/") || entryName.startsWith("__MACOSX/")) {
        continue;
      }
      files.push({
        relativePath: entryName,
        data: unzipped[entryName],
      });
    }

    const mdFile = pickMarkdownFile(files);
    if (!mdFile) {
      return {
        ok: false,
        reason: "md_missing",
        files,
        entryNames,
        byteLength,
        firstBytesHex,
        zipSignature,
      };
    }

    return {
      ok: true,
      mdContent: new TextDecoder("utf-8").decode(mdFile.data),
      files,
      entryNames,
      byteLength,
      firstBytesHex,
      zipSignature,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "zip_extract_failed",
      error: truncateErrorMessage(
        error instanceof Error ? error.message : String(error),
      ),
      files: [],
      entryNames: [],
      byteLength,
      firstBytesHex,
      zipSignature,
    };
  }
}

export function describeMineruZipInspectionFailure(
  result: MinerUZipInspectionFailure,
): string {
  switch (result.reason) {
    case "not_zip":
      return "Downloaded result is not a ZIP archive";
    case "md_missing":
      return "ZIP extracted, but no Markdown file was found";
    case "zip_extract_failed":
      return result.error
        ? `Failed to extract ZIP entries: ${result.error}`
        : "Failed to extract ZIP entries";
  }
}
