import { describe, expect, it } from "bun:test";
import {
	blockNativeSurfaces,
	nativeSurfacesBlocked,
	subscribeNativeSurfaceVisibility,
} from "../src/lib/native-surface-visibility";

describe("native surface visibility", () => {
	it("keeps native child windows blocked until every overlay releases", () => {
		let notifications = 0;
		const unsubscribe = subscribeNativeSurfaceVisibility(() => notifications++);
		const releaseFirst = blockNativeSurfaces();
		const releaseSecond = blockNativeSurfaces();

		expect(nativeSurfacesBlocked()).toBe(true);
		releaseFirst();
		expect(nativeSurfacesBlocked()).toBe(true);
		releaseSecond();
		expect(nativeSurfacesBlocked()).toBe(false);
		releaseSecond();
		expect(notifications).toBe(4);
		unsubscribe();
	});
});
