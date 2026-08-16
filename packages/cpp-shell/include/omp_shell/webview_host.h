#pragma once

#include <windows.h>
#include <wrl.h>

#include <WebView2.h>

#include <functional>
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
	void Navigate(std::wstring_view url) const;
	void Reload() const;
	void ExecuteScript(std::wstring_view script) const;
	void PostJson(std::wstring_view json) const;
	void ShowWelcome() const;
	void ShowStatus(std::wstring_view title, std::wstring_view detail, bool is_error) const;

	[[nodiscard]] bool ready() const noexcept;

private:
	void ConfigureController();

	HWND window_ = nullptr;
	ReadyHandler ready_handler_;
	MessageHandler message_handler_;
	Microsoft::WRL::ComPtr<ICoreWebView2Environment> environment_;
	Microsoft::WRL::ComPtr<ICoreWebView2Controller> controller_;
	Microsoft::WRL::ComPtr<ICoreWebView2> webview_;
	EventRegistrationToken message_token_{};
};

} // namespace omp::shell
