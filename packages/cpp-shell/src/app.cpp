#include "omp_shell/app.h"

#include "omp_shell/path_utils.h"
#include "omp_shell/resource.h"
#include "omp_shell/text_utils.h"
#include "omp_shell/window_layout.h"

#include <ShObjIdl.h>
#include <dwmapi.h>
#include <wincrypt.h>

#include <nlohmann/json.hpp>

#include <algorithm>
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
constexpr wchar_t kBaseWindowTitle[] = L"OMP";
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

constexpr COLORREF kMenuBackground = RGB(31, 31, 32);
constexpr COLORREF kMenuHotBackground = RGB(55, 55, 58);
constexpr COLORREF kMenuForeground = RGB(245, 245, 245);
constexpr COLORREF kMenuDisabledForeground = RGB(132, 132, 136);
constexpr COLORREF kMenuSeparator = RGB(70, 70, 73);

struct DarkMenuItem {
	const wchar_t* text;
	bool menu_bar;
	bool separator;
};

constexpr DarkMenuItem kShowWindowItem{L"打开 OMP", false, false};
constexpr DarkMenuItem kTrayOpenProjectItem{L"打开项目...", false, false};
constexpr DarkMenuItem kTrayExitItem{L"退出", false, false};
constexpr DarkMenuItem kMenuSeparatorItem{nullptr, false, true};

[[nodiscard]] HBRUSH DarkMenuBrush() noexcept {
	static HBRUSH brush = CreateSolidBrush(kMenuBackground);
	return brush;
}

[[nodiscard]] int DefaultCompactWindowWidth(UINT dpi) noexcept {
	RECT bounds{0, 0, MulDiv(kCompactClientWidth, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI), 1};
	if (AdjustWindowRectExForDpi(&bounds, kWindowStyle, FALSE, 0, dpi) == FALSE) {
		return bounds.right - bounds.left;
	}
	return bounds.right - bounds.left;
}

[[nodiscard]] HBRUSH DarkMenuHotBrush() noexcept {
	static HBRUSH brush = CreateSolidBrush(kMenuHotBackground);
	return brush;
}

[[nodiscard]] HFONT CreateMenuFont(HWND window) noexcept {
	NONCLIENTMETRICSW metrics{};
	metrics.cbSize = sizeof(metrics);
	const UINT dpi = window == nullptr ? USER_DEFAULT_SCREEN_DPI : GetDpiForWindow(window);
	if (SystemParametersInfoForDpi(SPI_GETNONCLIENTMETRICS, sizeof(metrics), &metrics, 0, dpi) != FALSE) {
		return CreateFontIndirectW(&metrics.lfMenuFont);
	}
	return nullptr;
}

void ApplyDarkMenuBackground(HMENU menu) noexcept {
	MENUINFO info{};
	info.cbSize = sizeof(info);
	info.fMask = MIM_BACKGROUND | MIM_APPLYTOSUBMENUS;
	info.hbrBack = DarkMenuBrush();
	SetMenuInfo(menu, &info);
}

void InsertDarkMenuItem(
	HMENU menu, const DarkMenuItem& item, UINT command, HMENU submenu = nullptr, UINT state = MFS_ENABLED) {
	MENUITEMINFOW info{};
	info.cbSize = sizeof(info);
	info.fMask = MIIM_FTYPE | MIIM_DATA | MIIM_STATE;
	info.fType = MFT_OWNERDRAW | (item.separator ? MFT_SEPARATOR : MFT_STRING);
	info.fState = state;
	info.dwItemData = reinterpret_cast<ULONG_PTR>(&item);
	if (item.text != nullptr) {
		info.fMask |= MIIM_STRING;
		info.dwTypeData = const_cast<wchar_t*>(item.text);
	}
	if (submenu != nullptr) {
		info.fMask |= MIIM_SUBMENU;
		info.hSubMenu = submenu;
	} else if (!item.separator) {
		info.fMask |= MIIM_ID;
		info.wID = command;
	}
	InsertMenuItemW(menu, static_cast<UINT>(GetMenuItemCount(menu)), TRUE, &info);
}

