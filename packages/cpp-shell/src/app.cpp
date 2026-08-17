#include "omp_shell/app.h"

#include "omp_shell/native_menu.h"
#include "omp_shell/path_utils.h"
#include "omp_shell/resource.h"
#include "omp_shell/screenshot_overlay.h"
#include "omp_shell/text_utils.h"
#include "omp_shell/window_layout.h"

#include <ShObjIdl.h>
#include <dwmapi.h>
#include <wincrypt.h>
#include <windowsx.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <iterator>
#include <limits>
#include <memory>
#include <stdexcept>
#include <system_error>
#include <unordered_set>
#include <utility>
#include <vector>

namespace omp::shell {
namespace {

constexpr wchar_t kWindowClassName[] = L"OmpCppShellWindow";
constexpr wchar_t kBaseWindowTitle[] = L"Grimoire Router App";
constexpr UINT kCoreEventMessage = WM_APP + 1;
constexpr UINT kTrayMessage = WM_APP + 2;
constexpr UINT kMenuOpenProject = 1001;
constexpr UINT kMenuReload = 1002;
constexpr UINT kMenuExit = 1003;
constexpr UINT kMenuAbout = 1004;
constexpr UINT kMenuShowWindow = 1005;
constexpr UINT kMenuToggleNativeTranscript = 1006;
constexpr UINT kMenuUndo = 1007;
constexpr UINT kMenuRedo = 1008;
constexpr UINT kMenuCut = 1009;
constexpr UINT kMenuCopy = 1010;
constexpr UINT kMenuPaste = 1011;
constexpr UINT kMenuSelectAll = 1012;
constexpr DWORD kWindowStyle = WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU;
constexpr int kSidebarWidth = 288;
constexpr int kConversationClientWidth = 808;
constexpr int kCompactClientWidth = kSidebarWidth + kConversationClientWidth;
constexpr int kAgentRailWidth = 288;
constexpr int kWebResizeEdgeWidth = 6;

constexpr NativeMenuItem kShowWindowItem{L"打开 Grimoire Router App", false, false};
constexpr NativeMenuItem kTrayOpenProjectItem{L"打开项目...", false, false};
constexpr NativeMenuItem kTrayExitItem{L"退出", false, false};
constexpr NativeMenuItem kMenuSeparatorItem{nullptr, false, true};

[[nodiscard]] int DefaultCompactWindowWidth(UINT dpi) noexcept {
	return MulDiv(kCompactClientWidth, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI);
}

enum class PreferredAppMode : int {
	Default = 0,
	AllowDark = 1,
	ForceDark = 2,
	ForceLight = 3,
};

using SetPreferredAppModeFn = PreferredAppMode(WINAPI*)(PreferredAppMode);
using AllowDarkModeForWindowFn = BOOL(WINAPI*)(HWND, BOOL);
using FlushMenuThemesFn = void(WINAPI*)();
using SetWindowThemeFn = HRESULT(WINAPI*)(HWND, LPCWSTR, LPCWSTR);
using ShouldAppsUseDarkModeFn = bool(WINAPI*)();
using RefreshImmersiveColorPolicyStateFn = void(WINAPI*)();

[[nodiscard]] HMODULE LoadUxTheme() noexcept {
	return LoadLibraryExW(L"uxtheme.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
}

[[nodiscard]] bool SystemPrefersDarkMode() noexcept {
	const HMODULE theme = LoadUxTheme();
	if (theme == nullptr) {
		return false;
	}
	const auto should_use_dark = reinterpret_cast<ShouldAppsUseDarkModeFn>(
		GetProcAddress(theme, MAKEINTRESOURCEA(132)));
	const bool dark = should_use_dark != nullptr && should_use_dark();
	FreeLibrary(theme);
	return dark;
}

void ApplyApplicationThemeMode(bool dark) noexcept {
	const HMODULE theme = LoadUxTheme();
	if (theme == nullptr) {
		return;
	}
	const auto set_preferred = reinterpret_cast<SetPreferredAppModeFn>(
		GetProcAddress(theme, MAKEINTRESOURCEA(135)));
	const auto flush_menus = reinterpret_cast<FlushMenuThemesFn>(
		GetProcAddress(theme, MAKEINTRESOURCEA(136)));
	const auto refresh_policy = reinterpret_cast<RefreshImmersiveColorPolicyStateFn>(
		GetProcAddress(theme, MAKEINTRESOURCEA(104)));
	if (set_preferred != nullptr) {
		static_cast<void>(set_preferred(dark ? PreferredAppMode::ForceDark : PreferredAppMode::ForceLight));
	}
	if (refresh_policy != nullptr) {
		refresh_policy();
	}
	if (flush_menus != nullptr) {
		flush_menus();
	}
	FreeLibrary(theme);
}

void ApplyWindowThemeMode(HWND window, bool dark) noexcept {
	if (window == nullptr) {
		return;
	}
	const HMODULE theme = LoadUxTheme();
	if (theme == nullptr) {
		return;
	}
	const auto allow_window = reinterpret_cast<AllowDarkModeForWindowFn>(
		GetProcAddress(theme, MAKEINTRESOURCEA(133)));
	const auto set_window_theme = reinterpret_cast<SetWindowThemeFn>(GetProcAddress(theme, "SetWindowTheme"));
	if (allow_window != nullptr) {
		static_cast<void>(allow_window(window, dark ? TRUE : FALSE));
	}
	if (set_window_theme != nullptr) {
		static_cast<void>(set_window_theme(window, dark ? L"DarkMode_Explorer" : L"Explorer", nullptr));
	}
	FreeLibrary(theme);
	DrawMenuBar(window);
}

thread_local bool native_dialog_dark_theme = false;

BOOL CALLBACK ApplyChildWindowTheme(HWND window, LPARAM dark) {
	ApplyWindowThemeMode(window, dark != 0);
	return TRUE;
}

void ApplyWindowTreeTheme(HWND window, bool dark) noexcept {
	ApplyWindowThemeMode(window, dark);
	EnumChildWindows(window, ApplyChildWindowTheme, dark ? 1 : 0);
	RedrawWindow(window, nullptr, nullptr, RDW_INVALIDATE | RDW_FRAME | RDW_ALLCHILDREN);
}

LRESULT CALLBACK NativeDialogThemeHook(int code, WPARAM wparam, LPARAM lparam) {
	if (code == HCBT_ACTIVATE) {
		ApplyWindowTreeTheme(reinterpret_cast<HWND>(wparam), native_dialog_dark_theme);
	}
	return CallNextHookEx(nullptr, code, wparam, lparam);
}

class ScopedNativeDialogTheme final {
public:
	explicit ScopedNativeDialogTheme(bool dark) : previous_theme_(native_dialog_dark_theme) {
		ApplyApplicationThemeMode(dark);
		native_dialog_dark_theme = dark;
		hook_ = SetWindowsHookExW(WH_CBT, NativeDialogThemeHook, nullptr, GetCurrentThreadId());
	}

	~ScopedNativeDialogTheme() {
		if (hook_ != nullptr) {
			UnhookWindowsHookEx(hook_);
		}
		native_dialog_dark_theme = previous_theme_;
	}

	ScopedNativeDialogTheme(const ScopedNativeDialogTheme&) = delete;
	ScopedNativeDialogTheme& operator=(const ScopedNativeDialogTheme&) = delete;

private:
	HHOOK hook_ = nullptr;
	bool previous_theme_ = false;
};

int ShowThemedMessageBox(HWND owner, const wchar_t* text, const wchar_t* caption, UINT type, bool dark) {
	ScopedNativeDialogTheme theme(dark);
	return MessageBoxW(owner, text, caption, type);
}

[[nodiscard]] HICON LoadEmbeddedIcon(HINSTANCE instance, bool dark, int width, int height) noexcept {
	return reinterpret_cast<HICON>(LoadImageW(
		instance,
		MAKEINTRESOURCEW(dark ? IDI_GRIMOIRE_ON_DARK : IDI_GRIMOIRE_ON_LIGHT),
		IMAGE_ICON,
		width,
		height,
		LR_DEFAULTCOLOR | LR_SHARED));
}

std::wstring CanonicalDirectory(std::wstring_view input, std::error_code& error) {
	const std::filesystem::path canonical = std::filesystem::canonical(std::filesystem::path(input), error);
	if (error || !std::filesystem::is_directory(canonical, error)) {
		return {};
	}
	return canonical.wstring();
}

std::wstring DirectoryName(std::wstring_view directory) {
	std::filesystem::path path(directory);
	std::wstring name = path.filename().wstring();
	if (name.empty()) {
		name = path.root_name().wstring();
	}
	return name.empty() ? std::wstring(kBaseWindowTitle) : name;
}

std::optional<NativeTranscriptRowKind> ParseNativeRowKind(std::string_view kind) noexcept {
	if (kind == "user") return NativeTranscriptRowKind::User;
	if (kind == "assistant") return NativeTranscriptRowKind::Assistant;
	if (kind == "reasoning") return NativeTranscriptRowKind::Reasoning;
	if (kind == "plan") return NativeTranscriptRowKind::Plan;
	if (kind == "tool") return NativeTranscriptRowKind::Tool;
	if (kind == "system") return NativeTranscriptRowKind::System;
	if (kind == "compaction") return NativeTranscriptRowKind::Compaction;
	if (kind == "error") return NativeTranscriptRowKind::Error;
	return std::nullopt;
}

NativeTranscriptRow ParseNativeRow(const nlohmann::json& value) {
	if (!value.is_object()) {
		throw std::invalid_argument("native transcript row must be an object");
	}
	NativeTranscriptRow row;
	row.id = value.at("id").get<std::string>();
	row.text = value.at("text").get<std::string>();
	const auto parsed_kind = ParseNativeRowKind(value.at("kind").get_ref<const std::string&>());
	if (!parsed_kind || row.id.empty() || row.id.size() > 512 || row.text.size() > 1024 * 1024) {
		throw std::invalid_argument("native transcript row is invalid or exceeds its size limit");
	}
	row.kind = *parsed_kind;
	const int flags = value.value("flags", 0);
	if (flags < 0 || flags > std::numeric_limits<std::uint8_t>::max()) {
		throw std::invalid_argument("native transcript flags are out of range");
	}
	row.flags = static_cast<NativeTranscriptRowFlags>(static_cast<std::uint8_t>(flags));
	if (const auto time_label = value.find("timeLabel"); time_label != value.end()) {
		if (!time_label->is_string()) {
			throw std::invalid_argument("native transcript time label must be a string");
		}
		row.time_label = time_label->get<std::string>();
		if (row.time_label.size() > 32) {
			throw std::invalid_argument("native transcript time label exceeds its size limit");
		}
	}
	row.can_edit = value.value("canEdit", false);
	row.height = std::clamp(value.value("estimatedHeight", 48), 1, 100'000);
	if (const auto duration = value.find("durationMs"); duration != value.end()) {
		if (!duration->is_number_integer()) {
			throw std::invalid_argument("native transcript duration must be an integer");
		}
		constexpr std::int64_t kMaximumReasoningDurationMs = 7LL * 24LL * 60LL * 60LL * 1'000LL;
		const std::int64_t duration_ms = duration->get<std::int64_t>();
		if (duration_ms < 0 || duration_ms > kMaximumReasoningDurationMs) {
			throw std::invalid_argument("native transcript duration is out of range");
		}
		row.duration_ms = duration_ms;
	}
	if (const auto items = value.find("processItems"); items != value.end()) {
		if (!items->is_array() || items->size() > 512) {
			throw std::invalid_argument("native transcript process item list is invalid");
		}
		std::size_t total_detail_bytes = 0;
		for (const nlohmann::json& encoded_item : *items) {
			if (!encoded_item.is_object()) {
				throw std::invalid_argument("native transcript process item must be an object");
			}
			NativeTranscriptProcessItem item;
			item.id = encoded_item.at("id").get<std::string>();
			item.summary = encoded_item.at("summary").get<std::string>();
			item.detail = encoded_item.at("detail").get<std::string>();
			item.failed = encoded_item.value("failed", false);
			total_detail_bytes += item.detail.size();
			if (item.id.empty() || item.id.size() > 512 || item.summary.empty() || item.summary.size() > 4 * 1024 ||
				item.detail.size() > 128 * 1024 || total_detail_bytes > 1024 * 1024) {
				throw std::invalid_argument("native transcript process item exceeds its size limit");
			}
			row.process_items.push_back(std::move(item));
		}
	}
	if (const auto media = value.find("mediaIds"); media != value.end()) {
		if (!media->is_array() || media->size() > 8) {
			throw std::invalid_argument("native transcript media list is invalid");
		}
		for (const nlohmann::json& encoded_id : *media) {
			const std::string media_id = encoded_id.get<std::string>();
			if (media_id.empty() || media_id.size() > 256) {
				throw std::invalid_argument("native transcript media id is invalid");
			}
			row.media_ids.push_back(media_id);
		}
	}
	return row;
}

std::vector<std::uint8_t> DecodeBase64(std::string_view encoded) {
	if (encoded.empty() || encoded.size() > 6 * 1024 * 1024 || encoded.size() > std::numeric_limits<DWORD>::max()) {
		return {};
	}
	DWORD byte_count = 0;
	if (!CryptStringToBinaryA(
			encoded.data(),
			static_cast<DWORD>(encoded.size()),
			CRYPT_STRING_BASE64,
			nullptr,
			&byte_count,
			nullptr,
			nullptr)) {
		return {};
	}
	std::vector<std::uint8_t> decoded(byte_count);
	if (!CryptStringToBinaryA(
			encoded.data(),
			static_cast<DWORD>(encoded.size()),
			CRYPT_STRING_BASE64,
			decoded.data(),
			&byte_count,
			nullptr,
			nullptr)) {
		return {};
	}
	decoded.resize(byte_count);
	return decoded;
}

std::string EncodeBase64(const std::vector<std::uint8_t>& bytes) {
	static constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	std::string encoded;
	encoded.reserve(((bytes.size() + 2) / 3) * 4);
	for (std::size_t offset = 0; offset < bytes.size(); offset += 3) {
		const std::uint32_t first = bytes[offset];
		const std::uint32_t second = offset + 1 < bytes.size() ? bytes[offset + 1] : 0;
		const std::uint32_t third = offset + 2 < bytes.size() ? bytes[offset + 2] : 0;
		const std::uint32_t value = (first << 16U) | (second << 8U) | third;
		encoded.push_back(alphabet[(value >> 18U) & 0x3FU]);
		encoded.push_back(alphabet[(value >> 12U) & 0x3FU]);
		encoded.push_back(offset + 1 < bytes.size() ? alphabet[(value >> 6U) & 0x3FU] : '=');
		encoded.push_back(offset + 2 < bytes.size() ? alphabet[value & 0x3FU] : '=');
	}
	return encoded;
}

class ScopedFlag final {
public:
	explicit ScopedFlag(bool& flag) : flag_(flag) { flag_ = true; }
	~ScopedFlag() { flag_ = false; }

	ScopedFlag(const ScopedFlag&) = delete;
	ScopedFlag& operator=(const ScopedFlag&) = delete;

private:
	bool& flag_;
};

} // namespace

App::App(HINSTANCE instance)
	: instance_(instance),
	  config_path_(DefaultConfigPath()),
	  config_(LoadConfig(config_path_)),
	  dark_theme_(config_.dark_theme.value_or(SystemPrefersDarkMode())) {}

App::~App() {
	shutting_down_ = true;
	core_.Stop();
	RemoveTray();
}

int App::Run(int show_command) {
	ApplyApplicationThemeMode(dark_theme_);
	if (!RegisterWindowClass() || !CreateMainWindow(show_command)) {
		return 1;
	}

	const ACCEL accelerators[] = {
		{FVIRTKEY | FCONTROL, static_cast<WORD>('O'), kMenuOpenProject},
		{FVIRTKEY | FCONTROL, static_cast<WORD>('R'), kMenuReload},
	};
	HACCEL accelerator_table = CreateAcceleratorTableW(
		const_cast<LPACCEL>(accelerators), static_cast<int>(std::size(accelerators)));
	MSG message{};
	for (;;) {
		const BOOL result = GetMessageW(&message, nullptr, 0, 0);
		if (result == 0) {
			if (accelerator_table != nullptr) {
				DestroyAcceleratorTable(accelerator_table);
			}
			return static_cast<int>(message.wParam);
		}
		if (result == -1) {
			if (accelerator_table != nullptr) {
				DestroyAcceleratorTable(accelerator_table);
			}
			return 1;
		}
		if (accelerator_table != nullptr && TranslateAcceleratorW(window_, accelerator_table, &message)) {
			continue;
		}
		TranslateMessage(&message);
		DispatchMessageW(&message);
	}
}

LRESULT CALLBACK App::WindowProcedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
	App* app = reinterpret_cast<App*>(GetWindowLongPtrW(window, GWLP_USERDATA));
	if (message == WM_NCCREATE) {
		const auto* create = reinterpret_cast<CREATESTRUCTW*>(lparam);
		app = static_cast<App*>(create->lpCreateParams);
		app->window_ = window;
		SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(app));
	}
	if (app != nullptr) {
		return app->HandleMessage(message, wparam, lparam);
	}
	return DefWindowProcW(window, message, wparam, lparam);
}

LRESULT App::HandleMessage(UINT message, WPARAM wparam, LPARAM lparam) {
	switch (message) {
	case WM_NCCALCSIZE:
		// Keep WS_THICKFRAME semantics, but let the Web title bar occupy the
		// complete window instead of exposing a DWM-painted strip above it.
		if (wparam == TRUE) {
			return 0;
		}
		break;
	case WM_NCHITTEST: {
		RECT bounds{};
		if (!GetWindowRect(window_, &bounds)) {
			break;
		}
		const UINT dpi = GetDpiForWindow(window_);
		const int horizontal_border = ResizeBorderThicknessForDpi(
			GetSystemMetricsForDpi(SM_CXFRAME, dpi) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi),
			static_cast<int>(dpi));
		const int vertical_border = ResizeBorderThicknessForDpi(
			GetSystemMetricsForDpi(SM_CYFRAME, dpi) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi),
			static_cast<int>(dpi));
		return HitTestResizeBorder(
			bounds, POINT{GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)}, horizontal_border, vertical_border, IsZoomed(window_));
	}
	case WM_CREATE:
		InitializeTray();
		if (native_transcript_.Create(window_, instance_)) {
			native_transcript_.SetDarkTheme(dark_theme_);
			native_transcript_.SetHistoryRequestHandler([this] {
				webview_.PostJson(LR"json({"channel":"omp-native-transcript-event","event":"load-earlier"})json");
			});
			native_transcript_.SetImageRequestHandler([this](std::string_view image_id) {
				if (pending_native_images_.size() < 32 &&
					std::find(pending_native_images_.begin(), pending_native_images_.end(), image_id) ==
						pending_native_images_.end()) {
					pending_native_images_.emplace_back(image_id);
				}
				nlohmann::json event{{"channel", "omp-native-transcript-event"},
					{"event", "image-needed"},
					{"imageId", image_id}};
				webview_.PostJson(Utf8ToWide(event.dump()));
			});
			native_transcript_.SetEditRequestHandler([this](std::string_view row_id) {
				nlohmann::json event{{"channel", "omp-native-transcript-event"},
					{"event", "edit-message"},
					{"rowId", row_id}};
				webview_.PostJson(Utf8ToWide(event.dump()));
			});
		}
		InitializeWebView();
		// WebView2 environment creation and the Bun/Core cold start are the two
		// dominant startup costs.  Start them side-by-side; the ready link is
		// retained in pending_navigation_ when Core wins the race.
		if (const auto initial_project = EnvironmentValue(L"OMP_CPP_SHELL_INITIAL_PROJECT");
			initial_project && std::filesystem::is_directory(*initial_project)) {
			SwitchProject(*initial_project);
		} else if (config_.last_project && std::filesystem::is_directory(*config_.last_project)) {
			SwitchProject(*config_.last_project);
		}
		return 0;
	case WM_ERASEBKGND: {
		RECT client{};
		GetClientRect(window_, &client);
		HBRUSH background = CreateSolidBrush(dark_theme_ ? RGB(21, 21, 23) : RGB(255, 255, 255));
		FillRect(reinterpret_cast<HDC>(wparam), &client, background);
		DeleteObject(background);
		return 1;
	}
	case WM_SIZE:
		webview_.Resize();
		if (has_native_transcript_bounds_) {
			native_transcript_.SetBounds(native_transcript_bounds_);
		}
		return 0;
	case WM_DROPFILES: {
		const HDROP drop = reinterpret_cast<HDROP>(wparam);
		const UINT count = std::min<UINT>(DragQueryFileW(drop, 0xFFFFFFFFU, nullptr, 0), 32U);
		nlohmann::json paths = nlohmann::json::array();
		for (UINT index = 0; index < count; ++index) {
			const UINT length = DragQueryFileW(drop, index, nullptr, 0);
			if (length == 0) {
				continue;
			}
			std::wstring value(static_cast<std::size_t>(length) + 1, L'\0');
			if (DragQueryFileW(drop, index, value.data(), length + 1) == 0) {
				continue;
			}
			value.resize(length);
			std::error_code status_error;
			if (std::filesystem::is_regular_file(value, status_error) && !status_error) {
				paths.push_back(WideToUtf8(value));
			}
		}
		DragFinish(drop);
		if (!paths.empty()) {
			webview_.PostJson(
				Utf8ToWide(nlohmann::json{{"channel", "omp-files-dropped"}, {"paths", std::move(paths)}}.dump()));
		}
		return 0;
	}
	case WM_EXITSIZEMOVE:
		if (agent_rail_open_ && has_compact_window_bounds_ && !IsZoomed(window_) && !IsIconic(window_)) {
			RECT resized{};
			if (GetWindowRect(window_, &resized)) {
				const int dpi = static_cast<int>(GetDpiForWindow(window_));
				agent_rail_docked_ = ShouldDockAgentRail(resized.right - resized.left, dpi);
				compact_window_bounds_ = resized;
				if (agent_rail_docked_) {
					const LONG rail_width = MulDiv(kAgentRailWidth, dpi, USER_DEFAULT_SCREEN_DPI);
					compact_window_bounds_.right = std::max(resized.left + 1, resized.right - rail_width);
				}
			}
		}
		SaveWindowState();
		return 0;
	case WM_GETMINMAXINFO: {
		auto* limits = reinterpret_cast<MINMAXINFO*>(lparam);
		const SIZE minimum = MinimumWindowTrackSizeForDpi(static_cast<int>(GetDpiForWindow(window_)));
		limits->ptMinTrackSize.x = minimum.cx;
		limits->ptMinTrackSize.y = minimum.cy;
		MONITORINFO monitor_info{};
		monitor_info.cbSize = sizeof(monitor_info);
		const HMONITOR monitor = MonitorFromWindow(window_, MONITOR_DEFAULTTONEAREST);
		if (monitor != nullptr && GetMonitorInfoW(monitor, &monitor_info)) {
			limits->ptMaxPosition.x = monitor_info.rcWork.left - monitor_info.rcMonitor.left;
			limits->ptMaxPosition.y = monitor_info.rcWork.top - monitor_info.rcMonitor.top;
			limits->ptMaxSize.x = monitor_info.rcWork.right - monitor_info.rcWork.left;
			limits->ptMaxSize.y = monitor_info.rcWork.bottom - monitor_info.rcWork.top;
		}
		return 0;
	}
	case WM_DPICHANGED: {
		const auto* suggested = reinterpret_cast<RECT*>(lparam);
		if (agent_rail_open_ && has_compact_window_bounds_ && !IsZoomed(window_) && !IsIconic(window_)) {
			const int dpi = HIWORD(wparam);
			agent_rail_docked_ = ShouldDockAgentRail(suggested->right - suggested->left, dpi);
			compact_window_bounds_ = *suggested;
			if (agent_rail_docked_) {
				const LONG rail_width = MulDiv(kAgentRailWidth, dpi, USER_DEFAULT_SCREEN_DPI);
				compact_window_bounds_.right = std::max(suggested->left + 1, suggested->right - rail_width);
			}
		}
		SetWindowPos(window_,
			nullptr,
			suggested->left,
			suggested->top,
			suggested->right - suggested->left,
			suggested->bottom - suggested->top,
			SWP_NOACTIVATE | SWP_NOZORDER);
		return 0;
	}
	case WM_MEASUREITEM:
		if (MeasureNativeMenuItem(window_, reinterpret_cast<MEASUREITEMSTRUCT*>(lparam))) {
			return TRUE;
		}
		break;
	case WM_DRAWITEM:
		if (DrawNativeMenuItem(window_, reinterpret_cast<DRAWITEMSTRUCT*>(lparam), dark_theme_)) {
			return TRUE;
		}
		break;
	case WM_COMMAND:
		switch (LOWORD(wparam)) {
		case kMenuOpenProject:
			PickProject();
			return 0;
		case kMenuReload:
			webview_.Reload();
			return 0;
		case kMenuUndo:
			webview_.ExecuteScript(L"document.execCommand('undo')");
			return 0;
		case kMenuRedo:
			webview_.ExecuteScript(L"document.execCommand('redo')");
			return 0;
		case kMenuCut:
			webview_.ExecuteScript(L"document.execCommand('cut')");
			return 0;
		case kMenuCopy:
			webview_.ExecuteScript(L"document.execCommand('copy')");
			return 0;
		case kMenuPaste:
			webview_.ExecuteScript(L"document.execCommand('paste')");
			return 0;
		case kMenuSelectAll:
			webview_.ExecuteScript(L"document.execCommand('selectAll')");
			return 0;
		case kMenuToggleNativeTranscript:
			native_transcript_preferred_ = !native_transcript_preferred_;
			if (HMENU menu = GetMenu(window_); menu != nullptr) {
				CheckMenuItem(menu,
					kMenuToggleNativeTranscript,
					MF_BYCOMMAND | (native_transcript_preferred_ ? MF_CHECKED : MF_UNCHECKED));
			}
			if (!native_transcript_preferred_) {
				native_transcript_.SetVisible(false);
			}
			webview_.PostJson(native_transcript_preferred_
					? LR"json({"channel":"omp-native-transcript-event","event":"use-native"})json"
					: LR"json({"channel":"omp-native-transcript-event","event":"use-web"})json");
			return 0;
		case kMenuExit:
			exiting_ = true;
			DestroyWindow(window_);
			return 0;
		case kMenuShowWindow:
			ShowMainWindow();
			return 0;
		case kMenuAbout:
			ShowThemedMessageBox(window_,
				L"Grimoire Router App\nNative Windows host for omp core",
				L"About Grimoire Router App",
				MB_OK | MB_ICONINFORMATION,
				dark_theme_);
			return 0;
		default:
			break;
		}
		break;
	case kCoreEventMessage: {
		std::unique_ptr<CoreEvent> event(reinterpret_cast<CoreEvent*>(lparam));
		HandleCoreEvent(std::move(event));
		return 0;
	}
	case kTrayMessage: {
		// NOTIFYICON_VERSION_4 packs the icon ID into the high word of
		// lParam; the mouse notification itself is in the low word.  Comparing
		// the full value makes every tray click look like an unknown event.
		const UINT tray_event = LOWORD(static_cast<ULONG_PTR>(lparam));
		if (tray_event == WM_LBUTTONUP || tray_event == WM_LBUTTONDBLCLK) {
			ShowMainWindow();
		} else if (tray_event == WM_RBUTTONUP || tray_event == WM_CONTEXTMENU) {
			ShowTrayMenu();
		}
		return 0;
	}
	case WM_CLOSE:
		SaveWindowState();
		if (config_.close_to_tray && !exiting_) {
			ShowWindow(window_, SW_HIDE);
			return 0;
		}
		DestroyWindow(window_);
		return 0;
	case WM_DESTROY:
		shutting_down_ = true;
		SaveWindowState();
		RemoveTray();
		native_transcript_.Destroy();
		core_.Stop();
		PostQuitMessage(0);
		return 0;
	default:
		break;
	}
	return DefWindowProcW(window_, message, wparam, lparam);
}

