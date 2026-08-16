import type { LocalFileReference } from "@oh-my-pi/pi-wire";
import { ArrowUp, File, Folder, Paperclip, SendHorizontal, Square, X } from "lucide-react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import { type DesktopBridge, desktopBridge as defaultDesktopBridge } from "../../lib/desktop-bridge";
import { shortenPath } from "../../lib/format";
import { ModelPicker } from "./ModelPicker";

export interface ComposerProps {
	client: GuestClient;
	snapshot: GuestSnapshot;
	/** Optional prompt text selected from the transcript for edit-and-resend. */
	prefill?: string;
	onPrefillConsumed?: () => void;
	/** Injectable native bridge; defaults to the process-wide WebView bridge. */
	desktop?: DesktopBridge;
}

/** Textarea metrics: line-height 20px + 8px vertical padding × 2 (kept in sync with composer.css). */
const LINE_PX = 20;
const PAD_Y = 16;
const MAX_ROWS = 8;

interface DraftLocalFile extends LocalFileReference {
	available: boolean;
}

function localFileName(path: string): string {
	const withoutTrailingSeparators = path.replace(/[\\/]+$/, "");
	return withoutTrailingSeparators.split(/[\\/]/).pop() || path;
}

function comparableLocalPath(path: string): string {
	const normalized = path.replaceAll("\\", "/");
	return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLocaleLowerCase() : normalized;
}

