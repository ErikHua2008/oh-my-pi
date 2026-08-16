#include "omp_shell/path_utils.h"

#include <algorithm>
#include <cwctype>

namespace omp::shell {
namespace {

constexpr std::wstring_view kVerbatimUncPrefix = LR"(\\?\UNC\)";
constexpr std::wstring_view kVerbatimPrefix = LR"(\\?\)";

bool IsDriveRoot(std::wstring_view path) {
	return path.size() == 3 && std::iswalpha(path[0]) != 0 && path[1] == L':' && path[2] == L'/';
}

} // namespace

std::wstring PathForCli(std::wstring_view path) {
	if (path.starts_with(kVerbatimUncPrefix)) {
		return L"\\\\" + std::wstring(path.substr(kVerbatimUncPrefix.size()));
	}
	if (path.starts_with(kVerbatimPrefix)) {
		return std::wstring(path.substr(kVerbatimPrefix.size()));
	}
	return std::wstring(path);
}

std::wstring ComparableProjectPath(std::wstring_view path) {
	std::wstring normalized = PathForCli(path);
	std::replace(normalized.begin(), normalized.end(), L'\\', L'/');
	while (normalized.size() > 1 && normalized.back() == L'/' && !IsDriveRoot(normalized)) {
		normalized.pop_back();
	}
	std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](wchar_t ch) {
		return static_cast<wchar_t>(std::towlower(ch));
	});
	return normalized;
}

} // namespace omp::shell
