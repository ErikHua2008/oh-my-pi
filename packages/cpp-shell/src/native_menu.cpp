#include "omp_shell/native_menu.h"

#include <algorithm>
#include <string_view>

namespace omp::shell {
namespace {

[[nodiscard]] COLORREF ToColorRef(std::uint32_t rgb) noexcept {
	return RGB((rgb >> 16U) & 0xFFU, (rgb >> 8U) & 0xFFU, rgb & 0xFFU);
}

[[nodiscard]] HBRUSH MenuBrush(bool dark, bool hot = false) noexcept {
	static HBRUSH light_brush = CreateSolidBrush(ToColorRef(NativeMenuPaletteFor(false).background));
	static HBRUSH light_hot_brush = CreateSolidBrush(ToColorRef(NativeMenuPaletteFor(false).hot_background));
	static HBRUSH dark_brush = CreateSolidBrush(ToColorRef(NativeMenuPaletteFor(true).background));
	static HBRUSH dark_hot_brush = CreateSolidBrush(ToColorRef(NativeMenuPaletteFor(true).hot_background));
	if (dark) {
		return hot ? dark_hot_brush : dark_brush;
	}
	return hot ? light_hot_brush : light_brush;
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

void DrawMenuText(HDC dc, std::wstring_view text, RECT bounds, UINT flags) noexcept {
	if (!text.empty()) {
		DrawTextW(dc, const_cast<wchar_t*>(text.data()), static_cast<int>(text.size()), &bounds, flags);
	}
}

} // namespace

void ApplyNativeMenuBackground(HMENU menu, bool dark) noexcept {
	if (menu == nullptr) {
		return;
	}
	MENUINFO info{};
	info.cbSize = sizeof(info);
	info.fMask = MIM_BACKGROUND | MIM_APPLYTOSUBMENUS;
	info.hbrBack = MenuBrush(dark);
	SetMenuInfo(menu, &info);
}

void InsertNativeMenuItem(
	HMENU menu, const NativeMenuItem& item, UINT command, HMENU submenu, UINT state) {
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

bool MeasureNativeMenuItem(HWND window, MEASUREITEMSTRUCT* measure) noexcept {
	if (measure == nullptr || measure->CtlType != ODT_MENU || measure->itemData == 0) {
		return false;
	}
	const auto* item = reinterpret_cast<const NativeMenuItem*>(measure->itemData);
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

bool DrawNativeMenuItem(HWND window, const DRAWITEMSTRUCT* draw, bool dark) noexcept {
	if (draw == nullptr || draw->CtlType != ODT_MENU || draw->itemData == 0) {
		return false;
	}
	const auto* item = reinterpret_cast<const NativeMenuItem*>(draw->itemData);
	const NativeMenuPalette palette = NativeMenuPaletteFor(dark);
	const bool selected = (draw->itemState & (ODS_SELECTED | ODS_HOTLIGHT)) != 0;
	FillRect(draw->hDC, &draw->rcItem, MenuBrush(dark, selected));
	const UINT dpi = window == nullptr ? USER_DEFAULT_SCREEN_DPI : GetDpiForWindow(window);
	if (item->separator) {
		const int y = (draw->rcItem.top + draw->rcItem.bottom) / 2;
		RECT separator{draw->rcItem.left + MulDiv(28, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI),
			y,
			draw->rcItem.right - MulDiv(8, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI),
			y + 1};
		HBRUSH brush = CreateSolidBrush(ToColorRef(palette.separator));
		FillRect(draw->hDC, &separator, brush);
		DeleteObject(brush);
		return true;
	}

	const bool disabled = (draw->itemState & (ODS_DISABLED | ODS_GRAYED)) != 0;
	SetBkMode(draw->hDC, TRANSPARENT);
	SetTextColor(draw->hDC, ToColorRef(disabled ? palette.disabled_foreground : palette.foreground));
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
				ToColorRef(disabled ? palette.disabled_foreground : palette.foreground));
			HGDIOBJ previous_pen = SelectObject(draw->hDC, pen);
			MoveToEx(draw->hDC, center_x - MulDiv(4, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI), center_y, nullptr);
			LineTo(draw->hDC,
				center_x - MulDiv(1, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI),
				center_y + MulDiv(3, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI));
			LineTo(draw->hDC,
				center_x + MulDiv(5, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI),
				center_y - MulDiv(4, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI));
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

} // namespace omp::shell
