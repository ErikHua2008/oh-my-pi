#include "test_harness.h"

#include "omp_shell/core_output_parser.h"

#include <string>

namespace {

constexpr auto kControl = "http://127.0.0.1:4567/#ws://127.0.0.1:4567/r/ctrl-secret";
constexpr auto kSession = "http://127.0.0.1:4567/#ws://127.0.0.1:4567/r/session-secret";

} // namespace

OMP_TEST("core links parse across arbitrarily split pipe reads") {
	omp::shell::CoreOutputParser parser;
	const std::string output = std::string("ctrl: ") + kControl + "\r\nsession: " + kSession + "\r\n";
	for (const char ch : output) {
		parser.Feed(std::string_view(&ch, 1));
	}
	OMP_CHECK(parser.complete());
	OMP_CHECK(parser.links()->control == kControl);
	OMP_CHECK(parser.links()->session == kSession);
}

OMP_TEST("unexpected startup output fails without echoing a potentially sensitive line") {
	omp::shell::CoreOutputParser parser;
	parser.Feed("debug token=super-secret\n");
	OMP_CHECK(!parser.complete());
	OMP_CHECK(!parser.error().empty());
	OMP_CHECK(parser.error().find("super-secret") == std::string::npos);
}

OMP_TEST("remote navigation links are rejected") {
	omp::shell::CoreOutputParser parser;
	parser.Feed("ctrl: https://example.com/#ws://example.com/r/secret\n");
	OMP_CHECK(!parser.complete());
	OMP_CHECK(parser.error() == "omp core emitted an invalid local control link");
}

OMP_TEST("loopback-looking links cannot redirect through user information") {
	omp::shell::CoreOutputParser parser;
	parser.Feed("ctrl: http://127.0.0.1:80@evil.example/#ws://127.0.0.1:4567/r/secret\n");
	OMP_CHECK(!parser.complete());
	OMP_CHECK(parser.error() == "omp core emitted an invalid local control link");
}

OMP_TEST("lookalike hosts and malformed ports are rejected") {
	const std::string invalid_links[] = {
		"http://127.0.0.1.evil.example:4567/#ws://127.0.0.1:4567/r/secret",
		"http://localhost.evil.example:4567/#ws://localhost:4567/r/secret",
		"http://127.0.0.1:0/#ws://127.0.0.1:4567/r/secret",
		"http://127.0.0.1:65536/#ws://127.0.0.1:4567/r/secret",
		"http://127.0.0.1:4567/#ws://127.0.0.1:not-a-port/r/secret",
		"http://127.0.0.1:4567\\@evil.example/#ws://127.0.0.1:4567/r/secret",
	};
	for (const std::string& link : invalid_links) {
		omp::shell::CoreOutputParser parser;
		parser.Feed(std::string("ctrl: ") + link + "\n");
		OMP_CHECK(!parser.complete());
		OMP_CHECK(parser.error() == "omp core emitted an invalid local control link");
	}
}

OMP_TEST("both loopback host spellings are accepted") {
	omp::shell::CoreOutputParser parser;
	parser.Feed("ctrl: http://localhost:4567/#ws://localhost:4567/r/control\n"
		"session: http://127.0.0.1:4567/#ws://localhost:4567/r/session\n");
	OMP_CHECK(parser.complete());
}

OMP_TEST("oversized loopback links are rejected before WebView navigation") {
	omp::shell::CoreOutputParser parser;
	std::string link = "http://127.0.0.1:4567/#ws://127.0.0.1:4567/r/";
	link.append(9 * 1024, 'a');
	parser.Feed(std::string("ctrl: ") + link + "\n");
	OMP_CHECK(!parser.complete());
	OMP_CHECK(parser.error() == "omp core emitted an invalid local control link");
}

OMP_TEST("EOF after the control line reports an incomplete startup") {
	omp::shell::CoreOutputParser parser;
	parser.Feed(std::string("ctrl: ") + kControl + "\n");
	parser.Finish();
	OMP_CHECK(!parser.complete());
	OMP_CHECK(parser.error() == "omp core ended before emitting the session link");
}
