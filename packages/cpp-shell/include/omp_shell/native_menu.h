#pragma once

#include <windows.h>

#include <cstdint>

namespace omp::shell {

struct NativeMenuPalette final {
	std::uint32_t background;
	std::uint32_t hot_background;
	std::uint32_t foreground;
	std::uint32_t disabled_foreground;
	std::uint32_t separator;
};

// Uses the same neutral surfaces as collab-web so tray and transcript menus
// remain visually continuous with the window that opened them.
[[nodiscard]] constexpr NativeMenuPalette NativeMenuPaletteFor(bool dark) noexcept {
	if (dark) {
		return {0x1F1F20, 0x37373A, 0xF5F5F5, 0x848488, 0x464649};
	}
	return {0xFFFFFF, 0xF1F3F6, 0x1F2328, 0x8A8F98, 0xE2E4E8};
}

struct NativeMenuItem final {
	const wchar_t* text;
	bool menu_bar;
	bool separator;
};

void ApplyNativeMenuBackground(HMENU menu, bool dark) noexcept;
void InsertNativeMenuItem(
	HMENU menu, const NativeMenuItem& item, UINT command, HMENU submenu = nullptr, UINT state = MFS_ENABLED);
[[nodiscard]] bool MeasureNativeMenuItem(HWND window, MEASUREITEMSTRUCT* measure) noexcept;
[[nodiscard]] bool DrawNativeMenuItem(HWND window, const DRAWITEMSTRUCT* draw, bool dark) noexcept;

} // namespace omp::shell
