#pragma once

#include <cstdint>

namespace omp::shell {

struct NativeTranscriptColor final {
	std::uint32_t rgb;
	float alpha;
};

struct NativeTranscriptPalette final {
	NativeTranscriptColor background;
	NativeTranscriptColor primary;
	NativeTranscriptColor muted;
	NativeTranscriptColor user;
	NativeTranscriptColor user_foreground;
	NativeTranscriptColor assistant;
	NativeTranscriptColor line;
	NativeTranscriptColor selection;
	NativeTranscriptColor scrollbar;
	NativeTranscriptColor scrollbar_hot;
	NativeTranscriptColor jump_button;
	NativeTranscriptColor jump_button_hot;
	NativeTranscriptColor jump_button_border;
	NativeTranscriptColor jump_button_shadow;
};

// Mirrors collab-web's semantic theme tokens so the native HWND remains
// visually continuous with the WebView controls surrounding it.
[[nodiscard]] constexpr NativeTranscriptPalette NativeTranscriptPaletteFor(bool dark) noexcept {
	if (dark) {
		return {
			{0x151517, 1.0F}, // --bg
			{0xF9FAFB, 1.0F}, // --fg
			{0xCFD3D6, 1.0F}, // --fg-muted
			{0x65C98F, 1.0F}, // WeChat-style outgoing bubble
			{0x102419, 1.0F},
			{0x2C2C2E, 1.0F}, // neutral OMP bubble
			{0x313133, 1.0F}, // --border composited over --bg
			{0x679EFE, 0.35F},
			{0xADB2B8, 0.50F},
			{0xCFD3D6, 0.78F},
			{0x2C2C2E, 0.98F},
			{0x3A3A3C, 0.98F},
			{0x555960, 0.92F},
			{0x000000, 0.34F},
		};
	}
	return {
		{0xFFFFFF, 1.0F}, // --bg
		{0x0F1115, 1.0F}, // --fg
		{0x61666B, 1.0F}, // --fg-muted
		{0xCBE7FF, 1.0F}, // WeCom-style outgoing bubble
		{0x0F1115, 1.0F},
		{0xF1F2F4, 1.0F}, // neutral OMP bubble
		{0xE5E5E5, 1.0F}, // --border composited over --bg
		{0x4176E6, 0.25F},
		{0x81858C, 0.48F},
		{0x61666B, 0.74F},
		{0xFFFFFF, 0.98F},
		{0xF2F3F5, 0.98F},
		{0xD9DADD, 0.96F},
		{0x000000, 0.14F},
	};
}

} // namespace omp::shell
