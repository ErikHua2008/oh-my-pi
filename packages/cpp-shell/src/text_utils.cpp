#include "omp_shell/text_utils.h"

#include <windows.h>

#include <limits>

namespace omp::shell {

std::wstring Utf8ToWide(std::string_view value) {
	if (value.empty()) {
		return {};
	}
	if (value.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
		return L"[text too large]";
	}
	const int length = static_cast<int>(value.size());
	const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), length, nullptr, 0);
	if (required <= 0) {
		return L"[invalid UTF-8]";
	}
	std::wstring result(static_cast<std::size_t>(required), L'\0');
	if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), length, result.data(), required) != required) {
		return L"[invalid UTF-8]";
	}
	return result;
}

std::string WideToUtf8(std::wstring_view value) {
	if (value.empty()) {
		return {};
	}
	if (value.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
		return "[text too large]";
	}
	const int length = static_cast<int>(value.size());
	const int required = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), length, nullptr, 0, nullptr, nullptr);
	if (required <= 0) {
		return "[invalid UTF-16]";
	}
	std::string result(static_cast<std::size_t>(required), '\0');
	if (WideCharToMultiByte(
			CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), length, result.data(), required, nullptr, nullptr) != required) {
		return "[invalid UTF-16]";
	}
	return result;
}

std::optional<std::wstring> EnvironmentValue(std::wstring_view name) {
	const std::wstring owned_name(name);
	const DWORD required = GetEnvironmentVariableW(owned_name.c_str(), nullptr, 0);
	if (required == 0) {
		return std::nullopt;
	}
	std::wstring value(static_cast<std::size_t>(required), L'\0');
	const DWORD written = GetEnvironmentVariableW(owned_name.c_str(), value.data(), required);
	if (written == 0 || written >= required) {
		return std::nullopt;
	}
	value.resize(static_cast<std::size_t>(written));
	return value;
}

} // namespace omp::shell