bool App::RegisterWindowClass() const {
	WNDCLASSEXW window_class{};
	window_class.cbSize = sizeof(window_class);
	window_class.style = CS_HREDRAW | CS_VREDRAW;
	window_class.lpfnWndProc = WindowProcedure;
	window_class.hInstance = instance_;
	window_class.hCursor = LoadCursorW(nullptr, IDC_ARROW);
	window_class.hIcon =
		LoadEmbeddedIcon(instance_, dark_theme_, GetSystemMetrics(SM_CXICON), GetSystemMetrics(SM_CYICON));
	window_class.hIconSm =
		LoadEmbeddedIcon(instance_, dark_theme_, GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON));
	if (window_class.hIcon == nullptr) {
		window_class.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
	}
	if (window_class.hIconSm == nullptr) {
		window_class.hIconSm = window_class.hIcon;
	}
	window_class.hbrBackground = nullptr;
	window_class.lpszClassName = kWindowClassName;
	return RegisterClassExW(&window_class) != 0 || GetLastError() == ERROR_CLASS_ALREADY_EXISTS;
}

bool App::CreateMainWindow(int show_command) {
	int x = CW_USEDEFAULT;
	int y = CW_USEDEFAULT;
	const UINT system_dpi = GetDpiForSystem();
	const SIZE minimum = MinimumWindowTrackSizeForDpi(static_cast<int>(system_dpi));
	int width = config_.window_width.value_or(DefaultCompactWindowWidth(system_dpi));
	int height = config_.window_height.value_or(MulDiv(820, static_cast<int>(system_dpi), USER_DEFAULT_SCREEN_DPI));
	// Use the same DPI-aware limits during restore and interactive sizing. This
	// keeps a user-selected 720-DIP compact width stable across restarts instead
	// of silently growing it back to the former hard-coded 800 pixels.
	width = std::max(width, static_cast<int>(minimum.cx));
	height = std::max(height, static_cast<int>(minimum.cy));
	if (config_.window_x && config_.window_y) {
		RECT restored{*config_.window_x, *config_.window_y, *config_.window_x + width, *config_.window_y + height};
		if (MonitorFromRect(&restored, MONITOR_DEFAULTTONULL) != nullptr) {
			x = restored.left;
			y = restored.top;
		}
	}
	window_ = CreateWindowExW(0,
		kWindowClassName,
		kBaseWindowTitle,
		kWindowStyle,
		x,
		y,
		width,
		height,
		nullptr,
		nullptr,
		instance_,
		this);
	if (window_ == nullptr) {
		return false;
	}
	DragAcceptFiles(window_, TRUE);
	const LONG_PTR window_style = GetWindowLongPtrW(window_, GWL_STYLE);
	SetWindowLongPtrW(window_, GWL_STYLE, window_style & ~static_cast<LONG_PTR>(WS_CAPTION));
	SetWindowPos(window_,
		nullptr,
		0,
		0,
		0,
		0,
		SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER);
	ApplyTheme(dark_theme_);
	ShowWindow(window_, config_.window_maximized ? SW_SHOWMAXIMIZED : show_command);
	UpdateWindow(window_);
	return true;
}

