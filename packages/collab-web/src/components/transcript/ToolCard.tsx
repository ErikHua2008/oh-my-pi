import type { ToolResultMessage } from "@oh-my-pi/pi-wire";
import type { ReactNode } from "react";
import { memo } from "react";
import { messageText } from "../../lib/format";
import { planPresentation, transcriptToolPresentation } from "../../lib/transcript-presentation";
import { type ToolRenderHost, ToolView } from "../../tool-render";

export interface ToolCardProps {
	toolCallId: string;
	name: string;
	args: unknown;
	intent?: string;
	result?: ToolResultMessage;
	running?: boolean;
	partialResult?: unknown;
	host?: ToolRenderHost;
}

/** Wire-type adapter over the shared per-tool renderer stack. */
export const ToolCard = memo(function ToolCard(props: ToolCardProps): ReactNode {
	const { toolCallId, name, intent, args, result, running, partialResult, host } = props;
	const presentation = transcriptToolPresentation(name);
	if (presentation === "hidden") return null;
	if (presentation === "plan") {
		const plan = planPresentation(result?.details, args);
		return (
			<div className="tr-plan-card" data-tool-call-id={toolCallId}>
				<div className="tr-plan-head">
					<span>计划</span>
					<span>{plan.total > 0 ? `${plan.done}/${plan.total}` : running ? "更新中…" : "已更新"}</span>
				</div>
				{plan.current && (
					<div className="tr-plan-item tr-plan-item--current">
						<span aria-hidden="true">→</span>
						<span>{plan.current}</span>
					</div>
				)}
				{plan.next && plan.next !== plan.current && (
					<div className="tr-plan-item">
						<span aria-hidden="true">○</span>
						<span>下一步：{plan.next}</span>
					</div>
				)}
				{plan.total > 0 && plan.done === plan.total && <div className="tr-plan-complete">✓ 全部任务已完成</div>}
			</div>
		);
	}
	const partial =
		running && !result ? (typeof partialResult === "string" ? partialResult : messageText(partialResult)) : "";
	return (
		<div className="tr-tool-card" data-tool-call-id={toolCallId}>
			<ToolView
				name={name}
				args={args}
				result={result}
				running={running}
				intent={intent}
				partial={partial || undefined}
				host={host}
			/>
		</div>
	);
});
