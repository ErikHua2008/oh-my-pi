#include "omp_shell/window_layout.h"

#include <algorithm>
#include <cstdint>

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

RECT FitWindowBoundsToWorkArea(
	LONG left, LONG top, LONG width, LONG height, const RECT& work_area) noexcept {
	const std::int64_t work_width = std::max<std::int64_t>(1,
		static_cast<std::int64_t>(work_area.right) - work_area.left);
	const std::int64_t work_height = std::max<std::int64_t>(1,
		static_cast<std::int64_t>(work_area.bottom) - work_area.top);
	const LONG fitted_width = static_cast<LONG>(std::clamp<std::int64_t>(width, 1, work_width));
	const LONG fitted_height = static_cast<LONG>(std::clamp<std::int64_t>(height, 1, work_height));
	const LONG fitted_left = static_cast<LONG>(std::clamp<std::int64_t>(
		left, work_area.left, static_cast<std::int64_t>(work_area.right) - fitted_width));
	const LONG fitted_top = static_cast<LONG>(std::clamp<std::int64_t>(
		top, work_area.top, static_cast<std::int64_t>(work_area.bottom) - fitted_height));
	return RECT{fitted_left, fitted_top, fitted_left + fitted_width, fitted_top + fitted_height};
}

bool ShouldDockAgentRail(int window_width, int dpi) noexcept {
	constexpr int kFirstDockedWidthDip = 1025;
	const int safe_dpi = dpi > 0 ? dpi : USER_DEFAULT_SCREEN_DPI;
	return window_width >= MulDiv(kFirstDockedWidthDip, safe_dpi, USER_DEFAULT_SCREEN_DPI);
}

SIZE MinimumWindowTrackSizeForDpi(int dpi) noexcept {
	constexpr int kMinimumWidthDip = 720;
	constexpr int kMinimumHeightDip = 560;
	const int safe_dpi = dpi > 0 ? dpi : USER_DEFAULT_SCREEN_DPI;
	return SIZE{
		MulDiv(kMinimumWidthDip, safe_dpi, USER_DEFAULT_SCREEN_DPI),
		MulDiv(kMinimumHeightDip, safe_dpi, USER_DEFAULT_SCREEN_DPI),
	};
}

RECT InsetBoundsAtWindowEdges(const RECT& bounds, const RECT& client_bounds, int edge_inset) noexcept {
	RECT inset = bounds;
	const LONG amount = std::max(0, edge_inset);
	if (inset.left <= client_bounds.left) {
		inset.left = std::min(inset.right, client_bounds.left + amount);
	}
	if (inset.top <= client_bounds.top) {
		inset.top = std::min(inset.bottom, client_bounds.top + amount);
	}
	if (inset.right >= client_bounds.right) {
		inset.right = std::max(inset.left, client_bounds.right - amount);
	}
	if (inset.bottom >= client_bounds.bottom) {
		inset.bottom = std::max(inset.top, client_bounds.bottom - amount);
	}
	return inset;
}

std::optional<WPARAM> WindowSizingCommandForAction(std::string_view action) noexcept {
	if (action == "resize_left") return SC_SIZE | WMSZ_LEFT;
	if (action == "resize_right") return SC_SIZE | WMSZ_RIGHT;
	if (action == "resize_top") return SC_SIZE | WMSZ_TOP;
	if (action == "resize_bottom") return SC_SIZE | WMSZ_BOTTOM;
	if (action == "resize_top_left") return SC_SIZE | WMSZ_TOPLEFT;
	if (action == "resize_top_right") return SC_SIZE | WMSZ_TOPRIGHT;
	if (action == "resize_bottom_left") return SC_SIZE | WMSZ_BOTTOMLEFT;
	if (action == "resize_bottom_right") return SC_SIZE | WMSZ_BOTTOMRIGHT;
	return std::nullopt;
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
