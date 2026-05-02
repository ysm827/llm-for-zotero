import type {
  ChatAttachment,
  CollectionContextRef,
  PaperContextRef,
  SelectedTextSource,
} from "../shared/types";
import type { AgentRuntimeRequest } from "../agent/types";
import type { AgentSkill } from "../agent/skills";
import { getAllSkills, getMatchedSkillIds } from "../agent/skills";
import { detectSkillIntent } from "../agent/model/skillClassifier";

export type CodexNativeSkillScope = {
  profileSignature?: string;
  conversationKey: number;
  libraryID: number;
  kind: "global" | "paper";
  activeItemId?: number;
  paperItemID?: number;
  activeContextItemId?: number;
  paperTitle?: string;
  paperContext?: PaperContextRef;
  activeNoteId?: number;
  activeNoteTitle?: string;
  activeNoteKind?: "item" | "standalone";
  activeNoteParentItemId?: number;
};

export type CodexNativeSkillContext = {
  forcedSkillIds?: string[];
  selectedTexts?: string[];
  selectedTextSources?: SelectedTextSource[];
  selectedTextPaperContexts?: (PaperContextRef | undefined)[];
  selectedPaperContexts?: PaperContextRef[];
  fullTextPaperContexts?: PaperContextRef[];
  pinnedPaperContexts?: PaperContextRef[];
  selectedCollectionContexts?: CollectionContextRef[];
  screenshots?: string[];
  attachments?: ChatAttachment[];
};

export type CodexNativeResolvedSkills = {
  request: AgentRuntimeRequest;
  matchedSkillIds: string[];
  instructionBlock: string;
};

type ResolveNativeSkillsParams = {
  scope: CodexNativeSkillScope;
  userText: string;
  model: string;
  apiBase?: string;
  signal?: AbortSignal;
  skillContext?: CodexNativeSkillContext;
  detectSkillIntentImpl?: typeof detectSkillIntent;
};

function normalizeList<T>(value: T[] | undefined): T[] | undefined {
  return Array.isArray(value) && value.length ? value : undefined;
}

function buildScopePaperContexts(
  scope: CodexNativeSkillScope,
): PaperContextRef[] | undefined {
  if (scope.paperContext) return [scope.paperContext];
  if (
    scope.kind !== "paper" ||
    !scope.paperItemID ||
    !scope.activeContextItemId
  ) {
    return undefined;
  }
  return [
    {
      itemId: scope.paperItemID,
      contextItemId: scope.activeContextItemId,
      title: scope.paperTitle || `Paper ${scope.paperItemID}`,
    },
  ];
}

function buildScopeActiveNoteContext(
  scope: CodexNativeSkillScope,
): AgentRuntimeRequest["activeNoteContext"] {
  if (!scope.activeNoteId) return undefined;
  return {
    noteId: scope.activeNoteId,
    title: scope.activeNoteTitle || `Note ${scope.activeNoteId}`,
    noteKind: scope.activeNoteKind || "standalone",
    parentItemId: scope.activeNoteParentItemId,
    noteText: "",
  };
}

export function buildCodexNativeSkillRequest(
  params: Omit<ResolveNativeSkillsParams, "signal" | "detectSkillIntentImpl">,
): AgentRuntimeRequest {
  const { scope, skillContext } = params;
  const scopePapers = buildScopePaperContexts(scope);
  return {
    conversationKey: scope.conversationKey,
    mode: "agent",
    userText: params.userText,
    activeItemId: scope.activeItemId || scope.paperItemID,
    libraryID: scope.libraryID,
    selectedTexts: normalizeList(skillContext?.selectedTexts),
    selectedTextSources: normalizeList(skillContext?.selectedTextSources),
    selectedTextPaperContexts: normalizeList(
      skillContext?.selectedTextPaperContexts,
    ),
    selectedPaperContexts:
      normalizeList(skillContext?.selectedPaperContexts) || scopePapers,
    fullTextPaperContexts: normalizeList(skillContext?.fullTextPaperContexts),
    pinnedPaperContexts: normalizeList(skillContext?.pinnedPaperContexts),
    selectedCollectionContexts: normalizeList(
      skillContext?.selectedCollectionContexts,
    ),
    attachments: normalizeList(skillContext?.attachments),
    screenshots: normalizeList(skillContext?.screenshots),
    forcedSkillIds: normalizeList(skillContext?.forcedSkillIds),
    model: params.model,
    apiBase: params.apiBase,
    authMode: "codex_app_server",
    providerProtocol: "codex_responses",
    activeNoteContext: buildScopeActiveNoteContext(scope),
    modelProviderLabel: "Codex",
  };
}

export function buildCodexNativeSkillInstructionBlock(
  matchedSkillIds: ReadonlyArray<string>,
  allSkills: ReadonlyArray<AgentSkill> = getAllSkills(),
): string {
  if (!matchedSkillIds.length) return "";
  const activeIds = new Set(matchedSkillIds);
  const matchedSkills = allSkills.filter((skill) => activeIds.has(skill.id));
  if (!matchedSkills.length) return "";
  return [
    "LLM-for-Zotero skills active for this turn:",
    "The following skill instructions are provided because the user's message matches these workflows. Use them as workflow guidance for Zotero MCP tools; do not treat skills as additional MCP tools.",
    ...matchedSkills.map((skill) =>
      [`Skill: ${skill.id}`, skill.instruction.trim()]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n\n");
}

export async function resolveCodexNativeSkills(
  params: ResolveNativeSkillsParams,
): Promise<CodexNativeResolvedSkills> {
  const request = buildCodexNativeSkillRequest(params);
  const allSkills = getAllSkills();
  if (!allSkills.length) {
    return {
      request,
      matchedSkillIds: [],
      instructionBlock: "",
    };
  }
  const classify = params.detectSkillIntentImpl || detectSkillIntent;
  const classifiedSkillIds = await classify(request, allSkills, params.signal);
  const matchedSkillIds = getMatchedSkillIds(request, classifiedSkillIds);
  return {
    request,
    matchedSkillIds,
    instructionBlock: buildCodexNativeSkillInstructionBlock(
      matchedSkillIds,
      allSkills,
    ),
  };
}
