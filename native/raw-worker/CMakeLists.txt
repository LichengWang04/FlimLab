cmake_minimum_required(VERSION 3.24)

project(filmlab_raw_worker VERSION 1.0.0 LANGUAGES CXX)

# This executable deliberately links to LibRaw as a normal native executable,
# not as a Node/Electron add-on.  That keeps its ABI independent from the
# Electron version used by the desktop app.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(FILMLAB_LIBRAW_ROOT "" CACHE PATH
  "Optional LibRaw installation prefix (contains include/ and lib/)")
set(FILMLAB_RAW_WORKER_OUTPUT_DIR "" CACHE PATH
  "Release bundle directory for filmlab-raw-worker (for example out/win32-x64)")

find_package(nlohmann_json CONFIG REQUIRED)

# vcpkg's libraw port exposes LibRaw::LibRaw through its compatibility wrapper.
# The other target names below support a direct LibRaw-cmake installation and
# common distro packages.  Prefer the thread-safe raw_r variant where present.
# Modern vcpkg exports lower-case `libraw::raw_r`; retain the FindLibRaw
# fallback for direct/distro installations that only provide legacy variables.
find_package(libraw CONFIG QUIET)
find_package(LibRaw QUIET)

set(FILMLAB_LIBRAW_TARGET "")
foreach(candidate
  libraw::raw_r
  libraw::raw
  libraw::libraw_r
  LibRaw::LibRaw
  LibRaw::libraw_r
  LibRaw::libraw
  raw_r
  raw)
  if(TARGET ${candidate})
    set(FILMLAB_LIBRAW_TARGET ${candidate})
    break()
  endif()
endforeach()

if(NOT FILMLAB_LIBRAW_TARGET)
  find_path(FILMLAB_LIBRAW_INCLUDE_DIR
    NAMES libraw/libraw.h
    HINTS "${FILMLAB_LIBRAW_ROOT}/include")
  find_library(FILMLAB_LIBRAW_LIBRARY
    NAMES raw_r raw libraw
    HINTS "${FILMLAB_LIBRAW_ROOT}/lib" "${FILMLAB_LIBRAW_ROOT}/lib64")

  if(FILMLAB_LIBRAW_INCLUDE_DIR AND FILMLAB_LIBRAW_LIBRARY)
    add_library(filmlab_libraw UNKNOWN IMPORTED)
    set_target_properties(filmlab_libraw PROPERTIES
      IMPORTED_LOCATION "${FILMLAB_LIBRAW_LIBRARY}"
      INTERFACE_INCLUDE_DIRECTORIES "${FILMLAB_LIBRAW_INCLUDE_DIR}")
    set(FILMLAB_LIBRAW_TARGET filmlab_libraw)
  endif()
endif()

if(NOT FILMLAB_LIBRAW_TARGET)
  message(FATAL_ERROR
    "LibRaw 0.22.1 was not found. Configure with the vcpkg toolchain after "
    "running `vcpkg install --triplet <triplet> --x-manifest-root=${CMAKE_CURRENT_SOURCE_DIR}`, "
    "or set FILMLAB_LIBRAW_ROOT to an installed LibRaw 0.22.1 prefix. "
    "See native/raw-worker/README.md.")
endif()

add_executable(filmlab-raw-worker src/main.cpp)
if(MSVC)
  # The release workflow intentionally uses x64-windows-static. Its vcpkg
  # libraries are compiled with /MT, so the sidecar must use the same CRT or
  # MSVC rejects the link with LNK2038 RuntimeLibrary mismatches.
  set_property(TARGET filmlab-raw-worker PROPERTY
    MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()
target_link_libraries(filmlab-raw-worker PRIVATE
  ${FILMLAB_LIBRAW_TARGET}
  nlohmann_json::nlohmann_json)

# A package-provided LibRaw target carries these transitive dependencies. They
# are repeated for the manual FILMLAB_LIBRAW_ROOT fallback, where a static
# raw_r library alone otherwise misses its platform support libraries.
find_package(Threads REQUIRED)
target_link_libraries(filmlab-raw-worker PRIVATE Threads::Threads)
if(WIN32)
  target_link_libraries(filmlab-raw-worker PRIVATE ws2_32)
endif()
target_compile_definitions(filmlab-raw-worker PRIVATE
  FILMLAB_RAW_WORKER_PROTOCOL_VERSION=1)

if(MSVC)
  target_compile_options(filmlab-raw-worker PRIVATE /W4 /permissive-)
else()
  target_compile_options(filmlab-raw-worker PRIVATE -Wall -Wextra -Wpedantic)
endif()

set_target_properties(filmlab-raw-worker PROPERTIES
  OUTPUT_NAME "filmlab-raw-worker")

# CI produces an executable at the exact path consumed by Electron's resource
# resolver.  Keep this opt-in so a normal local CMake build retains its usual
# build-tree layout, while a release build cannot accidentally publish a stale
# executable from an unrelated configuration directory.
if(FILMLAB_RAW_WORKER_OUTPUT_DIR)
  get_filename_component(FILMLAB_RAW_WORKER_OUTPUT_DIR
    "${FILMLAB_RAW_WORKER_OUTPUT_DIR}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
  set_target_properties(filmlab-raw-worker PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${FILMLAB_RAW_WORKER_OUTPUT_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${FILMLAB_RAW_WORKER_OUTPUT_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${FILMLAB_RAW_WORKER_OUTPUT_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${FILMLAB_RAW_WORKER_OUTPUT_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${FILMLAB_RAW_WORKER_OUTPUT_DIR}")
endif()

install(TARGETS filmlab-raw-worker
  RUNTIME DESTINATION raw-worker)
