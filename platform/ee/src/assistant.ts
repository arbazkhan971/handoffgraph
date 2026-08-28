// HandoffGraph in-product assistant (parity row 51).
//
// PROPRIETARY. See platform/ee/LICENSE.
//
// An assistant over the user's OWN telemetry, with a bring-your-own model, and
// answers that are always labelled INFERRED. Four design commitments make that
// sentence true rather than aspirational:
//
// 1. IT CANNOT SEE MORE THAN THE CALLER.
//    The assistant never gets its own credential or its own workspace scope.
//    It authenticates the caller with the same authenticateReadPrincipal used
//    by the public REST API and POST /v1/mcp, then forwards the caller's exact
//    Authorization header into every tool call. Whatever the caller could not
//    read through MCP, the assistant cannot read either — not by policy, but
//    because there is no code path that could.
//
// 2. IT USES OUR OWN MCP TOOLS, IN-PROCESS.
//    The tool catalogue is not a copy of src/mcp.ts's TOOL_DEFS maintained in
//    parallel here; it is fetched at request time by issuing a `tools/list`
//    JSON-RPC message to handleMcpRoute through a synthetic Request. Same for
//    execution: `tools/call` runs the real tool implementation. No HTTP hop, no
//    duplicated tool logic, and a READ-ONLY tool added to mcp.ts appears here
//    with no change to this file. (The synthetic-Request idiom is the
//    platform's: index.ts's OTLP handler replays the event-batch pipeline the
//    same way.)
//
// 2a. IT IS READ-ONLY, BY CONSTRUCTION.
//    tools/list is principal-independent: it returns the whole catalogue,
//    including record_score and accept_handoff, which APPEND OBSERVED
//    score.recorded / handoff.accepted events to the spine. Handing those to a
//    model would mean model output — steerable by prompt injection sitting in
//    the very telemetry the assistant was asked to summarize — could mint
//    OBSERVED evidence. That is exactly the INFERRED→OBSERVED laundering this
//    product exists to make impossible, so the assistant keeps only tools
//    flagged `write: false` (mcp.ts's ToolDef), and it does so twice over:
//
//      - the system prompt advertises the READ-ONLY catalogue, so a write tool
//        is never even named to the model; and
//      - a tool_call naming a write tool is REFUSED with
//        `assistant_write_tool_refused` and ends the request. Not skipped, not
//        answered around — a refusal the caller can see.
//
//    The filter is fail-closed on the flag itself: a tool is admitted only when
//    tools/list said `write: false`. A future tool that forgets the flag is
//    treated as write-capable and never offered, which is the safe direction to
//    be wrong in.
//
// 3. BRING YOUR OWN MODEL.
//    The caller supplies `gateway_key` and `model`. The model call goes through
//    this platform's own gateway (src/gateway.ts), which resolves the vk_ key,
//    unseals the customer's upstream credential, applies their rate limit, and
//    captures the request. HandoffGraph never holds a model credential for the
//    assistant, and the customer sees assistant spend in the same place as
//    every other gateway request.
//
// 4. INFERRED, ALWAYS, AND NEVER FABRICATED.
//    Every successful answer carries provenance "INFERRED" — non-negotiable,
//    and asserted in test/ee.test.ts. A model's prose about telemetry is a
//    model's prose; it is not observed evidence and this platform never labels
//    it as such. `evidence_refs` carries the platform ids the TOOLS returned
//    (not ids the model wrote), so a UI can link a claim back to observed data.
//    And every failure — model unavailable, unparseable model output, a tool
//    error, an exhausted tool budget — returns an error WITHOUT an `answer`
//    field. The assistant fails closed; it never narrates around a tool that
//    did not work.

import { authenticateReadPrincipal } from "../../src/apikeys";
import type { ApiKeysEnv } from "../../src/apikeys";
import { handleGatewayRoute, type FetchLike, type GatewayEnv } from "../../src/gateway";
import { canonicalJsonStringify, readRequestBody } from "../../src/ingest";
import { handleMcpRoute } from "../../src/mcp";

