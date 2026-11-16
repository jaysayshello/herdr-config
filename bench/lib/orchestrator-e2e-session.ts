// Reads an omp session file (jsonl) into the parts the orchestrator-e2e case times. The format, as
// omp 18 writes it:
//   {type:"message", message:{role:"user", timestamp(ms), content}}                  a prompt (or an hc note)
//   {type:"message", message:{role:"assistant", timestamp(ms, request start), completedAt(ms),
//     duration, ttft, usage:{input, output, cacheRead, cacheWrite}, content:[{type:"toolCall", id, name}, …]}}
//   {type:"custom", customType:"tool_execution_start", data:{toolCallId, toolName, startedAt(ISO)}}
//   {type:"message", message:{role:"toolResult", toolCallId, toolName, timestamp(ms, the end), content:[{type:"text", text}]}}
//   {type:"custom_message", customType:"herdr-report", timestamp(ISO), content}   a watch report
import * as fs from "node:fs";

export interface ModelCall {
	start: number;
	end: number;
	ttft: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tools: string[];
	model: string;
}
export interface ToolCall {
	id: string;
	name: string;
	start: number;
	end: number;
	text: string;
}
export interface Session {
	users: { at: number; text: string }[];
	models: ModelCall[];
	tools: ToolCall[];
	reports: { at: number; content: string }[];
}

interface Raw {
	type?: string;
	customType?: string;
	timestamp?: string;
	content?: unknown;
	data?: { toolCallId?: string; toolName?: string; startedAt?: string };
	message?: {
		role?: string;
		timestamp?: number;
		completedAt?: number;
		ttft?: number;
		toolCallId?: string;
		model?: string;
		toolName?: string;
		usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
		content?: unknown;
	};
}

const textOf = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map(c => (c && typeof c === "object" && "text" in c && typeof c.text === "string" ? c.text : "")).join("")
			: "";

export function readSession(file: string): Session {
	const s: Session = { users: [], models: [], tools: [], reports: [] };
	const starts = new Map<string, { name: string; at: number }>();
	let text = "";
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return s;
	}
	for (const line of text.split("\n")) {
		if (!line) continue;
		let e: Raw;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		const m = e.message;
		if (e.type === "message" && m?.role === "user") s.users.push({ at: m.timestamp ?? 0, text: textOf(m.content) });
		else if (e.type === "message" && m?.role === "assistant") {
			const calls = Array.isArray(m.content) ? m.content : [];
			s.models.push({
				start: m.timestamp ?? 0,
				end: m.completedAt ?? m.timestamp ?? 0,
				ttft: m.ttft ?? 0,
				input: m.usage?.input ?? 0,
				output: m.usage?.output ?? 0,
				cacheRead: m.usage?.cacheRead ?? 0,
				cacheWrite: m.usage?.cacheWrite ?? 0,
				tools: calls.flatMap(c => (c && typeof c === "object" && "type" in c && c.type === "toolCall" && "name" in c && typeof c.name === "string" ? [c.name] : [])),
				model: m.model ?? "?",
			});
		} else if (e.type === "custom" && e.customType === "tool_execution_start" && e.data?.toolCallId)
			starts.set(e.data.toolCallId, { name: e.data.toolName ?? "?", at: Date.parse(e.data.startedAt ?? e.timestamp ?? "") });
		else if (e.type === "message" && m?.role === "toolResult") {
			const id = m.toolCallId ?? "";
			const start = starts.get(id);
			s.tools.push({ id, name: m.toolName ?? start?.name ?? "?", start: start?.at ?? m.timestamp ?? 0, end: m.timestamp ?? 0, text: textOf(m.content) });
		} else if (e.type === "custom_message" && e.customType === "herdr-report") s.reports.push({ at: Date.parse(e.timestamp ?? ""), content: textOf(e.content) });
	}
	return s;
}

// Bytes of each field in a herdr_spaces result, summed over all spaces, tabs and terminals
// (`"key":value,` as JSON writes it), plus the JSON punctuation around them.
export function spacesFieldBytes(json: string): Record<string, number> {
	const out: Record<string, number> = {};
	const add = (prefix: string, obj: Record<string, unknown>, skip: string[]) => {
		for (const [k, v] of Object.entries(obj)) {
			if (skip.includes(k)) continue;
			const key = `${prefix}.${k}`;
			out[key] = (out[key] ?? 0) + Buffer.byteLength(`${JSON.stringify(k)}:${JSON.stringify(v)},`);
		}
	};
	let parsed: { self?: Record<string, unknown>; spaces?: { tabs?: { terminals?: Record<string, unknown>[] }[] }[] };
	try {
		parsed = JSON.parse(json);
	} catch {
		return out;
	}
	if (parsed.self) add("self", parsed.self, []);
	for (const sp of parsed.spaces ?? []) {
		add("space", sp as Record<string, unknown>, ["tabs"]);
		for (const tab of sp.tabs ?? []) {
			add("tab", tab as Record<string, unknown>, ["terminals"]);
			for (const t of tab.terminals ?? []) add("terminal", t, []);
		}
	}
	const fields = Object.values(out).reduce((a, b) => a + b, 0);
	out.punctuation = Buffer.byteLength(json) - fields;
	return out;
}
