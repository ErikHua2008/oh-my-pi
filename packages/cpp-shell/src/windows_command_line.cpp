#include "omp_shell/windows_command_line.h"

#include <stdexcept>

namespace omp::shell {
namespace {

bool IsCmdSafeArgument(std::wstring_view argument) {
	if (argument.empty() || argument.back() == L'\\') {
		return false;
	}
	constexpr std::wstring_view safe = L"#$*+-./:?@\\_";
	for (const wchar_t ch : argument) {
		if ((ch >= L'a' && ch <= L'z') || (ch >= L'A' && ch <= L'Z') || (ch >= L'0' && ch <= L'9') ||
			safe.find(ch) != std::wstring_view::npos) {
			continue;
		}
		return false;
	}
	return true;
}

void ValidateBatchToken(std::wstring_view value, std::string_view kind) {
	if (value.find(L'\0') != std::wstring_view::npos || value.find(L'\r') != std::wstring_view::npos ||
		value.find(L'\n') != std::wstring_view::npos) {
		throw std::invalid_argument("Windows batch " + std::string(kind) + " cannot contain NUL, CR, or LF");
	}
}

std::wstring EscapeCmdQuotedInterior(std::wstring_view value) {
	std::wstring escaped;
	std::size_t backslashes = 0;
	for (const wchar_t ch : value) {
		if (ch == L'\\') {
			++backslashes;
			escaped.push_back(ch);
		} else if (ch == L'"') {
			escaped.append(backslashes, L'\\');
			escaped.append(L"\"\"");
			backslashes = 0;
		} else if (ch == L'%') {
			escaped.append(L"%%cd:~,%");
			backslashes = 0;
		} else {
			backslashes = 0;
			escaped.push_back(ch);
		}
	}
	escaped.append(backslashes, L'\\');
	return escaped;
}

std::wstring EscapeCmdBatchArgument(std::wstring_view argument) {
	ValidateBatchToken(argument, "argument");
	if (IsCmdSafeArgument(argument)) {
		return std::wstring(argument);
	}
	return L"\"" + EscapeCmdQuotedInterior(argument) + L"\"";
}

} // namespace

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

std::wstring BuildWindowsBatchCommandLine(
	std::wstring_view command_interpreter,
	std::wstring_view command,
	std::span<const std::wstring> arguments) {
	ValidateBatchToken(command, "command");
	std::wstring command_line = QuoteWindowsArgument(command_interpreter);
	command_line.append(L" /d /e:ON /v:OFF /c \"\"");
	command_line.append(EscapeCmdQuotedInterior(command));
	command_line.push_back(L'"');
	for (const std::wstring& argument : arguments) {
		command_line.push_back(L' ');
		command_line.append(EscapeCmdBatchArgument(argument));
	}
	command_line.push_back(L'"');
	return command_line;
}

} // namespace omp::shell
