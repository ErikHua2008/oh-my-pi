#pragma once

#include <windows.h>

#include <optional>
#include <string_view>

namespace omp::shell {

[[nodiscard]] RECT ExpandWindowBoundsForRail(const RECT& compact_bounds, const RECT& work_area, int rail_width) noexcept;

// Recover persisted coordinates and dimensions into a monitor work area so a
// display topology or resolution change cannot strand the window off-screen.
[[nodiscard]] RECT FitWindowBoundsToWorkArea(
	LONG left, LONG top, LONG width, LONG height, const RECT& work_area) noexcept;

// Keep the CSS/Win32 rail decision identical. The Web layout docks the rail
// only above 1024 CSS pixels; narrower windows use an overlay instead.
[[nodiscard]] bool ShouldDockAgentRail(int window_width, int dpi) noexcept;

// Minimum user-resizable shell size in physical pixels for the active DPI.
[[nodiscard]] SIZE MinimumWindowTrackSizeForDpi(int dpi) noexcept;

// A native child surface can otherwise cover the WebView's invisible resize
// handles. Inset only the sides that actually touch the host client edge.
[[nodiscard]] RECT InsetBoundsAtWindowEdges(
	const RECT& bounds, const RECT& client_bounds, int edge_inset) noexcept;

// Convert the Web resize action to the exact SC_SIZE command understood by
// the Win32 system sizing loop.
[[nodiscard]] std::optional<WPARAM> WindowSizingCommandForAction(std::string_view action) noexcept;

// Frameless windows have no visible sizing frame, so keep a comfortable
// DPI-scaled grab target even when the system metric is unusually narrow.
[[nodiscard]] int ResizeBorderThicknessForDpi(int system_border, int dpi) noexcept;

// Returns the Win32 non-client hit code for a custom frameless resize border.
// The visible client area can then cover the full window while resizing still
// behaves like a standard desktop window.
[[nodiscard]] LRESULT HitTestResizeBorder(
	const RECT& window_bounds, POINT screen_point, int horizontal_border, int vertical_border, bool maximized) noexcept;

} // namespace omp::shell
