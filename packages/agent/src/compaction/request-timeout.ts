export interface RequestTimeoutGuard {
	readonly signal: AbortSignal | undefined;
	clear(): void;
	[Symbol.dispose](): void;
}

/**
 * Arm a request watchdog that remains live even when the request promise is the
 * only outstanding work. AbortSignal.timeout() can fail to wake that case on
 * Bun/Windows, so remote compaction uses an explicit, scoped timer.
 */
export function armRequestTimeout(signal: AbortSignal | undefined, timeoutMs: number): RequestTimeoutGuard {
	if (timeoutMs <= 0) {
		return { signal, clear() {}, [Symbol.dispose]() {} };
	}

	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
	}, timeoutMs);
	const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	const clear = () => clearTimeout(timer);
	return { signal: requestSignal, clear, [Symbol.dispose]: clear };
}
