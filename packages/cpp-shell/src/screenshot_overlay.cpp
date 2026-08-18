#include "omp_shell/screenshot_overlay.h"

#include "omp_shell/screenshot_geometry.h"

#include <commctrl.h>
#include <dwmapi.h>
#include <windowsx.h>
#include <wincodec.h>
#include <wrl/client.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace omp::shell {
namespace {

using Microsoft::WRL::ComPtr;

constexpr wchar_t kScreenshotWindowClass[] = L"OmpScreenshotOverlayWindow";
constexpr UINT kCommitTextMessage = WM_APP + 77;
constexpr LONG kMinimumSelection = 8;
constexpr int kResizeHandleHitRadius = 16;
constexpr std::size_t kMaximumCapturePixels = 64'000'000;
constexpr std::size_t kMaximumAnnotations = 512;
constexpr std::size_t kMaximumAnnotationPoints = 32'768;

enum class AnnotationTool {
	None,
	Rectangle,
	Ellipse,
	Arrow,
	Pen,
	Mosaic,
	Text,
};

enum class Interaction {
	Idle,
	Selecting,
	Moving,
	Resizing,
	Drawing,
};

enum class ToolbarAction {
	Rectangle,
	Ellipse,
	Arrow,
	Pen,
	Mosaic,
	Text,
	Red,
	Yellow,
	Blue,
	Undo,
	Cancel,
	Done,
};

struct Annotation {
	AnnotationTool tool = AnnotationTool::None;
	std::vector<POINT> points;
	std::wstring text;
	COLORREF color = RGB(239, 63, 53);
	int width = 3;
};

struct ToolbarButton {
	ToolbarAction action;
	const wchar_t* label;
};

constexpr std::array<ToolbarButton, 12> kToolbarButtons{{
	{ToolbarAction::Rectangle, L"矩形"},
	{ToolbarAction::Ellipse, L"椭圆"},
	{ToolbarAction::Arrow, L"箭头"},
	{ToolbarAction::Pen, L"画笔"},
	{ToolbarAction::Mosaic, L"马赛克"},
	{ToolbarAction::Text, L"文字"},
	{ToolbarAction::Red, L"红色"},
	{ToolbarAction::Yellow, L"黄色"},
	{ToolbarAction::Blue, L"蓝色"},
	{ToolbarAction::Undo, L"撤销"},
	{ToolbarAction::Cancel, L"取消"},
	{ToolbarAction::Done, L"完成"},
}};

[[nodiscard]] LONG Width(const RECT& rect) noexcept {
	return rect.right - rect.left;
}

[[nodiscard]] LONG Height(const RECT& rect) noexcept {
	return rect.bottom - rect.top;
}

[[nodiscard]] bool IsNonEmpty(const RECT& rect) noexcept {
	return Width(rect) > 0 && Height(rect) > 0;
}

[[nodiscard]] bool Contains(const RECT& rect, POINT point) noexcept {
	return point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom;
}

[[nodiscard]] POINT OffsetPoint(POINT point, LONG x, LONG y) noexcept {
	return POINT{point.x + x, point.y + y};
}

class ScopedSelection final {
public:
	ScopedSelection(HDC dc, HGDIOBJ object, bool delete_on_exit = false)
		: dc_(dc), object_(object), previous_(SelectObject(dc, object)), delete_on_exit_(delete_on_exit) {}
	~ScopedSelection() {
		if (previous_ != nullptr && previous_ != HGDI_ERROR) SelectObject(dc_, previous_);
		if (delete_on_exit_ && object_ != nullptr && object_ != HGDI_ERROR) DeleteObject(object_);
	}

	ScopedSelection(const ScopedSelection&) = delete;
	ScopedSelection& operator=(const ScopedSelection&) = delete;

private:
	HDC dc_ = nullptr;
	HGDIOBJ object_ = nullptr;
	HGDIOBJ previous_ = nullptr;
	bool delete_on_exit_ = false;
};

[[nodiscard]] HCURSOR ResizeCursor(ScreenshotResizeHandle handle) noexcept {
	switch (handle) {
	case ScreenshotResizeHandle::Left:
	case ScreenshotResizeHandle::Right:
		return LoadCursorW(nullptr, IDC_SIZEWE);
	case ScreenshotResizeHandle::Top:
	case ScreenshotResizeHandle::Bottom:
		return LoadCursorW(nullptr, IDC_SIZENS);
	case ScreenshotResizeHandle::TopLeft:
	case ScreenshotResizeHandle::BottomRight:
		return LoadCursorW(nullptr, IDC_SIZENWSE);
	case ScreenshotResizeHandle::TopRight:
	case ScreenshotResizeHandle::BottomLeft:
		return LoadCursorW(nullptr, IDC_SIZENESW);
	case ScreenshotResizeHandle::Move:
		return LoadCursorW(nullptr, IDC_SIZEALL);
	default:
		return LoadCursorW(nullptr, IDC_CROSS);
	}
}

[[nodiscard]] AnnotationTool ToolForAction(ToolbarAction action) noexcept {
	switch (action) {
	case ToolbarAction::Rectangle:
		return AnnotationTool::Rectangle;
	case ToolbarAction::Ellipse:
		return AnnotationTool::Ellipse;
	case ToolbarAction::Arrow:
		return AnnotationTool::Arrow;
	case ToolbarAction::Pen:
		return AnnotationTool::Pen;
	case ToolbarAction::Mosaic:
		return AnnotationTool::Mosaic;
	case ToolbarAction::Text:
		return AnnotationTool::Text;
	default:
		return AnnotationTool::None;
	}
}

[[nodiscard]] COLORREF ColorForAction(ToolbarAction action) noexcept {
	switch (action) {
	case ToolbarAction::Yellow:
		return RGB(255, 190, 31);
	case ToolbarAction::Blue:
		return RGB(46, 139, 255);
	default:
		return RGB(239, 63, 53);
	}
}

[[nodiscard]] bool IsColorAction(ToolbarAction action) noexcept {
	return action == ToolbarAction::Red || action == ToolbarAction::Yellow || action == ToolbarAction::Blue;
}

[[nodiscard]] bool IsToolAction(ToolbarAction action) noexcept {
	return ToolForAction(action) != AnnotationTool::None;
}

struct WindowAtPointContext {
	POINT point{};
	HWND overlay = nullptr;
	HWND owner = nullptr;
	RECT bounds{};
	bool found = false;
};

BOOL CALLBACK FindWindowAtPoint(HWND window, LPARAM parameter) {
	auto* context = reinterpret_cast<WindowAtPointContext*>(parameter);
	if (window == context->overlay || window == context->owner || !IsWindowVisible(window) || IsIconic(window)) return TRUE;
	const LONG_PTR style = GetWindowLongPtrW(window, GWL_EXSTYLE);
	if ((style & WS_EX_TRANSPARENT) != 0) return TRUE;
	DWORD cloaked = 0;
	if (SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked != 0) return TRUE;
	RECT bounds{};
	if (FAILED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &bounds, sizeof(bounds)))) {
		if (!GetWindowRect(window, &bounds)) return TRUE;
	}
	if (Width(bounds) < 8 || Height(bounds) < 8 || !Contains(bounds, context->point)) return TRUE;
	context->bounds = bounds;
	context->found = true;
	return FALSE;
}

class OverlaySession final {
public:
	OverlaySession(HINSTANCE instance, HWND owner) : instance_(instance), owner_(owner) {}

	~OverlaySession() {
		DestroyTextEditor(false);
		if (window_ != nullptr) DestroyWindow(window_);
		if (capture_dc_ != nullptr) {
			if (capture_previous_ != nullptr && capture_previous_ != HGDI_ERROR)
				SelectObject(capture_dc_, capture_previous_);
			DeleteDC(capture_dc_);
		}
		if (capture_bitmap_ != nullptr) DeleteObject(capture_bitmap_);
		if (dim_dc_ != nullptr) {
			if (dim_previous_ != nullptr && dim_previous_ != HGDI_ERROR) SelectObject(dim_dc_, dim_previous_);
			DeleteDC(dim_dc_);
		}
		if (dim_bitmap_ != nullptr) DeleteObject(dim_bitmap_);
		if (ui_font_ != nullptr) DeleteObject(ui_font_);
		if (text_font_ != nullptr) DeleteObject(text_font_);
		RestoreOwner();
	}

