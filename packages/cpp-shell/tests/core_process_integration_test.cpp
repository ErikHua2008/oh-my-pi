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
	if (mode == "exit") {
		WriteFixtureLinks();
		Sleep(50);
		return 7;
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

OMP_TEST("CoreProcess timeout terminates a silent child") {
	omp::shell::CoreProcess process;
	EventCollector events;
	std::string error;
	OMP_CHECK(process.Start(FixtureLaunch(L"silent", 100ms),
		[&events](omp::shell::CoreEvent event) { events.Push(std::move(event)); },
		error));
	const auto failed = events.WaitFor(omp::shell::CoreEventKind::StartupFailed, 5s);
	OMP_CHECK(failed.has_value());
	OMP_CHECK(failed->detail.find("timed out") != std::string::npos);
	process.Stop();
	OMP_CHECK(!process.running());
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
