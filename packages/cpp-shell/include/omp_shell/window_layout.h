#pragma once

#include <windows.h>

namespace omp::shell {

[[nodiscard]] RECT ExpandWindowBoundsForRail(const RECT& compact_bounds, const RECT& work_area, int rail_width) noexcept;

} // namespace omp::shell
