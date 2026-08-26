#include "test_harness.h"

#include "omp_shell/core_process.h"

#include <windows.h>

#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace {

using namespace std::chrono_literals;

class EventCollector final {
public:
	void Push(omp::shell::CoreEvent event) {
		{
			std::scoped_lock lock(mutex_);
			events_.push_back(std::move(event));
		}
		changed_.notify_all();
	}

	std::optional<omp::shell::CoreEvent> WaitFor(omp::shell::CoreEventKind kind, std::chrono::milliseconds timeout) {
		std::unique_lock lock(mutex_);
		const bool found = changed_.wait_for(lock, timeout, [this, kind] {
			for (const auto& event : events_) {
				if (event.kind == kind) {
					return true;
				}
			}
			return false;
		});
		if (!found) {
			return std::nullopt;
		}
		for (const auto& event : events_) {
			if (event.kind == kind) {
				return event;
			}
		}
		return std::nullopt;
	}

private:
	std::mutex mutex_;
	std::condition_variable changed_;
	std::vector<omp::shell::CoreEvent> events_;
};

std::wstring CurrentExecutable() {
	std::wstring path(32768, L'\0');
	const DWORD length = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
	path.resize(static_cast<std::size_t>(length));
	return path;
}

omp::shell::CoreLaunch FixtureLaunch(std::wstring mode, std::chrono::milliseconds timeout = 3s) {
	omp::shell::CoreLaunch launch;
	launch.arguments = {CurrentExecutable(), L"--fake-core", std::move(mode)};
	launch.project_directory = std::filesystem::current_path().wstring();
	launch.startup_timeout = timeout;
	return launch;
}

class BatchShim final {
public:
	BatchShim() {
		path_ = std::filesystem::path(CurrentExecutable()).parent_path() / L"omp core fixture.cmd";
		std::ofstream output(path_, std::ios::binary | std::ios::trunc);
		output << "@echo off\r\n\"%~dp0omp_shell_tests.exe\" --fake-core success\r\n";
	}

	~BatchShim() {
		std::error_code ignored;
		std::filesystem::remove(path_, ignored);
	}

	[[nodiscard]] const std::filesystem::path& path() const noexcept {
		return path_;
	}

private:
	std::filesystem::path path_;
};

class ScopedEnvironmentVariable final {
public:
	ScopedEnvironmentVariable(std::wstring name, const wchar_t* value) : name_(std::move(name)) {
		SetLastError(ERROR_SUCCESS);
		const DWORD required = GetEnvironmentVariableW(name_.c_str(), nullptr, 0);
		if (required != 0) {
			previous_.resize(required - 1);
			GetEnvironmentVariableW(name_.c_str(), previous_.data(), required);
			was_present_ = true;
		} else {
			was_present_ = GetLastError() != ERROR_ENVVAR_NOT_FOUND;
		}
		SetEnvironmentVariableW(name_.c_str(), value);
	}

	~ScopedEnvironmentVariable() {
		SetEnvironmentVariableW(name_.c_str(), was_present_ ? previous_.c_str() : nullptr);
	}

	ScopedEnvironmentVariable(const ScopedEnvironmentVariable&) = delete;
	ScopedEnvironmentVariable& operator=(const ScopedEnvironmentVariable&) = delete;

private:
	std::wstring name_;
	std::wstring previous_;
	bool was_present_ = false;
};

void WriteFixtureLinks() {
	std::cout << "ctrl: http://127.0.0.1:43210/#ws://127.0.0.1:43210/r/ctrl-fixture\n"
				  << "session: http://127.0.0.1:43210/#ws://127.0.0.1:43210/r/session-fixture\n"
				  << std::flush;
}

} // namespace

