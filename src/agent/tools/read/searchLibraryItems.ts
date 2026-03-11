import type { AgentToolDefinition } from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  fail,
  normalizePositiveInt,
  ok,
  validateObject,
} from "../shared";

type SearchLibraryItemsInput = {
  query?: string;
  filter?: "unfiled" | "untagged";
  limit?: number;
};

const VALID_FILTERS = ["unfiled", "untagged"] as const;

export function createSearchLibraryItemsTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<SearchLibraryItemsInput, unknown> {
  return {
    spec: {
      name: "search_library_items",
      description:
        "Search library papers by title, author, year, DOI, or use filter to list all unfiled or untagged papers. Results include full editable metadata.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description:
              "Search query. Required unless filter is set.",
          },
          filter: {
            type: "string",
            enum: ["unfiled", "untagged"],
            description:
              "Return only papers matching this condition instead of searching.",
          },
          limit: { type: "number" },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
    },
    presentation: {
      label: "Search Library",
      summaries: {
        onCall: ({ args }) => {
          const filter =
            args && typeof args === "object"
              ? (args as { filter?: string }).filter
              : undefined;
          if (filter === "unfiled") return "Listing unfiled papers in the active library";
          if (filter === "untagged") return "Listing papers without tags in the active library";
          return "Searching your library for matching papers";
        },
        onSuccess: ({ content }) => {
          const c = content as {
            filter?: string;
            results?: unknown[];
            totalCount?: number;
          } | null;
          const results = Array.isArray(c?.results) ? c!.results : [];
          const total = c?.totalCount ?? results.length;
          if (c?.filter === "unfiled") {
            return total > 0
              ? `Listed ${total} unfiled paper${total === 1 ? "" : "s"}`
              : "No unfiled papers found";
          }
          if (c?.filter === "untagged") {
            return total > 0
              ? `Listed ${total} untagged paper${total === 1 ? "" : "s"}`
              : "No untagged papers found";
          }
          return results.length > 0
            ? `Found ${results.length} matching paper${
                results.length === 1 ? "" : "s"
              } in your library`
            : "No matching papers found in the library";
        },
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail<SearchLibraryItemsInput>("Expected an object");
      }
      const filter =
        typeof args.filter === "string" &&
        (VALID_FILTERS as readonly string[]).includes(args.filter)
          ? (args.filter as "unfiled" | "untagged")
          : undefined;
      const query =
        typeof args.query === "string" ? args.query.trim() : "";
      if (!query && !filter) {
        return fail<SearchLibraryItemsInput>(
          "Either query or filter is required",
        );
      }
      return ok<SearchLibraryItemsInput>({
        query: query || undefined,
        filter,
        limit: normalizePositiveInt(args.limit),
      });
    },
    execute: async (input, context) => {
      const item =
        zoteroGateway.getItem(context.request.activeItemId) || context.item;
      const libraryID =
        item?.libraryID ||
        (Number.isFinite(context.request.libraryID)
          ? Math.floor(context.request.libraryID as number)
          : 0);
      if (!libraryID) {
        throw new Error("No active library available for search");
      }

      if (input.filter === "unfiled") {
        const result = await zoteroGateway.listUnfiledPaperTargets({
          libraryID,
          limit: input.limit,
        });
        return {
          results: result.papers,
          totalCount: result.totalCount,
          filter: "unfiled",
        };
      }
      if (input.filter === "untagged") {
        const result = await zoteroGateway.listUntaggedPaperTargets({
          libraryID,
          limit: input.limit,
        });
        return {
          results: result.papers,
          totalCount: result.totalCount,
          filter: "untagged",
        };
      }

      const results = await zoteroGateway.searchLibraryItems({
        libraryID,
        query: input.query!,
        excludeContextItemId:
          zoteroGateway.getActiveContextItem(item)?.id || null,
        limit: input.limit,
      });
      return {
        results: results.map((entry) => ({
          ...entry,
          metadata: zoteroGateway.getEditableArticleMetadata(
            zoteroGateway.getItem(entry.itemId),
          ),
        })),
      };
    },
  };
}
