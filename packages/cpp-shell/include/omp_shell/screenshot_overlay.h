#pragma once

#include <windows.h>

#include <cstdint>
#include <string>
#include <vector>

namespace omp::shell {

struct ScreenshotCaptureResult {
	bool completed = false;
	bool clipboard_written = false;
	LONG width = 0;
	LONG height = 0;
	std::vector<std::uint8_t> png;
	std::wstring error;
};

class ScreenshotOverlay final {
public:
	[[nodiscard]] static ScreenshotCaptureResult Capture(HINSTANCE instance, HWND owner);
};

} // namespace omp::shell
