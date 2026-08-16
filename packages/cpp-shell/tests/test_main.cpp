#include "test_harness.h"

#include <exception>
#include <iostream>

int RunCoreProcessFixtureIfRequested(int argc, char** argv);

namespace omp::shell::test {

std::vector<Case>& Registry() {
	static std::vector<Case> registry;
	return registry;
}

Registration::Registration(std::string name, std::function<void()> run) {
	Registry().push_back(Case{std::move(name), std::move(run)});
}

} // namespace omp::shell::test

int main(int argc, char** argv) {
	const int fixture_result = RunCoreProcessFixtureIfRequested(argc, argv);
	if (fixture_result >= 0) {
		return fixture_result;
	}
	int failures = 0;
	for (const auto& test : omp::shell::test::Registry()) {
		try {
			test.run();
			std::cout << "[pass] " << test.name << '\n';
		} catch (const std::exception& error) {
			++failures;
			std::cerr << "[fail] " << test.name << ": " << error.what() << '\n';
		}
	}
	std::cout << (omp::shell::test::Registry().size() - static_cast<std::size_t>(failures)) << " passed, "
			  << failures << " failed\n";
	return failures == 0 ? 0 : 1;
}
