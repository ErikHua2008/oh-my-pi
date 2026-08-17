#include "omp_shell/native_transcript_view.h"

#include "omp_shell/native_menu.h"
#include "omp_shell/native_transcript_bubble.h"
#include "omp_shell/native_transcript_reasoning.h"
#include "omp_shell/text_utils.h"

#include <shellapi.h>
#include <shlobj.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstring>
#include <limits>
#include <string_view>

namespace omp::shell {
namespace {

constexpr wchar_t kTranscriptWindowClass[] = L"OmpNativeTranscriptWindow";
constexpr float kRowContentInset = 16.0F;
constexpr float kRowVerticalPadding = 12.0F;
constexpr float kLabelHeight = 17.0F;
constexpr float kTextGap = 5.0F;
constexpr std::int32_t kCollapsedExpandableHeight = 42;
constexpr float kProcessItemHeaderHeight = 30.0F;
constexpr float kProcessItemGap = 6.0F;
constexpr float kProcessDetailGap = 4.0F;
constexpr float kProcessDetailHeight = 112.0F;
constexpr float kProcessDetailPadding = 8.0F;
constexpr std::int64_t kEstimatedLineScroll = 54;
constexpr std::int64_t kOverscan = 360;
constexpr std::size_t kMaximumCachedLayouts = 256;
constexpr std::size_t kMaximumCachedMedia = 32;
constexpr std::size_t kMaximumMediaBytes = 32 * 1024 * 1024;
constexpr std::size_t kMaximumSingleMediaBytes = 4 * 1024 * 1024;
constexpr float kThumbnailHeight = 160.0F;
constexpr float kMediaGap = 8.0F;
constexpr float kScrollbarHotWidth = 5.0F;
constexpr UINT_PTR kScrollbarHideTimer = 1;
constexpr UINT_PTR kMessageCopyFeedbackTimer = 2;
constexpr UINT kScrollbarHideDelayMs = 1'100;
constexpr UINT kMessageCopyFeedbackDelayMs = 1'200;
constexpr UINT kContextCopy = 1;
constexpr UINT kContextSelectAll = 2;
constexpr NativeMenuItem kContextCopyItem{L"复制\tCtrl+C", false, false};
constexpr NativeMenuItem kContextSelectAllItem{L"全选\tCtrl+A", false, false};

class NativeTranscriptDropTarget final : public IDropTarget {
public:
	NativeTranscriptDropTarget(
		HWND target, std::function<bool()> enabled_handler, std::function<void(bool)> state_handler)
		: target_(target), enabled_handler_(std::move(enabled_handler)), state_handler_(std::move(state_handler)) {}

	HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** value) override {
		if (value == nullptr) return E_POINTER;
		*value = nullptr;
		if (iid == IID_IUnknown || iid == IID_IDropTarget) {
			*value = static_cast<IDropTarget*>(this);
			AddRef();
			return S_OK;
		}
		return E_NOINTERFACE;
	}

	ULONG STDMETHODCALLTYPE AddRef() override { return ++reference_count_; }

	ULONG STDMETHODCALLTYPE Release() override {
		const ULONG remaining = --reference_count_;
		if (remaining == 0) delete this;
		return remaining;
	}

	HRESULT STDMETHODCALLTYPE DragEnter(
		IDataObject* data_object, DWORD, POINTL, DWORD* effect) override {
		has_files_ = enabled_handler_() && HasFileDrop(data_object);
		state_handler_(has_files_);
		SetEffect(effect, has_files_ && enabled_handler_());
		return S_OK;
	}

	HRESULT STDMETHODCALLTYPE DragOver(DWORD, POINTL, DWORD* effect) override {
		SetEffect(effect, has_files_ && enabled_handler_());
		return S_OK;
	}

	HRESULT STDMETHODCALLTYPE DragLeave() override {
		has_files_ = false;
		state_handler_(false);
		return S_OK;
	}

	HRESULT STDMETHODCALLTYPE Drop(IDataObject* data_object, DWORD, POINTL, DWORD* effect) override {
		const bool forwarded = has_files_ && enabled_handler_() && ForwardFileDrop(data_object);
		has_files_ = false;
		state_handler_(false);
		SetEffect(effect, forwarded);
		return S_OK;
	}

private:
	[[nodiscard]] static FORMATETC FileDropFormat() noexcept {
		return {static_cast<CLIPFORMAT>(CF_HDROP), nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
	}

	[[nodiscard]] static bool HasFileDrop(IDataObject* data_object) noexcept {
		if (data_object == nullptr) return false;
		FORMATETC format = FileDropFormat();
		return data_object->QueryGetData(&format) == S_OK;
	}

	static void SetEffect(DWORD* effect, bool accepted) noexcept {
		if (effect == nullptr) return;
		if (!accepted) {
			*effect = DROPEFFECT_NONE;
			return;
		}
		const DWORD allowed = *effect;
		*effect = (allowed & DROPEFFECT_LINK) != 0
			? DROPEFFECT_LINK
			: ((allowed & DROPEFFECT_COPY) != 0 ? DROPEFFECT_COPY : DROPEFFECT_NONE);
	}

	[[nodiscard]] bool ForwardFileDrop(IDataObject* data_object) const {
		if (data_object == nullptr || !IsWindow(target_)) return false;
		FORMATETC format = FileDropFormat();
		STGMEDIUM medium{};
		if (FAILED(data_object->GetData(&format, &medium))) {
			return false;
		}
		if (medium.tymed != TYMED_HGLOBAL || medium.hGlobal == nullptr) {
			ReleaseStgMedium(&medium);
			return false;
		}

		const HDROP source = reinterpret_cast<HDROP>(medium.hGlobal);
		const UINT count = std::min<UINT>(DragQueryFileW(source, 0xFFFFFFFFU, nullptr, 0), 32U);
		std::vector<std::wstring> paths;
		paths.reserve(count);
		std::size_t character_count = 1;
		for (UINT index = 0; index < count; ++index) {
			const UINT length = DragQueryFileW(source, index, nullptr, 0);
			if (length == 0) continue;
			std::wstring path(static_cast<std::size_t>(length) + 1, L'\0');
			if (DragQueryFileW(source, index, path.data(), length + 1) == 0) continue;
			path.resize(length);
			character_count += path.size() + 1;
			paths.push_back(std::move(path));
		}
		ReleaseStgMedium(&medium);
		if (paths.empty()) return false;

		const std::size_t bytes = sizeof(DROPFILES) + character_count * sizeof(wchar_t);
		HGLOBAL forwarded = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes);
		if (forwarded == nullptr) return false;
		auto* data = static_cast<std::byte*>(GlobalLock(forwarded));
		if (data == nullptr) {
			GlobalFree(forwarded);
			return false;
		}
		auto* descriptor = reinterpret_cast<DROPFILES*>(data);
		descriptor->pFiles = sizeof(DROPFILES);
		descriptor->fWide = TRUE;
		auto* cursor = reinterpret_cast<wchar_t*>(data + sizeof(DROPFILES));
		for (const std::wstring& path : paths) {
			std::memcpy(cursor, path.c_str(), (path.size() + 1) * sizeof(wchar_t));
			cursor += path.size() + 1;
		}
		*cursor = L'\0';
		GlobalUnlock(forwarded);

		const HWND parent = GetParent(target_);
		if (!IsWindow(parent)) {
			GlobalFree(forwarded);
			return false;
		}
		SendMessageW(parent, WM_DROPFILES, reinterpret_cast<WPARAM>(forwarded), 0);
		return true;
	}

	std::atomic<ULONG> reference_count_{1};
	HWND target_ = nullptr;
	std::function<bool()> enabled_handler_;
	std::function<void(bool)> state_handler_;
	bool has_files_ = false;
};

[[nodiscard]] D2D1_COLOR_F Color(std::uint32_t rgb, float alpha = 1.0F) noexcept {
	return D2D1::ColorF(
		static_cast<float>((rgb >> 16) & 0xFFU) / 255.0F,
		static_cast<float>((rgb >> 8) & 0xFFU) / 255.0F,
		static_cast<float>(rgb & 0xFFU) / 255.0F,
		alpha);
}

[[nodiscard]] D2D1_COLOR_F Color(const NativeTranscriptColor& color) noexcept {
	return Color(color.rgb, color.alpha);
}

[[nodiscard]] std::wstring_view RowLabel(NativeTranscriptRowKind kind) noexcept {
	switch (kind) {
	case NativeTranscriptRowKind::User:
		return L"你";
	case NativeTranscriptRowKind::Assistant:
		return L"Grimoire Router App";
	case NativeTranscriptRowKind::Reasoning:
		return L"思考";
	case NativeTranscriptRowKind::Plan:
		return L"计划";
	case NativeTranscriptRowKind::Tool:
		return L"操作";
	case NativeTranscriptRowKind::System:
		return L"系统";
	case NativeTranscriptRowKind::Compaction:
		return L"上下文压缩";
	case NativeTranscriptRowKind::Error:
		return L"错误";
	}
	return L"";
}

[[nodiscard]] D2D1_RECT_F ToD2DRect(const NativeTranscriptRectF& rect) noexcept {
	return D2D1::RectF(rect.left, rect.top, rect.right, rect.bottom);
}

[[nodiscard]] std::string ProcessItemKey(
	const NativeTranscriptRow& row, const NativeTranscriptProcessItem& item) {
	std::string key = row.id;
	key.push_back('\x1f');
	key.append(item.id);
	return key;
}

bool WriteClipboardText(HWND owner, std::wstring_view text) {
	if (text.empty() || !OpenClipboard(owner)) {
		return false;
	}
	if (!EmptyClipboard()) {
		CloseClipboard();
		return false;
	}
	const std::size_t byte_count = (text.size() + 1) * sizeof(wchar_t);
	HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, byte_count);
	bool copied = false;
	if (memory != nullptr) {
		void* destination = GlobalLock(memory);
		if (destination != nullptr) {
			std::memcpy(destination, text.data(), text.size() * sizeof(wchar_t));
			static_cast<wchar_t*>(destination)[text.size()] = L'\0';
			GlobalUnlock(memory);
			if (SetClipboardData(CF_UNICODETEXT, memory) != nullptr) {
				memory = nullptr;
				copied = true;
			}
		}
	}
	if (memory != nullptr) {
		GlobalFree(memory);
	}
	CloseClipboard();
	return copied;
}

} // namespace

NativeTranscriptView::~NativeTranscriptView() {
	Destroy();
}

bool NativeTranscriptView::Create(HWND parent, HINSTANCE instance) {
	if (window_ != nullptr) {
		return true;
	}
	if (!RegisterWindowClass(instance)) {
		return false;
	}

	window_ = CreateWindowExW(
		0,
		kTranscriptWindowClass,
		L"",
		WS_CHILD | WS_CLIPSIBLINGS | WS_TABSTOP,
		0,
		0,
		1,
		1,
		parent,
		nullptr,
		instance,
		this);
	if (window_ == nullptr) {
		return false;
	}
	HRESULT result = D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, d2d_factory_.ReleaseAndGetAddressOf());
	if (SUCCEEDED(result)) {
		result = DWriteCreateFactory(
			DWRITE_FACTORY_TYPE_SHARED,
			__uuidof(IDWriteFactory),
			reinterpret_cast<IUnknown**>(dwrite_factory_.ReleaseAndGetAddressOf()));
	}
	if (FAILED(result)) {
		Destroy();
		return false;
	}

	result = dwrite_factory_->CreateTextFormat(
		L"Segoe UI",
		nullptr,
		DWRITE_FONT_WEIGHT_NORMAL,
		DWRITE_FONT_STYLE_NORMAL,
		DWRITE_FONT_STRETCH_NORMAL,
		15.0F,
		L"zh-CN",
		text_format_.ReleaseAndGetAddressOf());
	if (SUCCEEDED(result)) {
		result = dwrite_factory_->CreateTextFormat(
			L"Segoe UI",
			nullptr,
			DWRITE_FONT_WEIGHT_SEMI_BOLD,
			DWRITE_FONT_STYLE_NORMAL,
			DWRITE_FONT_STRETCH_NORMAL,
			11.0F,
			L"zh-CN",
			label_format_.ReleaseAndGetAddressOf());
	}
	if (SUCCEEDED(result)) {
		result = dwrite_factory_->CreateTextFormat(
			L"Segoe UI",
			nullptr,
			DWRITE_FONT_WEIGHT_SEMI_BOLD,
			DWRITE_FONT_STYLE_NORMAL,
			DWRITE_FONT_STRETCH_NORMAL,
			13.0F,
			L"zh-CN",
			drop_hint_format_.ReleaseAndGetAddressOf());
	}
	if (FAILED(result)) {
		Destroy();
		return false;
	}
	HRESULT wic_result = CoCreateInstance(
		CLSID_WICImagingFactory2,
		nullptr,
		CLSCTX_INPROC_SERVER,
		IID_PPV_ARGS(wic_factory_.ReleaseAndGetAddressOf()));
	if (FAILED(wic_result)) {
		static_cast<void>(CoCreateInstance(
			CLSID_WICImagingFactory,
			nullptr,
			CLSCTX_INPROC_SERVER,
			IID_PPV_ARGS(wic_factory_.ReleaseAndGetAddressOf())));
	}
	text_format_->SetWordWrapping(DWRITE_WORD_WRAPPING_WRAP);
	text_format_->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_NEAR);
	drop_hint_format_->SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER);
	drop_hint_format_->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
	auto* target = new NativeTranscriptDropTarget(
		window_, [this] { return file_drop_enabled_; }, [this](bool active) { SetFileDragActive(active); });
	if (SUCCEEDED(RegisterDragDrop(window_, target))) {
		drop_target_.Attach(target);
	} else {
		target->Release();
		DragAcceptFiles(window_, TRUE);
	}
	return true;
}