[[nodiscard]] bool MeasureDarkMenuItem(HWND window, MEASUREITEMSTRUCT* measure) noexcept {
	if (measure == nullptr || measure->CtlType != ODT_MENU || measure->itemData == 0) {
		return false;
	}
	const auto* item = reinterpret_cast<const DarkMenuItem*>(measure->itemData);
	const UINT dpi = window == nullptr ? USER_DEFAULT_SCREEN_DPI : GetDpiForWindow(window);
	if (item->separator) {
		measure->itemWidth = 0;
		measure->itemHeight = static_cast<UINT>(MulDiv(9, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI));
		return true;
	}

	HDC dc = GetDC(window);
	if (dc == nullptr) {
		return false;
	}
	HFONT font = CreateMenuFont(window);
	HGDIOBJ previous_font = nullptr;
	if (font != nullptr) {
		previous_font = SelectObject(dc, font);
	}
	const std::wstring_view text(item->text == nullptr ? L"" : item->text);
	const std::size_t tab = text.find(L'\t');
	const std::wstring_view label = text.substr(0, tab);
	const std::wstring_view accelerator = tab == std::wstring_view::npos ? std::wstring_view{} : text.substr(tab + 1);
	SIZE label_size{};
	SIZE accelerator_size{};
	GetTextExtentPoint32W(dc, label.data(), static_cast<int>(label.size()), &label_size);
	if (!accelerator.empty()) {
		GetTextExtentPoint32W(dc, accelerator.data(), static_cast<int>(accelerator.size()), &accelerator_size);
	}
	if (previous_font != nullptr) {
		SelectObject(dc, previous_font);
	}
	if (font != nullptr) {
		DeleteObject(font);
	}
	ReleaseDC(window, dc);

	const int horizontal_padding = MulDiv(item->menu_bar ? 18 : 52, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI);
	const int accelerator_gap = accelerator.empty()
		? 0
		: MulDiv(28, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI) + accelerator_size.cx;
	measure->itemWidth = static_cast<UINT>(label_size.cx + horizontal_padding + accelerator_gap);
	measure->itemHeight = static_cast<UINT>(item->menu_bar
		? GetSystemMetricsForDpi(SM_CYMENU, dpi)
		: std::max(MulDiv(28, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI),
			static_cast<int>(label_size.cy) + MulDiv(8, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI)));
	return true;
}

void DrawMenuText(HDC dc, std::wstring_view text, RECT bounds, UINT flags) noexcept {
	if (text.empty()) {
		return;
	}
	DrawTextW(dc, const_cast<wchar_t*>(text.data()), static_cast<int>(text.size()), &bounds, flags);
}

[[nodiscard]] bool DrawDarkMenuItem(HWND window, const DRAWITEMSTRUCT* draw) noexcept {
	if (draw == nullptr || draw->CtlType != ODT_MENU || draw->itemData == 0) {
		return false;
	}
	const auto* item = reinterpret_cast<const DarkMenuItem*>(draw->itemData);
	const bool selected = (draw->itemState & (ODS_SELECTED | ODS_HOTLIGHT)) != 0;
	FillRect(draw->hDC, &draw->rcItem, selected ? DarkMenuHotBrush() : DarkMenuBrush());
	const UINT dpi = window == nullptr ? USER_DEFAULT_SCREEN_DPI : GetDpiForWindow(window);
	if (item->separator) {
		const int y = (draw->rcItem.top + draw->rcItem.bottom) / 2;
		RECT separator{draw->rcItem.left + MulDiv(28, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI),
			y,
			draw->rcItem.right - MulDiv(8, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI),
			y + 1};
		HBRUSH brush = CreateSolidBrush(kMenuSeparator);
		FillRect(draw->hDC, &separator, brush);
		DeleteObject(brush);
		return true;
	}

	const bool disabled = (draw->itemState & (ODS_DISABLED | ODS_GRAYED)) != 0;
	SetBkMode(draw->hDC, TRANSPARENT);
	SetTextColor(draw->hDC, disabled ? kMenuDisabledForeground : kMenuForeground);
	HFONT font = CreateMenuFont(window);
	HGDIOBJ previous_font = nullptr;
	if (font != nullptr) {
		previous_font = SelectObject(draw->hDC, font);
	}
	UINT text_flags = DT_SINGLELINE | DT_VCENTER;
	if ((draw->itemState & ODS_NOACCEL) != 0) {
		text_flags |= DT_HIDEPREFIX;
	}
	const std::wstring_view text(item->text == nullptr ? L"" : item->text);
	if (item->menu_bar) {
		DrawMenuText(draw->hDC, text, draw->rcItem, text_flags | DT_CENTER);
	} else {
		const int left_padding = MulDiv(28, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI);
		const int right_padding = MulDiv(12, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI);
		RECT text_bounds = draw->rcItem;
		text_bounds.left += left_padding;
		text_bounds.right -= right_padding;
		const std::size_t tab = text.find(L'\t');
		DrawMenuText(draw->hDC, text.substr(0, tab), text_bounds, text_flags | DT_LEFT);
		if (tab != std::wstring_view::npos) {
			DrawMenuText(draw->hDC, text.substr(tab + 1), text_bounds, text_flags | DT_RIGHT);
		}
		if ((draw->itemState & ODS_CHECKED) != 0) {
			const int center_x = draw->rcItem.left + MulDiv(13, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI);
			const int center_y = (draw->rcItem.top + draw->rcItem.bottom) / 2;
			HPEN pen = CreatePen(PS_SOLID,
				std::max(1, MulDiv(2, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI)),
				disabled ? kMenuDisabledForeground : kMenuForeground);
			HGDIOBJ previous_pen = SelectObject(draw->hDC, pen);
			MoveToEx(draw->hDC, center_x - MulDiv(4, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI), center_y, nullptr);
			LineTo(draw->hDC, center_x - MulDiv(1, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI), center_y + MulDiv(3, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI));
			LineTo(draw->hDC, center_x + MulDiv(5, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI), center_y - MulDiv(4, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI));
			SelectObject(draw->hDC, previous_pen);
			DeleteObject(pen);
		}
	}
	if (previous_font != nullptr) {
		SelectObject(draw->hDC, previous_font);
	}
	if (font != nullptr) {
		DeleteObject(font);
	}
	return true;
}

