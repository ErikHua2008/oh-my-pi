#pragma once

#include "omp_shell/core_output_parser.h"

#include <windows.h>

#include <atomic>
#include <chrono>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace omp::shell {

enum class CoreEventKind {
	Ready,
	StartupFailed,
	Exited,
};

struct CoreEvent {
	CoreEventKind kind = CoreEventKind::StartupFailed;
	CoreLinks links;
	std::string detail;
	DWORD exit_code = 0;
};

struct CoreLaunch {
	std::vector<std::wstring> arguments;
	std::wstring project_directory;
	std::chrono::milliseconds startup_timeout{std::chrono::seconds(90)};
};

class CoreProcess final {
public:
	using EventHandler = std::function<void(CoreEvent)>;

	CoreProcess() = default;
	~CoreProcess();

	CoreProcess(const CoreProcess&) = delete;
	CoreProcess& operator=(const CoreProcess&) = delete;

	[[nodiscard]] bool Start(CoreLaunch launch, EventHandler handler, std::string& error);
	void Stop();

	[[nodiscard]] bool running() const noexcept;

private:
	void Monitor(CoreLaunch launch);
	void DrainStderr(HANDLE pipe);
	void AppendStderr(std::string_view bytes);
	[[nodiscard]] std::string StderrTail() const;
	void Emit(CoreEvent event) const;
	void TerminateTree();
	void CleanupHandles();

	mutable std::mutex handles_mutex_;
	mutable std::mutex stderr_mutex_;
	HANDLE process_ = nullptr;
	HANDLE job_ = nullptr;
	HANDLE stdout_read_ = nullptr;
	HANDLE stderr_read_ = nullptr;
	std::thread monitor_thread_;
	EventHandler handler_;
	std::string stderr_tail_;
	std::atomic_bool stop_requested_{false};
	std::atomic_bool running_{false};
};

[[nodiscard]] std::vector<std::wstring> ResolveOmpCommand(
	std::wstring_view configured_omp_bin = {}, std::wstring_view configured_dev_repo = {});

} // namespace omp::shell