const THINKING_LABELS: Readonly<Record<string, string>> = {
	off: "Off",
	auto: "Auto",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

function autosize(el: HTMLTextAreaElement | null): void {
	if (!el) return;
	el.style.height = "0px";
	const max = MAX_ROWS * LINE_PX + PAD_Y;
	el.style.height = `${Math.max(LINE_PX + PAD_Y, Math.min(el.scrollHeight, max))}px`;
	el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

/**
 * Decides whether an Enter keydown should commit the composer. Returns `false` while an IME
 * composition is active so the keystroke confirms the composition instead of submitting.
 * `nativeEvent.isComposing` covers most browsers; `composing` bridges WebKit, which fires the
 * confirming Enter keydown *after* `compositionend`.
 */
export function shouldSubmitOnEnter(e: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean {
	if (e.key !== "Enter" || e.shiftKey) return false;
	return !(e.nativeEvent.isComposing || composing);
}

/**
 * Tracks IME composition state via a ref the keydown handler reads synchronously. The
 * `compositionend` reset is deferred a tick because WebKit dispatches the confirming Enter
 * keydown after `compositionend`, when `nativeEvent.isComposing` is already `false`.
 */
function useCompositionGuard(): {
	composingRef: RefObject<boolean>;
	onCompositionStart(): void;
	onCompositionEnd(): void;
} {
	const composingRef = useRef(false);
	const onCompositionStart = useCallback((): void => {
		composingRef.current = true;
	}, []);
	const onCompositionEnd = useCallback((): void => {
		setTimeout(() => {
			composingRef.current = false;
		}, 0);
	}, []);
	return { composingRef, onCompositionStart, onCompositionEnd };
}

interface AskEditorProps {
	prefill: string | undefined;
	onSubmit(value: string): void;
}

/**
 * Editor ask input. Rendered with `key={reqId}` so a new request remounts it with a fresh
 * draft seeded from `prefill`, while re-sends of the same request never clobber a half-typed
 * draft. Submits verbatim — whitespace-only responses are intentional.
 */
function AskEditor({ prefill, onSubmit }: AskEditorProps): ReactNode {
	const [draft, setDraft] = useState(prefill ?? "");
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [draft]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			onSubmit(draft);
		}
	};

	return (
		<div className="sh-composer-editor">
			<textarea
				ref={taRef}
				className="sh-composer-input"
				value={draft}
				onChange={e => setDraft(e.target.value)}
				onKeyDown={onKeyDown}
				onCompositionStart={onCompositionStart}
				onCompositionEnd={onCompositionEnd}
				placeholder="type your response…"
				rows={1}
				spellCheck={false}
			/>
			<div className="sh-composer-controls sh-ask-editor-controls">
				<span className="sh-composer-hint">Enter to submit · Shift+Enter for newline</span>
				<button
					type="button"
					className="sh-composer-submit"
					onClick={() => onSubmit(draft)}
					title="submit response"
				>
					<SendHorizontal size={13} />
					Submit
				</button>
			</div>
		</div>
	);
}

function Workspace({ cwd }: { cwd: string | undefined }): ReactNode {
	if (!cwd) return <span className="sh-workspace sh-workspace-empty">workspace unavailable</span>;

	const normalized = cwd.replace(/[\\/]+$/, "");
	const segments = normalized.split(/[\\/]/);
	const project = segments[segments.length - 1] || cwd;
	return (
		<span className="sh-workspace" title={cwd}>
			<Folder size={13} aria-hidden="true" />
			<span className="sh-workspace-project">{project}</span>
			<span className="sh-workspace-path">{shortenPath(cwd)}</span>
		</span>
	);
}

export function Composer({
	client,
	snapshot,
	prefill,
	onPrefillConsumed,
	desktop = defaultDesktopBridge,
}: ComposerProps): ReactNode {
	const [text, setText] = useState(prefill ?? "");
	const [localFiles, setLocalFiles] = useState<readonly DraftLocalFile[]>([]);
	const [attachmentError, setAttachmentError] = useState<string | null>(null);
	const [attachmentBusy, setAttachmentBusy] = useState(false);
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	const live = snapshot.phase === "live";
	const readOnly = snapshot.readOnly;
	const uiRequest = snapshot.uiRequest;
	const canPrompt = live && !readOnly;
	const busy = snapshot.working;
	const queued = snapshot.state?.queuedMessageCount ?? 0;
	const canSend =
		canPrompt &&
		!attachmentBusy &&
		(text.trim().length > 0 || localFiles.length > 0) &&
		localFiles.every(file => file.available);
	const thinkingLevels = snapshot.state?.availableThinkingLevels ?? [];
	const configuredThinkingLevel = snapshot.state?.configuredThinkingLevel;

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [text, uiRequest?.reqId]);

	useEffect(() => {
		if (prefill === undefined) return;
		setText(prefill);
		requestAnimationFrame(() => {
			taRef.current?.focus();
			taRef.current?.setSelectionRange(prefill.length, prefill.length);
		});
	}, [prefill]);

	const pickAttachments = useCallback(async (): Promise<void> => {
		setAttachmentBusy(true);
		setAttachmentError(null);
		try {
			const paths = await desktop.pickAttachments();
			setLocalFiles(current => {
				const seen = new Set(current.map(file => comparableLocalPath(file.path)));
				const additions: DraftLocalFile[] = [];
				for (const path of paths) {
					const key = comparableLocalPath(path);
					if (seen.has(key)) continue;
					seen.add(key);
					additions.push({ kind: "local-file", path, name: localFileName(path), available: true });
				}
				return additions.length > 0 ? [...current, ...additions] : current;
			});
		} catch {
			setAttachmentError("The native file picker is unavailable.");
		} finally {
			setAttachmentBusy(false);
		}
	}, [desktop]);

	const removeAttachment = useCallback((path: string): void => {
		setLocalFiles(current => current.filter(file => file.path !== path));
		setAttachmentError(null);
	}, []);

	const send = useCallback(async (): Promise<void> => {
		const trimmed = text.trim();
		if ((!trimmed && localFiles.length === 0) || !live || readOnly || attachmentBusy) return;
		setAttachmentBusy(true);
		setAttachmentError(null);
		try {
			if (localFiles.length > 0) {
				const statuses = await desktop.checkAttachments(localFiles.map(file => file.path));
				const availability = new Map(statuses.map(status => [comparableLocalPath(status.path), status.available]));
				const checked = localFiles.map(file => ({
					...file,
					available: availability.get(comparableLocalPath(file.path)) === true,
				}));
				const unavailable = checked.some(file => !file.available);
				if (unavailable) {
					setLocalFiles(checked);
					setAttachmentError("One or more referenced files are no longer available.");
					return;
				}
			}
			client.sendPrompt(
				trimmed,
				localFiles.map(({ kind, path, name }) => ({ kind, path, name })),
			);
			setText("");
			setLocalFiles([]);
			onPrefillConsumed?.();
		} catch {
			setAttachmentError("The referenced files could not be checked.");
		} finally {
			setAttachmentBusy(false);
		}
	}, [attachmentBusy, client, desktop, live, localFiles, onPrefillConsumed, readOnly, text]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			void send();
		}
	};

	if (uiRequest && canPrompt) {
		return (
			<div className="sh-composer sh-composer-ask">
				<div className="sh-composer-card">
					<div className="sh-ask-title">{uiRequest.title}</div>
					{uiRequest.kind === "select" ? (
						<div className="sh-ask-options">
							{uiRequest.options.map((option, index) => {
								const label = typeof option === "string" ? option : option.label;
								const checked = uiRequest.checkedIndices?.includes(index) ?? false;
								return (
									<button
										key={`${uiRequest.reqId}-${index}-${label}`}
										type="button"
										className={`sh-ask-option${checked ? " sh-ask-option-checked" : ""}`}
										onClick={() => client.sendUiResponse(uiRequest.reqId, label)}
									>
										<span className="sh-ask-option-marker">
											{uiRequest.selectionMarker === "checkbox"
												? checked
													? "☑"
													: "☐"
												: checked
													? "◉"
													: "○"}
										</span>
										<span className="sh-ask-option-copy">
											<span className="sh-ask-option-label">{label}</span>
											{typeof option !== "string" && option.description && (
												<span className="sh-ask-option-description">{option.description}</span>
											)}
										</span>
									</button>
								);
							})}
						</div>
					) : (
						<AskEditor
							key={uiRequest.reqId}
							prefill={uiRequest.prefill}
							onSubmit={value => client.sendUiResponse(uiRequest.reqId, value)}
						/>
					)}
					<div className="sh-composer-controls sh-ask-actions">
						<Workspace cwd={snapshot.state?.cwd} />
						<span className="sh-composer-control-spacer" />
						<button type="button" className="sh-btn" onClick={() => client.sendUiResponse(uiRequest.reqId)}>
							Cancel
						</button>
						{busy && (
							<button
								type="button"
								className="sh-btn sh-btn-stop"
								onClick={() => client.sendAbort()}
								disabled={!live}
								title="stop the current turn"
							>
								<Square size={11} /> <span className="sh-btn-label">Stop</span>
							</button>
						)}
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="sh-composer">
			<div className="sh-composer-card">
				{localFiles.length > 0 && (
					<div className="sh-composer-attachments" aria-label="local file references">
						{localFiles.map(file => (
							<div
								key={file.path}
								className={`sh-composer-attachment${file.available ? "" : " sh-composer-attachment-missing"}`}
								title={file.path}
							>
								<File size={13} aria-hidden="true" />
								<span>{file.name}</span>
								{!file.available && <span className="sh-composer-attachment-status">unavailable</span>}
								<button
									type="button"
									onClick={() => removeAttachment(file.path)}
									title={`remove ${file.name}`}
									aria-label={`remove ${file.name}`}
								>
									<X size={12} aria-hidden="true" />
								</button>
							</div>
						))}
					</div>
				)}
				{attachmentError && (
					<div className="sh-composer-attachment-error" role="alert">
						{attachmentError}
					</div>
				)}
				<textarea
					ref={taRef}
					className="sh-composer-input"
					value={text}
					onChange={e => setText(e.target.value)}
					onKeyDown={onKeyDown}
					onCompositionStart={onCompositionStart}
					onCompositionEnd={onCompositionEnd}
					placeholder={
						readOnly
							? "read-only session — watching only"
							: live
								? "prompt the host agent…"
								: "waiting for session…"
					}
					disabled={!canPrompt}
					rows={1}
					spellCheck={false}
				/>
				<div className="sh-composer-controls">
					{desktop.localFilesAvailable && (
						<button
							type="button"
							className="sh-composer-attach"
							onClick={() => void pickAttachments()}
							disabled={!canPrompt || attachmentBusy}
							title="reference local files"
							aria-label="reference local files"
						>
							<Paperclip size={15} aria-hidden="true" />
						</button>
					)}
					<Workspace cwd={snapshot.state?.cwd} />
					{thinkingLevels.length > 0 && configuredThinkingLevel && (
						<select
							className="sh-thinking-picker"
							value={configuredThinkingLevel}
							disabled={!canPrompt}
							title="change thinking level"
							aria-label="thinking level"
							onChange={event => client.sendThinkingChange(event.target.value)}
						>
							{thinkingLevels.map(level => (
								<option key={level} value={level}>
									{THINKING_LABELS[level] ?? level}
								</option>
							))}
						</select>
					)}
					<ModelPicker
						snapshot={snapshot}
						disabled={!canPrompt}
						onModelList={() => client.sendModelList()}
						onModelChange={(provider, id) => client.sendModelChange(provider, id)}
					/>
					<span className="sh-composer-control-spacer" />
					{busy && queued > 0 && (
						<span className="sh-queued">
							<span className="sh-queued-label">queued </span>×{queued}
						</span>
					)}
					{busy && !readOnly && (
						<button
							type="button"
							className="sh-btn sh-btn-stop"
							onClick={() => client.sendAbort()}
							disabled={!live}
							title="stop the current turn"
						>
							<Square size={11} /> <span className="sh-btn-label">Stop</span>
						</button>
					)}
					<button
						type="button"
						className="sh-composer-send"
						onClick={() => void send()}
						disabled={!canSend}
						title="send (Enter)"
						aria-label="send prompt"
					>
						<ArrowUp size={14} />
					</button>
				</div>
			</div>
		</div>
	);
}
