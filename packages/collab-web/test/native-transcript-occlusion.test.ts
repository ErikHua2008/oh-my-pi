import { describe, expect, it } from "bun:test";
import {
	NativeTranscriptOcclusionSet,
	nativeTranscriptOcclusionFromBounds,
} from "../src/components/shell/useNativeTranscriptOcclusion";

describe("native transcript popover occlusion", () => {
	it("matches the popover border box without adding a shadow margin", () => {
		expect(
			nativeTranscriptOcclusionFromBounds({ left: 100, top: 200, right: 340, bottom: 520 }, 2, 800, 600),
		).toEqual({ x: 200, y: 400, width: 480, height: 640 });
	});

	it("clips to the viewport and only rounds outward to physical pixels", () => {
		expect(
			nativeTranscriptOcclusionFromBounds({ left: -8, top: 20.25, right: 300.4, bottom: 420 }, 1.5, 280, 400),
		).toEqual({ x: 0, y: 30, width: 420, height: 570 });
	});

	it("keeps simultaneous toast, search, and menu holes instead of replacing the previous overlay", () => {
		const regions = new NativeTranscriptOcclusionSet();
		const toast = Symbol("toast");
		const search = Symbol("search");
		const toastBounds = { x: 600, y: 16, width: 320, height: 56 };
		const searchBounds = { x: 700, y: 80, width: 280, height: 600 };

		expect(regions.update(toast, toastBounds)).toEqual([toastBounds]);
		expect(regions.update(search, searchBounds)).toEqual([toastBounds, searchBounds]);
		expect(regions.update(toast, null)).toEqual([searchBounds]);
		expect(regions.update(search, null)).toEqual([]);
		expect(regions.empty).toBe(true);
	});
});
