import type { ChatSearchKind, ChatSearchResult, ChatSearchRole } from "@oh-my-pi/pi-wire";
import { File, Image, Link, MessageSquareText, Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { GuestClient } from "../../lib/client";
import { desktopBridge } from "../../lib/desktop-bridge";
import { useNativeTranscriptOcclusion } from "./useNativeTranscriptOcclusion";

interface ChatSearchPanelProps {
	client: GuestClient;
	onClose(): void;
	onReveal(result: ChatSearchResult): Promise<boolean>;
}

const TABS: readonly { kind: ChatSearchKind; label: string }[] = [
	{ kind: "all", label: "全部" },
	{ kind: "file", label: "文件" },
	{ kind: "image", label: "图片" },
	{ kind: "link", label: "链接" },
];

function resultIcon(kind: ChatSearchResult["kind"]): ReactNode {
	switch (kind) {
		case "image":
			return <Image size={17} aria-hidden="true" />;
		case "file":
			return <File size={17} aria-hidden="true" />;
		case "link":
			return <Link size={17} aria-hidden="true" />;
		default:
			return <MessageSquareText size={17} aria-hidden="true" />;
	}
}

function resultTime(timestamp: string): string {
	const parsed = new Date(timestamp);
	if (Number.isNaN(parsed.getTime())) return timestamp;
	return new Intl.DateTimeFormat(undefined, {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(parsed);
}

export function ChatSearchPanel({ client, onClose, onReveal }: ChatSearchPanelProps): ReactNode {
	const [query, setQuery] = useState("");
	const [kind, setKind] = useState<ChatSearchKind>("all");
	const [role, setRole] = useState<ChatSearchRole>("all");
	const [date, setDate] = useState("");
	const [results, setResults] = useState<readonly ChatSearchResult[]>([]);
	const [total, setTotal] = useState(0);
	const [truncated, setTruncated] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [locating, setLocating] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const panelRef = useRef<HTMLElement | null>(null);
	const requestRevision = useRef(0);
	useNativeTranscriptOcclusion(true, panelRef, desktopBridge, kind);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	useEffect(() => {
		const handleShortcut = (event: globalThis.KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.preventDefault();
				onClose();
				return;
			}
			if (event.key.toLocaleLowerCase() === "f" && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				inputRef.current?.focus();
				inputRef.current?.select();
			}
		};
		document.addEventListener("keydown", handleShortcut);
		return () => document.removeEventListener("keydown", handleShortcut);
	}, [onClose]);

	useEffect(() => {
		const revision = ++requestRevision.current;
		const abort = new AbortController();
		let active = true;
		setLoading(true);
		setError(null);
		setResults([]);
		setTotal(0);
		setTruncated(false);
		const timer = window.setTimeout(() => {
			void client
				.searchChat(query, kind, role, date || undefined, 100, abort.signal)
				.then(response => {
					if (!active || requestRevision.current !== revision) return;
					setResults(response.results);
					setTotal(response.total);
					setTruncated(response.truncated);
				})
				.catch(cause => {
					if (!active || requestRevision.current !== revision) return;
					setResults([]);
					setTotal(0);
					setTruncated(false);
					setError(cause instanceof Error ? cause.message : "无法搜索聊天记录");
				})
				.finally(() => {
					if (active && requestRevision.current === revision) setLoading(false);
				});
		}, 180);
		return () => {
			active = false;
			abort.abort();
			window.clearTimeout(timer);
		};
	}, [client, date, kind, query, role]);

	const reveal = async (result: ChatSearchResult): Promise<void> => {
		setLocating(result.entryId);
		setError(null);
		try {
			if (!(await onReveal(result))) setError("这条记录暂时无法定位，请稍后重试。");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "无法定位聊天记录");
		} finally {
			setLocating(null);
		}
	};

	return (
		<aside ref={panelRef} className="sh-chat-search" aria-label="查找聊天记录">
			<div className="sh-chat-search-header">
				<strong>查找聊天记录</strong>
				<button type="button" onClick={onClose} aria-label="关闭查找聊天记录">
					<X size={16} />
				</button>
			</div>
			<div className="sh-chat-search-tabs" role="tablist">
				{TABS.map(tab => (
					<button
						key={tab.kind}
						type="button"
						role="tab"
						aria-selected={kind === tab.kind}
						className={kind === tab.kind ? "sh-chat-search-tab-on" : undefined}
						onClick={() => setKind(tab.kind)}
					>
						{tab.label}
					</button>
				))}
			</div>
			<label className="sh-chat-search-input">
				<Search size={17} aria-hidden="true" />
				<input
					ref={inputRef}
					value={query}
					onChange={event => setQuery(event.target.value)}
					placeholder="搜索聊天记录"
					aria-label="搜索聊天记录"
				/>
				{query && (
					<button type="button" onClick={() => setQuery("")} aria-label="清空搜索">
						<X size={14} />
					</button>
				)}
			</label>
			<div className="sh-chat-search-filters">
				<select value={role} onChange={event => setRole(event.target.value as ChatSearchRole)} aria-label="发送者">
					<option value="all">全部发送者</option>
					<option value="user">我</option>
					<option value="assistant">Grimoire Router App</option>
				</select>
				<input type="date" value={date} onChange={event => setDate(event.target.value)} aria-label="日期" />
			</div>
			<div className="sh-chat-search-summary">
				{loading ? "正在搜索…" : error ? error : `${total} 条结果${truncated ? " · 显示前 100 条" : ""}`}
			</div>
			<div className="sh-chat-search-results">
				{!loading && !error && results.length === 0 && (
					<div className="sh-chat-search-empty">没有找到匹配的聊天记录</div>
				)}
				{results.map((result, index) => (
					<button
						key={`${result.entryId}:${result.kind}:${index}`}
						type="button"
						className="sh-chat-search-result"
						disabled={locating !== null}
						onClick={() => void reveal(result)}
					>
						<span className="sh-chat-search-result-icon">{resultIcon(result.kind)}</span>
						<span className="sh-chat-search-result-body">
							<span className="sh-chat-search-result-meta">
								<span>{result.role === "user" ? "我" : "Grimoire Router App"}</span>
								<time>{resultTime(result.timestamp)}</time>
							</span>
							<span className="sh-chat-search-result-text">
								{locating === result.entryId ? "正在定位…" : result.snippet}
							</span>
						</span>
					</button>
				))}
			</div>
		</aside>
	);
}
