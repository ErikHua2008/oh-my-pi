#include "omp_shell/webview_host.h"

#include "omp_shell/text_utils.h"
#include "omp_shell/webview_security.h"

#include <ShlObj.h>
#include <shellapi.h>

#include <algorithm>
#include <filesystem>
#include <nlohmann/json.hpp>
#include <utility>

namespace omp::shell {
namespace {

std::wstring WebViewDataDirectory() {
	PWSTR local_app_data = nullptr;
	if (FAILED(SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_CREATE, nullptr, &local_app_data))) {
		return {};
	}
	std::filesystem::path path(local_app_data);
	CoTaskMemFree(local_app_data);
	path /= L"io.omp.cpp-shell";
	path /= L"WebView2";
	std::error_code error;
	std::filesystem::create_directories(path, error);
	return error ? std::wstring{} : path.wstring();
}

std::wstring HtmlEscape(std::wstring_view value) {
	std::wstring escaped;
	escaped.reserve(value.size());
	for (const wchar_t ch : value) {
		switch (ch) {
		case L'&':
			escaped.append(L"&amp;");
			break;
		case L'<':
			escaped.append(L"&lt;");
			break;
		case L'>':
			escaped.append(L"&gt;");
			break;
		case L'\"':
			escaped.append(L"&quot;");
			break;
		case L'\n':
			escaped.append(L"<br>");
			break;
		case L'\r':
			break;
		default:
			if (ch < 0x20 && ch != L'\t') {
				escaped.push_back(L'\uFFFD');
			} else {
				escaped.push_back(ch);
			}
			break;
		}
	}
	return escaped;
}

bool IsInlineHtmlDataUri(std::wstring_view uri) {
	// Recent WebView2 Runtime versions expose NavigateToString navigation as an
	// internal base64 data URI instead of about:blank.
	return uri.starts_with(L"data:text/html;charset=utf-8;base64,");
}

bool StartsWithAsciiCaseInsensitive(std::wstring_view value, std::wstring_view prefix) {
	if (value.size() < prefix.size()) {
		return false;
	}
	for (std::size_t index = 0; index < prefix.size(); ++index) {
		wchar_t actual = value[index];
		if (actual >= L'A' && actual <= L'Z') {
			actual = static_cast<wchar_t>(actual - L'A' + L'a');
		}
		if (actual != prefix[index]) {
			return false;
		}
	}
	return true;
}

bool IsAllowedExternalUri(std::wstring_view uri) {
	constexpr std::size_t kMaximumUriLength = 8U * 1024U;
	if (uri.empty() || uri.size() > kMaximumUriLength ||
		(!StartsWithAsciiCaseInsensitive(uri, L"http://") &&
			!StartsWithAsciiCaseInsensitive(uri, L"https://"))) {
		return false;
	}
	const std::size_t scheme_end = uri.find(L"://");
	if (scheme_end == std::wstring_view::npos) {
		return false;
	}
	const std::size_t authority_start = scheme_end + 3U;
	const std::size_t authority_end = uri.find_first_of(L"/?#", authority_start);
	if (authority_start >= uri.size() || authority_end == authority_start) {
		return false;
	}
	for (const wchar_t ch : uri) {
		if (ch <= 0x20 || ch == 0x7F || ch == L'\\' || ch == L'"' || ch == L'<' || ch == L'>') {
			return false;
		}
	}
	return true;
}

void OpenExternalUri(HWND owner, std::wstring_view uri) {
	if (!IsAllowedExternalUri(uri)) {
		return;
	}
	const std::wstring owned(uri);
	ShellExecuteW(owner, L"open", owned.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

constexpr std::wstring_view kPageStyle = LR"css(
<style>
:root {
  font-family: "Segoe UI Variable", "Microsoft YaHei UI", sans-serif;
  --bg: #ffffff; --bg-sidebar: #f9fafb; --raised: #ffffff; --inset: #f9fafb;
  --hover: rgb(38 49 72 / 6%); --fg: #0f1115; --muted: #61666b; --faint: #81858c;
  --accent: #4176e6; --accent-hover: #3267d7; --accent-fg: #ffffff;
  --border: rgb(0 0 0 / 10%); --border-strong: rgb(0 0 0 / 16%); --err: #ec1313;
  --detail-bg: #f5f7fa; --detail-fg: #4b5057; --scrollbar: rgb(97 102 107 / 55%);
  --shadow: 0 0 1px rgb(0 0 0 / 20%), 0 12px 32px rgb(0 0 0 / 8%);
}
[data-theme="light"] { color-scheme: light; }
[data-theme="dark"] {
  color-scheme: dark;
  --bg: #151517; --bg-sidebar: #1b1b1c; --raised: #2c2c2e; --inset: #1b1b1c;
  --hover: rgb(255 255 255 / 8%); --fg: #f9fafb; --muted: #cfd3d6; --faint: #adb2b8;
  --accent: #679efe; --accent-hover: #79aaff; --accent-fg: #0f1115;
  --border: rgb(255 255 255 / 12%); --border-strong: rgb(255 255 255 / 20%); --err: #f25a5a;
  --detail-bg: #202022; --detail-fg: #cfd3d6; --scrollbar: rgb(207 211 214 / 58%);
  --shadow: 0 0 1px rgb(0 0 0 / 35%), 0 18px 48px rgb(0 0 0 / 32%);
}
* { box-sizing: border-box; }
html { background: var(--bg); scrollbar-color: var(--scrollbar) transparent; }
body { margin: 0; min-height: 100vh; padding-top: 36px; display: grid; place-items: center; background: var(--bg); color: var(--fg); }
.shellbar { position: fixed; inset: 0 0 auto; height: 36px; display: flex; align-items: stretch; z-index: 10;
  background: var(--bg-sidebar); border-bottom: 1px solid var(--border); user-select: none; }
.shellbar-drag { flex: 1; min-width: 40px; }
.shellbar-title { display: flex; align-items: center; padding-left: 14px; color: var(--faint); font-size: 12px; }
.shellbar-controls { display: flex; }
.shellbar-controls button { width: 46px; height: 35px; margin: 0; padding: 0; border-radius: 0; color: var(--faint);
  background: transparent; font-size: 16px; font-weight: 400; }
.shellbar-controls button:hover { color: var(--fg); background: var(--hover); }
.shellbar-controls .shellbar-close:hover { background: #c42b1c; }
.resize-edge { position: fixed; z-index: 1000; touch-action: none; }
.resize-top, .resize-bottom { left: 10px; right: 10px; height: 6px; }
.resize-left, .resize-right { top: 10px; bottom: 10px; width: 6px; }
.resize-top { top: 0; cursor: n-resize; }
.resize-right { right: 0; cursor: e-resize; }
.resize-bottom { bottom: 0; cursor: s-resize; }
.resize-left { left: 0; cursor: w-resize; }
.resize-top-left, .resize-top-right, .resize-bottom-right, .resize-bottom-left { width: 10px; height: 10px; }
.resize-top-left { top: 0; left: 0; cursor: nw-resize; }
.resize-top-right { top: 0; right: 0; cursor: ne-resize; }
.resize-bottom-right { right: 0; bottom: 0; cursor: se-resize; }
.resize-bottom-left { bottom: 0; left: 0; cursor: sw-resize; }
.card { width: min(620px, calc(100vw - 48px)); padding: 44px; border: 1px solid var(--border); border-radius: 18px;
  background: var(--raised); box-shadow: var(--shadow); }
.error-mark { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 12px; margin-bottom: 24px;
  background: var(--err); color: white; font-size: 22px; font-weight: 700; }
h1 { margin: 0 0 12px; font-size: 25px; font-weight: 620; letter-spacing: -.02em; }
p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.65; }
.detail { margin-top: 18px; padding: 14px 16px; max-height: 220px; overflow: auto; border-radius: 10px;
  border: 1px solid var(--border); background: var(--detail-bg); color: var(--detail-fg); font: 12px/1.55 Consolas, monospace; overflow-wrap: anywhere; }
button { margin-top: 28px; border: 0; border-radius: 9px; padding: 10px 17px; background: var(--accent); color: var(--accent-fg);
  font: 600 14px "Segoe UI Variable", sans-serif; cursor: pointer; }
button:hover { background: var(--accent-hover); }
.error h1 { color: var(--err); }
</style>
)css";

constexpr std::wstring_view kFallbackTitlebar = LR"html(
<div class="resize-edge resize-top" aria-hidden="true"
  onpointerdown="if(event.button===0)window.__TAURI_INTERNALS__?.invoke('window_action',{action:'resize_top'})"></div>
<div class="resize-edge resize-right" aria-hidden="true"
  onpointerdown="if(event.button===0)window.__TAURI_INTERNALS__?.invoke('window_action',{action:'resize_right'})"></div>
<div class="resize-edge resize-bottom" aria-hidden="true"
  onpointerdown="if(event.button===0)window.__TAURI_INTERNALS__?.invoke('window_action',{action:'resize_bottom'})"></div>
<div class="resize-edge resize-left" aria-hidden="true"
  onpointerdown="if(event.button===0)window.__TAURI_INTERNALS__?.invoke('window_action',{action:'resize_left'})"></div>
<div class="resize-edge resize-top-left" aria-hidden="true"
  onpointerdown="if(event.button===0)window.__TAURI_INTERNALS__?.invoke('window_action',{action:'resize_top_left'})"></div>
<div class="resize-edge resize-top-right" aria-hidden="true"
  onpointerdown="if(event.button===0)window.__TAURI_INTERNALS__?.invoke('window_action',{action:'resize_top_right'})"></div>
<div class="resize-edge resize-bottom-right" aria-hidden="true"
  onpointerdown="if(event.button===0)window.__TAURI_INTERNALS__?.invoke('window_action',{action:'resize_bottom_right'})"></div>
<div class="resize-edge resize-bottom-left" aria-hidden="true"
  onpointerdown="if(event.button===0)window.__TAURI_INTERNALS__?.invoke('window_action',{action:'resize_bottom_left'})"></div>
<header class="shellbar">
  <span class="shellbar-title">Grimoire Router App</span>
  <div class="shellbar-drag"
    onpointerdown="if(event.button===0)window.__TAURI_INTERNALS__?.invoke('window_action',{action:'drag'})"
    ondblclick="window.__TAURI_INTERNALS__?.invoke('window_action',{action:'toggle_maximize'})"></div>
  <div class="shellbar-controls">
    <button aria-label="Minimize" onclick="window.__TAURI_INTERNALS__?.invoke('window_action',{action:'minimize'})">−</button>
    <button aria-label="Maximize" onclick="window.__TAURI_INTERNALS__?.invoke('window_action',{action:'toggle_maximize'})">□</button>
    <button class="shellbar-close" aria-label="Close" onclick="window.__TAURI_INTERNALS__?.invoke('window_action',{action:'close'})">×</button>
  </div>
</header>
)html";

constexpr wchar_t kDesktopBridgeScript[] = LR"js(
(() => {
	window.__OMP_CPP_SHELL__ = true;
	const markCppHost = () => {
		if (document.documentElement) document.documentElement.dataset.ompHost = "cpp";
	};
	markCppHost();
	if (!document.documentElement) {
		document.addEventListener("DOMContentLoaded", markCppHost, { once: true });
	}
  if (window.__TAURI_INTERNALS__?.invoke || !window.chrome?.webview) return;
  let nextId = 0;
  const pending = new Map();
  window.chrome.webview.addEventListener("message", event => {
    const message = event.data;
	if (message?.channel === "omp-native-transcript-event" && typeof message.event === "string") {
	  window.dispatchEvent(new CustomEvent("omp-native-transcript", { detail: message }));
	  return;
	}
    if (!message || message.channel !== "omp-desktop-response" || typeof message.id !== "number") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.ok) request.resolve(message.value);
    else request.reject(new Error(typeof message.error === "string" ? message.error : "desktop command failed"));
  });
  const invoke = (command, args = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    window.chrome.webview.postMessage(JSON.stringify({ channel: "omp-desktop", id, command, args }));
  });
  window.__TAURI_INTERNALS__ = { ...(window.__TAURI_INTERNALS__ || {}), invoke };
  window.addEventListener("dragover", event => {
    if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
  });
  window.addEventListener("drop", event => {
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length === 0 || typeof window.chrome.webview.postMessageWithAdditionalObjects !== "function") return;
    event.preventDefault();
    event.stopPropagation();
    window.chrome.webview.postMessageWithAdditionalObjects("omp-drop-files", files.slice(0, 32));
  });
})();
)js";

} // namespace

