#pragma once

#include <windows.h>

namespace omp::shell {

enum class ScreenshotResizeHandle {
	None,
	Move,
	Left,
	Top,
	Right,
	Bottom,
	TopLeft,
	TopRight,
	BottomRight,
	BottomLeft,
};

[[nodiscard]] RECT NormalizeScreenshotRect(POINT first, POINT second);
[[nodiscard]] RECT ClampScreenshotRect(RECT bounds, RECT viewport, LONG minimum_size = 1);
[[nodiscard]] ScreenshotResizeHandle HitTestScreenshotSelection(RECT selection, POINT point, LONG handle_radius);
[[nodiscard]] RECT MoveScreenshotRect(RECT original, POINT delta, RECT viewport);
[[nodiscard]] RECT ResizeScreenshotRect(
	RECT original,
	ScreenshotResizeHandle handle,
	POINT point,
	RECT viewport,
	LONG minimum_size = 8);
[[nodiscard]] RECT PlaceScreenshotToolbar(RECT selection, RECT viewport, SIZE toolbar_size, LONG gap);

} // namespace omp::shell
