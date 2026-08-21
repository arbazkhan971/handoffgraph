// HandoffGraph Pi extension — v0.4.0 skeleton.
//
// Plain TypeScript, no npm install required: the subset of the Pi extension
// API this file uses is declared locally below (mirroring
// @earendil-works/pi-coding-agent's ExtensionAPI). When this repository
// grows a TS build, replace the local declarations with the package import.
//
// Pipeline: subscribe to Pi session lifecycle + message + tool events,
// serialize each one as a normalized `hfg.pi.event.v1` JSON line, and
// deliver it to the local HandoffGraph collector
// (POST http://127.0.0.1:<port>/v1/events). When the collector is
// unreachable, append to the crash-safe spool
// ~/.handoffgraph/spool/pi-spool.jsonl instead — never drop evidence.
//
// The envelope shape below is the wire contract consumed by
// internal/adapter/pi (Normalize). Keep both sides in sync; the Go tests
// compare this file against the embedded copy shipped by the installer.
//
// Commands registered (stubs): /hfg-checkpoint, /hfg-handoff.

/** Marker + version of the envelope understood by the Go normalizer. */
const HFG_ENVELOPE = "hfg.pi.event.v1"

/** Default collector endpoint (HFG_COLLECTOR_URL overrides). */
const DEFAULT_COLLECTOR_URL = "http://127.0.0.1:7333/v1/events"

/** Spool fallback path (HFG_SPOOL_PATH overrides). */
const DEFAULT_SPOOL_PATH = "~/.handoffgraph/spool/pi-spool.jsonl"

/** Max text kept per event field; long bodies belong in the object store. */
const MAX_TEXT = 4096

/** Documented subset of the Pi ExtensionAPI used by this extension. */
interface PiExtensionAPI {
  on(event: string, handler: (ev: any, ctx: { signal?: AbortSignal }) => void | Promise<void>): void
  registerCommand(name: string, handler: (args: string) => void | Promise<void>): void
}

/** One normalized event line, exactly as consumed by pi.Normalize. */
interface HfgEvent {
  schema: string
  type:
    | "session.start"
    | "session.switch"
    | "session.fork"
    | "message.user"
    | "message.assistant"
    | "tool.start"
    | "tool.end"
  sessionID: string
  parentSessionID?: string
  timestamp: string
  cwd?: string
  model?: string
  message?: string
  tool?: string
  input?: unknown
  output?: string
  error?: string
}

/** expandPath resolves a leading "~" against the home directory. */
function expandPath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? ""
    return home ? p.replace(/^~/, home) : p
  }
  return p
}

/** truncate caps a text field so payloads stay bounded. */
function truncate(s: string): string {
  return s.length <= MAX_TEXT ? s : s.slice(0, MAX_TEXT)
}

let cachedSessionID = ""

/** emit serializes one normalized event. */
function emit(ev: HfgEvent): void {
  deliver(JSON.stringify(ev) + "\n")
}

/** deliver posts one JSON line to the collector, retrying briefly; on
 *  failure it falls back to appending the line to the local spool so no
 *  event is lost while the daemon is down. */
const queue: string[] = []
let delivering = false

async function deliver(line: string): Promise<void> {
  queue.push(line)
  if (delivering) return
  delivering = true
  try {
    while (queue.length > 0) {
      const next = queue[0]
      if (!(await postOrSpool(next))) break
      queue.shift()
    }
  } finally {
    delivering = false
  }
}

/** postOrSpool: POST with up to 2 retries; spool-append as last resort. */
async function postOrSpool(line: string): Promise<boolean> {
  const url = process.env["HFG_COLLECTOR_URL"] ?? DEFAULT_COLLECTOR_URL
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        body: line,
      })
      if (res.ok) return true
    } catch {
      // fall through to retry / spool
    }
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)))
  }
  await spool(line)
  return false
}

/** spool appends one line to the fallback file (best effort). */
async function spool(line: string): Promise<void> {
  const fs = await import("node:fs/promises")
  const path = expandPath(process.env["HFG_SPOOL_PATH"] ?? DEFAULT_SPOOL_PATH)
  try {
    await fs.mkdir(path.substring(0, path.lastIndexOf("/")), { recursive: true })
    await fs.appendFile(path, line, "utf8")
  } catch (err) {
    console.warn("[handoffgraph] spool append failed; event dropped:", err)
  }
}

export default async function handoffgraph(pi: PiExtensionAPI): Promise<void> {
  const cwd = process.cwd()
  const now = () => new Date().toISOString()

  // Session lifecycle: start/switch/fork establish native session identity.
  pi.on("session_start", (ev) => {
    cachedSessionID = String(ev?.sessionID ?? ev?.id ?? "")
    emit({
      schema: HFG_ENVELOPE,
      type: "session.start",
      sessionID: cachedSessionID,
      timestamp: now(),
      cwd,
      model: ev?.model ?? undefined,
    })
  })
  pi.on("session_switch", (ev) => {
    cachedSessionID = String(ev?.sessionID ?? ev?.id ?? cachedSessionID)
    emit({
      schema: HFG_ENVELOPE,
      type: "session.switch",
      sessionID: cachedSessionID,
      parentSessionID: ev?.parentSessionID ?? undefined,
      timestamp: now(),
      cwd,
    })
  })
  pi.on("session_fork", (ev) => {
    const parent = cachedSessionID
    cachedSessionID = String(ev?.sessionID ?? ev?.id ?? "")
    emit({
      schema: HFG_ENVELOPE,
      type: "session.fork",
      sessionID: cachedSessionID,
      parentSessionID: ev?.parentSessionID ?? parent,
      timestamp: now(),
      cwd,
    })
  })

  // Messages: user prompts and assistant completions.
  pi.on("message", (ev) => {
    const role = ev?.message?.role
    if (role !== "user" && role !== "assistant") return
    emit({
      schema: HFG_ENVELOPE,
      type: role === "user" ? "message.user" : "message.assistant",
      sessionID: cachedSessionID,
      timestamp: ev?.timestamp ?? now(),
      cwd,
      model: ev?.model ?? undefined,
      message: truncate(String(ev?.message?.text ?? "")),
    })
  })

  // Tool calls: start + end (end carries output / error).
  pi.on("tool_call", (ev) => {
    emit({
      schema: HFG_ENVELOPE,
      type: "tool.start",
      sessionID: cachedSessionID,
      timestamp: now(),
      cwd,
      tool: String(ev?.tool ?? ev?.name ?? "unknown"),
      input: ev?.input,
    })
  })
  pi.on("tool_call_end", (ev) => {
    emit({
      schema: HFG_ENVELOPE,
      type: "tool.end",
      sessionID: cachedSessionID,
      timestamp: now(),
      cwd,
      tool: String(ev?.tool ?? ev?.name ?? "unknown"),
      output: truncate(String(ev?.output ?? "")),
      error: ev?.error ? truncate(String(ev?.error)) : undefined,
    })
  })

  // Command stubs (v0.4.0 placeholders; wired to the daemon later).
  pi.registerCommand("/hfg-checkpoint", async () => {
    console.log("[handoffgraph] /hfg-checkpoint stub — checkpoint building arrives with the local daemon")
  })
  pi.registerCommand("/hfg-handoff", async () => {
    console.log("[handoffgraph] /hfg-handoff stub — handoff building arrives with the local daemon")
  })
}
