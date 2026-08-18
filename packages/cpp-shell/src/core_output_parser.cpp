#include "omp_shell/core_output_parser.h"

#include <cstdint>
#include <utility>

namespace omp::shell {
namespace {

constexpr std::size_t kMaxBufferedOutput = 64 * 1024;

bool IsDecimalPort(std::string_view value) {
	if (value.empty() || value.size() > 5) {
		return false;
	}
	std::uint32_t port = 0;
	for (const char ch : value) {
		if (ch < '0' || ch > '9') {
			return false;
		}
		port = port * 10U + static_cast<std::uint32_t>(ch - '0');
	}
	return port != 0U && port <= 65535U;
}

bool IsLoopbackAuthority(std::string_view authority) {
	if (authority.find('@') != std::string_view::npos) {
		return false;
	}
	const auto separator = authority.rfind(':');
	if (separator == std::string_view::npos) {
		return false;
	}
	const std::string_view host = authority.substr(0, separator);
	return (host == "127.0.0.1" || host == "localhost") && IsDecimalPort(authority.substr(separator + 1));
}

bool ContainsUnsafeUrlCharacter(std::string_view value) {
	for (const unsigned char ch : value) {
		if (ch <= 0x20U || ch == 0x7FU || ch == '\\') {
			return true;
		}
	}
	return false;
}

bool IsLocalCoreLink(std::string_view link) {
	constexpr std::string_view http_scheme = "http://";
	constexpr std::string_view socket_marker = "#ws://";
	if (link.size() > 8U * 1024U || !link.starts_with(http_scheme) || ContainsUnsafeUrlCharacter(link)) {
		return false;
	}

	const auto socket_position = link.find(socket_marker, http_scheme.size());
	if (socket_position == std::string_view::npos ||
		link.find(socket_marker, socket_position + socket_marker.size()) != std::string_view::npos) {
		return false;
	}

	const std::string_view http_part = link.substr(http_scheme.size(), socket_position - http_scheme.size());
	if (!http_part.ends_with('/') || http_part.size() == 1 ||
		!IsLoopbackAuthority(http_part.substr(0, http_part.size() - 1))) {
		return false;
	}

	const std::string_view socket_part = link.substr(socket_position + socket_marker.size());
	const auto path_position = socket_part.find('/');
	if (path_position == std::string_view::npos || path_position + 1 >= socket_part.size()) {
		return false;
	}
	return IsLoopbackAuthority(socket_part.substr(0, path_position));
}

} // namespace

void CoreOutputParser::Feed(std::string_view bytes) {
	if (!error_.empty() || links_.has_value() || bytes.empty()) {
		return;
	}
	if (buffer_.size() + bytes.size() > kMaxBufferedOutput) {
		Fail("omp core startup output exceeded 64 KiB");
		return;
	}
	buffer_.append(bytes);

	for (;;) {
		const auto newline = buffer_.find('\n');
		if (newline == std::string::npos) {
			return;
		}
		std::string line = buffer_.substr(0, newline);
		buffer_.erase(0, newline + 1);
		if (!line.empty() && line.back() == '\r') {
			line.pop_back();
		}
		ConsumeLine(std::move(line));
		if (!error_.empty() || links_.has_value()) {
			return;
		}
	}
}

void CoreOutputParser::Finish() {
	if (!error_.empty() || links_.has_value()) {
		return;
	}
	if (!buffer_.empty()) {
		std::string line = std::move(buffer_);
		buffer_.clear();
		if (!line.empty() && line.back() == '\r') {
			line.pop_back();
		}
		ConsumeLine(std::move(line));
	}
	if (!error_.empty() || links_.has_value()) {
		return;
	}
	Fail(control_.has_value() ? "omp core ended before emitting the session link"
								  : "omp core ended before emitting control links");
}

bool CoreOutputParser::complete() const noexcept {
	return links_.has_value();
}

const std::optional<CoreLinks>& CoreOutputParser::links() const noexcept {
	return links_;
}

const std::string& CoreOutputParser::error() const noexcept {
	return error_;
}

void CoreOutputParser::ConsumeLine(std::string line) {
	if (!control_.has_value()) {
		constexpr std::string_view prefix = "ctrl: ";
		if (!line.starts_with(prefix)) {
			Fail("omp core emitted an unexpected first stdout line");
			return;
		}
		std::string value = line.substr(prefix.size());
		if (!IsLocalCoreLink(value)) {
			Fail("omp core emitted an invalid local control link");
			return;
		}
		control_ = std::move(value);
		return;
	}

	constexpr std::string_view prefix = "session: ";
	if (!line.starts_with(prefix)) {
		Fail("omp core emitted an unexpected second stdout line");
		return;
	}
	std::string value = line.substr(prefix.size());
	if (!IsLocalCoreLink(value)) {
		Fail("omp core emitted an invalid local session link");
		return;
	}
	links_ = CoreLinks{std::move(*control_), std::move(value)};
	control_.reset();
}

void CoreOutputParser::Fail(std::string message) {
	error_ = std::move(message);
	buffer_.clear();
	control_.reset();
}

} // namespace omp::shell
