#include "omp_shell/app.h"

#include <commctrl.h>
#include <objbase.h>

namespace {

HANDLE g_instance_mutex = nullptr;

bool EnsureSingleInstance() {
	g_instance_mutex = CreateMutexW(nullptr, TRUE, L"Local\\io.omp.cpp-shell.single-instance");
	if (g_instance_mutex == nullptr) {
		return true;
	}
	if (GetLastError() != ERROR_ALREADY_EXISTS) {
		return true;
	}
	HWND existing = nullptr;
	for (int attempt = 0; attempt < 50 && existing == nullptr; ++attempt) {
		existing = FindWindowW(L"OmpCppShellWindow", nullptr);
		if (existing == nullptr) {
			Sleep(20);
		}
	}
	if (existing != nullptr) {
		PostMessageW(existing, omp::shell::kShowExistingInstanceMessage, 0, 0);
	}
	CloseHandle(g_instance_mutex);
	g_instance_mutex = nullptr;
	return false;
}

} // namespace

int WINAPI wWinMain(_In_ HINSTANCE instance, _In_opt_ HINSTANCE, _In_ PWSTR, _In_ int show_command) {
	SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
	if (!EnsureSingleInstance()) {
		return 0;
	}
	const HRESULT ole = OleInitialize(nullptr);
	if (FAILED(ole)) {
		if (g_instance_mutex != nullptr) {
			CloseHandle(g_instance_mutex);
		}
		return 1;
	}
	INITCOMMONCONTROLSEX controls{sizeof(controls), ICC_STANDARD_CLASSES};
	InitCommonControlsEx(&controls);

	int result = 1;
	{
		// Release WebView2 and every other COM-backed member while OLE is still
		// initialized on this thread.
		omp::shell::App app(instance);
		result = app.Run(show_command);
	}
	OleUninitialize();
	if (g_instance_mutex != nullptr) {
		CloseHandle(g_instance_mutex);
		g_instance_mutex = nullptr;
	}
	return result;
}
