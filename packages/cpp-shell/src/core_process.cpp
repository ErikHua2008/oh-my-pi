#include "omp_shell/core_process.h"

#include "omp_shell/path_utils.h"
#include "omp_shell/text_utils.h"
#include "omp_shell/windows_command_line.h"

#include <algorithm>
#include <array>
#include <cstdlib>
#include <filesystem>
#include <system_error>
#include <utility>

namespace omp::shell {
namespace {

constexpr std::size_t kStderrTailBytes = 4096;

struct PipePair {
	HANDLE read = nullptr;
	HANDLE write = nullptr;
};

void CloseIfValid(HANDLE& handle) {
	if (handle != nullptr && handle != INVALID_HANDLE_VALUE) {
		CloseHandle(handle);
		handle = nullptr;
	}
}

std::wstring SearchExecutable(std::wstring_view name) {
	if (name.empty()) {
		return {};
	}
	const std::wstring value(name);
	for (const wchar_t* extension : {L".exe", L".cmd", L".bat"}) {
		DWORD required = SearchPathW(nullptr, value.c_str(), extension, 0, nullptr, nullptr);
		if (required == 0) {
			continue;
		}
		std::wstring result(static_cast<std::size_t>(required), L'\0');
		const DWORD written = SearchPathW(
			nullptr, value.c_str(), extension, static_cast<DWORD>(result.size() + 1), result.data(), nullptr);
		if (written != 0 && written < result.size() + 1) {
			result.resize(written);
			return result;
		}
	}
	return value;
}

std::vector<std::wstring> BuildCommandForExecutable(std::wstring executable) {
	const std::wstring extension = std::filesystem::path(executable).extension().wstring();
	if (_wcsicmp(extension.c_str(), L".cmd") == 0 || _wcsicmp(extension.c_str(), L".bat") == 0) {
		wchar_t system_directory[MAX_PATH]{};
		const UINT length = GetSystemDirectoryW(system_directory, static_cast<UINT>(std::size(system_directory)));
		if (length != 0 && length < std::size(system_directory)) {
			std::wstring command_interpreter(system_directory, length);
			command_interpreter.append(L"\\cmd.exe");
			return {std::move(command_interpreter), L"/d", L"/s", L"/c", std::move(executable)};
		}
	}
	return {std::move(executable)};
}

bool CreateChildOutputPipe(PipePair& pipe, std::string& error) {
	SECURITY_ATTRIBUTES security{};
	security.nLength = sizeof(security);
	security.bInheritHandle = TRUE;
	if (!CreatePipe(&pipe.read, &pipe.write, &security, 0)) {
		error = "CreatePipe failed: " + std::system_category().message(static_cast<int>(GetLastError()));
		return false;
	}
	if (!SetHandleInformation(pipe.read, HANDLE_FLAG_INHERIT, 0)) {
		error = "SetHandleInformation failed: " +
			std::system_category().message(static_cast<int>(GetLastError()));
		CloseIfValid(pipe.read);
		CloseIfValid(pipe.write);
		return false;
	}
	return true;
}

std::string RedactCoreLinks(std::string text) {
	std::size_t line_start = 0;
	while (line_start < text.size()) {
		const std::size_t line_end = text.find('\n', line_start);
		const std::size_t length = (line_end == std::string::npos ? text.size() : line_end) - line_start;
		const std::string_view line(text.data() + line_start, length);
		if (line.find("ctrl: ") != std::string_view::npos || line.find("session: ") != std::string_view::npos ||
			line.find("#ws://") != std::string_view::npos) {
			text.replace(line_start, length, "[redacted core link]");
		}
		const std::size_t next = text.find('\n', line_start);
		if (next == std::string::npos) {
			break;
		}
		line_start = next + 1;
	}
	return text;
}

} // namespace

CoreProcess::~CoreProcess() {
	Stop();
}

bool CoreProcess::Start(CoreLaunch launch, EventHandler handler, std::string& error) {
	Stop();
	if (launch.arguments.empty() || launch.arguments.front().empty()) {
		error = "OMP command is empty";
		return false;
	}

	PipePair stdout_pipe;
	PipePair stderr_pipe;
	if (!CreateChildOutputPipe(stdout_pipe, error)) {
		return false;
	}
	if (!CreateChildOutputPipe(stderr_pipe, error)) {
		CloseIfValid(stdout_pipe.read);
		CloseIfValid(stdout_pipe.write);
		return false;
	}

	SECURITY_ATTRIBUTES security{};
	security.nLength = sizeof(security);
	security.bInheritHandle = TRUE;
	HANDLE null_input = CreateFileW(
		L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
	if (null_input == INVALID_HANDLE_VALUE) {
		error = "opening NUL for stdin failed: " +
			std::system_category().message(static_cast<int>(GetLastError()));
		CloseIfValid(stdout_pipe.read);
		CloseIfValid(stdout_pipe.write);
		CloseIfValid(stderr_pipe.read);
		CloseIfValid(stderr_pipe.write);
		return false;
	}

	STARTUPINFOW startup{};
	startup.cb = sizeof(startup);
	startup.dwFlags = STARTF_USESTDHANDLES;
	startup.hStdInput = null_input;
	startup.hStdOutput = stdout_pipe.write;
	startup.hStdError = stderr_pipe.write;

	PROCESS_INFORMATION process_info{};
	std::wstring command_line = BuildWindowsCommandLine(launch.arguments);
	std::vector<wchar_t> mutable_command(command_line.begin(), command_line.end());
	mutable_command.push_back(L'\0');

	HANDLE job = CreateJobObjectW(nullptr, nullptr);
	if (job == nullptr) {
		error = "CreateJobObject failed: " + std::system_category().message(static_cast<int>(GetLastError()));
		CloseIfValid(null_input);
		CloseIfValid(stdout_pipe.read);
		CloseIfValid(stdout_pipe.write);
		CloseIfValid(stderr_pipe.read);
		CloseIfValid(stderr_pipe.write);
		return false;
	}
	JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
	limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
	if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
		error = "SetInformationJobObject failed: " +
			std::system_category().message(static_cast<int>(GetLastError()));
		CloseIfValid(job);
		CloseIfValid(null_input);
		CloseIfValid(stdout_pipe.read);
		CloseIfValid(stdout_pipe.write);
		CloseIfValid(stderr_pipe.read);
		CloseIfValid(stderr_pipe.write);
		return false;
	}

	const DWORD flags = CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
	const BOOL created = CreateProcessW(nullptr,
		mutable_command.data(),
		nullptr,
		nullptr,
		TRUE,
		flags,
		nullptr,
		launch.project_directory.c_str(),
		&startup,
		&process_info);
	const DWORD create_error = created ? ERROR_SUCCESS : GetLastError();
	CloseIfValid(null_input);
	CloseIfValid(stdout_pipe.write);
	CloseIfValid(stderr_pipe.write);
	if (!created) {
		error = "CreateProcessW failed: " + std::system_category().message(static_cast<int>(create_error));
		CloseIfValid(job);
		CloseIfValid(stdout_pipe.read);
		CloseIfValid(stderr_pipe.read);
		return false;
	}

	if (!AssignProcessToJobObject(job, process_info.hProcess)) {
		const DWORD assign_error = GetLastError();
		TerminateProcess(process_info.hProcess, 1);
		WaitForSingleObject(process_info.hProcess, 5000);
		CloseIfValid(process_info.hThread);
		CloseIfValid(process_info.hProcess);
		CloseIfValid(job);
		CloseIfValid(stdout_pipe.read);
		CloseIfValid(stderr_pipe.read);
		error = "AssignProcessToJobObject failed: " +
			std::system_category().message(static_cast<int>(assign_error));
		return false;
	}
	if (ResumeThread(process_info.hThread) == static_cast<DWORD>(-1)) {
		const DWORD resume_error = GetLastError();
		TerminateJobObject(job, 1);
		WaitForSingleObject(process_info.hProcess, 5000);
		CloseIfValid(process_info.hThread);
		CloseIfValid(process_info.hProcess);
		CloseIfValid(job);
		CloseIfValid(stdout_pipe.read);
		CloseIfValid(stderr_pipe.read);
		error = "ResumeThread failed: " + std::system_category().message(static_cast<int>(resume_error));
		return false;
	}
	CloseIfValid(process_info.hThread);

	{
		std::scoped_lock lock(handles_mutex_);
		process_ = process_info.hProcess;
		job_ = job;
		stdout_read_ = stdout_pipe.read;
		stderr_read_ = stderr_pipe.read;
	}
	{
		std::scoped_lock lock(stderr_mutex_);
		stderr_tail_.clear();
	}
	handler_ = std::move(handler);
	stop_requested_.store(false);
	running_.store(true);
	monitor_thread_ = std::thread([this, launch = std::move(launch)]() mutable { Monitor(std::move(launch)); });
	return true;
}

void CoreProcess::Stop() {
	stop_requested_.store(true);
	TerminateTree();
	if (monitor_thread_.joinable() && monitor_thread_.get_id() != std::this_thread::get_id()) {
		monitor_thread_.join();
	}
	running_.store(false);
}

bool CoreProcess::running() const noexcept {
	return running_.load();
}

void CoreProcess::Monitor(CoreLaunch launch) {
	HANDLE process = nullptr;
	HANDLE stdout_pipe = nullptr;
	HANDLE stderr_pipe = nullptr;
	{
		std::scoped_lock lock(handles_mutex_);
		process = process_;
		stdout_pipe = stdout_read_;
		stderr_pipe = stderr_read_;
	}

	std::thread stderr_thread([this, stderr_pipe] { DrainStderr(stderr_pipe); });
	CoreOutputParser parser;
	const ULONGLONG started_at = GetTickCount64();
	bool startup_finished = false;
	std::string startup_error;
	std::array<char, 4096> buffer{};

	while (!stop_requested_.load() && !startup_finished) {
		DWORD available = 0;
		if (!PeekNamedPipe(stdout_pipe, nullptr, 0, nullptr, &available, nullptr)) {
			const DWORD pipe_error = GetLastError();
			if (pipe_error == ERROR_BROKEN_PIPE) {
				parser.Finish();
				startup_error = parser.error();
			} else {
				startup_error = "reading omp core stdout failed: " +
					std::system_category().message(static_cast<int>(pipe_error));
			}
			break;
		}
		if (available > 0) {
			DWORD bytes_read = 0;
			const DWORD requested = std::min<DWORD>(available, static_cast<DWORD>(buffer.size()));
			if (!ReadFile(stdout_pipe, buffer.data(), requested, &bytes_read, nullptr)) {
				const DWORD read_error = GetLastError();
				if (read_error == ERROR_BROKEN_PIPE) {
					parser.Finish();
					startup_error = parser.error();
				} else {
					startup_error = "reading omp core stdout failed: " +
						std::system_category().message(static_cast<int>(read_error));
				}
				break;
			}
			parser.Feed(std::string_view(buffer.data(), static_cast<std::size_t>(bytes_read)));
			if (!parser.error().empty()) {
				startup_error = parser.error();
				break;
			}
			startup_finished = parser.complete();
			continue;
		}

		if (WaitForSingleObject(process, 0) == WAIT_OBJECT_0) {
			parser.Finish();
			startup_error = parser.error();
			break;
		}
		const auto elapsed = std::chrono::milliseconds(GetTickCount64() - started_at);
		if (elapsed >= launch.startup_timeout) {
			startup_error = "waiting for omp core startup timed out";
			break;
		}
		Sleep(8);
	}

	if (!stop_requested_.load() && startup_finished) {
		Emit(CoreEvent{CoreEventKind::Ready, *parser.links(), {}, 0});
	}

	if (!startup_finished) {
		TerminateTree();
	}

	WaitForSingleObject(process, INFINITE);
	DWORD exit_code = 0;
	GetExitCodeProcess(process, &exit_code);
	// The main process may have left workers holding inherited pipe handles.
	// Terminating the job guarantees those handles close before joining the
	// stderr drainer and before a project switch starts another Core.
	TerminateTree();
	if (stderr_thread.joinable()) {
		stderr_thread.join();
	}

	if (!stop_requested_.load()) {
		if (!startup_finished) {
			std::string detail = std::move(startup_error);
			const std::string stderr_tail = StderrTail();
			if (!stderr_tail.empty()) {
				detail.append("\n\nCore stderr:\n");
				detail.append(stderr_tail);
			}
			Emit(CoreEvent{CoreEventKind::StartupFailed, {}, std::move(detail), exit_code});
		} else {
			Emit(CoreEvent{CoreEventKind::Exited, {}, StderrTail(), exit_code});
		}
	}

	CleanupHandles();
	running_.store(false);
}

void CoreProcess::DrainStderr(HANDLE pipe) {
	std::array<char, 1024> buffer{};
	for (;;) {
		// ReadFile on a pipe blocks until the child closes its writer.  During
		// shutdown that can leave CoreProcess::Stop waiting forever when a
		// descendant inherited the stderr handle or did not exit cleanly.
		// Poll first so the monitor can observe stop_requested_ and join
		// deterministically after the job is terminated.
		DWORD available = 0;
		if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr)) {
			return;
		}
		if (available == 0) {
			if (stop_requested_.load()) {
				return;
			}
			Sleep(8);
			continue;
		}
		DWORD bytes_read = 0;
		const DWORD requested = std::min<DWORD>(available, static_cast<DWORD>(buffer.size()));
		if (!ReadFile(pipe, buffer.data(), requested, &bytes_read, nullptr) || bytes_read == 0) {
			return;
		}
		AppendStderr(std::string_view(buffer.data(), static_cast<std::size_t>(bytes_read)));
	}
}

