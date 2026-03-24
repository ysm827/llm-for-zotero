/**
 * Context Panel Module
 *
 * This is the main entry point for the LLM context panel, which provides
 * a chat interface in Zotero's reader/library side panel.
 *
 * The module is split into focused sub-modules:
 * - constants.ts   – shared constants
 * - types.ts       – shared type definitions
 * - state.ts       – module-level mutable state
 * - buildUI.ts     – UI construction
 * - setupHandlers.ts – event handler wiring
 * - chat.ts        – conversation logic, send/refresh
 * - shortcuts.ts   – shortcut rendering and management
 * - screenshot.ts  – screenshot capture from PDF reader
 * - pdfContext.ts   – PDF text extraction, chunking, BM25, embeddings
 * - multiContextPlanner.ts – budget-first adaptive multi-context assembly
 * - notes.ts       – Zotero note creation from chat
 * - contextResolution.ts – tab/reader context resolution
 * - menuPositioning.ts   – dropdown/context menu positioning
 * - prefHelpers.ts – preference access helpers
 * - textUtils.ts   – text sanitization, formatting
 */

import { getLocaleID } from "../../utils/locale";
import { config, PANE_ID } from "./constants";
import type { Message } from "./types";
import {
  activeConversationModeByLibrary,
  activeGlobalConversationByLibrary,
  activeContextPanels,
  activeContextPanelStateSync,
  chatHistory,
  loadedConversationKeys,
  readerContextPanelRegistered,
  setReaderContextPanelRegistered,
  recentReaderSelectionCache,
} from "./state";
import { clearConversation as clearStoredConversation } from "../../utils/chatStore";
import {
  ATTACHMENT_GC_MIN_AGE_MS,
  clearOwnerAttachmentRefs,
  collectAndDeleteUnreferencedBlobs,
} from "../../utils/attachmentRefStore";
import { normalizeSelectedText, setStatus } from "./textUtils";
import { buildUI, syncGlobalLockVisibility } from "./buildUI";
import { setupHandlers } from "./setupHandlers";
import { ensureConversationLoaded } from "./chat";
import { renderShortcuts } from "./shortcuts";
import { refreshChat } from "./chat";
import {
  getActiveContextAttachmentFromTabs,
  getActiveReaderForSelectedTab,
  getItemSelectionCacheKeys,
  appendSelectedTextContextForItem,
  applySelectedTextPreview,
  syncSelectedTextContextForSource,
} from "./contextResolution";
import { ensurePDFTextCached, ensureNoteTextCached } from "./pdfContext";
import { resolveCurrentSelectionPageLocationFromReader } from "./livePdfSelectionLocator";
import {
  getFirstSelectionFromReader,
  getSelectionFromDocument,
} from "./readerSelection";
import { resolveReaderPopupPaperContext } from "./readerPopup";
import { resolveInitialPanelItemState, resolveActiveLibraryID } from "./portalScope";
import { getLockedGlobalConversationKey } from "./prefHelpers";
import { getEditableSelectionFromDocument } from "./noteSelection";

// =============================================================================
// Public API
// =============================================================================

export function registerLLMStyles(win: _ZoteroTypes.MainWindow) {
  const doc = win.document;
  if (doc.getElementById(`${config.addonRef}-styles`)) return;

  // Main styles
  const link = doc.createElement("link") as HTMLLinkElement;
  link.id = `${config.addonRef}-styles`;
  link.rel = "stylesheet";
  link.type = "text/css";
  link.href = `chrome://${config.addonRef}/content/zoteroPane.css`;
  doc.documentElement?.appendChild(link);

  // KaTeX styles for math rendering
  const katexLink = doc.createElement("link") as HTMLLinkElement;
  katexLink.id = `${config.addonRef}-katex-styles`;
  katexLink.rel = "stylesheet";
  katexLink.type = "text/css";
  katexLink.href = `chrome://${config.addonRef}/content/vendor/katex/katex.min.css`;
  doc.documentElement?.appendChild(katexLink);
}