void NativeTranscriptView::Destroy() {
	SetFileDragActive(false);
	if (window_ != nullptr && drop_target_ != nullptr) {
		static_cast<void>(RevokeDragDrop(window_));
	}
	drop_target_.Reset();
	if (window_ != nullptr) {
		KillTimer(window_, kScrollbarHideTimer);
		KillTimer(window_, kMessageCopyFeedbackTimer);
	}
	DiscardDeviceResources();
	layout_cache_.clear();
	media_cache_.clear();
	requested_media_.clear();
	text_format_.Reset();
	label_format_.Reset();
	drop_hint_format_.Reset();
	dwrite_factory_.Reset();
	wic_factory_.Reset();
	d2d_factory_.Reset();
	if (window_ != nullptr) {
		const HWND owned = window_;
		window_ = nullptr;
		DestroyWindow(owned);
	}
	visible_ = false;
}

void NativeTranscriptView::SetBounds(const RECT& bounds) {
	if (window_ == nullptr) {
		return;
	}
	bounds_ = bounds;
	const int width = std::max(0L, bounds.right - bounds.left);
	const int height = std::max(0L, bounds.bottom - bounds.top);
	SetWindowPos(
		window_, HWND_TOP, bounds.left, bounds.top, width, height, SWP_NOACTIVATE | (visible_ ? SWP_SHOWWINDOW : 0));
	ApplyOcclusion();
	if (stick_to_bottom_) {
		StabilizeCurrentViewport();
		ScrollToBottom();
	} else {
		ScrollTo(scroll_offset_, false);
	}
}

void NativeTranscriptView::SetOcclusion(std::optional<RECT> occlusion) {
	occlusion_ = occlusion;
	ApplyOcclusion();
}

void NativeTranscriptView::ApplyOcclusion() {
	if (window_ == nullptr) {
		return;
	}
	const LONG width = std::max(0L, bounds_.right - bounds_.left);
	const LONG height = std::max(0L, bounds_.bottom - bounds_.top);
	if (!occlusion_ || width == 0 || height == 0) {
		SetWindowRgn(window_, nullptr, TRUE);
		return;
	}
	const RECT clipped{
		std::clamp(occlusion_->left - bounds_.left, 0L, width),
		std::clamp(occlusion_->top - bounds_.top, 0L, height),
		std::clamp(occlusion_->right - bounds_.left, 0L, width),
		std::clamp(occlusion_->bottom - bounds_.top, 0L, height),
	};
	if (clipped.right <= clipped.left || clipped.bottom <= clipped.top) {
		SetWindowRgn(window_, nullptr, TRUE);
		return;
	}
	HRGN visible_region = CreateRectRgn(0, 0, width, height);
	HRGN occluded_region = CreateRectRgn(clipped.left, clipped.top, clipped.right, clipped.bottom);
	if (visible_region == nullptr || occluded_region == nullptr ||
		CombineRgn(visible_region, visible_region, occluded_region, RGN_DIFF) == ERROR) {
		if (visible_region != nullptr) DeleteObject(visible_region);
		if (occluded_region != nullptr) DeleteObject(occluded_region);
		return;
	}
	DeleteObject(occluded_region);
	if (SetWindowRgn(window_, visible_region, TRUE) == 0) {
		DeleteObject(visible_region);
	}
}

void NativeTranscriptView::SetVisible(bool visible) {
	visible_ = visible;
	if (window_ == nullptr) {
		return;
	}
	ShowWindow(window_, visible ? SW_SHOWNA : SW_HIDE);
	if (visible) {
		SetWindowPos(window_, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
		InvalidateRect(window_, nullptr, FALSE);
		MaybeRequestEarlier();
	}
}

void NativeTranscriptView::SetDarkTheme(bool dark) {
	if (dark_theme_ == dark) {
		return;
	}
	dark_theme_ = dark;
	DiscardDeviceResources();
	if (window_ != nullptr) {
		InvalidateRect(window_, nullptr, FALSE);
	}
}

void NativeTranscriptView::SetFileDropEnabled(bool enabled) {
	file_drop_enabled_ = enabled;
	if (!enabled) SetFileDragActive(false);
}

void NativeTranscriptView::Clear() {
	if (window_ != nullptr) {
		KillTimer(window_, kScrollbarHideTimer);
		KillTimer(window_, kMessageCopyFeedbackTimer);
	}
	model_.Clear();
	layout_cache_.clear();
	media_cache_.clear();
	requested_media_.clear();
	expanded_rows_.clear();
	expanded_process_items_.clear();
	process_detail_scroll_offsets_.clear();
	ClearSelection();
	scroll_offset_ = 0;
	history_remaining_ = 0;
	history_loading_ = false;
	history_request_sent_ = false;
	history_request_delivered_ = false;
	overlay_scrollbar_visible_ = false;
	scrollbar_hovered_ = false;
	scrollbar_dragging_ = false;
	jump_button_hovered_ = false;
	jump_button_pressed_ = false;
	hovered_message_action_.reset();
	copied_row_id_.clear();
	mouse_tracking_ = false;
	stick_to_bottom_ = true;
	occlusion_.reset();
	ApplyOcclusion();
	UpdateScrollInfo();
	if (window_ != nullptr) {
		InvalidateRect(window_, nullptr, FALSE);
	}
}

void NativeTranscriptView::ReplaceSnapshot(std::vector<NativeTranscriptRow> rows, bool reset_to_tail) {
	const bool keep_tail = reset_to_tail || stick_to_bottom_ || scroll_offset_ >= MaximumScroll() - 2;
	if (reset_to_tail) {
		stick_to_bottom_ = true;
		scroll_offset_ = 0;
		expanded_rows_.clear();
		expanded_process_items_.clear();
		process_detail_scroll_offsets_.clear();
		ClearSelection();
		hovered_message_action_.reset();
		copied_row_id_.clear();
		if (window_ != nullptr) KillTimer(window_, kMessageCopyFeedbackTimer);
	}
	model_.ReplaceSnapshot(std::move(rows));
	for (auto it = expanded_rows_.begin(); it != expanded_rows_.end();) {
		if (model_.IndexOf(*it)) {
			++it;
		} else {
			it = expanded_rows_.erase(it);
		}
	}
	std::unordered_set<std::string> valid_process_items;
	for (std::size_t row_index = 0; row_index < model_.Size(); ++row_index) {
		const NativeTranscriptRow& row = model_.RowAt(row_index);
		for (const NativeTranscriptProcessItem& item : row.process_items) {
			valid_process_items.insert(ProcessItemKey(row, item));
		}
	}
	for (auto it = expanded_process_items_.begin(); it != expanded_process_items_.end();) {
		if (valid_process_items.contains(*it)) {
			++it;
		} else {
			process_detail_scroll_offsets_.erase(*it);
			it = expanded_process_items_.erase(it);
		}
	}
	if ((selection_anchor_ && !model_.IndexOf(selection_anchor_->row_id)) ||
		(selection_focus_ && !model_.IndexOf(selection_focus_->row_id))) {
		ClearSelection();
	}
	if (hovered_message_action_ && !model_.IndexOf(hovered_message_action_->row_id)) {
		hovered_message_action_.reset();
	}
	if (!copied_row_id_.empty() && !model_.IndexOf(copied_row_id_)) {
		copied_row_id_.clear();
		if (window_ != nullptr) KillTimer(window_, kMessageCopyFeedbackTimer);
	}
	// A replacement snapshot may retain stable row ids while changing their
	// text (for example after history reconciliation or an imported transcript
	// refresh). Text layouts are keyed by row id, so keeping the old cache would
	// render stale content and preserve the wrong measured height.
	layout_cache_.clear();
	if (keep_tail) {
		ScrollToBottom();
	} else {
		ScrollTo(scroll_offset_, false);
	}
	if (keep_tail) StabilizeCurrentViewport();
	UpdateScrollInfo();
	if (window_ != nullptr) {
		InvalidateRect(window_, nullptr, FALSE);
	}
}

void NativeTranscriptView::Upsert(NativeTranscriptRow row) {
	const bool keep_tail = stick_to_bottom_ || scroll_offset_ >= MaximumScroll() - 2;
	const std::string id = row.id;
	static_cast<void>(model_.Upsert(std::move(row)));
	layout_cache_.erase(id);
	if (keep_tail) {
		ScrollToBottom();
	} else {
		ScrollTo(scroll_offset_, false);
	}
	UpdateScrollInfo();
	if (window_ != nullptr) {
		InvalidateRect(window_, nullptr, FALSE);
	}
}

void NativeTranscriptView::Remove(std::string_view id) {
	const bool keep_tail = stick_to_bottom_ || scroll_offset_ >= MaximumScroll() - 2;
	if (!model_.Remove(id)) {
		return;
	}
	if ((selection_anchor_ && selection_anchor_->row_id == id) ||
		(selection_focus_ && selection_focus_->row_id == id)) {
		ClearSelection();
	}
	if (hovered_message_action_ && hovered_message_action_->row_id == id) hovered_message_action_.reset();
	if (copied_row_id_ == id) {
		copied_row_id_.clear();
		if (window_ != nullptr) KillTimer(window_, kMessageCopyFeedbackTimer);
	}
	layout_cache_.erase(std::string(id));
	std::string process_prefix(id);
	process_prefix.push_back('\x1f');
	for (auto it = expanded_process_items_.begin(); it != expanded_process_items_.end();) {
		if (it->starts_with(process_prefix)) {
			process_detail_scroll_offsets_.erase(*it);
			layout_cache_.erase(*it);
			it = expanded_process_items_.erase(it);
		} else {
			++it;
		}
	}
	if (keep_tail) {
		ScrollToBottom();
	} else {
		ScrollTo(scroll_offset_, false);
	}
	UpdateScrollInfo();
	if (window_ != nullptr) {
		InvalidateRect(window_, nullptr, FALSE);
	}
}

void NativeTranscriptView::SetHistoryState(std::size_t remaining, bool loading) {
	if (remaining != history_remaining_ || (history_loading_ && !loading)) {
		history_request_sent_ = false;
		history_request_delivered_ = false;
	}
	history_remaining_ = remaining;
	history_loading_ = loading;
	MaybeRequestEarlier();
}

void NativeTranscriptView::SetHistoryRequestHandler(std::function<void()> handler) {
	history_request_handler_ = std::move(handler);
	MaybeRequestEarlier();
}

bool NativeTranscriptView::TakeHistoryRequest() noexcept {
	if (!history_request_sent_ || history_request_delivered_) {
		return false;
	}
	history_request_delivered_ = true;
	return true;
}

void NativeTranscriptView::SetImageRequestHandler(std::function<void(std::string_view)> handler) {
	image_request_handler_ = std::move(handler);
}

void NativeTranscriptView::SetEditRequestHandler(std::function<void(std::string_view)> handler) {
	edit_request_handler_ = std::move(handler);
}

void NativeTranscriptView::ProvideImage(std::string image_id, std::vector<std::uint8_t> encoded_bytes) {
	if (image_id.empty()) {
		return;
	}
	requested_media_.erase(image_id);
	MediaEntry& entry = media_cache_[image_id];
	entry.bitmap.Reset();
	entry.last_use = ++media_use_clock_;
	if (encoded_bytes.empty() || encoded_bytes.size() > kMaximumSingleMediaBytes) {
		entry.encoded_bytes.clear();
		entry.failed = true;
	} else {
		entry.encoded_bytes = std::move(encoded_bytes);
		entry.failed = false;
	}
	TrimMediaCache();
	if (window_ != nullptr) {
		InvalidateRect(window_, nullptr, FALSE);
	}
}

LRESULT CALLBACK NativeTranscriptView::WindowProcedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
	NativeTranscriptView* view = reinterpret_cast<NativeTranscriptView*>(GetWindowLongPtrW(window, GWLP_USERDATA));
	if (message == WM_NCCREATE) {
		const auto* create = reinterpret_cast<CREATESTRUCTW*>(lparam);
		view = static_cast<NativeTranscriptView*>(create->lpCreateParams);
		view->window_ = window;
		SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(view));
	}
	if (view != nullptr) {
		return view->HandleMessage(message, wparam, lparam);
	}
	return DefWindowProcW(window, message, wparam, lparam);
}