export const ASSISTANT_PATH = "/v1/assistant";

export type AssistantEnv = ApiKeysEnv & GatewayEnv;

const MAX_ASSISTANT_BODY_BYTES = 16_384;
const MAX_QUESTION_BYTES = 4_000;
const MAX_MODEL_BYTES = 200;
const MAX_GATEWAY_KEY_BYTES = 200;

/** Hard ceiling on tool executions per request; a 6th request fails closed. */
export const MAX_TOOL_CALLS = 5;

/** Bound on a single tool result fed back to the model, in characters. */
const MAX_TOOL_RESULT_CHARS = 24_000;

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// -- the model boundary ----------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type AssistantModelResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * The one seam between the loop and any model. Production builds this from the
 * gateway (gatewayModelCall below); tests pass a scripted implementation, so
 * the loop is exercised without a network, a sealing key, or a real vk_ key.
 */
export type AssistantModelCall = (messages: ChatMessage[]) => Promise<AssistantModelResult>;

/**
 * Call the caller's own model through this platform's gateway, in-process.
 *
 * The synthetic Request carries the caller's vk_ gateway key, so the gateway
 * performs its normal work: key resolution, rate limiting, unsealing the
 * customer's upstream credential, capture. Nothing about the assistant bypasses
 * it. Every non-2xx is collapsed into a fail-closed error rather than being
 * reflected back — the model's absence must never look like a model's answer.
 */
export function gatewayModelCall(
  env: GatewayEnv,
  gatewayKey: string,
  model: string,
  fetcher: FetchLike = fetch,
): AssistantModelCall {
  return async (messages) => {
    const request = new Request("https://assistant.internal.invalid/gateway/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${gatewayKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        // An assistant over telemetry should be reproducible; the protocol
        // below also wants strict JSON, which sampling makes less reliable.
        temperature: 0,
        stream: false,
      }),
    });
    let response: Response | null;
    try {
      response = await handleGatewayRoute(request, env, fetcher);
    } catch {
      return { ok: false, error: "the model gateway failed" };
    }
    if (response === null) return { ok: false, error: "the model gateway is unavailable" };
    if (response.status < 200 || response.status >= 300) {
      // Content-free: the upstream body may contain the customer's prompt.
      return { ok: false, error: `the model gateway responded ${response.status}` };
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, error: "the model response was not JSON" };
    }
    const text = firstChoiceText(payload);
    if (text === null) return { ok: false, error: "the model response had no message content" };
    return { ok: true, text };
  };
}

/** OpenAI chat-completions shape: choices[0].message.content. */
function firstChoiceText(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first: unknown = choices[0];
  if (first === null || typeof first !== "object" || Array.isArray(first)) return null;
  const message = (first as Record<string, unknown>).message;
  if (message === null || typeof message !== "object" || Array.isArray(message)) return null;
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" && content.length > 0 ? content : null;
}

// -- in-process MCP ---------------------------------------------------------------

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
  /** true when the tool appends to the spine (mcp.ts's ToolDef.write). */
  write: boolean;
}

type McpOutcome = { ok: true; result: Record<string, unknown> } | { ok: false; message: string };

/**
 * Issue one JSON-RPC message to the hosted MCP endpoint without leaving the
 * isolate. `authorization` is the caller's own header, verbatim.
 */