WebViewHost::~WebViewHost() {
	callback_alive_->store(false, std::memory_order_release);
	if (webview_ && navigation_token_.value != 0) {
		webview_->remove_NavigationStarting(navigation_token_);
	}
	if (webview_ && new_window_token_.value != 0) {
		webview_->remove_NewWindowRequested(new_window_token_);
	}
	if (webview_ && message_token_.value != 0) {
		webview_->remove_WebMessageReceived(message_token_);
	}
	if (controller_) {
		controller_->Close();
	}
	ready_handler_ = {};
	message_handler_ = {};
}

void WebViewHost::Initialize(HWND window, ReadyHandler ready_handler, MessageHandler message_handler) {
	window_ = window;
	ready_handler_ = std::move(ready_handler);
	message_handler_ = std::move(message_handler);
	const std::wstring user_data = WebViewDataDirectory();
	const wchar_t* user_data_path = user_data.empty() ? nullptr : user_data.c_str();
	const auto callback_alive = callback_alive_;

	const HRESULT started = CreateCoreWebView2EnvironmentWithOptions(nullptr,
		user_data_path,
		nullptr,
		Microsoft::WRL::Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
			[this, callback_alive](HRESULT result, ICoreWebView2Environment* environment) -> HRESULT {
				if (!callback_alive->load(std::memory_order_acquire)) return S_OK;
				if (FAILED(result) || environment == nullptr) {
					if (ready_handler_) {
						ready_handler_(FAILED(result) ? result : E_FAIL);
					}
					return S_OK;
				}
				environment_ = environment;
				return environment_->CreateCoreWebView2Controller(window_,
					Microsoft::WRL::Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
						[this, callback_alive](HRESULT controller_result, ICoreWebView2Controller* controller) -> HRESULT {
							if (!callback_alive->load(std::memory_order_acquire)) return S_OK;
							if (FAILED(controller_result) || controller == nullptr) {
								if (ready_handler_) {
									ready_handler_(FAILED(controller_result) ? controller_result : E_FAIL);
								}
								return S_OK;
							}
							controller_ = controller;
							if (FAILED(controller_->get_CoreWebView2(&webview_))) {
								if (ready_handler_) {
									ready_handler_(E_FAIL);
								}
								return S_OK;
							}
							const HRESULT configure_result = ConfigureController();
							if (FAILED(configure_result)) {
								if (ready_handler_) ready_handler_(configure_result);
								return S_OK;
							}
							const HRESULT bridge_result = webview_->AddScriptToExecuteOnDocumentCreated(
								kDesktopBridgeScript,
								Microsoft::WRL::Callback<ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler>(
									[this, callback_alive](HRESULT script_result, LPCWSTR) -> HRESULT {
										if (!callback_alive->load(std::memory_order_acquire)) return S_OK;
										bridge_ready_ = SUCCEEDED(script_result);
										if (ready_handler_) {
											ready_handler_(script_result);
										}
										return S_OK;
									})
									.Get());
							if (FAILED(bridge_result) && ready_handler_) {
								ready_handler_(bridge_result);
							}
							return S_OK;
						})
						.Get());
			})
			.Get());
	if (FAILED(started) && ready_handler_) {
		ready_handler_(started);
	}
}

