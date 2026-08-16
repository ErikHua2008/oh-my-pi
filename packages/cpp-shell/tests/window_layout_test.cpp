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

OMP_TEST("agent rail docking follows the Web responsive breakpoint at every DPI") {
	OMP_CHECK(!ShouldDockAgentRail(1024, 96));
	OMP_CHECK(ShouldDockAgentRail(1025, 96));
	OMP_CHECK(!ShouldDockAgentRail(1536, 144));
	OMP_CHECK(ShouldDockAgentRail(1538, 144));
	OMP_CHECK(!ShouldDockAgentRail(2049, 192));
	OMP_CHECK(ShouldDockAgentRail(2050, 192));
	OMP_CHECK(ShouldDockAgentRail(1025, 0));
}

OMP_TEST("minimum window track size preserves a usable Codex-style shell") {
	const SIZE standard = MinimumWindowTrackSizeForDpi(96);
	OMP_CHECK(standard.cx == 720);
	OMP_CHECK(standard.cy == 560);
	const SIZE scaled = MinimumWindowTrackSizeForDpi(144);
	OMP_CHECK(scaled.cx == 1080);
	OMP_CHECK(scaled.cy == 840);
	const SIZE doubled = MinimumWindowTrackSizeForDpi(192);
	OMP_CHECK(doubled.cx == 1440);
	OMP_CHECK(doubled.cy == 1120);
	const SIZE fallback = MinimumWindowTrackSizeForDpi(0);
	OMP_CHECK(fallback.cx == 720);
	OMP_CHECK(fallback.cy == 560);
}

OMP_TEST("native child surfaces leave resize handles only at host window edges") {
	constexpr RECT client{0, 0, 1096, 820};
	RequireBounds(InsetBoundsAtWindowEdges(RECT{288, 80, 1096, 650}, client, 6), 288, 80, 1090, 650);
	RequireBounds(InsetBoundsAtWindowEdges(RECT{144, 80, 952, 650}, client, 6), 144, 80, 952, 650);
	RequireBounds(InsetBoundsAtWindowEdges(client, client, 6), 6, 6, 1090, 814);
}

OMP_TEST("every Web resize action maps to a directed Win32 system sizing command") {
	OMP_CHECK(WindowSizingCommandForAction("resize_left") == (SC_SIZE | WMSZ_LEFT));
	OMP_CHECK(WindowSizingCommandForAction("resize_right") == (SC_SIZE | WMSZ_RIGHT));
	OMP_CHECK(WindowSizingCommandForAction("resize_top") == (SC_SIZE | WMSZ_TOP));
	OMP_CHECK(WindowSizingCommandForAction("resize_bottom") == (SC_SIZE | WMSZ_BOTTOM));
	OMP_CHECK(WindowSizingCommandForAction("resize_top_left") == (SC_SIZE | WMSZ_TOPLEFT));
	OMP_CHECK(WindowSizingCommandForAction("resize_top_right") == (SC_SIZE | WMSZ_TOPRIGHT));
	OMP_CHECK(WindowSizingCommandForAction("resize_bottom_left") == (SC_SIZE | WMSZ_BOTTOMLEFT));
	OMP_CHECK(WindowSizingCommandForAction("resize_bottom_right") == (SC_SIZE | WMSZ_BOTTOMRIGHT));
	OMP_CHECK(!WindowSizingCommandForAction("resize_unknown"));
}

OMP_TEST("frameless resize border remains easy to grab at every DPI") {
	OMP_CHECK(ResizeBorderThicknessForDpi(8, 96) == 12);
	OMP_CHECK(ResizeBorderThicknessForDpi(12, 144) == 18);
	OMP_CHECK(ResizeBorderThicknessForDpi(24, 144) == 24);
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
