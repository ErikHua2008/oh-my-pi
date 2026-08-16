#pragma once

#include <windows.h>

namespace omp::shell {

[[nodiscard]] RECT ExpandWindowBoundsForRail(const RECT& compact_bounds, const RECT& work_area, int rail_width) noexcept;

// Returns the Win32 non-client hit code for a custom frameless resize border.
// The visible client area can then cover the full window while resizing still
// behaves like a standard desktop window.
[[nodiscard]] LRESULT HitTestResizeBorder(
	const RECT& window_bounds, POINT screen_point, int horizontal_border, int vertical_border, bool maximized) noexcept;

} // namespace omp::shell