export function registerReaderContextPanel() {
  if (readerContextPanelRegistered) return;
  setReaderContextPanelRegistered(true);
  // Generation counter: incremented on every onAsyncRender call so stale
  // (superseded) renders can bail out at each await point.
  let renderGeneration = 0;
  Zotero.ItemPaneManager.registerSection({
    paneID: PANE_ID,
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("llm-panel-head"),
      icon: `chrome://${config.addonRef}/content/icons/icon-20.png`,
    },
    sidenav: {
      l10nID: getLocaleID("llm-panel-sidenav-tooltip"),
      icon: `chrome://${config.addonRef}/content/icons/icon-20.png`,
    },
    onInit: ({ setEnabled, tabType }) => {
      setEnabled(true);
      ztoolkit.log(`LLM: panel init tabType=${tabType}`);
    },
    onItemChange: ({ setEnabled, tabType }) => {
      setEnabled(true);
      ztoolkit.log(`LLM: panel itemChange tabType=${tabType}`);
      // Refresh the cached tab ID (side effect of getActiveReaderForSelectedTab)
      getActiveReaderForSelectedTab();
      return true;
    },
    onRender: ({ body, item }) => {
      syncGlobalLockVisibility(body);
      // If a global lock is active but the panel is showing paper chat,
      // the panel state is stale (e.g. tab was already open before auto-lock).
      // Schedule a full async re-render so the panel switches to the locked session.
      try {
        const libraryID = resolveActiveLibraryID() || 0;
        const lockedKey = libraryID > 0 ? getLockedGlobalConversationKey(libraryID) : null;
        const panelRoot = body.querySelector("#llm-main") as HTMLElement | null;
        const currentKind = panelRoot?.dataset?.conversationKind;
        if (lockedKey !== null && currentKind === "paper") {
          const resolvedState = resolveInitialPanelItemState(item);
          // Micro-task so onRender returns synchronously
          void (async () => {
            try {
              buildUI(body, resolvedState.item);
              if (resolvedState.item) await ensureConversationLoaded(resolvedState.item);
              setupHandlers(body, item);
              refreshChat(body, resolvedState.item);
            } catch { /* ignore */ }
          })();
        }
      } catch { /* ignore */ }
    },
    onAsyncRender: async ({ body, item, setEnabled, tabType }) => {
      setEnabled(true);
      const thisGeneration = ++renderGeneration;
      ztoolkit.log(
        `LLM: panel asyncRender tabType=${tabType} hasItem=${Boolean(item)} gen=${thisGeneration}`,
      );

      const resolvedInitialState = resolveInitialPanelItemState(item);
      const resolvedItem = resolvedInitialState.item;
      const basePaperItem = resolvedInitialState.basePaperItem;

      buildUI(body, resolvedItem);
      
      if (resolvedItem) {
        await ensureConversationLoaded(resolvedItem);
      }
      // Bail if a newer render has started while we were awaiting.
      if (renderGeneration !== thisGeneration) return;
      await renderShortcuts(body, resolvedItem);
      if (renderGeneration !== thisGeneration) return;
      setupHandlers(body, item); // setupHandlers will re-resolve its own state from item
      refreshChat(body, resolvedItem);
      // Defer content extraction so the panel becomes interactive sooner.
      const activeContextItem = getActiveContextAttachmentFromTabs();
      if (activeContextItem) {
        void ensurePDFTextCached(activeContextItem);
      } else if (item && (item as any).isNote?.()) {
        void ensureNoteTextCached(item);
      }
    },
  });
}

