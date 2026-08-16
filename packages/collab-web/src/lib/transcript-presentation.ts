export type TranscriptToolPresentation = "plan" | "operation" | "hidden";

const PLAN_TOOLS = new Set(["todo", "todo_write", "update_plan"]);
const INTERNAL_TOOLS = new Set([
	"ask",
	"await",
	"cancel_job",
	"goal",
	"hub",
	"irc",
	"job",
	"poll",
	"propose",
	"recall",
	"reflect",
	"reject",
	"report_tool_issue",
	"resolve",
	"retain",
	"task",
	"yield",
]);

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function shortened(value: string, limit = 96): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

export function transcriptToolPresentation(name: string): TranscriptToolPresentation {
	const normalized = name.trim().toLowerCase();
	if (PLAN_TOOLS.has(normalized)) return "plan";
	if (INTERNAL_TOOLS.has(normalized)) return "hidden";
	// Unknown extension tools remain visible: hiding a plug-in operation would
	// make an actual side effect disappear from the audit trail.
	return "operation";
}

export interface PlanPresentation {
	done: number;
	total: number;
	current: string | null;
	next: string | null;
}

interface PlanTask {
	content: string;
	status: string;
}

function planTasksFromDetails(details: unknown): PlanTask[] {
	const phases = record(details)?.phases;
	if (!Array.isArray(phases)) return [];
	const tasks: PlanTask[] = [];
	for (const phaseValue of phases) {
		const phase = record(phaseValue);
		if (!Array.isArray(phase?.tasks)) continue;
		for (const taskValue of phase.tasks) {
			const task = record(taskValue);
			const content = text(task?.content);
			if (content) tasks.push({ content, status: text(task?.status) ?? "pending" });
		}
	}
	return tasks;
}

function planTasksFromArgs(args: unknown): PlanTask[] {
	const value = record(args);
	if (!value) return [];
	const tasks: PlanTask[] = [];
	if (Array.isArray(value.list)) {
		for (const phaseValue of value.list) {
			const phase = record(phaseValue);
			if (!Array.isArray(phase?.items)) continue;
			for (const item of phase.items) {
				const content = text(item);
				if (content) tasks.push({ content, status: tasks.length === 0 ? "in_progress" : "pending" });
			}
		}
	}
	if (tasks.length === 0) {
		const content = text(value.task);
		if (content) tasks.push({ content, status: "in_progress" });
	}
	return tasks;
}

export function planPresentation(details: unknown, args?: unknown): PlanPresentation {
	const tasks = planTasksFromDetails(details);
	const available = tasks.length > 0 ? tasks : planTasksFromArgs(args);
	const done = available.filter(task => task.status === "completed" || task.status === "abandoned").length;
	const current =
		available.find(task => task.status === "in_progress" || task.status === "blocked") ??
		available.find(task => task.status === "pending") ??
		null;
	const next = available.find(task => task.status === "pending" && task !== current) ?? null;
	return {
		done,
		total: available.length,
		current: current?.content ?? null,
		next: next?.content ?? null,
	};
}

export function planPresentationText(details: unknown, args?: unknown): string {
	const plan = planPresentation(details, args);
	if (plan.total === 0) return "计划正在更新…";
	const lines = [`计划 · ${plan.done}/${plan.total}`];
	if (plan.current) lines.push(`→ ${shortened(plan.current, 120)}`);
	if (plan.next && plan.next !== plan.current) lines.push(`○ 下一步：${shortened(plan.next, 110)}`);
	if (plan.done === plan.total) lines.push("✓ 全部任务已完成");
	return lines.join("\n");
}

function firstPath(args: Record<string, unknown>): string | null {
	const direct = text(args.path) ?? text(args.file_path) ?? text(args.cwd);
	if (direct) return direct;
	if (Array.isArray(args.paths)) return args.paths.map(text).find((value): value is string => value !== null) ?? null;
	return null;
}

function patchPath(args: Record<string, unknown>): string | null {
	const input = text(args.input) ?? text(args._input);
	if (!input) return firstPath(args);
	const match = /^\*{3} (?:Update|Add|Delete) File:\s*(.+)$/m.exec(input);
	return match?.[1]?.trim() || firstPath(args);
}

/** One-line native summary used before the expandable operation details. */
export function operationPresentation(name: string, rawArgs: unknown, failed = false): string {
	const normalized = name.trim().toLowerCase();
	const args = record(rawArgs) ?? {};
	let action = `已执行操作 · ${name}`;
	switch (normalized) {
		case "bash":
		case "exec_command":
		case "shell_command": {
			const command = text(args.command) ?? text(args.cmd);
			action = command ? `已执行命令 · ${shortened(command)}` : "已执行命令";
			break;
		}
		case "read": {
			const path = firstPath(args);
			action = path ? `已读取文件 · ${shortened(path)}` : "已读取文件";
			break;
		}
		case "write":
		case "edit":
		case "apply_patch":
		case "ast_edit": {
			const path = patchPath(args);
			action = path ? `已修改文件 · ${shortened(path)}` : "已修改文件";
			break;
		}
		case "grep":
		case "search":
		case "ast_grep": {
			const pattern = text(args.pattern) ?? text(args.query);
			action = pattern ? `已搜索内容 · ${shortened(pattern)}` : "已搜索文件内容";
			break;
		}
		case "glob":
		case "find": {
			const path = firstPath(args);
			action = path ? `已查找文件 · ${shortened(path)}` : "已查找文件";
			break;
		}
		case "inspect_image":
			action = "已查看图片";
			break;
		default:
			break;
	}
	return failed ? `操作失败 · ${action.replace(/^已/, "")}` : action;
}

const SYSTEM_TAG = /<system-(?:reminder|notification|interrupt)(?:\s[^>]*)?>/i;
const SYSTEM_CUSTOM_TYPE = /(?:^|[-_:])(reminder|notification)(?:$|[-_:])/i;

export function isSystemReminder(customType: string, content: string): boolean {
	return SYSTEM_TAG.test(content) || SYSTEM_CUSTOM_TYPE.test(customType);
}
