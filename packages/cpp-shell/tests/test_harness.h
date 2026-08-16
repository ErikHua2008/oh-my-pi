#pragma once

#include <functional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace omp::shell::test {

struct Case {
	std::string name;
	std::function<void()> run;
};

std::vector<Case>& Registry();

class Registration final {
public:
	Registration(std::string name, std::function<void()> run);
};

[[noreturn]] inline void Fail(std::string_view expression, std::string_view file, int line) {
	std::ostringstream message;
	message << file << ':' << line << ": check failed: " << expression;
	throw std::runtime_error(message.str());
}

} // namespace omp::shell::test

#define OMP_TEST_CONCAT_INNER(left, right) left##right
#define OMP_TEST_CONCAT(left, right) OMP_TEST_CONCAT_INNER(left, right)

#define OMP_TEST(name)                                                                                                  \
	static void OMP_TEST_CONCAT(TestFunction_, __LINE__)();                                                               \
	static ::omp::shell::test::Registration OMP_TEST_CONCAT(TestRegistration_, __LINE__)(                                 \
		name, OMP_TEST_CONCAT(TestFunction_, __LINE__));                                                                     \
	static void OMP_TEST_CONCAT(TestFunction_, __LINE__)()

#define OMP_CHECK(expression)                                                                                           \
	do {                                                                                                                   \
		if (!(expression)) {                                                                                                  \
			::omp::shell::test::Fail(#expression, __FILE__, __LINE__);                                                           \
		}                                                                                                                    \
	} while (false)