void WebViewHost::Resize() const {
	if (!controller_ || window_ == nullptr) {
		return;
	}
	RECT bounds{};
	GetClientRect(window_, &bounds);
	controller_->put_Bounds(bounds);
}

void WebViewHost::Navigate(std::wstring_view url) {
	const auto origin = TrustedLoopbackOrigin(url);
	if (!webview_ || !bridge_ready_ || !origin) {
		return;
	}
	const std::wstring previous_origin = trusted_loopback_origin_;
	trusted_loopback_origin_ = *origin;
	const std::wstring owned(url);
	if (FAILED(webview_->Navigate(owned.c_str()))) {
		trusted_loopback_origin_ = previous_origin;
	}
}

void WebViewHost::Reload() const {
	if (webview_ && bridge_ready_) {
		webview_->Reload();
	}
}

void WebViewHost::ExecuteScript(std::wstring_view script) const {
	if (!webview_ || !bridge_ready_) {
		return;
	}
	const std::wstring owned(script);
	webview_->ExecuteScript(owned.c_str(), nullptr);
}

void WebViewHost::PostJson(std::wstring_view json) const {
	if (!webview_ || !bridge_ready_) {
		return;
	}
	const std::wstring owned(json);
	webview_->PostWebMessageAsJson(owned.c_str());
}