void App::InitializeTray() {
	tray_icon_.cbSize = sizeof(tray_icon_);
	tray_icon_.hWnd = window_;
	tray_icon_.uID = 1;
	tray_icon_.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP;
	tray_icon_.uCallbackMessage = kTrayMessage;
	const UINT dpi = GetDpiForWindow(window_);
	tray_icon_.hIcon = LoadEmbeddedIcon(instance_,
		dark_theme_,
		GetSystemMetricsForDpi(SM_CXSMICON, dpi),
		GetSystemMetricsForDpi(SM_CYSMICON, dpi));
	if (tray_icon_.hIcon == nullptr) {
		tray_icon_.hIcon = reinterpret_cast<HICON>(GetClassLongPtrW(window_, GCLP_HICONSM));
	}
	wcscpy_s(tray_icon_.szTip, L"Grimoire Router App");
	tray_added_ = Shell_NotifyIconW(NIM_ADD, &tray_icon_) != FALSE;
	if (tray_added_) {
		tray_icon_.uVersion = NOTIFYICON_VERSION_4;
		Shell_NotifyIconW(NIM_SETVERSION, &tray_icon_);
	}
}

void App::RemoveTray() {
	if (tray_added_) {
		Shell_NotifyIconW(NIM_DELETE, &tray_icon_);
		tray_added_ = false;
	}
}