LRESULT NativeTranscriptView::HandleMessage(UINT message, WPARAM wparam, LPARAM lparam) {
	switch (message) {
	case WM_PAINT:
		Paint();
		return 0;
	case WM_ERASEBKGND:
		return 1;
	case WM_DROPFILES:
		// The native transcript is a child HWND layered over the WebView. Forward
		// its HDROP to App so dropping anywhere in the conversation surface uses
		// the same path-reference flow as the composer.
		if (!file_drop_enabled_) {
			DragFinish(reinterpret_cast<HDROP>(wparam));
			return 0;
		}
		SendMessageW(GetParent(window_), WM_DROPFILES, wparam, lparam);
		return 0;
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
	case WM_SIZE:
		if (render_target_ != nullptr) {
			const UINT width = LOWORD(lparam);
			const UINT height = HIWORD(lparam);
			render_target_->Resize(D2D1::SizeU(width, height));
		}
		ScrollTo(scroll_offset_, false);
		return 0;
	case WM_DPICHANGED_AFTERPARENT:
		DiscardDeviceResources();
		layout_cache_.clear();
		UpdateScrollInfo();
		InvalidateRect(window_, nullptr, FALSE);
		return 0;
	case WM_TIMER:
		if (wparam == kScrollbarHideTimer && !scrollbar_hovered_ && !scrollbar_dragging_) {
			KillTimer(window_, kScrollbarHideTimer);
			if (overlay_scrollbar_visible_) {
				overlay_scrollbar_visible_ = false;
				InvalidateRect(window_, nullptr, FALSE);
			}
			return 0;
		}
		if (wparam == kMessageCopyFeedbackTimer) {
			KillTimer(window_, kMessageCopyFeedbackTimer);
			if (!copied_row_id_.empty()) {
				copied_row_id_.clear();
				InvalidateRect(window_, nullptr, FALSE);
			}
			return 0;
		}
		break;
	case WM_MOUSEWHEEL: {
		POINT point{static_cast<short>(LOWORD(lparam)), static_cast<short>(HIWORD(lparam))};
		if (ScreenToClient(window_, &point) && ScrollProcessDetailAtPoint(point, GET_WHEEL_DELTA_WPARAM(wparam))) {
			return 0;
		}
		RevealOverlayScrollbar();
		wheel_remainder_ += GET_WHEEL_DELTA_WPARAM(wparam);
		UINT lines = 3;
		SystemParametersInfoW(SPI_GETWHEELSCROLLLINES, 0, &lines, 0);
		if (lines == WHEEL_PAGESCROLL) {
			const int pages = wheel_remainder_ / WHEEL_DELTA;
			wheel_remainder_ %= WHEEL_DELTA;
			ScrollBy(-static_cast<std::int64_t>(pages) * ClientHeightDip(), true);
		} else {
			const int notches = wheel_remainder_ / WHEEL_DELTA;
			wheel_remainder_ %= WHEEL_DELTA;
			ScrollBy(-static_cast<std::int64_t>(notches) * lines * kEstimatedLineScroll, true);
		}
		return 0;
	}
	case WM_VSCROLL: {
		RevealOverlayScrollbar();
		SCROLLINFO info{};
		info.cbSize = sizeof(info);
		info.fMask = SIF_TRACKPOS;
		GetScrollInfo(window_, SB_VERT, &info);
		switch (LOWORD(wparam)) {
		case SB_LINEUP:
			ScrollBy(-kEstimatedLineScroll, true);
			break;
		case SB_LINEDOWN:
			ScrollBy(kEstimatedLineScroll, true);
			break;
		case SB_PAGEUP:
			ScrollBy(-ClientHeightDip() * 9 / 10, true);
			break;
		case SB_PAGEDOWN:
			ScrollBy(ClientHeightDip() * 9 / 10, true);
			break;
		case SB_THUMBPOSITION:
		case SB_THUMBTRACK:
			ScrollTo(info.nTrackPos, true);
			break;
		case SB_TOP:
			ScrollTo(0, true);
			break;
		case SB_BOTTOM:
			ScrollToBottom();
			break;
		default:
			break;
		}
		return 0;
	}
	case WM_KEYDOWN:
		if ((GetKeyState(VK_CONTROL) & 0x8000) != 0 && wparam == 'C') {
			CopySelectionToClipboard();
			return 0;
		}
		if ((GetKeyState(VK_CONTROL) & 0x8000) != 0 && wparam == 'A') {
			SelectAll();
			return 0;
		}
		switch (wparam) {
		case VK_UP:
			ScrollBy(-kEstimatedLineScroll, true);
			return 0;
		case VK_DOWN:
			ScrollBy(kEstimatedLineScroll, true);
			return 0;
		case VK_PRIOR:
			ScrollBy(-ClientHeightDip() * 9 / 10, true);
			return 0;
		case VK_NEXT:
			ScrollBy(ClientHeightDip() * 9 / 10, true);
			return 0;
		case VK_HOME:
			if ((GetKeyState(VK_CONTROL) & 0x8000) != 0) {
				ScrollTo(0, true);
				return 0;
			}
			break;
		case VK_END:
			if ((GetKeyState(VK_CONTROL) & 0x8000) != 0) {
				ScrollToBottom();
				return 0;
			}
			break;
		default:
			break;
		}
		break;
	case WM_LBUTTONDOWN: {
		SetFocus(window_);
		const POINT point{static_cast<short>(LOWORD(lparam)), static_cast<short>(HIWORD(lparam))};
		const D2D1_POINT_2F dip_point = PointToDip(point);
		if (JumpButtonVisible() && CurrentJumpButton().Contains(dip_point.x, dip_point.y)) {
			SetCapture(window_);
			jump_button_pressed_ = true;
			jump_button_hovered_ = true;
			InvalidateRect(window_, nullptr, FALSE);
			return 0;
		}
		NativeTranscriptScrollbarGeometry scrollbar = CurrentScrollbarGeometry();
		if (scrollbar.scrollable && scrollbar.hit_area.Contains(dip_point.x, dip_point.y)) {
			SetCapture(window_);
			selecting_ = false;
			scrollbar_dragging_ = true;
			scrollbar_hovered_ = true;
			RevealOverlayScrollbar();
			if (!scrollbar.thumb.Contains(dip_point.x, dip_point.y)) {
				const float centered_top = dip_point.y - scrollbar.thumb.Height() / 2.0F;
				ScrollTo(
					NativeTranscriptOffsetForThumbTop(scrollbar, centered_top, MaximumScroll()), true);
				scrollbar = CurrentScrollbarGeometry();
			}
			scrollbar_drag_anchor_y_ = dip_point.y;
			scrollbar_drag_anchor_offset_ = scroll_offset_;
			return 0;
		}
		if (const auto action = HitTestMessageAction(point)) {
			if (action->action == MessageActionKind::Copy) {
				CopyRowToClipboard(action->row_id);
			} else if (edit_request_handler_) {
				edit_request_handler_(action->row_id);
			}
			return 0;
		}
		if (const auto process_item = HitTestProcessItemHeader(point)) {
			ToggleProcessItem(*process_item);
			return 0;
		}
		if (const auto row_id = HitTestExpandableHeader(point)) {
			ToggleExpandable(*row_id);
			return 0;
		}
		SetCapture(window_);
		selecting_ = true;
		if (const auto hit = HitTestText(point)) {
			if ((GetKeyState(VK_SHIFT) & 0x8000) == 0 || !selection_anchor_) {
				selection_anchor_ = hit;
			}
			selection_focus_ = hit;
			InvalidateRect(window_, nullptr, FALSE);
		}
		return 0;
	}
	case WM_MOUSEMOVE: {
		const POINT point{static_cast<short>(LOWORD(lparam)), static_cast<short>(HIWORD(lparam))};
		if (!mouse_tracking_) {
			TRACKMOUSEEVENT tracking{};
			tracking.cbSize = sizeof(tracking);
			tracking.dwFlags = TME_LEAVE;
			tracking.hwndTrack = window_;
			mouse_tracking_ = TrackMouseEvent(&tracking) != FALSE;
		}
		UpdateOverlayHover(point);
		UpdateMessageActionHover(point);
		if (scrollbar_dragging_ && (wparam & MK_LBUTTON) != 0) {
			const NativeTranscriptScrollbarGeometry scrollbar = CurrentScrollbarGeometry();
			const float travel = scrollbar.track.Height() - scrollbar.thumb.Height();
			if (scrollbar.scrollable && travel > 0.0F) {
				const float delta = PointToDip(point).y - scrollbar_drag_anchor_y_;
				const auto offset_delta = static_cast<std::int64_t>(
					std::llround(delta / travel * static_cast<float>(MaximumScroll())));
				ScrollTo(scrollbar_drag_anchor_offset_ + offset_delta, true);
			}
			return 0;
		}
		if (jump_button_pressed_) {
			return 0;
		}
		if (selecting_ && (wparam & MK_LBUTTON) != 0) {
			RECT client{};
			GetClientRect(window_, &client);
			if (point.y < 0) {
				ScrollBy(-kEstimatedLineScroll, true);
			} else if (point.y >= client.bottom) {
				ScrollBy(kEstimatedLineScroll, true);
			}
			if (const auto hit = HitTestText(point)) {
				selection_focus_ = hit;
				InvalidateRect(window_, nullptr, FALSE);
			}
			return 0;
		}
		break;
	}
	case WM_LBUTTONUP: {
		const POINT point{static_cast<short>(LOWORD(lparam)), static_cast<short>(HIWORD(lparam))};
		if (scrollbar_dragging_) {
			scrollbar_dragging_ = false;
			if (GetCapture() == window_) {
				ReleaseCapture();
			}
			ScheduleOverlayScrollbarHide();
			return 0;
		}
		if (jump_button_pressed_) {
			const D2D1_POINT_2F dip_point = PointToDip(point);
			const bool activate = JumpButtonVisible() && CurrentJumpButton().Contains(dip_point.x, dip_point.y);
			jump_button_pressed_ = false;
			if (GetCapture() == window_) {
				ReleaseCapture();
			}
			if (activate) {
				ScrollToBottom();
			}
			InvalidateRect(window_, nullptr, FALSE);
			return 0;
		}
		if (selecting_) {
			if (const auto hit = HitTestText(point)) {
				selection_focus_ = hit;
			}
			selecting_ = false;
			if (GetCapture() == window_) {
				ReleaseCapture();
			}
			InvalidateRect(window_, nullptr, FALSE);
		}
		return 0;
	}
	case WM_MOUSELEAVE:
		mouse_tracking_ = false;
		if (scrollbar_hovered_ || jump_button_hovered_ || hovered_message_action_) {
			scrollbar_hovered_ = false;
			jump_button_hovered_ = false;
			hovered_message_action_.reset();
			InvalidateRect(window_, nullptr, FALSE);
		}
		ScheduleOverlayScrollbarHide();
		return 0;
	case WM_SETCURSOR:
		if (LOWORD(lparam) == HTCLIENT) {
			POINT point{};
			if (GetCursorPos(&point) && ScreenToClient(window_, &point)) {
				const D2D1_POINT_2F dip_point = PointToDip(point);
				if (JumpButtonVisible() && CurrentJumpButton().Contains(dip_point.x, dip_point.y)) {
					SetCursor(LoadCursorW(nullptr, IDC_HAND));
					return TRUE;
				}
				const NativeTranscriptScrollbarGeometry scrollbar = CurrentScrollbarGeometry();
				if (scrollbar.scrollable && scrollbar.hit_area.Contains(dip_point.x, dip_point.y)) {
					SetCursor(LoadCursorW(nullptr, IDC_ARROW));
					return TRUE;
				}
				if (HitTestProcessItemHeader(point) || HitTestExpandableHeader(point)) {
					SetCursor(LoadCursorW(nullptr, IDC_HAND));
					return TRUE;
				}
				if (HitTestMessageAction(point)) {
					SetCursor(LoadCursorW(nullptr, IDC_HAND));
					return TRUE;
				}
			}
			SetCursor(LoadCursorW(nullptr, IDC_IBEAM));
			return TRUE;
		}
		break;
	case WM_LBUTTONDBLCLK: {
		const POINT point{static_cast<short>(LOWORD(lparam)), static_cast<short>(HIWORD(lparam))};
		if (HitTestMessageAction(point) || HitTestProcessItemHeader(point) || HitTestExpandableHeader(point)) {
			return 0;
		}
		if (const auto hit = HitTestText(point)) {
			SelectRow(*hit);
		}
		return 0;
	}
	case WM_CAPTURECHANGED:
		selecting_ = false;
		scrollbar_dragging_ = false;
		jump_button_pressed_ = false;
		ScheduleOverlayScrollbarHide();
		return 0;
	case WM_CONTEXTMENU: {
		POINT point{static_cast<short>(LOWORD(lparam)), static_cast<short>(HIWORD(lparam))};
		if (point.x == -1 && point.y == -1) {
			RECT client{};
			GetClientRect(window_, &client);
			point = {(client.left + client.right) / 2, (client.top + client.bottom) / 2};
			ClientToScreen(window_, &point);
		}
		ShowContextMenu(point);
		return 0;
	}
	case WM_GETDLGCODE:
		return DLGC_WANTARROWS | DLGC_WANTCHARS;
	case WM_NCDESTROY:
		KillTimer(window_, kScrollbarHideTimer);
		KillTimer(window_, kMessageCopyFeedbackTimer);
		SetWindowLongPtrW(window_, GWLP_USERDATA, 0);
		window_ = nullptr;
		return 0;
	default:
		break;
	}
	return DefWindowProcW(window_, message, wparam, lparam);
}

