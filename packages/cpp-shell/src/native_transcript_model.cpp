#include "omp_shell/native_transcript_model.h"

#include "omp_shell/text_utils.h"

#include <algorithm>
#include <limits>
#include <stdexcept>
#include <utility>

namespace omp::shell {
namespace {

[[nodiscard]] std::size_t HighestPowerOfTwoAtMost(std::size_t value) noexcept {
	std::size_t bit = 1;
	while (bit <= value / 2) {
		bit *= 2;
	}
	return value == 0 ? 0 : bit;
}

[[nodiscard]] std::int64_t SaturatingAdd(std::int64_t left, std::int64_t right) noexcept {
	if (right > 0 && left > std::numeric_limits<std::int64_t>::max() - right) {
		return std::numeric_limits<std::int64_t>::max();
	}
	if (right < 0 && left < std::numeric_limits<std::int64_t>::min() - right) {
		return std::numeric_limits<std::int64_t>::min();
	}
	return left + right;
}

} // namespace

void NativeTranscriptModel::Clear() {
	rows_.clear();
	index_by_id_.clear();
	height_tree_.assign(1, 0);
	++generation_;
}

void NativeTranscriptModel::ReplaceSnapshot(std::vector<NativeTranscriptRow> rows) {
	rows_.clear();
	rows_.reserve(rows.size());
	index_by_id_.clear();
	index_by_id_.reserve(rows.size());

	for (NativeTranscriptRow& row : rows) {
		if (row.id.empty()) {
			continue;
		}
		row.height = NormalizeHeight(row.height);
		const auto found = index_by_id_.find(row.id);
		if (found == index_by_id_.end()) {
			const std::size_t index = rows_.size();
			index_by_id_.emplace(row.id, index);
			rows_.push_back(std::move(row));
		} else {
			// Keep the first occurrence's stable ordering while accepting the
			// newest payload. This also makes replayed bridge batches idempotent.
			rows_[found->second] = std::move(row);
		}
	}

	RebuildIndexAndHeights();
	++generation_;
}

std::size_t NativeTranscriptModel::Upsert(NativeTranscriptRow row) {
	if (row.id.empty()) {
		throw std::invalid_argument("native transcript rows require a stable id");
	}
	row.height = NormalizeHeight(row.height);
	const auto found = index_by_id_.find(row.id);
	if (found == index_by_id_.end()) {
		const std::size_t index = rows_.size();
		index_by_id_.emplace(row.id, index);
		rows_.push_back(std::move(row));
		AppendHeight(rows_.back().height);
		++generation_;
		return index;
	}

	const std::size_t index = found->second;
	const std::int32_t old_height = rows_[index].height;
	rows_[index] = std::move(row);
	AddHeight(index, static_cast<std::int64_t>(rows_[index].height) - old_height);
	++generation_;
	return index;
}

bool NativeTranscriptModel::Remove(std::string_view id) {
	const auto found = index_by_id_.find(std::string(id));
	if (found == index_by_id_.end()) {
		return false;
	}
	const std::size_t index = found->second;
	index_by_id_.erase(found);
	if (index + 1 == rows_.size()) {
		rows_.pop_back();
		height_tree_.pop_back();
	} else {
		rows_.erase(rows_.begin() + static_cast<std::ptrdiff_t>(index));
		RebuildIndexAndHeights();
	}
	++generation_;
	return true;
}

bool NativeTranscriptModel::UpdateHeight(std::string_view id, std::int32_t height) {
	const auto found = index_by_id_.find(std::string(id));
	if (found == index_by_id_.end()) {
		return false;
	}
	NativeTranscriptRow& row = rows_[found->second];
	const std::int32_t normalized = NormalizeHeight(height);
	if (row.height == normalized) {
		return true;
	}
	const std::int64_t delta = static_cast<std::int64_t>(normalized) - row.height;
	row.height = normalized;
	AddHeight(found->second, delta);
	++generation_;
	return true;
}

std::int64_t NativeTranscriptModel::TotalHeight() const noexcept {
	return PrefixHeight(rows_.size());
}

const NativeTranscriptRow& NativeTranscriptModel::RowAt(std::size_t index) const {
	return rows_.at(index);
}

std::optional<std::size_t> NativeTranscriptModel::IndexOf(std::string_view id) const {
	const auto found = index_by_id_.find(std::string(id));
	if (found == index_by_id_.end()) {
		return std::nullopt;
	}
	return found->second;
}

std::int64_t NativeTranscriptModel::RowTop(std::size_t index) const {
	if (index > rows_.size()) {
		throw std::out_of_range("native transcript row index is out of range");
	}
	return PrefixHeight(index);
}

NativeTranscriptVisibleRange NativeTranscriptModel::VisibleRange(
	std::int64_t viewport_top,
	std::int64_t viewport_height,
	std::int64_t overscan) const noexcept {
	if (rows_.empty() || viewport_height <= 0) {
		return {};
	}
	const std::int64_t total = TotalHeight();
	const std::int64_t safe_overscan = std::max<std::int64_t>(0, overscan);
	const std::int64_t top = std::clamp(
		SaturatingAdd(viewport_top, -safe_overscan), static_cast<std::int64_t>(0), total);
	const std::int64_t viewport_bottom = SaturatingAdd(viewport_top, viewport_height);
	const std::int64_t bottom = std::clamp(
		SaturatingAdd(viewport_bottom, safe_overscan), static_cast<std::int64_t>(0), total);
	if (bottom <= top) {
		const std::size_t boundary = PrefixUpperBound(top);
		return {boundary, boundary, top, bottom};
	}

	const std::size_t first = PrefixUpperBound(top);
	const std::size_t last = std::max(first, PrefixLowerBound(bottom));
	return {first, last, top, bottom};
}

std::int32_t NativeTranscriptModel::NormalizeHeight(std::int32_t height) noexcept {
	return std::max(kMinimumRowHeight, height);
}

void NativeTranscriptModel::RebuildIndexAndHeights() {
	index_by_id_.clear();
	index_by_id_.reserve(rows_.size());
	height_tree_.assign(rows_.size() + 1, 0);
	for (std::size_t index = 0; index < rows_.size(); ++index) {
		rows_[index].height = NormalizeHeight(rows_[index].height);
		index_by_id_.emplace(rows_[index].id, index);
		const std::size_t tree_index = index + 1;
		height_tree_[tree_index] += rows_[index].height;
		const std::size_t parent = tree_index + (tree_index & (~tree_index + 1));
		if (parent < height_tree_.size()) {
			height_tree_[parent] += height_tree_[tree_index];
		}
	}
}

void NativeTranscriptModel::AddHeight(std::size_t index, std::int64_t delta) noexcept {
	for (std::size_t tree_index = index + 1; tree_index < height_tree_.size();
		 tree_index += tree_index & (~tree_index + 1)) {
		height_tree_[tree_index] += delta;
	}
}

void NativeTranscriptModel::AppendHeight(std::int32_t height) {
	const std::size_t tree_index = height_tree_.size();
	const std::size_t low_bit = tree_index & (~tree_index + 1);
	const std::size_t range_start = tree_index - low_bit;
	const std::int64_t preceding_range = PrefixHeight(tree_index - 1) - PrefixHeight(range_start);
	height_tree_.push_back(preceding_range + NormalizeHeight(height));
}

std::int64_t NativeTranscriptModel::PrefixHeight(std::size_t count) const noexcept {
	count = std::min(count, rows_.size());
	std::int64_t total = 0;
	for (std::size_t tree_index = count; tree_index > 0; tree_index -= tree_index & (~tree_index + 1)) {
		total += height_tree_[tree_index];
	}
	return total;
}

std::size_t NativeTranscriptModel::PrefixUpperBound(std::int64_t value) const noexcept {
	if (value < 0 || rows_.empty()) {
		return 0;
	}
	std::size_t index = 0;
	std::int64_t sum = 0;
	for (std::size_t bit = HighestPowerOfTwoAtMost(rows_.size()); bit != 0; bit /= 2) {
		const std::size_t next = index + bit;
		if (next < height_tree_.size() && height_tree_[next] <= value - sum) {
			index = next;
			sum += height_tree_[next];
		}
	}
	return std::min(index, rows_.size());
}

std::size_t NativeTranscriptModel::PrefixLowerBound(std::int64_t value) const noexcept {
	if (value <= 0 || rows_.empty()) {
		return 0;
	}
	std::size_t index = 0;
	std::int64_t sum = 0;
	for (std::size_t bit = HighestPowerOfTwoAtMost(rows_.size()); bit != 0; bit /= 2) {
		const std::size_t next = index + bit;
		if (next < height_tree_.size() && height_tree_[next] < value - sum) {
			index = next;
			sum += height_tree_[next];
		}
	}
	return std::min(index + 1, rows_.size());
}

std::wstring ExtractNativeTranscriptText(
	const NativeTranscriptModel& model, const NativeTranscriptTextRange& range) {
	if (model.Empty() || range.first_index > range.last_index || range.last_index >= model.Size()) {
		return {};
	}
	std::wstring text;
	for (std::size_t index = range.first_index; index <= range.last_index; ++index) {
		std::wstring row_text = Utf8ToWide(model.RowAt(index).text);
		const std::size_t start = index == range.first_index
			? std::min<std::size_t>(range.first_position, row_text.size())
			: 0;
		const std::size_t end = index == range.last_index
			? std::min<std::size_t>(range.last_position, row_text.size())
			: row_text.size();
		if (index != range.first_index) {
			text.append(L"\r\n\r\n");
		}
		if (end > start) {
			text.append(row_text, start, end - start);
		}
	}
	return text;
}

} // namespace omp::shell
