#pragma once

#include "omp_shell/native_transcript_controls.h"

#include <algorithm>
#include <cmath>
#include <cstddef>

namespace omp::shell {

struct NativeTranscriptBubbleLayout final {
	NativeTranscriptRectF bubble;
	float content_left = 0.0F;
	float content_width = 0.0F;
	float text_top = 0.0F;
	float row_height = 0.0F;
};

[[nodiscard]] inline float NativeTranscriptBubbleMaxContentWidth(float viewport_width, bool user) noexcept {
	constexpr float kOuterHorizontalPadding = 0.0F;
	constexpr float kBubbleHorizontalPadding = 14.0F;
	constexpr float kMinimumContentWidth = 40.0F;
	constexpr float kUserWidthRatio = 0.78F;
	constexpr float kAssistantWidthRatio = 0.92F;
	const float available = std::max(kMinimumContentWidth,
		viewport_width - 2.0F * kOuterHorizontalPadding - 2.0F * kBubbleHorizontalPadding);
	return available * (user ? kUserWidthRatio : kAssistantWidthRatio);
}

[[nodiscard]] inline NativeTranscriptBubbleLayout ComputeNativeTranscriptBubbleLayout(
	float viewport_width,
	bool user,
	float measured_text_width,
	float measured_text_height,
	std::size_t media_count) noexcept {
	constexpr float kOuterHorizontalPadding = 0.0F;
	constexpr float kOuterVerticalPadding = 5.0F;
	constexpr float kBubbleHorizontalPadding = 14.0F;
	constexpr float kBubbleVerticalPadding = 10.0F;
	constexpr float kMinimumTextWidth = 18.0F;
	constexpr float kThumbnailHeight = 160.0F;
	constexpr float kMediaGap = 8.0F;

	const float maximum_content_width = NativeTranscriptBubbleMaxContentWidth(viewport_width, user);
	const float natural_content_width = media_count == 0
		? std::clamp(measured_text_width, kMinimumTextWidth, maximum_content_width)
		: maximum_content_width;
	const float bubble_width = natural_content_width + 2.0F * kBubbleHorizontalPadding;
	const float bubble_left = user
		? viewport_width - kOuterHorizontalPadding - bubble_width
		: kOuterHorizontalPadding;
	const float content_height = std::max(18.0F, measured_text_height) +
		static_cast<float>(media_count) * (kThumbnailHeight + kMediaGap);
	const float bubble_height = content_height + 2.0F * kBubbleVerticalPadding;
	const float row_height = std::ceil(bubble_height + 2.0F * kOuterVerticalPadding);
	return {
		{bubble_left, kOuterVerticalPadding, bubble_left + bubble_width, kOuterVerticalPadding + bubble_height},
		bubble_left + kBubbleHorizontalPadding,
		natural_content_width,
		kOuterVerticalPadding + kBubbleVerticalPadding,
		row_height,
	};
}

} // namespace omp::shell
