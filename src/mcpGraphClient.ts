import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type McpToolResult = {
  structuredContent?: unknown;
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};

export type ToolTrace = {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  duration_ms: number;
  error?: string;
};

export type OpenAIToolDef = {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
};

type McpNodeRow = {
  id: number;
  title: string;
  notes?: string | null;
  description?: string | null;
  link?: string | null;
  node_type?: string | null;
  event_date?: string | null;
  metadata?: unknown;
};

function getMcpServerScriptPath(): string {
  const explicit = process.env.LS_HUB_MCP_SERVER_PATH?.trim();
  if (explicit) return explicit;
  return require.resolve("latent-space-hub-mcp/index.js");
}

function summarizeToolResult(result: McpToolResult): unknown {
  if (result.structuredContent) {
    const json = JSON.stringify(result.structuredContent);
    if (json.length > 2000) {
      const sc = result.structuredContent as Record<string, unknown>;
      if (Array.isArray(sc.rows)) return { rows_count: sc.rows.length };
      if (Array.isArray(sc.results)) return { results_count: sc.results.length };
      if (Array.isArray(sc.nodes)) return { nodes_count: sc.nodes.length };
      return { truncated: true, length: json.length };
    }
    return result.structuredContent;
  }
  const text = normalizeTextContent(result.content);
  return text.length > 500 ? { text_preview: text.slice(0, 500), full_length: text.length } : { text };
}

export function normalizeTextContent(content: McpToolResult["content"]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text?.trim() || "")
    .filter(Boolean)
    .join("\n\n");
}

const READ_ONLY_TOOLS = new Set([
  "ls_get_context",
  "ls_search_nodes",
  "ls_get_nodes",
  "ls_query_edges",
  "ls_list_dimensions",
  "ls_search_content",
  "ls_sqlite_query",
  "ls_list_guides",
  "ls_read_guide"
]);

export class McpGraphClient {
  private client: McpClient | null = null;
  private connected = false;
  private cachedToolDefs: OpenAIToolDef[] | null = null;
  public callTraces: ToolTrace[] = [];

  clearTraces(): ToolTrace[] {
    const traces = [...this.callTraces];
    this.callTraces = [];
    return traces;
  }

