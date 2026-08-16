include(FetchContent)

set(JSON_BuildTests OFF CACHE INTERNAL "Disable nlohmann/json tests")
set(JSON_Install OFF CACHE INTERNAL "Disable nlohmann/json install rules")
FetchContent_Declare(
	nlohmann_json
	URL "https://github.com/nlohmann/json/releases/download/v3.12.0/json.tar.xz"
	DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(nlohmann_json)