int RunCoreProcessFixtureIfRequested(int argc, char** argv) {
	if (argc < 3 || std::string_view(argv[1]) != "--fake-core") {
		return -1;
	}
	const std::string_view mode(argv[2]);
	if (mode == "success") {
		WriteFixtureLinks();
		Sleep(60'000);
		return 0;
	}
	if (mode == "native-gui-host") {
		wchar_t value[8]{};
		const DWORD length = GetEnvironmentVariableW(L"OMP_NATIVE_GUI_HOST", value, static_cast<DWORD>(std::size(value)));
		wchar_t grimoire[8]{};
		const DWORD grimoire_length =
			GetEnvironmentVariableW(L"OMP_GRIMOIRE_MODE", grimoire, static_cast<DWORD>(std::size(grimoire)));
		if (length != 1 || value[0] != L'1' || grimoire_length != 1 || grimoire[0] != L'1' ||
			GetConsoleWindow() != nullptr) return 8;
		WriteFixtureLinks();
		Sleep(60'000);
		return 0;
	}
	if (mode == "slow-success") {
		Sleep(80);
		WriteFixtureLinks();
		Sleep(60'000);
		return 0;
	}
	if (mode == "exit") {
		WriteFixtureLinks();
		Sleep(50);
		return 7;
	}
	if (mode == "stdout-flood") {
		WriteFixtureLinks();
		const std::string chunk(4096, 'x');
		for (int index = 0; index < 512; ++index) {
			std::cout.write(chunk.data(), static_cast<std::streamsize>(chunk.size()));
		}
		std::cout << std::flush;
		return 9;
	}
	if (mode == "malformed") {
		std::cout << "debug token=must-not-leak\n" << std::flush;
		std::cerr << "safe fixture diagnostic\n" << std::flush;
		return 3;
	}
	if (mode == "silent") {
		Sleep(60'000);
		return 0;
	}
	return 2;
}

OMP_TEST("CoreProcess reports ready and synchronously reaps a stopped child tree") {
	omp::shell::CoreProcess process;
	EventCollector events;
	std::string error;
	OMP_CHECK(process.Start(FixtureLaunch(L"success"),
		[&events](omp::shell::CoreEvent event) { events.Push(std::move(event)); },
		error));
	const auto ready = events.WaitFor(omp::shell::CoreEventKind::Ready, 5s);
	OMP_CHECK(ready.has_value());
	OMP_CHECK(ready->links.control.find("ctrl-fixture") != std::string::npos);
	const auto stop_started = std::chrono::steady_clock::now();
	process.Stop();
	OMP_CHECK(!process.running());
	OMP_CHECK(std::chrono::steady_clock::now() - stop_started < 2s);
}

OMP_TEST("CoreProcess marks its descendant tree as a hidden native GUI host") {
	ScopedEnvironmentVariable existing_marker(L"OMP_NATIVE_GUI_HOST", L"parent-value");
	ScopedEnvironmentVariable existing_grimoire_mode(L"OMP_GRIMOIRE_MODE", L"parent-grimoire");
	omp::shell::CoreProcess process;
	EventCollector events;
	std::string error;
	OMP_CHECK(process.Start(FixtureLaunch(L"native-gui-host"),
		[&events](omp::shell::CoreEvent event) { events.Push(std::move(event)); },
		error));
	wchar_t parent_value[32]{};
	const DWORD parent_length =
		GetEnvironmentVariableW(L"OMP_NATIVE_GUI_HOST", parent_value, static_cast<DWORD>(std::size(parent_value)));
	OMP_CHECK(parent_length == 12);
	OMP_CHECK(std::wstring_view(parent_value, parent_length) == L"parent-value");
	wchar_t parent_grimoire[32]{};
	const DWORD parent_grimoire_length = GetEnvironmentVariableW(
		L"OMP_GRIMOIRE_MODE", parent_grimoire, static_cast<DWORD>(std::size(parent_grimoire)));
	OMP_CHECK(parent_grimoire_length == 15);
	OMP_CHECK(std::wstring_view(parent_grimoire, parent_grimoire_length) == L"parent-grimoire");
	OMP_CHECK(events.WaitFor(omp::shell::CoreEventKind::Ready, 5s).has_value());
	process.Stop();
}

OMP_TEST("CoreProcess launches a cmd shim whose path contains spaces") {
	const BatchShim shim;
	OMP_CHECK(std::filesystem::exists(shim.path()));
	omp::shell::CoreLaunch launch;
	launch.arguments = {shim.path().wstring()};
	launch.project_directory = std::filesystem::current_path().wstring();

	omp::shell::CoreProcess process;
	EventCollector events;
	std::string error;
	OMP_CHECK(process.Start(std::move(launch),
		[&events](omp::shell::CoreEvent event) { events.Push(std::move(event)); },
		error));
	OMP_CHECK(events.WaitFor(omp::shell::CoreEventKind::Ready, 5s).has_value());
	process.Stop();
	OMP_CHECK(!process.running());
}

OMP_TEST("CoreProcess reports an unexpected post-start exit code") {
	omp::shell::CoreProcess process;
	EventCollector events;
	std::string error;
	OMP_CHECK(process.Start(FixtureLaunch(L"exit"),
		[&events](omp::shell::CoreEvent event) { events.Push(std::move(event)); },
		error));
	OMP_CHECK(events.WaitFor(omp::shell::CoreEventKind::Ready, 5s).has_value());
	const auto exited = events.WaitFor(omp::shell::CoreEventKind::Exited, 5s);
	OMP_CHECK(exited.has_value());
	OMP_CHECK(exited->exit_code == 7);
	process.Stop();
}

OMP_TEST("CoreProcess continuously drains stdout after startup") {
	omp::shell::CoreProcess process;
	EventCollector events;
	std::string error;
	OMP_CHECK(process.Start(FixtureLaunch(L"stdout-flood"),
		[&events](omp::shell::CoreEvent event) { events.Push(std::move(event)); },
		error));
	OMP_CHECK(events.WaitFor(omp::shell::CoreEventKind::Ready, 5s).has_value());
	const auto exited = events.WaitFor(omp::shell::CoreEventKind::Exited, 5s);
	OMP_CHECK(exited.has_value());
	OMP_CHECK(exited->exit_code == 9);
	process.Stop();
}

OMP_TEST("CoreProcess timeout terminates a silent child") {
	omp::shell::CoreProcess process;
	EventCollector events;
	std::string error;
	auto launch = FixtureLaunch(L"silent", 150ms);
	launch.startup_slow_threshold = 30ms;
	OMP_CHECK(process.Start(std::move(launch),
		[&events](omp::shell::CoreEvent event) { events.Push(std::move(event)); },
		error));
	const auto slow = events.WaitFor(omp::shell::CoreEventKind::StartupSlow, 5s);
	OMP_CHECK(slow.has_value());
	OMP_CHECK(slow->detail.find("has not emitted") != std::string::npos);
	const auto failed = events.WaitFor(omp::shell::CoreEventKind::StartupFailed, 5s);
	OMP_CHECK(failed.has_value());
	OMP_CHECK(failed->detail.find("timed out") != std::string::npos);
	process.Stop();
	OMP_CHECK(!process.running());
}

OMP_TEST("CoreProcess can report slow startup and still become ready") {
	omp::shell::CoreProcess process;
	EventCollector events;
	std::string error;
	auto launch = FixtureLaunch(L"slow-success", 2s);
	launch.startup_slow_threshold = 20ms;
	OMP_CHECK(process.Start(std::move(launch),
		[&events](omp::shell::CoreEvent event) { events.Push(std::move(event)); },
		error));
	OMP_CHECK(events.WaitFor(omp::shell::CoreEventKind::StartupSlow, 5s).has_value());
	OMP_CHECK(events.WaitFor(omp::shell::CoreEventKind::Ready, 5s).has_value());
	process.Stop();
	OMP_CHECK(!process.running());
}

OMP_TEST("development repository is discovered above a nested shell executable") {
	const std::filesystem::path root = std::filesystem::temp_directory_path() /
		(L"omp-cpp-shell-repo-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()));
	const std::filesystem::path marker = root / L"packages" / L"coding-agent" / L"src" / L"cli.ts";
	const std::filesystem::path executable =
		root / L"packages" / L"cpp-shell" / L"out" / L"build" / L"windows-msvc" / L"Release" / L"omp-cpp-shell.exe";
	std::error_code error;
	std::filesystem::create_directories(marker.parent_path(), error);
	OMP_CHECK(!error);
	std::filesystem::create_directories(executable.parent_path(), error);
	OMP_CHECK(!error);
	{
		std::ofstream output(marker, std::ios::binary | std::ios::trunc);
		output << "// fixture\n";
	}
	const auto detected = omp::shell::FindDevelopmentRepository(executable);
	std::filesystem::remove_all(root, error);
	OMP_CHECK(detected.has_value());
	OMP_CHECK(*detected == root);
}

OMP_TEST("configured development repository prefers bundle and explicit override keeps source mode") {
	const std::filesystem::path root = std::filesystem::temp_directory_path() /
		(L"omp-cpp-shell-bundle-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()));
	const std::filesystem::path source = root / L"packages" / L"coding-agent" / L"src" / L"cli.ts";
	const std::filesystem::path bundle = root / L"packages" / L"coding-agent" / L"dist" / L"cli.js";
	std::error_code error;
	std::filesystem::create_directories(source.parent_path(), error);
	OMP_CHECK(!error);
	std::filesystem::create_directories(bundle.parent_path(), error);
	OMP_CHECK(!error);
	{
		std::ofstream output(source, std::ios::binary | std::ios::trunc);
		output << "// source fixture\n";
	}
	{
		std::ofstream output(bundle, std::ios::binary | std::ios::trunc);
		output << "// bundle fixture\n";
	}

	ScopedEnvironmentVariable clear_override(L"OMP_CPP_SHELL_DEV_REPO", nullptr);
	const auto bundled_command = omp::shell::ResolveOmpCommand({}, root.wstring());
	OMP_CHECK(bundled_command.size() == 3);
	OMP_CHECK(bundled_command[2] == L"dist/cli.js");

	{
		ScopedEnvironmentVariable source_override(L"OMP_CPP_SHELL_DEV_REPO", root.c_str());
		const auto source_command = omp::shell::ResolveOmpCommand({}, root.wstring());
		OMP_CHECK(source_command.size() == 3);
		OMP_CHECK(source_command[2] == L"src/cli.ts");
	}

	std::filesystem::remove(bundle, error);
	OMP_CHECK(!error);
	const auto fallback_command = omp::shell::ResolveOmpCommand({}, root.wstring());
	std::filesystem::remove_all(root, error);
	OMP_CHECK(fallback_command.size() == 3);
	OMP_CHECK(fallback_command[2] == L"src/cli.ts");
}

OMP_TEST("CoreProcess startup diagnostics do not echo unexpected stdout secrets") {
	omp::shell::CoreProcess process;
	EventCollector events;
	std::string error;
	OMP_CHECK(process.Start(FixtureLaunch(L"malformed"),
		[&events](omp::shell::CoreEvent event) { events.Push(std::move(event)); },
		error));
	const auto failed = events.WaitFor(omp::shell::CoreEventKind::StartupFailed, 5s);
	OMP_CHECK(failed.has_value());
	OMP_CHECK(failed->detail.find("must-not-leak") == std::string::npos);
	OMP_CHECK(failed->detail.find("safe fixture diagnostic") != std::string::npos);
	process.Stop();
}
