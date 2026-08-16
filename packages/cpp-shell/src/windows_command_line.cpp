#include "omp_shell/windows_command_line.h"

namespace omp::shell {

std::wstring QuoteWindowsArgument(std::wstring_view argument) {
	if (!argument.empty() && argument.find_first_of(L" \t\n\v\"") == std::wstring_view::npos) {
		return std::wstring(argument);
	}

	std::wstring quoted;
	quoted.push_back(L'"');
	std::size_t backslashes = 0;
	for (const wchar_t ch : argument) {
		if (ch == L'\\') {
			++backslashes;
			continue;
		}
		if (ch == L'"') {
			quoted.append(backslashes * 2 + 1, L'\\');
			quoted.push_back(L'"');
			backslashes = 0;
			continue;
		}
		quoted.append(backslashes, L'\\');
		backslashes = 0;
		quoted.push_back(ch);
	}
	quoted.append(backslashes * 2, L'\\');
	quoted.push_back(L'"');
	return quoted;
}

std::wstring BuildWindowsCommandLine(std::span<const std::wstring> arguments) {
	std::wstring command_line;
	for (const auto& argument : arguments) {
		if (!command_line.empty()) {
			command_line.push_back(L' ');
		}
		command_line.append(QuoteWindowsArgument(argument));
	}
	return command_line;
}

} // namespace omp::shell