bool NativeTranscriptView::RegisterWindowClass(HINSTANCE instance) const {
	WNDCLASSEXW window_class{};
	window_class.cbSize = sizeof(window_class);
	window_class.style = CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS;
	window_class.lpfnWndProc = WindowProcedure;
	window_class.hInstance = instance;
	window_class.hCursor = LoadCursorW(nullptr, IDC_IBEAM);
	window_class.hbrBackground = nullptr;
	window_class.lpszClassName = kTranscriptWindowClass;
	return RegisterClassExW(&window_class) != 0 || GetLastError() == ERROR_CLASS_ALREADY_EXISTS;
}

HRESULT NativeTranscriptView::EnsureDeviceResources() {
	if (render_target_ != nullptr) {
		return S_OK;
	}
	if (window_ == nullptr || d2d_factory_ == nullptr) {
		return E_UNEXPECTED;
	}

	RECT client{};
	GetClientRect(window_, &client);
	const UINT width = static_cast<UINT>(std::max(1L, client.right - client.left));
	const UINT height = static_cast<UINT>(std::max(1L, client.bottom - client.top));
	const float dpi = static_cast<float>(GetDpiForWindow(window_));
	const NativeTranscriptPalette palette = NativeTranscriptPaletteFor(dark_theme_);
	HRESULT result = d2d_factory_->CreateHwndRenderTarget(
		D2D1::RenderTargetProperties(
			D2D1_RENDER_TARGET_TYPE_DEFAULT, D2D1::PixelFormat(), dpi, dpi, D2D1_RENDER_TARGET_USAGE_NONE),
		D2D1::HwndRenderTargetProperties(window_, D2D1::SizeU(width, height), D2D1_PRESENT_OPTIONS_NONE),
		render_target_.ReleaseAndGetAddressOf());
	if (SUCCEEDED(result)) {
		result = render_target_->CreateSolidColorBrush(Color(palette.primary), primary_brush_.ReleaseAndGetAddressOf());
	}
	if (SUCCEEDED(result)) {
		result = render_target_->CreateSolidColorBrush(Color(palette.muted), muted_brush_.ReleaseAndGetAddressOf());
	}
	if (SUCCEEDED(result)) {
		result = render_target_->CreateSolidColorBrush(Color(palette.user), user_brush_.ReleaseAndGetAddressOf());
	}
	if (SUCCEEDED(result)) {
		result = render_target_->CreateSolidColorBrush(
			Color(palette.user_foreground), user_foreground_brush_.ReleaseAndGetAddressOf());
	}
	if (SUCCEEDED(result)) {
		result = render_target_->CreateSolidColorBrush(
			Color(palette.assistant), assistant_brush_.ReleaseAndGetAddressOf());
	}
	if (SUCCEEDED(result)) {
		result = render_target_->CreateSolidColorBrush(Color(palette.line), line_brush_.ReleaseAndGetAddressOf());
	}
	if (SUCCEEDED(result)) {
		result = render_target_->CreateSolidColorBrush(Color(palette.selection), selection_brush_.ReleaseAndGetAddressOf());
	}
	if (SUCCEEDED(result)) {
		result = render_target_->CreateSolidColorBrush(Color(palette.scrollbar), scrollbar_brush_.ReleaseAndGetAddressOf());
	}
	if (SUCCEEDED(result)) {
		result = render_target_->CreateSolidColorBrush(Color(palette.scrollbar_hot), scrollbar_hot_brush_.ReleaseAndGetAddressOf());
	}
	if (SUCCEEDED(result)) {
		result = render_target_->CreateSolidColorBrush(Color(palette.jump_button), jump_button_brush_.ReleaseAndGetAddressOf());
	}
	if (SUCCEEDED(result)) {
		result = render_target_->CreateSolidColorBrush(Color(palette.jump_button_hot), jump_button_hot_brush_.ReleaseAndGetAddressOf());
	}
	if (SUCCEEDED(result)) {
		result = render_target_->CreateSolidColorBrush(
			Color(palette.jump_button_border), jump_button_border_brush_.ReleaseAndGetAddressOf());
	}
	if (SUCCEEDED(result)) {
		result = render_target_->CreateSolidColorBrush(
			Color(palette.jump_button_shadow), jump_button_shadow_brush_.ReleaseAndGetAddressOf());
	}
	if (SUCCEEDED(result)) {
		result = render_target_->CreateSolidColorBrush(
			Color(palette.background.rgb, 0.88F), drop_overlay_brush_.ReleaseAndGetAddressOf());
	}
	if (SUCCEEDED(result)) {
		result = render_target_->CreateSolidColorBrush(
			Color(palette.accent), drop_accent_brush_.ReleaseAndGetAddressOf());
	}
	if (FAILED(result)) {
		DiscardDeviceResources();
	}
	return result;
}

void NativeTranscriptView::DiscardDeviceResources() {
	for (auto& [id, media] : media_cache_) {
		static_cast<void>(id);
		media.bitmap.Reset();
	}
	jump_button_shadow_brush_.Reset();
	drop_accent_brush_.Reset();
	drop_overlay_brush_.Reset();
	jump_button_border_brush_.Reset();
	jump_button_hot_brush_.Reset();
	jump_button_brush_.Reset();
	scrollbar_hot_brush_.Reset();
	scrollbar_brush_.Reset();
	selection_brush_.Reset();
	line_brush_.Reset();
	assistant_brush_.Reset();
	user_foreground_brush_.Reset();
	user_brush_.Reset();
	muted_brush_.Reset();
	primary_brush_.Reset();
	render_target_.Reset();
}

void NativeTranscriptView::Paint() {
	PAINTSTRUCT paint{};
	BeginPaint(window_, &paint);
	if (SUCCEEDED(EnsureDeviceResources())) {
		const NativeTranscriptPalette palette = NativeTranscriptPaletteFor(dark_theme_);
		const D2D1_SIZE_F size = render_target_->GetSize();
		StabilizeVisibleLayout(size.width, size.height);
		render_target_->BeginDraw();
		render_target_->SetTransform(D2D1::Matrix3x2F::Identity());
		render_target_->Clear(Color(palette.background));
		layout_changed_during_paint_ = false;
		const auto range = model_.VisibleRange(
			scroll_offset_, static_cast<std::int64_t>(std::ceil(size.height)), kOverscan);
		for (std::size_t index = range.first; index < range.last; ++index) {
			DrawRow(index, size.width);
		}
		TrimLayoutCache(range);
		DrawOverlayControls(size.width, size.height);
		DrawFileDropOverlay(size.width, size.height);
		const HRESULT result = render_target_->EndDraw();
		if (result == D2DERR_RECREATE_TARGET) {
			DiscardDeviceResources();
		} else if (layout_changed_during_paint_) {
			if (stick_to_bottom_) {
				scroll_offset_ = MaximumScroll();
			} else {
				scroll_offset_ = std::min(scroll_offset_, MaximumScroll());
			}
			UpdateScrollInfo();
			InvalidateRect(window_, nullptr, FALSE);
		}
	}
	EndPaint(window_, &paint);
}

bool NativeTranscriptView::MeasureRowHeight(std::size_t index, float viewport_width) {
	if (index >= model_.Size()) return false;
	const NativeTranscriptRow& row = model_.RowAt(index);
	const bool user = row.kind == NativeTranscriptRowKind::User;
	const bool message = user || row.kind == NativeTranscriptRowKind::Assistant ||
		row.kind == NativeTranscriptRowKind::Plan;
	const bool collapsed_expandable = IsCollapsedExpandable(row);
	const bool structured_process =
		row.kind == NativeTranscriptRowKind::Reasoning && !row.process_items.empty() && !collapsed_expandable;

	std::int32_t measured_height = row.height;
	if (collapsed_expandable) {
		measured_height = kCollapsedExpandableHeight;
	} else if (structured_process) {
		float structured_height = 2.0F * kRowVerticalPadding + kLabelHeight + kTextGap;
		for (const NativeTranscriptProcessItem& item : row.process_items) {
			structured_height += kProcessItemHeaderHeight + kProcessItemGap;
			if (expanded_process_items_.contains(ProcessItemKey(row, item))) {
				structured_height += kProcessDetailGap + kProcessDetailHeight;
			}
		}
		measured_height = static_cast<std::int32_t>(std::ceil(structured_height));
	} else {
		const float horizontal_padding = NativeTranscriptOuterHorizontalPadding(viewport_width) + kRowContentInset;
		const float available_width = std::max(80.0F, viewport_width - 2.0F * horizontal_padding);
		const float layout_width = message ? NativeTranscriptBubbleMaxContentWidth(viewport_width, user) : available_width;
		TextLayout* layout = GetTextLayout(row, layout_width);
		if (layout == nullptr) return false;
		if (message) {
			measured_height = static_cast<std::int32_t>(ComputeNativeTranscriptBubbleLayout(viewport_width,
				user,
				layout->measured_width,
				layout->measured_height,
				row.media_ids.size(),
				!row.time_label.empty())
				.row_height);
		} else {
			measured_height = static_cast<std::int32_t>(std::ceil(
				layout->measured_height + 2.0F * kRowVerticalPadding + kLabelHeight + kTextGap +
				static_cast<float>(row.media_ids.size()) * (kThumbnailHeight + kMediaGap)));
		}
	}

	if (row.height == measured_height) return false;
	static_cast<void>(model_.UpdateHeight(row.id, measured_height));
	return true;
}

void NativeTranscriptView::StabilizeVisibleLayout(float viewport_width, float viewport_height) {
	if (!stick_to_bottom_ || model_.Empty() || viewport_width < 1.0F || viewport_height < 1.0F) return;
	constexpr int kMaximumLayoutPasses = 12;
	const std::int64_t height = static_cast<std::int64_t>(std::ceil(viewport_height));
	for (int pass = 0; pass < kMaximumLayoutPasses; ++pass) {
		scroll_offset_ = std::max<std::int64_t>(0, model_.TotalHeight() - height);
		const NativeTranscriptVisibleRange range = model_.VisibleRange(scroll_offset_, height, kOverscan);
		bool changed = false;
		for (std::size_t index = range.first; index < range.last; ++index) {
			changed = MeasureRowHeight(index, viewport_width) || changed;
		}
		if (!changed) break;
	}
	scroll_offset_ = std::max<std::int64_t>(0, model_.TotalHeight() - height);
	UpdateScrollInfo();
}

void NativeTranscriptView::StabilizeCurrentViewport() {
	if (window_ == nullptr) return;
	RECT client{};
	GetClientRect(window_, &client);
	const float scale = DpiScale();
	StabilizeVisibleLayout(
		static_cast<float>(std::max(0L, client.right - client.left)) / scale,
		static_cast<float>(std::max(0L, client.bottom - client.top)) / scale);
}

void NativeTranscriptView::SetFileDragActive(bool active) {
	if (file_drag_active_ == active) return;
	file_drag_active_ = active;
	if (window_ != nullptr) InvalidateRect(window_, nullptr, FALSE);
}

void NativeTranscriptView::DrawFileDropOverlay(float viewport_width, float viewport_height) {
	if (!file_drag_active_ || drop_overlay_brush_ == nullptr || drop_accent_brush_ == nullptr ||
		drop_hint_format_ == nullptr || viewport_width < 48.0F || viewport_height < 48.0F) {
		return;
	}
	constexpr float inset = 16.0F;
	const D2D1_RECT_F bounds =
		D2D1::RectF(inset, 10.0F, viewport_width - inset, viewport_height - 2.0F);
	const D2D1_ROUNDED_RECT surface = D2D1::RoundedRect(bounds, 10.0F, 10.0F);
	render_target_->FillRoundedRectangle(surface, drop_overlay_brush_.Get());
	render_target_->DrawRoundedRectangle(surface, drop_accent_brush_.Get(), 1.5F);
	constexpr std::wstring_view hint = L"松开以引用本机文件";
	render_target_->DrawTextW(
		hint.data(),
		static_cast<UINT32>(hint.size()),
		drop_hint_format_.Get(),
		D2D1::RectF(bounds.left + 20.0F, bounds.top, bounds.right - 20.0F, bounds.bottom),
		drop_accent_brush_.Get(),
		D2D1_DRAW_TEXT_OPTIONS_CLIP);
}

