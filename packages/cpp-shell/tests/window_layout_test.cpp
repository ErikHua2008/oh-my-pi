#include "omp_shell/window_layout.h"

#include "test_harness.h"

namespace omp::shell::test {
namespace {

void RequireBounds(const RECT& actual, LONG left, LONG top, LONG right, LONG bottom) {
	OMP_CHECK(actual.left == left);
	OMP_CHECK(actual.top == top);
	OMP_CHECK(actual.right == right);
	OMP_CHECK(actual.bottom == bottom);
}

} // namespace

OMP_TEST("window layout expands to the right when space is available") {
	RequireBounds(ExpandWindowBoundsForRail(RECT{100, 80, 1212, 900}, RECT{0, 0, 1920, 1040}, 288),
		100,
		80,
		1500,
		900);
}

OMP_TEST("window layout shifts left to keep the Agent rail on screen") {
	RequireBounds(ExpandWindowBoundsForRail(RECT{808, 80, 1920, 900}, RECT{0, 0, 1920, 1040}, 288),
		520,
		80,
		1920,
		900);
}

OMP_TEST("window layout caps expansion to the monitor work area") {
	RequireBounds(ExpandWindowBoundsForRail(RECT{100, 40, 1212, 760}, RECT{0, 0, 1366, 768}, 288),
		0,
		40,
		1366,
		760);
}

OMP_TEST("frameless resize hit testing preserves every edge and corner") {
	constexpr RECT bounds{100, 200, 900, 800};
	OMP_CHECK(HitTestResizeBorder(bounds, POINT{100, 200}, 8, 8, false) == HTTOPLEFT);
	OMP_CHECK(HitTestResizeBorder(bounds, POINT{899, 200}, 8, 8, false) == HTTOPRIGHT);
	OMP_CHECK(HitTestResizeBorder(bounds, POINT{100, 799}, 8, 8, false) == HTBOTTOMLEFT);
	OMP_CHECK(HitTestResizeBorder(bounds, POINT{899, 799}, 8, 8, false) == HTBOTTOMRIGHT);
	OMP_CHECK(HitTestResizeBorder(bounds, POINT{100, 500}, 8, 8, false) == HTLEFT);
	OMP_CHECK(HitTestResizeBorder(bounds, POINT{899, 500}, 8, 8, false) == HTRIGHT);
	OMP_CHECK(HitTestResizeBorder(bounds, POINT{500, 200}, 8, 8, false) == HTTOP);
	OMP_CHECK(HitTestResizeBorder(bounds, POINT{500, 799}, 8, 8, false) == HTBOTTOM);
	OMP_CHECK(HitTestResizeBorder(bounds, POINT{500, 500}, 8, 8, false) == HTCLIENT);
}

OMP_TEST("frameless resize hit testing is disabled while maximized") {
	constexpr RECT bounds{0, 0, 1920, 1040};
	OMP_CHECK(HitTestResizeBorder(bounds, POINT{0, 0}, 8, 8, true) == HTCLIENT);
}

} // namespace omp::shell::test