enum class PreferredAppMode : int {
	Default = 0,
	AllowDark = 1,
};

using SetPreferredAppModeFn = PreferredAppMode(WINAPI*)(PreferredAppMode);
using AllowDarkModeForWindowFn = BOOL(WINAPI*)(HWND, BOOL);
using FlushMenuThemesFn = void(WINAPI*)();
using SetWindowThemeFn = HRESULT(WINAPI*)(HWND, LPCWSTR, LPCWSTR);

[[nodiscard]] HMODULE LoadUxTheme() noexcept {
	return LoadLibraryExW(L"uxtheme.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
}

void EnableDarkApplicationMode() noexcept {
	const HMODULE theme = LoadUxTheme();
	if (theme == nullptr) {
		return;
	}
	const auto set_preferred = reinterpret_cast<SetPreferredAppModeFn>(
		GetProcAddress(theme, MAKEINTRESOURCEA(135)));
	if (set_preferred != nullptr) {
		static_cast<void>(set_preferred(PreferredAppMode::AllowDark));
	}
	FreeLibrary(theme);
}

void EnableDarkWindowMode(HWND window) noexcept {
	const HMODULE theme = LoadUxTheme();
	if (theme == nullptr) {
		return;
	}
	const auto allow_window = reinterpret_cast<AllowDarkModeForWindowFn>(
		GetProcAddress(theme, MAKEINTRESOURCEA(133)));
	const auto set_window_theme = reinterpret_cast<SetWindowThemeFn>(GetProcAddress(theme, "SetWindowTheme"));
	const auto flush_menus = reinterpret_cast<FlushMenuThemesFn>(
		GetProcAddress(theme, MAKEINTRESOURCEA(136)));
	if (allow_window != nullptr) {
		static_cast<void>(allow_window(window, TRUE));
	}
	if (set_window_theme != nullptr) {
		static_cast<void>(set_window_theme(window, L"DarkMode_Explorer", nullptr));
	}
	if (flush_menus != nullptr) {
		flush_menus();
	}
	FreeLibrary(theme);
	DrawMenuBar(window);
}

[[nodiscard]] HICON LoadEmbeddedIcon(HINSTANCE instance, int width, int height) noexcept {
	return reinterpret_cast<HICON>(LoadImageW(
		instance,
		MAKEINTRESOURCEW(IDI_OMP_APP),
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
	row.height = std::clamp(value.value("estimatedHeight", 48), 1, 100'000);
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

} // namespace

App::App(HINSTANCE instance) : instance_(instance), config_path_(DefaultConfigPath()), config_(LoadConfig(config_path_)) {}

App::~App() {
	shutting_down_ = true;
	core_.Stop();
	RemoveTray();
}

int App::Run(int show_command) {
	EnableDarkApplicationMode();
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
	case WM_CREATE:
		InitializeTray();
		if (native_transcript_.Create(window_, instance_)) {
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
		}
		InitializeWebView();
		return 0;
	case WM_SIZE:
		webview_.Resize();
		if (has_native_transcript_bounds_) {
			native_transcript_.SetBounds(native_transcript_bounds_);
		}
		return 0;
	case WM_GETMINMAXINFO: {
		MONITORINFO monitor_info{};
		monitor_info.cbSize = sizeof(monitor_info);
		const HMONITOR monitor = MonitorFromWindow(window_, MONITOR_DEFAULTTONEAREST);
		if (monitor != nullptr && GetMonitorInfoW(monitor, &monitor_info)) {
			auto* limits = reinterpret_cast<MINMAXINFO*>(lparam);
			limits->ptMaxPosition.x = monitor_info.rcWork.left - monitor_info.rcMonitor.left;
			limits->ptMaxPosition.y = monitor_info.rcWork.top - monitor_info.rcMonitor.top;
			limits->ptMaxSize.x = monitor_info.rcWork.right - monitor_info.rcWork.left;
			limits->ptMaxSize.y = monitor_info.rcWork.bottom - monitor_info.rcWork.top;
		}
		return 0;
	}
	case WM_DPICHANGED: {
		const auto* suggested = reinterpret_cast<RECT*>(lparam);
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
		if (MeasureDarkMenuItem(window_, reinterpret_cast<MEASUREITEMSTRUCT*>(lparam))) {
			return TRUE;
		}
		break;
	case WM_DRAWITEM:
		if (DrawDarkMenuItem(window_, reinterpret_cast<DRAWITEMSTRUCT*>(lparam))) {
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
			MessageBoxW(window_, L"OMP C++ Shell\nNative Windows host for omp core", L"About OMP", MB_OK | MB_ICONINFORMATION);
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
	window_class.hIcon = LoadEmbeddedIcon(instance_, GetSystemMetrics(SM_CXICON), GetSystemMetrics(SM_CYICON));
	window_class.hIconSm = LoadEmbeddedIcon(instance_, GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON));
	if (window_class.hIcon == nullptr) {
		window_class.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
	}
	if (window_class.hIconSm == nullptr) {
		window_class.hIconSm = window_class.hIcon;
	}
	window_class.hbrBackground = CreateSolidBrush(RGB(32, 33, 35));
	window_class.lpszClassName = kWindowClassName;
	return RegisterClassExW(&window_class) != 0 || GetLastError() == ERROR_CLASS_ALREADY_EXISTS;
}

bool App::CreateMainWindow(int show_command) {
	int x = CW_USEDEFAULT;
	int y = CW_USEDEFAULT;
	int width = config_.window_width.value_or(DefaultCompactWindowWidth(GetDpiForSystem()));
	int height = config_.window_height.value_or(820);
	width = std::max(width, 800);
	height = std::max(height, 600);
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
	const LONG_PTR window_style = GetWindowLongPtrW(window_, GWL_STYLE);
	SetWindowLongPtrW(window_, GWL_STYLE, window_style & ~static_cast<LONG_PTR>(WS_CAPTION));
	SetWindowPos(window_,
		nullptr,
		0,
		0,
		0,
		0,
		SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER);
	const BOOL dark_mode = TRUE;
	DwmSetWindowAttribute(window_, 20, &dark_mode, sizeof(dark_mode));
	EnableDarkWindowMode(window_);
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
	tray_icon_.hIcon = LoadEmbeddedIcon(
		instance_, GetSystemMetricsForDpi(SM_CXSMICON, dpi), GetSystemMetricsForDpi(SM_CYSMICON, dpi));
	if (tray_icon_.hIcon == nullptr) {
		tray_icon_.hIcon = reinterpret_cast<HICON>(GetClassLongPtrW(window_, GCLP_HICONSM));
	}
	wcscpy_s(tray_icon_.szTip, L"OMP C++ Shell");
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
		if (IsZoomed(window_) || IsIconic(window_)) {
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
		has_compact_window_bounds_ = true;
		const int rail_width = MulDiv(kAgentRailWidth, static_cast<int>(GetDpiForWindow(window_)), USER_DEFAULT_SCREEN_DPI);
		const RECT expanded = ExpandWindowBoundsForRail(compact_window_bounds_, monitor_info.rcWork, rail_width);
		SetWindowPos(window_,
			nullptr,
			expanded.left,
			expanded.top,
			expanded.right - expanded.left,
			expanded.bottom - expanded.top,
			SWP_NOACTIVATE | SWP_NOZORDER);
		return;
	}

	if (!has_compact_window_bounds_) {
		return;
	}
	const RECT compact = compact_window_bounds_;
	has_compact_window_bounds_ = false;
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

void App::ShowTrayMenu() {
	POINT cursor{};
	GetCursorPos(&cursor);
	HMENU menu = CreatePopupMenu();
	InsertDarkMenuItem(menu, kShowWindowItem, kMenuShowWindow, nullptr, MFS_DEFAULT);
	InsertDarkMenuItem(menu, kTrayOpenProjectItem, kMenuOpenProject);
	InsertDarkMenuItem(menu, kMenuSeparatorItem, 0);
	InsertDarkMenuItem(menu, kTrayExitItem, kMenuExit);
	ApplyDarkMenuBackground(menu);
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
	webview_.Initialize(window_,
		[this](HRESULT result) {
			if (FAILED(result)) {
				MessageBoxW(window_,
					L"无法初始化 Microsoft Edge WebView2 Runtime。请安装或修复 WebView2 Runtime。",
					L"OMP 启动失败",
					MB_OK | MB_ICONERROR);
				return;
			}
			if (!pending_navigation_.empty()) {
				webview_.Navigate(pending_navigation_);
				pending_navigation_.clear();
			} else if (const auto initial_project = EnvironmentValue(L"OMP_CPP_SHELL_INITIAL_PROJECT");
				initial_project && std::filesystem::is_directory(*initial_project)) {
				SwitchProject(*initial_project);
			} else if (config_.last_project && std::filesystem::is_directory(*config_.last_project)) {
				SwitchProject(*config_.last_project);
			} else {
				webview_.ShowWelcome();
			}
		},
		[this](std::wstring message) { HandleWebMessage(std::move(message)); });
}

void App::PickProject() {
	Microsoft::WRL::ComPtr<IFileOpenDialog> dialog;
	if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog)))) {
		MessageBoxW(window_, L"无法打开项目选择器。", L"OMP", MB_OK | MB_ICONERROR);
		return;
	}
	FILEOPENDIALOGOPTIONS options{};
	if (SUCCEEDED(dialog->GetOptions(&options))) {
		dialog->SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
	}
	dialog->SetTitle(L"选择 OMP 项目目录");
	if (dialog->Show(window_) != S_OK) {
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

std::vector<std::wstring> App::PickAttachments() const {
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
	dialog->SetTitle(L"选择要引用的本机文件");
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
		MessageBoxW(window_, L"所选路径不是可访问的项目目录。", L"无法打开项目", MB_OK | MB_ICONERROR);
		return;
	}
	if (core_.running() && ComparableProjectPath(canonical) == ComparableProjectPath(project_directory_)) {
		return;
	}

	webview_.ShowStatus(L"正在启动 OMP Core", canonical, false);
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
		ShowCoreFailure(L"无法启动 OMP Core", start_error);
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
	case CoreEventKind::StartupFailed:
		ShowCoreFailure(L"OMP Core 启动失败", event->detail);
		break;
	case CoreEventKind::Exited: {
		std::wstring summary = L"OMP Core 已意外退出（code ";
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
			native_transcript_bounds_ = {static_cast<LONG>(left),
				static_cast<LONG>(top),
				static_cast<LONG>(right),
				static_cast<LONG>(bottom)};
			has_native_transcript_bounds_ = right > left && bottom > top;
			if (has_native_transcript_bounds_) {
				native_transcript_.SetBounds(native_transcript_bounds_);
			}
			native_transcript_.SetVisible(has_native_transcript_bounds_ && native_transcript_preferred_);
			reply(true, Json{{"enabled", native_transcript_preferred_}});
			return;
		}
		if (command == "native_transcript_hide") {
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
			for (const auto& path : PickAttachments()) {
				paths.push_back(WideToUtf8(path));
			}
			reply(true, std::move(paths));
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
		MessageBoxW(window_, wide_detail.c_str(), std::wstring(summary).c_str(), MB_OK | MB_ICONERROR);
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
	title.append(L" — OMP");
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