void NativeTranscriptView::DrawRow(std::size_t index, float viewport_width) {
	const NativeTranscriptRow& row = model_.RowAt(index);
	const bool user = row.kind == NativeTranscriptRowKind::User;
	const bool message = user || row.kind == NativeTranscriptRowKind::Assistant ||
		row.kind == NativeTranscriptRowKind::Plan;
	const bool collapsed_expandable = IsCollapsedExpandable(row);
	const float horizontal_padding = NativeTranscriptOuterHorizontalPadding(viewport_width) + kRowContentInset;
	const float available_width = std::max(80.0F, viewport_width - 2.0F * horizontal_padding);
	const float layout_width = message ? NativeTranscriptBubbleMaxContentWidth(viewport_width, user) : available_width;
	const bool structured_process =
		row.kind == NativeTranscriptRowKind::Reasoning && !row.process_items.empty() && !collapsed_expandable;
	TextLayout* cached = collapsed_expandable || structured_process ? nullptr : GetTextLayout(row, layout_width);
	if (!collapsed_expandable && !structured_process && cached == nullptr) {
		return;
	}

	NativeTranscriptBubbleLayout bubble_layout{};
	if (message) {
		bubble_layout = ComputeNativeTranscriptBubbleLayout(viewport_width,
			user,
			cached->measured_width,
			cached->measured_height,
			row.media_ids.size(),
			!row.time_label.empty());
	}
	float structured_height = 2.0F * kRowVerticalPadding + kLabelHeight + kTextGap;
	if (structured_process) {
		for (const NativeTranscriptProcessItem& item : row.process_items) {
			structured_height += kProcessItemHeaderHeight + kProcessItemGap;
			if (expanded_process_items_.contains(ProcessItemKey(row, item))) {
				structured_height += kProcessDetailGap + kProcessDetailHeight;
			}
		}
	}
	const std::int32_t measured_height = static_cast<std::int32_t>(
		collapsed_expandable
			? kCollapsedExpandableHeight
			: structured_process
				? std::ceil(structured_height)
			: message
				? bubble_layout.row_height
				: std::ceil(
				  cached->measured_height + 2.0F * kRowVerticalPadding + kLabelHeight + kTextGap +
				  static_cast<float>(row.media_ids.size()) * (kThumbnailHeight + kMediaGap)));
	if (row.height != measured_height) {
		static_cast<void>(model_.UpdateHeight(row.id, measured_height));
		layout_changed_during_paint_ = true;
	}
	const float row_top = static_cast<float>(model_.RowTop(index) - scroll_offset_);
	const float row_height = static_cast<float>(model_.RowAt(index).height);
	const float content_left = message ? bubble_layout.content_left : horizontal_padding;
	const float content_width = message ? bubble_layout.content_width : available_width;

	if (message) {
		const D2D1_ROUNDED_RECT bubble = D2D1::RoundedRect(
			D2D1::RectF(
				bubble_layout.bubble.left,
				row_top + bubble_layout.bubble.top,
				bubble_layout.bubble.right,
				row_top + bubble_layout.bubble.bottom),
			11.0F,
			11.0F);
		render_target_->FillRoundedRectangle(bubble, user ? user_brush_.Get() : assistant_brush_.Get());
	}

	if (!message) {
		const std::wstring_view row_label = RowLabel(row.kind);
		std::wstring dynamic_label;
		std::wstring_view label = row_label;
		if (row.kind == NativeTranscriptRowKind::Reasoning) {
			const bool expandable = HasFlag(row.flags, NativeTranscriptRowFlags::Expandable);
			dynamic_label = NativeTranscriptReasoningLabel(
				row.duration_ms,
				expandable,
				expandable && !collapsed_expandable,
				HasFlag(row.flags, NativeTranscriptRowFlags::Streaming));
			label = dynamic_label;
		} else if (row.kind == NativeTranscriptRowKind::Tool && collapsed_expandable) {
			const std::size_t line_end = row.text.find('\n');
			dynamic_label = Utf8ToWide(row.text.substr(0, line_end));
			dynamic_label.append(HasFlag(row.flags, NativeTranscriptRowFlags::Streaming) ? L"  …" : L"  ▸");
			label = dynamic_label;
		} else if (row.kind == NativeTranscriptRowKind::Tool &&
			HasFlag(row.flags, NativeTranscriptRowFlags::Expandable)) {
			dynamic_label = L"操作  ▾";
			label = dynamic_label;
		}
		const D2D1_RECT_F label_rect = D2D1::RectF(
			content_left,
			row_top + kRowVerticalPadding,
			content_left + content_width,
			row_top + kRowVerticalPadding + kLabelHeight);
		render_target_->DrawTextW(
			label.data(),
			static_cast<UINT32>(label.size()),
			label_format_.Get(),
			label_rect,
			row.kind == NativeTranscriptRowKind::Error ? primary_brush_.Get() : muted_brush_.Get(),
			D2D1_DRAW_TEXT_OPTIONS_CLIP);
	}

	if (cached != nullptr) {
		const float text_top = message
			? row_top + bubble_layout.text_top
			: row_top + kRowVerticalPadding + kLabelHeight + kTextGap;
		const D2D1_POINT_2F origin = D2D1::Point2F(content_left, text_top);
		DrawSelection(index, *cached, origin.x, origin.y);
		render_target_->DrawTextLayout(origin,
			cached->layout.Get(),
			user ? user_foreground_brush_.Get() : primary_brush_.Get(),
			D2D1_DRAW_TEXT_OPTIONS_CLIP);
		DrawMedia(row, content_left, origin.y + cached->measured_height + kMediaGap, content_width);
	}
	if (message && !row.time_label.empty()) {
		DrawMessageActions(row, bubble_layout, row_top);
	}
	if (structured_process) {
		float item_top = row_top + kRowVerticalPadding + kLabelHeight + kTextGap;
		for (const NativeTranscriptProcessItem& item : row.process_items) {
			const std::string item_key = ProcessItemKey(row, item);
			const bool item_expanded = expanded_process_items_.contains(item_key);
			const D2D1_ROUNDED_RECT header_box = D2D1::RoundedRect(
				D2D1::RectF(content_left, item_top, content_left + content_width, item_top + kProcessItemHeaderHeight),
				6.0F,
				6.0F);
			render_target_->FillRoundedRectangle(header_box, assistant_brush_.Get());
			std::wstring summary = Utf8ToWide(item.summary);
			summary.append(item_expanded ? L"  ▾" : L"  ▸");
			render_target_->DrawTextW(
				summary.data(),
				static_cast<UINT32>(summary.size()),
				label_format_.Get(),
				D2D1::RectF(
					content_left + 9.0F,
					item_top + 6.0F,
					content_left + content_width - 9.0F,
					item_top + kProcessItemHeaderHeight - 5.0F),
				item.failed ? primary_brush_.Get() : muted_brush_.Get(),
				D2D1_DRAW_TEXT_OPTIONS_CLIP);
			item_top += kProcessItemHeaderHeight;
			if (item_expanded) {
				item_top += kProcessDetailGap;
				const D2D1_RECT_F detail_box = D2D1::RectF(
					content_left + 8.0F,
					item_top,
					content_left + content_width - 8.0F,
					item_top + kProcessDetailHeight);
				render_target_->FillRoundedRectangle(D2D1::RoundedRect(detail_box, 7.0F, 7.0F), assistant_brush_.Get());
				render_target_->DrawRoundedRectangle(
					D2D1::RoundedRect(detail_box, 7.0F, 7.0F), line_brush_.Get(), 1.0F);
				NativeTranscriptRow detail_row;
				detail_row.id = item_key;
				detail_row.text = item.detail;
				const float detail_text_width = std::max(
					40.0F, detail_box.right - detail_box.left - 2.0F * kProcessDetailPadding - 6.0F);
				if (TextLayout* detail_layout = GetTextLayout(detail_row, detail_text_width)) {
					const float detail_view_height = kProcessDetailHeight - 2.0F * kProcessDetailPadding;
					const float maximum_detail_scroll =
						std::max(0.0F, detail_layout->measured_height - detail_view_height);
					float& detail_scroll = process_detail_scroll_offsets_[item_key];
					detail_scroll = std::clamp(detail_scroll, 0.0F, maximum_detail_scroll);
					const D2D1_RECT_F detail_clip = D2D1::RectF(
						detail_box.left + kProcessDetailPadding,
						detail_box.top + kProcessDetailPadding,
						detail_box.right - kProcessDetailPadding - 6.0F,
						detail_box.bottom - kProcessDetailPadding);
					render_target_->PushAxisAlignedClip(detail_clip, D2D1_ANTIALIAS_MODE_PER_PRIMITIVE);
					render_target_->DrawTextLayout(
						D2D1::Point2F(detail_clip.left, detail_clip.top - detail_scroll),
						detail_layout->layout.Get(),
						item.failed ? primary_brush_.Get() : muted_brush_.Get(),
						D2D1_DRAW_TEXT_OPTIONS_CLIP);
					render_target_->PopAxisAlignedClip();
					if (maximum_detail_scroll > 0.0F) {
						const float track_height = detail_clip.bottom - detail_clip.top;
						const float thumb_height = std::max(
							18.0F, track_height * detail_view_height / detail_layout->measured_height);
						const float thumb_top = detail_clip.top +
							(track_height - thumb_height) * detail_scroll / maximum_detail_scroll;
						render_target_->FillRoundedRectangle(
							D2D1::RoundedRect(
								D2D1::RectF(
									detail_box.right - 6.0F,
									thumb_top,
									detail_box.right - 3.0F,
									thumb_top + thumb_height),
								1.5F,
								1.5F),
							scrollbar_brush_.Get());
					}
				}
				item_top += kProcessDetailHeight;
			}
			item_top += kProcessItemGap;
		}
	}
	if (!message) {
		render_target_->DrawLine(
			D2D1::Point2F(horizontal_padding, row_top + row_height - 1.0F),
			D2D1::Point2F(viewport_width - horizontal_padding, row_top + row_height - 1.0F),
			line_brush_.Get(),
			1.0F);
	}
}

void NativeTranscriptView::DrawMessageActions(
	const NativeTranscriptRow& row,
	const NativeTranscriptBubbleLayout& bubble_layout,
	float row_top) {
	const bool user = row.kind == NativeTranscriptRowKind::User;
	NativeTranscriptMessageActionsLayout actions =
		ComputeNativeTranscriptMessageActionsLayout(bubble_layout, user, row.can_edit);
	const auto offset = [row_top](NativeTranscriptRectF& rect) {
		rect.top += row_top;
		rect.bottom += row_top;
	};
	offset(actions.time);
	offset(actions.copy);
	if (actions.has_edit) offset(actions.edit);

	const auto is_hovered = [this, &row](MessageActionKind action) {
		return hovered_message_action_ && hovered_message_action_->row_id == row.id &&
			hovered_message_action_->action == action;
	};
	const auto draw_hover = [this](const NativeTranscriptRectF& rect) {
		render_target_->FillRoundedRectangle(D2D1::RoundedRect(ToD2DRect(rect), 5.0F, 5.0F), assistant_brush_.Get());
	};
	if (is_hovered(MessageActionKind::Copy)) draw_hover(actions.copy);
	if (actions.has_edit && is_hovered(MessageActionKind::Edit)) draw_hover(actions.edit);

	const std::wstring time = Utf8ToWide(row.time_label);
	render_target_->DrawTextW(
		time.data(),
		static_cast<UINT32>(time.size()),
		label_format_.Get(),
		ToD2DRect(actions.time),
		muted_brush_.Get(),
		D2D1_DRAW_TEXT_OPTIONS_CLIP);

	ID2D1SolidColorBrush* copy_brush = is_hovered(MessageActionKind::Copy) ? primary_brush_.Get() : muted_brush_.Get();
	const float copy_left = actions.copy.left + 7.0F;
	const float copy_top = actions.copy.top + 6.0F;
	if (copied_row_id_ == row.id) {
		render_target_->DrawLine(
			D2D1::Point2F(copy_left, copy_top + 6.0F),
			D2D1::Point2F(copy_left + 3.0F, copy_top + 9.0F),
			copy_brush,
			1.7F);
		render_target_->DrawLine(
			D2D1::Point2F(copy_left + 3.0F, copy_top + 9.0F),
			D2D1::Point2F(copy_left + 10.0F, copy_top + 1.0F),
			copy_brush,
			1.7F);
	} else {
		render_target_->DrawRoundedRectangle(
			D2D1::RoundedRect(D2D1::RectF(copy_left + 3.0F, copy_top, copy_left + 11.0F, copy_top + 10.0F), 2.0F, 2.0F),
			copy_brush,
			1.4F);
		render_target_->DrawRoundedRectangle(
			D2D1::RoundedRect(D2D1::RectF(copy_left, copy_top + 3.0F, copy_left + 8.0F, copy_top + 13.0F), 2.0F, 2.0F),
			copy_brush,
			1.4F);
	}

	if (actions.has_edit) {
		ID2D1SolidColorBrush* edit_brush =
			is_hovered(MessageActionKind::Edit) ? primary_brush_.Get() : muted_brush_.Get();
		const float left = actions.edit.left + 6.0F;
		const float top = actions.edit.top + 6.0F;
		render_target_->DrawLine(
			D2D1::Point2F(left + 1.0F, top + 10.0F),
			D2D1::Point2F(left + 10.0F, top + 1.0F),
			edit_brush,
			2.0F);
		render_target_->DrawLine(
			D2D1::Point2F(left, top + 13.0F),
			D2D1::Point2F(left + 4.0F, top + 12.0F),
			edit_brush,
			1.5F);
		render_target_->DrawLine(
			D2D1::Point2F(left + 9.0F, top + 1.0F),
			D2D1::Point2F(left + 12.0F, top + 4.0F),
			edit_brush,
			1.5F);
	}
}

