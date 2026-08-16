#include "omp_shell/webview_host.h"

#include <ShlObj.h>

#include <filesystem>
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
			escaped.push_back(ch);
			break;
		}
	}
	return escaped;
}

constexpr std::wstring_view kPageStyle = LR"css(
<style>
:root { color-scheme: dark; font-family: "Segoe UI Variable", "Microsoft YaHei UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; padding-top: 36px; display: grid; place-items: center; background: #202123; color: #f2f2f2; }
.shellbar { position: fixed; inset: 0 0 auto; height: 36px; display: flex; align-items: stretch; z-index: 10;
  background: #1b1b1c; border-bottom: 1px solid #34363a; user-select: none; }
.shellbar-drag { flex: 1; min-width: 40px; }
.shellbar-title { display: flex; align-items: center; padding-left: 14px; color: #b8babf; font-size: 12px; }
.shellbar-controls { display: flex; }
.shellbar-controls button { width: 46px; height: 35px; margin: 0; padding: 0; border-radius: 0; color: #b8babf;
  background: transparent; font-size: 16px; font-weight: 400; }
.shellbar-controls button:hover { color: white; background: #373739; }
.shellbar-controls .shellbar-close:hover { background: #c42b1c; }
.card { width: min(620px, calc(100vw - 48px)); padding: 44px; border: 1px solid #34363a; border-radius: 18px;
  background: #282a2d; box-shadow: 0 24px 80px rgba(0,0,0,.28); }
.mark { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 12px; margin-bottom: 24px;
  background: #f2f2f2; color: #202123; font-size: 22px; font-weight: 700; }
h1 { margin: 0 0 12px; font-size: 25px; font-weight: 620; letter-spacing: -.02em; }
p { margin: 0; color: #b8babf; font-size: 14px; line-height: 1.65; }
.detail { margin-top: 18px; padding: 14px 16px; max-height: 220px; overflow: auto; border-radius: 10px;
  background: #1f2022; color: #c7c9ce; font: 12px/1.55 Consolas, monospace; overflow-wrap: anywhere; }
button { margin-top: 28px; border: 0; border-radius: 9px; padding: 10px 17px; background: #f2f2f2; color: #202123;
  font: 600 14px "Segoe UI Variable", sans-serif; cursor: pointer; }
button:hover { background: white; }
.error .mark { background: #e45b5b; color: white; }
.error h1 { color: #ffdfdf; }
</style>
)css";

constexpr std::wstring_view kFallbackTitlebar = LR"html(
<header class="shellbar">
  <span class="shellbar-title">OMP</span>
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
})();
)js";

} // namespace

WebViewHost::~WebViewHost() {
	if (webview_ && message_token_.value != 0) {
		webview_->remove_WebMessageReceived(message_token_);
	}
	if (controller_) {
		controller_->Close();
	}
}

void WebViewHost::Initialize(HWND window, ReadyHandler ready_handler, MessageHandler message_handler) {
	window_ = window;
	ready_handler_ = std::move(ready_handler);
	message_handler_ = std::move(message_handler);
	const std::wstring user_data = WebViewDataDirectory();
	const wchar_t* user_data_path = user_data.empty() ? nullptr : user_data.c_str();

	const HRESULT started = CreateCoreWebView2EnvironmentWithOptions(nullptr,
		user_data_path,
		nullptr,
		Microsoft::WRL::Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
			[this](HRESULT result, ICoreWebView2Environment* environment) -> HRESULT {
				if (FAILED(result) || environment == nullptr) {
					if (ready_handler_) {
						ready_handler_(FAILED(result) ? result : E_FAIL);
					}
					return S_OK;
				}
				environment_ = environment;
				return environment_->CreateCoreWebView2Controller(window_,
					Microsoft::WRL::Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
						[this](HRESULT controller_result, ICoreWebView2Controller* controller) -> HRESULT {
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
							ConfigureController();
							const HRESULT bridge_result = webview_->AddScriptToExecuteOnDocumentCreated(
								kDesktopBridgeScript,
								Microsoft::WRL::Callback<ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler>(
									[this](HRESULT script_result, LPCWSTR) -> HRESULT {
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

void WebViewHost::Navigate(std::wstring_view url) const {
	if (!webview_) {
		return;
	}
	const std::wstring owned(url);
	webview_->Navigate(owned.c_str());
}

void WebViewHost::Reload() const {
	if (webview_) {
		webview_->Reload();
	}
}

void WebViewHost::ExecuteScript(std::wstring_view script) const {
	if (!webview_) {
		return;
	}
	const std::wstring owned(script);
	webview_->ExecuteScript(owned.c_str(), nullptr);
}

void WebViewHost::PostJson(std::wstring_view json) const {
	if (!webview_) {
		return;
	}
	const std::wstring owned(json);
	webview_->PostWebMessageAsJson(owned.c_str());
}

void WebViewHost::ShowWelcome() const {
	if (!webview_) {
		return;
	}
	std::wstring page = LR"html(<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>OMP</title>)html";
	page.append(kPageStyle);
	page.append(L"<body>");
	page.append(kFallbackTitlebar);
	page.append(LR"html(<main class="card"><div class="mark">O</div><h1>从一个项目开始</h1>
<p>选择本地项目后，OMP 会在后台启动 Core，并在这个原生窗口中打开会话。模型凭据仍由 OMP 管理。</p>
<button onclick="chrome.webview.postMessage('open-project')">打开项目</button></main></body></html>)html");
	webview_->NavigateToString(page.c_str());
}

void WebViewHost::ShowStatus(std::wstring_view title, std::wstring_view detail, bool is_error) const {
	if (!webview_) {
		return;
	}
	std::wstring page = LR"html(<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>OMP</title>)html";
	page.append(kPageStyle);
	page.append(L"<body>");
	page.append(kFallbackTitlebar);
	page.append(is_error ? L"<main class=\"card error\">" : L"<main class=\"card\">");
	page.append(is_error ? L"<div class=\"mark\">!</div>" : L"<div class=\"mark\">O</div>");
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
	webview_->NavigateToString(page.c_str());
}

bool WebViewHost::ready() const noexcept {
	return webview_ != nullptr;
}

void WebViewHost::ConfigureController() {
	Resize();
	SetDarkTheme(false);

	Microsoft::WRL::ComPtr<ICoreWebView2Settings> settings;
	if (SUCCEEDED(webview_->get_Settings(&settings))) {
		settings->put_IsStatusBarEnabled(FALSE);
		settings->put_IsZoomControlEnabled(TRUE);
#ifdef NDEBUG
		settings->put_AreDevToolsEnabled(FALSE);
#endif
	}

	webview_->add_WebMessageReceived(
		Microsoft::WRL::Callback<ICoreWebView2WebMessageReceivedEventHandler>(
			[this](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* arguments) -> HRESULT {
				LPWSTR raw_message = nullptr;
				if (SUCCEEDED(arguments->TryGetWebMessageAsString(&raw_message)) && raw_message != nullptr) {
					std::wstring message(raw_message);
					CoTaskMemFree(raw_message);
					if (message_handler_) {
						message_handler_(std::move(message));
					}
				}
				return S_OK;
			})
			.Get(),
		&message_token_);
}

void WebViewHost::SetDarkTheme(bool dark) const {
	if (controller_ == nullptr) {
		return;
	}
	Microsoft::WRL::ComPtr<ICoreWebView2Controller2> controller2;
	if (SUCCEEDED(controller_.As(&controller2))) {
		const COREWEBVIEW2_COLOR background =
			dark ? COREWEBVIEW2_COLOR{255, 21, 21, 23} : COREWEBVIEW2_COLOR{255, 255, 255, 255};
		controller2->put_DefaultBackgroundColor(background);
	}
}

} // namespace omp::shell
