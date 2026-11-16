// Puts the herdr_spaces list before each user request, in a hidden <herdr-spaces> message, so that
// the orchestrator routes the request in its first model call. Before, every request began with a
// model call that only called herdr_spaces, and a second one that read the list.
// It builds the list with the same code as herdr_spaces (herdrClient's spaces), so the model sees
// the same JSON. If the list fails or takes more than LIST_MS, it adds nothing, and the model
// calls herdr_spaces as before.
// Only user prompts get it. omp starts no before_agent_start for the messages of the other
// extensions (<herdr-report>, <herdr-pr-ready>, ...: attribution "agent"), and a prompt that
// starts with <herdr- is skipped too, in case that changes. A worker's reply typed in with
// hc send (<hc from=...>) is a user prompt, and gets the list: its box needs the space id.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { herdrClient } from "../tools/herdr.ts";

const LIST_MS = 2_000;
const TAG = "herdr-spaces";

export default function herdrSpaces(pi: ExtensionAPI) {
	const herdr = herdrClient(pi.exec);

	// The list as herdr_spaces returns it, or undefined when it fails or is late. A late list is
	// dropped even if it ends: an abort turns the hc get of each terminal into nulls.
	async function list(): Promise<string | undefined> {
		const stop = new AbortController();
		const late = Promise.withResolvers<undefined>();
		const timer = setTimeout(() => {
			stop.abort();
			late.resolve(undefined);
		}, LIST_MS);
		try {
			const out = await Promise.race([herdr.spaces(stop.signal), late.promise]);
			return out && !stop.signal.aborted ? JSON.stringify(out) : undefined;
		} catch {
			return undefined;
		} finally {
			clearTimeout(timer);
		}
	}

	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.agent.kind !== "main" || !ctx.hasUI) return;
		// "revive" restarts a turn with no new prompt.
		if (event.reason !== undefined && event.reason !== "prompt") return;
		const prompt = event.prompt.trimStart();
		if (!prompt || prompt.startsWith("<herdr-")) return;
		const json = await list();
		if (!json) return;
		return { message: { customType: TAG, content: `<${TAG}>\n${json}\n</${TAG}>`, display: false } };
	});
}
