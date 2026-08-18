cmake_minimum_required(VERSION 3.25)

project(
	omp_cpp_shell
	VERSION 0.1.0
	DESCRIPTION "Native Windows host for omp core"
	LANGUAGES CXX
)

enable_language(RC)

if(NOT WIN32)
	message(FATAL_ERROR "omp cpp-shell currently supports Windows only")
endif()

if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
	message(FATAL_ERROR "omp cpp-shell MVP currently supports x64 only")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(OMP_CPP_SHELL_BUILD_TESTS "Build cpp-shell unit tests" ON)
option(OMP_CPP_SHELL_BUILD_WEB_ASSETS "Rebuild collab-web assets with the native shell" ON)
option(OMP_CPP_SHELL_BUILD_CORE_BUNDLE "Rebuild the single-file coding-agent Core bundle" ON)

get_filename_component(OMP_REPOSITORY_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)

if(OMP_CPP_SHELL_BUILD_WEB_ASSETS OR OMP_CPP_SHELL_BUILD_CORE_BUNDLE)
	find_program(OMP_BUN_EXECUTABLE NAMES bun bun.exe REQUIRED)

	if(OMP_CPP_SHELL_BUILD_WEB_ASSETS)
		set(OMP_COLLAB_WEB_DIRECTORY "${OMP_REPOSITORY_ROOT}/packages/collab-web")
		add_custom_target(
			omp_collab_web_assets ALL
			COMMAND "${OMP_BUN_EXECUTABLE}" run build
			WORKING_DIRECTORY "${OMP_COLLAB_WEB_DIRECTORY}"
			COMMENT "Rebuilding collab-web assets for the C++ shell"
			VERBATIM
			USES_TERMINAL
		)
	endif()

	if(OMP_CPP_SHELL_BUILD_CORE_BUNDLE)
		set(OMP_CODING_AGENT_DIRECTORY "${OMP_REPOSITORY_ROOT}/packages/coding-agent")
		set(OMP_CODING_AGENT_BUNDLE "${OMP_CODING_AGENT_DIRECTORY}/dist/cli.js")
		file(
			GLOB_RECURSE OMP_CODING_AGENT_BUNDLE_INPUTS
			CONFIGURE_DEPENDS
			"${OMP_REPOSITORY_ROOT}/packages/*/src/*.js"
			"${OMP_REPOSITORY_ROOT}/packages/*/src/*.json"
			"${OMP_REPOSITORY_ROOT}/packages/*/src/*.md"
			"${OMP_REPOSITORY_ROOT}/packages/*/src/*.ts"
			"${OMP_REPOSITORY_ROOT}/packages/*/src/*.tsx"
			"${OMP_CODING_AGENT_DIRECTORY}/scripts/*.ts"
		)
		add_custom_command(
			OUTPUT "${OMP_CODING_AGENT_BUNDLE}"
			COMMAND "${OMP_BUN_EXECUTABLE}" run gen:bundle
			WORKING_DIRECTORY "${OMP_CODING_AGENT_DIRECTORY}"
			DEPENDS
				${OMP_CODING_AGENT_BUNDLE_INPUTS}
				"${OMP_REPOSITORY_ROOT}/bun.lock"
				"${OMP_REPOSITORY_ROOT}/package.json"
				"${OMP_CODING_AGENT_DIRECTORY}/package.json"
			COMMENT "Rebuilding the single-file OMP Core bundle"
			VERBATIM
		)
		add_custom_target(omp_coding_agent_bundle DEPENDS "${OMP_CODING_AGENT_BUNDLE}")
	endif()
endif()

# The resource script references these ICO files by path. Resource compilers do
# not reliably report those indirect dependencies to Visual Studio/MSBuild, so
# changing only an ICO could otherwise leave the previous icon embedded in the
# executable. Make the relationship explicit for every generator.
set(OMP_GRIMOIRE_ICON_LIGHT "${OMP_REPOSITORY_ROOT}/packages/collab-web/public/grimoire-cube-on-light.ico")
set(OMP_GRIMOIRE_ICON_DARK "${OMP_REPOSITORY_ROOT}/packages/collab-web/public/grimoire-cube-on-dark.ico")
set_property(
	SOURCE src/omp_shell.rc
	APPEND
	PROPERTY OBJECT_DEPENDS "${OMP_GRIMOIRE_ICON_LIGHT};${OMP_GRIMOIRE_ICON_DARK}"
)

include(cmake/Dependencies.cmake)

add_library(
	omp_shell_base STATIC
	src/config.cpp
	src/core_output_parser.cpp
	src/native_transcript_controls.cpp
	src/native_transcript_model.cpp
	src/path_utils.cpp
	src/screenshot_geometry.cpp
	src/text_utils.cpp
	src/window_layout.cpp
	src/windows_command_line.cpp
)
target_include_directories(omp_shell_base PUBLIC include)
target_compile_definitions(omp_shell_base PUBLIC UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
target_link_libraries(omp_shell_base PUBLIC nlohmann_json::nlohmann_json)

add_library(omp_shell_runtime STATIC src/core_process.cpp)
target_include_directories(omp_shell_runtime PUBLIC include)
target_link_libraries(omp_shell_runtime PUBLIC omp_shell_base)
target_compile_definitions(omp_shell_runtime PUBLIC UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)

include(cmake/WebView2.cmake)

add_executable(
	omp-cpp-shell WIN32
	src/app.cpp
	src/main.cpp
	src/native_menu.cpp
	src/native_transcript_view.cpp
	src/screenshot_overlay.cpp
	src/omp_shell.rc
	src/webview_host.cpp
)
if(TARGET omp_collab_web_assets)
	add_dependencies(omp-cpp-shell omp_collab_web_assets)
endif()
if(TARGET omp_coding_agent_bundle)
	add_dependencies(omp-cpp-shell omp_coding_agent_bundle)
endif()
target_include_directories(omp-cpp-shell PRIVATE include)
target_compile_definitions(omp-cpp-shell PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
target_link_libraries(
	omp-cpp-shell
	PRIVATE
		omp_shell_runtime
		omp_webview2
		comctl32
		crypt32
		d2d1
		dwmapi
		dwrite
		gdi32
		ole32
		shell32
		shlwapi
		user32
		windowscodecs
)

if(MSVC)
	foreach(target omp_shell_base omp_shell_runtime omp-cpp-shell)
		target_compile_options(${target} PRIVATE /W4 /WX /permissive- /EHsc /utf-8 /Zc:__cplusplus)
	endforeach()
	target_link_options(omp-cpp-shell PRIVATE /SUBSYSTEM:WINDOWS)
endif()

include(CTest)
if(BUILD_TESTING AND OMP_CPP_SHELL_BUILD_TESTS)
	add_subdirectory(tests)
endif()

install(TARGETS omp-cpp-shell RUNTIME DESTINATION .)
