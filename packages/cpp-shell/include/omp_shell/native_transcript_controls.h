#pragma once

#include <cstdint>

namespace omp::shell {

struct NativeTranscriptRectF final {
	float left = 0.0F;
	float top = 0.0F;
	float right = 0.0F;
	float bottom = 0.0F;

	[[nodiscard]] float Width() const noexcept { return right - left; }
	[[nodiscard]] float Height() const noexcept { return bottom - top; }
	[[nodiscard]] bool Contains(float x, float y) const noexcept {
		return x >= left && x <= right && y >= top && y <= bottom;
	}
};

struct NativeTranscriptScrollbarGeometry final {
	NativeTranscriptRectF track;
	NativeTranscriptRectF thumb;
	NativeTranscriptRectF hit_area;
	bool scrollable = false;
};

[[nodiscard]] NativeTranscriptScrollbarGeometry ComputeNativeTranscriptScrollbar(
	float viewport_width,
	float viewport_height,
	std::int64_t total_height,
	std::int64_t scroll_offset) noexcept;

[[nodiscard]] NativeTranscriptRectF ComputeNativeTranscriptJumpButton(
	float viewport_width,
	float viewport_height) noexcept;

[[nodiscard]] bool ShouldShowNativeTranscriptJumpButton(
	std::int64_t total_height,
	std::int64_t viewport_height,
	std::int64_t scroll_offset) noexcept;

[[nodiscard]] std::int64_t NativeTranscriptOffsetForThumbTop(
	const NativeTranscriptScrollbarGeometry& geometry,
	float thumb_top,
	std::int64_t maximum_scroll) noexcept;

} // namespace omp::shell