void NativeTranscriptView::DrawOverlayControls(float viewport_width, float viewport_height) {
	const NativeTranscriptScrollbarGeometry scrollbar = ComputeNativeTranscriptScrollbar(
		viewport_width, viewport_height, model_.TotalHeight(), scroll_offset_);
	if (scrollbar.scrollable && (overlay_scrollbar_visible_ || scrollbar_hovered_ || scrollbar_dragging_)) {
		NativeTranscriptRectF thumb = scrollbar.thumb;
		ID2D1SolidColorBrush* brush = scrollbar_brush_.Get();
		if (scrollbar_hovered_ || scrollbar_dragging_) {
			const float center = (thumb.left + thumb.right) / 2.0F;
			thumb.left = center - kScrollbarHotWidth / 2.0F;
			thumb.right = center + kScrollbarHotWidth / 2.0F;
			brush = scrollbar_hot_brush_.Get();
		}
		const float radius = std::max(1.5F, thumb.Width() / 2.0F);
		render_target_->FillRoundedRectangle(D2D1::RoundedRect(ToD2DRect(thumb), radius, radius), brush);
	}

	if (!ShouldShowNativeTranscriptJumpButton(
			model_.TotalHeight(), static_cast<std::int64_t>(std::floor(viewport_height)), scroll_offset_)) {
		return;
	}
	const NativeTranscriptRectF button = ComputeNativeTranscriptJumpButton(viewport_width, viewport_height);
	if (button.Width() <= 0.0F || button.Height() <= 0.0F) {
		return;
	}
	const float radius = button.Width() / 2.0F;
	const D2D1_POINT_2F center = D2D1::Point2F(
		(button.left + button.right) / 2.0F,
		(button.top + button.bottom) / 2.0F + (jump_button_pressed_ ? 1.0F : 0.0F));
	const D2D1_ELLIPSE shadow = D2D1::Ellipse(D2D1::Point2F(center.x, center.y + 2.0F), radius + 1.0F, radius + 1.0F);
	render_target_->FillEllipse(shadow, jump_button_shadow_brush_.Get());
	const D2D1_ELLIPSE face = D2D1::Ellipse(center, radius, radius);
	render_target_->FillEllipse(
		face, jump_button_hovered_ ? jump_button_hot_brush_.Get() : jump_button_brush_.Get());
	render_target_->DrawEllipse(face, jump_button_border_brush_.Get(), 1.0F);

	const float arrow_top = center.y - 5.0F;
	const float arrow_bottom = center.y + 5.0F;
	render_target_->DrawLine(
		D2D1::Point2F(center.x, arrow_top),
		D2D1::Point2F(center.x, arrow_bottom),
		primary_brush_.Get(),
		1.6F);
	render_target_->DrawLine(
		D2D1::Point2F(center.x - 4.5F, center.y + 1.0F),
		D2D1::Point2F(center.x, arrow_bottom),
		primary_brush_.Get(),
		1.6F);
	render_target_->DrawLine(
		D2D1::Point2F(center.x + 4.5F, center.y + 1.0F),
		D2D1::Point2F(center.x, arrow_bottom),
		primary_brush_.Get(),
		1.6F);
}

void NativeTranscriptView::DrawMedia(const NativeTranscriptRow& row, float left, float top, float width) {
	for (const std::string& image_id : row.media_ids) {
		RequestMedia(image_id);
		ID2D1Bitmap* bitmap = GetMediaBitmap(image_id);
		const D2D1_RECT_F slot = D2D1::RectF(left, top, left + width, top + kThumbnailHeight);
		if (bitmap != nullptr) {
			const D2D1_SIZE_F image_size = bitmap->GetSize();
			if (image_size.width > 0.0F && image_size.height > 0.0F) {
				const float scale = std::min(width / image_size.width, kThumbnailHeight / image_size.height);
				const float draw_width = image_size.width * scale;
				const float draw_height = image_size.height * scale;
				const D2D1_RECT_F destination = D2D1::RectF(
					left,
					top,
					left + draw_width,
					top + draw_height);
				render_target_->DrawBitmap(
					bitmap, &destination, 1.0F, D2D1_BITMAP_INTERPOLATION_MODE_LINEAR, nullptr);
			}
		} else {
			ID2D1SolidColorBrush* placeholder =
				row.kind == NativeTranscriptRowKind::User ? user_brush_.Get() : assistant_brush_.Get();
			render_target_->FillRoundedRectangle(D2D1::RoundedRect(slot, 8.0F, 8.0F), placeholder);
			const auto found = media_cache_.find(image_id);
			const bool failed = found != media_cache_.end() && found->second.failed;
			const wchar_t* label = failed ? L"图片不可用" : L"图片加载中…";
			const UINT32 label_length = failed ? 5U : 6U;
			render_target_->DrawTextW(
				label,
				label_length,
				label_format_.Get(),
				D2D1::RectF(left + 12.0F, top + 12.0F, left + width - 12.0F, top + 36.0F),
				row.kind == NativeTranscriptRowKind::User ? user_foreground_brush_.Get() : muted_brush_.Get());
		}
		top += kThumbnailHeight + kMediaGap;
	}
}

ID2D1Bitmap* NativeTranscriptView::GetMediaBitmap(std::string_view image_id) {
	const auto found = media_cache_.find(std::string(image_id));
	if (found == media_cache_.end() || found->second.failed || found->second.encoded_bytes.empty()) {
		return nullptr;
	}
	MediaEntry& entry = found->second;
	entry.last_use = ++media_use_clock_;
	if (entry.bitmap != nullptr) {
		return entry.bitmap.Get();
	}
	if (wic_factory_ == nullptr || render_target_ == nullptr ||
		entry.encoded_bytes.size() > std::numeric_limits<DWORD>::max()) {
		return nullptr;
	}

	Microsoft::WRL::ComPtr<IWICStream> stream;
	Microsoft::WRL::ComPtr<IWICBitmapDecoder> decoder;
	Microsoft::WRL::ComPtr<IWICBitmapFrameDecode> frame;
	Microsoft::WRL::ComPtr<IWICFormatConverter> converter;
	HRESULT result = wic_factory_->CreateStream(stream.ReleaseAndGetAddressOf());
	if (SUCCEEDED(result)) {
		result = stream->InitializeFromMemory(
			entry.encoded_bytes.data(), static_cast<DWORD>(entry.encoded_bytes.size()));
	}
	if (SUCCEEDED(result)) {
		result = wic_factory_->CreateDecoderFromStream(
			stream.Get(), nullptr, WICDecodeMetadataCacheOnLoad, decoder.ReleaseAndGetAddressOf());
	}
	if (SUCCEEDED(result)) {
		result = decoder->GetFrame(0, frame.ReleaseAndGetAddressOf());
	}
	if (SUCCEEDED(result)) {
		result = wic_factory_->CreateFormatConverter(converter.ReleaseAndGetAddressOf());
	}
	if (SUCCEEDED(result)) {
		result = converter->Initialize(
			frame.Get(),
			GUID_WICPixelFormat32bppPBGRA,
			WICBitmapDitherTypeNone,
			nullptr,
			0.0,
			WICBitmapPaletteTypeMedianCut);
	}
	if (SUCCEEDED(result)) {
		result = render_target_->CreateBitmapFromWicBitmap(
			converter.Get(), nullptr, entry.bitmap.ReleaseAndGetAddressOf());
	}
	if (FAILED(result)) {
		entry.bitmap.Reset();
		entry.encoded_bytes.clear();
		entry.failed = true;
		return nullptr;
	}
	return entry.bitmap.Get();
}

void NativeTranscriptView::RequestMedia(std::string_view image_id) {
	if (image_id.empty() || media_cache_.contains(std::string(image_id)) ||
		requested_media_.contains(std::string(image_id)) || !image_request_handler_) {
		return;
	}
	const std::string owned(image_id);
	requested_media_.insert(owned);
	image_request_handler_(owned);
}

void NativeTranscriptView::TrimMediaCache() {
	std::size_t total_bytes = 0;
	for (const auto& [id, entry] : media_cache_) {
		static_cast<void>(id);
		total_bytes += entry.encoded_bytes.size();
	}
	while (media_cache_.size() > kMaximumCachedMedia || total_bytes > kMaximumMediaBytes) {
		const auto oldest = std::min_element(
			media_cache_.begin(),
			media_cache_.end(),
			[](const auto& left, const auto& right) { return left.second.last_use < right.second.last_use; });
		if (oldest == media_cache_.end()) {
			break;
		}
		total_bytes -= oldest->second.encoded_bytes.size();
		requested_media_.erase(oldest->first);
		media_cache_.erase(oldest);
	}
}

void NativeTranscriptView::DrawSelection(
	std::size_t index,
	const TextLayout& layout,
	float origin_x,
	float origin_y) {
	if (selection_brush_ == nullptr || layout.layout == nullptr) {
		return;
	}
	const auto selection = NormalizedSelection();
	if (!selection || index < selection->first_index || index > selection->last_index) {
		return;
	}
	const auto text_size = static_cast<std::uint32_t>(
		std::min<std::size_t>(layout.text.size(), std::numeric_limits<std::uint32_t>::max()));
	const std::uint32_t start =
		index == selection->first_index ? std::min(selection->first_position, text_size) : 0;
	const std::uint32_t end =
		index == selection->last_index ? std::min(selection->last_position, text_size) : text_size;
	if (end <= start) {
		return;
	}

	UINT32 metric_count = 0;
	static_cast<void>(layout.layout->HitTestTextRange(
		start, end - start, origin_x, origin_y, nullptr, 0, &metric_count));
	if (metric_count == 0) {
		return;
	}
	std::vector<DWRITE_HIT_TEST_METRICS> metrics(metric_count);
	if (FAILED(layout.layout->HitTestTextRange(
			start, end - start, origin_x, origin_y, metrics.data(), metric_count, &metric_count))) {
		return;
	}
	for (UINT32 metric_index = 0; metric_index < metric_count; ++metric_index) {
		const DWRITE_HIT_TEST_METRICS& metric = metrics[metric_index];
		render_target_->FillRectangle(
			D2D1::RectF(metric.left, metric.top, metric.left + metric.width, metric.top + metric.height),
			selection_brush_.Get());
	}
}

bool NativeTranscriptView::IsCollapsedExpandable(const NativeTranscriptRow& row) const {
	const bool supported = row.kind == NativeTranscriptRowKind::Reasoning ||
		row.kind == NativeTranscriptRowKind::Tool;
	return supported && HasFlag(row.flags, NativeTranscriptRowFlags::Expandable) &&
		!HasFlag(row.flags, NativeTranscriptRowFlags::Expanded) && !expanded_rows_.contains(row.id);
}

std::optional<std::string> NativeTranscriptView::HitTestExpandableHeader(POINT point) const {
	if (model_.Empty() || window_ == nullptr) {
		return std::nullopt;
	}
	RECT client{};
	GetClientRect(window_, &client);
	if (client.right <= client.left || client.bottom <= client.top) {
		return std::nullopt;
	}
	const float scale = std::max(0.01F, DpiScale());
	const float x = static_cast<float>(point.x) / scale;
	const float y = static_cast<float>(point.y) / scale;
	const float viewport_width = static_cast<float>(client.right - client.left) / scale;
	const float horizontal_padding = NativeTranscriptOuterHorizontalPadding(viewport_width) + kRowContentInset;
	if (x < horizontal_padding || x > viewport_width - horizontal_padding) {
		return std::nullopt;
	}
	const std::int64_t content_y = scroll_offset_ + static_cast<std::int64_t>(std::floor(y));
	const NativeTranscriptVisibleRange range = model_.VisibleRange(content_y, 1);
	if (range.Empty() || range.first >= model_.Size()) {
		return std::nullopt;
	}
	const NativeTranscriptRow& row = model_.RowAt(range.first);
	if ((row.kind != NativeTranscriptRowKind::Reasoning && row.kind != NativeTranscriptRowKind::Tool) ||
		!HasFlag(row.flags, NativeTranscriptRowFlags::Expandable)) {
		return std::nullopt;
	}
	const float row_top = static_cast<float>(model_.RowTop(range.first) - scroll_offset_);
	const float label_top = row_top + kRowVerticalPadding;
	if (y < label_top || y > label_top + kLabelHeight) {
		return std::nullopt;
	}
	return row.id;
}

