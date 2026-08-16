type Listener = () => void;

let blockerCount = 0;
const listeners = new Set<Listener>();

function publish(): void {
	for (const listener of listeners) listener();
}

/** Hide native child surfaces while a WebView overlay must occupy their area. */
export function blockNativeSurfaces(): () => void {
	blockerCount++;
	publish();
	let released = false;
	return () => {
		if (released) return;
		released = true;
		blockerCount = Math.max(0, blockerCount - 1);
		publish();
	};
}

export function nativeSurfacesBlocked(): boolean {
	return blockerCount > 0;
}

export function subscribeNativeSurfaceVisibility(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