  async getToolDefinitions(): Promise<OpenAIToolDef[]> {
    if (this.cachedToolDefs) return this.cachedToolDefs;
    const client = this.ensureClient();
    const { tools } = await client.listTools();
    this.cachedToolDefs = tools
      .filter((t) => READ_ONLY_TOOLS.has(t.name))
      .map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema
        }
      }));
    return this.cachedToolDefs;
  }

  async connect(): Promise<void> {
    if (this.connected && this.client) return;
    const scriptPath = getMcpServerScriptPath();

    const client = new McpClient(
      { name: "latent-space-bots", version: "0.1.0" },
      { capabilities: {} }
    );

    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === "string")
      ),
      TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL || "",
      TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN || ""
    };

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [scriptPath],
      env,
      stderr: "pipe"
    });

    if (transport.stderr) {
      transport.stderr.on("data", (chunk) => {
        const text = String(chunk || "").trim();
        if (text) {
          console.warn(`[mcp] ${text}`);
        }
      });
    }

    await client.connect(transport);
    this.client = client;
    this.connected = true;
  }

  private ensureClient(): McpClient {
    if (!this.client || !this.connected) {
      throw new Error("MCP client is not connected.");
    }
    return this.client;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    const start = Date.now();
    const client = this.ensureClient();
    let result: McpToolResult;
    try {
      result = (await client.callTool({ name, arguments: args })) as McpToolResult;
    } catch (error) {
      this.callTraces.push({ tool: name, args, result: null, duration_ms: Date.now() - start, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }

    const elapsed = Date.now() - start;
    if (result?.isError) {
      const msg = normalizeTextContent(result.content) || `${name} returned an MCP error`;
      this.callTraces.push({ tool: name, args, result: null, duration_ms: elapsed, error: msg });
      throw new Error(msg);
    }

    this.callTraces.push({ tool: name, args, result: summarizeToolResult(result), duration_ms: elapsed });
    return result;
  }

  async readGuide(name: string): Promise<string> {
    const result = await this.callTool("ls_read_guide", { name });
    const structured = result.structuredContent as { content?: unknown } | undefined;
    if (structured && typeof structured.content === "string") {
      return structured.content;
    }
    return normalizeTextContent(result.content);
  }

  async lookupMemberByDiscordId(discordId: string): Promise<McpNodeRow | null> {
    const escaped = discordId.replace(/'/g, "''");
    const sql =
      "SELECT id, title, notes, metadata, node_type, event_date, updated_at " +
      "FROM nodes " +
      "WHERE node_type = 'member' AND json_extract(metadata, '$.discord_id') = '" +
      escaped +
      "' " +
      "ORDER BY updated_at DESC " +
      "LIMIT 1";

    const result = await this.callTool("ls_sqlite_query", { sql });
    const rows = ((result.structuredContent as { rows?: unknown[] } | undefined)?.rows || []) as Array<
      Record<string, unknown>
    >;
    if (!rows.length) return null;
    const row = rows[0];
    const metadata = (() => {
      const raw = row.metadata;
      if (raw && typeof raw === "object") return raw;
      if (typeof raw === "string") {
        try {
          return JSON.parse(raw);
        } catch {
          return {};
        }
      }
      return {};
    })();

    return {
      id: Number(row.id),
      title: String(row.title || ""),
      notes: row.notes == null ? null : String(row.notes),
      node_type: row.node_type == null ? null : String(row.node_type),
      event_date: row.event_date == null ? null : String(row.event_date),
      metadata
    };
  }

  async createMemberNode(payload: {
    title: string;
    description?: string;
    metadata: Record<string, unknown>;
  }): Promise<{ id: number }> {
    const result = await this.callTool("ls_add_node", {
      title: payload.title,
      description: payload.description,
      dimensions: ["member"],
      node_type: "member",
      metadata: payload.metadata
    });
    const structured = result.structuredContent as { nodeId?: unknown } | undefined;
    const id = Number(structured?.nodeId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error("MCP ls_add_node did not return a valid nodeId.");
    }
    return { id };
  }

  async updateMemberNode(
    nodeId: number,
    updates: { content?: string; metadata: Record<string, unknown> }
  ): Promise<void> {
    await this.callTool("ls_update_node", {
      id: nodeId,
      updates: {
        ...(updates.content ? { content: updates.content } : {}),
        metadata: updates.metadata
      }
    });
  }

  async createMemberEdge(sourceId: number, targetId: number, explanation: string): Promise<void> {
    await this.callTool("ls_create_edge", {
      sourceId,
      targetId,
      explanation
    });
  }

  async searchNodes(query: string, limit: number): Promise<McpNodeRow[]> {
    const result = await this.callTool("ls_search_nodes", {
      query,
      limit
    });
    const nodes = ((result.structuredContent as { nodes?: unknown[] } | undefined)?.nodes || []) as Array<
      Record<string, unknown>
    >;

    return nodes.map((row) => ({
      id: Number(row.id),
      title: String(row.title || ""),
      notes: row.notes == null ? null : String(row.notes),
      description: row.description == null ? null : String(row.description),
      link: row.link == null ? null : String(row.link),
      node_type: row.node_type == null ? null : String(row.node_type),
      event_date: row.event_date == null ? null : String(row.event_date),
      metadata: row.metadata
    }));
  }

  async searchContent(query: string, limit: number): Promise<Array<{ node_id: number; title: string; text: string }>> {
    const result = await this.callTool("ls_search_content", {
      query,
      limit
    });
    const rows = ((result.structuredContent as { results?: unknown[] } | undefined)?.results || []) as Array<
      Record<string, unknown>
    >;

    return rows.map((row) => ({
      node_id: Number(row.node_id),
      title: String(row.title || ""),
      text: String(row.text || "")
    }));
  }

  async getNodes(nodeIds: number[]): Promise<McpNodeRow[]> {
    const unique = Array.from(new Set(nodeIds.filter((id) => Number.isFinite(id) && id > 0))).slice(0, 10);
    if (!unique.length) return [];
    const result = await this.callTool("ls_get_nodes", {
      nodeIds: unique
    });
    const nodes = ((result.structuredContent as { nodes?: unknown[] } | undefined)?.nodes || []) as Array<
      Record<string, unknown>
    >;

    return nodes.map((row) => ({
      id: Number(row.id),
      title: String(row.title || ""),
      notes: row.notes == null ? null : String(row.notes),
      description: row.description == null ? null : String(row.description),
      link: row.link == null ? null : String(row.link),
      node_type: row.node_type == null ? null : String(row.node_type),
      event_date: row.event_date == null ? null : String(row.event_date),
      metadata: row.metadata
    }));
  }

  async queryLatestContent(nodeType: string | undefined, limit: number): Promise<Array<Record<string, unknown>>> {
    const safeLimit = Math.max(1, Math.floor(limit));
    const base =
      "SELECT id, title, node_type, event_date, coalesce(description, '') AS description, " +
      "substr(coalesce(notes, ''), 1, 700) AS excerpt, coalesce(link, '') AS link " +
      "FROM nodes WHERE event_date IS NOT NULL ";

    const contentTypes = ["podcast", "article", "ainews", "builders-club", "paper-club", "workshop"];
    const sql = nodeType
      ? `${base}AND node_type = '${nodeType.replace(/'/g, "''")}' ORDER BY event_date DESC, updated_at DESC LIMIT ${safeLimit}`
      : `${base}AND node_type IN (${contentTypes.map((t) => `'${t}'`).join(", ")}) ORDER BY event_date DESC, updated_at DESC LIMIT ${safeLimit}`;

    const result = await this.callTool("ls_sqlite_query", { sql });
    const rows = ((result.structuredContent as { rows?: unknown[] } | undefined)?.rows || []) as Array<
      Record<string, unknown>
    >;
    return rows;
  }
}
