export interface TimeoutSignalGuard {
	readonly signal: AbortSignal;
	clear(): void;
	[Symbol.dispose](): void;
}

/**
 * Arm a scoped timeout signal that stays live while an otherwise-pending I/O
 * promise is the only work left. AbortSignal.timeout() can fail to wake that
 * case on Bun/Windows; the explicit timer is cleared by the caller's `using`
 * scope as soon as the request settles.
 */
export function armTimeoutSignal(timeoutMs: number, signal?: AbortSignal): TimeoutSignalGuard {
	const controller = new AbortController();
	const reason = new DOMException("The operation timed out.", "TimeoutError");
	const timer = setTimeout(() => controller.abort(reason), Math.max(0, timeoutMs));
	const clear = () => clearTimeout(timer);
	return {
		signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
		clear,
		[Symbol.dispose]: clear,
	};
}

/** Detect a timeout raised by an abortable fetch. */
export function isTimeoutError(error: unknown): boolean {
	return error instanceof Error && error.name === "TimeoutError";
}
