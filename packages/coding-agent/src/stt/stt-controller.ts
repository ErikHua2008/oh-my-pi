import { AudioCapture } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import { type SttStreamHandle, sttClient } from "./asr-client";
import { downloadSttModel, isSttModelCached } from "./downloader";
import { resolveSttModelSpec, type SttModelKey } from "./models";
import { evaluateSubmitTrigger, type SttSubmitTrigger } from "./submit-trigger";

export type SttState = "idle" | "recording" | "transcribing";

export interface SttToggleOptions {
	showWarning(msg: string): void;
	showStatus(msg: string): void;
	onStateChange(state: SttState): void;
	/** Force a redraw after async edits to the composer (live segment/preview inserts). */
	requestRender?(): void;
	/** Optional desktop/client override without mutating the user's persisted TUI settings. */
	modelName?: string;
	language?: string;
	submitTrigger?: SttSubmitTrigger;
}

/** The slice of the composer editor the controller drives. */
export interface SttEditor {
	insertText(text: string): void;
	setVolatileText(text: string): void;
	clearVolatileText(): void;
	commitVolatileText(text: string): void;
	submit(): void;
	deleteBeforeCursor(count: number): void;
}

interface CaptureHandle {
	stop(): void;
}

type CaptureFactory = (onAudio: (error: Error | null, samples: Float32Array) => void) => CaptureHandle;

/** Coordinates native microphone capture with incremental local transcription. */
export class STTController {
	#state: SttState = "idle";
	#resolvedModelKey: string | null = null;
	#toggling = false;
	#stopAfterStart = false;
	#cancelAfterStart = false;
	#disposed = false;
	#preflightAbort: AbortController | null = null;
	readonly #createCapture: CaptureFactory;

	// Live streaming capture.
	#stream: SttStreamHandle | null = null;
	#streamRecorder: CaptureHandle | null = null;
	#streamAcceptingAudio = false;
	#streamEditor: SttEditor | null = null;
	#streamAbort: AbortController | null = null;
	#streamUtterance = "";
	#streamPreviewSegments: string[] = [];
	#streamPreview = "";
	#streamAudio: Float32Array[] = [];
	#streamAudioSamples = 0;
	#streamModelKey: SttModelKey | null = null;
	#streamLanguage: string | undefined;

	/** Creates a controller; tests may replace the hardware capture boundary. */
	constructor(createCapture: CaptureFactory = onAudio => new AudioCapture(16_000, onAudio)) {
		this.#createCapture = createCapture;
	}

	get state(): SttState {
		return this.#state;
	}

