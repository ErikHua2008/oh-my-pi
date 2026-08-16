import type { LocalFileReference } from "@oh-my-pi/pi-wire";
import { MANAGED_IMAGE_MAX_BYTES } from "@oh-my-pi/pi-wire";
import { ArrowUp, File, FileUp, Folder, ImagePlus, Pencil, Scissors, SendHorizontal, Square, X } from "lucide-react";
import type { ClipboardEvent, DragEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import { type DesktopBridge, desktopBridge as defaultDesktopBridge } from "../../lib/desktop-bridge";
import { shortenPath } from "../../lib/format";
import { ModelPicker } from "./ModelPicker";
import { ScreenshotAnnotator } from "./ScreenshotAnnotator";
import { ThinkingPicker } from "./ThinkingPicker";

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
	type: "image" | "document";
	preview?: string;
	editBlob?: Blob;
}

interface PendingAnnotation {
	image: Blob;
	replacePath?: string;
}

const IMAGE_EXTENSIONS = new Set(["bmp", "gif", "jpeg", "jpg", "png", "tif", "tiff", "webp"]);
const MAX_DRAFT_ATTACHMENTS = 32;

function isImagePath(path: string): boolean {
	const match = /\.([^.\\/]+)$/.exec(path);
	return match !== null && IMAGE_EXTENSIONS.has(match[1]?.toLocaleLowerCase() ?? "");
}

function localFileName(path: string): string {
	const withoutTrailingSeparators = path.replace(/[\\/]+$/, "");
	return withoutTrailingSeparators.split(/[\\/]/).pop() || path;
}

function comparableLocalPath(path: string): string {
	const normalized = path.replaceAll("\\", "/");
	return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLocaleLowerCase() : normalized;
}

