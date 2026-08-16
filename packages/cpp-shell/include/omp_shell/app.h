#pragma once

#include "omp_shell/config.h"
#include "omp_shell/core_process.h"
#include "omp_shell/native_transcript_view.h"
#include "omp_shell/webview_host.h"

#include <windows.h>
#include <shellapi.h>

#include <memory>
#include <filesystem>
#include <string>
#include <vector>

namespace omp::shell {

class App final {
public:
	explicit App(HINSTANCE instance);
	~App();

	App(const App&) = delete;
	App& operator=(const App&) = delete;

	[[nodiscard]] int Run(int show_command);

private:
	static LRESULT CALLBACK WindowProcedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam);
	LRESULT HandleMessage(UINT message, WPARAM wparam, LPARAM lparam);

	[[nodiscard]] bool RegisterWindowClass() const;
	[[nodiscard]] bool CreateMainWindow(int show_command);
	void InitializeTray();
	void RemoveTray();
	void ShowMainWindow() const;
	void ShowTrayMenu();
	void InitializeWebView();
	void PickProject();
	[[nodiscard]] std::vector<std::wstring> PickAttachments() const;
	void SwitchProject(std::wstring project_directory);
	void HandleCoreEvent(std::unique_ptr<CoreEvent> event);
	void HandleWebMessage(std::wstring message);
	void HandleDesktopRequest(std::string_view payload);
	void ShowCoreFailure(std::wstring_view summary, std::string_view detail);
	void SetAgentRailOpen(bool open);
	void ApplyTheme(bool dark);
	void UpdateWindowTitle() const;
	void SaveWindowState();
	void SaveConfigFile();

	HINSTANCE instance_ = nullptr;
	HWND window_ = nullptr;
	WebViewHost webview_;
	NativeTranscriptView native_transcript_;
	CoreProcess core_;
	std::filesystem::path config_path_;
	ShellConfig config_;
	std::wstring project_directory_;
	std::wstring pending_navigation_;
	std::wstring pending_core_failure_summary_;
	std::wstring pending_core_failure_detail_;
	std::string native_session_id_;
	std::vector<std::string> pending_native_images_;
	RECT native_transcript_bounds_{};
	NOTIFYICONDATAW tray_icon_{};
	RECT compact_window_bounds_{};
	bool has_native_transcript_bounds_ = false;
	bool has_compact_window_bounds_ = false;
	bool native_transcript_preferred_ = true;
	bool agent_rail_open_ = false;
	bool agent_rail_docked_ = false;
	bool dark_theme_ = false;
	bool tray_added_ = false;
	bool exiting_ = false;
	bool shutting_down_ = false;
};

} // namespace omp::shell
