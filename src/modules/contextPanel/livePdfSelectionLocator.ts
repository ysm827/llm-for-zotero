import { collectReaderSelectionDocuments } from "./readerSelection";
import { sanitizeText } from "./textUtils";

export type LivePdfPageText = {
  pageIndex: number;
  pageLabel?: string;
  text: string;
};

export type LivePdfSelectionPageLocation = {
  contextItemId?: number;
  pageIndex: number;
  pageLabel?: string;
  pagesScanned: number;
};

export type LivePdfSelectionLocateStatus =
  | "resolved"
  | "ambiguous"
  | "not-found"
  | "selection-too-short"
  | "unavailable";

export type LivePdfSelectionLocateConfidence = "high" | "medium" | "low" | "none";

export type LivePdfSelectionLocateResult = {
  status: LivePdfSelectionLocateStatus;
  confidence: LivePdfSelectionLocateConfidence;
  selectionText: string;
  normalizedSelection: string;
  queryLabel?: string;
  expectedPageIndex: number | null;
  computedPageIndex: number | null;
  matchedPageIndexes: number[];
  totalMatches: number;
  pagesScanned: number;
  excerpt?: string;
  reason?: string;
  debugSummary?: string[];
};

type LocatePageTextOptions = {
  queryLabel?: string;
  resolveSinglePageDuplicates?: boolean;
};

type PageMatch = {
  pageIndex: number;
  matchIndexes: number[];
  excerpt?: string;
};

type QuotePageScore = {
  pageIndex: number;
  matchedAnchorKeys: Set<string>;
  totalMatches: number;
  excerpt?: string;
};

type PageTextIndexEntry = {
  pageIndex: number;
  pageLabel?: string;
  text: string;
  normalizedText: string;
};

const PAGE_CONTAINER_SELECTOR = [
  ".page[data-page-number]",
  ".page[data-page-index]",
  "[data-page-number]",
  "[data-page-index]",
].join(", ");
const PAGE_FLASH_STYLE_ID = "llmforzotero-page-flash-style";
const PAGE_FLASH_CLASS = "llmforzotero-page-flash";

const SEARCH_WORD_PATTERN = /[a-z0-9]+/g;
const COMMON_SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "then",
  "these",
  "this",
  "those",
  "to",
  "was",
  "we",
  "were",
  "with",
]);

function normalizeLocatorText(value: string): string {
  return sanitizeText(value || "")
    .replace(/\u00ad/g, "")
    .replace(/([A-Za-z])-\s+([A-Za-z])/g, "$1$2")
    .replace(/[“”‘’]/g, " ")
    .replace(/[‐‑‒–—-]/g, " ")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stripInlineLocatorNoise(value: string): string {
  const cleaned = sanitizeText(value || "");
  return cleaned
    .replace(/\(([^)]{0,160})\)/gi, (_match, inner: string) =>
      /\b(fig|figure|table|appendix|supp|supplement|eq|equation|section|sec\.?|et al|19\d{2}|20\d{2})\b/i.test(
        inner,
      )
        ? " "
        : ` ${inner} `,
    )
    .replace(/\[([^\]]{0,160})\]/gi, (_match, inner: string) =>
      /\b(fig|figure|table|appendix|supp|supplement|eq|equation|section|sec\.?|et al|19\d{2}|20\d{2})\b/i.test(
        inner,
      )
        ? " "
        : ` ${inner} `,
    );
}

function extractSearchTokens(value: string): string[] {
  const normalized = normalizeLocatorText(stripInlineLocatorNoise(value));
  return normalized.match(SEARCH_WORD_PATTERN) || [];
}

function scoreSearchToken(token: string): number {
  if (!token) return Number.NEGATIVE_INFINITY;
  if (COMMON_SEARCH_STOP_WORDS.has(token)) return 0.5;
  if (/^\d+$/.test(token)) return 0.2;
  if (token.length <= 2) return 0.2;
  if (token.length === 3) return 1.5;
  return Math.min(8, token.length + (/[a-z]/.test(token) ? 1 : 0));
}

function scoreTokenWindow(tokens: string[]): number {
  if (tokens.length < 4) return Number.NEGATIVE_INFINITY;
  const scores = tokens.map(scoreSearchToken);
  const informativeTokenCount = scores.filter((score) => score >= 2).length;
  if (informativeTokenCount < 2) return Number.NEGATIVE_INFINITY;
  return scores.reduce((sum, score) => sum + score, 0);
}

function scoreAnchorTokenWindow(tokens: string[]): number {
  if (tokens.length < 5) return Number.NEGATIVE_INFINITY;
  const alphaTokens = tokens.filter((token) => /[a-z]/.test(token));
  if (alphaTokens.length < 5) return Number.NEGATIVE_INFINITY;
  const digitOnlyCount = tokens.filter((token) => /^\d+$/.test(token)).length;
  const alphaRatio = alphaTokens.length / tokens.length;
  const averageAlphaLength =
    alphaTokens.reduce((sum, token) => sum + token.length, 0) / alphaTokens.length;
  return alphaRatio * 10 + averageAlphaLength - digitOnlyCount * 3;
}

function buildFallbackAnchor(tokens: string[], windowSize: number): string[] {
  if (tokens.length < 5) return [];
  const anchorTokens = tokens.slice(0, Math.min(tokens.length, windowSize));
  return anchorTokens.length >= 5 ? [anchorTokens.join(" ")] : [];
}

function buildQuoteAnchors(value: string): string[] {
  const tokens = extractSearchTokens(value);
  if (tokens.length < 5) return [];

  const primaryWindowSize =
    tokens.length >= 72 ? 11 : tokens.length >= 40 ? 9 : tokens.length >= 20 ? 8 : 6;
  const secondaryWindowSize = Math.max(5, primaryWindowSize - 2);
  const anchorCount = tokens.length >= 72 ? 5 : tokens.length >= 32 ? 4 : 3;
  const maxStart = Math.max(0, tokens.length - primaryWindowSize);
  if (tokens.length <= 12) {
    return buildFallbackAnchor(tokens, primaryWindowSize);
  }

  const preferredMinStart = maxStart >= 2 ? 1 : 0;
  const preferredMaxStart =
    maxStart >= 2 ? Math.max(preferredMinStart, maxStart - 1) : maxStart;
  const positions = new Set<number>();

  if (maxStart === 0) {
    positions.add(0);
  } else {
    const denominator = Math.max(1, anchorCount - 1);
    for (let i = 0; i < anchorCount; i += 1) {
      const ratio = denominator === 0 ? 0 : i / denominator;
      const start = preferredMinStart + Math.round((preferredMaxStart - preferredMinStart) * ratio);
      positions.add(Math.max(0, Math.min(maxStart, start)));
    }
    positions.add(Math.max(0, Math.min(maxStart, Math.floor((preferredMinStart + preferredMaxStart) / 2))));
  }

  const radius = Math.max(2, Math.min(8, Math.floor(primaryWindowSize / 2) + 1));
  const anchors = new Set<string>();
  for (const start of positions) {
    let bestWindow: {
      text: string;
      score: number;
      distance: number;
      start: number;
    } | null = null;
    const minStart = Math.max(0, start - radius);
    const maxCandidateStart = Math.min(maxStart, start + radius);
    for (let candidateStart = minStart; candidateStart <= maxCandidateStart; candidateStart += 1) {
      const anchorTokens = tokens.slice(
        candidateStart,
        candidateStart + primaryWindowSize,
      );
      const score = scoreAnchorTokenWindow(anchorTokens);
      if (!Number.isFinite(score)) continue;
      const candidate = {
        text: anchorTokens.join(" "),
        score,
        distance: Math.abs(candidateStart - start),
        start: candidateStart,
      };
      if (
        !bestWindow ||
        candidate.score > bestWindow.score ||
        (candidate.score === bestWindow.score && candidate.distance < bestWindow.distance)
      ) {
        bestWindow = candidate;
      }
    }
    if (bestWindow?.text) {
      anchors.add(bestWindow.text);
      const shorterTokens = tokens.slice(
        bestWindow.start,
        bestWindow.start + secondaryWindowSize,
      );
      if (shorterTokens.length >= 5) {
        anchors.add(shorterTokens.join(" "));
      }
    }
  }

  if (!anchors.size) {
    return buildFallbackAnchor(tokens, primaryWindowSize);
  }

  return Array.from(anchors);
}

