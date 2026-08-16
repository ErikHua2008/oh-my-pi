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
	float actions_top = 0.0F;
	float row_height = 0.0F;
};

struct NativeTranscriptMessageActionsLayout final {
	NativeTranscriptRectF time;
	NativeTranscriptRectF copy;
	NativeTranscriptRectF edit;
	bool has_edit = false;
};

/** Match the Web message rail: 24px normally and 12px in compact windows. */
[[nodiscard]] inline float NativeTranscriptOuterHorizontalPadding(float viewport_width) noexcept {
	return viewport_width <= 720.0F ? 12.0F : 24.0F;
}

[[nodiscard]] inline float NativeTranscriptBubbleMaxContentWidth(float viewport_width, bool user) noexcept {
	constexpr float kBubbleHorizontalPadding = 14.0F;
	constexpr float kMinimumContentWidth = 40.0F;
	constexpr float kUserWidthRatio = 0.78F;
	constexpr float kAssistantWidthRatio = 0.92F;
	const float outer_horizontal_padding = NativeTranscriptOuterHorizontalPadding(viewport_width);
	const float available = std::max(kMinimumContentWidth,
		viewport_width - 2.0F * outer_horizontal_padding - 2.0F * kBubbleHorizontalPadding);
	return available * (user ? kUserWidthRatio : kAssistantWidthRatio);
}

[[nodiscard]] inline NativeTranscriptBubbleLayout ComputeNativeTranscriptBubbleLayout(
	float viewport_width,
	bool user,
	float measured_text_width,
	float measured_text_height,
	std::size_t media_count,
	bool show_actions = false) noexcept {
	constexpr float kOuterVerticalPadding = 5.0F;
	constexpr float kBubbleHorizontalPadding = 14.0F;
	constexpr float kBubbleVerticalPadding = 10.0F;
	constexpr float kMinimumTextWidth = 18.0F;
	constexpr float kThumbnailHeight = 160.0F;
	constexpr float kMediaGap = 8.0F;
	constexpr float kActionsGap = 2.0F;
	constexpr float kActionsHeight = 24.0F;

	const float outer_horizontal_padding = NativeTranscriptOuterHorizontalPadding(viewport_width);
	const float maximum_content_width = NativeTranscriptBubbleMaxContentWidth(viewport_width, user);
	const float natural_content_width = media_count == 0
		? std::clamp(measured_text_width, kMinimumTextWidth, maximum_content_width)
		: maximum_content_width;
	const float bubble_width = natural_content_width + 2.0F * kBubbleHorizontalPadding;
	const float bubble_left = user
		? viewport_width - outer_horizontal_padding - bubble_width
		: outer_horizontal_padding;
	const float content_height = std::max(18.0F, measured_text_height) +
		static_cast<float>(media_count) * (kThumbnailHeight + kMediaGap);
	const float bubble_height = content_height + 2.0F * kBubbleVerticalPadding;
	const float actions_top = kOuterVerticalPadding + bubble_height + kActionsGap;
	const float row_height = std::ceil(
		bubble_height + 2.0F * kOuterVerticalPadding + (show_actions ? kActionsGap + kActionsHeight : 0.0F));
	return {
		{bubble_left, kOuterVerticalPadding, bubble_left + bubble_width, kOuterVerticalPadding + bubble_height},
		bubble_left + kBubbleHorizontalPadding,
		natural_content_width,
		kOuterVerticalPadding + kBubbleVerticalPadding,
		actions_top,
		row_height,
	};
}

[[nodiscard]] inline NativeTranscriptMessageActionsLayout ComputeNativeTranscriptMessageActionsLayout(
	const NativeTranscriptBubbleLayout& bubble,
	bool user,
	bool can_edit) noexcept {
	constexpr float kTimeWidth = 42.0F;
	constexpr float kButtonSize = 24.0F;
	constexpr float kGap = 2.0F;
	const float total_width = kTimeWidth + kGap + kButtonSize + (can_edit ? kGap + kButtonSize : 0.0F);
	const float left = user ? bubble.bubble.right - total_width : bubble.bubble.left;
	NativeTranscriptMessageActionsLayout result;
	result.has_edit = user && can_edit;
	if (user) {
		result.time = {left, bubble.actions_top, left + kTimeWidth, bubble.actions_top + kButtonSize};
		result.copy = {result.time.right + kGap,
			bubble.actions_top,
			result.time.right + kGap + kButtonSize,
			bubble.actions_top + kButtonSize};
		if (result.has_edit) {
			result.edit = {result.copy.right + kGap,
				bubble.actions_top,
				result.copy.right + kGap + kButtonSize,
				bubble.actions_top + kButtonSize};
		}
	} else {
		result.copy = {left, bubble.actions_top, left + kButtonSize, bubble.actions_top + kButtonSize};
		result.time = {result.copy.right + kGap,
			bubble.actions_top,
			result.copy.right + kGap + kTimeWidth,
			bubble.actions_top + kButtonSize};
	}
	return result;
}

} // namespace omp::shell
