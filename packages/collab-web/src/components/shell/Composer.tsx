import type { LocalFileReference } from "@oh-my-pi/pi-wire";
import { MANAGED_IMAGE_MAX_BYTES } from "@oh-my-pi/pi-wire";
import {
	ArrowUp,
	File,
	FileUp,
	Folder,
	ImagePlus,
	Mic,
	Pencil,
	Scissors,
	Search,
	SendHorizontal,
	Square,
	X,
} from "lucide-react";
import type { ClipboardEvent, KeyboardEvent, ReactNode, RefObject } from "react";
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
	/** Open the current conversation's chat-history search panel. */
	onOpenChatSearch?: () => void;
	/** Injectable native bridge; defaults to the process-wide WebView bridge. */
	desktop?: DesktopBridge;
}

/** Textarea metrics: line-height 20px + 8px vertical padding × 2 (kept in sync with composer.css). */
const LINE_PX = 20;
const PAD_Y = 16;
const COMPOSER_MIN_ROWS = 2;
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

function base64Blob(encoded: string, mimeType: string): Blob {
	const binary = atob(encoded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return new Blob([bytes], { type: mimeType });
}

function autosize(el: HTMLTextAreaElement | null, minimumRows = 1): void {
	if (!el) return;
	el.style.height = "0px";
	const min = Math.max(1, minimumRows) * LINE_PX + PAD_Y;
	const max = MAX_ROWS * LINE_PX + PAD_Y;
	el.style.height = `${Math.max(min, Math.min(el.scrollHeight, max))}px`;
	el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

export function mergeSpeechInput(base: string, utterance: string): string {
	if (!base || !utterance) return `${base}${utterance}`;
	return /\s$/.test(base) || /^\s/.test(utterance) ? `${base}${utterance}` : `${base} ${utterance}`;
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

/** Only the native shell can stat host paths; browser-managed media is already validated by Core. */
export function shouldCheckDraftAttachmentPaths(fileCount: number, localFilesAvailable: boolean): boolean {
	return fileCount > 0 && localFilesAvailable;
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
	onOpenChatSearch,
	desktop = defaultDesktopBridge,
}: ComposerProps): ReactNode {
	const [text, setText] = useState(prefill ?? "");
	const [localFiles, setLocalFiles] = useState<readonly DraftLocalFile[]>([]);
	const [attachmentError, setAttachmentError] = useState<string | null>(null);
	const [attachmentHint, setAttachmentHint] = useState<string | null>(null);
	const [attachmentBusy, setAttachmentBusy] = useState(false);
	const [annotation, setAnnotation] = useState<PendingAnnotation | null>(null);
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const speechBaseRef = useRef<string | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	const live = snapshot.phase === "live";
	const readOnly = snapshot.readOnly;
	const uiRequest = snapshot.uiRequest;
	const canPrompt = live && !readOnly;
	const busy = snapshot.working;
	const speechActive = snapshot.speech.state !== "idle";
	const queued = snapshot.state?.queuedMessageCount ?? 0;
	const canSend =
		canPrompt &&
		!attachmentBusy &&
		!speechActive &&
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
		autosize(taRef.current, COMPOSER_MIN_ROWS);
	}, [text, uiRequest?.reqId]);

	useEffect(() => {
		if (prefill === undefined) return;
		setText(prefill);
		requestAnimationFrame(() => {
			taRef.current?.focus();
			taRef.current?.setSelectionRange(prefill.length, prefill.length);
		});
	}, [prefill]);

	useEffect(() => {
		if (speechBaseRef.current === null) return;
		setText(mergeSpeechInput(speechBaseRef.current, snapshot.speech.text));
		if (snapshot.speech.state === "idle" && snapshot.speech.final) {
			speechBaseRef.current = null;
			requestAnimationFrame(() => taRef.current?.focus());
		}
	}, [snapshot.speech]);

	useEffect(
		() => () => {
			if (client.getSnapshot().speech.state !== "idle") client.cancelSpeechInput();
			speechBaseRef.current = null;
		},
		[client],
	);

	const toggleSpeechInput = useCallback((): void => {
		if (speechActive) {
			client.stopSpeechInput();
			return;
		}
		if (!canPrompt || attachmentBusy) return;
		speechBaseRef.current = text;
		setAttachmentError(null);
		setAttachmentHint(null);
		client.startSpeechInput();
	}, [attachmentBusy, canPrompt, client, speechActive, text]);

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
		() => desktop.subscribeDroppedFiles(paths => canPrompt && !speechActive && addLocalPaths(paths)),
		[addLocalPaths, canPrompt, desktop, speechActive],
	);

	const pickAttachments = useCallback(
		async (kind: "image" | "document"): Promise<void> => {
			if (!canPrompt || attachmentBusy || speechActive) return;
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
		[addLocalPaths, attachmentBusy, canPrompt, desktop, speechActive],
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
		if (!canPrompt || attachmentBusy || speechActive) return;
		setAttachmentBusy(true);
		setAttachmentError(null);
		setAttachmentHint(null);
		try {
			const capture = await desktop.startScreenshot();
			if (!capture) return;
			setAttachmentBusy(false);
			await importManagedImage(base64Blob(capture.data, capture.mimeType), capture.name);
			if (!capture.clipboardWritten) setAttachmentHint("截图已加入输入框，但系统剪贴板暂时被其他程序占用。");
		} catch (error) {
			setAttachmentError(error instanceof Error ? error.message : "截图失败。");
		} finally {
			setAttachmentBusy(false);
		}
	}, [attachmentBusy, canPrompt, desktop, importManagedImage, speechActive]);

	const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
		if (speechActive) return;
		const item = Array.from(event.clipboardData.items).find(
			candidate => candidate.kind === "file" && candidate.type.startsWith("image/"),
		);
		const image = item?.getAsFile();
		if (!image) return;
		event.preventDefault();
		const name = image.name || `clipboard-${Date.now()}.png`;
		void importManagedImage(image, name);
	};

	const receiveDroppedFiles = useCallback(
		(dataTransfer: DataTransfer): void => {
			if (!canPrompt || speechActive) return;
			const paths = Array.from(dataTransfer.files)
				.map(file => (file as File & { path?: string }).path)
				.filter((path): path is string => typeof path === "string" && path.length > 0);
			if (paths.length === 0 && !desktop.localFilesAvailable) {
				setAttachmentError("无法取得拖入文件的源路径，请使用上方的图片或文档按钮选择。");
				return;
			}
			addLocalPaths(paths);
		},
		[addLocalPaths, canPrompt, desktop.localFilesAvailable, speechActive],
	);

	useEffect(() => {
		const app = taRef.current?.closest<HTMLElement>(".sh-app");
		if (!app) return;
		let dragDepth = 0;

		const isFileDrag = (event: globalThis.DragEvent): boolean => event.dataTransfer?.types.includes("Files") === true;
		const isDropSurface = (target: EventTarget | null): boolean => {
			if (!(target instanceof Element)) return false;
			if (target.closest(".sh-app") !== app) return false;
			return (
				target.closest(
					".sh-header-bar, .sh-rail, .sh-rail-backdrop, .sh-settings-backdrop, .sh-shot-backdrop, .ag-drawer, .ag-drawer-backdrop",
				) === null
			);
		};
		const showDropSurface = (active: boolean): void => {
			app.classList.toggle("sh-session-drag-active", active);
		};
		const deactivate = (): void => {
			dragDepth = 0;
			showDropSurface(false);
		};
		const onDragEnter = (event: globalThis.DragEvent): void => {
			if (!isFileDrag(event)) return;
			dragDepth += 1;
			showDropSurface(canPrompt && !speechActive && isDropSurface(event.target));
		};
		const onDragOver = (event: globalThis.DragEvent): void => {
			if (!isFileDrag(event)) return;
			const accepted = canPrompt && !speechActive && isDropSurface(event.target);
			showDropSurface(accepted);
			if (!isDropSurface(event.target)) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = accepted ? "link" : "none";
		};
		const onDragLeave = (event: globalThis.DragEvent): void => {
			if (!isFileDrag(event)) return;
			dragDepth = Math.max(0, dragDepth - 1);
			if (dragDepth === 0) showDropSurface(false);
		};
		const onDrop = (event: globalThis.DragEvent): void => {
			if (!isFileDrag(event)) return;
			// A drop ends the browser drag session even when it lands on an excluded
			// header/rail surface. Reset the depth unconditionally so the next OS drag
			// cannot inherit a stale counter and leave the overlay stuck on screen.
			deactivate();
			if (!isDropSurface(event.target)) return;
			event.preventDefault();
			if (event.dataTransfer) receiveDroppedFiles(event.dataTransfer);
		};

		app.addEventListener("dragenter", onDragEnter);
		app.addEventListener("dragover", onDragOver);
		app.addEventListener("dragleave", onDragLeave);
		app.addEventListener("drop", onDrop);
		return () => {
			deactivate();
			app.removeEventListener("dragenter", onDragEnter);
			app.removeEventListener("dragover", onDragOver);
			app.removeEventListener("dragleave", onDragLeave);
			app.removeEventListener("drop", onDrop);
		};
	}, [canPrompt, receiveDroppedFiles, speechActive]);

	const removeAttachment = useCallback((path: string): void => {
		setLocalFiles(current => current.filter(file => file.path !== path));
		setAttachmentError(null);
		setAttachmentHint(null);
	}, []);

	const send = useCallback(async (): Promise<void> => {
		const trimmed = text.trim();
		if ((!trimmed && localFiles.length === 0) || !live || readOnly || attachmentBusy || speechActive) return;
		setAttachmentBusy(true);
		setAttachmentError(null);
		try {
			// Native file references live on the same machine as the C++ shell and
			// can be checked immediately before send. In a browser, however, pasted
			// images have already been persisted by Core and the returned path is a
			// host path; asking the browser fallback to stat it yields an empty result
			// and used to mark every managed image as missing.
			if (shouldCheckDraftAttachmentPaths(localFiles.length, desktop.localFilesAvailable)) {
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
	}, [attachmentBusy, client, desktop, live, localFiles, onPrefillConsumed, readOnly, speechActive, text]);

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
			<div className="sh-composer">
				<div className="sh-composer-card">
					{(desktop.localFilesAvailable || desktop.speechInputAvailable || onOpenChatSearch !== undefined) && (
						<div className="sh-composer-tools" aria-label="输入工具">
							{desktop.localFilesAvailable && (
								<button
									type="button"
									onClick={() => void startScreenshot()}
									disabled={!canPrompt || attachmentBusy || speechActive}
									title="截图"
									aria-label="截图"
								>
									<Scissors size={18} aria-hidden="true" />
								</button>
							)}
							{desktop.localFilesAvailable && (
								<button
									type="button"
									onClick={() => void pickAttachments("image")}
									disabled={!canPrompt || attachmentBusy || speechActive}
									title="引用本机图片"
									aria-label="引用本机图片"
								>
									<ImagePlus size={18} aria-hidden="true" />
								</button>
							)}
							{desktop.localFilesAvailable && (
								<button
									type="button"
									onClick={() => void pickAttachments("document")}
									disabled={!canPrompt || attachmentBusy || speechActive}
									title="引用本机文档"
									aria-label="引用本机文档"
								>
									<FileUp size={18} aria-hidden="true" />
								</button>
							)}
							{desktop.speechInputAvailable && (
								<button
									type="button"
									className={speechActive ? "sh-composer-mic sh-composer-mic-on" : "sh-composer-mic"}
									onClick={toggleSpeechInput}
									disabled={!speechActive && (!canPrompt || attachmentBusy)}
									title={speechActive ? "结束语音录入" : "语音录入"}
									aria-label={speechActive ? "结束语音录入" : "开始语音录入"}
								>
									<Mic size={18} aria-hidden="true" />
								</button>
							)}
							{onOpenChatSearch !== undefined && (
								<button type="button" onClick={onOpenChatSearch} title="查找聊天记录" aria-label="查找聊天记录">
									<Search size={18} aria-hidden="true" />
								</button>
							)}
							<span className="sh-composer-tools-label">
								{speechActive
									? (snapshot.speech.status ?? "正在听…")
									: desktop.localFilesAvailable
										? "可拖入文件 · Ctrl+V 粘贴图片"
										: "点击麦克风开始语音录入"}
							</span>
						</div>
					)}
					{localFiles.length > 0 && (
						<div className="sh-composer-attachments" aria-label="local file references">
							{localFiles.map(file => (
								<div
									key={file.path}
									className={`sh-composer-attachment sh-composer-attachment-${file.type}${file.preview ? " sh-composer-attachment-preview" : ""}${file.available ? "" : " sh-composer-attachment-missing"}`}
									title={file.path}
								>
									{file.preview ? (
										<img src={file.preview} alt="" draggable={false} />
									) : file.type === "image" ? (
										<ImagePlus size={15} aria-hidden="true" />
									) : (
										<File size={13} aria-hidden="true" />
									)}
									{!file.preview && <span className="sh-composer-attachment-name">{file.name}</span>}
									{!file.available && <span className="sh-composer-attachment-status">unavailable</span>}
									{file.editBlob && (
										<button
											type="button"
											onClick={() => {
												if (file.editBlob) setAnnotation({ image: file.editBlob, replacePath: file.path });
											}}
											className="sh-composer-attachment-edit"
											title="标注图片"
											aria-label={`标注 ${file.name}`}
										>
											<Pencil size={12} aria-hidden="true" />
										</button>
									)}
									<button
										type="button"
										onClick={() => removeAttachment(file.path)}
										className="sh-composer-attachment-remove"
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
						readOnly={speechActive}
						placeholder={
							readOnly
								? "read-only session — watching only"
								: speechActive
									? (snapshot.speech.status ?? "正在听…")
									: live
										? "prompt the host agent…"
										: "waiting for session…"
						}
						disabled={!canPrompt}
						rows={COMPOSER_MIN_ROWS}
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
