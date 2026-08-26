#pragma once

#include <filesystem>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace omp::shell {

struct ShellConfig {
	std::wstring omp_bin = L"omp";
	std::optional<std::wstring> dev_repo;
	std::optional<std::wstring> last_project;
	std::vector<std::wstring> recent_projects;
	std::map<std::wstring, std::wstring> project_names;
	std::vector<std::string> pinned_sessions;
	std::map<std::string, std::string> session_read_through;
	std::optional<int> window_x;
	std::optional<int> window_y;
	std::optional<int> window_width;
	std::optional<int> window_height;
	std::optional<bool> dark_theme;
	bool window_maximized = false;
	bool close_to_tray = true;
	bool show_all_models = false;

	void RecordProject(std::wstring project_directory);
	[[nodiscard]] bool RemoveProject(std::wstring_view project_directory);
	[[nodiscard]] std::optional<std::wstring> ProjectName(std::wstring_view project_directory) const;
	[[nodiscard]] bool SetProjectName(std::wstring project_directory, std::wstring name);
};

[[nodiscard]] std::filesystem::path DefaultConfigPath();
[[nodiscard]] std::filesystem::path DefaultGrimoireUserConfigPath();
[[nodiscard]] std::filesystem::path DefaultGrimoireTeamConfigPath();
[[nodiscard]] bool EnsureGrimoireUserConfig(const std::filesystem::path& path, std::string& error);
[[nodiscard]] ShellConfig LoadConfig(const std::filesystem::path& path);
[[nodiscard]] bool SaveConfig(const std::filesystem::path& path, const ShellConfig& config, std::string& error);

} // namespace omp::shell
