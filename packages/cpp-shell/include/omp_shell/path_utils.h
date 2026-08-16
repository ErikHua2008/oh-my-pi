#pragma once

#include <string>
#include <string_view>

namespace omp::shell {

[[nodiscard]] std::wstring PathForCli(std::wstring_view path);
[[nodiscard]] std::wstring ComparableProjectPath(std::wstring_view path);

} // namespace omp::shell
