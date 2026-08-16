#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace omp::shell {

enum class NativeTranscriptRowKind : std::uint8_t {
	User,
	Assistant,
	Reasoning,
	Tool,
	System,
	Compaction,
	Error,
};

enum class NativeTranscriptRowFlags : std::uint8_t {
	None = 0,
	Streaming = 1 << 0,
	Expandable = 1 << 1,
	Expanded = 1 << 2,
	Failed = 1 << 3,
};

[[nodiscard]] constexpr NativeTranscriptRowFlags operator|(
	NativeTranscriptRowFlags left, NativeTranscriptRowFlags right) noexcept {
	return static_cast<NativeTranscriptRowFlags>(
		static_cast<std::uint8_t>(left) | static_cast<std::uint8_t>(right));
}

[[nodiscard]] constexpr bool HasFlag(
	NativeTranscriptRowFlags value, NativeTranscriptRowFlags flag) noexcept {
	return (static_cast<std::uint8_t>(value) & static_cast<std::uint8_t>(flag)) != 0;
}

struct NativeTranscriptRow final {
	std::string id;
	NativeTranscriptRowKind kind = NativeTranscriptRowKind::System;
	std::string text;
	NativeTranscriptRowFlags flags = NativeTranscriptRowFlags::None;
	std::int32_t height = 48;
	std::vector<std::string> media_ids;
	std::int64_t duration_ms = -1;
};

struct NativeTranscriptVisibleRange final {
	std::size_t first = 0;
	std::size_t last = 0;
	std::int64_t top = 0;
	std::int64_t bottom = 0;

	[[nodiscard]] bool Empty() const noexcept { return first == last; }
	[[nodiscard]] std::size_t Size() const noexcept { return last - first; }
};

struct NativeTranscriptTextRange final {
	std::size_t first_index = 0;
	std::size_t last_index = 0;
	std::uint32_t first_position = 0;
	std::uint32_t last_position = 0;
};

// Compact, UI-independent backing store for the native transcript. Row heights
// are held in a Fenwick tree, keeping streaming updates and visible-range
// lookups logarithmic even when a transcript contains hundreds of thousands of
// rows. Text remains UTF-8 and is converted/cached only by the renderer for the
// handful of rows currently on screen.
class NativeTranscriptModel final {
public:
	static constexpr std::int32_t kMinimumRowHeight = 1;

	void Clear();
	void ReplaceSnapshot(std::vector<NativeTranscriptRow> rows);

	// Inserts a new tail row or updates an existing stable id in place. Returns
	// the affected index. This is the hot path for streamed assistant output.
	[[nodiscard]] std::size_t Upsert(NativeTranscriptRow row);
	[[nodiscard]] bool Remove(std::string_view id);
	[[nodiscard]] bool UpdateHeight(std::string_view id, std::int32_t height);

	[[nodiscard]] std::size_t Size() const noexcept { return rows_.size(); }
	[[nodiscard]] bool Empty() const noexcept { return rows_.empty(); }
	[[nodiscard]] std::uint64_t Generation() const noexcept { return generation_; }
	[[nodiscard]] std::int64_t TotalHeight() const noexcept;
	[[nodiscard]] const NativeTranscriptRow& RowAt(std::size_t index) const;
	[[nodiscard]] std::optional<std::size_t> IndexOf(std::string_view id) const;
	[[nodiscard]] std::int64_t RowTop(std::size_t index) const;
	[[nodiscard]] NativeTranscriptVisibleRange VisibleRange(
		std::int64_t viewport_top,
		std::int64_t viewport_height,
		std::int64_t overscan = 0) const noexcept;

private:
	[[nodiscard]] static std::int32_t NormalizeHeight(std::int32_t height) noexcept;
	void RebuildIndexAndHeights();
	void AddHeight(std::size_t index, std::int64_t delta) noexcept;
	void AppendHeight(std::int32_t height);
	[[nodiscard]] std::int64_t PrefixHeight(std::size_t count) const noexcept;
	[[nodiscard]] std::size_t PrefixUpperBound(std::int64_t value) const noexcept;
	[[nodiscard]] std::size_t PrefixLowerBound(std::int64_t value) const noexcept;

	std::vector<NativeTranscriptRow> rows_;
	std::unordered_map<std::string, std::size_t> index_by_id_;
	// One-based Fenwick tree: height_tree_[0] is deliberately unused.
	std::vector<std::int64_t> height_tree_{0};
	std::uint64_t generation_ = 0;
};

[[nodiscard]] std::wstring ExtractNativeTranscriptText(
	const NativeTranscriptModel& model, const NativeTranscriptTextRange& range);

} // namespace omp::shell
