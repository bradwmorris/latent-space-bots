/**
 * Slop's local tool definitions and handlers.
 *
 * These replace the MCP tool definitions. The LLM sees these as available
 * functions and the tool loop executes them via direct Turso queries.
 */
import type { Client as LibsqlClient } from "@libsql/client";
import * as dbOps from "./db";

// ── OpenAI function calling types ──────────────────────────────

export type OpenAIToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ToolHandler = {
  execute: (args: Record<string, unknown>, db: LibsqlClient) => Promise<string>;
};

// ── Tool definitions (what the LLM sees) ───────────────────────

export const TOOL_DEFINITIONS: OpenAIToolDef[] = [
  {
    type: "function",
    function: {
      name: "slop_search_nodes",
      description:
        "Search nodes in the knowledge graph by title, description, or notes. Supports optional node_type filter. Returns matching nodes sorted by relevance.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query text" },
          limit: { type: "number", description: "Max results (default 10, max 25)" },
          node_type: { type: "string", description: "Optional: filter by node type (podcast, article, ainews, guest, entity, member, event, workshop, paper-club, builders-club)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "slop_search_content",
      description:
        "Search through transcript/article text chunks using FTS5 full-text search. Use this for specific quotes, passages, or deep content searches.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query text" },
          limit: { type: "number", description: "Max results (default 10, max 25)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "slop_get_nodes",
      description: "Get full node records by their IDs. Use after search to load complete details.",
      parameters: {
        type: "object",
        properties: {
          nodeIds: {
            type: "array",
            items: { type: "number" },
            description: "Array of node IDs to retrieve (max 10)",
          },
        },
        required: ["nodeIds"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "slop_query_edges",
      description: "Get edges (connections) for a node. Returns connected nodes with relationship context.",
      parameters: {
        type: "object",
        properties: {
          nodeId: { type: "number", description: "The node ID to query edges for" },
          limit: { type: "number", description: "Max edges to return (default 25)" },
        },
        required: ["nodeId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "slop_list_dimensions",
      description: "List all priority dimensions (categories) in the knowledge graph with their node counts.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "slop_get_context",
      description: "Get knowledge graph stats: total nodes, edges, and chunks counts.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "slop_sqlite_query",
      description:
        "Run a read-only SQL query against the knowledge graph database. Only SELECT, WITH, and PRAGMA statements allowed. Use for complex queries, aggregations, date-range filters, etc.",
      parameters: {
        type: "object",
        properties: {
          sql: { type: "string", description: "SQL query (SELECT/WITH/PRAGMA only)" },
        },
        required: ["sql"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "slop_read_skill",
      description: "Read a skill by name. Returns the full markdown content with instructions.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name to read" },
        },
        required: ["name"],
      },
    },
  },
];

// ── Tool handlers (what executes when the LLM calls a tool) ────

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  slop_search_nodes: {
    execute: async (args, db) => {
      const query = String(args.query || "");
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
      const nodeType = typeof args.node_type === "string" ? args.node_type : undefined;
      const nodes = await dbOps.searchNodes(db, query, limit, nodeType);
      return JSON.stringify({ nodes, count: nodes.length });
    },
  },

  slop_search_content: {
    execute: async (args, db) => {
      const query = String(args.query || "");
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
      const results = await dbOps.searchContent(db, query, limit);
      return JSON.stringify({ results, count: results.length });
    },
  },

  slop_get_nodes: {
    execute: async (args, db) => {
      const nodeIds = Array.isArray(args.nodeIds) ? args.nodeIds.map(Number) : [];
      const nodes = await dbOps.getNodesById(db, nodeIds);
      return JSON.stringify({ nodes, count: nodes.length });
    },
  },

  slop_query_edges: {
    execute: async (args, db) => {
      const nodeId = Number(args.nodeId);
      const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 50);
      const edges = await dbOps.queryEdges(db, nodeId, limit);
      return JSON.stringify({ edges, count: edges.length });
    },
  },

  slop_list_dimensions: {
    execute: async (_args, db) => {
      const dimensions = await dbOps.listDimensions(db);
      return JSON.stringify({ dimensions, count: dimensions.length });
    },
  },

  slop_get_context: {
    execute: async (_args, db) => {
      const context = await dbOps.getContext(db);
      return JSON.stringify(context);
    },
  },

  slop_sqlite_query: {
    execute: async (args, db) => {
      const sql = String(args.sql || "");
      const rows = await dbOps.sqliteQuery(db, sql);
      return JSON.stringify({ rows, count: rows.length });
    },
  },

  // slop_read_skill is handled separately in index.ts (reads from local skills/ dir)
};
