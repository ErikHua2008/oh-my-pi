#pragma once

#include <span>
#include <string>
#include <string_view>

namespace omp::shell {

[[nodiscard]] std::wstring QuoteWindowsArgument(std::wstring_view argument);
[[nodiscard]] std::wstring BuildWindowsCommandLine(std::span<const std::wstring> arguments);
[[nodiscard]] std::wstring BuildWindowsBatchCommandLine(
	std::wstring_view command_interpreter,
	std::wstring_view command,
	std::span<const std::wstring> arguments);

} // namespace omp::shell