	OverlaySession(const OverlaySession&) = delete;
	OverlaySession& operator=(const OverlaySession&) = delete;

	[[nodiscard]] ScreenshotCaptureResult Run() {
		HideOwner();
		if (!CaptureDesktop() || !CreateOverlayWindow()) {
			if (result_.error.empty()) result_.error = L"无法创建截图层";
			return std::move(result_);
		}
		running_ = true;
		ShowWindow(window_, SW_SHOW);
		SetWindowPos(window_, HWND_TOPMOST, virtual_bounds_.left, virtual_bounds_.top, Width(virtual_bounds_),
			Height(virtual_bounds_), SWP_SHOWWINDOW);
		SetForegroundWindow(window_);
		SetFocus(window_);
		// The overlay already covers the complete virtual desktop. Capturing the
		// mouse before a button is pressed can make the first drag arrive as a
		// click after focus transfers from WebView2 (notably over RDP or mixed
		// DPI displays), which leaves the auto-detected window as a fixed region.
		// Capture only from OnLeftDown while a real interaction is active.
		POINT cursor{};
		if (GetCursorPos(&cursor)) {
			last_mouse_ = POINT{cursor.x - virtual_bounds_.left, cursor.y - virtual_bounds_.top};
			UpdateHoverWindow(last_mouse_);
		}

		MSG message{};
		while (running_) {
			const BOOL status = GetMessageW(&message, nullptr, 0, 0);
			if (status <= 0) {
				if (status == 0) PostQuitMessage(static_cast<int>(message.wParam));
				else if (result_.error.empty()) result_.error = L"Windows 消息循环异常中止";
				break;
			}
			TranslateMessage(&message);
			DispatchMessageW(&message);
		}
		RestoreOwner();
		return std::move(result_);
	}

private:
	static LRESULT CALLBACK WindowProcedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
		OverlaySession* self = reinterpret_cast<OverlaySession*>(GetWindowLongPtrW(window, GWLP_USERDATA));
		if (message == WM_NCCREATE) {
			const auto* create = reinterpret_cast<const CREATESTRUCTW*>(lparam);
			self = static_cast<OverlaySession*>(create->lpCreateParams);
			SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
			self->window_ = window;
		}
		return self != nullptr ? self->HandleMessage(message, wparam, lparam)
							   : DefWindowProcW(window, message, wparam, lparam);
	}

	static LRESULT CALLBACK EditProcedure(
		HWND editor,
		UINT message,
		WPARAM wparam,
		LPARAM lparam,
		UINT_PTR,
		DWORD_PTR context) {
		auto* self = reinterpret_cast<OverlaySession*>(context);
		if (message == WM_KEYDOWN && wparam == VK_RETURN) {
			PostMessageW(self->window_, kCommitTextMessage, TRUE, 0);
			return 0;
		}
		if (message == WM_KEYDOWN && wparam == VK_ESCAPE) {
			PostMessageW(self->window_, kCommitTextMessage, FALSE, 0);
			return 0;
		}
		if (message == WM_KILLFOCUS) PostMessageW(self->window_, kCommitTextMessage, TRUE, 0);
		if (message == WM_NCDESTROY && self->edit_ == editor) self->edit_ = nullptr;
		return DefSubclassProc(editor, message, wparam, lparam);
	}

	void HideOwner() {
		if (owner_ == nullptr || !IsWindow(owner_)) return;
		owner_was_visible_ = IsWindowVisible(owner_) != FALSE;
		owner_placement_.length = sizeof(owner_placement_);
		owner_placement_valid_ = GetWindowPlacement(owner_, &owner_placement_) != FALSE;
		if (owner_was_visible_) {
			ShowWindow(owner_, SW_HIDE);
			DwmFlush();
		}
	}

	void RestoreOwner() {
		if (owner_restored_ || !owner_was_visible_ || owner_ == nullptr || !IsWindow(owner_)) return;
		owner_restored_ = true;
		if (owner_placement_valid_) SetWindowPlacement(owner_, &owner_placement_);
		ShowWindow(owner_, owner_placement_valid_ && owner_placement_.showCmd == SW_SHOWMAXIMIZED ? SW_SHOWMAXIMIZED : SW_SHOW);
		SetForegroundWindow(owner_);
	}

	[[nodiscard]] bool CaptureDesktop() {
		virtual_bounds_ = RECT{
			GetSystemMetrics(SM_XVIRTUALSCREEN),
			GetSystemMetrics(SM_YVIRTUALSCREEN),
			GetSystemMetrics(SM_XVIRTUALSCREEN) + GetSystemMetrics(SM_CXVIRTUALSCREEN),
			GetSystemMetrics(SM_YVIRTUALSCREEN) + GetSystemMetrics(SM_CYVIRTUALSCREEN),
		};
		const LONG width = Width(virtual_bounds_);
		const LONG height = Height(virtual_bounds_);
		if (width <= 0 || height <= 0 || static_cast<std::size_t>(width) > kMaximumCapturePixels /
				static_cast<std::size_t>(height)) {
			result_.error = L"当前多显示器分辨率超出截图限制";
			return false;
		}
		client_bounds_ = RECT{0, 0, width, height};
		HDC screen = GetDC(nullptr);
		if (screen == nullptr) {
			result_.error = L"无法读取屏幕";
			return false;
		}
		capture_dc_ = CreateCompatibleDC(screen);
		BITMAPINFO info{};
		info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
		info.bmiHeader.biWidth = width;
		info.bmiHeader.biHeight = -height;
		info.bmiHeader.biPlanes = 1;
		info.bmiHeader.biBitCount = 32;
		info.bmiHeader.biCompression = BI_RGB;
		capture_bitmap_ = CreateDIBSection(screen, &info, DIB_RGB_COLORS, reinterpret_cast<void**>(&capture_bits_), nullptr, 0);
		bool captured = false;
		if (capture_dc_ != nullptr && capture_bitmap_ != nullptr && capture_bits_ != nullptr) {
			capture_previous_ = SelectObject(capture_dc_, capture_bitmap_);
			captured = BitBlt(capture_dc_, 0, 0, width, height, screen, virtual_bounds_.left, virtual_bounds_.top,
				SRCCOPY | CAPTUREBLT) != FALSE;
		}
		ReleaseDC(nullptr, screen);
		if (!captured) {
			result_.error = L"Windows 拒绝了屏幕捕获";
			return false;
		}
		capture_stride_ = width * 4;
		const std::size_t byte_count = static_cast<std::size_t>(capture_stride_) * static_cast<std::size_t>(height);
		for (std::size_t offset = 3; offset < byte_count; offset += 4) capture_bits_[offset] = 255;
		return CreateDimSurface();
	}

	[[nodiscard]] bool CreateDimSurface() {
		HDC screen = GetDC(nullptr);
		if (screen == nullptr) return false;
		dim_dc_ = CreateCompatibleDC(screen);
		BITMAPINFO info{};
		info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
		info.bmiHeader.biWidth = Width(client_bounds_);
		info.bmiHeader.biHeight = -Height(client_bounds_);
		info.bmiHeader.biPlanes = 1;
		info.bmiHeader.biBitCount = 32;
		info.bmiHeader.biCompression = BI_RGB;
		std::uint8_t* bits = nullptr;
		dim_bitmap_ = CreateDIBSection(screen, &info, DIB_RGB_COLORS, reinterpret_cast<void**>(&bits), nullptr, 0);
		ReleaseDC(nullptr, screen);
		if (dim_dc_ == nullptr || dim_bitmap_ == nullptr || bits == nullptr) return false;
		dim_previous_ = SelectObject(dim_dc_, dim_bitmap_);
		if (dim_previous_ == nullptr || dim_previous_ == HGDI_ERROR) return false;
		const std::size_t byte_count = static_cast<std::size_t>(capture_stride_) *
			static_cast<std::size_t>(Height(client_bounds_));
		std::memcpy(bits, capture_bits_, byte_count);
		for (std::size_t offset = 0; offset + 3 < byte_count; offset += 4) {
			bits[offset] = static_cast<std::uint8_t>((static_cast<unsigned int>(bits[offset]) * 143U) / 255U);
			bits[offset + 1] = static_cast<std::uint8_t>((static_cast<unsigned int>(bits[offset + 1]) * 143U) / 255U);
			bits[offset + 2] = static_cast<std::uint8_t>((static_cast<unsigned int>(bits[offset + 2]) * 143U) / 255U);
			bits[offset + 3] = 255;
		}
		return true;
	}

	[[nodiscard]] bool CreateOverlayWindow() {
		WNDCLASSEXW window_class{};
		window_class.cbSize = sizeof(window_class);
		window_class.lpfnWndProc = WindowProcedure;
		window_class.hInstance = instance_;
		window_class.hCursor = LoadCursorW(nullptr, IDC_CROSS);
		window_class.lpszClassName = kScreenshotWindowClass;
		window_class.style = CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS;
		if (RegisterClassExW(&window_class) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return false;
		window_ = CreateWindowExW(
			WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
			kScreenshotWindowClass,
			L"Grimoire Screenshot",
			WS_POPUP,
			virtual_bounds_.left,
			virtual_bounds_.top,
			Width(virtual_bounds_),
			Height(virtual_bounds_),
			nullptr,
			nullptr,
			instance_,
			this);
		if (window_ == nullptr) return false;
		const BOOL transitions_disabled = TRUE;
		DwmSetWindowAttribute(window_, DWMWA_TRANSITIONS_FORCEDISABLED, &transitions_disabled, sizeof(transitions_disabled));
		const UINT dpi = GetDpiForWindow(window_);
		ui_font_ = CreateFontW(-MulDiv(15, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI), 0, 0, 0, FW_MEDIUM,
			FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
			DEFAULT_PITCH | FF_DONTCARE, L"Microsoft YaHei UI");
		text_font_ = CreateFontW(-MulDiv(18, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI), 0, 0, 0, FW_MEDIUM,
			FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
			DEFAULT_PITCH | FF_DONTCARE, L"Microsoft YaHei UI");
		return true;
	}

	LRESULT HandleMessage(UINT message, WPARAM wparam, LPARAM lparam) {
		switch (message) {
		case WM_ERASEBKGND:
			return 1;
		case WM_PAINT:
			Paint();
			return 0;
		case WM_MOUSEMOVE:
			OnMouseMove(POINT{GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)}, wparam);
			return 0;
		case WM_LBUTTONDOWN:
			OnLeftDown(POINT{GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)});
			return 0;
		case WM_LBUTTONUP:
			OnLeftUp(POINT{GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)});
			return 0;
		case WM_LBUTTONDBLCLK:
			if (has_selection_ && Contains(selection_, POINT{GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)})) {
				last_mouse_ = POINT{GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
				complete_on_left_up_ = true;
				SetCapture(window_);
			}
			return 0;
		case WM_RBUTTONDOWN:
			SetCapture(window_);
			return 0;
		case WM_RBUTTONUP:
			if (GetCapture() == window_) ReleaseCapture();
			Cancel();
			return 0;
		case WM_KEYDOWN:
			OnKeyDown(wparam);
			return 0;
		case WM_DISPLAYCHANGE:
			result_ = ScreenshotCaptureResult{};
			result_.error = L"显示器配置已变化，请重新截图";
			DestroyTextEditor(false);
			if (GetCapture() == window_) ReleaseCapture();
			if (window_ != nullptr) DestroyWindow(window_);
			return 0;
		case WM_CLOSE:
			Cancel();
			return 0;
		case WM_QUERYENDSESSION:
			return TRUE;
		case WM_ENDSESSION:
			if (wparam != FALSE) Cancel();
			return 0;
		case WM_SETCURSOR:
			UpdateCursor(last_mouse_);
			return TRUE;
		case kCommitTextMessage:
			DestroyTextEditor(wparam != FALSE);
			return 0;
		case WM_CAPTURECHANGED:
			if (interaction_ != Interaction::Idle && edit_ == nullptr) FinishInteraction(last_mouse_);
			return 0;
		case WM_NCDESTROY: {
			const HWND destroyed_window = window_;
			SetWindowLongPtrW(destroyed_window, GWLP_USERDATA, 0);
			window_ = nullptr;
			running_ = false;
			return DefWindowProcW(destroyed_window, message, wparam, lparam);
		}
		default:
			return DefWindowProcW(window_, message, wparam, lparam);
		}
	}

	void Paint() {
		PAINTSTRUCT paint{};
		HDC dc = BeginPaint(window_, &paint);
		if (dc == nullptr) return;
		const RECT dirty = paint.rcPaint;
		BitBlt(dc, dirty.left, dirty.top, Width(dirty), Height(dirty), dim_dc_, dirty.left, dirty.top, SRCCOPY);

		const RECT visible = has_selection_ || interaction_ == Interaction::Selecting ? selection_ : hover_window_;
		RECT visible_dirty{};
		if (IsNonEmpty(visible) && IntersectRect(&visible_dirty, &visible, &dirty)) {
			BitBlt(dc,
				visible_dirty.left,
				visible_dirty.top,
				Width(visible_dirty),
				Height(visible_dirty),
				capture_dc_,
				visible_dirty.left,
				visible_dirty.top,
				SRCCOPY);
		}
		if (has_selection_) DrawAnnotations(dc);
		if (IsNonEmpty(visible)) DrawSelection(dc, visible, has_selection_);
		if (has_selection_ && interaction_ != Interaction::Selecting) DrawToolbar(dc);
		if (!has_selection_ && !IsNonEmpty(selection_)) DrawInstructions(dc);
		EndPaint(window_, &paint);
	}

	[[nodiscard]] RECT ClampVisualBounds(RECT bounds) const {
		RECT clipped{};
		return IntersectRect(&clipped, &bounds, &client_bounds_) ? clipped : RECT{};
	}

	[[nodiscard]] RECT UnionVisualBounds(RECT first, RECT second) const {
		if (!IsNonEmpty(first)) return ClampVisualBounds(second);
		if (!IsNonEmpty(second)) return ClampVisualBounds(first);
		RECT joined{};
		UnionRect(&joined, &first, &second);
		return ClampVisualBounds(joined);
	}

	[[nodiscard]] RECT ToolbarVisualBounds() const {
		if (!has_selection_) return RECT{};
		RECT bounds = ToolbarBounds();
		InflateRect(&bounds, Scale(28), Scale(38));
		return ClampVisualBounds(bounds);
	}

	[[nodiscard]] RECT SelectionVisualBounds(RECT selection, bool include_toolbar) const {
		if (!IsNonEmpty(selection)) return RECT{};
		RECT bounds = selection;
		InflateRect(&bounds, Scale(7), Scale(7));
		RECT label{selection.left, selection.top - Scale(30), selection.left + Scale(120), selection.top - Scale(5)};
		if (label.top < client_bounds_.top) {
			label.top = selection.top + Scale(6);
			label.bottom = label.top + Scale(25);
		}
		bounds = UnionVisualBounds(bounds, label);
		if (include_toolbar) bounds = UnionVisualBounds(bounds, ToolbarVisualBounds());
		return bounds;
	}

	[[nodiscard]] RECT AnnotationVisualBounds(const Annotation& annotation) const {
		if (annotation.points.empty()) return RECT{};
		LONG left = annotation.points.front().x;
		LONG top = annotation.points.front().y;
		LONG right = left + 1;
		LONG bottom = top + 1;
		for (const POINT point : annotation.points) {
			left = std::min(left, point.x);
			top = std::min(top, point.y);
			right = std::max(right, point.x + 1);
			bottom = std::max(bottom, point.y + 1);
		}
		if (annotation.tool == AnnotationTool::Text) {
			right = std::min(selection_.right, left + Scale(520));
			bottom = std::min(selection_.bottom, top + Scale(40));
		}
		RECT bounds{left, top, right, bottom};
		const LONG padding = annotation.tool == AnnotationTool::Mosaic
			? std::max<LONG>(Scale(18), annotation.width * 6)
			: std::max<LONG>(Scale(16), annotation.width * 6);
		InflateRect(&bounds, padding, padding);
		return ClampVisualBounds(bounds);
	}

	void InvalidateVisualTransition(RECT before, RECT after) const {
		RECT dirty = UnionVisualBounds(before, after);
		if (IsNonEmpty(dirty)) InvalidateRect(window_, &dirty, FALSE);
	}

	void DrawSelection(HDC dc, RECT bounds, bool handles) {
		HPEN border = CreatePen(PS_SOLID, Scale(2), RGB(38, 132, 255));
		ScopedSelection select_pen(dc, border, true);
		ScopedSelection select_brush(dc, GetStockObject(HOLLOW_BRUSH));
		Rectangle(dc, bounds.left, bounds.top, bounds.right, bounds.bottom);

		if (handles) {
			const LONG radius = Scale(7);
			const LONG center_x = bounds.left + Width(bounds) / 2;
			const LONG center_y = bounds.top + Height(bounds) / 2;
			const std::array<POINT, 8> points{{
				{bounds.left, bounds.top},
				{center_x, bounds.top},
				{bounds.right, bounds.top},
				{bounds.right, center_y},
				{bounds.right, bounds.bottom},
				{center_x, bounds.bottom},
				{bounds.left, bounds.bottom},
				{bounds.left, center_y},
			}};
			HBRUSH fill = CreateSolidBrush(RGB(255, 255, 255));
			HPEN outline = CreatePen(PS_SOLID, 1, RGB(38, 132, 255));
			ScopedSelection handle_brush(dc, fill, true);
			ScopedSelection handle_pen(dc, outline, true);
			for (const POINT point : points)
				Ellipse(dc, point.x - radius, point.y - radius, point.x + radius + 1, point.y + radius + 1);
		}

		std::wstring dimensions = std::to_wstring(Width(bounds));
		dimensions.append(L" × ");
		dimensions.append(std::to_wstring(Height(bounds)));
		RECT label{bounds.left, bounds.top - Scale(30), bounds.left + Scale(120), bounds.top - Scale(5)};
		if (label.top < client_bounds_.top) {
			label.top = bounds.top + Scale(6);
			label.bottom = label.top + Scale(25);
		}
		HBRUSH background = CreateSolidBrush(RGB(34, 34, 36));
		ScopedSelection label_brush(dc, background, true);
		ScopedSelection label_pen(dc, GetStockObject(NULL_PEN));
		RoundRect(dc, label.left, label.top, label.right, label.bottom, Scale(8), Scale(8));
		SetBkMode(dc, TRANSPARENT);
		SetTextColor(dc, RGB(255, 255, 255));
		ScopedSelection label_font(dc, ui_font_);
		DrawTextW(dc, dimensions.c_str(), static_cast<int>(dimensions.size()), &label, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
	}

	void DrawInstructions(HDC dc) {
		const std::wstring text = L"拖动鼠标选择截图区域 · 单击可自动选取窗口 · Esc 取消";
		RECT bounds{client_bounds_.left, client_bounds_.top + Scale(28), client_bounds_.right,
			client_bounds_.top + Scale(70)};
		SetBkMode(dc, TRANSPARENT);
		SetTextColor(dc, RGB(255, 255, 255));
		ScopedSelection font(dc, ui_font_);
		DrawTextW(dc, text.c_str(), static_cast<int>(text.size()), &bounds, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
	}

	[[nodiscard]] RECT ToolbarBounds() const {
		const SIZE size{Scale(12 + static_cast<int>(kToolbarButtons.size()) * 34), Scale(46)};
		return PlaceScreenshotToolbar(selection_, client_bounds_, size, Scale(8));
	}

	[[nodiscard]] RECT ToolbarButtonBounds(std::size_t index) const {
		const RECT toolbar = ToolbarBounds();
		const LONG size = Scale(34);
		const LONG left = toolbar.left + Scale(6) + static_cast<LONG>(index) * size;
		return RECT{left, toolbar.top + Scale(6), left + size, toolbar.bottom - Scale(6)};
	}

	void DrawToolbar(HDC dc) {
		const RECT toolbar = ToolbarBounds();
		HBRUSH background = CreateSolidBrush(RGB(37, 37, 40));
		ScopedSelection toolbar_brush(dc, background, true);
		ScopedSelection toolbar_pen(dc, GetStockObject(NULL_PEN));
		RoundRect(dc, toolbar.left, toolbar.top, toolbar.right, toolbar.bottom, Scale(10), Scale(10));
		SetBkMode(dc, TRANSPARENT);
		ScopedSelection font(dc, ui_font_);

		for (std::size_t index = 0; index < kToolbarButtons.size(); ++index) {
			const ToolbarButton button = kToolbarButtons[index];
			const RECT bounds = ToolbarButtonBounds(index);
			const bool active = (IsToolAction(button.action) && ToolForAction(button.action) == tool_) ||
				(IsColorAction(button.action) && ColorForAction(button.action) == color_);
			if (active || index == hovered_button_) {
				HBRUSH hover = CreateSolidBrush(active ? RGB(53, 111, 190) : RGB(60, 60, 64));
				ScopedSelection hover_brush(dc, hover, true);
				RoundRect(dc, bounds.left, bounds.top, bounds.right, bounds.bottom, Scale(7), Scale(7));
			}
			if (IsColorAction(button.action)) {
				const COLORREF color = ColorForAction(button.action);
				HBRUSH swatch = CreateSolidBrush(color);
				ScopedSelection swatch_brush(dc, swatch, true);
				Ellipse(dc, bounds.left + Scale(9), bounds.top + Scale(7), bounds.right - Scale(9), bounds.bottom - Scale(7));
				continue;
			}
			DrawToolbarIcon(dc,
				button.action,
				bounds,
				button.action == ToolbarAction::Done ? RGB(74, 210, 126) : RGB(242, 242, 244));
		}
		DrawToolbarTooltip(dc, toolbar);
	}

	void DrawToolbarIcon(HDC dc, ToolbarAction action, RECT bounds, COLORREF color) {
		const LONG pad = Scale(9);
		RECT icon{bounds.left + pad, bounds.top + pad, bounds.right - pad, bounds.bottom - pad};
		HPEN pen = CreatePen(PS_SOLID, Scale(2), color);
		ScopedSelection selected_pen(dc, pen, true);
		ScopedSelection hollow(dc, GetStockObject(HOLLOW_BRUSH));
		if (action == ToolbarAction::Rectangle) {
			Rectangle(dc, icon.left, icon.top, icon.right, icon.bottom);
		} else if (action == ToolbarAction::Ellipse) {
			Ellipse(dc, icon.left, icon.top, icon.right, icon.bottom);
		} else if (action == ToolbarAction::Arrow) {
			MoveToEx(dc, icon.left, icon.bottom, nullptr);
			LineTo(dc, icon.right, icon.top);
			MoveToEx(dc, icon.right, icon.top, nullptr);
			LineTo(dc, icon.right - Scale(7), icon.top + Scale(1));
			MoveToEx(dc, icon.right, icon.top, nullptr);
			LineTo(dc, icon.right - Scale(1), icon.top + Scale(7));
		} else if (action == ToolbarAction::Pen) {
			const std::array<POINT, 4> points{{
				{icon.left, icon.bottom - Scale(2)},
				{icon.left + Scale(5), icon.top + Scale(5)},
				{icon.left + Scale(10), icon.bottom - Scale(6)},
				{icon.right, icon.top + Scale(1)},
			}};
			Polyline(dc, points.data(), static_cast<int>(points.size()));
		} else if (action == ToolbarAction::Mosaic) {
			HBRUSH brush = CreateSolidBrush(color);
			ScopedSelection selected_brush(dc, brush, true);
			const LONG cell = Scale(4);
			for (LONG row = 0; row < 3; ++row)
				for (LONG column = 0; column < 3; ++column) {
					const LONG left = icon.left + column * (cell + Scale(2));
					const LONG top = icon.top + row * (cell + Scale(2));
					Rectangle(dc, left, top, left + cell, top + cell);
				}
		} else if (action == ToolbarAction::Text) {
			SetTextColor(dc, color);
			RECT text_bounds = bounds;
			DrawTextW(dc, L"T", 1, &text_bounds, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
		} else if (action == ToolbarAction::Undo) {
			Arc(dc, icon.left, icon.top, icon.right, icon.bottom, icon.left, icon.bottom, icon.left, icon.top);
			MoveToEx(dc, icon.left, icon.top, nullptr);
			LineTo(dc, icon.left + Scale(7), icon.top);
			MoveToEx(dc, icon.left, icon.top, nullptr);
			LineTo(dc, icon.left, icon.top + Scale(7));
		} else if (action == ToolbarAction::Cancel) {
			MoveToEx(dc, icon.left, icon.top, nullptr);
			LineTo(dc, icon.right, icon.bottom);
			MoveToEx(dc, icon.right, icon.top, nullptr);
			LineTo(dc, icon.left, icon.bottom);
		} else if (action == ToolbarAction::Done) {
			MoveToEx(dc, icon.left, icon.top + Height(icon) / 2, nullptr);
			LineTo(dc, icon.left + Width(icon) / 3, icon.bottom);
			LineTo(dc, icon.right, icon.top);
		}
	}

	void DrawToolbarTooltip(HDC dc, RECT toolbar) {
		if (hovered_button_ >= kToolbarButtons.size()) return;
		const wchar_t* label = kToolbarButtons[hovered_button_].label;
		SIZE text_size{};
		if (!GetTextExtentPoint32W(dc, label, lstrlenW(label), &text_size)) return;
		const RECT button = ToolbarButtonBounds(hovered_button_);
		const LONG width = text_size.cx + Scale(16);
		const LONG height = Scale(26);
		LONG left = button.left + (Width(button) - width) / 2;
		left = std::clamp(left, client_bounds_.left, client_bounds_.right - width);
		LONG top = toolbar.top - height - Scale(6);
		if (top < client_bounds_.top) top = toolbar.bottom + Scale(6);
		RECT tooltip{left, top, left + width, top + height};
		HBRUSH background = CreateSolidBrush(RGB(22, 22, 24));
		ScopedSelection selected_brush(dc, background, true);
		RoundRect(dc, tooltip.left, tooltip.top, tooltip.right, tooltip.bottom, Scale(7), Scale(7));
		SetTextColor(dc, RGB(245, 245, 247));
		DrawTextW(dc, label, -1, &tooltip, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
	}

	void DrawAnnotations(HDC dc) {
		const int saved = SaveDC(dc);
		IntersectClipRect(dc, selection_.left, selection_.top, selection_.right, selection_.bottom);
		for (const Annotation& annotation : annotations_) DrawAnnotation(dc, annotation);
		if (active_annotation_) DrawAnnotation(dc, *active_annotation_);
		RestoreDC(dc, saved);
	}

	void DrawAnnotation(HDC dc, const Annotation& annotation) {
		if (annotation.points.empty()) return;
		if (annotation.tool == AnnotationTool::Mosaic) {
			for (const POINT point : annotation.points) DrawMosaicStamp(dc, point, annotation.width);
			return;
		}
		if (annotation.tool == AnnotationTool::Text) {
			if (annotation.text.empty()) return;
			SetBkMode(dc, TRANSPARENT);
			SetTextColor(dc, annotation.color);
			ScopedSelection font(dc, text_font_);
			TextOutW(dc, annotation.points[0].x, annotation.points[0].y, annotation.text.c_str(),
				static_cast<int>(annotation.text.size()));
			return;
		}
		HPEN pen = CreatePen(PS_SOLID, annotation.width, annotation.color);
		ScopedSelection selected_pen(dc, pen, true);
		ScopedSelection hollow(dc, GetStockObject(HOLLOW_BRUSH));
		if ((annotation.tool == AnnotationTool::Pen) && annotation.points.size() >= 2) {
			Polyline(dc, annotation.points.data(), static_cast<int>(annotation.points.size()));
		} else if (annotation.points.size() >= 2) {
			const POINT first = annotation.points.front();
			const POINT last = annotation.points.back();
			const RECT bounds = NormalizeScreenshotRect(first, last);
			if (annotation.tool == AnnotationTool::Rectangle)
				Rectangle(dc, bounds.left, bounds.top, bounds.right, bounds.bottom);
			else if (annotation.tool == AnnotationTool::Ellipse)
				Ellipse(dc, bounds.left, bounds.top, bounds.right, bounds.bottom);
			else if (annotation.tool == AnnotationTool::Arrow)
				DrawArrow(dc, first, last, annotation.color, annotation.width);
		}
	}

	void DrawArrow(HDC dc, POINT start, POINT end, COLORREF color, int width) {
		MoveToEx(dc, start.x, start.y, nullptr);
		LineTo(dc, end.x, end.y);
		const double angle = std::atan2(static_cast<double>(end.y - start.y), static_cast<double>(end.x - start.x));
		const double head = static_cast<double>(std::max(width * 5, Scale(14)));
		const POINT wing_a{
			end.x - static_cast<LONG>(std::lround(head * std::cos(angle - 0.55))),
			end.y - static_cast<LONG>(std::lround(head * std::sin(angle - 0.55))),
		};
		const POINT wing_b{
			end.x - static_cast<LONG>(std::lround(head * std::cos(angle + 0.55))),
			end.y - static_cast<LONG>(std::lround(head * std::sin(angle + 0.55))),
		};
		const std::array<POINT, 3> head_points{{end, wing_a, wing_b}};
		HBRUSH brush = CreateSolidBrush(color);
		ScopedSelection selected_brush(dc, brush, true);
		Polygon(dc, head_points.data(), static_cast<int>(head_points.size()));
	}

	void DrawMosaicStamp(HDC dc, POINT center, int width) {
		const LONG radius = std::max<LONG>(Scale(12), width * 5);
		const LONG block = std::max<LONG>(Scale(5), width * 2);
		for (LONG y = center.y - radius; y < center.y + radius; y += block) {
			for (LONG x = center.x - radius; x < center.x + radius; x += block) {
				const LONG source_x = std::clamp(x + block / 2, selection_.left, selection_.right - 1);
				const LONG source_y = std::clamp(y + block / 2, selection_.top, selection_.bottom - 1);
				StretchBlt(dc, x, y, block + 1, block + 1, capture_dc_, source_x, source_y, 1, 1, SRCCOPY);
			}
		}
	}

	void OnLeftDown(POINT point) {
		last_mouse_ = point;
		if (edit_ != nullptr) DestroyTextEditor(true);
		SetFocus(window_);
		if (has_selection_) {
			if (const auto button = HitToolbar(point)) {
				pressed_button_ = *button;
				hovered_button_ = *button;
				SetCapture(window_);
				InvalidateRect(window_, nullptr, FALSE);
				return;
			}
			const ScreenshotResizeHandle hit =
				HitTestScreenshotSelection(selection_, point, Scale(kResizeHandleHitRadius));
			if (hit == ScreenshotResizeHandle::Move && tool_ == AnnotationTool::Text) {
				BeginText(point);
				return;
			}
			if (hit == ScreenshotResizeHandle::Move && tool_ != AnnotationTool::None) {
				interaction_ = Interaction::Drawing;
				active_annotation_ = Annotation{tool_, {point}, L"", color_, Scale(3)};
			} else if (hit == ScreenshotResizeHandle::Move) {
				interaction_ = Interaction::Moving;
				selection_before_drag_ = selection_;
				drag_origin_ = point;
			} else if (hit != ScreenshotResizeHandle::None) {
				interaction_ = Interaction::Resizing;
				selection_before_drag_ = selection_;
				resize_handle_ = hit;
			} else {
				UpdateHoverWindow(point);
				StartSelection(point);
			}
		} else {
			StartSelection(point);
		}
		SetCapture(window_);
		InvalidateRect(window_, nullptr, FALSE);
	}

	void StartSelection(POINT point) {
		interaction_ = Interaction::Selecting;
		drag_origin_ = point;
		selection_ = RECT{point.x, point.y, point.x, point.y};
		selection_before_drag_ = hover_window_;
		has_selection_ = false;
		annotations_.clear();
		active_annotation_.reset();
		tool_ = AnnotationTool::None;
	}

	void OnMouseMove(POINT point, WPARAM buttons) {
		last_mouse_ = point;
		RECT before{};
		if (interaction_ == Interaction::Selecting || interaction_ == Interaction::Moving ||
			interaction_ == Interaction::Resizing) {
			before = SelectionVisualBounds(selection_, has_selection_);
		} else if (interaction_ == Interaction::Drawing && active_annotation_) {
			before = AnnotationVisualBounds(*active_annotation_);
		}
		if (interaction_ == Interaction::Selecting) {
			if (std::abs(point.x - drag_origin_.x) >= Scale(3) || std::abs(point.y - drag_origin_.y) >= Scale(3)) {
				selection_ = ClampScreenshotRect(NormalizeScreenshotRect(drag_origin_, point), client_bounds_);
			}
		} else if (interaction_ == Interaction::Moving) {
			const RECT previous = selection_;
			selection_ = MoveScreenshotRect(selection_before_drag_,
				POINT{point.x - drag_origin_.x, point.y - drag_origin_.y}, client_bounds_);
			ShiftAnnotations(selection_.left - previous.left, selection_.top - previous.top);
		} else if (interaction_ == Interaction::Resizing) {
			selection_ = ResizeScreenshotRect(selection_before_drag_, resize_handle_, point, client_bounds_, kMinimumSelection);
		} else if (interaction_ == Interaction::Drawing && active_annotation_) {
			POINT clamped{
				std::clamp(point.x, selection_.left, selection_.right - 1),
				std::clamp(point.y, selection_.top, selection_.bottom - 1),
			};
			if (active_annotation_->tool == AnnotationTool::Pen || active_annotation_->tool == AnnotationTool::Mosaic) {
				if (active_annotation_->points.size() < kMaximumAnnotationPoints) {
					const POINT previous = active_annotation_->points.back();
					const LONG minimum_distance = active_annotation_->tool == AnnotationTool::Mosaic ? Scale(2) : 1;
					if (std::abs(clamped.x - previous.x) >= minimum_distance ||
						std::abs(clamped.y - previous.y) >= minimum_distance) {
						active_annotation_->points.push_back(clamped);
					}
				}
			}
			else if (active_annotation_->points.size() == 1)
				active_annotation_->points.push_back(clamped);
			else
				active_annotation_->points.back() = clamped;
		} else {
			const auto previous_button = hovered_button_;
			const RECT previous_toolbar = ToolbarVisualBounds();
			hovered_button_ = HitToolbar(point).value_or(std::numeric_limits<std::size_t>::max());
			if (!has_selection_ && (buttons & MK_LBUTTON) == 0) UpdateHoverWindow(point);
			if (previous_button == hovered_button_ && has_selection_) {
				UpdateCursor(point);
				return;
			}
			if (previous_button != hovered_button_)
				InvalidateVisualTransition(previous_toolbar, ToolbarVisualBounds());
		}
		UpdateCursor(point);
		if (interaction_ == Interaction::Selecting || interaction_ == Interaction::Moving ||
			interaction_ == Interaction::Resizing) {
			InvalidateVisualTransition(before, SelectionVisualBounds(selection_, has_selection_));
		} else if (interaction_ == Interaction::Drawing && active_annotation_) {
			InvalidateVisualTransition(before, AnnotationVisualBounds(*active_annotation_));
		}
	}

	void OnLeftUp(POINT point) {
		last_mouse_ = point;
		if (pressed_button_) {
			const std::optional<std::size_t> released_button = HitToolbar(point);
			const std::size_t pressed = *pressed_button_;
			pressed_button_.reset();
			if (GetCapture() == window_) ReleaseCapture();
			if (released_button && *released_button == pressed) ExecuteToolbar(pressed);
			return;
		}
		if (complete_on_left_up_) {
			complete_on_left_up_ = false;
			if (GetCapture() == window_) ReleaseCapture();
			Complete();
			return;
		}
		FinishInteraction(point);
		if (GetCapture() == window_) ReleaseCapture();
		InvalidateRect(window_, nullptr, FALSE);
	}

	void FinishInteraction(POINT point) {
		if (interaction_ == Interaction::Selecting) {
			const bool click = std::abs(point.x - drag_origin_.x) < Scale(3) &&
				std::abs(point.y - drag_origin_.y) < Scale(3);
			if (click && IsNonEmpty(selection_before_drag_)) selection_ = selection_before_drag_;
			has_selection_ = Width(selection_) >= kMinimumSelection && Height(selection_) >= kMinimumSelection;
			if (!has_selection_) selection_ = RECT{};
		} else if (interaction_ == Interaction::Drawing && active_annotation_) {
			if (annotations_.size() < kMaximumAnnotations &&
				(active_annotation_->points.size() >= 2 || active_annotation_->tool == AnnotationTool::Mosaic))
				annotations_.push_back(std::move(*active_annotation_));
			active_annotation_.reset();
		}
		interaction_ = Interaction::Idle;
		resize_handle_ = ScreenshotResizeHandle::None;
	}

	void UpdateHoverWindow(POINT client_point) {
		const RECT previous_visual = SelectionVisualBounds(hover_window_, false);
		WindowAtPointContext context{
			OffsetPoint(client_point, virtual_bounds_.left, virtual_bounds_.top), window_, owner_, RECT{}, false};
		EnumWindows(FindWindowAtPoint, reinterpret_cast<LPARAM>(&context));
		RECT next{};
		if (context.found) {
			next = RECT{
				context.bounds.left - virtual_bounds_.left,
				context.bounds.top - virtual_bounds_.top,
				context.bounds.right - virtual_bounds_.left,
				context.bounds.bottom - virtual_bounds_.top,
			};
			next.left = std::clamp(next.left, client_bounds_.left, client_bounds_.right);
			next.top = std::clamp(next.top, client_bounds_.top, client_bounds_.bottom);
			next.right = std::clamp(next.right, next.left, client_bounds_.right);
			next.bottom = std::clamp(next.bottom, next.top, client_bounds_.bottom);
		}
		if (!EqualRect(&next, &hover_window_)) {
			hover_window_ = next;
			InvalidateVisualTransition(previous_visual, SelectionVisualBounds(hover_window_, false));
		}
	}

	void UpdateCursor(POINT point) {
		if (HitToolbar(point)) {
			SetCursor(LoadCursorW(nullptr, IDC_HAND));
			return;
		}
		if (has_selection_) {
			const ScreenshotResizeHandle hit =
				HitTestScreenshotSelection(selection_, point, Scale(kResizeHandleHitRadius));
			if (hit == ScreenshotResizeHandle::Move && tool_ != AnnotationTool::None) {
				SetCursor(tool_ == AnnotationTool::Text ? LoadCursorW(nullptr, IDC_IBEAM) : LoadCursorW(nullptr, IDC_CROSS));
				return;
			}
			SetCursor(ResizeCursor(hit));
			return;
		}
		SetCursor(LoadCursorW(nullptr, IDC_CROSS));
	}

	[[nodiscard]] std::optional<std::size_t> HitToolbar(POINT point) const {
		if (!has_selection_ || !Contains(ToolbarBounds(), point)) return std::nullopt;
		for (std::size_t index = 0; index < kToolbarButtons.size(); ++index) {
			if (Contains(ToolbarButtonBounds(index), point)) return index;
		}
		return std::nullopt;
	}

	void ExecuteToolbar(std::size_t index) {
		if (index >= kToolbarButtons.size()) return;
		const ToolbarAction action = kToolbarButtons[index].action;
		if (IsToolAction(action)) {
			tool_ = ToolForAction(action);
		} else if (IsColorAction(action)) {
			color_ = ColorForAction(action);
		} else if (action == ToolbarAction::Undo) {
			if (!annotations_.empty()) annotations_.pop_back();
		} else if (action == ToolbarAction::Cancel) {
			Cancel();
			return;
		} else if (action == ToolbarAction::Done) {
			Complete();
			return;
		}
		InvalidateRect(window_, nullptr, FALSE);
	}

	void OnKeyDown(WPARAM key) {
		if (key == VK_ESCAPE) {
			Cancel();
			return;
		}
		if (key == VK_RETURN) {
			Complete();
			return;
		}
		if ((GetKeyState(VK_CONTROL) & 0x8000) != 0 && key == 'Z') {
			if (!annotations_.empty()) annotations_.pop_back();
			InvalidateRect(window_, nullptr, FALSE);
			return;
		}
		if (!has_selection_) return;
		if (key == 'R') tool_ = AnnotationTool::Rectangle;
		else if (key == 'E') tool_ = AnnotationTool::Ellipse;
		else if (key == 'A') tool_ = AnnotationTool::Arrow;
		else if (key == 'B') tool_ = AnnotationTool::Pen;
		else if (key == 'M') tool_ = AnnotationTool::Mosaic;
		else if (key == 'T') tool_ = AnnotationTool::Text;
		else if (key == VK_LEFT || key == VK_RIGHT || key == VK_UP || key == VK_DOWN) {
			const LONG distance = (GetKeyState(VK_SHIFT) & 0x8000) != 0 ? 10 : 1;
			POINT delta{};
			if (key == VK_LEFT) delta.x = -distance;
			if (key == VK_RIGHT) delta.x = distance;
			if (key == VK_UP) delta.y = -distance;
			if (key == VK_DOWN) delta.y = distance;
			const RECT previous = selection_;
			selection_ = MoveScreenshotRect(selection_, delta, client_bounds_);
			ShiftAnnotations(selection_.left - previous.left, selection_.top - previous.top);
		}
		InvalidateRect(window_, nullptr, FALSE);
	}

	void BeginText(POINT point) {
		DestroyTextEditor(true);
		LONG width = std::min<LONG>(Scale(260), selection_.right - point.x);
		if (width < Scale(80)) {
			point.x = selection_.left;
			width = std::min<LONG>(Scale(260), Width(selection_));
		}
		if (width < Scale(40)) return;
		point.y = std::clamp(point.y, selection_.top, std::max(selection_.top, selection_.bottom - Scale(34)));
		text_anchor_ = point;
		edit_ = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL,
			point.x, point.y, width, Scale(34), window_, nullptr, instance_, nullptr);
		if (edit_ == nullptr) return;
		SendMessageW(edit_, WM_SETFONT, reinterpret_cast<WPARAM>(text_font_), TRUE);
		SetWindowSubclass(edit_, EditProcedure, 1, reinterpret_cast<DWORD_PTR>(this));
		SetFocus(edit_);
	}

	void DestroyTextEditor(bool commit) {
		if (edit_ == nullptr) return;
		HWND editor = edit_;
		edit_ = nullptr;
		std::wstring text;
		if (commit) {
			const int length = GetWindowTextLengthW(editor);
			if (length > 0 && length <= 500) {
				text.resize(static_cast<std::size_t>(length) + 1);
				const int copied = GetWindowTextW(editor, text.data(), length + 1);
				text.resize(static_cast<std::size_t>(std::max(copied, 0)));
			}
		}
		RemoveWindowSubclass(editor, EditProcedure, 1);
		DestroyWindow(editor);
		if (!text.empty() && annotations_.size() < kMaximumAnnotations)
			annotations_.push_back(Annotation{AnnotationTool::Text, {text_anchor_}, std::move(text), color_, Scale(3)});
		if (window_ != nullptr) {
			SetFocus(window_);
			InvalidateRect(window_, nullptr, FALSE);
		}
	}

	void ShiftAnnotations(LONG x, LONG y) {
		if (x == 0 && y == 0) return;
		for (Annotation& annotation : annotations_)
			for (POINT& point : annotation.points) point = OffsetPoint(point, x, y);
	}

	void Cancel() {
		result_ = ScreenshotCaptureResult{};
		DestroyTextEditor(false);
		if (GetCapture() == window_) ReleaseCapture();
		if (window_ != nullptr) DestroyWindow(window_);
	}

	void Complete() {
		DestroyTextEditor(true);
		if (!has_selection_ || Width(selection_) < kMinimumSelection || Height(selection_) < kMinimumSelection) return;
		ScreenshotCaptureResult capture = ComposeSelection();
		if (!capture.error.empty()) {
			result_ = std::move(capture);
			if (GetCapture() == window_) ReleaseCapture();
			if (window_ != nullptr) DestroyWindow(window_);
			return;
		}
		result_ = std::move(capture);
		if (GetCapture() == window_) ReleaseCapture();
		if (window_ != nullptr) DestroyWindow(window_);
	}

	[[nodiscard]] ScreenshotCaptureResult ComposeSelection() {
		ScreenshotCaptureResult output;
		output.width = Width(selection_);
		output.height = Height(selection_);
		HDC result_dc = CreateCompatibleDC(capture_dc_);
		if (result_dc == nullptr) {
			output.error = L"无法创建截图缓冲区";
			return output;
		}
		BITMAPINFO info{};
		info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
		info.bmiHeader.biWidth = output.width;
		info.bmiHeader.biHeight = -output.height;
		info.bmiHeader.biPlanes = 1;
		info.bmiHeader.biBitCount = 32;
		info.bmiHeader.biCompression = BI_RGB;
		std::uint8_t* bits = nullptr;
		HBITMAP bitmap = CreateDIBSection(capture_dc_, &info, DIB_RGB_COLORS, reinterpret_cast<void**>(&bits), nullptr, 0);
		if (bitmap == nullptr || bits == nullptr) {
			if (bitmap != nullptr) DeleteObject(bitmap);
			DeleteDC(result_dc);
			output.error = L"无法分配截图内存";
			return output;
		}
		HGDIOBJ previous = SelectObject(result_dc, bitmap);
		if (previous == nullptr || previous == HGDI_ERROR) {
			DeleteObject(bitmap);
			DeleteDC(result_dc);
			output.error = L"无法创建截图缓冲区";
			return output;
		}
		if (!BitBlt(result_dc,
				0,
				0,
				output.width,
				output.height,
				capture_dc_,
				selection_.left,
				selection_.top,
				SRCCOPY)) {
			SelectObject(result_dc, previous);
			DeleteObject(bitmap);
			DeleteDC(result_dc);
			output.error = L"无法读取选中的截图区域";
			return output;
		}
		SetViewportOrgEx(result_dc, -selection_.left, -selection_.top, nullptr);
		DrawAnnotations(result_dc);
		SetViewportOrgEx(result_dc, 0, 0, nullptr);
		const int stride = output.width * 4;
		const std::size_t byte_count = static_cast<std::size_t>(stride) * static_cast<std::size_t>(output.height);
		for (std::size_t offset = 3; offset < byte_count; offset += 4) bits[offset] = 255;
		output.png = EncodePng(bits, output.width, output.height, stride);
		if (output.png.empty()) output.error = L"无法编码 PNG 截图";
		if (output.error.empty()) {
			output.clipboard_written = WriteClipboard(bits, output.width, output.height, stride, output.png);
			output.completed = true;
		}
		if (previous != nullptr && previous != HGDI_ERROR) SelectObject(result_dc, previous);
		DeleteObject(bitmap);
		DeleteDC(result_dc);
		return output;
	}

	[[nodiscard]] std::vector<std::uint8_t> EncodePng(const std::uint8_t* bits, LONG width, LONG height, int stride) const {
		ComPtr<IWICImagingFactory> factory;
		if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory)))) return {};
		ComPtr<IWICBitmap> bitmap;
		const UINT buffer_size = static_cast<UINT>(static_cast<std::size_t>(stride) * static_cast<std::size_t>(height));
		if (FAILED(factory->CreateBitmapFromMemory(static_cast<UINT>(width), static_cast<UINT>(height),
			GUID_WICPixelFormat32bppBGRA, static_cast<UINT>(stride), buffer_size,
			const_cast<std::uint8_t*>(bits), &bitmap))) return {};
		ComPtr<IStream> stream;
		if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &stream))) return {};
		ComPtr<IWICBitmapEncoder> encoder;
		if (FAILED(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder)) ||
			FAILED(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache))) return {};
		ComPtr<IWICBitmapFrameEncode> frame;
		ComPtr<IPropertyBag2> properties;
		if (FAILED(encoder->CreateNewFrame(&frame, &properties)) || FAILED(frame->Initialize(properties.Get())) ||
			FAILED(frame->SetSize(static_cast<UINT>(width), static_cast<UINT>(height)))) return {};
		WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
		if (FAILED(frame->SetPixelFormat(&format)) || FAILED(frame->WriteSource(bitmap.Get(), nullptr)) ||
			FAILED(frame->Commit()) || FAILED(encoder->Commit())) return {};
		STATSTG stat{};
		if (FAILED(stream->Stat(&stat, STATFLAG_NONAME)) || stat.cbSize.QuadPart <= 0 ||
			stat.cbSize.QuadPart > static_cast<ULONGLONG>(std::numeric_limits<ULONG>::max())) return {};
		LARGE_INTEGER start{};
		if (FAILED(stream->Seek(start, STREAM_SEEK_SET, nullptr))) return {};
		std::vector<std::uint8_t> png(static_cast<std::size_t>(stat.cbSize.QuadPart));
		ULONG read = 0;
		if (FAILED(stream->Read(png.data(), static_cast<ULONG>(png.size()), &read)) ||
			read != static_cast<ULONG>(png.size())) return {};
		return png;
	}

	[[nodiscard]] bool WriteClipboard(
		const std::uint8_t* bits,
		LONG width,
		LONG height,
		int stride,
		const std::vector<std::uint8_t>& png) const {
		bool opened = false;
		const std::size_t pixel_bytes = static_cast<std::size_t>(stride) * static_cast<std::size_t>(height);
		HGLOBAL dib = GlobalAlloc(GMEM_MOVEABLE, sizeof(BITMAPV5HEADER) + pixel_bytes);
		if (dib == nullptr) return false;
		auto* memory = static_cast<std::uint8_t*>(GlobalLock(dib));
		if (memory == nullptr) {
			GlobalFree(dib);
			return false;
		}
		BITMAPV5HEADER header{};
		header.bV5Size = sizeof(header);
		header.bV5Width = width;
		header.bV5Height = -height;
		header.bV5Planes = 1;
		header.bV5BitCount = 32;
		header.bV5Compression = BI_BITFIELDS;
		header.bV5RedMask = 0x00FF0000;
		header.bV5GreenMask = 0x0000FF00;
		header.bV5BlueMask = 0x000000FF;
		header.bV5AlphaMask = 0xFF000000;
		header.bV5CSType = LCS_sRGB;
		std::memcpy(memory, &header, sizeof(header));
		std::memcpy(memory + sizeof(header), bits, pixel_bytes);
		GlobalUnlock(dib);

		const UINT png_format = RegisterClipboardFormatW(L"PNG");
		HGLOBAL png_memory = nullptr;
		if (png_format != 0 && !png.empty()) {
			png_memory = GlobalAlloc(GMEM_MOVEABLE, png.size());
			if (png_memory != nullptr) {
				void* target = GlobalLock(png_memory);
				if (target != nullptr) {
					std::memcpy(target, png.data(), png.size());
					GlobalUnlock(png_memory);
				} else {
					GlobalFree(png_memory);
					png_memory = nullptr;
				}
			}
		}
		for (int attempt = 0; attempt < 5 && !opened; ++attempt) {
			opened = OpenClipboard(window_) != FALSE;
			if (!opened) Sleep(10);
		}
		if (!opened) {
			GlobalFree(dib);
			if (png_memory != nullptr) GlobalFree(png_memory);
			return false;
		}
		if (!EmptyClipboard()) {
			CloseClipboard();
			GlobalFree(dib);
			if (png_memory != nullptr) GlobalFree(png_memory);
			return false;
		}
		const bool dib_set = SetClipboardData(CF_DIBV5, dib) != nullptr;
		if (!dib_set) GlobalFree(dib);
		bool png_set = false;
		if (png_memory != nullptr) {
			png_set = SetClipboardData(png_format, png_memory) != nullptr;
			if (!png_set) GlobalFree(png_memory);
		}
		CloseClipboard();
		return dib_set || png_set;
	}

	[[nodiscard]] int Scale(int value) const noexcept {
		const UINT dpi = window_ != nullptr ? GetDpiForWindow(window_) : USER_DEFAULT_SCREEN_DPI;
		return MulDiv(value, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI);
	}

	HINSTANCE instance_ = nullptr;
	HWND owner_ = nullptr;
	HWND window_ = nullptr;
	HWND edit_ = nullptr;
	WINDOWPLACEMENT owner_placement_{sizeof(WINDOWPLACEMENT)};
	bool owner_was_visible_ = false;
	bool owner_placement_valid_ = false;
	bool owner_restored_ = false;
	bool running_ = false;
	RECT virtual_bounds_{};
	RECT client_bounds_{};
	HDC capture_dc_ = nullptr;
	HBITMAP capture_bitmap_ = nullptr;
	HGDIOBJ capture_previous_ = nullptr;
	std::uint8_t* capture_bits_ = nullptr;
	int capture_stride_ = 0;
	HDC dim_dc_ = nullptr;
	HBITMAP dim_bitmap_ = nullptr;
	HGDIOBJ dim_previous_ = nullptr;
	HFONT ui_font_ = nullptr;
	HFONT text_font_ = nullptr;
	ScreenshotCaptureResult result_;
	RECT selection_{};
	RECT selection_before_drag_{};
	RECT hover_window_{};
	POINT drag_origin_{};
	POINT last_mouse_{};
	POINT text_anchor_{};
	bool has_selection_ = false;
	Interaction interaction_ = Interaction::Idle;
	ScreenshotResizeHandle resize_handle_ = ScreenshotResizeHandle::None;
	AnnotationTool tool_ = AnnotationTool::None;
	COLORREF color_ = RGB(239, 63, 53);
	std::vector<Annotation> annotations_;
	std::optional<Annotation> active_annotation_;
	std::size_t hovered_button_ = std::numeric_limits<std::size_t>::max();
	std::optional<std::size_t> pressed_button_;
	bool complete_on_left_up_ = false;
};

} // namespace

ScreenshotCaptureResult ScreenshotOverlay::Capture(HINSTANCE instance, HWND owner) {
	OverlaySession session(instance, owner);
	return session.Run();
}

} // namespace omp::shell