void WebViewHost::ShowWelcome() {
	if (!webview_ || !bridge_ready_) {
		return;
	}
	std::wstring page = LR"html(<!doctype html><html lang="zh-CN" data-theme=")html";
	page.append(dark_theme_ ? L"dark" : L"light");
	page.append(LR"html("><meta charset="utf-8"><title>Grimoire Router App</title>)html");
	page.append(kPageStyle);
	page.append(L"<body>");
	page.append(kFallbackTitlebar);
	page.append(LR"html(<main class="card"><h1>从一个项目开始</h1>
<p>选择本地项目后，Grimoire Router App 会在后台启动 Core，并在这个原生窗口中打开会话。模型凭据仍由 Core 管理。</p>
<button onclick="chrome.webview.postMessage('open-project')">打开项目</button></main></body></html>)html");
	pending_inline_navigation_ = true;
	if (FAILED(webview_->NavigateToString(page.c_str()))) {
		pending_inline_navigation_ = false;
	}
}

void WebViewHost::ShowStatus(std::wstring_view title, std::wstring_view detail, bool is_error) {
	if (!webview_ || !bridge_ready_) {
		return;
	}
	std::wstring page = LR"html(<!doctype html><html lang="zh-CN" data-theme=")html";
	page.append(dark_theme_ ? L"dark" : L"light");
	page.append(LR"html("><meta charset="utf-8"><title>Grimoire Router App</title>)html");
	page.append(kPageStyle);
	page.append(L"<body>");
	page.append(kFallbackTitlebar);
	page.append(is_error ? L"<main class=\"card error\">" : L"<main class=\"card\">");
	if (is_error) {
		page.append(L"<div class=\"error-mark\">!</div>");
	}
	page.append(L"<h1>");
	page.append(HtmlEscape(title));
	page.append(L"</h1>");
	if (!detail.empty()) {
		page.append(L"<div class=\"detail\">");
		page.append(HtmlEscape(detail));
		page.append(L"</div>");
	}
	if (is_error) {
		page.append(L"<button onclick=\"chrome.webview.postMessage('open-project')\">选择其他项目</button>");
	}
	page.append(L"</main></body></html>");
	pending_inline_navigation_ = true;
	if (FAILED(webview_->NavigateToString(page.c_str()))) {
		pending_inline_navigation_ = false;
	}
}

