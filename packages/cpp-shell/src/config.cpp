#include "omp_shell/config.h"

#include "omp_shell/path_utils.h"
#include "omp_shell/text_utils.h"

#include <ShlObj.h>
#include <windows.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <fstream>
#include <system_error>

namespace omp::shell {
namespace {

using Json = nlohmann::json;

std::optional<std::wstring> OptionalWideString(const Json& json, const char* key) {
	const auto item = json.find(key);
	if (item == json.end() || !item->is_string()) {
		return std::nullopt;
	}
	const std::wstring value = Utf8ToWide(item->get_ref<const std::string&>());
	return value.empty() ? std::nullopt : std::optional<std::wstring>(value);
}

template <typename T>
std::optional<T> OptionalNumber(const Json& json, const char* key) {
	const auto item = json.find(key);
	if (item == json.end() || !item->is_number_integer()) {
		return std::nullopt;
	}
	return item->get<T>();
}

std::filesystem::path BackupPath(const std::filesystem::path& path) {
	std::filesystem::path backup = path;
	backup += L".bak";
	return backup;
}

} // namespace

void ShellConfig::RecordProject(std::wstring project_directory) {
	const std::wstring comparable = ComparableProjectPath(project_directory);
	recent_projects.erase(std::remove_if(recent_projects.begin(),
			recent_projects.end(),
			[&comparable](const std::wstring& existing) {
				return ComparableProjectPath(existing) == comparable;
			}),
		recent_projects.end());
	recent_projects.insert(recent_projects.begin(), std::move(project_directory));
	if (recent_projects.size() > 8) {
		recent_projects.resize(8);
	}
	last_project = recent_projects.front();
}

std::optional<std::wstring> ShellConfig::ProjectName(std::wstring_view project_directory) const {
	const std::wstring comparable = ComparableProjectPath(project_directory);
	for (const auto& [path, name] : project_names) {
		if (ComparableProjectPath(path) == comparable && !name.empty()) {
			return name;
		}
	}
	return std::nullopt;
}

bool ShellConfig::SetProjectName(std::wstring project_directory, std::wstring name) {
	const auto first = name.find_first_not_of(L" \t\r\n");
	if (first == std::wstring::npos) {
		return false;
	}
	const auto last = name.find_last_not_of(L" \t\r\n");
	name = name.substr(first, last - first + 1);
	if (name.size() > 120) {
		return false;
	}
	const std::wstring comparable = ComparableProjectPath(project_directory);
	for (auto iterator = project_names.begin(); iterator != project_names.end();) {
		if (ComparableProjectPath(iterator->first) == comparable) {
			iterator = project_names.erase(iterator);
		} else {
			++iterator;
		}
	}
	project_names.emplace(std::move(project_directory), std::move(name));
	return true;
}

std::filesystem::path DefaultConfigPath() {
	PWSTR app_data = nullptr;
	if (FAILED(SHGetKnownFolderPath(FOLDERID_RoamingAppData, KF_FLAG_CREATE, nullptr, &app_data))) {
		return std::filesystem::path(L"config.json");
	}
	std::filesystem::path path(app_data);
	CoTaskMemFree(app_data);
	path /= L"io.omp.cpp-shell";
	path /= L"config.json";
	return path;
}

ShellConfig LoadConfig(const std::filesystem::path& path) {
	std::ifstream input(path, std::ios::binary);
	if (!input) {
		return {};
	}
	try {
		const Json json = Json::parse(input);
		ShellConfig config;
		if (const auto value = OptionalWideString(json, "ompBin")) {
			config.omp_bin = *value;
		}
		config.dev_repo = OptionalWideString(json, "devRepo");
		config.last_project = OptionalWideString(json, "lastProject");
		if (const auto projects = json.find("recentProjects"); projects != json.end() && projects->is_array()) {
			for (const auto& project : *projects) {
				if (project.is_string() && config.recent_projects.size() < 8) {
					config.recent_projects.push_back(Utf8ToWide(project.get_ref<const std::string&>()));
				}
			}
		}
		if (const auto names = json.find("projectNames"); names != json.end() && names->is_object()) {
			for (const auto& [project_path, name] : names->items()) {
				if (name.is_string()) {
					config.project_names.emplace(
						Utf8ToWide(project_path), Utf8ToWide(name.get_ref<const std::string&>()));
				}
			}
		}
		if (const auto pinned = json.find("pinnedSessions"); pinned != json.end() && pinned->is_array()) {
			for (const auto& session : *pinned) {
				if (session.is_string() && config.pinned_sessions.size() < 1000) {
					config.pinned_sessions.push_back(session.get_ref<const std::string&>());
				}
			}
		}
		if (const auto read_through = json.find("sessionReadThrough");
			read_through != json.end() && read_through->is_object()) {
			for (const auto& [session, timestamp] : read_through->items()) {
				if (timestamp.is_string() && config.session_read_through.size() < 5000) {
					config.session_read_through.emplace(session, timestamp.get_ref<const std::string&>());
				}
			}
		}
		config.window_x = OptionalNumber<int>(json, "windowX");
		config.window_y = OptionalNumber<int>(json, "windowY");
		config.window_width = OptionalNumber<int>(json, "windowWidth");
		config.window_height = OptionalNumber<int>(json, "windowHeight");
		config.window_maximized = json.value("windowMaximized", false);
		config.close_to_tray = json.value("closeToTray", true);
		return config;
	} catch (const std::exception&) {
		std::error_code ignored;
		std::filesystem::copy_file(path, BackupPath(path), std::filesystem::copy_options::overwrite_existing, ignored);
		return {};
	}
}

bool SaveConfig(const std::filesystem::path& path, const ShellConfig& config, std::string& error) {
	Json json;
	json["ompBin"] = WideToUtf8(config.omp_bin);
	json["devRepo"] = config.dev_repo ? Json(WideToUtf8(*config.dev_repo)) : Json(nullptr);
	json["lastProject"] = config.last_project ? Json(WideToUtf8(*config.last_project)) : Json(nullptr);
	json["recentProjects"] = Json::array();
	for (const auto& project : config.recent_projects) {
		json["recentProjects"].push_back(WideToUtf8(project));
	}
	json["projectNames"] = Json::object();
	for (const auto& [path_key, name] : config.project_names) {
		json["projectNames"][WideToUtf8(path_key)] = WideToUtf8(name);
	}
	json["pinnedSessions"] = config.pinned_sessions;
	json["sessionReadThrough"] = config.session_read_through;
	json["windowX"] = config.window_x ? Json(*config.window_x) : Json(nullptr);
	json["windowY"] = config.window_y ? Json(*config.window_y) : Json(nullptr);
	json["windowWidth"] = config.window_width ? Json(*config.window_width) : Json(nullptr);
	json["windowHeight"] = config.window_height ? Json(*config.window_height) : Json(nullptr);
	json["windowMaximized"] = config.window_maximized;
	json["closeToTray"] = config.close_to_tray;

	std::error_code directory_error;
	if (!path.parent_path().empty()) {
		std::filesystem::create_directories(path.parent_path(), directory_error);
	}
	if (directory_error) {
		error = "creating shell config directory failed: " + directory_error.message();
		return false;
	}
	std::filesystem::path temporary = path;
	temporary += L".tmp";
	{
		std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
		if (!output) {
			error = "opening temporary shell config failed";
			return false;
		}
		output << json.dump(2) << '\n';
		output.flush();
		if (!output) {
			error = "writing temporary shell config failed";
			return false;
		}
	}
	if (!MoveFileExW(temporary.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
		error = "replacing shell config failed: " +
			std::system_category().message(static_cast<int>(GetLastError()));
		std::error_code ignored;
		std::filesystem::remove(temporary, ignored);
		return false;
	}
	return true;
}

} // namespace omp::shell
