#pragma once

#include <algorithm>
#include <cstdint>
#include <string>

namespace omp::shell {

[[nodiscard]] inline std::wstring FormatNativeTranscriptWorkDuration(std::int64_t duration_ms) {
	const std::int64_t rounded_seconds = std::max<std::int64_t>(1, (duration_ms + 500) / 1'000);
	const std::int64_t hours = rounded_seconds / 3'600;
	const std::int64_t minutes = (rounded_seconds % 3'600) / 60;
	const std::int64_t seconds = rounded_seconds % 60;
	std::wstring result;
	if (hours > 0) {
		result.append(std::to_wstring(hours)).append(L"小时");
	}
	if (minutes > 0) {
		result.append(std::to_wstring(minutes)).append(L"分");
	}
	if (seconds > 0 || (hours == 0 && minutes == 0)) {
		result.append(std::to_wstring(seconds)).append(L"秒");
	}
	return result;
}

[[nodiscard]] inline std::wstring NativeTranscriptReasoningLabel(
	std::int64_t duration_ms,
	bool expandable,
	bool expanded,
	bool streaming) {
	if (streaming) {
		return L"正在思考…";
	}
	std::wstring label = duration_ms >= 0
		? L"思考并工作了 " + FormatNativeTranscriptWorkDuration(duration_ms)
		: L"思考过程";
	if (expandable) {
		label.append(expanded ? L"  ▾" : L"  ▸");
	}
	return label;
}

} // namespace omp::shell
