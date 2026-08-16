#pragma once

#include <optional>
#include <string>
#include <string_view>

namespace omp::shell {

struct CoreLinks {
	std::string control;
	std::string session;
};

class CoreOutputParser final {
public:
	void Feed(std::string_view bytes);
	void Finish();

	[[nodiscard]] bool complete() const noexcept;
	[[nodiscard]] const std::optional<CoreLinks>& links() const noexcept;
	[[nodiscard]] const std::string& error() const noexcept;

private:
	void ConsumeLine(std::string line);
	void Fail(std::string message);

	std::string buffer_;
	std::optional<std::string> control_;
	std::optional<CoreLinks> links_;
	std::string error_;
};

} // namespace omp::shell
