#pragma once

#include <string>
#include <string_view>
#include <optional>

namespace omp::shell {

[[nodiscard]] std::wstring Utf8ToWide(std::string_view value);
[[nodiscard]] std::string WideToUtf8(std::wstring_view value);
[[nodiscard]] std::optional<std::wstring> EnvironmentValue(std::wstring_view name);

} // namespace omp::shell
