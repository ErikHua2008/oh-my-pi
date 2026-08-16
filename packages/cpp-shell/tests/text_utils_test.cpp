#include "test_harness.h"

#include "omp_shell/text_utils.h"

#include <string>

OMP_TEST("UTF conversion round trips Chinese paths and emoji") {
	const std::wstring original = L"C:\\项目 空格\\聊天🚀";
	const std::string utf8 = omp::shell::WideToUtf8(original);
	OMP_CHECK(omp::shell::Utf8ToWide(utf8) == original);
}

OMP_TEST("invalid UTF-8 is represented by a bounded diagnostic") {
	const std::string invalid{"\xC3\x28", 2};
	OMP_CHECK(omp::shell::Utf8ToWide(invalid) == L"[invalid UTF-8]");
}
