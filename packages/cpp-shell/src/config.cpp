#include "omp_shell/config.h"

#include "omp_shell/path_utils.h"
#include "omp_shell/text_utils.h"

#include <ShlObj.h>
#include <windows.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdint>
#include <fstream>
#include <system_error>

namespace omp::shell {
namespace {

using Json = nlohmann::json;
constexpr std::uintmax_t kMaximumConfigBytes = 8 * 1024 * 1024;
constexpr std::size_t kMaximumPathBytes = 32 * 1024;
constexpr std::size_t kMaximumSessionIdBytes = 512;
constexpr std::size_t kMaximumTimestampBytes = 128;
constexpr char kGrimoireUserConfigTemplate[] = R"toml(# Grimoire Router App personal overrides.
# This file is loaded after C:\ProgramData\Grimoire Router App\config.toml.
# Uncomment only the values you want to override, then restart the app.
# Never store an API key here. The key is read from the environment variable
# named by provider.env_key.

# [provider]
# base_url = "https://router.hddev.top/v1"
# api = "openai-responses"
# env_key = "GRIMOIRE_API_KEY"

# [models]
# discover = true
# default = "gpt-5.5"
# default_effort = "xhigh"
# exclude = ["gpt-image-*"]
# fallback = ["gpt-5.4", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]
)toml";

std::filesystem::path KnownFolderPath(const KNOWNFOLDERID& folder, DWORD flags) {
	PWSTR value = nullptr;
	if (FAILED(SHGetKnownFolderPath(folder, flags, nullptr, &value))) {
		return {};
	}
	std::filesystem::path path(value);
	CoTaskMemFree(value);
	return path;
}

std::optional<std::wstring> OptionalWideString(const Json& json, const char* key) {
	const auto item = json.find(key);
	if (item == json.end() || !item->is_string()) {
		return std::nullopt;
	}
	const std::string& encoded = item->get_ref<const std::string&>();
	if (encoded.size() > kMaximumPathBytes) {
		return std::nullopt;
	}
	const std::wstring value = Utf8ToWide(encoded);
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

bool ShellConfig::RemoveProject(std::wstring_view project_directory) {
	const std::wstring comparable = ComparableProjectPath(project_directory);
	const auto original_size = recent_projects.size();
	recent_projects.erase(std::remove_if(recent_projects.begin(),
			recent_projects.end(),
			[&comparable](const std::wstring& existing) {
				return ComparableProjectPath(existing) == comparable;
			}),
		recent_projects.end());
	for (auto iterator = project_names.begin(); iterator != project_names.end();) {
		if (ComparableProjectPath(iterator->first) == comparable) {
			iterator = project_names.erase(iterator);
		} else {
			++iterator;
		}
	}
	if (last_project && ComparableProjectPath(*last_project) == comparable) {
		last_project = recent_projects.empty()
			? std::nullopt
			: std::optional<std::wstring>(recent_projects.front());
	}
	return recent_projects.size() != original_size;
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
	if (project_directory.empty()) {
		return false;
	}
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
	std::filesystem::path path = KnownFolderPath(FOLDERID_RoamingAppData, KF_FLAG_CREATE);
	if (path.empty()) {
		return std::filesystem::path(L"config.json");
	}
	path /= L"io.omp.cpp-shell";
	path /= L"config.json";
	return path;
}

std::filesystem::path DefaultGrimoireUserConfigPath() {
	std::filesystem::path path = KnownFolderPath(FOLDERID_RoamingAppData, KF_FLAG_CREATE);
	if (path.empty()) {
		return std::filesystem::path(L"config.toml");
	}
	path /= L"io.omp.cpp-shell";
	path /= L"config.toml";
	return path;
}

std::filesystem::path DefaultGrimoireTeamConfigPath() {
	std::filesystem::path path = KnownFolderPath(FOLDERID_ProgramData, KF_FLAG_DEFAULT);
	if (path.empty()) {
		return {};
	}
	path /= L"Grimoire Router App";
	path /= L"config.toml";
	return path;
}

bool EnsureGrimoireUserConfig(const std::filesystem::path& path, std::string& error) {
	if (path.empty()) {
		error = "Grimoire user config path is unavailable";
		return false;
	}
	std::error_code status_error;
	if (std::filesystem::exists(path, status_error)) {
		if (!std::filesystem::is_regular_file(path, status_error) || status_error) {
			error = "Grimoire user config path is not a regular file";
			return false;
		}
		return true;
	}
	if (status_error) {
		error = "checking Grimoire user config failed: " + status_error.message();
		return false;
	}

	std::error_code directory_error;
	if (!path.parent_path().empty()) {
		std::filesystem::create_directories(path.parent_path(), directory_error);
	}
	if (directory_error) {
		error = "creating Grimoire user config directory failed: " + directory_error.message();
		return false;
	}

	const HANDLE file = CreateFileW(path.c_str(),
		GENERIC_WRITE,
		FILE_SHARE_READ,
		nullptr,
		CREATE_NEW,
		FILE_ATTRIBUTE_NORMAL,
		nullptr);
	if (file == INVALID_HANDLE_VALUE) {
		const DWORD open_error = GetLastError();
		if (open_error == ERROR_FILE_EXISTS || open_error == ERROR_ALREADY_EXISTS) {
			std::error_code existing_error;
			if (std::filesystem::is_regular_file(path, existing_error) && !existing_error) {
				return true;
			}
			error = "Grimoire user config path is not a regular file";
			return false;
		}
		error = "creating Grimoire user config failed: " +
			std::system_category().message(static_cast<int>(open_error));
		return false;
	}

	DWORD written = 0;
	const DWORD template_size = static_cast<DWORD>(sizeof(kGrimoireUserConfigTemplate) - 1);
	const bool write_succeeded = WriteFile(file, kGrimoireUserConfigTemplate, template_size, &written, nullptr) != FALSE;
	const DWORD write_error = write_succeeded ? ERROR_WRITE_FAULT : GetLastError();
	const bool saved = write_succeeded && written == template_size;
	CloseHandle(file);
	if (!saved) {
		error = "writing Grimoire user config failed: " +
			std::system_category().message(static_cast<int>(write_error));
		std::error_code ignored;
		std::filesystem::remove(path, ignored);
		return false;
	}
	return true;
}

ShellConfig LoadConfig(const std::filesystem::path& path) {
	std::error_code size_error;
	const std::uintmax_t file_size = std::filesystem::file_size(path, size_error);
	if (!size_error && file_size > kMaximumConfigBytes) {
		std::error_code ignored;
		std::filesystem::copy_file(path, BackupPath(path), std::filesystem::copy_options::overwrite_existing, ignored);
		return {};
	}
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
				if (project.is_string() && project.get_ref<const std::string&>().size() <= kMaximumPathBytes &&
					config.recent_projects.size() < 8) {
					config.recent_projects.push_back(Utf8ToWide(project.get_ref<const std::string&>()));
				}
			}
		}
		if (const auto names = json.find("projectNames"); names != json.end() && names->is_object()) {
			for (const auto& [project_path, name] : names->items()) {
				if (name.is_string() && project_path.size() <= kMaximumPathBytes && config.project_names.size() < 256) {
					static_cast<void>(config.SetProjectName(
						Utf8ToWide(project_path), Utf8ToWide(name.get_ref<const std::string&>())));
				}
			}
		}
		if (const auto pinned = json.find("pinnedSessions"); pinned != json.end() && pinned->is_array()) {
			for (const auto& session : *pinned) {
				if (session.is_string() && !session.get_ref<const std::string&>().empty() &&
					session.get_ref<const std::string&>().size() <= kMaximumSessionIdBytes &&
					config.pinned_sessions.size() < 1000) {
					config.pinned_sessions.push_back(session.get_ref<const std::string&>());
				}
			}
		}
		if (const auto read_through = json.find("sessionReadThrough");
			read_through != json.end() && read_through->is_object()) {
			for (const auto& [session, timestamp] : read_through->items()) {
				if (!session.empty() && session.size() <= kMaximumSessionIdBytes && timestamp.is_string() &&
					timestamp.get_ref<const std::string&>().size() <= kMaximumTimestampBytes &&
					config.session_read_through.size() < 5000) {
					config.session_read_through.emplace(session, timestamp.get_ref<const std::string&>());
				}
			}
		}
		config.window_x = OptionalNumber<int>(json, "windowX");
		config.window_y = OptionalNumber<int>(json, "windowY");
		config.window_width = OptionalNumber<int>(json, "windowWidth");
		config.window_height = OptionalNumber<int>(json, "windowHeight");
		if (const auto theme = json.find("darkTheme"); theme != json.end() && theme->is_boolean()) {
			config.dark_theme = theme->get<bool>();
		}
		config.window_maximized = json.value("windowMaximized", false);
		config.close_to_tray = json.value("closeToTray", true);
		config.show_all_models = json.value("showAllModels", false);
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
	json["darkTheme"] = config.dark_theme ? Json(*config.dark_theme) : Json(nullptr);
	json["windowMaximized"] = config.window_maximized;
	json["closeToTray"] = config.close_to_tray;
	json["showAllModels"] = config.show_all_models;

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