export function registerReaderSelectionTracking() {
  const readerAPI = Zotero.Reader as _ZoteroTypes.Reader & {
    __llmSelectionTrackingRegistered?: boolean;
  };
  if (!readerAPI || readerAPI.__llmSelectionTrackingRegistered) return;

  const handler: _ZoteroTypes.Reader.EventHandler<
    "renderTextSelectionPopup"
  > = (event) => {
    const selectedText = (() => {
      const fromAnnotation = normalizeSelectedText(
        event.params?.annotation?.text || "",
      );
      if (fromAnnotation) return fromAnnotation;
      const fromPopupDoc = getSelectionFromDocument(
        event.doc,
        normalizeSelectedText,
      );
      if (fromPopupDoc) return fromPopupDoc;
      return getFirstSelectionFromReader(
        event.reader as any,
        normalizeSelectedText,
      );
    })();
    const itemId = event.reader?._item?.id || event.reader?.itemID;
    if (typeof itemId !== "number") return;
    const item = Zotero.Items.get(itemId) || null;
    const cacheKeys = getItemSelectionCacheKeys(item);
    const keys = cacheKeys.length ? cacheKeys : [itemId];
    const popupPrefValue = Zotero.Prefs.get(
      `${config.prefsPrefix}.showPopupAddText`,
      true,
    );
    const showAddTextInPopup =
      popupPrefValue !== false &&
      `${popupPrefValue || ""}`.toLowerCase() !== "false";

    const resolveSelectedTextForPopupAction = (): string => {
      const fromPopupDoc = getSelectionFromDocument(
        event.doc,
        normalizeSelectedText,
      );
      if (fromPopupDoc) return fromPopupDoc;
      const fromParams = normalizeSelectedText(
        (event.params as unknown as { text?: string; selectedText?: string })
          ?.text ||
          (event.params as unknown as { text?: string; selectedText?: string })
            ?.selectedText ||
          "",
      );
      if (fromParams) return fromParams;
      const fromAnnotation = normalizeSelectedText(
        event.params?.annotation?.text || "",
      );
      if (fromAnnotation) return fromAnnotation;
      const fromReader = getFirstSelectionFromReader(
        event.reader as any,
        normalizeSelectedText,
      );
      if (fromReader) return fromReader;
      for (const key of keys) {
        const cached = normalizeSelectedText(
          recentReaderSelectionCache.get(key) || "",
        );
        if (cached) return cached;
      }
      return "";
    };

    if (selectedText || showAddTextInPopup) {
      let popupSentinelEl: HTMLElement | null = null;
      const addTextToPanel = async () => {
        const effectiveSelectedText =
          normalizeSelectedText(selectedText) ||
          resolveSelectedTextForPopupAction();
        if (!effectiveSelectedText) {
          ztoolkit.log("LLM: Add Text popup action skipped (no selection)");
          return;
        }
        try {
          const panelRecords: Array<{
            body: Element;
            root: HTMLDivElement;
          }> = [];
          const seenRoots = new Set<Element>();
          const pushPanelRecord = (
            body: Element | null | undefined,
            root: HTMLDivElement | null | undefined,
          ) => {
            if (!body || !root || seenRoots.has(root)) return;
            seenRoots.add(root);
            panelRecords.push({ body, root });
          };
          for (const [panelBody] of activeContextPanels.entries()) {
            if (!(panelBody as Element).isConnected) {
              activeContextPanels.delete(panelBody);
              activeContextPanelStateSync.delete(panelBody);
              continue;
            }
            const root = panelBody.querySelector(
              "#llm-main",
            ) as HTMLDivElement | null;
            pushPanelRecord(panelBody, root);
          }
          const docs = new Set<Document>();
          const pushDoc = (doc?: Document | null) => {
            if (doc) docs.add(doc);
          };
          pushDoc(event.doc);
          pushDoc(event.doc.defaultView?.top?.document || null);
          try {
            pushDoc(Zotero.getMainWindow()?.document || null);
          } catch (_err) {
            void _err;
          }
          try {
            const wins = Zotero.getMainWindows?.() || [];
            for (const win of wins) {
              pushDoc(win?.document || null);
            }
          } catch (_err) {
            void _err;
          }

          if (!panelRecords.length) {
            for (const doc of docs) {
              const roots = Array.from(
                doc.querySelectorAll("#llm-main"),
              ) as HTMLDivElement[];
              for (const root of roots) {
                const panelBody = root.parentElement || root;
                pushPanelRecord(panelBody, root);
              }
            }
          }
          if (!panelRecords.length) return;

          const readerLibraryID = Number(item?.libraryID || 0);
          const normalizedReaderLibraryID =
            Number.isFinite(readerLibraryID) && readerLibraryID > 0
              ? Math.floor(readerLibraryID)
              : 0;
          const readerModeLock =
            normalizedReaderLibraryID > 0
              ? activeConversationModeByLibrary.get(normalizedReaderLibraryID)
              : null;
          const readerGlobalConversationKey =
            readerModeLock === "global" && normalizedReaderLibraryID > 0
              ? Math.floor(
                  Number(
                    activeGlobalConversationByLibrary.get(
                      normalizedReaderLibraryID,
                    ) || 0,
                  ),
                )
              : 0;
          const readerPaperContext = resolveReaderPopupPaperContext(
            item,
            getActiveContextAttachmentFromTabs(),
          );
          const readerPaperItemID =
            readerPaperContext && Number.isFinite(readerPaperContext.itemId)
              ? Math.floor(readerPaperContext.itemId)
              : 0;
          const getPanelItemId = (root: HTMLDivElement): number | null => {
            const parsed = Number(root.dataset.itemId || 0);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
          };
          const getPanelLibraryId = (root: HTMLDivElement): number | null => {
            const parsed = Number(root.dataset.libraryId || 0);
            return Number.isFinite(parsed) && parsed > 0
              ? Math.floor(parsed)
              : null;
          };
          const getPanelConversationKind = (
            root: HTMLDivElement,
          ): "global" | "paper" | null => {
            const raw = `${root.dataset.conversationKind || ""}`
              .trim()
              .toLowerCase();
            if (raw === "global") return "global";
            if (raw === "paper") return "paper";
            return null;
          };
          const getPanelBasePaperItemID = (
            root: HTMLDivElement,
          ): number | null => {
            const parsed = Number(root.dataset.basePaperItemId || 0);
            return Number.isFinite(parsed) && parsed > 0
              ? Math.floor(parsed)
              : null;
          };
          const isVisible = (root: HTMLElement) =>
            root.getClientRects().length > 0;
          const popupTopDoc = event.doc.defaultView?.top?.document || null;
          const rootStates = panelRecords
            .map(({ body, root }) => {
              const ownerDoc = body.ownerDocument;
              const panelItemId = getPanelItemId(root);
              const panelLibraryId = getPanelLibraryId(root);
              const conversationKind = getPanelConversationKind(root);
              const conversationKey = panelItemId;
              const basePaperItemID = getPanelBasePaperItemID(root);
              const sameConversationMode =
                readerModeLock === "global"
                  ? conversationKind === "global"
                  : readerModeLock === "paper"
                    ? conversationKind === "paper"
                    : false;
              return {
                body,
                root,
                panelItemId,
                panelLibraryId,
                conversationKind,
                basePaperItemID,
                conversationKey,
                visible: isVisible(root),
                sameDoc: popupTopDoc ? ownerDoc === popupTopDoc : false,
                sameLibrary:
                  normalizedReaderLibraryID > 0 &&
                  panelLibraryId === normalizedReaderLibraryID,
                matchesReaderPaper:
                  readerPaperItemID > 0 &&
                  basePaperItemID !== null &&
                  basePaperItemID === readerPaperItemID,
                matchesLockedGlobal:
                  readerGlobalConversationKey > 0 &&
                  conversationKey === readerGlobalConversationKey,
                sameConversationMode,
                hasActiveFocus: Boolean(
                  ownerDoc?.activeElement &&
                  root.contains(ownerDoc.activeElement),
                ),
              };
            })
            .filter(
              (state) =>
                state.panelItemId !== null &&
                state.conversationKey !== null &&
                state.conversationKind !== null,
            );
          if (!rootStates.length) return;
          const sameLibraryStates =
            normalizedReaderLibraryID > 0
              ? rootStates.filter((state) => state.sameLibrary)
              : [];
          const rankedStates = sameLibraryStates.length
            ? sameLibraryStates
            : rootStates;

          // Deterministic status/focus target ranking:
          // 1) same doc + visible + focused panel
          // 2) visible + focused panel
          // 3) same doc + visible + matching global lock
          // 4) same doc + visible + matching reader paper
          // 5) same doc + visible
          // 6) visible + matching global lock
          // 7) visible + matching reader paper
          // 8) visible
          // 9) same doc
          // 10) focused panel
          const scoreState = (state: (typeof rankedStates)[number]) => {
            if (state.sameDoc && state.visible && state.hasActiveFocus)
              return 8;
            if (state.visible && state.hasActiveFocus) return 7;
            if (state.sameDoc && state.visible && state.matchesLockedGlobal)
              return 6.5;
            if (state.sameDoc && state.visible && state.matchesReaderPaper)
              return 6;
            if (state.visible && state.sameConversationMode) return 5.5;
            if (state.sameDoc && state.visible) return 5;
            if (state.visible && state.matchesLockedGlobal) return 4.5;
            if (state.visible && state.matchesReaderPaper) return 4;
            if (state.visible) return 3;
            if (state.sameDoc) return 2;
            if (state.hasActiveFocus) return 1;
            return 0;
          };
          let bestState = rankedStates[0];
          let bestScore = scoreState(bestState);
          for (const state of rankedStates.slice(1)) {
            const score = scoreState(state);
            if (score > bestScore) {
              bestState = state;
              bestScore = score;
            }
          }

          const panelRoot = bestState.root;
          const panelBody = bestState.body;
          const conversationKey = bestState.conversationKey as number;
          const isGlobalConversation = bestState.conversationKind === "global";
          if (!isGlobalConversation) {
            const panelBasePaperItemID = Number(bestState.basePaperItemID || 0);
            const paperMismatch =
              !readerPaperContext ||
              panelBasePaperItemID <= 0 ||
              readerPaperContext.itemId !== panelBasePaperItemID;
            if (paperMismatch) {
              const status = panelBody.querySelector(
                "#llm-status",
              ) as HTMLElement | null;
              if (status) {
                setStatus(
                  status,
                  "Paper mode only accepts text from this paper",
                  "error",
                );
              }
              return;
            }
          }
          const selectedPaperContext = isGlobalConversation
            ? readerPaperContext
            : null;
          const selectedTextLocation =
            await resolveCurrentSelectionPageLocationFromReader(
              event.reader as any,
              effectiveSelectedText,
            );
          const added = appendSelectedTextContextForItem(
            conversationKey,
            effectiveSelectedText,
            "pdf",
            selectedPaperContext,
            selectedTextLocation,
          );
          let refreshedPanels = 0;
          for (const [
            activeBody,
            syncPanelState,
          ] of activeContextPanelStateSync) {
            if (!(activeBody as Element).isConnected) {
              activeContextPanels.delete(activeBody);
              activeContextPanelStateSync.delete(activeBody);
              continue;
            }
            const activeRoot = activeBody.querySelector(
              "#llm-main",
            ) as HTMLDivElement | null;
            const activeConversationKey = activeRoot
              ? Number(activeRoot.dataset.itemId || 0)
              : 0;
            if (
              !Number.isFinite(activeConversationKey) ||
              activeConversationKey !== conversationKey
            ) {
              continue;
            }
            syncPanelState();
            refreshedPanels += 1;
          }
          if (!refreshedPanels) {
            applySelectedTextPreview(panelBody, conversationKey);
          }
          const status = panelBody.querySelector(
            "#llm-status",
          ) as HTMLElement | null;
          if (status) {
            setStatus(
              status,
              added ? "Selected text included" : "Text Context up to 5",
              added ? "ready" : "error",
            );
          }
          if (added) {
            const inputEl = panelBody.querySelector(
              "#llm-input",
            ) as HTMLTextAreaElement | null;
            inputEl?.focus({ preventScroll: true });
          }
        } catch (err) {
          ztoolkit.log("LLM: Add Text popup action failed", err);
        }
      };
      const stripPopupRowChrome = (
        row: HTMLElement | null,
        hideRow: boolean = false,
      ) => {
        if (!row) return;
        const HTMLElementCtor = event.doc.defaultView?.HTMLElement;
        if (hideRow) {
          row.style.display = "none";
        } else {
          row.style.width = "100%";
          row.style.padding = "0 12px";
          row.style.margin = "0";
          row.style.borderTop = "none";
          row.style.borderBottom = "none";
          row.style.boxShadow = "none";
          row.style.background = "transparent";
        }
        const isSeparator = (el: Element | null): el is HTMLElement => {
          if (!el || !HTMLElementCtor || !(el instanceof HTMLElementCtor))
            return false;
          const tag = el.tagName.toLowerCase();
          return tag === "hr" || el.getAttribute("role") === "separator";
        };
        const prev = row.previousElementSibling;
        const next = row.nextElementSibling;
        if (isSeparator(prev)) prev.style.display = "none";
        if (isSeparator(next)) next.style.display = "none";
      };
      if (showAddTextInPopup) {
        try {
          const addTextBtn = event.doc.createElementNS(
            "http://www.w3.org/1999/xhtml",
            "button",
          ) as HTMLButtonElement;
          addTextBtn.type = "button";
          addTextBtn.textContent = "Add Text";
          addTextBtn.title = "Add selected text to LLM panel";
          addTextBtn.style.cssText = [
            "display:block",
            "width:100%",
            "margin:0",
            "padding:6px 8px",
            "box-sizing:border-box",
            "border:1px solid rgba(130,130,130,0.38)",
            "border-radius:6px",
            "background:rgba(255,255,255,0.04)",
            // Keep text readable across light/dark themes.
            "color:inherit",
            "font-size:12px",
            "line-height:1.25",
            "text-align:center",
            "cursor:pointer",
          ].join(";");
          let addTextHandled = false;
          const handleAddTextAction = (e: Event) => {
            if (addTextHandled) return;
            addTextHandled = true;
            e.preventDefault();
            e.stopPropagation();
            void addTextToPanel();
          };
          const isPrimaryButton = (e: Event): boolean => {
            const maybeMouse = e as MouseEvent;
            return (
              typeof maybeMouse.button !== "number" || maybeMouse.button === 0
            );
          };
          // Reader popup items may be removed before "click" fires.
          // Handle early pointer/mouse down as the primary trigger.
          addTextBtn.addEventListener("pointerdown", (e: Event) => {
            if (!isPrimaryButton(e)) return;
            handleAddTextAction(e);
          });
          addTextBtn.addEventListener("mousedown", (e: Event) => {
            if (!isPrimaryButton(e)) return;
            handleAddTextAction(e);
          });
          addTextBtn.addEventListener("click", handleAddTextAction);
          addTextBtn.addEventListener("command", handleAddTextAction);
          event.append(addTextBtn);
          popupSentinelEl = addTextBtn;
          stripPopupRowChrome(addTextBtn.parentElement as HTMLElement | null);
        } catch (err) {
          ztoolkit.log("LLM: failed to append Add Text popup button", err);
        }
      }

      if (selectedText) {
        for (const key of keys) {
          recentReaderSelectionCache.set(key, selectedText);
        }
      } else {
        for (const key of keys) {
          recentReaderSelectionCache.delete(key);
        }
      }

      if (selectedText) {
        try {
          let sentinel = popupSentinelEl;
          if (!sentinel) {
            const fallback = event.doc.createElementNS(
              "http://www.w3.org/1999/xhtml",
              "span",
            ) as HTMLSpanElement;
            fallback.style.display = "none";
            event.append(fallback);
            stripPopupRowChrome(
              fallback.parentElement as HTMLElement | null,
              true,
            );
            sentinel = fallback;
          }

          let wasConnected = false;
          let checks = 0;
          const maxChecks = 600;

          const watchSentinel = () => {
            if (++checks > maxChecks) return;
            if (sentinel.isConnected) {
              wasConnected = true;
              setTimeout(watchSentinel, 500);
              return;
            }
            if (!wasConnected && checks <= 6) {
              setTimeout(watchSentinel, 200);
              return;
            }
            if (wasConnected) {
              for (const key of keys) {
                if (recentReaderSelectionCache.get(key) === selectedText) {
                  recentReaderSelectionCache.delete(key);
                }
              }
            }
          };
          setTimeout(watchSentinel, 100);
        } catch (_err) {
          ztoolkit.log("LLM: selection popup sentinel failed", _err);
        }
      }
    } else {
      for (const key of keys) {
        recentReaderSelectionCache.delete(key);
      }
    }
  };

  Zotero.Reader.registerEventListener(
    "renderTextSelectionPopup",
    handler,
    config.addonID,
  );
  readerAPI.__llmSelectionTrackingRegistered = true;
}