void App::ShowMainWindow() const {
	ShowWindow(window_, IsZoomed(window_) ? SW_SHOWMAXIMIZED : SW_RESTORE);
	SetForegroundWindow(window_);
}

void App::SetAgentRailOpen(bool open) {
	if (agent_rail_open_ == open || window_ == nullptr || !IsWindow(window_)) {
		return;
	}
	agent_rail_open_ = open;
	if (open) {
		has_compact_window_bounds_ = false;
		agent_rail_docked_ = false;
		if (IsZoomed(window_) || IsIconic(window_)) {
			RECT client{};
			agent_rail_docked_ = GetClientRect(window_, &client) &&
				ShouldDockAgentRail(client.right - client.left, static_cast<int>(GetDpiForWindow(window_)));
			return;
		}
		if (!GetWindowRect(window_, &compact_window_bounds_)) {
			return;
		}
		MONITORINFO monitor_info{};
		monitor_info.cbSize = sizeof(monitor_info);
		const HMONITOR monitor = MonitorFromWindow(window_, MONITOR_DEFAULTTONEAREST);
		if (monitor == nullptr || !GetMonitorInfoW(monitor, &monitor_info)) {
			return;
		}
		const int dpi = static_cast<int>(GetDpiForWindow(window_));
		const int rail_width = MulDiv(kAgentRailWidth, dpi, USER_DEFAULT_SCREEN_DPI);
		const RECT expanded = ExpandWindowBoundsForRail(compact_window_bounds_, monitor_info.rcWork, rail_width);
		agent_rail_docked_ = ShouldDockAgentRail(expanded.right - expanded.left, dpi);
		if (!agent_rail_docked_) {
			has_compact_window_bounds_ = false;
			return;
		}
		if (!SetWindowPos(window_,
			nullptr,
			expanded.left,
			expanded.top,
			expanded.right - expanded.left,
			expanded.bottom - expanded.top,
			SWP_NOACTIVATE | SWP_NOZORDER)) {
			agent_rail_docked_ = false;
			return;
		}
		has_compact_window_bounds_ = true;
		return;
	}

	if (!has_compact_window_bounds_ || !agent_rail_docked_) {
		has_compact_window_bounds_ = false;
		agent_rail_docked_ = false;
		return;
	}
	const RECT compact = compact_window_bounds_;
	has_compact_window_bounds_ = false;
	agent_rail_docked_ = false;
	if (IsZoomed(window_) || IsIconic(window_)) {
		WINDOWPLACEMENT placement{};
		placement.length = sizeof(placement);
		if (GetWindowPlacement(window_, &placement)) {
			placement.rcNormalPosition = compact;
			SetWindowPlacement(window_, &placement);
		}
		return;
	}
	SetWindowPos(window_,
		nullptr,
		compact.left,
		compact.top,
		compact.right - compact.left,
		compact.bottom - compact.top,
		SWP_NOACTIVATE | SWP_NOZORDER);
}

