#include "test_harness.h"

#include "omp_shell/path_utils.h"

OMP_TEST("verbatim drive path becomes a Bun-compatible CLI path") {
	OMP_CHECK(omp::shell::PathForCli(LR"(\\?\C:\项目 空格\repo)") == LR"(C:\项目 空格\repo)");
}

OMP_TEST("verbatim UNC path becomes an ordinary UNC path") {
	OMP_CHECK(omp::shell::PathForCli(LR"(\\?\UNC\server\share\repo)") == LR"(\\server\share\repo)");
}

OMP_TEST("project comparison ignores case separators trailing slash and verbatim prefix") {
	const auto left = omp::shell::ComparableProjectPath(LR"(\\?\C:\Work\OMP\)");
	const auto right = omp::shell::ComparableProjectPath(L"c:/work/omp");
	OMP_CHECK(left == right);
}
