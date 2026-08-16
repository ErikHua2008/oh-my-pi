#include "test_harness.h"

#include "omp_shell/native_transcript_reasoning.h"

OMP_TEST("native reasoning headers show completed work duration and trailing disclosure state") {
	OMP_CHECK(omp::shell::NativeTranscriptReasoningLabel(539'000, true, false, false) ==
		L"思考并工作了 8分59秒  ▸");
	OMP_CHECK(omp::shell::NativeTranscriptReasoningLabel(3'723'000, true, true, false) ==
		L"思考并工作了 1小时2分3秒  ▾");
}

OMP_TEST("native reasoning headers retain safe fallbacks for live and legacy rows") {
	OMP_CHECK(omp::shell::NativeTranscriptReasoningLabel(-1, true, false, false) == L"思考过程  ▸");
	OMP_CHECK(omp::shell::NativeTranscriptReasoningLabel(-1, false, false, true) == L"正在思考…");
}