async function mcpCall(
  env: AssistantEnv,
  authorization: string,
  method: string,
  params: Record<string, unknown> | undefined,
  id: number,
): Promise<McpOutcome> {
  const request = new Request("https://assistant.internal.invalid/v1/mcp", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
  });
  const response = await handleMcpRoute(request, env);
  if (response === null) return { ok: false, message: "the hosted MCP endpoint is unavailable" };
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, message: "the hosted MCP endpoint returned a malformed response" };
  }
  if (response.status !== 200) {
    const error = readErrorMessage(payload);
    return { ok: false, message: error ?? `the hosted MCP endpoint responded ${response.status}` };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, message: "the hosted MCP endpoint returned a malformed response" };
  }
  const envelope = payload as Record<string, unknown>;
  const rpcError = envelope.error;
  if (rpcError !== undefined && rpcError !== null) {
    const message =
      typeof rpcError === "object" && !Array.isArray(rpcError) &&
      typeof (rpcError as Record<string, unknown>).message === "string"
        ? ((rpcError as Record<string, unknown>).message as string)
        : "tool call failed";
    return { ok: false, message };
  }
  const result = envelope.result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return { ok: false, message: "the hosted MCP endpoint returned no result" };
  }
  return { ok: true, result: result as Record<string, unknown> };
}

function readErrorMessage(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const error = (payload as Record<string, unknown>).error;
  if (typeof error === "string") return error;
  if (error !== null && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return null;
}

function toolDefsFrom(result: Record<string, unknown>): McpToolDef[] {
  const tools = result.tools;
  if (!Array.isArray(tools)) return [];
  const defs: McpToolDef[] = [];
  for (const entry of tools) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.length === 0) continue;
    defs.push({
      name: record.name,
      description: typeof record.description === "string" ? record.description : "",
      inputSchema: record.inputSchema ?? { type: "object" },
      // FAIL CLOSED. Only an explicit `write: false` makes a tool read-only
      // here; a missing, malformed, or true flag means "assume it writes". A
      // tool that lands in mcp.ts without the flag therefore disappears from
      // the assistant rather than quietly becoming reachable by model output.
      write: record.write !== false,
    });
  }
  // Deterministic prompt bytes: the same workspace state always produces the
  // same system prompt, so a model's behavior is reproducible.
  return defs.sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1));
}

// -- evidence harvesting -------------------------------------------------------------

/**
 * Every id this platform mints is a short lowercase prefix plus a 26-character
 * Crockford ULID (evt_, ws_, ses_, trc_, spn_, ...). Harvesting by shape rather
 * than by an enumerated prefix list means a new id kind is linkable the day it
 * exists, and — critically — these come from TOOL RESULTS, never from model
 * output, so a hallucinated id can never reach evidence_refs.
 */
const PLATFORM_ID_PATTERN = /^[a-z]{2,6}_[0-9A-HJKMNP-TV-Z]{26}$/;

function harvestEvidence(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 12) return;
  if (typeof value === "string") {
    if (PLATFORM_ID_PATTERN.test(value)) into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) harvestEvidence(item, into, depth + 1);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      harvestEvidence(item, into, depth + 1);
    }
  }
}

/** The tool's structured payload, preferring structuredContent over text. */
function structuredResult(result: Record<string, unknown>): unknown {
  const structured = result.structuredContent;
  if (structured !== undefined && structured !== null) return structured;
  const content = result.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block === null || typeof block !== "object" || Array.isArray(block)) continue;
      const text = (block as Record<string, unknown>).text;
      if (typeof text !== "string") continue;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
  return result;
}

// -- the protocol ---------------------------------------------------------------------

/**
 * The model speaks exactly one JSON object per turn. This is deliberately not
 * OpenAI-native tool calling: `gateway_key` may point at any upstream (OpenAI,
 * Anthropic, or a custom endpoint — see UPSTREAM_PROVIDERS in src/gateway.ts),
 * and a plain-JSON convention in the system prompt is the one calling
 * convention every one of them can honor. The cost is that parsing must be
 * strict, which it is: anything that is not one of these two shapes ends the
 * request with an error rather than being coerced into an answer.
 */