void App::ApplyTheme(bool dark) {
	const bool persist_theme = config_.dark_theme != std::optional<bool>(dark);
	dark_theme_ = dark;
	config_.dark_theme = dark;
	ApplyApplicationThemeMode(dark);
	native_transcript_.SetDarkTheme(dark);
	webview_.SetDarkTheme(dark);
	if (persist_theme) {
		SaveConfigFile();
	}
	if (window_ == nullptr) {
		return;
	}
	const BOOL dark_mode = dark ? TRUE : FALSE;
	DwmSetWindowAttribute(window_, 20, &dark_mode, sizeof(dark_mode));
	// Windows 11 draws a one-pixel DWM border even after the client area is
	// extended. DWMWA_COLOR_NONE suppresses it without disabling the shadow.
	constexpr DWORD kDwmBorderColorAttribute = 34;
	constexpr COLORREF kDwmColorNone = 0xFFFFFFFE;
	DwmSetWindowAttribute(window_, kDwmBorderColorAttribute, &kDwmColorNone, sizeof(kDwmColorNone));
	ApplyWindowThemeMode(window_, dark);
	ApplyWindowThemeMode(native_transcript_.Window(), dark);
	const UINT dpi = GetDpiForWindow(window_);
	const HICON large_icon = LoadEmbeddedIcon(instance_,
		dark,
		GetSystemMetricsForDpi(SM_CXICON, dpi),
		GetSystemMetricsForDpi(SM_CYICON, dpi));
	const HICON small_icon = LoadEmbeddedIcon(instance_,
		dark,
		GetSystemMetricsForDpi(SM_CXSMICON, dpi),
		GetSystemMetricsForDpi(SM_CYSMICON, dpi));
	if (large_icon != nullptr) SendMessageW(window_, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(large_icon));
	if (small_icon != nullptr) SendMessageW(window_, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(small_icon));
	if (tray_added_ && small_icon != nullptr) {
		tray_icon_.hIcon = small_icon;
		const UINT previous_flags = tray_icon_.uFlags;
		tray_icon_.uFlags = NIF_ICON;
		Shell_NotifyIconW(NIM_MODIFY, &tray_icon_);
		tray_icon_.uFlags = previous_flags;
	}
	RedrawWindow(window_, nullptr, nullptr, RDW_INVALIDATE | RDW_FRAME | RDW_ALLCHILDREN);
}

void App::ShowTrayMenu() {
	POINT cursor{};
	GetCursorPos(&cursor);
	HMENU menu = CreatePopupMenu();
	InsertNativeMenuItem(menu, kShowWindowItem, kMenuShowWindow, nullptr, MFS_DEFAULT);
	InsertNativeMenuItem(menu, kTrayOpenProjectItem, kMenuOpenProject);
	InsertNativeMenuItem(menu, kMenuSeparatorItem, 0);
	InsertNativeMenuItem(menu, kTrayExitItem, kMenuExit);
	ApplyNativeMenuBackground(menu, dark_theme_);
	SetForegroundWindow(window_);
	// Request the selected command directly instead of relying on a posted
	// WM_COMMAND.  The tray owner can be hidden, and a posted command can be
	// lost while the shell is transitioning to its shutdown path.
	const UINT command = TrackPopupMenu(
		menu, TPM_RIGHTBUTTON | TPM_BOTTOMALIGN | TPM_LEFTALIGN | TPM_RETURNCMD, cursor.x, cursor.y, 0, window_, nullptr);
	DestroyMenu(menu);
	switch (command) {
	case kMenuShowWindow:
		ShowMainWindow();
		break;
	case kMenuOpenProject:
		PickProject();
		break;
	case kMenuExit:
		exiting_ = true;
		DestroyWindow(window_);
		break;
	default:
		break;
	}
}

void App::InitializeWebView() {
	webview_.SetDarkTheme(dark_theme_);
	webview_.Initialize(window_,
		[this](HRESULT result) {
			if (FAILED(result)) {
				ShowThemedMessageBox(window_,
					L"无法初始化 Microsoft Edge WebView2 Runtime。请安装或修复 WebView2 Runtime。",
					L"Grimoire Router App 启动失败",
					MB_OK | MB_ICONERROR,
					dark_theme_);
				return;
			}
			if (!pending_navigation_.empty()) {
				webview_.Navigate(pending_navigation_);
				pending_navigation_.clear();
			} else if (!pending_core_failure_summary_.empty()) {
				webview_.ShowStatus(pending_core_failure_summary_, pending_core_failure_detail_, true);
				pending_core_failure_summary_.clear();
				pending_core_failure_detail_.clear();
			} else if (!project_directory_.empty() && core_.running()) {
				webview_.ShowStatus(L"正在启动 Core", project_directory_, false);
			} else {
				webview_.ShowWelcome();
			}
		},
		[this](std::wstring message) { HandleWebMessage(std::move(message)); });
}

void App::PickProject() {
	Microsoft::WRL::ComPtr<IFileOpenDialog> dialog;
	if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog)))) {
		ShowThemedMessageBox(
			window_, L"无法打开项目选择器。", L"Grimoire Router App", MB_OK | MB_ICONERROR, dark_theme_);
		return;
	}
	FILEOPENDIALOGOPTIONS options{};
	if (SUCCEEDED(dialog->GetOptions(&options))) {
		dialog->SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
	}
	dialog->SetTitle(L"选择 Grimoire Router App 项目目录");
	const HRESULT shown = dialog->Show(window_);
	if (shown != S_OK) {
		return;
	}
	Microsoft::WRL::ComPtr<IShellItem> item;
	if (FAILED(dialog->GetResult(&item))) {
		return;
	}
	PWSTR selected_path = nullptr;
	if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &selected_path)) && selected_path != nullptr) {
		std::wstring project(selected_path);
		CoTaskMemFree(selected_path);
		SwitchProject(std::move(project));
	}
}