std::optional<NativeTranscriptView::ProcessItemHit> NativeTranscriptView::HitTestProcessItemHeader(
	POINT point) const {
	if (model_.Empty() || window_ == nullptr) {
		return std::nullopt;
	}
	RECT client{};
	GetClientRect(window_, &client);
	if (client.right <= client.left || client.bottom <= client.top) {
		return std::nullopt;
	}
	const float scale = std::max(0.01F, DpiScale());
	const float x = static_cast<float>(point.x) / scale;
	const float y = static_cast<float>(point.y) / scale;
	const float viewport_width = static_cast<float>(client.right - client.left) / scale;
	const float horizontal_padding = NativeTranscriptOuterHorizontalPadding(viewport_width) + kRowContentInset;
	if (x < horizontal_padding || x > viewport_width - horizontal_padding) {
		return std::nullopt;
	}
	const std::int64_t content_y = scroll_offset_ + static_cast<std::int64_t>(std::floor(y));
	const NativeTranscriptVisibleRange range = model_.VisibleRange(content_y, 1);
	if (range.Empty() || range.first >= model_.Size()) {
		return std::nullopt;
	}
	const NativeTranscriptRow& row = model_.RowAt(range.first);
	if (row.kind != NativeTranscriptRowKind::Reasoning || row.process_items.empty() || IsCollapsedExpandable(row)) {
		return std::nullopt;
	}
	float item_top = static_cast<float>(model_.RowTop(range.first) - scroll_offset_) +
		kRowVerticalPadding + kLabelHeight + kTextGap;
	for (const NativeTranscriptProcessItem& item : row.process_items) {
		const std::string item_key = ProcessItemKey(row, item);
		if (y >= item_top && y <= item_top + kProcessItemHeaderHeight) {
			return ProcessItemHit{row.id, item_key};
		}
		item_top += kProcessItemHeaderHeight;
		if (expanded_process_items_.contains(item_key)) {
			item_top += kProcessDetailGap + kProcessDetailHeight;
		}
		item_top += kProcessItemGap;
	}
	return std::nullopt;
}

std::optional<NativeTranscriptView::MessageActionHit> NativeTranscriptView::HitTestMessageAction(POINT point) {
	if (model_.Empty() || window_ == nullptr) {
		return std::nullopt;
	}
	RECT client{};
	GetClientRect(window_, &client);
	if (client.right <= client.left || client.bottom <= client.top) {
		return std::nullopt;
	}
	const float scale = std::max(0.01F, DpiScale());
	const float x = static_cast<float>(point.x) / scale;
	const float y = static_cast<float>(point.y) / scale;
	const float viewport_width = static_cast<float>(client.right - client.left) / scale;
	const std::int64_t content_y = scroll_offset_ + static_cast<std::int64_t>(std::floor(y));
	const NativeTranscriptVisibleRange range = model_.VisibleRange(content_y, 1);
	if (range.Empty() || range.first >= model_.Size()) {
		return std::nullopt;
	}
	const NativeTranscriptRow& row = model_.RowAt(range.first);
	const bool user = row.kind == NativeTranscriptRowKind::User;
	if ((!user && row.kind != NativeTranscriptRowKind::Assistant) || row.time_label.empty()) {
		return std::nullopt;
	}
	TextLayout* layout = GetTextLayout(row, NativeTranscriptBubbleMaxContentWidth(viewport_width, user));
	if (layout == nullptr) {
		return std::nullopt;
	}
	NativeTranscriptBubbleLayout bubble = ComputeNativeTranscriptBubbleLayout(
		viewport_width, user, layout->measured_width, layout->measured_height, row.media_ids.size(), true);
	NativeTranscriptMessageActionsLayout actions =
		ComputeNativeTranscriptMessageActionsLayout(bubble, user, row.can_edit);
	const float row_top = static_cast<float>(model_.RowTop(range.first) - scroll_offset_);
	const auto hit = [x, y, row_top](const NativeTranscriptRectF& rect) {
		return rect.Contains(x, y - row_top);
	};
	if (hit(actions.copy)) return MessageActionHit{row.id, MessageActionKind::Copy};
	if (actions.has_edit && hit(actions.edit)) return MessageActionHit{row.id, MessageActionKind::Edit};
	return std::nullopt;
}

void NativeTranscriptView::UpdateMessageActionHover(POINT point) {
	const auto next = HitTestMessageAction(point);
	const bool unchanged = (!next && !hovered_message_action_) ||
		(next && hovered_message_action_ && next->row_id == hovered_message_action_->row_id &&
			next->action == hovered_message_action_->action);
	if (unchanged) return;
	hovered_message_action_ = next;
	if (window_ != nullptr) InvalidateRect(window_, nullptr, FALSE);
}

void NativeTranscriptView::ToggleExpandable(std::string_view row_id) {
	const auto index = model_.IndexOf(row_id);
	if (!index) {
		return;
	}
	const NativeTranscriptRow& row = model_.RowAt(*index);
	if ((row.kind != NativeTranscriptRowKind::Reasoning && row.kind != NativeTranscriptRowKind::Tool) ||
		!HasFlag(row.flags, NativeTranscriptRowFlags::Expandable)) {
		return;
	}
	const std::string id(row_id);
	if (expanded_rows_.contains(id)) {
		expanded_rows_.erase(id);
	} else {
		expanded_rows_.insert(id);
	}
	if ((selection_anchor_ && selection_anchor_->row_id == id) ||
		(selection_focus_ && selection_focus_->row_id == id)) {
		ClearSelection();
	}
	static_cast<void>(model_.UpdateHeight(id, kCollapsedExpandableHeight));
	if (stick_to_bottom_) {
		ScrollToBottom();
	} else {
		ScrollTo(scroll_offset_, false);
	}
	if (window_ != nullptr) {
		InvalidateRect(window_, nullptr, FALSE);
	}
}

void NativeTranscriptView::ToggleProcessItem(const ProcessItemHit& hit) {
	const auto index = model_.IndexOf(hit.row_id);
	if (!index) {
		return;
	}
	const NativeTranscriptRow& row = model_.RowAt(*index);
	if (row.kind != NativeTranscriptRowKind::Reasoning || row.process_items.empty() || IsCollapsedExpandable(row)) {
		return;
	}
	const bool opening = !expanded_process_items_.contains(hit.item_key);
	if (opening) {
		expanded_process_items_.insert(hit.item_key);
	} else {
		expanded_process_items_.erase(hit.item_key);
		process_detail_scroll_offsets_.erase(hit.item_key);
	}
	const auto detail_delta = static_cast<std::int32_t>(kProcessDetailGap + kProcessDetailHeight);
	const std::int32_t next_height =
		std::max(kCollapsedExpandableHeight, row.height + (opening ? detail_delta : -detail_delta));
	static_cast<void>(model_.UpdateHeight(row.id, next_height));
	if (stick_to_bottom_) {
		ScrollToBottom();
	} else {
		ScrollTo(scroll_offset_, false);
	}
	if (window_ != nullptr) {
		InvalidateRect(window_, nullptr, FALSE);
	}
}

bool NativeTranscriptView::ScrollProcessDetailAtPoint(POINT point, int wheel_delta) {
	if (model_.Empty() || window_ == nullptr || wheel_delta == 0) {
		return false;
	}
	RECT client{};
	GetClientRect(window_, &client);
	if (client.right <= client.left || client.bottom <= client.top) {
		return false;
	}
	const float scale = std::max(0.01F, DpiScale());
	const float x = static_cast<float>(point.x) / scale;
	const float y = static_cast<float>(point.y) / scale;
	const float viewport_width = static_cast<float>(client.right - client.left) / scale;
	const float horizontal_padding = NativeTranscriptOuterHorizontalPadding(viewport_width) + kRowContentInset;
	const float available_width = std::max(80.0F, viewport_width - 2.0F * horizontal_padding);
	const std::int64_t content_y = scroll_offset_ + static_cast<std::int64_t>(std::floor(y));
	const NativeTranscriptVisibleRange range = model_.VisibleRange(content_y, 1);
	if (range.Empty() || range.first >= model_.Size()) {
		return false;
	}
	const NativeTranscriptRow& row = model_.RowAt(range.first);
	if (row.kind != NativeTranscriptRowKind::Reasoning || row.process_items.empty() || IsCollapsedExpandable(row)) {
		return false;
	}
	float item_top = static_cast<float>(model_.RowTop(range.first) - scroll_offset_) +
		kRowVerticalPadding + kLabelHeight + kTextGap;
	for (const NativeTranscriptProcessItem& item : row.process_items) {
		const std::string item_key = ProcessItemKey(row, item);
		item_top += kProcessItemHeaderHeight;
		if (expanded_process_items_.contains(item_key)) {
			item_top += kProcessDetailGap;
			const float detail_left = horizontal_padding + 8.0F;
			const float detail_right = horizontal_padding + available_width - 8.0F;
			if (x >= detail_left && x <= detail_right && y >= item_top && y <= item_top + kProcessDetailHeight) {
				NativeTranscriptRow detail_row;
				detail_row.id = item_key;
				detail_row.text = item.detail;
				const float detail_width = std::max(
					40.0F, detail_right - detail_left - 2.0F * kProcessDetailPadding - 6.0F);
				TextLayout* layout = GetTextLayout(detail_row, detail_width);
				if (layout == nullptr) {
					return false;
				}
				const float viewport_height = kProcessDetailHeight - 2.0F * kProcessDetailPadding;
				const float maximum = std::max(0.0F, layout->measured_height - viewport_height);
				if (maximum <= 0.0F) {
					return false;
				}
				float& offset = process_detail_scroll_offsets_[item_key];
				const float delta = -static_cast<float>(wheel_delta) / static_cast<float>(WHEEL_DELTA) * 66.0F;
				const float next = std::clamp(offset + delta, 0.0F, maximum);
				if (std::abs(next - offset) < 0.5F) {
					return false;
				}
				offset = next;
				InvalidateRect(window_, nullptr, FALSE);
				return true;
			}
			item_top += kProcessDetailHeight;
		}
		item_top += kProcessItemGap;
	}
	return false;
}

std::optional<NativeTranscriptView::SelectionPoint> NativeTranscriptView::HitTestText(POINT point) {
	if (model_.Empty() || window_ == nullptr) {
		return std::nullopt;
	}
	RECT client{};
	GetClientRect(window_, &client);
	if (client.right <= client.left || client.bottom <= client.top) {
		return std::nullopt;
	}
	point.x = std::clamp(point.x, client.left, client.right - 1);
	point.y = std::clamp(point.y, client.top, client.bottom - 1);
	const float scale = DpiScale();
	const float x = static_cast<float>(point.x) / scale;
	const float y = static_cast<float>(point.y) / scale;
	const float viewport_width = static_cast<float>(client.right - client.left) / scale;
	const std::int64_t content_y = scroll_offset_ + static_cast<std::int64_t>(std::floor(y));
	const NativeTranscriptVisibleRange range = model_.VisibleRange(content_y, 1);
	if (range.Empty() || range.first >= model_.Size()) {
		return std::nullopt;
	}

	const std::size_t index = range.first;
	const NativeTranscriptRow& row = model_.RowAt(index);
	if (IsCollapsedExpandable(row)) {
		return std::nullopt;
	}
	if (row.kind == NativeTranscriptRowKind::Reasoning && !row.process_items.empty()) {
		return std::nullopt;
	}
	const bool user = row.kind == NativeTranscriptRowKind::User;
	const bool message = user || row.kind == NativeTranscriptRowKind::Assistant ||
		row.kind == NativeTranscriptRowKind::Plan;
	const float horizontal_padding = NativeTranscriptOuterHorizontalPadding(viewport_width) + kRowContentInset;
	const float available_width = std::max(80.0F, viewport_width - 2.0F * horizontal_padding);
	const float layout_width = message ? NativeTranscriptBubbleMaxContentWidth(viewport_width, user) : available_width;
	TextLayout* layout = GetTextLayout(row, layout_width);
	if (layout == nullptr) {
		return std::nullopt;
	}
	NativeTranscriptBubbleLayout bubble_layout{};
	if (message) {
		bubble_layout = ComputeNativeTranscriptBubbleLayout(viewport_width,
			user,
			layout->measured_width,
			layout->measured_height,
			row.media_ids.size());
	}
	const float content_left = message ? bubble_layout.content_left : horizontal_padding;
	const float text_top = static_cast<float>(model_.RowTop(index) - scroll_offset_) +
		(message ? bubble_layout.text_top : kRowVerticalPadding + kLabelHeight + kTextGap);
	if (y <= text_top) {
		return SelectionPoint{row.id, 0};
	}
	const auto text_size = static_cast<std::uint32_t>(
		std::min<std::size_t>(layout->text.size(), std::numeric_limits<std::uint32_t>::max()));
	if (y >= text_top + layout->measured_height) {
		return SelectionPoint{row.id, text_size};
	}

	BOOL trailing = FALSE;
	BOOL inside = FALSE;
	DWRITE_HIT_TEST_METRICS metric{};
	if (FAILED(layout->layout->HitTestPoint(x - content_left, y - text_top, &trailing, &inside, &metric))) {
		return std::nullopt;
	}
	std::uint32_t position = metric.textPosition;
	if (trailing) {
		position = static_cast<std::uint32_t>(std::min<std::uint64_t>(
			static_cast<std::uint64_t>(position) + metric.length,
			std::numeric_limits<std::uint32_t>::max()));
	}
	return SelectionPoint{row.id, std::min(position, text_size)};
}

