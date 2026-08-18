#include "test_harness.h"

#include "omp_shell/native_transcript_model.h"

#include <chrono>
#include <cstdint>
#include <iostream>
#include <string>
#include <utility>
#include <vector>

namespace {

omp::shell::NativeTranscriptRow Row(
	std::string id,
	std::int32_t height,
	std::string text = {},
	omp::shell::NativeTranscriptRowFlags flags = omp::shell::NativeTranscriptRowFlags::None) {
	return {std::move(id), omp::shell::NativeTranscriptRowKind::Assistant, std::move(text), flags, height};
}

} // namespace

OMP_TEST("native transcript snapshot deduplicates stable ids without reordering") {
	omp::shell::NativeTranscriptModel model;
	std::vector<omp::shell::NativeTranscriptRow> rows;
	rows.push_back(Row("a", 20, "old"));
	rows.push_back(Row("b", 30, "second"));
	rows.push_back(Row("a", 40, "new"));
	rows.push_back(Row("", 50, "invalid"));

	model.ReplaceSnapshot(std::move(rows));

	OMP_CHECK(model.Size() == 2);
	OMP_CHECK(model.RowAt(0).id == "a");
	OMP_CHECK(model.RowAt(0).text == "new");
	OMP_CHECK(model.RowAt(1).id == "b");
	OMP_CHECK(model.TotalHeight() == 70);
	OMP_CHECK(model.IndexOf("a") == 0);
	OMP_CHECK(!model.IndexOf("missing").has_value());
}

OMP_TEST("native transcript upsert appends and updates streaming rows in place") {
	using omp::shell::NativeTranscriptRowFlags;
	omp::shell::NativeTranscriptModel model;
	OMP_CHECK(model.Upsert(Row("user-1", 24, "hello")) == 0);
	OMP_CHECK(model.Upsert(Row("assistant-1", 30, "a", NativeTranscriptRowFlags::Streaming)) == 1);
	OMP_CHECK(model.Upsert(Row("assistant-1", 42, "answer")) == 1);

	OMP_CHECK(model.Size() == 2);
	OMP_CHECK(model.RowAt(1).text == "answer");
	OMP_CHECK(!omp::shell::HasFlag(model.RowAt(1).flags, NativeTranscriptRowFlags::Streaming));
	OMP_CHECK(model.TotalHeight() == 66);
	OMP_CHECK(model.RowTop(1) == 24);
}

OMP_TEST("native transcript preserves structured second-level process items") {
	auto row = Row("reasoning-1", 42, "fallback process text", omp::shell::NativeTranscriptRowFlags::Expandable);
	row.kind = omp::shell::NativeTranscriptRowKind::Reasoning;
	row.process_items.push_back({"command-1", "已执行命令 · bun test", "line 1\nline 2\nline 3", false});
	omp::shell::NativeTranscriptModel model;
	model.ReplaceSnapshot({std::move(row)});

	OMP_CHECK(model.RowAt(0).process_items.size() == 1);
	OMP_CHECK(model.RowAt(0).process_items[0].summary == "已执行命令 · bun test");
	OMP_CHECK(model.RowAt(0).process_items[0].detail.find("line 3") != std::string::npos);
}

OMP_TEST("native transcript accepts filesystem-absolute report paths and rejects device paths") {
	using omp::shell::IsNativeTranscriptAbsoluteFilePath;
	OMP_CHECK(IsNativeTranscriptAbsoluteFilePath(R"(C:\reports\result.html)"));
	OMP_CHECK(IsNativeTranscriptAbsoluteFilePath(R"(\\server\share\result.pdf)"));
	OMP_CHECK(IsNativeTranscriptAbsoluteFilePath(R"(\\?\C:\very-long\result.html)"));
	OMP_CHECK(IsNativeTranscriptAbsoluteFilePath(R"(\\?\UNC\server\share\result.pdf)"));
	OMP_CHECK(!IsNativeTranscriptAbsoluteFilePath(R"(C:relative.html)"));
	OMP_CHECK(!IsNativeTranscriptAbsoluteFilePath(R"(..\relative.html)"));
	OMP_CHECK(!IsNativeTranscriptAbsoluteFilePath("https://example.com/report.html"));
	OMP_CHECK(!IsNativeTranscriptAbsoluteFilePath(R"(\\.\PhysicalDrive0)"));
}

