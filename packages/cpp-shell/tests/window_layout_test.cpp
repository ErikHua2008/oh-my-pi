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

} // namespace omp::shell::test