void CoreProcess::AppendStderr(std::string_view bytes) {
	std::scoped_lock lock(stderr_mutex_);
	stderr_tail_.append(bytes);
	if (stderr_tail_.size() > kStderrTailBytes) {
		stderr_tail_.erase(0, stderr_tail_.size() - kStderrTailBytes);
	}
}

std::string CoreProcess::StderrTail() const {
	std::scoped_lock lock(stderr_mutex_);
	return RedactCoreLinks(stderr_tail_);
}

void CoreProcess::Emit(CoreEvent event) const {
	if (handler_) {
		handler_(std::move(event));
	}
}

void CoreProcess::TerminateTree() {
	std::scoped_lock lock(handles_mutex_);
	if (job_ != nullptr) {
		TerminateJobObject(job_, 0);
	} else if (process_ != nullptr) {
		TerminateProcess(process_, 0);
	}
}

void CoreProcess::CleanupHandles() {
	std::scoped_lock lock(handles_mutex_);
	CloseIfValid(stdout_read_);
	CloseIfValid(stderr_read_);
	CloseIfValid(process_);
	CloseIfValid(job_);
}

std::vector<std::wstring> ResolveOmpCommand(std::wstring_view configured_omp_bin, std::wstring_view configured_dev_repo) {
	std::wstring dev_repo = EnvironmentValue(L"OMP_CPP_SHELL_DEV_REPO").value_or(L"");
	if (dev_repo.empty()) {
		dev_repo = configured_dev_repo;
	}
	if (!dev_repo.empty()) {
		std::wstring coding_agent = dev_repo;
		while (!coding_agent.empty() && (coding_agent.back() == L'\\' || coding_agent.back() == L'/')) {
			coding_agent.pop_back();
		}
		coding_agent.append(L"\\packages\\coding-agent");
		auto command = BuildCommandForExecutable(SearchExecutable(L"bun"));
		command.push_back(L"--cwd=" + coding_agent);
		command.push_back(L"src/cli.ts");
		return command;
	}
	std::wstring omp_bin = EnvironmentValue(L"OMP_CPP_SHELL_OMP_BIN").value_or(L"");
	if (omp_bin.empty()) {
		omp_bin = configured_omp_bin;
	}
	return BuildCommandForExecutable(SearchExecutable(omp_bin.empty() ? L"omp" : omp_bin));
}

} // namespace omp::shell