std::vector<std::wstring> App::PickAttachments(std::string_view kind) const {
	Microsoft::WRL::ComPtr<IFileOpenDialog> dialog;
	if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog)))) {
		throw std::runtime_error("unable to create the Windows file picker");
	}
	FILEOPENDIALOGOPTIONS options{};
	if (FAILED(dialog->GetOptions(&options)) ||
		FAILED(dialog->SetOptions(
			options | FOS_ALLOWMULTISELECT | FOS_FORCEFILESYSTEM | FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST |
			FOS_NOCHANGEDIR))) {
		throw std::runtime_error("unable to configure the Windows file picker");
	}
	if (kind == "image") {
		const COMDLG_FILTERSPEC filters[] = {
			{L"图片文件", L"*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp;*.tif;*.tiff"},
		};
		static_cast<void>(dialog->SetFileTypes(static_cast<UINT>(std::size(filters)), filters));
		static_cast<void>(dialog->SetFileTypeIndex(1));
		dialog->SetTitle(L"选择要引用的本机图片");
	} else {
		const COMDLG_FILTERSPEC filters[] = {
			{L"文档和常用文件",
				L"*.pdf;*.doc;*.docx;*.xls;*.xlsx;*.ppt;*.pptx;*.txt;*.md;*.csv;*.json;*.xml;*.html;*.htm;*.zip;*.7z"},
			{L"所有文件", L"*.*"},
		};
		static_cast<void>(dialog->SetFileTypes(static_cast<UINT>(std::size(filters)), filters));
		static_cast<void>(dialog->SetFileTypeIndex(1));
		dialog->SetTitle(L"选择要引用的本机文档或文件");
	}
	const HRESULT shown = dialog->Show(window_);
	if (shown == HRESULT_FROM_WIN32(ERROR_CANCELLED)) {
		return {};
	}
	if (FAILED(shown)) {
		throw std::runtime_error("the Windows file picker failed");
	}

	Microsoft::WRL::ComPtr<IShellItemArray> items;
	if (FAILED(dialog->GetResults(&items))) {
		throw std::runtime_error("unable to read selected files");
	}
	DWORD count = 0;
	if (FAILED(items->GetCount(&count))) {
		throw std::runtime_error("unable to count selected files");
	}
	std::vector<std::wstring> paths;
	paths.reserve(count);
	for (DWORD index = 0; index < count; ++index) {
		Microsoft::WRL::ComPtr<IShellItem> item;
		if (FAILED(items->GetItemAt(index, &item))) {
			continue;
		}
		PWSTR selected_path = nullptr;
		if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &selected_path)) && selected_path != nullptr) {
			paths.emplace_back(selected_path);
			CoTaskMemFree(selected_path);
		}
	}
	return paths;
}

void App::SwitchProject(std::wstring project_directory) {
	std::error_code error;
	std::wstring canonical = CanonicalDirectory(project_directory, error);
	if (error || canonical.empty()) {
		ShowThemedMessageBox(window_,
			L"所选路径不是可访问的项目目录。",
			L"无法打开项目",
			MB_OK | MB_ICONERROR,
			dark_theme_);
		return;
	}
	if (core_.running() && ComparableProjectPath(canonical) == ComparableProjectPath(project_directory_)) {
		return;
	}

	webview_.ShowStatus(L"正在启动 Core", canonical, false);
	native_transcript_.SetVisible(false);
	native_transcript_.Clear();
	has_native_transcript_bounds_ = false;
	native_session_id_.clear();
	pending_native_images_.clear();
	core_.Stop();
	project_directory_ = std::move(canonical);
	config_.RecordProject(project_directory_);
	SaveConfigFile();
	UpdateWindowTitle();

	CoreLaunch launch;
	launch.arguments = ResolveOmpCommand(config_.omp_bin, config_.dev_repo.value_or(L""));
	launch.arguments.emplace_back(L"--mode");
	launch.arguments.emplace_back(L"core");
	launch.arguments.emplace_back(L"--no-open");
	launch.arguments.emplace_back(L"--cwd");
	launch.arguments.emplace_back(PathForCli(project_directory_));
	launch.project_directory = project_directory_;

	std::string start_error;
	const HWND target_window = window_;
	if (!core_.Start(std::move(launch),
			[target_window](CoreEvent event) {
				auto payload = std::make_unique<CoreEvent>(std::move(event));
				if (PostMessageW(target_window, kCoreEventMessage, 0, reinterpret_cast<LPARAM>(payload.get()))) {
					payload.release();
				}
			},
			start_error)) {
		ShowCoreFailure(L"无法启动 Core", start_error);
	}
}

void App::HandleCoreEvent(std::unique_ptr<CoreEvent> event) {
	if (!event || shutting_down_) {
		return;
	}
	switch (event->kind) {
	case CoreEventKind::Ready: {
		std::wstring control = Utf8ToWide(event->links.control);
		if (webview_.ready()) {
			webview_.Navigate(control);
		} else {
			pending_navigation_ = std::move(control);
		}
		break;
	}
	case CoreEventKind::StartupSlow:
		webview_.ShowStatus(L"Core 启动时间较长", Utf8ToWide(event->detail), false);
		break;
	case CoreEventKind::StartupFailed:
		ShowCoreFailure(L"Core 启动失败", event->detail);
		break;
	case CoreEventKind::Exited: {
		std::wstring summary = L"Core 已意外退出（code ";
		summary.append(std::to_wstring(event->exit_code));
		summary.push_back(L'）');
		ShowCoreFailure(summary, event->detail);
		break;
	}
	}
}

void App::HandleWebMessage(std::wstring message) {
	if (message == L"open-project") {
		PickProject();
		return;
	}
	HandleDesktopRequest(WideToUtf8(message));
}