	#setState(state: SttState, options: SttToggleOptions): void {
		this.#state = state;
		options.onStateChange(state);
	}

	async toggle(editor: SttEditor, options: SttToggleOptions): Promise<void> {
		if (this.#toggling) {
			if (this.#state === "idle") this.cancel(options);
			else if (this.#state === "recording") this.#stopAfterStart = true;
			return;
		}
		this.#toggling = true;
		try {
			switch (this.#state) {
				case "idle":
					await this.#start(editor, options);
					break;
				case "recording":
					await this.#stop(options);
					break;
				case "transcribing":
					options.showStatus("Transcription in progress...");
					break;
			}
			if (this.#cancelAfterStart) {
				this.#cancelAfterStart = false;
				this.#stopAfterStart = false;
				this.#cancelActive(options);
			} else if (this.#stopAfterStart && this.#state === "recording") {
				this.#stopAfterStart = false;
				await this.#stop(options);
			} else if (this.#state !== "recording") {
				this.#stopAfterStart = false;
			}
		} finally {
			this.#toggling = false;
		}
	}

	/** Cancel the active utterance without flushing or submitting it; the controller remains reusable. */
	cancel(options: SttToggleOptions): void {
		if (this.#toggling) {
			this.#cancelAfterStart = true;
			this.#stopAfterStart = false;
			// First-use model setup can take a while. Detach from the download so the
			// UI/host microphone lease is released as soon as the aborted preflight
			// unwinds, rather than waiting for the model load itself to finish.
			if (this.#state === "idle") {
				this.#preflightAbort?.abort();
			} else if (this.#state === "transcribing") {
				this.#streamAbort?.abort();
			}
			return;
		}
		this.#cancelActive(options);
	}

	#cancelActive(options: SttToggleOptions): void {
		this.#stopAfterStart = false;
		this.#streamAcceptingAudio = false;
		this.#streamAbort?.abort();
		this.#streamAbort = null;
		this.#stream?.cancel();
		try {
			this.#streamRecorder?.stop();
		} catch {
			// best-effort microphone cleanup
		}
		this.#streamEditor?.clearVolatileText();
		this.#cleanupStream();
		this.#setState("idle", options);
	}

	async #ensureDeps(options: SttToggleOptions): Promise<boolean> {
		const modelKey = resolveSttModelSpec(
			options.modelName ?? (settings.get("stt.modelName") as string | undefined),
		).key;
		// Keyed on the model rather than a one-shot flag: switching stt.modelName
		// mid-session must re-run preflight so an uncached new tier downloads here
		// (with progress) instead of blocking silently at stop.
		if (this.#resolvedModelKey === modelKey) return true;
		const preflightAbort = new AbortController();
		this.#preflightAbort = preflightAbort;
		try {
			// Only clear the status line when preflight emitted progress; the
			// cached-model fast path emits nothing.
			let wroteStatus = false;
			const status = (msg: string): void => {
				wroteStatus = true;
				options.showStatus(msg);
			};
			// Loading the multi-hundred-MB speech model into the worker is what made
			// the old "Checking STT dependencies…" step slow. Don't pay it before
			// recording: when the weights are already cached, start now and warm the
			// model in the background — the stream/transcribe paths load it on demand
			// (memoized in the worker) and it is hot by the time recording stops.
			// Only a genuine first-use download blocks, with explicit progress, so we
			// never record silently against missing weights.
			if (await isSttModelCached(modelKey)) {
				if (preflightAbort.signal.aborted) return false;
				this.#warmModel(modelKey);
			} else {
				await downloadSttModel(modelKey, p => status(`Downloading speech model ${p.label} (${p.percent}%)`), {
					signal: preflightAbort.signal,
				});
			}
			if (preflightAbort.signal.aborted) return false;
			if (wroteStatus) options.showStatus("");
			this.#resolvedModelKey = modelKey;
			return true;
		} catch (err) {
			if (preflightAbort.signal.aborted) return false;
			const msg = err instanceof Error ? err.message : "Failed to setup STT dependencies";
			options.showWarning(msg);
			logger.error("STT dependency setup failed", { error: msg });
			return false;
		} finally {
			if (this.#preflightAbort === preflightAbort) this.#preflightAbort = null;
		}
	}

	/** Warm the speech model in the worker without blocking recording. The worker
	 *  memoizes the load, so the stream/transcribe path reuses it and the model is
	 *  hot by the time recording stops. Only called when the weights are already
	 *  cached, so no network fetch happens. On load failure (corrupt cache, OOM,
	 *  runtime install) invalidate the resolved key so the next toggle re-runs
	 *  preflight and retries instead of skipping it forever. */
	#warmModel(modelKey: string): void {
		void downloadSttModel(modelKey).catch(err => {
			// Guard against a concurrent model switch clobbering a newer resolution.
			if (!this.#disposed && this.#resolvedModelKey === modelKey) this.#resolvedModelKey = null;
			logger.debug("stt: background model warmup failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	async #start(editor: SttEditor, options: SttToggleOptions): Promise<void> {
		// Cancellation can arrive while the first-use model download is still in
		// flight. Do not briefly open the microphone after that download finishes;
		// toggle() will consume #cancelAfterStart and publish the terminal idle state.
		if (!(await this.#ensureDeps(options)) || this.#disposed || this.#cancelAfterStart) return;
		await this.#startStreaming(editor, options);
	}

	async #stop(options: SttToggleOptions): Promise<void> {
		await this.#stopStreaming(options);
	}

	// ── Live streaming ──────────────────────────────────────────────

	#normalized(text: string): string {
		return text.replace(/\s+/g, " ").trim();
	}

	#previewText(partial = ""): string {
		return [...this.#streamPreviewSegments, this.#normalized(partial)].filter(Boolean).join(" ");
	}

	#capturedAudio(): Float32Array {
		const audio = new Float32Array(this.#streamAudioSamples);
		let offset = 0;
		for (const chunk of this.#streamAudio) {
			audio.set(chunk, offset);
			offset += chunk.length;
		}
		return audio;
	}

	async #startStreaming(editor: SttEditor, options: SttToggleOptions): Promise<void> {
		const modelKey = resolveSttModelSpec(
			options.modelName ?? (settings.get("stt.modelName") as string | undefined),
		).key;
		const language = options.language ?? (settings.get("stt.language") as string | undefined);
		this.#streamEditor = editor;
		this.#streamUtterance = "";
		this.#streamPreviewSegments = [];
		this.#streamPreview = "";
		this.#streamAudio = [];
		this.#streamAudioSamples = 0;
		this.#streamModelKey = modelKey;
		this.#streamLanguage = language || undefined;
		this.#streamAbort = new AbortController();
		const stream = sttClient.startStream(modelKey, {
			language: language || undefined,
			signal: this.#streamAbort.signal,
			onPartial: text => {
				if (this.#disposed || this.#state !== "recording") return;
				this.#streamPreview = this.#previewText(text);
				this.#streamEditor?.setVolatileText(this.#streamPreview);
				options.requestRender?.();
			},
			onSegment: text => {
				if (this.#disposed) return;
				const normalized = this.#normalized(text);
				if (normalized) this.#streamPreviewSegments.push(normalized);
				this.#streamPreview = this.#previewText();
				this.#streamEditor?.setVolatileText(this.#streamPreview);
				options.requestRender?.();
			},
			onError: error => {
				// During stop(), #stopStreaming owns error reporting and final cleanup.
				// While actively recording, fail immediately so a broken/OOM model does
				// not leave the microphone and UI stuck until the user clicks Stop.
				if (
					this.#disposed ||
					this.#stream !== stream ||
					(this.#state !== "recording" && !this.#streamAcceptingAudio)
				)
					return;
				this.#failActiveStream(stream, options, error);
			},
		});
		this.#stream = stream;
		let recorder: CaptureHandle;
		this.#streamAcceptingAudio = true;
		try {
			recorder = this.#createCapture((error, samples) => {
				if (this.#disposed || this.#stream !== stream || !this.#streamAcceptingAudio) return;
				if (error) {
					logger.error("Native microphone capture failed", { error: error.message });
					this.#failActiveStream(stream, options, error);
					return;
				}
				// AudioCapture may reuse its callback buffer. Keep an owned copy for
				// the high-quality whole-utterance decode performed after Stop.
				const captured = samples.slice();
				this.#streamAudio.push(captured);
				this.#streamAudioSamples += captured.length;
				stream.pushAudio(samples);
			});
		} catch (err) {
			this.#streamAcceptingAudio = false;
			stream.cancel();
			this.#cleanupStream();
			const msg = err instanceof Error ? err.message : "Failed to start microphone capture";
			options.showWarning(msg);
			logger.error("STT recording failed to start", { error: msg });
			return;
		}
		// A native callback or worker failure may fire synchronously while the
		// capture object is being constructed. Do not resurrect that failed stream.
		if (this.#disposed || this.#stream !== stream) {
			this.#streamAcceptingAudio = false;
			try {
				recorder.stop();
			} catch {
				// #failActiveStream already reported the original failure.
			}
			return;
		}
		this.#streamRecorder = recorder;
		this.#setState("recording", options);
		logger.debug("STT live recording started", { modelKey });
	}

	#failActiveStream(stream: SttStreamHandle, options: SttToggleOptions, error: Error): void {
		if (this.#stream !== stream) return;
		this.#streamAcceptingAudio = false;
		const activeRecorder = this.#streamRecorder;
		this.#streamRecorder = null;
		try {
			activeRecorder?.stop();
		} catch (cause) {
			logger.debug("stt: microphone cleanup failed", {
				error: cause instanceof Error ? cause.message : String(cause),
			});
		}
		this.#streamAbort?.abort(error);
		stream.cancel();
		this.#streamEditor?.clearVolatileText();
		options.requestRender?.();
		this.#cleanupStream();
		this.#setState("idle", options);
		options.showWarning(error.message);
	}

	async #stopStreaming(options: SttToggleOptions): Promise<void> {
		const stream = this.#stream;
		const recorder = this.#streamRecorder;
		if (!stream) {
			this.#setState("idle", options);
			return;
		}
		// Stop the mic first so no further audio is fed, then start the final decode.
		try {
			recorder?.stop();
		} catch (err) {
			logger.debug("stt: streaming recorder stop failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		this.#streamAcceptingAudio = false;
		this.#streamRecorder = null;
		this.#setState("transcribing", options);

		let failed = false;
		let finalText = "";
		try {
			// Segmented live decoding is useful as a preview, but its independent
			// short windows lose Chinese context and can split a word at a hard
			// endpoint. Cancel that provisional stream and decode the owned complete
			// waveform once, using Whisper's overlapping long-form windows.
			stream.cancel();
			const audio = this.#capturedAudio();
			if (audio.length > 0 && this.#streamModelKey) {
				finalText = this.#normalized(
					await sttClient.transcribe(this.#streamModelKey, audio, {
						language: this.#streamLanguage,
						signal: this.#streamAbort?.signal,
					}),
				);
			}
		} catch (err) {
			failed = true;
			if (this.#cancelAfterStart || this.#disposed) {
				this.#streamEditor?.clearVolatileText();
				this.#cleanupStream();
				return;
			}
			if (!this.#disposed) {
				const msg = err instanceof Error ? err.message : "Transcription failed";
				options.showWarning(msg);
				logger.error("STT live transcription failed", { error: msg });
			}
		}
		if (this.#disposed) {
			this.#cleanupStream();
			return;
		}
		const acceptedText = finalText || (failed ? this.#streamPreview : "");
		this.#streamEditor?.clearVolatileText();
		if (acceptedText) this.#streamEditor?.commitVolatileText(acceptedText);
		this.#streamUtterance = acceptedText;
		options.requestRender?.();
		if (!failed) options.showStatus(acceptedText ? "" : "No speech detected.");

		if (acceptedText && !failed && this.#streamEditor) {
			const trigger = options.submitTrigger ?? settings.get("stt.submitTrigger");
			const { submit, trimTrailing } = evaluateSubmitTrigger(this.#streamUtterance, trigger);
			if (trimTrailing > 0) {
				this.#streamEditor.deleteBeforeCursor(trimTrailing);
			}
			if (submit) {
				this.#streamEditor.submit();
			}
		}

		this.#cleanupStream();
		this.#setState("idle", options);
	}

	#cleanupStream(): void {
		this.#stream = null;
		this.#streamRecorder = null;
		this.#streamAcceptingAudio = false;
		this.#streamEditor = null;
		this.#streamAbort = null;
		this.#streamUtterance = "";
		this.#streamPreviewSegments = [];
		this.#streamPreview = "";
		this.#streamAudio = [];
		this.#streamAudioSamples = 0;
		this.#streamModelKey = null;
		this.#streamLanguage = undefined;
	}

	dispose(): void {
		this.#disposed = true;
		this.#preflightAbort?.abort();
		this.#preflightAbort = null;
		if (this.#streamAbort) {
			this.#streamAbort.abort();
			this.#streamAbort = null;
		}
		this.#stream?.cancel();
		try {
			this.#streamRecorder?.stop();
		} catch {
			// best effort cleanup
		}
		this.#cleanupStream();
		this.#state = "idle";
		this.#cancelAfterStart = false;
		this.#resolvedModelKey = null;
	}
}
