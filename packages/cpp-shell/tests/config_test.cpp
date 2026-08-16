#include "test_harness.h"

#include "omp_shell/config.h"

#include <windows.h>

#include <filesystem>
#include <fstream>
#include <iterator>
#include <optional>
#include <string>

namespace {

class TemporaryDirectory final {
public:
	TemporaryDirectory() {
		path_ = std::filesystem::temp_directory_path() /
			(L"omp-cpp-shell-test-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()));
		std::filesystem::create_directories(path_);
	}

	~TemporaryDirectory() {
		std::error_code ignored;
		std::filesystem::remove_all(path_, ignored);
	}

	[[nodiscard]] const std::filesystem::path& path() const noexcept {
		return path_;
	}

private:
	std::filesystem::path path_;
};

} // namespace

OMP_TEST("shell config round trips Unicode projects and window state without credential fields") {
	TemporaryDirectory directory;
	const auto path = directory.path() / L"config.json";
	omp::shell::ShellConfig config;
	config.omp_bin = LR"(C:\工具\omp.exe)";
	config.dev_repo = LR"(C:\源码\oh my pi)";
	config.RecordProject(LR"(C:\项目 一)");
	config.RecordProject(LR"(D:\项目 二)");
	OMP_CHECK(config.SetProjectName(LR"(D:\项目 二)", L"重要项目"));
	config.pinned_sessions = {"session-a"};
	config.session_read_through = {{"session-a", "2026-08-15T20:00:00.000Z"}};
	config.window_x = 120;
	config.window_y = 80;
	config.window_width = 1440;
	config.window_height = 900;
	config.window_maximized = true;
	std::string error;
	OMP_CHECK(omp::shell::SaveConfig(path, config, error));

	const omp::shell::ShellConfig loaded = omp::shell::LoadConfig(path);
	OMP_CHECK(loaded.omp_bin == config.omp_bin);
	OMP_CHECK(loaded.dev_repo == config.dev_repo);
	OMP_CHECK(loaded.last_project == std::optional<std::wstring>(LR"(D:\项目 二)"));
	OMP_CHECK(loaded.recent_projects.size() == 2);
	OMP_CHECK(loaded.ProjectName(LR"(d:\项目 二\)") == std::optional<std::wstring>(L"重要项目"));
	OMP_CHECK(loaded.pinned_sessions == config.pinned_sessions);
	OMP_CHECK(loaded.session_read_through == config.session_read_through);
	OMP_CHECK(loaded.window_width == 1440);
	OMP_CHECK(loaded.window_maximized);

	std::ifstream input(path, std::ios::binary);
	const std::string serialized((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
	OMP_CHECK(serialized.find("apiKey") == std::string::npos);
	OMP_CHECK(serialized.find("token") == std::string::npos);
}

OMP_TEST("project aliases reject blank and oversized names") {
	omp::shell::ShellConfig config;
	OMP_CHECK(!config.SetProjectName(L"C:\\repo", L"   "));
	OMP_CHECK(!config.SetProjectName(L"C:\\repo", std::wstring(121, L'x')));
	OMP_CHECK(config.SetProjectName(L"C:\\repo", L"  Display Name  "));
	OMP_CHECK(config.ProjectName(L"c:/repo") == std::optional<std::wstring>(L"Display Name"));
}

OMP_TEST("recording projects deduplicates equivalent Windows paths and caps recents") {
	omp::shell::ShellConfig config;
	config.RecordProject(LR"(\\?\C:\Work\OMP\)");
	config.RecordProject(L"c:/work/omp");
	OMP_CHECK(config.recent_projects.size() == 1);
	for (int index = 0; index < 12; ++index) {
		config.RecordProject(L"C:\\project-" + std::to_wstring(index));
	}
	OMP_CHECK(config.recent_projects.size() == 8);
	OMP_CHECK(config.last_project == std::optional<std::wstring>(L"C:\\project-11"));
}

OMP_TEST("corrupt shell config is backed up and replaced with safe defaults in memory") {
	TemporaryDirectory directory;
	const auto path = directory.path() / L"config.json";
	{
		std::ofstream output(path, std::ios::binary);
		output << "{ definitely-not-json";
	}
	const omp::shell::ShellConfig loaded = omp::shell::LoadConfig(path);
	OMP_CHECK(loaded.omp_bin == L"omp");
	OMP_CHECK(!loaded.last_project.has_value());
	std::filesystem::path backup = path;
	backup += L".bak";
	OMP_CHECK(std::filesystem::exists(backup));
}