function systemPrompt(tools: McpToolDef[]): string {
  const catalogue = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
  return [
    "You are the HandoffGraph assistant. You answer questions about ONE workspace's own",
    "agent telemetry — workstreams, traces, spans, sessions, and quality scores — by",
    "calling the tools below. You have no knowledge of this workspace beyond what the",
    "tools return.",
    "",
    "TOOLS (JSON) — this list is COMPLETE, and every tool on it is READ-ONLY. You cannot",
    "record scores, accept handoffs, or write anything; a tool_call naming any tool that",
    "is not listed below is refused and ends the request.",
    canonicalJsonStringify(catalogue),
    "",
    "PROTOCOL — every reply you send must be EXACTLY ONE JSON object and nothing else.",
    "No prose outside it. No markdown fences. No explanation before or after.",
    "",
    "  To call a tool:",
    '    {"tool_call": {"name": "<tool name>", "arguments": {<arguments>}}}',
    "",
    "  To answer the question:",
    '    {"answer": "<your answer, in plain prose>"}',
    "",
    "After each tool call you will receive one message containing:",
    '    {"tool_result": {"name": "<tool name>", "result": <the tool output>}}',
    "",
    "RULES",
    `  - You may make at most ${MAX_TOOL_CALLS} tool calls in total. Plan accordingly.`,
    "  - Every factual claim in your answer must be supported by a tool result.",
    "    If the tools do not support a claim, say what you could not determine",
    "    instead of guessing. A partial answer is correct; an invented one is not.",
    "  - Never invent ids, counts, timestamps, or costs. Quote only what a tool returned.",
    "  - Your answer will be shown to the user labelled INFERRED, because it is your",
    "    interpretation and not observed evidence. Write it accordingly.",
  ].join("\n");
}

type ModelTurn =
  | { kind: "tool_call"; name: string; args: Record<string, unknown> }
  | { kind: "answer"; answer: string };

/**
 * Strict, fail-closed parse of one model turn.
 *
 * The single tolerated deviation is a wrapping markdown code fence, because
 * emitting one is near-universal model behavior and stripping it is
 * unambiguous. Everything else — prose around the object, both keys present,
 * neither key present, a non-object — is a protocol violation, and a protocol
 * violation ends the request. It is never treated as an answer.
 */
