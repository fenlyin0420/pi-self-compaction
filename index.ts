/**
 * Model-driven context compaction.
 *
 * Pi compacts on its own once the context crosses `contextWindow - reserveTokens`. That
 * threshold is a client-side decision the model never sees coming, and nothing in the prompt
 * tells the model how full its window is. This extension gives it both, so it can compact
 * earlier, at a boundary it picks:
 *
 * 1. Every USAGE_NOTICE_INTERVAL top-level tool calls, a `context_usage` notice is appended to
 *    the conversation. It is persisted as a custom message (so it survives resume and
 *    compaction) and hidden from the transcript. Appending at the tail keeps the prompt-cache
 *    prefix intact.
 * 2. `compact_context` carries the policy in the system prompt (promptSnippet +
 *    promptGuidelines) and only records the request; it never compacts inline.
 * 3. `turn_end` executes it: that boundary runs after every tool result of the turn is
 *    persisted, which is when the context can be rewritten safely. The tool result sets
 *    `terminate: true`, so the loop ends the batch instead of starting another assistant turn.
 * 4. The call is fire-and-forget because `session.compact()` starts with `abort()`, and
 *    `abort()` awaits an idle session. Awaiting it from inside a run deadlocks: the tool waits
 *    for the run to end, the run waits for the tool to return.
 * 5. `onComplete` starts one fresh run so the model continues the task on the compacted context
 *    instead of stopping. Failed and cancelled compaction resumes too, otherwise the aborted
 *    run would drop the task silently.
 *
 * Pi's own threshold compaction stays enabled as the backstop for when the model misjudges.
 */

import type { ContextUsage, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Append a context-usage notice every N top-level tool calls. */
const USAGE_NOTICE_INTERVAL = 5;

/** Usage percentage at which the notice tells the model to compact. */
const COMPACT_HINT_PERCENT = 60;

const USAGE_MESSAGE_TYPE = "context-usage";
const RESUME_MESSAGE_TYPE = "compaction-resume";

const CompactParams = Type.Object({
	instructions: Type.Optional(
		Type.String({
			description:
				"Optional focus for the summary, e.g. 'keep the exact API contract and the failing test output'.",
		}),
	),
});

function formatPercent(percent: number | null): string {
	return percent === null ? "unknown" : `${percent.toFixed(1)}%`;
}

function formatUsageNotice(usage: ContextUsage, callsSinceNotice: number): string {
	const lines = [
		`[context] ${formatPercent(usage.percent)} of the ${usage.contextWindow.toLocaleString()} token window used. ${callsSinceNotice} tool calls since the previous notice.`,
	];
	if (usage.percent !== null && usage.percent >= COMPACT_HINT_PERCENT) {
		lines.push(
			`[context] Context is above ${COMPACT_HINT_PERCENT}%. Call \`compact_context\` at the next safe point (after the current edit or command, before starting a large new read).`,
		);
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	/** Tool calls counted since the last notice was appended. */
	let callsSinceNotice = 0;
	/** Set by the `compact_context` tool, consumed by the next `turn_end`. */
	let pendingInstructions: string | undefined;
	let pendingCompaction = false;

	const resume = (ctx: ExtensionContext, errorMessage?: string): void => {
		const text = errorMessage
			? `[context] Compaction did not run (${errorMessage}). The conversation is unchanged; continue the task.`
			: `[context] Older messages were summarized away. The summary covers the work so far; continue the task from where you stopped instead of re-reading files it already covers.`;
		pi.sendMessage({ customType: RESUME_MESSAGE_TYPE, content: text, display: false }, { triggerTurn: true });
	};

	pi.registerTool({
		name: "compact_context",
		label: "Compact Context",
		description:
			"Summarize older conversation into a summary to free context. Runs at the end of the current turn; the task resumes automatically on the compacted context. Use it when the [context] usage notices show the window filling up.",
		promptSnippet:
			"compact_context - summarize older conversation to free context, at your own judgement rather than Pi's forced threshold",
		promptGuidelines: [
			"Pi appends a `[context]` usage notice every 5 tool calls. It reports how full the model context window is; treat it as authoritative and watch the trend.",
			"When a notice reports 60% or more used, call `compact_context` at the next safe point - after the current file edit or command finishes, before starting a large file read or a long test run. Waiting longer risks Pi's own forced compaction, which interrupts you mid-step.",
			"`compact_context` runs at the end of the turn and the task resumes automatically, so pass `instructions` for anything the summary must preserve, then end your turn with a one-line status.",
			"Never call `compact_context` in the same batch as work you have not finished, and never call it twice in one turn.",
		],
		parameters: CompactParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (pendingCompaction) {
				return {
					content: [{ type: "text" as const, text: "Compaction is already scheduled for this turn." }],
					details: { scheduled: false },
					terminate: true,
				};
			}
			const usage = ctx.getContextUsage();
			pendingCompaction = true;
			pendingInstructions = params.instructions;
			const status = usage
				? `${formatPercent(usage.percent)} of ${usage.contextWindow.toLocaleString()} tokens used`
				: "usage unknown";
			return {
				content: [
					{
						type: "text" as const,
						text: `Compaction scheduled for the end of this turn (${status}). Stop calling tools now and end your turn with a one-line status; the compacted context and your next turn follow automatically.`,
					},
				],
				// Ending the batch here means the loop never starts another assistant turn, so the
				// compaction in the turn_end handler does not have a live stream to abort.
				details: { scheduled: true, usage },
				terminate: true,
			};
		},
	});

	pi.on("session_start", async () => {
		callsSinceNotice = 0;
		pendingCompaction = false;
		pendingInstructions = undefined;
	});

	// A request only lives for one turn. Clearing here keeps a request that never reached its
	// boundary (run aborted or errored) from firing on a later, unrelated turn.
	pi.on("turn_start", async () => {
		pendingCompaction = false;
		pendingInstructions = undefined;
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		// Nested calls (for example from a codemode script) belong to their parent call.
		if (event.parentToolCallId !== undefined) return;
		callsSinceNotice++;
		if (callsSinceNotice < USAGE_NOTICE_INTERVAL) return;
		const usage = ctx.getContextUsage();
		if (!usage) return;
		const sinceNotice = callsSinceNotice;
		callsSinceNotice = 0;
		// While streaming this is queued and flushed once the turn's tool results are persisted,
		// so the notice lands before the next assistant response.
		pi.sendMessage(
			{
				customType: USAGE_MESSAGE_TYPE,
				content: formatUsageNotice(usage, sinceNotice),
				display: false,
				details: usage,
			},
			{ triggerTurn: false },
		);
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!pendingCompaction) return;
		pendingCompaction = false;
		const customInstructions = pendingInstructions;
		pendingInstructions = undefined;
		ctx.compact({
			customInstructions,
			onComplete: () => resume(ctx),
			onError: (error) => resume(ctx, error.message),
		});
	});
}
