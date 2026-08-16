import type { RefObject } from "react";
import { useLayoutEffect } from "react";
import {
	type DesktopBridge,
	type DesktopNativeTranscriptOcclusion,
	desktopBridge as defaultDesktopBridge,
} from "../../lib/desktop-bridge";

interface CssBounds {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** Convert the popover's exact CSS border box to the physical-pixel hole used by the native HWND. */
export function nativeTranscriptOcclusionFromBounds(
	bounds: CssBounds,
	scale: number,
	viewportWidth: number,
	viewportHeight: number,
): DesktopNativeTranscriptOcclusion {
	const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
	const left = Math.floor(Math.max(0, Math.min(viewportWidth, bounds.left)) * safeScale);
	const top = Math.floor(Math.max(0, Math.min(viewportHeight, bounds.top)) * safeScale);
	const right = Math.ceil(Math.max(0, Math.min(viewportWidth, bounds.right)) * safeScale);
	const bottom = Math.ceil(Math.max(0, Math.min(viewportHeight, bounds.bottom)) * safeScale);
	return {
		x: left,
		y: top,
		width: Math.max(0, right - left),
		height: Math.max(0, bottom - top),
	};
}

/** Let a Web popover pass through the native transcript HWND without replacing the transcript renderer. */
export function useNativeTranscriptOcclusion(
	open: boolean,
	surfaceRef: RefObject<HTMLElement | null>,
	desktop: Pick<DesktopBridge, "setNativeTranscriptOcclusion"> = defaultDesktopBridge,
): void {
	useLayoutEffect(() => {
		if (!open) return;
		let frame = 0;
		let disposed = false;

		const publish = (): void => {
			if (disposed) return;
			const surface = surfaceRef.current;
			if (surface === null) return;
			const bounds = surface.getBoundingClientRect();
			const occlusion = nativeTranscriptOcclusionFromBounds(
				bounds,
				window.devicePixelRatio || 1,
				window.innerWidth,
				window.innerHeight,
			);
			void desktop.setNativeTranscriptOcclusion(occlusion);
		};
		const schedule = (): void => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(publish);
		};

		const observer = new ResizeObserver(schedule);
		if (surfaceRef.current !== null) observer.observe(surfaceRef.current);
		window.addEventListener("resize", schedule);
		window.visualViewport?.addEventListener("resize", schedule);
		publish();

		return () => {
			disposed = true;
			cancelAnimationFrame(frame);
			observer.disconnect();
			window.removeEventListener("resize", schedule);
			window.visualViewport?.removeEventListener("resize", schedule);
			void desktop.setNativeTranscriptOcclusion(null);
		};
	}, [desktop, open, surfaceRef]);
}
