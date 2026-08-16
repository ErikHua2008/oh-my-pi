import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Toasts } from "../src/components/shell/Toasts";
import type { Notice } from "../src/lib/client";

function notice(id: number, level: Notice["level"], message: string): Notice {
	return { id, level, message, at: Date.now() };
}

describe("Toasts", () => {
	it("shows only the newest transient notice in the non-blocking center layer", () => {
		const html = renderToStaticMarkup(
			<Toasts notices={[notice(1, "info", "older info"), notice(2, "warning", "new warning")]} />,
		);

		expect(html).toContain('class="sh-toasts-transient"');
		expect(html).toContain("new warning");
		expect(html).not.toContain("older info");
		expect(html).not.toContain("sh-toast-close");
	});

	it("keeps errors separate from transient notices and gives errors a dismiss control", () => {
		const html = renderToStaticMarkup(
			<Toasts notices={[notice(1, "error", "model failed"), notice(2, "info", "guest joined")]} />,
		);

		expect(html).toContain('class="sh-toasts-transient"');
		expect(html).toContain('class="sh-toasts-errors"');
		expect(html).toContain("guest joined");
		expect(html).toContain("model failed");
		expect(html).toContain('aria-label="Dismiss notification"');
	});

	it("limits persistent errors to the newest three", () => {
		const html = renderToStaticMarkup(
			<Toasts
				notices={[
					notice(1, "error", "first error"),
					notice(2, "error", "second error"),
					notice(3, "error", "third error"),
					notice(4, "error", "fourth error"),
				]}
			/>,
		);

		expect(html).not.toContain("first error");
		expect(html).toContain("second error");
		expect(html).toContain("third error");
		expect(html).toContain("fourth error");
	});
});
