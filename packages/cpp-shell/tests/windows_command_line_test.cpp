#include "test_harness.h"

#include "omp_shell/windows_command_line.h"

#include <array>

OMP_TEST("plain Windows argument is not quoted") {
	OMP_CHECK(omp::shell::QuoteWindowsArgument(L"--mode") == L"--mode");
}

OMP_TEST("empty and spaced arguments are quoted") {
	OMP_CHECK(omp::shell::QuoteWindowsArgument(L"") == L"\"\"");
	const std::wstring spaced = LR"(C:\项目 空格)";
	const std::wstring expected = L"\"C:\\项目 空格\"";
	OMP_CHECK(omp::shell::QuoteWindowsArgument(spaced) == expected);
}

OMP_TEST("quotes and trailing backslashes follow CommandLineToArgvW rules") {
	const std::wstring quoted_input = LR"(say "hello")";
	const std::wstring quoted_expected = L"\"say \\\"hello\\\"\"";
	OMP_CHECK(omp::shell::QuoteWindowsArgument(quoted_input) == quoted_expected);
	const std::wstring trailing_input = LR"(C:\path with space\)";
	const std::wstring trailing_expected = L"\"C:\\path with space\\\\\"";
	OMP_CHECK(omp::shell::QuoteWindowsArgument(trailing_input) == trailing_expected);
}

OMP_TEST("command line builder preserves argument boundaries") {
	const std::array<std::wstring, 4> arguments{L"omp", L"--cwd", LR"(C:\项目 空格)", L""};
	const std::wstring expected = L"omp --cwd \"C:\\项目 空格\" \"\"";
	OMP_CHECK(omp::shell::BuildWindowsCommandLine(arguments) == expected);
}
