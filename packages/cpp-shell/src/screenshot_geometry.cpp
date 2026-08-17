#include "omp_shell/screenshot_geometry.h"

#include <algorithm>

namespace omp::shell {
namespace {

[[nodiscard]] bool Near(LONG value, LONG target, LONG radius) {
	return value >= target - radius && value <= target + radius;
}

[[nodiscard]] bool Between(LONG value, LONG low, LONG high) {
	return value >= low && value <= high;
}

} // namespace

RECT NormalizeScreenshotRect(POINT first, POINT second) {
	return RECT{
		std::min(first.x, second.x),
		std::min(first.y, second.y),
		std::max(first.x, second.x),
		std::max(first.y, second.y),
	};
}

RECT ClampScreenshotRect(RECT bounds, RECT viewport, LONG minimum_size) {
	minimum_size = std::max<LONG>(1, minimum_size);
	if (viewport.right <= viewport.left || viewport.bottom <= viewport.top) {
		return RECT{};
	}
	minimum_size = std::min({minimum_size, viewport.right - viewport.left, viewport.bottom - viewport.top});
	if (bounds.right < bounds.left) std::swap(bounds.left, bounds.right);
	if (bounds.bottom < bounds.top) std::swap(bounds.top, bounds.bottom);
	const LONG viewport_width = viewport.right - viewport.left;
	const LONG viewport_height = viewport.bottom - viewport.top;
	const LONG width = std::clamp(bounds.right - bounds.left, minimum_size, viewport_width);
	const LONG height = std::clamp(bounds.bottom - bounds.top, minimum_size, viewport_height);
	bounds.left = std::clamp(bounds.left, viewport.left, viewport.right - width);
	bounds.top = std::clamp(bounds.top, viewport.top, viewport.bottom - height);
	bounds.right = bounds.left + width;
	bounds.bottom = bounds.top + height;
	return bounds;
}

ScreenshotResizeHandle HitTestScreenshotSelection(RECT selection, POINT point, LONG handle_radius) {
	if (selection.right <= selection.left || selection.bottom <= selection.top) {
		return ScreenshotResizeHandle::None;
	}
	handle_radius = std::max<LONG>(2, handle_radius);
	if (Near(point.x, selection.left, handle_radius) && Near(point.y, selection.top, handle_radius))
		return ScreenshotResizeHandle::TopLeft;
	if (Near(point.x, selection.right, handle_radius) && Near(point.y, selection.top, handle_radius))
		return ScreenshotResizeHandle::TopRight;
	if (Near(point.x, selection.right, handle_radius) && Near(point.y, selection.bottom, handle_radius))
		return ScreenshotResizeHandle::BottomRight;
	if (Near(point.x, selection.left, handle_radius) && Near(point.y, selection.bottom, handle_radius))
		return ScreenshotResizeHandle::BottomLeft;
	if (Near(point.x, selection.left, handle_radius) && Between(point.y, selection.top, selection.bottom))
		return ScreenshotResizeHandle::Left;
	if (Near(point.x, selection.right, handle_radius) && Between(point.y, selection.top, selection.bottom))
		return ScreenshotResizeHandle::Right;
	if (Near(point.y, selection.top, handle_radius) && Between(point.x, selection.left, selection.right))
		return ScreenshotResizeHandle::Top;
	if (Near(point.y, selection.bottom, handle_radius) && Between(point.x, selection.left, selection.right))
		return ScreenshotResizeHandle::Bottom;
	if (Between(point.x, selection.left, selection.right) && Between(point.y, selection.top, selection.bottom))
		return ScreenshotResizeHandle::Move;
	return ScreenshotResizeHandle::None;
}

RECT MoveScreenshotRect(RECT original, POINT delta, RECT viewport) {
	const LONG width = original.right - original.left;
	const LONG height = original.bottom - original.top;
	RECT moved{
		original.left + delta.x,
		original.top + delta.y,
		original.right + delta.x,
		original.bottom + delta.y,
	};
	if (moved.left < viewport.left) {
		moved.left = viewport.left;
		moved.right = moved.left + width;
	}
	if (moved.right > viewport.right) {
		moved.right = viewport.right;
		moved.left = moved.right - width;
	}
	if (moved.top < viewport.top) {
		moved.top = viewport.top;
		moved.bottom = moved.top + height;
	}
	if (moved.bottom > viewport.bottom) {
		moved.bottom = viewport.bottom;
		moved.top = moved.bottom - height;
	}
	return moved;
}

RECT ResizeScreenshotRect(
	RECT original,
	ScreenshotResizeHandle handle,
	POINT point,
	RECT viewport,
	LONG minimum_size) {
	minimum_size = std::max<LONG>(1, minimum_size);
	RECT resized = original;
	const bool left = handle == ScreenshotResizeHandle::Left || handle == ScreenshotResizeHandle::TopLeft ||
		handle == ScreenshotResizeHandle::BottomLeft;
	const bool right = handle == ScreenshotResizeHandle::Right || handle == ScreenshotResizeHandle::TopRight ||
		handle == ScreenshotResizeHandle::BottomRight;
	const bool top = handle == ScreenshotResizeHandle::Top || handle == ScreenshotResizeHandle::TopLeft ||
		handle == ScreenshotResizeHandle::TopRight;
	const bool bottom = handle == ScreenshotResizeHandle::Bottom || handle == ScreenshotResizeHandle::BottomLeft ||
		handle == ScreenshotResizeHandle::BottomRight;
	if (left) resized.left = std::clamp(point.x, viewport.left, original.right - minimum_size);
	if (right) resized.right = std::clamp(point.x, original.left + minimum_size, viewport.right);
	if (top) resized.top = std::clamp(point.y, viewport.top, original.bottom - minimum_size);
	if (bottom) resized.bottom = std::clamp(point.y, original.top + minimum_size, viewport.bottom);
	return resized;
}

RECT PlaceScreenshotToolbar(RECT selection, RECT viewport, SIZE toolbar_size, LONG gap) {
	const LONG width = std::min<LONG>(toolbar_size.cx, viewport.right - viewport.left);
	const LONG height = std::min<LONG>(toolbar_size.cy, viewport.bottom - viewport.top);
	LONG left = selection.right - width;
	left = std::clamp(left, viewport.left, viewport.right - width);
	LONG top = selection.bottom + gap;
	if (top + height > viewport.bottom) top = selection.top - gap - height;
	if (top < viewport.top) top = std::clamp(selection.bottom - height - gap, viewport.top, viewport.bottom - height);
	return RECT{left, top, left + width, top + height};
}

} // namespace omp::shell