export function parseModelTurn(raw: string): { ok: true; turn: ModelTurn } | { ok: false; error: string } {
  let text = raw.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(text);
  if (fence !== null) text = fence[1].trim();
  if (text.length === 0) return { ok: false, error: "the model returned an empty reply" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "the model reply was not a single JSON object" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "the model reply was not a single JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  const hasToolCall = record.tool_call !== undefined && record.tool_call !== null;
  const hasAnswer = record.answer !== undefined && record.answer !== null;
  if (hasToolCall === hasAnswer) {
    return { ok: false, error: 'the model reply must contain exactly one of "tool_call" or "answer"' };
  }

  if (hasAnswer) {
    const answer = record.answer;
    if (typeof answer !== "string" || answer.trim().length === 0) {
      return { ok: false, error: '"answer" must be a non-empty string' };
    }
    return { ok: true, turn: { kind: "answer", answer: answer.trim() } };
  }

  const call = record.tool_call;
  if (call === null || typeof call !== "object" || Array.isArray(call)) {
    return { ok: false, error: '"tool_call" must be an object' };
  }
  const callRecord = call as Record<string, unknown>;
  const name = callRecord.name;
  if (typeof name !== "string" || name.length === 0) {
    return { ok: false, error: '"tool_call.name" must be a non-empty string' };
  }
  const rawArgs = callRecord.arguments;
  let args: Record<string, unknown> = {};
  if (rawArgs !== undefined && rawArgs !== null) {
    if (typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
      return { ok: false, error: '"tool_call.arguments" must be an object' };
    }
    args = rawArgs as Record<string, unknown>;
  }
  return { ok: true, turn: { kind: "tool_call", name, args } };
}

// -- the route ---------------------------------------------------------------------------

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

interface AssistantRequestBody {
  question: string;
  gatewayKey: string;
  model: string;
}

function validateBody(parsed: unknown): { ok: true; value: AssistantRequestBody } | { ok: false; error: string } {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "request body must be a JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  const question = record.question;
  if (typeof question !== "string" || question.trim().length === 0 || utf8Bytes(question) > MAX_QUESTION_BYTES) {
    return { ok: false, error: `question must be a non-empty string of at most ${MAX_QUESTION_BYTES} bytes` };
  }
  const gatewayKey = record.gateway_key;
  if (typeof gatewayKey !== "string" || gatewayKey.length === 0 || utf8Bytes(gatewayKey) > MAX_GATEWAY_KEY_BYTES) {
    return { ok: false, error: "gateway_key must be a non-empty string" };
  }
  const model = record.model;
  if (typeof model !== "string" || model.trim().length === 0 || utf8Bytes(model) > MAX_MODEL_BYTES) {
    return { ok: false, error: "model must be a non-empty string" };
  }
  return { ok: true, value: { question: question.trim(), gatewayKey, model: model.trim() } };
}

/**
 * POST /v1/assistant. Flag-gated under EE for now (handleEERoute checks
 * EE_ENABLED before reaching here).
 *
 * NOTE FOR THE ORCHESTRATOR — this gate is a product decision, not a technical
 * one. The plan positions the assistant as BYO-model with INFERRED answers,
 * which is equally coherent as an OSS feature: it holds no proprietary model,
 * bills through the customer's own gateway key, and reads only what the caller
 * could already read. Moving it out of the fence is a file move plus a
 * delegation-pair move in index.ts; nothing in this module depends on being
 * Enterprise. It is fenced here only because row 48 and row 51 landed in one
 * slice and the narrower default was the safer one to ship.
 */
export async function handleAssistantRoute(
  request: Request,
  env: AssistantEnv,
  modelCall?: AssistantModelCall,
  fetcher: FetchLike = fetch,
): Promise<Response> {
  // Authenticate FIRST, with the same resolver the public API and MCP use, so
  // the assistant's reach is exactly the caller's reach.
  const auth = await authenticateReadPrincipal(request, env);
  if ("response" in auth) return auth.response;
  const authorization = request.headers.get("authorization") ?? "";

  const bodyRead = await readRequestBody(request, MAX_ASSISTANT_BODY_BYTES);
  if (!bodyRead.ok) {
    return json(bodyRead.status, {
      error:
        bodyRead.status === 413
          ? "request body exceeds the assistant message size limit"
          : "request body is not readable UTF-8",
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyRead.text);
  } catch {
    return json(400, { error: "request body is not valid JSON" });
  }
  const body = validateBody(parsed);
  if (!body.ok) return json(400, { error: body.error });

  // The live tool catalogue, straight from src/mcp.ts — then narrowed to the
  // read-only half of it. tools/list is principal-independent and includes
  // record_score and accept_handoff; those append OBSERVED events to the spine
  // and must never be reachable from model output. See commitment 2a above.
  const list = await mcpCall(env, authorization, "tools/list", undefined, 1);
  if (!list.ok) {
    return json(502, { error: "assistant_tools_unavailable", detail: list.message });
  }
  const catalogue = toolDefsFrom(list.result);
  const tools = catalogue.filter((tool) => !tool.write);
  if (tools.length === 0) {
    return json(502, { error: "assistant_tools_unavailable", detail: "no read-only tools are available" });
  }
  const readOnlyNames = new Set(tools.map((tool) => tool.name));
  // Kept only to tell "this tool exists but writes" apart from "this tool does
  // not exist" in the refusal, so the caller sees which one actually happened.
  const writeNames = new Set(catalogue.filter((tool) => tool.write).map((tool) => tool.name));

  const model = modelCall ?? gatewayModelCall(env, body.value.gatewayKey, body.value.model, fetcher);

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(tools) },
    { role: "user", content: body.value.question },
  ];
  const toolsUsed: string[] = [];
  const evidence = new Set<string>();
  let rpcId = 2;

  // MAX_TOOL_CALLS tool turns plus one final answering turn.
  for (let turn = 0; turn <= MAX_TOOL_CALLS; turn += 1) {
    const result = await model(messages);
    if (!result.ok) {
      return json(502, { error: "assistant_model_unavailable", detail: result.error });
    }
    const parsedTurn = parseModelTurn(result.text);
    if (!parsedTurn.ok) {
      // Fail closed. An unparseable turn is not an answer, and guessing at
      // what the model meant is exactly how a fabricated answer gets shipped.
      return json(502, {
        error: "assistant_protocol_violation",
        detail: parsedTurn.error,
        tools_used: [...toolsUsed],
      });
    }

    if (parsedTurn.turn.kind === "answer") {
      return json(200, {
        answer: parsedTurn.turn.answer,
        // Non-negotiable. A model's reading of telemetry is never observed
        // evidence, and this platform never labels it as such.
        provenance: "INFERRED",
        tools_used: [...toolsUsed],
        evidence_refs: [...evidence].sort(),
        model: body.value.model,
        tool_calls: toolsUsed.length,
      });
    }

    if (toolsUsed.length >= MAX_TOOL_CALLS) {
      return json(502, {
        error: "assistant_tool_budget_exhausted",
        detail: `the model requested more than ${MAX_TOOL_CALLS} tool calls`,
        tools_used: [...toolsUsed],
      });
    }

    const { name, args } = parsedTurn.turn;
    if (!readOnlyNames.has(name)) {
      if (writeNames.has(name)) {
        // The second half of the read-only guarantee. The write tools were
        // never advertised, so a model asking for one is either confused or
        // steered — most plausibly by injected text inside the very telemetry
        // it was asked to summarize. Either way: refuse loudly and stop. A
        // silent skip would let the model keep going and answer as though the
        // write had happened; executing it would append an OBSERVED
        // score.recorded / handoff.accepted event authored by a model.
        return json(502, {
          error: "assistant_write_tool_refused",
          detail:
            `the model requested a write tool, which the assistant never offers: ${JSON.stringify(name)}. ` +
            "The assistant is read-only; nothing was written.",
          tool: name,
          tools_used: [...toolsUsed],
        });
      }
      return json(502, {
        error: "assistant_unknown_tool",
        detail: `the model requested a tool that does not exist: ${JSON.stringify(name)}`,
        tools_used: [...toolsUsed],
      });
    }

    const called = await mcpCall(
      env,
      authorization,
      "tools/call",
      { name, arguments: args },
      rpcId,
    );
    rpcId += 1;
    if (!called.ok) {
      // A failed tool ends the request. The alternative — telling the model
      // "that failed, carry on" — invites it to answer from nothing, which is
      // the fabrication this endpoint exists to avoid.
      return json(502, {
        error: "assistant_tool_failed",
        detail: called.message,
        tool: name,
        tools_used: [...toolsUsed],
      });
    }

    toolsUsed.push(name);
    const structured = structuredResult(called.result);
    harvestEvidence(structured, evidence);

    messages.push({ role: "assistant", content: result.text });
    let rendered = canonicalJsonStringify({ tool_result: { name, result: structured } });
    if (rendered.length > MAX_TOOL_RESULT_CHARS) {
      rendered = canonicalJsonStringify({
        tool_result: {
          name,
          truncated: true,
          note: "the result was too large to include; narrow the query and call again",
        },
      });
    }
    messages.push({ role: "user", content: rendered });
  }

  // The loop ran out of turns without an answer.
  return json(502, {
    error: "assistant_tool_budget_exhausted",
    detail: `the model requested more than ${MAX_TOOL_CALLS} tool calls`,
    tools_used: [...toolsUsed],
  });
}
