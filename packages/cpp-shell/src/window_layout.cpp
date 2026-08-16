#include "omp_shell/window_layout.h"

#include <algorithm>

namespace omp::shell {

RECT ExpandWindowBoundsForRail(const RECT& compact_bounds, const RECT& work_area, int rail_width) noexcept {
	const LONG compact_width = std::max<LONG>(1, compact_bounds.right - compact_bounds.left);
	const LONG work_width = std::max<LONG>(1, work_area.right - work_area.left);
	const LONG expanded_width = std::min<LONG>(work_width, compact_width + std::max(0, rail_width));
	LONG left = std::max(compact_bounds.left, work_area.left);
	if (left + expanded_width > work_area.right) {
		left = work_area.right - expanded_width;
	}
	return RECT{left, compact_bounds.top, left + expanded_width, compact_bounds.bottom};
}

int ResizeBorderThicknessForDpi(int system_border, int dpi) noexcept {
	constexpr int kMinimumResizeBorderDip = 12;
	const int scaled_minimum =
		dpi > 0 ? MulDiv(kMinimumResizeBorderDip, dpi, USER_DEFAULT_SCREEN_DPI) : kMinimumResizeBorderDip;
	return std::max(system_border, scaled_minimum);
}

LRESULT HitTestResizeBorder(
	const RECT& window_bounds, POINT screen_point, int horizontal_border, int vertical_border, bool maximized) noexcept {
	if (maximized || horizontal_border <= 0 || vertical_border <= 0 || screen_point.x < window_bounds.left ||
		screen_point.x >= window_bounds.right || screen_point.y < window_bounds.top ||
		screen_point.y >= window_bounds.bottom) {
		return HTCLIENT;
	}
	const bool left = screen_point.x < window_bounds.left + horizontal_border;
	const bool right = screen_point.x >= window_bounds.right - horizontal_border;
	const bool top = screen_point.y < window_bounds.top + vertical_border;
	const bool bottom = screen_point.y >= window_bounds.bottom - vertical_border;
	if (top && left) return HTTOPLEFT;
	if (top && right) return HTTOPRIGHT;
	if (bottom && left) return HTBOTTOMLEFT;
	if (bottom && right) return HTBOTTOMRIGHT;
	if (left) return HTLEFT;
	if (right) return HTRIGHT;
	if (top) return HTTOP;
	if (bottom) return HTBOTTOM;
	return HTCLIENT;
}

} // namespace omp::shell