bool WebViewHost::ready() const noexcept {
	return webview_ != nullptr && bridge_ready_;
}

HRESULT WebViewHost::ConfigureController() {
	Resize();
	SetDarkTheme(dark_theme_);
	const auto callback_alive = callback_alive_;

	Microsoft::WRL::ComPtr<ICoreWebView2Settings> settings;
	if (SUCCEEDED(webview_->get_Settings(&settings))) {
		settings->put_IsStatusBarEnabled(FALSE);
		settings->put_IsZoomControlEnabled(TRUE);
#ifdef NDEBUG
		settings->put_AreDevToolsEnabled(FALSE);
#endif
	}

	HRESULT result = webview_->add_NavigationStarting(
		Microsoft::WRL::Callback<ICoreWebView2NavigationStartingEventHandler>(
			[this, callback_alive](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* arguments) -> HRESULT {
				if (!callback_alive->load(std::memory_order_acquire)) return S_OK;
				try {
				LPWSTR raw_uri = nullptr;
				if (arguments == nullptr || FAILED(arguments->get_Uri(&raw_uri)) || raw_uri == nullptr) {
					if (arguments != nullptr) {
						arguments->put_Cancel(TRUE);
					}
					return S_OK;
				}
				const std::wstring uri(raw_uri);
				CoTaskMemFree(raw_uri);
				const bool expected_inline = pending_inline_navigation_ &&
					(uri == L"about:blank" || IsInlineHtmlDataUri(uri));
				pending_inline_navigation_ = false;
				const auto loopback_origin = TrustedLoopbackOrigin(uri);
				const bool trusted_loopback = loopback_origin && *loopback_origin == trusted_loopback_origin_;
				const bool trusted = expected_inline || trusted_loopback;
				if (expected_inline) {
					active_inline_uri_ = uri;
				} else if (trusted_loopback) {
					active_inline_uri_.clear();
				}
				if (!trusted) {
					arguments->put_Cancel(TRUE);
					BOOL user_initiated = FALSE;
					if (SUCCEEDED(arguments->get_IsUserInitiated(&user_initiated)) && user_initiated) {
						OpenExternalUri(window_, uri);
					}
				}
				return S_OK;
				} catch (...) {
					if (arguments != nullptr) arguments->put_Cancel(TRUE);
					return S_OK;
				}
			})
			.Get(),
		&navigation_token_);
	if (FAILED(result)) return result;

	result = webview_->add_NewWindowRequested(
		Microsoft::WRL::Callback<ICoreWebView2NewWindowRequestedEventHandler>(
			[this, callback_alive](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* arguments) -> HRESULT {
				if (!callback_alive->load(std::memory_order_acquire)) return S_OK;
				try {
				if (arguments == nullptr) {
					return S_OK;
				}
				arguments->put_Handled(TRUE);
				BOOL user_initiated = FALSE;
				LPWSTR raw_uri = nullptr;
				if (SUCCEEDED(arguments->get_IsUserInitiated(&user_initiated)) && user_initiated &&
					SUCCEEDED(arguments->get_Uri(&raw_uri)) && raw_uri != nullptr) {
					const std::wstring uri(raw_uri);
					CoTaskMemFree(raw_uri);
					OpenExternalUri(window_, uri);
				}
				return S_OK;
				} catch (...) {
					if (arguments != nullptr) arguments->put_Handled(TRUE);
					return S_OK;
				}
			})
			.Get(),
		&new_window_token_);
	if (FAILED(result)) return result;

	result = webview_->add_WebMessageReceived(
		Microsoft::WRL::Callback<ICoreWebView2WebMessageReceivedEventHandler>(
			[this, callback_alive](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* arguments) -> HRESULT {
				if (!callback_alive->load(std::memory_order_acquire)) return S_OK;
				try {
				LPWSTR raw_source = nullptr;
				if (arguments == nullptr || FAILED(arguments->get_Source(&raw_source)) || raw_source == nullptr) {
					return S_OK;
				}
				const std::wstring source(raw_source);
				CoTaskMemFree(raw_source);
				const auto source_origin = TrustedLoopbackOrigin(source);
				const bool trusted_source =
					(source_origin && *source_origin == trusted_loopback_origin_) ||
					(!active_inline_uri_.empty() && source == active_inline_uri_);
				if (!trusted_source) {
					return S_OK;
				}
				LPWSTR raw_message = nullptr;
				if (SUCCEEDED(arguments->TryGetWebMessageAsString(&raw_message)) && raw_message != nullptr) {
					std::wstring message(raw_message);
					CoTaskMemFree(raw_message);
					if (message == L"omp-drop-files") {
						Microsoft::WRL::ComPtr<ICoreWebView2WebMessageReceivedEventArgs2> arguments2;
						Microsoft::WRL::ComPtr<ICoreWebView2ObjectCollectionView> objects;
						nlohmann::json paths = nlohmann::json::array();
						if (SUCCEEDED(arguments->QueryInterface(IID_PPV_ARGS(&arguments2))) &&
							SUCCEEDED(arguments2->get_AdditionalObjects(&objects)) && objects != nullptr) {
							UINT32 count = 0;
							if (SUCCEEDED(objects->get_Count(&count))) {
								count = std::min<UINT32>(count, 32U);
								for (UINT32 index = 0; index < count; ++index) {
									Microsoft::WRL::ComPtr<IUnknown> value;
									Microsoft::WRL::ComPtr<ICoreWebView2File> file;
									LPWSTR file_path = nullptr;
									if (SUCCEEDED(objects->GetValueAtIndex(index, &value)) && value != nullptr &&
										SUCCEEDED(value.As(&file)) && SUCCEEDED(file->get_Path(&file_path)) &&
										file_path != nullptr) {
										std::error_code status_error;
										if (wcsnlen_s(file_path, 32'769) <= 32'768 &&
											std::filesystem::is_regular_file(file_path, status_error) && !status_error) {
											paths.push_back(WideToUtf8(file_path));
										}
										CoTaskMemFree(file_path);
									}
								}
							}
						}
						if (!paths.empty()) {
							const std::wstring payload =
								Utf8ToWide(nlohmann::json{{"channel", "omp-files-dropped"}, {"paths", paths}}.dump());
							webview_->PostWebMessageAsJson(payload.c_str());
						}
						return S_OK;
					}
					if (message_handler_) {
						message_handler_(std::move(message));
					}
				}
				return S_OK;
				} catch (...) {
					return S_OK;
				}
			})
			.Get(),
		&message_token_);
	return result;
}

void WebViewHost::SetDarkTheme(bool dark) {
	dark_theme_ = dark;
	if (controller_ != nullptr) {
		Microsoft::WRL::ComPtr<ICoreWebView2Controller2> controller2;
		if (SUCCEEDED(controller_.As(&controller2))) {
			const COREWEBVIEW2_COLOR background =
				dark ? COREWEBVIEW2_COLOR{255, 21, 21, 23} : COREWEBVIEW2_COLOR{255, 255, 255, 255};
			controller2->put_DefaultBackgroundColor(background);
		}
	}
	if (webview_ != nullptr) {
		Microsoft::WRL::ComPtr<ICoreWebView2_13> webview13;
		Microsoft::WRL::ComPtr<ICoreWebView2Profile> profile;
		if (SUCCEEDED(webview_.As(&webview13)) && SUCCEEDED(webview13->get_Profile(&profile)) && profile != nullptr) {
			profile->put_PreferredColorScheme(
				dark ? COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK : COREWEBVIEW2_PREFERRED_COLOR_SCHEME_LIGHT);
		}
		const wchar_t* script = dark
			? L"document.documentElement.dataset.theme='dark'"
			: L"document.documentElement.dataset.theme='light'";
		webview_->ExecuteScript(script, nullptr);
	}
}

} // namespace omp::shell
