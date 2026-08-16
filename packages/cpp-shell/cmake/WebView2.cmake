include(FetchContent)

# Pin the SDK so local builds and CI compile against the same WebView2 API.
# The Evergreen runtime remains independently serviced by Microsoft.
set(OMP_WEBVIEW2_VERSION "1.0.4129.50" CACHE STRING "Microsoft.Web.WebView2 NuGet version")

FetchContent_Declare(
	webview2_sdk
	URL "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${OMP_WEBVIEW2_VERSION}/microsoft.web.webview2.${OMP_WEBVIEW2_VERSION}.nupkg"
	DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(webview2_sdk)

set(OMP_WEBVIEW2_NATIVE_DIR "${webview2_sdk_SOURCE_DIR}/build/native")
set(OMP_WEBVIEW2_LOADER "${OMP_WEBVIEW2_NATIVE_DIR}/x64/WebView2LoaderStatic.lib")

if(NOT EXISTS "${OMP_WEBVIEW2_NATIVE_DIR}/include/WebView2.h")
	message(FATAL_ERROR "WebView2 SDK headers were not found in ${OMP_WEBVIEW2_NATIVE_DIR}")
endif()

if(NOT EXISTS "${OMP_WEBVIEW2_LOADER}")
	message(FATAL_ERROR "WebView2 x64 static loader was not found at ${OMP_WEBVIEW2_LOADER}")
endif()

add_library(omp_webview2_loader STATIC IMPORTED GLOBAL)
set_target_properties(omp_webview2_loader PROPERTIES IMPORTED_LOCATION "${OMP_WEBVIEW2_LOADER}")

add_library(omp_webview2 INTERFACE)
target_include_directories(omp_webview2 INTERFACE "${OMP_WEBVIEW2_NATIVE_DIR}/include")
target_link_libraries(omp_webview2 INTERFACE omp_webview2_loader)