type MainWindowWithNoteEditingTracker = _ZoteroTypes.MainWindow & {
  __llmNoteEditingSelectionTracking?: {
    intervalId: number;
    refresh: () => void;
    lastNoteId: number;
    lastSelectionText: string;
  };
};

function collectAccessibleDocuments(
  rootDoc: Document,
  docs: Document[] = [],
  seen: Set<Document> = new Set<Document>(),
  depth = 0,
): Document[] {
  if (!rootDoc || seen.has(rootDoc) || depth > 3) {
    return docs;
  }
  seen.add(rootDoc);
  docs.push(rootDoc);
  const frames = Array.from(rootDoc.querySelectorAll("iframe"));
  for (const frame of frames) {
    try {
      const frameDoc = (frame as HTMLIFrameElement).contentDocument;
      if (frameDoc) {
        collectAccessibleDocuments(frameDoc, docs, seen, depth + 1);
      }
    } catch (_err) {
      void _err;
    }
  }
  return docs;
}

function getActiveNoteItemFromWindow(
  win: _ZoteroTypes.MainWindow,
): Zotero.Item | null {
  try {
    const tabs = (win as unknown as { Zotero?: { Tabs?: any } }).Zotero?.Tabs;
    const selectedId =
      tabs?.selectedID === undefined || tabs?.selectedID === null
        ? ""
        : `${tabs.selectedID}`;
    const activeTab = Array.isArray(tabs?._tabs)
      ? tabs._tabs.find((tab: Record<string, unknown>) => `${tab?.id || ""}` === selectedId)
      : null;
    const data = (activeTab?.data || {}) as Record<string, unknown>;
    const candidateIds = [
      data.itemID,
      data.itemId,
      data.id,
      data.noteID,
      data.noteId,
    ];
    for (const candidateId of candidateIds) {
      const parsed = Number(candidateId);
      if (!Number.isFinite(parsed) || parsed <= 0) continue;
      const item = Zotero.Items.get(Math.floor(parsed)) || null;
      if ((item as any)?.isNote?.()) {
        return item;
      }
    }
  } catch (_err) {
    void _err;
  }

  try {
    const pane = (win as unknown as {
      ZoteroPane?: { getSelectedItems?: () => Zotero.Item[] };
    }).ZoteroPane;
    const selectedItems = pane?.getSelectedItems?.() || [];
    const noteItem = selectedItems.find((item: Zotero.Item) =>
      (item as any)?.isNote?.(),
    );
    return noteItem || null;
  } catch (_err) {
    void _err;
  }

  return null;
}

