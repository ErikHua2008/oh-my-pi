import { describe, expect, it } from "bun:test";
import { applyProjectHotwords, normalizeProjectHotwords } from "@oh-my-pi/pi-coding-agent/stt/hotwords";

describe("Chinese project hotwords", () => {
	it("repairs a close homophone only when the user supplied the intended project term", () => {
		expect(applyProjectHotwords("继续完善宇宙磨方的交互", ["宇宙魔方"])).toBe("继续完善宇宙魔方的交互");
		expect(applyProjectHotwords("请让后花的检查这个分支", ["霍华德"])).toBe("请让霍华德检查这个分支");
	});

	it("does not rewrite unrelated dictated text", () => {
		expect(applyProjectHotwords("今天讨论数据库迁移", ["宇宙魔方"])).toBe("今天讨论数据库迁移");
	});

	it("deduplicates, trims, bounds, and drops one-character correction terms", () => {
		expect(normalizeProjectHotwords([" 宇宙魔方 ", "宇宙魔方", "水", "Grimoire   Router"])).toEqual([
			"宇宙魔方",
			"Grimoire Router",
		]);
	});
});
