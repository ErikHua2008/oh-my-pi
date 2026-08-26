#include "test_harness.h"

#include "omp_shell/webview_security.h"

#include <optional>
#include <string>

OMP_TEST("WebView Core origin accepts only explicit loopback HTTP endpoints") {
	OMP_CHECK(omp::shell::TrustedLoopbackOrigin(L"http://127.0.0.1:43210/#session") ==
		std::optional<std::wstring>(L"http://127.0.0.1:43210"));
	OMP_CHECK(omp::shell::TrustedLoopbackOrigin(L"http://localhost:1/path?query") ==
		std::optional<std::wstring>(L"http://localhost:1"));
	OMP_CHECK(!omp::shell::TrustedLoopbackOrigin(L"https://127.0.0.1:43210/").has_value());
	OMP_CHECK(!omp::shell::TrustedLoopbackOrigin(L"http://127.0.0.1/").has_value());
	OMP_CHECK(!omp::shell::TrustedLoopbackOrigin(L"http://user@127.0.0.1:43210/").has_value());
	OMP_CHECK(!omp::shell::TrustedLoopbackOrigin(L"http://127.0.0.1:65536/").has_value());
	OMP_CHECK(!omp::shell::TrustedLoopbackOrigin(L"http://127.0.0.1:43210\\evil").has_value());
	OMP_CHECK(!omp::shell::TrustedLoopbackOrigin(L"http://example.com:43210/").has_value());
}

OMP_TEST("WebView desktop trust remains bound to the selected Core port") {
	const auto selected = omp::shell::TrustedLoopbackOrigin(L"http://127.0.0.1:43210/#control");
	const auto same_core = omp::shell::TrustedLoopbackOrigin(L"http://127.0.0.1:43210/settings");
	const auto other_local_service = omp::shell::TrustedLoopbackOrigin(L"http://127.0.0.1:43211/");
	OMP_CHECK(selected.has_value());
	OMP_CHECK(same_core == selected);
	OMP_CHECK(other_local_service.has_value());
	OMP_CHECK(other_local_service != selected);
}
