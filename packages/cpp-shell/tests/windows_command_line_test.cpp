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

OMP_TEST("batch command line keeps a spaced shim path inside cmd outer quotes") {
	const std::array<std::wstring, 2> arguments{L"--version", LR"(E:\project with spaces)"};
	const std::wstring command_line = omp::shell::BuildWindowsBatchCommandLine(
		LR"(C:\Windows\System32\cmd.exe)", LR"(C:\Users\Erik Hua\AppData\Roaming\npm\bun.cmd)", arguments);
	const std::wstring expected =
		LR"(C:\Windows\System32\cmd.exe /d /e:ON /v:OFF /c ""C:\Users\Erik Hua\AppData\Roaming\npm\bun.cmd" --version "E:\project with spaces"")";
	OMP_CHECK(command_line == expected);
}

OMP_TEST("batch command line neutralizes cmd metacharacters and percent expansion") {
	const std::array<std::wstring, 2> arguments{L"\"&calc.exe", L"%CMDCMDLINE:~-1%&calc.exe"};
	const std::wstring command_line =
		omp::shell::BuildWindowsBatchCommandLine(L"cmd.exe", L"npx.cmd", arguments);
	OMP_CHECK(command_line ==
		LR"(cmd.exe /d /e:ON /v:OFF /c ""npx.cmd" """&calc.exe" "%%cd:~,%CMDCMDLINE:~-1%%cd:~,%&calc.exe"")");
	OMP_CHECK(command_line.find(L"%CMDCMDLINE:~-1%&") == std::wstring::npos);
}