function formatQuerySnippet(query: string, maxLength = 72): string {
  if (query.length <= maxLength) return query;
  return `${query.slice(0, maxLength - 3)}...`;
}

function buildPageTextIndex(pages: LivePdfPageText[]): PageTextIndexEntry[] {
  return pages.map((page) => ({
    pageIndex: page.pageIndex,
    pageLabel: page.pageLabel,
    text: page.text,
    normalizedText: normalizeLocatorText(page.text),
  }));
}

function searchPageIndexEntries(
  pageIndexEntries: PageTextIndexEntry[],
  query: string,
): {
  matchedPageIndexes: number[];
  totalMatches: number;
  excerpt?: string;
} {
  const normalizedQuery = normalizeLocatorText(query);
  if (!normalizedQuery) {
    return {
      matchedPageIndexes: [],
      totalMatches: 0,
    };
  }

  const matchedPageIndexes: number[] = [];
  let totalMatches = 0;
  let excerpt: string | undefined;
  for (const page of pageIndexEntries) {
    const matchIndexes = findAllMatchIndexes(page.normalizedText, normalizedQuery);
    if (!matchIndexes.length) continue;
    matchedPageIndexes.push(page.pageIndex);
    totalMatches += matchIndexes.length;
    if (!excerpt) {
      excerpt = buildExcerpt(page.normalizedText, matchIndexes[0], normalizedQuery.length);
    }
  }
  return { matchedPageIndexes, totalMatches, excerpt };
}

function getProgressiveStartOffsets(tokens: string[]): number[] {
  const offsets = [0];
  if (tokens.length > 6 && scoreSearchToken(tokens[0]) < 2) {
    offsets.push(1);
  }
  if (tokens.length > 8 && scoreSearchToken(tokens[0]) < 1 && scoreSearchToken(tokens[1]) < 2) {
    offsets.push(2);
  }
  return offsets;
}

function findAllMatchIndexes(haystack: string, needle: string): number[] {
  if (!haystack || !needle) return [];
  const out: number[] = [];
  let cursor = 0;
  while (cursor < haystack.length) {
    const found = haystack.indexOf(needle, cursor);
    if (found < 0) break;
    out.push(found);
    cursor = found + Math.max(1, Math.floor(needle.length / 2));
  }
  return out;
}

function buildExcerpt(text: string, index: number, matchLength: number): string {
  if (!text) return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const start = Math.max(0, index - 72);
  const end = Math.min(normalized.length, index + matchLength + 72);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < normalized.length ? "..." : "";
  return `${prefix}${normalized.slice(start, end).trim()}${suffix}`;
}

function isElementNode(value: unknown): value is Element {
  return Boolean(
    value &&
      typeof value === "object" &&
      "nodeType" in value &&
      (value as { nodeType?: unknown }).nodeType === 1,
  );
}

function getElementFromNode(node: Node | null | undefined): Element | null {
  if (!node) return null;
  if (node.nodeType === 1) {
    return node as Element;
  }
  return node.parentElement || null;
}

function parsePageIndexFromElement(element: Element | null | undefined): number | null {
  let current = element || null;
  while (current) {
    const pageNumberAttr = current.getAttribute("data-page-number");
    if (pageNumberAttr) {
      const pageNumber = Number.parseInt(pageNumberAttr, 10);
      if (Number.isFinite(pageNumber) && pageNumber >= 1) {
        return pageNumber - 1;
      }
    }
    const pageIndexAttr = current.getAttribute("data-page-index");
    if (pageIndexAttr) {
      const pageIndex = Number.parseInt(pageIndexAttr, 10);
      if (Number.isFinite(pageIndex) && pageIndex >= 0) {
        return pageIndex;
      }
    }
    current = current.parentElement;
  }
  return null;
}

function getPageLabelFromElement(element: Element | null | undefined): string | undefined {
  let current = element || null;
  while (current) {
    const pageNumberAttr = current.getAttribute("data-page-number");
    if (pageNumberAttr) {
      return pageNumberAttr;
    }
    const pageIndexAttr = current.getAttribute("data-page-index");
    if (pageIndexAttr) {
      const pageIndex = Number.parseInt(pageIndexAttr, 10);
      if (Number.isFinite(pageIndex) && pageIndex >= 0) {
        return `${pageIndex + 1}`;
      }
    }
    current = current.parentElement;
  }
  return undefined;
}

function countRenderedPages(doc: Document): number {
  return doc.querySelectorAll(PAGE_CONTAINER_SELECTOR).length;
}

function getPageElementByIndex(doc: Document, pageIndex: number): Element | null {
  const pageElements = Array.from(doc.querySelectorAll(PAGE_CONTAINER_SELECTOR)).filter(
    isElementNode,
  );
  for (const pageElement of pageElements) {
    if (parsePageIndexFromElement(pageElement) === pageIndex) {
      return pageElement;
    }
  }
  return null;
}