void App::HandleDesktopRequest(std::string_view payload) {
	using Json = nlohmann::json;
	const Json request = Json::parse(payload, nullptr, false);
	if (request.is_discarded() || !request.is_object() || request.value("channel", "") != "omp-desktop") {
		return;
	}
	const std::uint64_t id = request.value("id", std::uint64_t{0});
	if (id == 0 || !request.contains("command") || !request["command"].is_string()) {
		return;
	}
	const std::string command = request["command"].get<std::string>();
	const Json args = request.value("args", Json::object());
	const auto reply = [this, id](bool ok, Json value, std::string error = {}) {
		Json response{{"channel", "omp-desktop-response"}, {"id", id}, {"ok", ok}};
		if (ok) {
			response["value"] = std::move(value);
		} else {
			response["error"] = std::move(error);
		}
		webview_.PostJson(Utf8ToWide(response.dump()));
	};

	try {
		if (command == "window_theme") {
			const std::string theme = args.at("theme").get<std::string>();
			if (theme != "light" && theme != "dark") {
				throw std::invalid_argument("unsupported window theme");
			}
			const bool dark = theme == "dark";
			if (dark != dark_theme_) {
				ApplyTheme(dark);
			} else {
				native_transcript_.SetDarkTheme(dark);
			}
			reply(true, Json{{"theme", theme}});
			return;
		}
		if (command == "window_action") {
			const std::string action = args.at("action").get<std::string>();
			const auto post_command = [this, &reply](UINT native_command) {
				reply(true, nullptr);
				PostMessageW(window_, WM_COMMAND, native_command, 0);
			};
			if (action == "drag") {
				reply(true, nullptr);
				ReleaseCapture();
				PostMessageW(window_, WM_NCLBUTTONDOWN, HTCAPTION, 0);
				return;
			}
			if (const auto resize_command = WindowSizingCommandForAction(action)) {
				reply(true, nullptr);
				if (!IsZoomed(window_) && !IsIconic(window_)) {
					ReleaseCapture();
					PostMessageW(window_, WM_SYSCOMMAND, *resize_command, 0);
				}
				return;
			}
			if (action == "minimize") {
				reply(true, nullptr);
				ShowWindow(window_, SW_MINIMIZE);
				return;
			}
			if (action == "toggle_maximize") {
				reply(true, nullptr);
				ShowWindow(window_, IsZoomed(window_) ? SW_RESTORE : SW_MAXIMIZE);
				return;
			}
			if (action == "close") {
				reply(true, nullptr);
				PostMessageW(window_, WM_CLOSE, 0, 0);
				return;
			}
			if (action == "exit") {
				post_command(kMenuExit);
				return;
			}
			if (action == "open_project") {
				post_command(kMenuOpenProject);
				return;
			}
			if (action == "reload") {
				post_command(kMenuReload);
				return;
			}
			if (action == "toggle_native_transcript") {
				post_command(kMenuToggleNativeTranscript);
				return;
			}
			if (action == "undo") {
				post_command(kMenuUndo);
				return;
			}
			if (action == "redo") {
				post_command(kMenuRedo);
				return;
			}
			if (action == "cut") {
				post_command(kMenuCut);
				return;
			}
			if (action == "copy") {
				post_command(kMenuCopy);
				return;
			}
			if (action == "paste") {
				post_command(kMenuPaste);
				return;
			}
			if (action == "select_all") {
				post_command(kMenuSelectAll);
				return;
			}
			if (action == "about") {
				post_command(kMenuAbout);
				return;
			}
			throw std::invalid_argument("unsupported window action");
		}
		if (command == "window_agent_rail") {
			SetAgentRailOpen(args.at("open").get<bool>());
			reply(true, Json{{"open", agent_rail_open_}});
			return;
		}
		if (command == "native_transcript_replace") {
			if (native_transcript_.Window() == nullptr) {
				reply(false, nullptr, "native transcript renderer is unavailable");
				return;
			}
			const Json& snapshot = args.at("snapshot");
			const Json& encoded_rows = snapshot.at("rows");
			if (!encoded_rows.is_array() || encoded_rows.size() > 200'000) {
				reply(false, nullptr, "native transcript snapshot is too large");
				return;
			}
			std::string session_id;
			if (const auto found = snapshot.find("sessionId"); found != snapshot.end() && found->is_string()) {
				session_id = found->get<std::string>();
			}
			const bool preserve_streaming_tail = session_id == native_session_id_;
			std::vector<NativeTranscriptRow> rows;
			rows.reserve(encoded_rows.size() + 1);
			std::unordered_set<std::string> ids;
			ids.reserve(encoded_rows.size());
			for (const Json& encoded_row : encoded_rows) {
				NativeTranscriptRow row = ParseNativeRow(encoded_row);
				ids.insert(row.id);
				rows.push_back(std::move(row));
			}
			if (preserve_streaming_tail) {
				const NativeTranscriptModel& current = native_transcript_.Model();
				for (std::size_t index = 0; index < current.Size(); ++index) {
					const NativeTranscriptRow& row = current.RowAt(index);
					if (HasFlag(row.flags, NativeTranscriptRowFlags::Streaming) && !ids.contains(row.id)) {
						rows.push_back(row);
					}
				}
			}
			native_session_id_ = session_id;
			native_transcript_.ReplaceSnapshot(std::move(rows));
			const std::size_t history_remaining = snapshot.value("historyRemaining", std::size_t{0});
			const bool history_loading = snapshot.value("historyLoading", false);
			native_transcript_.SetHistoryState(history_remaining, history_loading);
			reply(true, Json{{"enabled", native_transcript_preferred_}});
			return;
		}
		if (command == "native_transcript_upsert") {
			if (native_transcript_.Window() == nullptr) {
				reply(false, nullptr, "native transcript renderer is unavailable");
				return;
			}
			native_transcript_.Upsert(ParseNativeRow(args.at("row")));
			reply(true, nullptr);
			return;
		}
		if (command == "native_transcript_remove") {
			const std::string id_value = args.at("id").get<std::string>();
			if (id_value.size() <= 512) {
				native_transcript_.Remove(id_value);
			}
			reply(true, nullptr);
			return;
		}
		if (command == "native_transcript_take_events") {
			Json events = Json::array();
			if (native_transcript_.TakeHistoryRequest()) {
				events.push_back("load-earlier");
			}
			for (const std::string& image_id : pending_native_images_) {
				events.push_back(Json{{"type", "image-needed"}, {"imageId", image_id}});
			}
			pending_native_images_.clear();
			reply(true, std::move(events));
			return;
		}
		if (command == "native_transcript_image") {
			const Json& image = args.at("image");
			const std::string image_id = image.at("imageId").get<std::string>();
			const std::string data = image.at("data").get<std::string>();
			if (image_id.empty() || image_id.size() > 256 || data.size() > 6 * 1024 * 1024) {
				reply(false, nullptr, "native transcript image payload is invalid");
				return;
			}
			std::erase(pending_native_images_, image_id);
			native_transcript_.ProvideImage(image_id, DecodeBase64(data));
			reply(true, nullptr);
			return;
		}
		if (command == "native_transcript_viewport") {
			if (native_transcript_.Window() == nullptr) {
				reply(false, nullptr, "native transcript renderer is unavailable");
				return;
			}
			const Json& viewport = args.at("viewport");
			const std::string theme = viewport.at("theme").get<std::string>();
			if (theme != "light" && theme != "dark") {
				throw std::invalid_argument("unsupported native transcript theme");
			}
			const bool dark = theme == "dark";
			if (dark != dark_theme_) {
				ApplyTheme(dark);
			} else {
				native_transcript_.SetDarkTheme(dark);
			}
			const std::int64_t x = std::clamp<std::int64_t>(viewport.at("x").get<std::int64_t>(), -1'000'000, 1'000'000);
			const std::int64_t y = std::clamp<std::int64_t>(viewport.at("y").get<std::int64_t>(), -1'000'000, 1'000'000);
			const std::int64_t width =
				std::clamp<std::int64_t>(viewport.at("width").get<std::int64_t>(), 0, 1'000'000);
			const std::int64_t height =
				std::clamp<std::int64_t>(viewport.at("height").get<std::int64_t>(), 0, 1'000'000);
			RECT client{};
			GetClientRect(window_, &client);
			const std::int64_t left = std::clamp<std::int64_t>(x, client.left, client.right);
			const std::int64_t top = std::clamp<std::int64_t>(y, client.top, client.bottom);
			const std::int64_t right = std::clamp<std::int64_t>(x + width, left, client.right);
			const std::int64_t bottom = std::clamp<std::int64_t>(y + height, top, client.bottom);
			const RECT requested_bounds{static_cast<LONG>(left),
				static_cast<LONG>(top),
				static_cast<LONG>(right),
				static_cast<LONG>(bottom)};
			const int resize_inset =
				MulDiv(kWebResizeEdgeWidth, static_cast<int>(GetDpiForWindow(window_)), USER_DEFAULT_SCREEN_DPI);
			native_transcript_bounds_ = InsetBoundsAtWindowEdges(requested_bounds, client, resize_inset);
			has_native_transcript_bounds_ = native_transcript_bounds_.right > native_transcript_bounds_.left &&
				native_transcript_bounds_.bottom > native_transcript_bounds_.top;
			if (has_native_transcript_bounds_) {
				native_transcript_.SetBounds(native_transcript_bounds_);
			}
			native_transcript_.SetVisible(has_native_transcript_bounds_ && native_transcript_preferred_);
			reply(true, Json{{"enabled", native_transcript_preferred_}});
			return;
		}
		if (command == "native_transcript_occlusion") {
			if (native_transcript_.Window() == nullptr) {
				reply(false, nullptr, "native transcript renderer is unavailable");
				return;
			}
			const auto found = args.find("occlusion");
			if (found == args.end() || found->is_null()) {
				native_transcript_.SetOcclusion(std::nullopt);
				reply(true, nullptr);
				return;
			}
			const Json& occlusion = *found;
			const std::int64_t x = std::clamp<std::int64_t>(occlusion.at("x").get<std::int64_t>(), -1'000'000, 1'000'000);
			const std::int64_t y = std::clamp<std::int64_t>(occlusion.at("y").get<std::int64_t>(), -1'000'000, 1'000'000);
			const std::int64_t width = std::clamp<std::int64_t>(occlusion.at("width").get<std::int64_t>(), 0, 1'000'000);
			const std::int64_t height = std::clamp<std::int64_t>(occlusion.at("height").get<std::int64_t>(), 0, 1'000'000);
			native_transcript_.SetOcclusion(RECT{
				static_cast<LONG>(x),
				static_cast<LONG>(y),
				static_cast<LONG>(x + width),
				static_cast<LONG>(y + height),
			});
			reply(true, nullptr);
			return;
		}
		if (command == "native_transcript_hide") {
			native_transcript_.SetOcclusion(std::nullopt);
			native_transcript_.SetVisible(false);
			has_native_transcript_bounds_ = false;
			reply(true, nullptr);
			return;
		}
		if (command == "project_list") {
			Json projects = Json::array();
			for (const auto& project : config_.recent_projects) {
				projects.push_back(WideToUtf8(project));
			}
			Json names = Json::object();
			for (const auto& [path, name] : config_.project_names) {
				names[WideToUtf8(path)] = WideToUtf8(name);
			}
			Json value;
			value["recent_projects"] = std::move(projects);
			value["last_project"] = config_.last_project ? Json(WideToUtf8(*config_.last_project)) : Json(nullptr);
			value["current_project"] = project_directory_.empty() ? Json(nullptr) : Json(WideToUtf8(project_directory_));
			value["project_names"] = std::move(names);
			reply(true, std::move(value));
			return;
		}
		if (command == "project_open") {
			reply(true, nullptr);
			PickProject();
			return;
		}
		if (command == "project_switch") {
			const std::wstring path = Utf8ToWide(args.at("path").get_ref<const std::string&>());
			if (path.empty()) {
				reply(false, nullptr, "project path is empty");
				return;
			}
			reply(true, nullptr);
			SwitchProject(path);
			return;
		}
		if (command == "project_open_imported") {
			const std::wstring path = Utf8ToWide(args.at("path").get_ref<const std::string&>());
			const std::string session_id = args.at("sessionId").get<std::string>();
			if (session_id.empty() || session_id.size() > 128 ||
				!std::ranges::all_of(session_id, [](unsigned char ch) { return std::isalnum(ch) || ch == '-' || ch == '_'; })) {
				reply(false, nullptr, "imported session id is invalid");
				return;
			}
			std::error_code path_error;
			const std::wstring canonical = CanonicalDirectory(path, path_error);
			if (path_error || canonical.empty()) {
				reply(false, nullptr, "the imported session project directory is not available");
				return;
			}
			const bool switched = !core_.running() ||
				ComparableProjectPath(canonical) != ComparableProjectPath(project_directory_);
			if (!switched) {
				reply(true, Json{{"switched", false}});
				return;
			}
			pending_imported_session_id_ = session_id;
			reply(true, Json{{"switched", true}});
			SwitchProject(canonical);
			return;
		}
		if (command == "project_take_imported") {
			Json value{{"session_id",
				pending_imported_session_id_.empty() ? Json(nullptr) : Json(pending_imported_session_id_)}};
			pending_imported_session_id_.clear();
			reply(true, std::move(value));
			return;
		}
		if (command == "project_rename") {
			const std::wstring path = Utf8ToWide(args.at("path").get_ref<const std::string&>());
			const std::wstring name = Utf8ToWide(args.at("name").get_ref<const std::string&>());
			if (!config_.SetProjectName(path, name)) {
				reply(false, nullptr, "project name must contain 1-120 characters");
				return;
			}
			SaveConfigFile();
			if (ComparableProjectPath(path) == ComparableProjectPath(project_directory_)) {
				UpdateWindowTitle();
			}
			reply(true, nullptr);
			return;
		}
		if (command == "project_remove") {
			const std::wstring path = Utf8ToWide(args.at("path").get_ref<const std::string&>());
			if (path.empty()) {
				reply(false, nullptr, "project path is empty");
				return;
			}
			if (!project_directory_.empty() &&
				ComparableProjectPath(path) == ComparableProjectPath(project_directory_)) {
				reply(false, nullptr, "the active project cannot be removed");
				return;
			}
			static_cast<void>(config_.RemoveProject(path));
			SaveConfigFile();
			reply(true, nullptr);
			return;
		}
		if (command == "project_reveal") {
			const std::wstring path = Utf8ToWide(args.at("path").get_ref<const std::string&>());
			std::error_code path_error;
			const std::wstring canonical = CanonicalDirectory(path, path_error);
			if (path_error || canonical.empty()) {
				reply(false, nullptr, "project directory is not available");
				return;
			}
			const HINSTANCE opened = ShellExecuteW(window_, L"open", canonical.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
			if (reinterpret_cast<INT_PTR>(opened) <= 32) {
				reply(false, nullptr, "Windows Explorer rejected the project path");
				return;
			}
			reply(true, nullptr);
			return;
		}
		if (command == "attachment_pick") {
			Json paths = Json::array();
			const std::string kind = args.value("kind", "document");
			for (const auto& path : PickAttachments(kind)) {
				paths.push_back(WideToUtf8(path));
			}
			reply(true, std::move(paths));
			return;
		}
		if (command == "screenshot_start") {
			if (screenshot_active_) {
				reply(false, nullptr, "a screenshot capture is already active");
				return;
			}
			ScopedFlag screenshot_guard(screenshot_active_);
			ScreenshotCaptureResult capture = ScreenshotOverlay::Capture(instance_, window_);
			if (!capture.error.empty()) {
				reply(false, nullptr, WideToUtf8(capture.error));
				return;
			}
			if (!capture.completed) {
				reply(true, Json{{"completed", false}});
				return;
			}
			constexpr std::size_t kMaximumScreenshotBytes = 24 * 1024 * 1024;
			if (capture.png.empty() || capture.png.size() > kMaximumScreenshotBytes) {
				reply(false, nullptr, "the selected screenshot exceeds the 24 MB image limit");
				return;
			}
			reply(true,
				Json{{"completed", true},
					{"clipboardWritten", capture.clipboard_written},
					{"mimeType", "image/png"},
					{"name", "screenshot-" + std::to_string(GetTickCount64()) + ".png"},
					{"width", capture.width},
					{"height", capture.height},
					{"data", EncodeBase64(capture.png)}});
			return;
		}
		if (command == "attachment_status") {
			const std::vector<std::string> paths = args.at("paths").get<std::vector<std::string>>();
			if (paths.size() > 64) {
				reply(false, nullptr, "attachment status request is too large");
				return;
			}
			Json statuses = Json::array();
			for (const auto& path : paths) {
				std::error_code status_error;
				const bool available = std::filesystem::is_regular_file(Utf8ToWide(path), status_error);
				statuses.push_back(Json{{"path", path}, {"available", available && !status_error}});
			}
			reply(true, std::move(statuses));
			return;
		}
		if (command == "session_preferences") {
			reply(true,
				Json{{"pinned_sessions", config_.pinned_sessions}, {"session_read_through", config_.session_read_through}});
			return;
		}
		if (command == "session_preferences_update") {
			std::vector<std::string> pinned = args.at("pinnedSessions").get<std::vector<std::string>>();
			std::map<std::string, std::string> read_through =
				args.at("sessionReadThrough").get<std::map<std::string, std::string>>();
			if (pinned.size() > 1000 || read_through.size() > 5000) {
				reply(false, nullptr, "session preference payload is too large");
				return;
			}
			config_.pinned_sessions = std::move(pinned);
			config_.session_read_through = std::move(read_through);
			SaveConfigFile();
			reply(true, nullptr);
			return;
		}
		reply(false, nullptr, "unsupported desktop command");
	} catch (const std::exception& error) {
		reply(false, nullptr, error.what());
	}
}

void App::ShowCoreFailure(std::wstring_view summary, std::string_view detail) {
	const std::wstring wide_detail = Utf8ToWide(detail);
	if (webview_.ready()) {
		webview_.ShowStatus(summary, wide_detail, true);
	} else {
		// Core now starts in parallel with WebView2.  Keep an early failure for
		// the startup page instead of blocking WebView initialization behind a
		// modal dialog on the UI thread.
		pending_core_failure_summary_ = summary;
		pending_core_failure_detail_ = wide_detail;
	}
}

void App::UpdateWindowTitle() const {
	if (window_ == nullptr) {
		return;
	}
	if (project_directory_.empty()) {
		SetWindowTextW(window_, kBaseWindowTitle);
		return;
	}
	std::wstring title = config_.ProjectName(project_directory_).value_or(DirectoryName(project_directory_));
	title.append(L" — Grimoire Router App");
	SetWindowTextW(window_, title.c_str());
}

void App::SaveWindowState() {
	if (window_ == nullptr || !IsWindow(window_)) {
		return;
	}
	WINDOWPLACEMENT placement{};
	placement.length = sizeof(placement);
	if (!GetWindowPlacement(window_, &placement)) {
		return;
	}
	const RECT& bounds = agent_rail_open_ && has_compact_window_bounds_ ? compact_window_bounds_ : placement.rcNormalPosition;
	config_.window_x = bounds.left;
	config_.window_y = bounds.top;
	config_.window_width = bounds.right - bounds.left;
	config_.window_height = bounds.bottom - bounds.top;
	config_.window_maximized = placement.showCmd == SW_SHOWMAXIMIZED;
	SaveConfigFile();
}

void App::SaveConfigFile() {
	std::string error;
	if (!SaveConfig(config_path_, config_, error)) {
		const std::string diagnostic = "OMP cpp-shell config save failed: " + error + "\n";
		OutputDebugStringA(diagnostic.c_str());
	}
}

} // namespace omp::shell
