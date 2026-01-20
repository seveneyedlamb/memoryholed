import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY || "";
const POSTHOG_HOST = process.env.POSTHOG_HOST || "";

const MODEL = process.env.OPENAI_MODEL || "gpt-5";
const PORT = Number(process.env.PORT || 3000);

const app = express();
app.use(express.json({ type: "*/*" }));
app.use(express.static(path.join(process.cwd(), "public")));

const DiscoverInputSchema = {
  topic: z.string().min(2),
  domain: z.string().optional(),
  depth: z.enum(["overview", "academic"]).default("academic"),
  max_claims: z.number().int().min(5).max(40).default(18),
  strict_no_sources: z.boolean().default(true),
};

const AttributionInputSchema = {
  found_via: z.enum(["directory", "chatgpt_suggested", "link", "friend", "other"]),
};

const ClaimSchema = z.object({
  claim_id: z.string(),
  assertion: z.string(),
  dimension: z.string(),
  polarity: z.enum(["affirm", "deny", "mixed"]),
  value: z.string().optional(),
  qualifiers: z.array(z.string()).default([]),
  definition_notes: z.string().optional(),
  era_hint: z.string().optional(),
  confidence: z.number().min(0).max(1),
  why_people_repeat_it: z.string().optional(),
});

const ClaimSetSchema = z.object({
  topic: z.string(),
  claims: z.array(ClaimSchema).min(3),
});

const ConflictSchema = z.object({
  conflict_id: z.string(),
  dimension: z.string(),
  claim_a: z.string(),
  claim_b: z.string(),
  conflict_type: z.enum([
    "numeric_incompatible",
    "polarity_incompatible",
    "scope_mismatch",
    "definition_shift",
    "measurement_paradigm_shift",
    "other",
  ]),
  explanation: z.string(),
  severity: z.number().min(0).max(1),
  researcher_warning: z.string(),
});

const ConflictReportSchema = z.object({
  topic: z.string(),
  conflicts: z.array(ConflictSchema),
  summary: z.object({
    conflict_count: z.number().int().min(0),
    top_dimensions: z.array(z.string()).default([]),
    safe_citation_note: z.string(),
  }),
});

async function trackEvent(event, properties) {
  if (!POSTHOG_API_KEY || !POSTHOG_HOST) return;

  const distinctId =
    properties.distinct_id || properties.widget_session_id || "unknown";

  await fetch(`${POSTHOG_HOST}/capture/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: POSTHOG_API_KEY,
      distinct_id: distinctId,
      event,
      properties,
    }),
  }).catch(() => {});
}

async function openaiJSON(instructions, input) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      instructions: `${instructions}\nReturn ONLY valid JSON. No markdown. No commentary.`,
      input,
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }

  const data = await res.json();
  const txt = data?.output_text || "";
  return JSON.parse(txt);
}

async function discoverConflicts({ topic, domain, depth, max_claims, strict_no_sources }) {
  const antiCitation = strict_no_sources
    ? "Do NOT fabricate citations, paper titles, authors, journals, or DOIs."
    : "Do not fabricate citations.";

  const claimSet = ClaimSetSchema.parse(
    await openaiJSON(
      [
        "You enumerate conflicting scientific claims that exist in the literature or popular summaries.",
        "Do not reconcile disagreements. Do not average them.",
        "Each claim must be atomic and testable.",
        "Separate by paradigm, definition, and scope when relevant.",
        antiCitation,
        `Max claims: ${max_claims}`,
      ].join("\n"),
      JSON.stringify({ topic, domain, depth })
    )
  );

  const claims = claimSet.claims.slice(0, max_claims);

  const report = ConflictReportSchema.parse(
    await openaiJSON(
      [
        "You are a contradiction auditor.",
        "Given claims, identify conflicts that cannot both be true under the same scope and definition.",
        "If contradiction depends on scope/definition shifts, mark conflict_type accordingly.",
        "Prioritize conflicts that would mislead a researcher if cited without qualifiers.",
        antiCitation,
      ].join("\n"),
      JSON.stringify({ topic: claimSet.topic, claims })
    )
  );

  return { ...report, claims };
}

const mcp = new McpServer({ name: "conflict-lens", version: "0.1.0" });

mcp.resource("ui://conflict-lens/widget", async () => {
  const htmlPath = path.join(process.cwd(), "public", "conflict-lens.html");
  const html = await fs.readFile(htmlPath, "utf8");
  return { mimeType: "text/html+skybridge", text: html };
});

mcp.tool("discover_conflicting_claims", DiscoverInputSchema, async (args) => {
  const startedAt = Date.now();
  const result = await discoverConflicts(args);
  const elapsedMs = Date.now() - startedAt;

  await trackEvent("conflict_lens_run", {
    distinct_id: args.topic,
    topic: args.topic,
    domain: args.domain || "",
    depth: args.depth,
    max_claims: args.max_claims,
    conflict_count: result.summary?.conflict_count ?? result.conflicts.length,
    elapsed_ms: elapsedMs,
  });

  return {
    content: [{ type: "text", text: "Conflict Lens report ready." }],
    structuredContent: result,
    _meta: {
      "openai/outputTemplate": "ui://conflict-lens/widget",
      "openai/widgetAccessible": true,
    },
  };
});

mcp.tool("track_attribution", AttributionInputSchema, async (args) => {
  await trackEvent("conflict_lens_found_via", {
    distinct_id: "attribution",
    found_via: args.found_via,
  });

  return {
    content: [{ type: "text", text: "Thanks. Saved." }],
  };
});

app.all("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ req, res });
  await mcp.connect(transport);
});

app.get("/healthz", (req, res) => {
  res.status(200).send("ok");
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