function ensurePageFlashStyle(doc: Document): void {
  if (doc.getElementById(PAGE_FLASH_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = PAGE_FLASH_STYLE_ID;
  style.textContent = `
    @keyframes llmforzoteroPageFlashPulse {
      0%, 100% {
        box-shadow: 0 0 0 0 rgba(37, 99, 235, 0);
        background-color: rgba(37, 99, 235, 0);
      }
      25%, 75% {
        box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.95);
        background-color: rgba(59, 130, 246, 0.10);
      }
      50% {
        box-shadow: 0 0 0 6px rgba(96, 165, 250, 0.35);
        background-color: rgba(96, 165, 250, 0.16);
      }
    }

    .${PAGE_FLASH_CLASS} {
      animation: llmforzoteroPageFlashPulse 0.75s ease-in-out 2;
      border-radius: 6px;
    }
  `;
  (doc.head || doc.documentElement || doc).appendChild(style);
}

function flashPageElement(pageElement: Element): void {
  const doc = pageElement.ownerDocument;
  if (!doc) return;
  ensurePageFlashStyle(doc);
  pageElement.classList.remove(PAGE_FLASH_CLASS);
  void (pageElement as HTMLElement).getBoundingClientRect();
  pageElement.classList.add(PAGE_FLASH_CLASS);
  const win = doc.defaultView;
  win?.setTimeout(() => {
    pageElement.classList.remove(PAGE_FLASH_CLASS);
  }, 1700);
}

function getSelectionPageElement(doc: Document): Element | null {
  const selection = doc.defaultView?.getSelection?.();
  if (!selection || selection.rangeCount < 1 || selection.isCollapsed) {
    return null;
  }
  const candidates: Array<Node | null> = [
    selection.anchorNode,
    selection.focusNode,
    selection.getRangeAt(0).commonAncestorContainer,
  ];
  for (const node of candidates) {
    const element = getElementFromNode(node);
    const pageIndex = parsePageIndexFromElement(element);
    if (pageIndex !== null) {
      return element;
    }
  }
  return null;
}

function buildDomResolvedResult(
  selectionText: string,
  expectedPageIndex: number | null,
  pageIndex: number,
  pageLabel?: string,
  pagesScanned = 0,
): LivePdfSelectionLocateResult {
  return {
    status: "resolved",
    confidence: "high",
    selectionText: sanitizeText(selectionText || "").trim(),
    normalizedSelection: normalizeLocatorText(selectionText),
    queryLabel: "Selection",
    expectedPageIndex,
    computedPageIndex: pageIndex,
    matchedPageIndexes: [pageIndex],
    totalMatches: 1,
    pagesScanned,
    reason: pageLabel
      ? `Resolved directly from the live selection DOM on page ${pageLabel}.`
      : "Resolved directly from the live selection DOM.",
  };
}

function matchByPrefixSuffix(
  normalizedPageText: string,
  normalizedSelection: string,
): number[] {
  if (normalizedSelection.length < 48) return [];
  const edgeLength = Math.max(18, Math.min(64, Math.floor(normalizedSelection.length / 3)));
  const prefix = normalizedSelection.slice(0, edgeLength).trim();
  const suffix = normalizedSelection.slice(-edgeLength).trim();
  if (!prefix || !suffix) return [];
  const out: number[] = [];
  let cursor = 0;
  while (cursor < normalizedPageText.length) {
    const prefixIndex = normalizedPageText.indexOf(prefix, cursor);
    if (prefixIndex < 0) break;
    const suffixSearchStart = prefixIndex + prefix.length;
    const suffixIndex = normalizedPageText.indexOf(suffix, suffixSearchStart);
    if (suffixIndex < 0) break;
    const spanLength = suffixIndex + suffix.length - prefixIndex;
    if (spanLength <= normalizedSelection.length * 1.8 + 48) {
      out.push(prefixIndex);
    }
    cursor = prefixIndex + Math.max(1, Math.floor(prefix.length / 2));
  }
  return out;
}

function collectPageMatches(
  pages: LivePdfPageText[],
  normalizedSelection: string,
): { matches: PageMatch[]; confidence: LivePdfSelectionLocateConfidence } {
  const exactMatches: PageMatch[] = [];
  for (const page of pages) {
    const normalizedPageText = normalizeLocatorText(page.text);
    const matchIndexes = findAllMatchIndexes(normalizedPageText, normalizedSelection);
    if (!matchIndexes.length) continue;
    exactMatches.push({
      pageIndex: page.pageIndex,
      matchIndexes,
      excerpt: buildExcerpt(
        normalizedPageText,
        matchIndexes[0],
        normalizedSelection.length,
      ),
    });
  }
  if (exactMatches.length) {
    return { matches: exactMatches, confidence: "high" };
  }

  const fallbackMatches: PageMatch[] = [];
  for (const page of pages) {
    const normalizedPageText = normalizeLocatorText(page.text);
    const matchIndexes = matchByPrefixSuffix(normalizedPageText, normalizedSelection);
    if (!matchIndexes.length) continue;
    fallbackMatches.push({
      pageIndex: page.pageIndex,
      matchIndexes,
      excerpt: buildExcerpt(
        normalizedPageText,
        matchIndexes[0],
        normalizedSelection.length,
      ),
    });
  }
  return {
    matches: fallbackMatches,
    confidence: fallbackMatches.length ? "medium" : "none",
  };
}

function getQuoteAnchorSkipReason(anchor: string): string | null {
  const tokens = extractSearchTokens(anchor);
  if (tokens.length < 5) {
    return "too short";
  }
  const alphaTokens = tokens.filter((token) => /[a-z]/.test(token));
  if (alphaTokens.length < 5) {
    return "too little plain text";
  }
  if (alphaTokens.length / tokens.length < 0.72) {
    return "math-heavy or symbol-heavy";
  }
  return null;
}

function formatPageList(pageIndexes: number[]): string {
  return pageIndexes.length
    ? pageIndexes.map((pageIndex) => `p${pageIndex + 1}`).join(", ")
    : "none";
}

function buildQuoteDebugSummary(
  scoreByPage: Map<number, QuotePageScore>,
  anchorSummaries: string[],
  contextLabel: string,
  earlyStopReason?: string,
): string[] {
  const pageLines = Array.from(scoreByPage.values())
    .sort((left, right) => {
      const anchorDelta =
        right.matchedAnchorKeys.size - left.matchedAnchorKeys.size;
      if (anchorDelta !== 0) return anchorDelta;
      return right.totalMatches - left.totalMatches;
    })
    .slice(0, 4)
    .map(
      (score) =>
        `${contextLabel} vote ${score.pageIndex + 1}: ${score.matchedAnchorKeys.size} anchors, ${score.totalMatches} matches`,
    );
  const anchorLines = anchorSummaries.slice(0, 6);
  const lines = [...pageLines, ...anchorLines];
  if (earlyStopReason) {
    lines.push(earlyStopReason);
  }
  return lines;
}

function shouldEarlyStopQuoteVoting(
  scoreByPage: Map<number, QuotePageScore>,
  remainingAnchors: number,
): boolean {
  const scores = Array.from(scoreByPage.values()).sort(
    (left, right) => right.matchedAnchorKeys.size - left.matchedAnchorKeys.size,
  );
  if (!scores.length) return false;
  const leader = scores[0].matchedAnchorKeys.size;
  const runnerUp = scores[1]?.matchedAnchorKeys.size || 0;
  return leader >= 2 && leader > runnerUp + remainingAnchors;
}

function scoreQuoteAnchorsAcrossPages(
  pages: LivePdfPageText[],
  anchors: string[],
): {
  scoreByPage: Map<number, QuotePageScore>;
  informativeAnchorCount: number;
  anchorSummaries: string[];
} {
  const scoreByPage = new Map<number, QuotePageScore>();
  const anchorSummaries: string[] = [];
  for (const anchor of anchors) {
    const skipReason = getQuoteAnchorSkipReason(anchor);
    if (skipReason) {
      anchorSummaries.push(`Anchor skipped: "${anchor}" (${skipReason})`);
      continue;
    }
    const normalizedAnchor = normalizeLocatorText(anchor);
    if (normalizedAnchor.split(" ").length < 5) continue;
    const { matches } = collectPageMatches(pages, normalizedAnchor);
    const matchedPageIndexes = Array.from(
      new Set(matches.map((match) => match.pageIndex)),
    );
    if (!matchedPageIndexes.length) {
      anchorSummaries.push(`Anchor miss: "${anchor}"`);
      continue;
    }
    if (matchedPageIndexes.length > Math.max(3, Math.ceil(pages.length * 0.35))) {
      anchorSummaries.push(
        `Anchor skipped: "${anchor}" (too broad: ${formatPageList(matchedPageIndexes)})`,
      );
      continue;
    }
    anchorSummaries.push(
      `Anchor hit: "${anchor}" -> ${formatPageList(matchedPageIndexes)}`,
    );
    for (const match of matches) {
      const existing = scoreByPage.get(match.pageIndex) || {
        pageIndex: match.pageIndex,
        matchedAnchorKeys: new Set<string>(),
        totalMatches: 0,
        excerpt: match.excerpt,
      };
      existing.matchedAnchorKeys.add(normalizedAnchor);
      existing.totalMatches += match.matchIndexes.length;
      if (!existing.excerpt && match.excerpt) {
        existing.excerpt = match.excerpt;
      }
      scoreByPage.set(match.pageIndex, existing);
    }
  }

  const informativeAnchorKeys = new Set<string>();
  for (const score of scoreByPage.values()) {
    for (const key of score.matchedAnchorKeys) {
      informativeAnchorKeys.add(key);
    }
  }
  return {
    scoreByPage,
    informativeAnchorCount: informativeAnchorKeys.size,
    anchorSummaries,
  };
}

function buildQuoteAnchorResult(
  scoreByPage: Map<number, QuotePageScore>,
  informativeAnchorCount: number,
  quoteText: string,
  expectedPageIndex: number | null,
  pagesScanned: number,
  fallbackReason?: string,
  debugSummary?: string[],
): LivePdfSelectionLocateResult {
  const selectionText = sanitizeText(quoteText || "").trim();
  const normalizedSelection = normalizeLocatorText(selectionText);
  const scoredPages = Array.from(scoreByPage.values()).sort((left, right) => {
    const anchorDelta =
      right.matchedAnchorKeys.size - left.matchedAnchorKeys.size;
    if (anchorDelta !== 0) return anchorDelta;
    const matchDelta = right.totalMatches - left.totalMatches;
    if (matchDelta !== 0) return matchDelta;
    return left.pageIndex - right.pageIndex;
  });
  const matchedPageIndexes = scoredPages.map((score) => score.pageIndex);
  const totalMatches = scoredPages.reduce(
    (sum, score) => sum + score.totalMatches,
    0,
  );

  if (!scoredPages.length) {
    return {
      status: "not-found",
      confidence: "none",
      selectionText,
      normalizedSelection,
      queryLabel: "Quote",
      expectedPageIndex,
      computedPageIndex: null,
      matchedPageIndexes,
      totalMatches,
      pagesScanned,
      debugSummary,
      reason:
        fallbackReason ||
        "The multi-anchor quote search did not find a reliable page candidate.",
    };
  }

  const topScore = scoredPages[0];
  const topAnchorCount = topScore.matchedAnchorKeys.size;
  const tiedTopPages = scoredPages.filter(
    (score) => score.matchedAnchorKeys.size === topAnchorCount,
  );
  const confidence: LivePdfSelectionLocateConfidence =
    topAnchorCount >= 3 || informativeAnchorCount >= 4
      ? "high"
      : topAnchorCount >= 2
        ? "medium"
        : "low";
  const sharedReason = `Matched ${topAnchorCount} of ${Math.max(
    informativeAnchorCount,
    topAnchorCount,
  )} quote anchors to the page.`;

  if (tiedTopPages.length === 1 && (topAnchorCount >= 2 || informativeAnchorCount <= 1)) {
    return {
      status: "resolved",
      confidence,
      selectionText,
      normalizedSelection,
      queryLabel: "Quote",
      expectedPageIndex,
      computedPageIndex: topScore.pageIndex,
      matchedPageIndexes,
      totalMatches,
      pagesScanned,
      excerpt: topScore.excerpt,
      debugSummary,
      reason: sharedReason,
    };
  }

  return {
    status: "ambiguous",
    confidence: "low",
    selectionText,
    normalizedSelection,
    queryLabel: "Quote",
    expectedPageIndex,
    computedPageIndex: null,
    matchedPageIndexes,
    totalMatches,
    pagesScanned,
    excerpt: topScore.excerpt,
    debugSummary,
    reason: `${sharedReason} Multiple pages tied for the strongest quote match.`,
  };
}

export function locateSelectionInPageTexts(
  pages: LivePdfPageText[],
  selectionText: string,
  expectedPageIndex?: number | null,
  options?: LocatePageTextOptions,
): LivePdfSelectionLocateResult {
  const queryLabel = options?.queryLabel || "Selection";
  const queryLabelLower = queryLabel.toLowerCase();
  const normalizedSelection = normalizeLocatorText(selectionText);
  if (!normalizedSelection) {
    return {
      status: "unavailable",
      confidence: "none",
      selectionText: sanitizeText(selectionText || "").trim(),
      normalizedSelection,
      queryLabel,
      expectedPageIndex: expectedPageIndex ?? null,
      computedPageIndex: null,
      matchedPageIndexes: [],
      totalMatches: 0,
      pagesScanned: pages.length,
      reason: `${queryLabel} text was empty.`,
    };
  }
  if (normalizedSelection.length < 12) {
    return {
      status: "selection-too-short",
      confidence: "none",
      selectionText: sanitizeText(selectionText || "").trim(),
      normalizedSelection,
      queryLabel,
      expectedPageIndex: expectedPageIndex ?? null,
      computedPageIndex: null,
      matchedPageIndexes: [],
      totalMatches: 0,
      pagesScanned: pages.length,
      reason: `${queryLabel} was too short for reliable page resolution.`,
    };
  }

  const { matches, confidence } = collectPageMatches(pages, normalizedSelection);
  const matchedPageIndexes = matches.map((match) => match.pageIndex);
  const totalMatches = matches.reduce(
    (sum, match) => sum + match.matchIndexes.length,
    0,
  );
  if (!matches.length) {
    return {
      status: "not-found",
      confidence: "none",
      selectionText: sanitizeText(selectionText || "").trim(),
      normalizedSelection,
      queryLabel,
      expectedPageIndex: expectedPageIndex ?? null,
      computedPageIndex: null,
      matchedPageIndexes,
      totalMatches,
      pagesScanned: pages.length,
      reason: `The live PDF text search did not find the current ${queryLabelLower}.`,
    };
  }
  if (matches.length === 1 && totalMatches > 1 && options?.resolveSinglePageDuplicates) {
    return {
      status: "resolved",
      confidence: confidence === "high" ? "low" : confidence,
      selectionText: sanitizeText(selectionText || "").trim(),
      normalizedSelection,
      queryLabel,
      expectedPageIndex: expectedPageIndex ?? null,
      computedPageIndex: matches[0].pageIndex,
      matchedPageIndexes,
      totalMatches,
      pagesScanned: pages.length,
      excerpt: matches[0].excerpt,
      reason: `The current ${queryLabelLower} matched multiple locations on the same page in the live PDF.`,
    };
  }
  if (matches.length > 1 || totalMatches > 1) {
    return {
      status: "ambiguous",
      confidence: confidence === "high" ? "low" : confidence,
      selectionText: sanitizeText(selectionText || "").trim(),
      normalizedSelection,
      queryLabel,
      expectedPageIndex: expectedPageIndex ?? null,
      computedPageIndex: null,
      matchedPageIndexes,
      totalMatches,
      pagesScanned: pages.length,
      excerpt: matches[0].excerpt,
      reason: `The current ${queryLabelLower} matched more than one location in the live PDF.`,
    };
  }

  return {
    status: "resolved",
    confidence,
    selectionText: sanitizeText(selectionText || "").trim(),
    normalizedSelection,
    queryLabel,
    expectedPageIndex: expectedPageIndex ?? null,
    computedPageIndex: matches[0].pageIndex,
    matchedPageIndexes,
    totalMatches,
    pagesScanned: pages.length,
    excerpt: matches[0].excerpt,
  };
}

export function locateQuoteInPageTexts(
  pages: LivePdfPageText[],
  quoteText: string,
  expectedPageIndex?: number | null,
): LivePdfSelectionLocateResult {
  const cleanQuote = sanitizeText(quoteText || "").trim();
  const exactResult = locateSelectionInPageTexts(
    pages,
    cleanQuote,
    expectedPageIndex,
    {
      queryLabel: "Quote",
      resolveSinglePageDuplicates: true,
    },
  );
  if (exactResult.status === "resolved") {
    return {
      ...exactResult,
      reason:
        exactResult.reason ||
        "The exact quote matched a single page in the live PDF text.",
    };
  }
  if (
    exactResult.status === "selection-too-short" ||
    exactResult.status === "unavailable"
  ) {
    return exactResult;
  }

  const anchors = buildQuoteAnchors(cleanQuote);
  if (!anchors.length) {
    return exactResult;
  }
  const { scoreByPage, informativeAnchorCount, anchorSummaries } = scoreQuoteAnchorsAcrossPages(
    pages,
    anchors,
  );
  const debugSummary = buildQuoteDebugSummary(
    scoreByPage,
    anchorSummaries,
    "Rendered",
  );
  const anchorResult = buildQuoteAnchorResult(
    scoreByPage,
    informativeAnchorCount,
    cleanQuote,
    expectedPageIndex ?? null,
    pages.length,
    exactResult.reason,
    debugSummary,
  );
  if (
    anchorResult.status === "resolved" ||
    anchorResult.status === "ambiguous"
  ) {
    return anchorResult;
  }
  return exactResult.status === "ambiguous" ? exactResult : anchorResult;
}

function getPdfViewerApplication(reader: any): any | null {
  const candidates = [
    reader?._internalReader?._lastView,
    reader?._internalReader?._primaryView,
    reader?._internalReader?._secondaryView,
    reader,
  ];
  for (const candidate of candidates) {
    const app =
      candidate?._iframeWindow?.PDFViewerApplication ||
      candidate?._iframe?.contentWindow?.PDFViewerApplication ||
      candidate?._window?.PDFViewerApplication;
    if (app?.pdfDocument) {
      return app;
    }
  }
  return null;
}

function getExpectedPageIndex(reader: any, app?: any | null): number | null {
  const candidates = [
    reader?._internalReader?._state?.primaryViewStats?.pageIndex,
    reader?._internalReader?._state?.secondaryViewStats?.pageIndex,
    Number.isFinite(app?.page) ? Number(app.page) - 1 : null,
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

function locateCurrentSelectionFromDom(
  reader: any,
  selectionText: string,
): LivePdfSelectionLocateResult | null {
  const normalizedSelection = normalizeLocatorText(selectionText);
  if (!normalizedSelection) return null;

  const app = getPdfViewerApplication(reader);
  const expectedPageIndex = getExpectedPageIndex(reader, app);
  const docs = collectReaderSelectionDocuments(reader);
  for (const doc of docs) {
    const selectedText = sanitizeText(doc.defaultView?.getSelection?.()?.toString() || "").trim();
    if (!selectedText) continue;
    if (normalizeLocatorText(selectedText) !== normalizedSelection) continue;
    const selectionPageElement = getSelectionPageElement(doc);
    const pageIndex = parsePageIndexFromElement(selectionPageElement);
    if (pageIndex === null) continue;
    return buildDomResolvedResult(
      selectionText,
      expectedPageIndex,
      pageIndex,
      getPageLabelFromElement(selectionPageElement),
      countRenderedPages(doc),
    );
  }
  return null;
}

export function getCurrentSelectionPageLocationFromReader(
  reader: any,
  selectionText: string,
): LivePdfSelectionPageLocation | null {
  const normalizedSelection = normalizeLocatorText(selectionText);
  if (!normalizedSelection) return null;

  const docs = collectReaderSelectionDocuments(reader);
  const contextItemId = (() => {
    const raw = Number(reader?._item?.id || reader?.itemID || 0);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
  })();

  for (const doc of docs) {
    const selectedText = sanitizeText(
      doc.defaultView?.getSelection?.()?.toString() || "",
    ).trim();
    if (!selectedText) continue;
    if (normalizeLocatorText(selectedText) !== normalizedSelection) continue;
    const selectionPageElement = getSelectionPageElement(doc);
    const pageIndex = parsePageIndexFromElement(selectionPageElement);
    if (pageIndex === null) continue;
    return {
      contextItemId,
      pageIndex,
      pageLabel: getPageLabelFromElement(selectionPageElement),
      pagesScanned: countRenderedPages(doc),
    };
  }

  return null;
}

export async function flashPageInLivePdfReader(
  reader: any,
  pageIndex: number,
): Promise<boolean> {
  if (!Number.isFinite(pageIndex) || pageIndex < 0) return false;
  const normalizedPageIndex = Math.floor(pageIndex);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1800) {
    const app = getPdfViewerApplication(reader);
    const pageView = app?.pdfViewer?.getPageView?.(normalizedPageIndex);
    const directPageElement = isElementNode(pageView?.div) ? pageView.div : null;
    if (directPageElement) {
      flashPageElement(directPageElement);
      return true;
    }

    const docs = collectReaderSelectionDocuments(reader);
    for (const doc of docs) {
      const pageElement = getPageElementByIndex(doc, normalizedPageIndex);
      if (!pageElement) continue;
      flashPageElement(pageElement);
      return true;
    }
    await delay(40);
  }
  return false;
}

function extractPageTextFromElement(pageElement: Element): string {
  const textLayer =
    pageElement.querySelector(".textLayer") ||
    pageElement.querySelector('[class*="textLayer"]');
  return sanitizeText((textLayer?.textContent || pageElement.textContent || "").trim());
}

function extractRenderedPageTexts(reader: any): {
  pages: LivePdfPageText[];
  expectedPageIndex: number | null;
} {
  const app = getPdfViewerApplication(reader);
  const pagesByIndex = new Map<number, LivePdfPageText>();
  const docs = collectReaderSelectionDocuments(reader);
  for (const doc of docs) {
    const pageElements = Array.from(doc.querySelectorAll(PAGE_CONTAINER_SELECTOR)).filter(
      isElementNode,
    );
    for (const pageElement of pageElements) {
      const pageIndex = parsePageIndexFromElement(pageElement);
      if (pageIndex === null || pagesByIndex.has(pageIndex)) continue;
      const text = extractPageTextFromElement(pageElement);
      if (!text) continue;
      pagesByIndex.set(pageIndex, {
        pageIndex,
        pageLabel: getPageLabelFromElement(pageElement) || `${pageIndex + 1}`,
        text,
      });
    }
  }

  return {
    pages: Array.from(pagesByIndex.values()).sort((a, b) => a.pageIndex - b.pageIndex),
    expectedPageIndex: getExpectedPageIndex(reader, app),
  };
}

function getPagesCount(app: any): number {
  const candidates = [app?.pagesCount, app?.pdfDocument?.numPages];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return 0;
}

function shouldRunExactQuoteQuery(quoteText: string): boolean {
  const tokens = extractSearchTokens(quoteText);
  return tokens.length > 0 && tokens.length <= 24 && quoteText.length <= 220;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFindControllerPageMatches(
  findController: any,
  pagesCount: number,
  expectedQuery: string,
  timeoutMs = 4000,
): Promise<unknown[]> {
  const startedAt = Date.now();
  let latestMatches: unknown[] = [];
  while (Date.now() - startedAt < timeoutMs) {
    if (String(findController?._rawQuery || "") !== expectedQuery) {
      await delay(25);
      continue;
    }
    const pageMatches = Array.isArray(findController?.pageMatches)
      ? findController.pageMatches
      : [];
    if (pageMatches.length > latestMatches.length) {
      latestMatches = pageMatches;
    }
    const pendingSize =
      typeof findController?._pendingFindMatches?.size === "number"
        ? findController._pendingFindMatches.size
        : 0;
    const pagesToSearch = Number.isFinite(findController?._pagesToSearch)
      ? Number(findController._pagesToSearch)
      : null;
    if ((pageMatches.length >= pagesCount || pagesToSearch === 0) && pendingSize === 0) {
      return pageMatches;
    }
    await delay(50);
  }
  return latestMatches;
}

function summarizeFindControllerMatches(pageMatches: unknown[]): {
  matchedPageIndexes: number[];
  totalMatches: number;
  pageMatchCounts: number[];
} {
  const matchedPageIndexes: number[] = [];
  const pageMatchCounts: number[] = [];
  let totalMatches = 0;
  for (let pageIndex = 0; pageIndex < pageMatches.length; pageIndex += 1) {
    const matches: unknown[] = Array.isArray(pageMatches[pageIndex])
      ? (pageMatches[pageIndex] as unknown[])
      : [];
    if (!matches.length) continue;
    matchedPageIndexes.push(pageIndex);
    pageMatchCounts[pageIndex] = matches.length;
    totalMatches += matches.length;
  }
  return { matchedPageIndexes, totalMatches, pageMatchCounts };
}

async function searchFindControllerForQuery(
  reader: any,
  query: string,
): Promise<{
  matchedPageIndexes: number[];
  totalMatches: number;
  pagesCount: number;
  pageMatchCounts: number[];
} | null> {
  const app = getPdfViewerApplication(reader);
  const findController = app?.findController;
  const eventBus = app?.eventBus;
  const pagesCount = getPagesCount(app);
  if (!findController || !eventBus || pagesCount < 1) {
    return null;
  }

  eventBus.dispatch("find", {
    source: { source: "llm-live-quote-demo" },
    type: "",
    query,
    phraseSearch: true,
    caseSensitive: false,
    entireWord: false,
    highlightAll: false,
    findPrevious: false,
    matchDiacritics: false,
  });

  const pageMatches = await waitForFindControllerPageMatches(
    findController,
    pagesCount,
    query,
  );
  return {
    ...summarizeFindControllerMatches(pageMatches),
    pagesCount,
  };
}

function buildFindControllerQuoteResult(
  quoteText: string,
  expectedPageIndex: number | null,
  searchResult: {
    matchedPageIndexes: number[];
    totalMatches: number;
    pagesCount: number;
  },
  reason: string,
  confidence: LivePdfSelectionLocateConfidence,
  computedPageIndex: number | null,
  debugSummary?: string[],
): LivePdfSelectionLocateResult {
  return {
    status: computedPageIndex === null ? "ambiguous" : "resolved",
    confidence,
    selectionText: sanitizeText(quoteText || "").trim(),
    normalizedSelection: normalizeLocatorText(quoteText),
    queryLabel: "Quote",
    expectedPageIndex,
    computedPageIndex,
    matchedPageIndexes: searchResult.matchedPageIndexes,
    totalMatches: searchResult.totalMatches,
    pagesScanned: searchResult.pagesCount,
    debugSummary,
    reason,
  };
}

function buildPageTextQuoteResult(
  quoteText: string,
  expectedPageIndex: number | null,
  searchResult: {
    matchedPageIndexes: number[];
    totalMatches: number;
    excerpt?: string;
  },
  pagesScanned: number,
  reason: string,
  confidence: LivePdfSelectionLocateConfidence,
  computedPageIndex: number | null,
  debugSummary?: string[],
): LivePdfSelectionLocateResult {
  return {
    status: computedPageIndex === null ? "ambiguous" : "resolved",
    confidence,
    selectionText: sanitizeText(quoteText || "").trim(),
    normalizedSelection: normalizeLocatorText(quoteText),
    queryLabel: "Quote",
    expectedPageIndex,
    computedPageIndex,
    matchedPageIndexes: searchResult.matchedPageIndexes,
    totalMatches: searchResult.totalMatches,
    pagesScanned,
    excerpt: searchResult.excerpt,
    debugSummary,
    reason,
  };
}

function locateQuoteProgressivelyInPageTexts(
  pages: LivePdfPageText[],
  quoteText: string,
  expectedPageIndex: number | null,
): {
  result: LivePdfSelectionLocateResult | null;
  debugSummary: string[];
} {
  const tokens = extractSearchTokens(quoteText);
  const pageIndexEntries = buildPageTextIndex(pages);
  const debugSummary: string[] = [];
  const minQueryLength = tokens.length >= 12 ? 4 : 3;
  const maxQueryLength = Math.min(tokens.length, 14);
  for (const offset of getProgressiveStartOffsets(tokens)) {
    for (
      let queryLength = minQueryLength;
      queryLength <= maxQueryLength && offset + queryLength <= tokens.length;
      queryLength += 1
    ) {
      const query = tokens.slice(offset, offset + queryLength).join(" ");
      const searchResult = searchPageIndexEntries(pageIndexEntries, query);
      debugSummary.push(
        `Rendered prefix query: "${formatQuerySnippet(query)}" -> ${formatPageList(searchResult.matchedPageIndexes)}`,
      );
      if (searchResult.matchedPageIndexes.length === 1) {
        return {
          result: buildPageTextQuoteResult(
            quoteText,
            expectedPageIndex,
            searchResult,
            pages.length,
            "The progressive rendered-page quote search found a unique page.",
            queryLength >= 6 ? "high" : "medium",
            searchResult.matchedPageIndexes[0],
            debugSummary,
          ),
          debugSummary,
        };
      }
      if (!searchResult.matchedPageIndexes.length) {
        break;
      }
    }
  }
  return { result: null, debugSummary };
}

async function locateQuoteProgressivelyWithFindController(
  reader: any,
  quoteText: string,
  expectedPageIndex: number | null,
): Promise<{
  result: LivePdfSelectionLocateResult | null;
  debugSummary: string[];
}> {
  const tokens = extractSearchTokens(quoteText);
  const debugSummary: string[] = [];
  const minQueryLength = tokens.length >= 12 ? 4 : 3;
  const maxQueryLength = Math.min(tokens.length, 14);
  for (const offset of getProgressiveStartOffsets(tokens)) {
    for (
      let queryLength = minQueryLength;
      queryLength <= maxQueryLength && offset + queryLength <= tokens.length;
      queryLength += 1
    ) {
      const query = tokens.slice(offset, offset + queryLength).join(" ");
      const searchResult = await searchFindControllerForQuery(reader, query);
      if (!searchResult) {
        return { result: null, debugSummary };
      }
      debugSummary.push(
        `Progressive query: "${formatQuerySnippet(query)}" -> ${formatPageList(searchResult.matchedPageIndexes)}`,
      );
      if (searchResult.matchedPageIndexes.length === 1) {
        return {
          result: buildFindControllerQuoteResult(
            quoteText,
            expectedPageIndex,
            searchResult,
            "The live reader progressive quote search found a unique page.",
            searchResult.totalMatches > 1 ? "medium" : "high",
            searchResult.matchedPageIndexes[0],
            debugSummary,
          ),
          debugSummary,
        };
      }
      if (!searchResult.matchedPageIndexes.length) {
        break;
      }
    }
  }
  return { result: null, debugSummary };
}

async function locateQuoteWithFindController(
  reader: any,
  quoteText: string,
): Promise<LivePdfSelectionLocateResult | null> {
  const app = getPdfViewerApplication(reader);
  const pagesCount = getPagesCount(app);
  if (pagesCount < 1) {
    return null;
  }

  const expectedPageIndex = getExpectedPageIndex(reader, app);
  const cleanQuote = sanitizeText(quoteText || "").trim();
  const exactQuery = extractSearchTokens(cleanQuote).join(" ");
  const exactResult = shouldRunExactQuoteQuery(cleanQuote) && exactQuery
    ? await searchFindControllerForQuery(reader, exactQuery)
    : null;
  if (exactResult?.matchedPageIndexes.length === 1) {
    return buildFindControllerQuoteResult(
      cleanQuote,
      expectedPageIndex,
      exactResult,
      exactResult.totalMatches > 1
        ? "The live reader full-document exact-quote search found the quote multiple times on the same page."
        : "The live reader full-document exact-quote search found the quote on a single page.",
      exactResult.totalMatches > 1 ? "low" : "high",
      exactResult.matchedPageIndexes[0],
      [`Exact query -> ${formatPageList(exactResult.matchedPageIndexes)}`],
    );
  }

  const progressiveResult = await locateQuoteProgressivelyWithFindController(
    reader,
    cleanQuote,
    expectedPageIndex,
  );
  if (progressiveResult.result) {
    return progressiveResult.result;
  }

  const anchors = buildQuoteAnchors(cleanQuote);
  const scoreByPage = new Map<number, QuotePageScore>();
  const informativeAnchorKeys = new Set<string>();
  const anchorSummaries = [...progressiveResult.debugSummary];
  let earlyStopReason: string | undefined;
  for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex += 1) {
    const anchor = anchors[anchorIndex];
    const skipReason = getQuoteAnchorSkipReason(anchor);
    if (skipReason) {
      anchorSummaries.push(`Anchor skipped: "${anchor}" (${skipReason})`);
      continue;
    }
    const anchorResult = await searchFindControllerForQuery(reader, anchor);
    if (!anchorResult?.matchedPageIndexes.length) {
      anchorSummaries.push(`Anchor miss: "${anchor}"`);
      continue;
    }
    if (
      anchorResult.matchedPageIndexes.length >
      Math.max(3, Math.ceil(anchorResult.pagesCount * 0.35))
    ) {
      anchorSummaries.push(
        `Anchor skipped: "${anchor}" (too broad: ${formatPageList(anchorResult.matchedPageIndexes)})`,
      );
      continue;
    }
    const normalizedAnchor = normalizeLocatorText(anchor);
    informativeAnchorKeys.add(normalizedAnchor);
    anchorSummaries.push(
      `Anchor hit: "${anchor}" -> ${formatPageList(anchorResult.matchedPageIndexes)}`,
    );
    for (const pageIndex of anchorResult.matchedPageIndexes) {
      const score = scoreByPage.get(pageIndex) || {
        pageIndex,
        matchedAnchorKeys: new Set<string>(),
        totalMatches: 0,
      };
      score.matchedAnchorKeys.add(normalizedAnchor);
      score.totalMatches += anchorResult.pageMatchCounts[pageIndex] || 0;
      scoreByPage.set(pageIndex, score);
    }
    const remainingAnchors = anchors.length - anchorIndex - 1;
    if (shouldEarlyStopQuoteVoting(scoreByPage, remainingAnchors)) {
      const leadingPage = Array.from(scoreByPage.values()).sort(
        (left, right) => right.matchedAnchorKeys.size - left.matchedAnchorKeys.size,
      )[0];
      earlyStopReason = `Early stop: page ${leadingPage.pageIndex + 1} cannot be overtaken with ${remainingAnchors} anchors remaining.`;
      break;
    }
  }

  const debugSummary = buildQuoteDebugSummary(
    scoreByPage,
    anchorSummaries,
    "Find",
    earlyStopReason,
  );
  const anchorScoreResult = buildQuoteAnchorResult(
    scoreByPage,
    informativeAnchorKeys.size,
    cleanQuote,
    expectedPageIndex,
    pagesCount,
    "The live reader full-document search did not find the current quote.",
    debugSummary,
  );
  if (
    anchorScoreResult.status === "resolved" ||
    anchorScoreResult.status === "ambiguous"
  ) {
    return {
      ...anchorScoreResult,
      reason: anchorScoreResult.reason
        ? `${anchorScoreResult.reason} This result came from the live reader full-document anchor search.`
        : "This result came from the live reader full-document anchor search.",
    };
  }

  if (exactResult?.matchedPageIndexes.length) {
    return {
      ...buildFindControllerQuoteResult(
        cleanQuote,
        expectedPageIndex,
        exactResult,
        "The live reader full-document exact-quote search found the quote on multiple pages.",
        "low",
        null,
        [`Exact query -> ${formatPageList(exactResult.matchedPageIndexes)}`],
      ),
      status: "ambiguous",
    };
  }

  return anchorScoreResult;
}

export async function locateCurrentSelectionInLivePdfReader(
  reader: any,
  selectionText: string,
): Promise<LivePdfSelectionLocateResult> {
  const cleanSelection = sanitizeText(selectionText || "").trim();
  if (!cleanSelection) {
    return {
      status: "unavailable",
      confidence: "none",
      selectionText: cleanSelection,
      normalizedSelection: "",
      queryLabel: "Selection",
      expectedPageIndex: null,
      computedPageIndex: null,
      matchedPageIndexes: [],
      totalMatches: 0,
      pagesScanned: 0,
      reason: "No live reader selection was available.",
    };
  }

  try {
    const domResolved = locateCurrentSelectionFromDom(reader, cleanSelection);
    if (domResolved) {
      return domResolved;
    }

    const { pages, expectedPageIndex } = extractRenderedPageTexts(reader);
    if (!pages.length) {
      return {
        status: "unavailable",
        confidence: "none",
        selectionText: cleanSelection,
        normalizedSelection: normalizeLocatorText(cleanSelection),
        queryLabel: "Selection",
        expectedPageIndex,
        computedPageIndex: null,
        matchedPageIndexes: [],
        totalMatches: 0,
        pagesScanned: 0,
        reason: "The active reader did not expose a live selection page or rendered page text.",
      };
    }

    const result = locateSelectionInPageTexts(pages, cleanSelection, expectedPageIndex, {
      queryLabel: "Selection",
    });
    if (result.status === "resolved" && result.reason) {
      return {
        ...result,
        reason: `${result.reason} This was matched against the currently rendered live reader pages.`,
      };
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "unavailable",
      confidence: "none",
      selectionText: cleanSelection,
      normalizedSelection: normalizeLocatorText(cleanSelection),
      queryLabel: "Selection",
      expectedPageIndex: getExpectedPageIndex(reader, getPdfViewerApplication(reader)),
      computedPageIndex: null,
      matchedPageIndexes: [],
      totalMatches: 0,
      pagesScanned: 0,
      reason: `Live reader locator failed: ${message}`,
    };
  }
}

export async function locateQuoteInLivePdfReader(
  reader: any,
  quoteText: string,
): Promise<LivePdfSelectionLocateResult> {
  const cleanQuote = sanitizeText(quoteText || "").trim();
  if (!cleanQuote) {
    return {
      status: "unavailable",
      confidence: "none",
      selectionText: cleanQuote,
      normalizedSelection: "",
      queryLabel: "Quote",
      expectedPageIndex: null,
      computedPageIndex: null,
      matchedPageIndexes: [],
      totalMatches: 0,
      pagesScanned: 0,
      reason: "No quote text was provided.",
    };
  }

  try {
    const { pages, expectedPageIndex } = extractRenderedPageTexts(reader);
    if (pages.length) {
      const progressiveRenderedResult = locateQuoteProgressivelyInPageTexts(
        pages,
        cleanQuote,
        expectedPageIndex,
      );
      if (progressiveRenderedResult.result) {
        return progressiveRenderedResult.result;
      }

      const fullDocumentResult = await locateQuoteWithFindController(reader, cleanQuote);
      if (
        fullDocumentResult &&
        (fullDocumentResult.status === "resolved" || fullDocumentResult.status === "ambiguous")
      ) {
        return fullDocumentResult;
      }

      const renderedResult = locateQuoteInPageTexts(
        pages,
        cleanQuote,
        expectedPageIndex,
      );
      if (progressiveRenderedResult.debugSummary.length) {
        renderedResult.debugSummary = [
          ...progressiveRenderedResult.debugSummary,
          ...(renderedResult.debugSummary || []),
        ].slice(0, 10);
      }
      if (renderedResult.status !== "not-found") {
        return {
          ...renderedResult,
          reason: renderedResult.reason
            ? `${renderedResult.reason} This result came from the currently rendered live reader pages.`
            : "This result came from the currently rendered live reader pages.",
        };
      }
      if (fullDocumentResult?.reason) {
        return {
          ...renderedResult,
          debugSummary: [
            ...progressiveRenderedResult.debugSummary,
            ...(renderedResult.debugSummary || []),
          ].slice(0, 10),
          reason: `${fullDocumentResult.reason} Rendered-page fallback also did not find it.`,
        };
      }
      return renderedResult;
    }

    const fullDocumentResult = await locateQuoteWithFindController(reader, cleanQuote);
    if (
      fullDocumentResult &&
      (fullDocumentResult.status === "resolved" || fullDocumentResult.status === "ambiguous")
    ) {
      return fullDocumentResult;
    }

    if (fullDocumentResult) {
      return fullDocumentResult;
    }

    return {
      status: "unavailable",
      confidence: "none",
      selectionText: cleanQuote,
      normalizedSelection: normalizeLocatorText(cleanQuote),
      queryLabel: "Quote",
      expectedPageIndex: getExpectedPageIndex(reader, getPdfViewerApplication(reader)),
      computedPageIndex: null,
      matchedPageIndexes: [],
      totalMatches: 0,
      pagesScanned: 0,
      reason: "The active reader did not expose a live quote-search path or rendered page text.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "unavailable",
      confidence: "none",
      selectionText: cleanQuote,
      normalizedSelection: normalizeLocatorText(cleanQuote),
      queryLabel: "Quote",
      expectedPageIndex: getExpectedPageIndex(reader, getPdfViewerApplication(reader)),
      computedPageIndex: null,
      matchedPageIndexes: [],
      totalMatches: 0,
      pagesScanned: 0,
      reason: `Live quote locator failed: ${message}`,
    };
  }
}
