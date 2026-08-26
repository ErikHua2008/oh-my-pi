#pragma once

#include <windows.h>
#include <wrl.h>

#include <WebView2.h>

#include <atomic>
#include <functional>
#include <memory>
#include <string>
#include <string_view>

namespace omp::shell {

class WebViewHost final {
public:
	using ReadyHandler = std::function<void(HRESULT)>;
	using MessageHandler = std::function<void(std::wstring)>;

	WebViewHost() = default;
	~WebViewHost();

	WebViewHost(const WebViewHost&) = delete;
	WebViewHost& operator=(const WebViewHost&) = delete;

	void Initialize(HWND window, ReadyHandler ready_handler, MessageHandler message_handler);
	void Resize() const;
	void Navigate(std::wstring_view url);
	void Reload() const;
	void ExecuteScript(std::wstring_view script) const;
	void PostJson(std::wstring_view json) const;
	void SetDarkTheme(bool dark);
	void ShowWelcome();
	void ShowStatus(std::wstring_view title, std::wstring_view detail, bool is_error);

	[[nodiscard]] bool ready() const noexcept;

private:
	[[nodiscard]] HRESULT ConfigureController();

	HWND window_ = nullptr;
	ReadyHandler ready_handler_;
	MessageHandler message_handler_;
	Microsoft::WRL::ComPtr<ICoreWebView2Environment> environment_;
	Microsoft::WRL::ComPtr<ICoreWebView2Controller> controller_;
	Microsoft::WRL::ComPtr<ICoreWebView2> webview_;
	EventRegistrationToken navigation_token_{};
	EventRegistrationToken new_window_token_{};
	EventRegistrationToken message_token_{};
	// WebView2 environment/controller creation completes asynchronously. Keep a
	// token in every callback so a quick application exit cannot dereference the
	// host after its owning App has already been destroyed.
	std::shared_ptr<std::atomic_bool> callback_alive_ = std::make_shared<std::atomic_bool>(true);
	bool pending_inline_navigation_ = false;
	std::wstring active_inline_uri_;
	std::wstring trusted_loopback_origin_;
	bool bridge_ready_ = false;
	bool dark_theme_ = false;
};

} // namespace omp::shell
