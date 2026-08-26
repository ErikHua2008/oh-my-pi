#pragma once

#include <optional>
#include <string>
#include <string_view>

namespace omp::shell {

// Returns the normalized scheme + authority for a loopback Core URL. Other
// URLs are rejected so they cannot inherit the native desktop bridge.
[[nodiscard]] std::optional<std::wstring> TrustedLoopbackOrigin(std::wstring_view uri);

} // namespace omp::shell
