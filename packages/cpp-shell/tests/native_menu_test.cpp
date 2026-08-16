#include "test_harness.h"

#include "omp_shell/native_menu.h"

namespace omp::shell::test {

OMP_TEST("native popup menus have complete and distinct light and dark palettes") {
	constexpr NativeMenuPalette light = NativeMenuPaletteFor(false);
	constexpr NativeMenuPalette dark = NativeMenuPaletteFor(true);
	OMP_CHECK(light.background == 0xFFFFFF);
	OMP_CHECK(light.foreground == 0x1F2328);
	OMP_CHECK(light.hot_background != light.background);
	OMP_CHECK(light.disabled_foreground != light.foreground);
	OMP_CHECK(dark.background == 0x1F1F20);
	OMP_CHECK(dark.foreground == 0xF5F5F5);
	OMP_CHECK(dark.hot_background != dark.background);
	OMP_CHECK(dark.background != light.background);
	OMP_CHECK(dark.foreground != light.foreground);
}

} // namespace omp::shell::test