function refreshPanelsForConversationKey(conversationKey: number): void {
  for (const [activeBody, syncPanelState] of activeContextPanelStateSync) {
    if (!(activeBody as Element).isConnected) {
      activeContextPanels.delete(activeBody);
      activeContextPanelStateSync.delete(activeBody);
      continue;
    }
    const activeRoot = activeBody.querySelector(
      "#llm-main",
    ) as HTMLDivElement | null;
    const activeConversationKey = activeRoot
      ? Number(activeRoot.dataset.itemId || 0)
      : 0;
    if (
      Number.isFinite(activeConversationKey) &&
      activeConversationKey === conversationKey
    ) {
      syncPanelState();
    }
  }
}

function refreshTrackedNoteEditingSelection(
  win: MainWindowWithNoteEditingTracker,
): void {
  const tracker = win.__llmNoteEditingSelectionTracking;
  if (!tracker) return;
  const noteItem = getActiveNoteItemFromWindow(win);
  const nextNoteId =
    noteItem && Number.isFinite(noteItem.id) && noteItem.id > 0
      ? Math.floor(noteItem.id)
      : 0;
  const nextSelectionText = noteItem
    ? collectAccessibleDocuments(win.document).reduce((found, doc) => {
        return found || getEditableSelectionFromDocument(doc);
      }, "")
    : "";

  if (
    tracker.lastNoteId === nextNoteId &&
    tracker.lastSelectionText === nextSelectionText
  ) {
    return;
  }

  if (
    tracker.lastNoteId > 0 &&
    (tracker.lastNoteId !== nextNoteId || !nextSelectionText)
  ) {
    if (
      syncSelectedTextContextForSource(
        tracker.lastNoteId,
        "",
        "note-edit",
      )
    ) {
      refreshPanelsForConversationKey(tracker.lastNoteId);
    }
  }

  if (nextNoteId > 0 && nextSelectionText) {
    if (
      syncSelectedTextContextForSource(
        nextNoteId,
        nextSelectionText,
        "note-edit",
      )
    ) {
      refreshPanelsForConversationKey(nextNoteId);
    }
  }

  tracker.lastNoteId = nextNoteId;
  tracker.lastSelectionText = nextSelectionText;
}

