#include "omp_shell/native_transcript_theme.h"

#include "test_harness.h"

namespace omp::shell::test {

OMP_TEST("native transcript light palette follows Web semantic colors") {
	constexpr NativeTranscriptPalette palette = NativeTranscriptPaletteFor(false);
	OMP_CHECK(palette.background.rgb == 0xFFFFFF);
	OMP_CHECK(palette.primary.rgb == 0x0F1115);
	OMP_CHECK(palette.muted.rgb == 0x61666B);
	OMP_CHECK(palette.user.rgb == 0xEDF3FE);
}

OMP_TEST("native transcript dark palette remains distinct and readable") {
	constexpr NativeTranscriptPalette light = NativeTranscriptPaletteFor(false);
	constexpr NativeTranscriptPalette dark = NativeTranscriptPaletteFor(true);
	OMP_CHECK(dark.background.rgb == 0x151517);
	OMP_CHECK(dark.primary.rgb == 0xF9FAFB);
	OMP_CHECK(dark.user.rgb == 0x2C2C2E);
	OMP_CHECK(dark.background.rgb != light.background.rgb);
	OMP_CHECK(dark.primary.rgb != light.primary.rgb);
}

} // namespace omp::shell::test
