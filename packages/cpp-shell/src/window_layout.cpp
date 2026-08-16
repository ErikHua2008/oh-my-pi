#include "omp_shell/window_layout.h"

#include <algorithm>

namespace omp::shell {

RECT ExpandWindowBoundsForRail(const RECT& compact_bounds, const RECT& work_area, int rail_width) noexcept {
	const LONG compact_width = std::max<LONG>(1, compact_bounds.right - compact_bounds.left);
	const LONG work_width = std::max<LONG>(1, work_area.right - work_area.left);
	const LONG expanded_width = std::min<LONG>(work_width, compact_width + std::max(0, rail_width));
	LONG left = std::max(compact_bounds.left, work_area.left);
	if (left + expanded_width > work_area.right) {
		left = work_area.right - expanded_width;
	}
	return RECT{left, compact_bounds.top, left + expanded_width, compact_bounds.bottom};
}

} // namespace omp::shell
