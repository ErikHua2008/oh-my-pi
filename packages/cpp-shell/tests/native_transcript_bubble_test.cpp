#include "test_harness.h"

#include "omp_shell/native_transcript_bubble.h"

OMP_TEST("native transcript bubbles shrink to short messages and preserve conversation alignment") {
	const auto user = omp::shell::ComputeNativeTranscriptBubbleLayout(800.0F, true, 18.0F, 24.0F, 0);
	const auto assistant = omp::shell::ComputeNativeTranscriptBubbleLayout(800.0F, false, 96.0F, 24.0F, 0);
	OMP_CHECK(user.bubble.Width() == 46.0F);
	OMP_CHECK(user.bubble.right == 776.0F);
	OMP_CHECK(assistant.bubble.left == 24.0F);
	OMP_CHECK(assistant.bubble.Width() == 124.0F);
	OMP_CHECK(user.row_height == 54.0F);
}

OMP_TEST("native transcript bubbles cap long text and reserve full width for media") {
	const float user_max = omp::shell::NativeTranscriptBubbleMaxContentWidth(800.0F, true);
	const float assistant_max = omp::shell::NativeTranscriptBubbleMaxContentWidth(800.0F, false);
	const auto long_user = omp::shell::ComputeNativeTranscriptBubbleLayout(800.0F, true, 4'000.0F, 80.0F, 0);
	const auto image_user = omp::shell::ComputeNativeTranscriptBubbleLayout(800.0F, true, 18.0F, 20.0F, 1);
	OMP_CHECK(long_user.content_width == user_max);
	OMP_CHECK(long_user.bubble.right == 776.0F);
	OMP_CHECK(assistant_max > user_max);
	OMP_CHECK(image_user.content_width == user_max);
	OMP_CHECK(image_user.row_height == 218.0F);
}

OMP_TEST("native transcript bubbles leave a dedicated scrollbar lane") {
	const auto user = omp::shell::ComputeNativeTranscriptBubbleLayout(800.0F, true, 4'000.0F, 80.0F, 0);
	const auto scrollbar = omp::shell::ComputeNativeTranscriptScrollbar(800.0F, 600.0F, 60'000, 0);
	OMP_CHECK(scrollbar.track.left - user.bubble.right == 16.0F);

	const auto compact = omp::shell::ComputeNativeTranscriptBubbleLayout(700.0F, true, 18.0F, 20.0F, 0);
	OMP_CHECK(compact.bubble.right == 688.0F);
}

OMP_TEST("native message actions preserve the familiar user and assistant order") {
	const auto user = omp::shell::ComputeNativeTranscriptBubbleLayout(800.0F, true, 180.0F, 24.0F, 0, true);
	const auto assistant =
		omp::shell::ComputeNativeTranscriptBubbleLayout(800.0F, false, 180.0F, 24.0F, 0, true);
	const auto user_actions = omp::shell::ComputeNativeTranscriptMessageActionsLayout(user, true, true);
	const auto assistant_actions =
		omp::shell::ComputeNativeTranscriptMessageActionsLayout(assistant, false, false);

	OMP_CHECK(user.row_height == 80.0F);
	OMP_CHECK(user_actions.has_edit);
	OMP_CHECK(user_actions.time.right < user_actions.copy.left);
	OMP_CHECK(user_actions.copy.right < user_actions.edit.left);
	OMP_CHECK(user_actions.edit.right == user.bubble.right);

	OMP_CHECK(assistant.row_height == 80.0F);
	OMP_CHECK(!assistant_actions.has_edit);
	OMP_CHECK(assistant_actions.copy.left == assistant.bubble.left);
	OMP_CHECK(assistant_actions.copy.right < assistant_actions.time.left);
}
