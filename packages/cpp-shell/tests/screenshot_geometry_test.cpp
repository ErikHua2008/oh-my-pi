#include "omp_shell/screenshot_geometry.h"

#include "test_harness.h"

namespace omp::shell::test {
namespace {

void RequireRect(const RECT& actual, LONG left, LONG top, LONG right, LONG bottom) {
	OMP_CHECK(actual.left == left);
	OMP_CHECK(actual.top == top);
	OMP_CHECK(actual.right == right);
	OMP_CHECK(actual.bottom == bottom);
}

} // namespace

OMP_TEST("screenshot selection normalizes reverse drags") {
	RequireRect(NormalizeScreenshotRect(POINT{500, 420}, POINT{120, 80}), 120, 80, 500, 420);
}

OMP_TEST("screenshot selection clamps to the virtual desktop") {
	RequireRect(ClampScreenshotRect(RECT{-2000, -500, 900, 1400}, RECT{-1920, 0, 1920, 1080}), -1920, 0, 980, 1080);
	RequireRect(ClampScreenshotRect(RECT{0, 0, 1, 1}, RECT{0, 0, 4, 3}, 8), 0, 0, 3, 3);
}

OMP_TEST("screenshot selection hit testing covers handles and interior") {
	constexpr RECT selection{100, 100, 700, 500};
	OMP_CHECK(HitTestScreenshotSelection(selection, POINT{100, 100}, 6) == ScreenshotResizeHandle::TopLeft);
	OMP_CHECK(HitTestScreenshotSelection(selection, POINT{400, 100}, 6) == ScreenshotResizeHandle::Top);
	OMP_CHECK(HitTestScreenshotSelection(selection, POINT{700, 100}, 6) == ScreenshotResizeHandle::TopRight);
	OMP_CHECK(HitTestScreenshotSelection(selection, POINT{700, 300}, 6) == ScreenshotResizeHandle::Right);
	OMP_CHECK(HitTestScreenshotSelection(selection, POINT{700, 500}, 6) == ScreenshotResizeHandle::BottomRight);
	OMP_CHECK(HitTestScreenshotSelection(selection, POINT{400, 500}, 6) == ScreenshotResizeHandle::Bottom);
	OMP_CHECK(HitTestScreenshotSelection(selection, POINT{100, 500}, 6) == ScreenshotResizeHandle::BottomLeft);
	OMP_CHECK(HitTestScreenshotSelection(selection, POINT{100, 300}, 6) == ScreenshotResizeHandle::Left);
	OMP_CHECK(HitTestScreenshotSelection(selection, POINT{300, 220}, 6) == ScreenshotResizeHandle::Move);
	OMP_CHECK(HitTestScreenshotSelection(selection, POINT{20, 20}, 6) == ScreenshotResizeHandle::None);
}

OMP_TEST("screenshot selection keeps a forgiving resize target outside the visible border") {
	constexpr RECT selection{100, 100, 700, 500};
	OMP_CHECK(HitTestScreenshotSelection(selection, POINT{711, 280}, 12) == ScreenshotResizeHandle::Right);
	OMP_CHECK(HitTestScreenshotSelection(selection, POINT{320, 89}, 12) == ScreenshotResizeHandle::Top);
	OMP_CHECK(HitTestScreenshotSelection(selection, POINT{711, 511}, 12) == ScreenshotResizeHandle::BottomRight);
}

OMP_TEST("screenshot selection movement stays on the virtual desktop") {
	constexpr RECT viewport{-1920, 0, 1920, 1080};
	RequireRect(MoveScreenshotRect(RECT{-100, 100, 500, 500}, POINT{-2500, 900}, viewport), -1920, 680, -1320, 1080);
}

OMP_TEST("screenshot selection resizing enforces a minimum size") {
	constexpr RECT viewport{0, 0, 1920, 1080};
	RequireRect(
		ResizeScreenshotRect(RECT{100, 100, 700, 500}, ScreenshotResizeHandle::TopLeft, POINT{698, 499}, viewport, 16),
		684,
		484,
		700,
		500);
	RequireRect(
		ResizeScreenshotRect(RECT{100, 100, 700, 500}, ScreenshotResizeHandle::Right, POINT{960, 300}, viewport, 16),
		100,
		100,
		960,
		500);
	RequireRect(
		ResizeScreenshotRect(RECT{100, 100, 700, 500}, ScreenshotResizeHandle::Bottom, POINT{300, 720}, viewport, 16),
		100,
		100,
		700,
		720);
}

OMP_TEST("screenshot toolbar flips above selections near the bottom edge") {
	RequireRect(PlaceScreenshotToolbar(RECT{100, 700, 900, 1030}, RECT{0, 0, 1920, 1080}, SIZE{420, 48}, 8),
		480,
		644,
		900,
		692);
}

} // namespace omp::shell::test