std::optional<NativeTranscriptView::SelectionSpan> NativeTranscriptView::NormalizedSelection() const {
	if (!selection_anchor_ || !selection_focus_) {
		return std::nullopt;
	}
	const auto anchor_index = model_.IndexOf(selection_anchor_->row_id);
	const auto focus_index = model_.IndexOf(selection_focus_->row_id);
	if (!anchor_index || !focus_index) {
		return std::nullopt;
	}
	if (*anchor_index < *focus_index) {
		return SelectionSpan{*anchor_index, *focus_index, selection_anchor_->position, selection_focus_->position};
	}
	if (*anchor_index > *focus_index) {
		return SelectionSpan{*focus_index, *anchor_index, selection_focus_->position, selection_anchor_->position};
	}
	const std::uint32_t first = std::min(selection_anchor_->position, selection_focus_->position);
	const std::uint32_t last = std::max(selection_anchor_->position, selection_focus_->position);
	return SelectionSpan{*anchor_index, *anchor_index, first, last};
}

bool NativeTranscriptView::HasSelection() const {
	const auto selection = NormalizedSelection();
	return selection &&
		(selection->first_index != selection->last_index || selection->first_position != selection->last_position);
}

void NativeTranscriptView::ClearSelection() {
	selection_anchor_.reset();
	selection_focus_.reset();
	selecting_ = false;
	if (window_ != nullptr) {
		InvalidateRect(window_, nullptr, FALSE);
	}
}

void NativeTranscriptView::SelectAll() {
	if (model_.Empty()) {
		ClearSelection();
		return;
	}
	const NativeTranscriptRow& first = model_.RowAt(0);
	const NativeTranscriptRow& last = model_.RowAt(model_.Size() - 1);
	const std::wstring last_text = Utf8ToWide(last.text);
	selection_anchor_ = SelectionPoint{first.id, 0};
	selection_focus_ = SelectionPoint{
		last.id,
		static_cast<std::uint32_t>(
			std::min<std::size_t>(last_text.size(), std::numeric_limits<std::uint32_t>::max()))};
	InvalidateRect(window_, nullptr, FALSE);
}

void NativeTranscriptView::SelectRow(const SelectionPoint& point) {
	const auto index = model_.IndexOf(point.row_id);
	if (!index) {
		return;
	}
	const std::wstring text = Utf8ToWide(model_.RowAt(*index).text);
	const auto text_size = static_cast<std::uint32_t>(
		std::min<std::size_t>(text.size(), std::numeric_limits<std::uint32_t>::max()));
	selection_anchor_ = SelectionPoint{point.row_id, 0};
	selection_focus_ = SelectionPoint{point.row_id, text_size};
	InvalidateRect(window_, nullptr, FALSE);
}

void NativeTranscriptView::CopySelectionToClipboard() {
	const auto selection = NormalizedSelection();
	if (!selection || !HasSelection()) {
		return;
	}
	const std::wstring text = ExtractNativeTranscriptText(
		model_,
		NativeTranscriptTextRange{
			selection->first_index,
			selection->last_index,
			selection->first_position,
			selection->last_position});
	static_cast<void>(WriteClipboardText(window_, text));
}

void NativeTranscriptView::CopyRowToClipboard(std::string_view row_id) {
	const auto index = model_.IndexOf(row_id);
	if (!index) return;
	if (!WriteClipboardText(window_, Utf8ToWide(model_.RowAt(*index).text))) return;
	copied_row_id_ = row_id;
	KillTimer(window_, kMessageCopyFeedbackTimer);
	SetTimer(window_, kMessageCopyFeedbackTimer, kMessageCopyFeedbackDelayMs, nullptr);
	InvalidateRect(window_, nullptr, FALSE);
}

void NativeTranscriptView::ShowContextMenu(POINT screen_point) {
	HMENU menu = CreatePopupMenu();
	InsertNativeMenuItem(
		menu, kContextCopyItem, kContextCopy, nullptr, HasSelection() ? MFS_ENABLED : MFS_DISABLED);
	InsertNativeMenuItem(menu, kContextSelectAllItem, kContextSelectAll);
	ApplyNativeMenuBackground(menu, dark_theme_);
	const UINT command = TrackPopupMenu(
		menu,
		TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_LEFTALIGN | TPM_TOPALIGN,
		screen_point.x,
		screen_point.y,
		0,
		window_,
		nullptr);
	DestroyMenu(menu);
	if (command == kContextCopy) {
		CopySelectionToClipboard();
	} else if (command == kContextSelectAll) {
		SelectAll();
	}
}

D2D1_POINT_2F NativeTranscriptView::PointToDip(POINT point) const noexcept {
	const float scale = std::max(0.01F, DpiScale());
	return D2D1::Point2F(static_cast<float>(point.x) / scale, static_cast<float>(point.y) / scale);
}

NativeTranscriptScrollbarGeometry NativeTranscriptView::CurrentScrollbarGeometry() const noexcept {
	if (window_ == nullptr) {
		return {};
	}
	RECT client{};
	GetClientRect(window_, &client);
	const float scale = std::max(0.01F, DpiScale());
	return ComputeNativeTranscriptScrollbar(
		static_cast<float>(client.right - client.left) / scale,
		static_cast<float>(client.bottom - client.top) / scale,
		model_.TotalHeight(),
		scroll_offset_);
}

NativeTranscriptRectF NativeTranscriptView::CurrentJumpButton() const noexcept {
	if (window_ == nullptr) {
		return {};
	}
	RECT client{};
	GetClientRect(window_, &client);
	const float scale = std::max(0.01F, DpiScale());
	return ComputeNativeTranscriptJumpButton(
		static_cast<float>(client.right - client.left) / scale,
		static_cast<float>(client.bottom - client.top) / scale);
}

bool NativeTranscriptView::JumpButtonVisible() const noexcept {
	return ShouldShowNativeTranscriptJumpButton(model_.TotalHeight(), ClientHeightDip(), scroll_offset_);
}

void NativeTranscriptView::UpdateOverlayHover(POINT point) {
	const D2D1_POINT_2F dip_point = PointToDip(point);
	const NativeTranscriptScrollbarGeometry scrollbar = CurrentScrollbarGeometry();
	const bool next_scrollbar_hovered = scrollbar.scrollable && scrollbar.hit_area.Contains(dip_point.x, dip_point.y);
	const bool next_jump_hovered =
		JumpButtonVisible() && CurrentJumpButton().Contains(dip_point.x, dip_point.y);
	const bool changed = next_scrollbar_hovered != scrollbar_hovered_ || next_jump_hovered != jump_button_hovered_;
	scrollbar_hovered_ = next_scrollbar_hovered;
	jump_button_hovered_ = next_jump_hovered;
	if (scrollbar_hovered_) {
		RevealOverlayScrollbar();
	} else {
		ScheduleOverlayScrollbarHide();
	}
	if (changed && window_ != nullptr) {
		InvalidateRect(window_, nullptr, FALSE);
	}
}

void NativeTranscriptView::RevealOverlayScrollbar() {
	if (window_ == nullptr || !CurrentScrollbarGeometry().scrollable) {
		return;
	}
	const bool changed = !overlay_scrollbar_visible_;
	overlay_scrollbar_visible_ = true;
	if (scrollbar_hovered_ || scrollbar_dragging_) {
		KillTimer(window_, kScrollbarHideTimer);
	} else {
		SetTimer(window_, kScrollbarHideTimer, kScrollbarHideDelayMs, nullptr);
	}
	if (changed) {
		InvalidateRect(window_, nullptr, FALSE);
	}
}

void NativeTranscriptView::ScheduleOverlayScrollbarHide() {
	if (window_ == nullptr || !overlay_scrollbar_visible_) {
		return;
	}
	if (scrollbar_hovered_ || scrollbar_dragging_) {
		KillTimer(window_, kScrollbarHideTimer);
		return;
	}
	SetTimer(window_, kScrollbarHideTimer, kScrollbarHideDelayMs, nullptr);
}

NativeTranscriptView::TextLayout* NativeTranscriptView::GetTextLayout(
	const NativeTranscriptRow& row, float width) {
	if (dwrite_factory_ == nullptr || text_format_ == nullptr) {
		return nullptr;
	}
	const std::size_t text_hash = std::hash<std::string>{}(row.text);
	auto found = layout_cache_.find(row.id);
	if (found != layout_cache_.end() && found->second.text_hash == text_hash &&
		std::abs(found->second.width - width) < 0.5F) {
		return &found->second;
	}

	TextLayout replacement{};
	replacement.text_hash = text_hash;
	replacement.width = width;
	replacement.text = Utf8ToWide(row.text);
	const HRESULT result = dwrite_factory_->CreateTextLayout(
		replacement.text.data(),
		static_cast<UINT32>(replacement.text.size()),
		text_format_.Get(),
		width,
		100'000.0F,
		replacement.layout.ReleaseAndGetAddressOf());
	if (FAILED(result)) {
		return nullptr;
	}
	DWRITE_TEXT_METRICS metrics{};
	if (FAILED(replacement.layout->GetMetrics(&metrics))) {
		return nullptr;
	}
	replacement.measured_width = std::max(0.0F, metrics.widthIncludingTrailingWhitespace);
	replacement.measured_height = std::max(18.0F, metrics.height);
	if (found == layout_cache_.end()) {
		found = layout_cache_.emplace(row.id, std::move(replacement)).first;
	} else {
		found->second = std::move(replacement);
	}
	return &found->second;
}

void NativeTranscriptView::UpdateScrollInfo() {
	if (window_ == nullptr) {
		return;
	}
	if ((GetWindowLongPtrW(window_, GWL_STYLE) & WS_VSCROLL) != 0) {
		ShowScrollBar(window_, SB_VERT, FALSE);
	}
}

void NativeTranscriptView::ScrollTo(std::int64_t offset, bool user_action) {
	const std::int64_t maximum = MaximumScroll();
	const std::int64_t next = std::clamp<std::int64_t>(offset, 0, maximum);
	if (user_action) {
		stick_to_bottom_ = maximum - next <= 2;
		RevealOverlayScrollbar();
	}
	if (next == scroll_offset_) {
		UpdateScrollInfo();
		MaybeRequestEarlier();
		return;
	}
	scroll_offset_ = next;
	UpdateScrollInfo();
	if (window_ != nullptr) {
		InvalidateRect(window_, nullptr, FALSE);
	}
	MaybeRequestEarlier();
}

void NativeTranscriptView::ScrollBy(std::int64_t delta, bool user_action) {
	ScrollTo(scroll_offset_ + delta, user_action);
}

void NativeTranscriptView::ScrollToBottom() {
	stick_to_bottom_ = true;
	ScrollTo(MaximumScroll(), false);
}

std::int64_t NativeTranscriptView::MaximumScroll() const noexcept {
	return std::max<std::int64_t>(0, model_.TotalHeight() - ClientHeightDip());
}

std::int64_t NativeTranscriptView::ClientHeightDip() const noexcept {
	if (window_ == nullptr) {
		return 0;
	}
	RECT client{};
	GetClientRect(window_, &client);
	const float scale = DpiScale();
	return static_cast<std::int64_t>(std::max(0.0F, static_cast<float>(client.bottom - client.top) / scale));
}

float NativeTranscriptView::DpiScale() const noexcept {
	return window_ == nullptr ? 1.0F : static_cast<float>(GetDpiForWindow(window_)) / 96.0F;
}

void NativeTranscriptView::TrimLayoutCache(const NativeTranscriptVisibleRange& range) {
	if (layout_cache_.size() <= kMaximumCachedLayouts) {
		return;
	}
	std::unordered_map<std::string, TextLayout> retained;
	retained.reserve(range.Size());
	for (std::size_t index = range.first; index < range.last; ++index) {
		auto node = layout_cache_.extract(model_.RowAt(index).id);
		if (!node.empty()) {
			retained.insert(std::move(node));
		}
	}
	layout_cache_.swap(retained);
}

void NativeTranscriptView::MaybeRequestEarlier() {
	if (!visible_ || history_remaining_ == 0 || history_loading_ || history_request_sent_ || scroll_offset_ > kOverscan ||
		!history_request_handler_) {
		return;
	}
	history_request_sent_ = true;
	history_request_delivered_ = false;
	history_request_handler_();
}

} // namespace omp::shell