function blobBase64(image: Blob): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const reader = new FileReader();
	reader.onerror = () => reject(new Error("unable to read clipboard image"));
	reader.onload = () => {
		const result = reader.result;
		if (typeof result !== "string") {
			reject(new Error("unable to read clipboard image"));
			return;
		}
		const comma = result.indexOf(",");
		if (comma < 0) {
			reject(new Error("invalid clipboard image"));
			return;
		}
		resolve(result.slice(comma + 1));
	};
	reader.readAsDataURL(image);
	return promise;
}

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
	const [attachmentHint, setAttachmentHint] = useState<string | null>(null);
	const [attachmentBusy, setAttachmentBusy] = useState(false);
	const [dragActive, setDragActive] = useState(false);
	const [screenshotPending, setScreenshotPending] = useState(false);
	const [annotation, setAnnotation] = useState<PendingAnnotation | null>(null);
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
	useEffect(() => {
		// Warm the local picker while the session snapshot is arriving. The
		// client deduplicates this with a click made before the reply arrives.
		if (snapshot.state !== null && snapshot.models === null) client.sendModelList();
	}, [client, snapshot.models, snapshot.state]);

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

	const addLocalPaths = useCallback((paths: readonly string[], requestedType?: "image" | "document"): void => {
		setLocalFiles(current => {
			const seen = new Set(current.map(file => comparableLocalPath(file.path)));
			const additions: DraftLocalFile[] = [];
			for (const path of paths) {
				if (current.length + additions.length >= MAX_DRAFT_ATTACHMENTS) break;
				const key = comparableLocalPath(path);
				if (seen.has(key)) continue;
				seen.add(key);
				additions.push({
					kind: "local-file",
					path,
					name: localFileName(path),
					available: true,
					type: requestedType === "image" || isImagePath(path) ? "image" : "document",
				});
			}
			return additions.length > 0 ? [...current, ...additions] : current;
		});
		setAttachmentError(null);
		setAttachmentHint(null);
	}, []);

	useEffect(
		() => desktop.subscribeDroppedFiles(paths => canPrompt && addLocalPaths(paths)),
		[addLocalPaths, canPrompt, desktop],
	);

	useEffect(() => {
		if (!screenshotPending) return;
		const timer = setTimeout(() => {
			setScreenshotPending(false);
			setAttachmentHint(current => (current?.startsWith("截图完成后") ? null : current));
		}, 120_000);
		return () => clearTimeout(timer);
	}, [screenshotPending]);

	const pickAttachments = useCallback(
		async (kind: "image" | "document"): Promise<void> => {
			setAttachmentBusy(true);
			setAttachmentError(null);
			setAttachmentHint(null);
			try {
				addLocalPaths(await desktop.pickAttachments(kind), kind);
			} catch {
				setAttachmentError("无法打开本机文件选择器。");
			} finally {
				setAttachmentBusy(false);
			}
		},
		[addLocalPaths, desktop],
	);

	const importManagedImage = useCallback(
		async (image: Blob, name: string, replacePath?: string): Promise<void> => {
			if (image.size > MANAGED_IMAGE_MAX_BYTES) {
				setAttachmentError(`剪贴板图片不能超过 ${MANAGED_IMAGE_MAX_BYTES / 1024 / 1024} MB。`);
				return;
			}
			if (!replacePath && localFiles.length >= MAX_DRAFT_ATTACHMENTS) {
				setAttachmentError(`一次最多引用 ${MAX_DRAFT_ATTACHMENTS} 个文件。`);
				return;
			}
			setAttachmentBusy(true);
			setAttachmentError(null);
			setAttachmentHint(null);
			try {
				const media = await client.importManagedImage(await blobBase64(image), image.type || "image/png", name);
				const preview = media.thumbnail
					? `data:${media.thumbnail.mimeType};base64,${media.thumbnail.data}`
					: undefined;
				setLocalFiles(current => {
					const withoutReplaced = replacePath ? current.filter(file => file.path !== replacePath) : current;
					if (withoutReplaced.length >= MAX_DRAFT_ATTACHMENTS) return withoutReplaced;
					if (
						withoutReplaced.some(file => comparableLocalPath(file.path) === comparableLocalPath(media.file.path))
					) {
						return withoutReplaced;
					}
					return [
						...withoutReplaced,
						{
							...media.file,
							available: true,
							type: "image",
							preview,
							editBlob: image,
						},
					];
				});
			} catch (error) {
				setAttachmentError(error instanceof Error ? error.message : "剪贴板图片保存失败。");
			} finally {
				setAttachmentBusy(false);
			}
		},
		[client, localFiles.length],
	);

	const startScreenshot = useCallback(async (): Promise<void> => {
		setAttachmentError(null);
		const started = await desktop.startScreenshot();
		if (!started) {
			setAttachmentError("Windows 截图工具不可用。");
			return;
		}
		setScreenshotPending(true);
		setAttachmentHint("截图完成后按 Ctrl+V 粘贴；粘贴后可画直线或箭头。");
	}, [desktop]);

	const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
		const item = Array.from(event.clipboardData.items).find(
			candidate => candidate.kind === "file" && candidate.type.startsWith("image/"),
		);
		const image = item?.getAsFile();
		if (!image) return;
		event.preventDefault();
		const name = image.name || `clipboard-${Date.now()}.png`;
		if (screenshotPending) {
			setScreenshotPending(false);
			setAttachmentHint(null);
			setAnnotation({ image });
			return;
		}
		void importManagedImage(image, name);
	};

	const onDrop = (event: DragEvent<HTMLDivElement>): void => {
		event.preventDefault();
		setDragActive(false);
		if (!canPrompt) return;
		const paths = Array.from(event.dataTransfer.files)
			.map(file => (file as File & { path?: string }).path)
			.filter((path): path is string => typeof path === "string" && path.length > 0);
		if (paths.length === 0) {
			setAttachmentError("无法取得拖入文件的源路径，请使用上方的图片或文档按钮选择。");
			return;
		}
		addLocalPaths(paths);
	};

	const removeAttachment = useCallback((path: string): void => {
		setLocalFiles(current => current.filter(file => file.path !== path));
		setAttachmentError(null);
		setAttachmentHint(null);
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
			setAttachmentHint(null);
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
		<>
			<div
				className={`sh-composer${dragActive ? " sh-composer-drag-active" : ""}`}
				onDragEnter={event => {
					if (event.dataTransfer.types.includes("Files")) setDragActive(true);
				}}
				onDragOver={event => {
					if (!event.dataTransfer.types.includes("Files")) return;
					event.preventDefault();
					event.dataTransfer.dropEffect = "link";
				}}
				onDragLeave={event => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
				}}
				onDrop={onDrop}
			>
				<div className="sh-composer-card">
					{desktop.localFilesAvailable && (
						<div className="sh-composer-tools" aria-label="附件工具">
							<button
								type="button"
								onClick={() => void startScreenshot()}
								disabled={!canPrompt || attachmentBusy}
								title="截图"
								aria-label="截图"
							>
								<Scissors size={18} aria-hidden="true" />
							</button>
							<button
								type="button"
								onClick={() => void pickAttachments("image")}
								disabled={!canPrompt || attachmentBusy}
								title="引用本机图片"
								aria-label="引用本机图片"
							>
								<ImagePlus size={18} aria-hidden="true" />
							</button>
							<button
								type="button"
								onClick={() => void pickAttachments("document")}
								disabled={!canPrompt || attachmentBusy}
								title="引用本机文档"
								aria-label="引用本机文档"
							>
								<FileUp size={18} aria-hidden="true" />
							</button>
							<span className="sh-composer-tools-label">可拖入文件 · Ctrl+V 粘贴图片</span>
						</div>
					)}
					{localFiles.length > 0 && (
						<div className="sh-composer-attachments" aria-label="local file references">
							{localFiles.map(file => (
								<div
									key={file.path}
									className={`sh-composer-attachment sh-composer-attachment-${file.type}${file.available ? "" : " sh-composer-attachment-missing"}`}
									title={file.path}
								>
									{file.preview ? (
										<img src={file.preview} alt="" draggable={false} />
									) : file.type === "image" ? (
										<ImagePlus size={15} aria-hidden="true" />
									) : (
										<File size={13} aria-hidden="true" />
									)}
									<span className="sh-composer-attachment-name">{file.name}</span>
									{!file.available && <span className="sh-composer-attachment-status">unavailable</span>}
									{file.editBlob && (
										<button
											type="button"
											onClick={() => {
												if (file.editBlob) setAnnotation({ image: file.editBlob, replacePath: file.path });
											}}
											title="标注图片"
											aria-label={`标注 ${file.name}`}
										>
											<Pencil size={12} aria-hidden="true" />
										</button>
									)}
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
					{attachmentHint && <div className="sh-composer-attachment-hint">{attachmentHint}</div>}
					<textarea
						ref={taRef}
						className="sh-composer-input"
						value={text}
						onChange={e => setText(e.target.value)}
						onKeyDown={onKeyDown}
						onPaste={onPaste}
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
						<Workspace cwd={snapshot.state?.cwd} />
						{thinkingLevels.length > 0 && configuredThinkingLevel && (
							<ThinkingPicker
								levels={thinkingLevels}
								value={configuredThinkingLevel}
								disabled={!canPrompt}
								desktop={desktop}
								onChange={level => client.sendThinkingChange(level)}
							/>
						)}
						<ModelPicker
							snapshot={snapshot}
							disabled={!canPrompt}
							desktop={desktop}
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
			{annotation && (
				<ScreenshotAnnotator
					image={annotation.image}
					onCancel={() => setAnnotation(null)}
					onComplete={image => {
						const replacePath = annotation.replacePath;
						setAnnotation(null);
						void importManagedImage(image, `annotation-${Date.now()}.png`, replacePath);
					}}
				/>
			)}
		</>
	);
}
