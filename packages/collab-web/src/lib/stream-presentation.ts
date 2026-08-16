import type { AssistantMessage } from "@oh-my-pi/pi-wire";

export const INITIAL_STREAM_BATCH_DELAY_MS = 100;
export const STREAM_BATCH_MAX_DELAY_MS = 280;
export const STREAM_BATCH_MAX_CHARS = 96;

function blockShape(message: AssistantMessage): string {
	return message.content
		.map(block => {
			switch (block.type) {
				case "thinking":
				case "redactedThinking":
				case "text":
					return block.type;
				case "toolCall":
					return `${block.type}:${block.id}:${block.name}`;
				default:
					return "unknown";
			}
		})
		.join("|");
}

function visibleText(message: AssistantMessage): string {
	return message.content
		.map(block => {
			switch (block.type) {
				case "thinking":
					return block.thinking;
				case "text":
					return block.text;
				case "redactedThinking":
					return "[redacted]";
				case "toolCall":
					return `${block.name}\n${block.intent ?? ""}`;
				default:
					return "";
			}
		})
		.join("\n");
}

function endsAtNaturalBoundary(delta: string): boolean {
	if (/\n\s*$/u.test(delta)) return true;
	if (delta.length < 4) return false;
	return /(?:[。！？；：]|[.!?;:])(?:["'”’」』】）)\]]*)?\s*$/u.test(delta);
}

/**
 * Decide whether the pending assistant stream has accumulated a useful visual
 * chunk. Sentence/paragraph boundaries win; a bounded time and size fallback
 * keeps unpunctuated model output responsive without laying out every token.
 */
export function shouldFlushAssistantStreamBatch(
	presented: AssistantMessage,
	latest: AssistantMessage,
	elapsedMs: number,
): boolean {
	if (blockShape(presented) !== blockShape(latest)) return true;
	const previousText = visibleText(presented);
	const latestText = visibleText(latest);
	if (latestText === previousText) return false;
	if (!latestText.startsWith(previousText)) return true;
	const delta = latestText.slice(previousText.length);
	return (
		delta.length >= STREAM_BATCH_MAX_CHARS || endsAtNaturalBoundary(delta) || elapsedMs >= STREAM_BATCH_MAX_DELAY_MS
	);
}
