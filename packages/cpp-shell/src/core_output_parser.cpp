#include "omp_shell/core_output_parser.h"

#include <utility>

namespace omp::shell {
namespace {

constexpr std::size_t kMaxBufferedOutput = 64 * 1024;

bool IsLocalCoreLink(std::string_view link) {
	const bool local_http = link.starts_with("http://127.0.0.1:") || link.starts_with("http://localhost:");
	const bool local_socket = link.find("#ws://127.0.0.1:") != std::string_view::npos ||
		link.find("#ws://localhost:") != std::string_view::npos;
	return local_http && local_socket;
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
