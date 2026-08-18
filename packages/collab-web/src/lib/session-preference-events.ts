const SESSION_PREFERENCES_REMOVED_EVENT = "omp-session-preferences-removed";

/** Notify every mounted sidebar that an archived session was permanently removed. */
export function notifySessionPreferencesRemoved(sessionId: string): void {
	window.dispatchEvent(new CustomEvent<string>(SESSION_PREFERENCES_REMOVED_EVENT, { detail: sessionId }));
}

export function onSessionPreferencesRemoved(listener: (sessionId: string) => void): () => void {
	const handle = (event: Event): void => {
		if (!(event instanceof CustomEvent) || typeof event.detail !== "string") return;
		listener(event.detail);
	};
	window.addEventListener(SESSION_PREFERENCES_REMOVED_EVENT, handle);
	return () => window.removeEventListener(SESSION_PREFERENCES_REMOVED_EVENT, handle);
}
