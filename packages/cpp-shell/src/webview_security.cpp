#include "omp_shell/webview_security.h"

#include <cstdint>

namespace omp::shell {
namespace {

bool IsDecimalPort(std::wstring_view value) noexcept {
	if (value.empty() || value.size() > 5) {
		return false;
	}
	std::uint32_t port = 0;
	for (const wchar_t ch : value) {
		if (ch < L'0' || ch > L'9') {
			return false;
		}
		port = port * 10U + static_cast<std::uint32_t>(ch - L'0');
	}
	return port != 0U && port <= 65535U;
}

bool IsLoopbackAuthority(std::wstring_view authority) noexcept {
	if (authority.find(L'@') != std::wstring_view::npos) {
		return false;
	}
	const auto separator = authority.rfind(L':');
	if (separator == std::wstring_view::npos) {
		return false;
	}
	const std::wstring_view host = authority.substr(0, separator);
	return (host == L"127.0.0.1" || host == L"localhost") && IsDecimalPort(authority.substr(separator + 1));
}

} // namespace

std::optional<std::wstring> TrustedLoopbackOrigin(std::wstring_view uri) {
	constexpr std::wstring_view scheme = L"http://";
	if (uri.size() > 8U * 1024U || !uri.starts_with(scheme)) {
		return std::nullopt;
	}
	for (const wchar_t ch : uri) {
		if (ch <= 0x20 || ch == 0x7F || ch == L'\\' || ch == L'"' || ch == L'<' || ch == L'>') {
			return std::nullopt;
		}
	}
	const auto authority_end = uri.find_first_of(L"/?#", scheme.size());
	const std::wstring_view authority = authority_end == std::wstring_view::npos
		? uri.substr(scheme.size())
		: uri.substr(scheme.size(), authority_end - scheme.size());
	if (!IsLoopbackAuthority(authority)) {
		return std::nullopt;
	}
	const std::size_t origin_length =
		authority_end == std::wstring_view::npos ? uri.size() : authority_end;
	return std::wstring(uri.substr(0, origin_length));
}

} // namespace omp::shell
