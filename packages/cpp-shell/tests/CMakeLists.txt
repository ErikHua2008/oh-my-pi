add_executable(
	omp_shell_tests
	config_test.cpp
	core_process_integration_test.cpp
	core_output_parser_test.cpp
	native_transcript_controls_test.cpp
	native_transcript_model_test.cpp
	native_transcript_theme_test.cpp
	path_utils_test.cpp
	test_main.cpp
	text_utils_test.cpp
	window_layout_test.cpp
	windows_command_line_test.cpp
)
target_link_libraries(omp_shell_tests PRIVATE omp_shell_runtime)
target_compile_definitions(omp_shell_tests PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)

if(MSVC)
	target_compile_options(omp_shell_tests PRIVATE /W4 /WX /permissive- /EHsc /utf-8 /Zc:__cplusplus)
endif()

add_test(NAME omp_shell_tests COMMAND omp_shell_tests)
