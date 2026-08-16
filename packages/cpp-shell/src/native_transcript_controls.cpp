#include "omp_shell/native_transcript_controls.h"

#include <algorithm>
#include <cmath>

namespace omp::shell {
namespace {

constexpr float kScrollbarTopMargin = 8.0F;
constexpr float kScrollbarRightMargin = 5.0F;
constexpr float kScrollbarWidth = 3.0F;
constexpr float kScrollbarHitWidth = 18.0F;
constexpr float kMinimumThumbHeight = 36.0F;
constexpr float kJumpButtonSize = 34.0F;
constexpr float kJumpButtonBottomMargin = 16.0F;
constexpr std::int64_t kJumpButtonThreshold = 36;

} // namespace

NativeTranscriptScrollbarGeometry ComputeNativeTranscriptScrollbar(
	float viewport_width,
	float viewport_height,
	std::int64_t total_height,
	std::int64_t scroll_offset) noexcept {
	NativeTranscriptScrollbarGeometry geometry{};
	if (viewport_width <= 0.0F || viewport_height < 48.0F || total_height <= 0) {
		return geometry;
	}

	const std::int64_t viewport = static_cast<std::int64_t>(std::floor(viewport_height));
	const std::int64_t maximum_scroll = std::max<std::int64_t>(0, total_height - viewport);
	if (maximum_scroll == 0) {
		return geometry;
	}

	const float track_left = std::max(0.0F, viewport_width - kScrollbarRightMargin - kScrollbarWidth);
	const float track_right = std::max(track_left, viewport_width - kScrollbarRightMargin);
	geometry.track = {track_left, kScrollbarTopMargin, track_right, viewport_height - kScrollbarTopMargin};
	geometry.hit_area = {
		std::max(0.0F, viewport_width - kScrollbarHitWidth),
		0.0F,
		viewport_width,
		viewport_height,
	};
	const float track_height = geometry.track.Height();
	if (track_height <= 0.0F) {
		return NativeTranscriptScrollbarGeometry{};
	}

	const float visible_ratio = std::clamp(viewport_height / static_cast<float>(total_height), 0.0F, 1.0F);
	const float thumb_height = std::clamp(track_height * visible_ratio, kMinimumThumbHeight, track_height);
	const float travel = std::max(0.0F, track_height - thumb_height);
	const float offset_ratio = static_cast<float>(std::clamp<std::int64_t>(scroll_offset, 0, maximum_scroll)) /
		static_cast<float>(maximum_scroll);
	const float thumb_top = geometry.track.top + travel * offset_ratio;
	geometry.thumb = {geometry.track.left, thumb_top, geometry.track.right, thumb_top + thumb_height};
	geometry.scrollable = true;
	return geometry;
}

NativeTranscriptRectF ComputeNativeTranscriptJumpButton(float viewport_width, float viewport_height) noexcept {
	if (viewport_width < kJumpButtonSize || viewport_height < kJumpButtonSize + kJumpButtonBottomMargin) {
		return {};
	}
	const float left = std::max(0.0F, (viewport_width - kJumpButtonSize) / 2.0F);
	const float top = viewport_height - kJumpButtonBottomMargin - kJumpButtonSize;
	return {left, top, left + kJumpButtonSize, top + kJumpButtonSize};
}

bool ShouldShowNativeTranscriptJumpButton(
	std::int64_t total_height,
	std::int64_t viewport_height,
	std::int64_t scroll_offset) noexcept {
	const std::int64_t maximum_scroll = std::max<std::int64_t>(0, total_height - viewport_height);
	return maximum_scroll > 0 && maximum_scroll - std::clamp<std::int64_t>(scroll_offset, 0, maximum_scroll) >
		kJumpButtonThreshold;
}

std::int64_t NativeTranscriptOffsetForThumbTop(
	const NativeTranscriptScrollbarGeometry& geometry,
	float thumb_top,
	std::int64_t maximum_scroll) noexcept {
	if (!geometry.scrollable || maximum_scroll <= 0) {
		return 0;
	}
	const float travel = geometry.track.Height() - geometry.thumb.Height();
	if (travel <= 0.0F) {
		return 0;
	}
	const float ratio = std::clamp((thumb_top - geometry.track.top) / travel, 0.0F, 1.0F);
	return static_cast<std::int64_t>(std::llround(ratio * static_cast<float>(maximum_scroll)));
}

} // namespace omp::shell