OMP_TEST("native transcript visible range handles exact boundaries and overscan") {
	omp::shell::NativeTranscriptModel model;
	model.ReplaceSnapshot({Row("a", 10), Row("b", 20), Row("c", 30), Row("d", 40)});

	auto range = model.VisibleRange(10, 20);
	OMP_CHECK(range.first == 1);
	OMP_CHECK(range.last == 2);

	range = model.VisibleRange(11, 20);
	OMP_CHECK(range.first == 1);
	OMP_CHECK(range.last == 3);

	range = model.VisibleRange(30, 1, 10);
	OMP_CHECK(range.first == 1);
	OMP_CHECK(range.last == 3);
	OMP_CHECK(range.top == 20);
	OMP_CHECK(range.bottom == 41);

	OMP_CHECK(model.UpdateHeight("b", 50));
	OMP_CHECK(model.RowTop(2) == 60);
	OMP_CHECK(model.TotalHeight() == 130);
	OMP_CHECK(!model.UpdateHeight("missing", 10));
}

OMP_TEST("native transcript keeps minimum positive row heights") {
	omp::shell::NativeTranscriptModel model;
	model.ReplaceSnapshot({Row("zero", 0), Row("negative", -100)});
	OMP_CHECK(model.TotalHeight() == 2);
	OMP_CHECK(model.VisibleRange(0, 1).Size() == 1);
}

OMP_TEST("native transcript removes transient tail and middle rows") {
	omp::shell::NativeTranscriptModel model;
	model.ReplaceSnapshot({Row("a", 10), Row("b", 20), Row("stream", 30)});
	OMP_CHECK(model.Remove("stream"));
	OMP_CHECK(model.Size() == 2);
	OMP_CHECK(model.TotalHeight() == 30);
	OMP_CHECK(model.Remove("a"));
	OMP_CHECK(model.Size() == 1);
	OMP_CHECK(model.RowAt(0).id == "b");
	OMP_CHECK(model.RowTop(1) == 20);
	OMP_CHECK(!model.Remove("missing"));
}

OMP_TEST("native transcript extracts exact cross-row clipboard text") {
	omp::shell::NativeTranscriptModel model;
	model.ReplaceSnapshot({Row("a", 10, "hello"), Row("b", 10, "world"), Row("c", 10, "中文")});
	OMP_CHECK(
		omp::shell::ExtractNativeTranscriptText(model, {0, 1, 1, 3}) == L"ello\r\n\r\nwor");
	OMP_CHECK(omp::shell::ExtractNativeTranscriptText(model, {2, 2, 0, 2}) == L"中文");
	OMP_CHECK(omp::shell::ExtractNativeTranscriptText(model, {3, 3, 0, 1}).empty());
}

OMP_TEST("native transcript indexes one hundred thousand rows within a bounded budget") {
	constexpr std::size_t kRowCount = 100'000;
	std::vector<omp::shell::NativeTranscriptRow> rows;
	rows.reserve(kRowCount);
	for (std::size_t index = 0; index < kRowCount; ++index) {
		rows.push_back(Row("row-" + std::to_string(index), 36 + static_cast<std::int32_t>(index % 5), "message"));
	}

	omp::shell::NativeTranscriptModel model;
	const auto started = std::chrono::steady_clock::now();
	model.ReplaceSnapshot(std::move(rows));
	std::size_t visited = 0;
	for (std::size_t query = 0; query < 100'000; ++query) {
		const std::int64_t top = static_cast<std::int64_t>((query * 7919ULL) % 3'700'000ULL);
		visited += model.VisibleRange(top, 900, 450).Size();
	}
	const auto elapsed = std::chrono::steady_clock::now() - started;
	const auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count();

	OMP_CHECK(model.Size() == kRowCount);
	OMP_CHECK(model.TotalHeight() == 3'800'000);
	OMP_CHECK(visited > 0);
	// This generous guard detects an accidental O(n) visible-range lookup while
	// remaining stable on an unoptimised Debug build and slower CI hardware.
	OMP_CHECK(elapsed_ms < 30'000);
	std::cout << "[benchmark] 100k native rows + 100k viewport queries: " << elapsed_ms << " ms\n";
}
