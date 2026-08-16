#pragma once

#include "omp_shell/native_transcript_controls.h"
#include "omp_shell/native_transcript_model.h"

#include <windows.h>

#include <d2d1.h>
#include <dwrite.h>
#include <wincodec.h>
#include <wrl/client.h>

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace omp::shell {

// A Win32/DirectWrite virtual transcript surface. It is deliberately a child
// HWND rather than another web document: only the viewport-sized set of text
// layouts and draw calls exists, regardless of total session length.
class NativeTranscriptView final {
public:
	NativeTranscriptView() = default;
	~NativeTranscriptView();

	NativeTranscriptView(const NativeTranscriptView&) = delete;
	NativeTranscriptView& operator=(const NativeTranscriptView&) = delete;

	[[nodiscard]] bool Create(HWND parent, HINSTANCE instance);
	void Destroy();
	void SetBounds(const RECT& bounds);
	void SetVisible(bool visible);
	[[nodiscard]] bool IsVisible() const noexcept { return visible_; }
	[[nodiscard]] HWND Window() const noexcept { return window_; }

	void Clear();
	void ReplaceSnapshot(std::vector<NativeTranscriptRow> rows);
	void Upsert(NativeTranscriptRow row);
	void Remove(std::string_view id);
	void SetHistoryState(std::size_t remaining, bool loading);
	void SetHistoryRequestHandler(std::function<void()> handler);
	[[nodiscard]] bool TakeHistoryRequest() noexcept;
	void SetImageRequestHandler(std::function<void(std::string_view)> handler);
	void ProvideImage(std::string image_id, std::vector<std::uint8_t> encoded_bytes);
	[[nodiscard]] const NativeTranscriptModel& Model() const noexcept { return model_; }

private:
	struct TextLayout final {
		std::size_t text_hash = 0;
		float width = 0.0F;
		std::wstring text;
		Microsoft::WRL::ComPtr<IDWriteTextLayout> layout;
		float measured_height = 0.0F;
	};
	struct SelectionPoint final {
		std::string row_id;
		std::uint32_t position = 0;
	};
	struct SelectionSpan final {
		std::size_t first_index = 0;
		std::size_t last_index = 0;
		std::uint32_t first_position = 0;
		std::uint32_t last_position = 0;
	};
	struct MediaEntry final {
		std::vector<std::uint8_t> encoded_bytes;
		Microsoft::WRL::ComPtr<ID2D1Bitmap> bitmap;
		std::uint64_t last_use = 0;
		bool failed = false;
	};

	static LRESULT CALLBACK WindowProcedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam);
	LRESULT HandleMessage(UINT message, WPARAM wparam, LPARAM lparam);
	[[nodiscard]] bool RegisterWindowClass(HINSTANCE instance) const;
	[[nodiscard]] HRESULT EnsureDeviceResources();
	void DiscardDeviceResources();
	void Paint();
	void DrawRow(std::size_t index, float viewport_width);
	void DrawOverlayControls(float viewport_width, float viewport_height);
	void DrawSelection(
		std::size_t index,
		const TextLayout& layout,
		float origin_x,
		float origin_y);
	void DrawMedia(const NativeTranscriptRow& row, float left, float top, float width);
	[[nodiscard]] ID2D1Bitmap* GetMediaBitmap(std::string_view image_id);
	void RequestMedia(std::string_view image_id);
	void TrimMediaCache();
	[[nodiscard]] TextLayout* GetTextLayout(const NativeTranscriptRow& row, float width);
	[[nodiscard]] bool IsCollapsedReasoning(const NativeTranscriptRow& row) const;
	[[nodiscard]] std::optional<std::string> HitTestReasoningHeader(POINT point) const;
	void ToggleReasoning(std::string_view row_id);
	[[nodiscard]] std::optional<SelectionPoint> HitTestText(POINT point);
	[[nodiscard]] std::optional<SelectionSpan> NormalizedSelection() const;
	[[nodiscard]] bool HasSelection() const;
	void ClearSelection();
	void SelectAll();
	void SelectRow(const SelectionPoint& point);
	void CopySelectionToClipboard();
	void ShowContextMenu(POINT screen_point);
	[[nodiscard]] D2D1_POINT_2F PointToDip(POINT point) const noexcept;
	[[nodiscard]] NativeTranscriptScrollbarGeometry CurrentScrollbarGeometry() const noexcept;
	[[nodiscard]] NativeTranscriptRectF CurrentJumpButton() const noexcept;
	[[nodiscard]] bool JumpButtonVisible() const noexcept;
	void UpdateOverlayHover(POINT point);
	void RevealOverlayScrollbar();
	void ScheduleOverlayScrollbarHide();
	void UpdateScrollInfo();
	void ScrollTo(std::int64_t offset, bool user_action);
	void ScrollBy(std::int64_t delta, bool user_action);
	void ScrollToBottom();
	[[nodiscard]] std::int64_t MaximumScroll() const noexcept;
	[[nodiscard]] std::int64_t ClientHeightDip() const noexcept;
	[[nodiscard]] float DpiScale() const noexcept;
	void TrimLayoutCache(const NativeTranscriptVisibleRange& range);
	void MaybeRequestEarlier();

	HWND window_ = nullptr;
	NativeTranscriptModel model_;
	Microsoft::WRL::ComPtr<ID2D1Factory> d2d_factory_;
	Microsoft::WRL::ComPtr<IDWriteFactory> dwrite_factory_;
	Microsoft::WRL::ComPtr<IWICImagingFactory> wic_factory_;
	Microsoft::WRL::ComPtr<ID2D1HwndRenderTarget> render_target_;
	Microsoft::WRL::ComPtr<ID2D1SolidColorBrush> primary_brush_;
	Microsoft::WRL::ComPtr<ID2D1SolidColorBrush> muted_brush_;
	Microsoft::WRL::ComPtr<ID2D1SolidColorBrush> user_brush_;
	Microsoft::WRL::ComPtr<ID2D1SolidColorBrush> line_brush_;
	Microsoft::WRL::ComPtr<ID2D1SolidColorBrush> selection_brush_;
	Microsoft::WRL::ComPtr<ID2D1SolidColorBrush> scrollbar_brush_;
	Microsoft::WRL::ComPtr<ID2D1SolidColorBrush> scrollbar_hot_brush_;
	Microsoft::WRL::ComPtr<ID2D1SolidColorBrush> jump_button_brush_;
	Microsoft::WRL::ComPtr<ID2D1SolidColorBrush> jump_button_hot_brush_;
	Microsoft::WRL::ComPtr<ID2D1SolidColorBrush> jump_button_border_brush_;
	Microsoft::WRL::ComPtr<ID2D1SolidColorBrush> jump_button_shadow_brush_;
	Microsoft::WRL::ComPtr<IDWriteTextFormat> text_format_;
	Microsoft::WRL::ComPtr<IDWriteTextFormat> label_format_;
	std::unordered_map<std::string, TextLayout> layout_cache_;
	std::unordered_map<std::string, MediaEntry> media_cache_;
	std::unordered_set<std::string> requested_media_;
	std::unordered_set<std::string> expanded_reasoning_;
	std::optional<SelectionPoint> selection_anchor_;
	std::optional<SelectionPoint> selection_focus_;
	std::int64_t scroll_offset_ = 0;
	std::size_t history_remaining_ = 0;
	std::function<void()> history_request_handler_;
	std::function<void(std::string_view)> image_request_handler_;
	float scrollbar_drag_anchor_y_ = 0.0F;
	std::int64_t scrollbar_drag_anchor_offset_ = 0;
	int wheel_remainder_ = 0;
	bool history_loading_ = false;
	bool history_request_sent_ = false;
	bool history_request_delivered_ = false;
	bool layout_changed_during_paint_ = false;
	bool selecting_ = false;
	bool mouse_tracking_ = false;
	bool overlay_scrollbar_visible_ = false;
	bool scrollbar_hovered_ = false;
	bool scrollbar_dragging_ = false;
	bool jump_button_hovered_ = false;
	bool jump_button_pressed_ = false;
	std::uint64_t media_use_clock_ = 0;
	bool stick_to_bottom_ = true;
	bool visible_ = false;
};

} // namespace omp::shell