export function registerNoteEditingSelectionTracking(
  win: _ZoteroTypes.MainWindow,
) {
  const trackedWindow = win as MainWindowWithNoteEditingTracker;
  if (trackedWindow.__llmNoteEditingSelectionTracking) return;
  const refresh = () => {
    refreshTrackedNoteEditingSelection(trackedWindow);
  };
  const intervalId = win.setInterval(refresh, 250);
  trackedWindow.__llmNoteEditingSelectionTracking = {
    intervalId,
    refresh,
    lastNoteId: 0,
    lastSelectionText: "",
  };
  win.document.addEventListener("selectionchange", refresh, true);
  win.document.addEventListener("mouseup", refresh, true);
  win.document.addEventListener("keyup", refresh, true);
  win.addEventListener(
    "unload",
    () => {
      const tracker = trackedWindow.__llmNoteEditingSelectionTracking;
      if (!tracker) return;
      win.clearInterval(tracker.intervalId);
      win.document.removeEventListener("selectionchange", tracker.refresh, true);
      win.document.removeEventListener("mouseup", tracker.refresh, true);
      win.document.removeEventListener("keyup", tracker.refresh, true);
      delete trackedWindow.__llmNoteEditingSelectionTracking;
    },
    { once: true },
  );
  refresh();
}

export function clearConversation(itemId: number) {
  chatHistory.set(itemId, []);
  loadedConversationKeys.add(itemId);
  void clearStoredConversation(itemId).catch((err) => {
    ztoolkit.log("LLM: Failed to clear persisted chat history", err);
  });
  void clearOwnerAttachmentRefs("conversation", itemId).catch((err) => {
    ztoolkit.log(
      "LLM: Failed to clear persisted conversation attachment refs",
      err,
    );
  });
  void collectAndDeleteUnreferencedBlobs(ATTACHMENT_GC_MIN_AGE_MS).catch(
    (err) => {
      ztoolkit.log("LLM: Failed to collect unreferenced attachment blobs", err);
    },
  );
}

export function getConversationHistory(itemId: number): Message[] {
  return chatHistory.get(itemId) || [];
}
