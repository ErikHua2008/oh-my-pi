#include "test_harness.h"

#include "omp_shell/native_transcript_controls.h"

#include <cstdint>

OMP_TEST("native transcript overlay scrollbar stays thin and maps the full scroll range") {
	const auto top = omp::shell::ComputeNativeTranscriptScrollbar(800.0F, 600.0F, 60'000, 0);
	OMP_CHECK(top.scrollable);
	OMP_CHECK(top.thumb.Width() == 3.0F);
	OMP_CHECK(top.thumb.Height() >= 36.0F);
	OMP_CHECK(top.thumb.top == top.track.top);
	OMP_CHECK(top.hit_area.Width() == 18.0F);

	const std::int64_t maximum = 60'000 - 600;
	const auto bottom = omp::shell::ComputeNativeTranscriptScrollbar(800.0F, 600.0F, 60'000, maximum);
	OMP_CHECK(bottom.thumb.bottom == bottom.track.bottom);
	OMP_CHECK(omp::shell::NativeTranscriptOffsetForThumbTop(bottom, bottom.track.top, maximum) == 0);
	OMP_CHECK(omp::shell::NativeTranscriptOffsetForThumbTop(bottom, bottom.track.bottom, maximum) == maximum);
}

OMP_TEST("native transcript overlay controls disappear when scrolling is unnecessary") {
	const auto scrollbar = omp::shell::ComputeNativeTranscriptScrollbar(800.0F, 600.0F, 500, 0);
	OMP_CHECK(!scrollbar.scrollable);
	OMP_CHECK(!omp::shell::ShouldShowNativeTranscriptJumpButton(500, 600, 0));
	OMP_CHECK(!omp::shell::ShouldShowNativeTranscriptJumpButton(60'000, 600, 59'400));
}

OMP_TEST("native transcript jump button is centered and appears only away from the tail") {
	const auto button = omp::shell::ComputeNativeTranscriptJumpButton(800.0F, 600.0F);
	OMP_CHECK(button.Width() == 34.0F);
	OMP_CHECK(button.Height() == 34.0F);
	OMP_CHECK(button.left == 383.0F);
	OMP_CHECK(button.bottom == 584.0F);
	OMP_CHECK(omp::shell::ShouldShowNativeTranscriptJumpButton(60'000, 600, 20'000));
	OMP_CHECK(!omp::shell::ShouldShowNativeTranscriptJumpButton(60'000, 600, 59'380));
}
