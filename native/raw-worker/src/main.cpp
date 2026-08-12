// FilmLab's RAW decoder sidecar.
//
// stdin and stdout are a JSON Lines protocol. stdout must never receive log
// lines: the Electron utility process uses it as a strict response channel.
// The only pixel output is a headerless RGB16LE cache written to cachePath.
// In particular, this program never calls LibRaw's dcraw_process(), thumbnail
// APIs, or JPEG writer, so it cannot silently substitute an embedded preview.

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <exception>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <libraw/libraw.h>
#include <libraw/libraw_version.h>
#include <nlohmann/json.hpp>

#ifndef FILMLAB_RAW_WORKER_PROTOCOL_VERSION
#define FILMLAB_RAW_WORKER_PROTOCOL_VERSION 1
#endif

#if LIBRAW_MAJOR_VERSION != 0 || LIBRAW_MINOR_VERSION != 22 || \
    LIBRAW_PATCH_VERSION != 1
#error "FilmLab raw worker is pinned to LibRaw 0.22.1. Update and validate the decoder fingerprint intentionally."
#endif

namespace {

using Json = nlohmann::json;
namespace fs = std::filesystem;

constexpr std::string_view kCacheFormat = "filmlab-rgb16le-v1";
constexpr std::string_view kBayerCacheFormat = "filmlab-bayer16le-v1";
constexpr std::string_view kDemosaicName = "edge-aware-bayer-v2";
constexpr std::string_view kLegacyDemosaicName = "bilinear-bayer-v1";
constexpr std::string_view kGpuDemosaicName = "gpu-edge-aware-bayer-v2";
constexpr int kOutputChannels = 3;

class ProtocolError final : public std::runtime_error {
 public:
  ProtocolError(std::string code, std::string message)
      : std::runtime_error(std::move(message)), code_(std::move(code)) {}

  [[nodiscard]] const std::string& code() const noexcept { return code_; }

 private:
  std::string code_;
};

struct Tap {
  int dx = 0;
  int dy = 0;
  double weight = 0.0;
};

struct BayerLayout {
  // LibRaw color identifiers for the active area's 2×2 tile.  Identifiers 1
  // and 3 are both green but keep separate black levels in color.cblack.
  std::array<int, 4> rawColors{};
  std::array<std::array<std::array<std::vector<Tap>, 3>, 2>, 2> kernels{};

  [[nodiscard]] int rawColorAt(int y, int x) const {
    const int parityY = positiveMod(y, 2);
    const int parityX = positiveMod(x, 2);
    return rawColors[static_cast<std::size_t>(parityY * 2 + parityX)];
  }

  static int positiveMod(int value, int modulo) {
    const int remainder = value % modulo;
    return remainder < 0 ? remainder + modulo : remainder;
  }
};

[[nodiscard]] std::string toUtf8(const fs::path& path) {
  const auto value = path.u8string();
  return {value.begin(), value.end()};
}

[[nodiscard]] fs::path fromUtf8(const std::string& value) {
  return fs::u8path(value);
}

template <std::size_t N>
[[nodiscard]] std::string boundedCString(const char (&value)[N]) {
  std::size_t length = 0;
  while (length < N && value[length] != '\0') {
    ++length;
  }
  return {value, length};
}

[[nodiscard]] int canonicalColor(const int rawColor) {
  switch (rawColor) {
    case 0:
      return 0;  // red
    case 1:
    case 3:
      return 1;  // green (two Bayer positions)
    case 2:
      return 2;  // blue
    default:
      throw ProtocolError("UNSUPPORTED_CFA", "LibRaw returned a non-Bayer color channel");
  }
}

[[nodiscard]] int mirrorIndex(int value, const int size) {
  if (size <= 1) {
    return 0;
  }

  // Reflection keeps the first valid pixel at each edge. It preserves the
  // normal 3×3 bilinear kernel without shrinking the active frame by one row
  // or column.
  while (value < 0 || value >= size) {
    value = value < 0 ? -value : (2 * size - 2 - value);
  }
  return value;
}

[[nodiscard]] std::string requireString(const Json& object, const char* key) {
  const auto found = object.find(key);
  if (found == object.end() || !found->is_string() || found->get_ref<const std::string&>().empty()) {
    throw ProtocolError("INVALID_REQUEST", std::string("Missing non-empty string field: ") + key);
  }
  return found->get<std::string>();
}

void writeJson(const Json& value) {
  std::cout << value.dump() << '\n' << std::flush;
}

void writeProgress(const Json& id, const std::string_view stage, const double fraction) {
  writeJson({
      {"id", id},
      {"event", "progress"},
      {"stage", std::string(stage)},
      {"fraction", std::clamp(fraction, 0.0, 1.0)},
  });
}

void writeFailure(const Json& id, const std::string_view code, const std::string& message) {
  writeJson({
      {"id", id},
      {"ok", false},
      {"error", {{"code", code}, {"message", message}}},
  });
}

[[nodiscard]] bool isSupportedBayer(LibRaw& raw) {
  // filters == 0 covers already-RGB/non-mosaic data. filters == 9 is the
  // LibRaw marker used for X-Trans. Both must be handled by a dedicated
  // decoder/demosaicer rather than being guessed as Bayer.
  return raw.imgdata.idata.filters != 0 && raw.imgdata.idata.filters != 9 &&
         raw.imgdata.rawdata.raw_image != nullptr && !raw.is_sraw();
}

[[nodiscard]] BayerLayout buildBayerLayout(LibRaw& raw, const int top, const int left,
                                            const int height, const int width) {
  BayerLayout layout;
  std::array<int, 3> counts{};

  for (int y = 0; y < 2; ++y) {
    for (int x = 0; x < 2; ++x) {
      const int rawColor = raw.COLOR(top + y, left + x);
      const int canonical = canonicalColor(rawColor);
      layout.rawColors[static_cast<std::size_t>(y * 2 + x)] = rawColor;
      ++counts[static_cast<std::size_t>(canonical)];
    }
  }

  if (counts != std::array<int, 3>{1, 2, 1}) {
    throw ProtocolError("UNSUPPORTED_CFA", "The active image area is not a 2×2 Bayer CFA");
  }

  // A 2×2 count alone is not sufficient for Fuji rotated layouts or another
  // non-periodic arrangement that happens to begin with RGGB-like values.
  // Validate the tile repeats before applying a Bayer-only interpolation.
  for (int y = 0; y < std::min(4, height); ++y) {
    for (int x = 0; x < std::min(4, width); ++x) {
      if (raw.COLOR(top + y, left + x) != layout.rawColorAt(y, x)) {
        throw ProtocolError("UNSUPPORTED_CFA", "The active image area does not repeat a 2×2 Bayer CFA");
      }
    }
  }

  for (int parityY = 0; parityY < 2; ++parityY) {
    for (int parityX = 0; parityX < 2; ++parityX) {
      const int sourceColor = canonicalColor(layout.rawColorAt(parityY, parityX));
      for (int targetColor = 0; targetColor < 3; ++targetColor) {
        auto& kernel = layout.kernels[static_cast<std::size_t>(parityY)]
                                     [static_cast<std::size_t>(parityX)]
                                     [static_cast<std::size_t>(targetColor)];

        // Keep an actually sampled value unchanged. Only interpolate channels
        // absent at the CFA location.
        if (targetColor == sourceColor) {
          kernel.push_back({0, 0, 1.0});
          continue;
        }

        for (int dy = -1; dy <= 1; ++dy) {
          for (int dx = -1; dx <= 1; ++dx) {
            const int candidateColor = canonicalColor(layout.rawColorAt(parityY + dy, parityX + dx));
            if (candidateColor != targetColor) {
              continue;
            }
            const int distanceSquared = dx * dx + dy * dy;
            if (distanceSquared == 0) {
              continue;
            }
            kernel.push_back({dx, dy, 1.0 / static_cast<double>(distanceSquared)});
          }
        }

        if (kernel.empty()) {
          throw ProtocolError("UNSUPPORTED_CFA", "Bayer interpolation kernel could not be formed");
        }
      }
    }
  }

  return layout;
}

[[nodiscard]] double normalizedSample(const LibRaw& raw, const BayerLayout& layout,
                                      const int top, const int left, const int y, const int x) {
  const int rawHeight = static_cast<int>(raw.imgdata.sizes.raw_height);
  const int rawWidth = static_cast<int>(raw.imgdata.sizes.raw_width);
  const int rawY = top + y;
  const int rawX = left + x;

  if (rawY < 0 || rawY >= rawHeight || rawX < 0 || rawX >= rawWidth) {
    throw ProtocolError("INVALID_RAW_LAYOUT", "Active area exceeds LibRaw's unpacked sensor buffer");
  }

  const int rawColor = layout.rawColorAt(y, x);
  const auto* rawPixels = raw.imgdata.rawdata.raw_image;
  const std::uint32_t sample = rawPixels[static_cast<std::size_t>(rawY) *
                                         static_cast<std::size_t>(rawWidth) +
                                         static_cast<std::size_t>(rawX)];
  // LibRaw semantics: when color.cblack[0] is non-zero, cblack[0..3] hold
  // the per-CFA-channel black levels and color.black is ignored; when it is
  // zero, every channel uses the global color.black. The previous
  // per-channel `channel == 0 ? global : channel` fallback misread cameras
  // whose per-channel table legitimately contains a zero entry, biasing one
  // CFA channel against the others and colouring the shadows.
  const std::uint32_t black = raw.imgdata.color.cblack[0] != 0
                                  ? raw.imgdata.color.cblack[rawColor]
                                  : raw.imgdata.color.black;
  const std::uint32_t maximum = raw.imgdata.color.maximum == 0
                                    ? std::numeric_limits<std::uint16_t>::max()
                                    : raw.imgdata.color.maximum;

  if (maximum <= black) {
    throw ProtocolError("INVALID_RAW_LEVELS", "LibRaw reported a white level at or below the black level");
  }

  const double normalized = (static_cast<double>(sample) - static_cast<double>(black)) /
                            (static_cast<double>(maximum) - static_cast<double>(black));
  return std::clamp(normalized, 0.0, 1.0);
}

[[nodiscard]] double demosaicChannel(const LibRaw& raw, const BayerLayout& layout,
                                     const int top, const int left, const int height,
                                     const int width, const int y, const int x,
                                     const int targetColor) {
  const auto& taps = layout.kernels[static_cast<std::size_t>(y & 1)]
                                  [static_cast<std::size_t>(x & 1)]
                                  [static_cast<std::size_t>(targetColor)];
  double weightedValue = 0.0;
  double weights = 0.0;

  for (const Tap& tap : taps) {
    const int sampleY = mirrorIndex(y + tap.dy, height);
    const int sampleX = mirrorIndex(x + tap.dx, width);
    if (canonicalColor(layout.rawColorAt(sampleY, sampleX)) != targetColor) {
      // This can only happen at a reflected edge. Ignore the bad reflected
      // sample instead of borrowing a value from a different color plane.
      continue;
    }
    weightedValue += normalizedSample(raw, layout, top, left, sampleY, sampleX) * tap.weight;
    weights += tap.weight;
  }

  if (weights == 0.0) {
    throw ProtocolError("UNSUPPORTED_CFA", "Bayer interpolation failed at an image boundary");
  }
  return weightedValue / weights;
}

[[nodiscard]] double normalizedMirroredSample(
    const LibRaw& raw, const BayerLayout& layout, const int top, const int left,
    const int height, const int width, const int y, const int x) {
  return normalizedSample(raw, layout, top, left,
                          mirrorIndex(y, height), mirrorIndex(x, width));
}

[[nodiscard]] double edgeAwareGreen(
    const LibRaw& raw, const BayerLayout& layout, const int top, const int left,
    const int height, const int width, const int y, const int x) {
  if (canonicalColor(layout.rawColorAt(y, x)) == 1) {
    return normalizedMirroredSample(raw, layout, top, left, height, width, y, x);
  }
  const double center = normalizedMirroredSample(raw, layout, top, left, height, width, y, x);
  const double left1 = normalizedMirroredSample(raw, layout, top, left, height, width, y, x - 1);
  const double right1 = normalizedMirroredSample(raw, layout, top, left, height, width, y, x + 1);
  const double left2 = normalizedMirroredSample(raw, layout, top, left, height, width, y, x - 2);
  const double right2 = normalizedMirroredSample(raw, layout, top, left, height, width, y, x + 2);
  const double up1 = normalizedMirroredSample(raw, layout, top, left, height, width, y - 1, x);
  const double down1 = normalizedMirroredSample(raw, layout, top, left, height, width, y + 1, x);
  const double up2 = normalizedMirroredSample(raw, layout, top, left, height, width, y - 2, x);
  const double down2 = normalizedMirroredSample(raw, layout, top, left, height, width, y + 2, x);
  const double horizontal = (left1 + right1) * 0.5 + (2.0 * center - left2 - right2) * 0.25;
  const double vertical = (up1 + down1) * 0.5 + (2.0 * center - up2 - down2) * 0.25;
  const double horizontalGradient = std::abs(left1 - right1) + std::abs(2.0 * center - left2 - right2);
  const double verticalGradient = std::abs(up1 - down1) + std::abs(2.0 * center - up2 - down2);
  const double estimate = horizontalGradient < verticalGradient
                              ? horizontal
                              : verticalGradient < horizontalGradient ? vertical : (horizontal + vertical) * 0.5;
  return std::clamp(estimate, 0.0, 1.0);
}

[[nodiscard]] double edgeAwareDemosaicChannel(
    const LibRaw& raw, const BayerLayout& layout, const int top, const int left,
    const int height, const int width, const int y, const int x,
    const int targetColor) {
  const int sourceColor = canonicalColor(layout.rawColorAt(y, x));
  if (sourceColor == targetColor) {
    return normalizedMirroredSample(raw, layout, top, left, height, width, y, x);
  }
  const double centerGreen = edgeAwareGreen(raw, layout, top, left, height, width, y, x);
  if (targetColor == 1) return centerGreen;

  double differences = 0.0;
  int count = 0;
  const auto accumulateDifference = [&](const int sampleY, const int sampleX) {
    const int mirroredY = mirrorIndex(sampleY, height);
    const int mirroredX = mirrorIndex(sampleX, width);
    if (canonicalColor(layout.rawColorAt(mirroredY, mirroredX)) != targetColor) return;
    const double color = normalizedSample(raw, layout, top, left, mirroredY, mirroredX);
    const double green = edgeAwareGreen(raw, layout, top, left, height, width, mirroredY, mirroredX);
    differences += color - green;
    ++count;
  };

  if (sourceColor == 1) {
    const bool targetIsHorizontal = canonicalColor(layout.rawColorAt(y, x + 1)) == targetColor;
    if (targetIsHorizontal) {
      accumulateDifference(y, x - 1);
      accumulateDifference(y, x + 1);
    } else {
      accumulateDifference(y - 1, x);
      accumulateDifference(y + 1, x);
    }
  } else {
    accumulateDifference(y - 1, x - 1);
    accumulateDifference(y - 1, x + 1);
    accumulateDifference(y + 1, x - 1);
    accumulateDifference(y + 1, x + 1);
  }
  if (count == 0) {
    return demosaicChannel(raw, layout, top, left, height, width, y, x, targetColor);
  }
  return std::clamp(centerGreen + differences / static_cast<double>(count), 0.0, 1.0);
}

void appendLe16(std::vector<std::uint8_t>& row, const std::uint16_t value) {
  row.push_back(static_cast<std::uint8_t>(value & 0xffu));
  row.push_back(static_cast<std::uint8_t>((value >> 8u) & 0xffu));
}

[[nodiscard]] std::uint16_t unitToUInt16(const double value) {
  const double clamped = std::clamp(value, 0.0, 1.0);
  return static_cast<std::uint16_t>(std::lround(clamped * 65535.0));
}

[[nodiscard]] Json metadataFor(const LibRaw& raw, const BayerLayout& layout,
                               const int top, const int left, const int height,
                               const int width, const std::string_view demosaic) {
  Json rawPattern = Json::array();
  Json rgbPattern = Json::array();
  for (const int rawColor : layout.rawColors) {
    rawPattern.push_back(rawColor);
    rgbPattern.push_back(canonicalColor(rawColor));
  }

  Json blackLevels = Json::array();
  for (int index = 0; index < 4; ++index) {
    blackLevels.push_back(raw.imgdata.color.cblack[index]);
  }

  const std::uint32_t maximum = raw.imgdata.color.maximum == 0
                                    ? std::numeric_limits<std::uint16_t>::max()
                                    : raw.imgdata.color.maximum;
  std::array<double, 3> rangeSums{};
  std::array<int, 3> rangeCounts{};
  for (const int rawColor : layout.rawColors) {
    const std::uint32_t black = raw.imgdata.color.cblack[0] != 0
                                    ? raw.imgdata.color.cblack[rawColor]
                                    : raw.imgdata.color.black;
    if (maximum <= black) {
      throw ProtocolError("INVALID_RAW_LEVELS", "LibRaw reported a white level at or below the black level");
    }
    const int channel = canonicalColor(rawColor);
    rangeSums[static_cast<std::size_t>(channel)] += maximum - black;
    ++rangeCounts[static_cast<std::size_t>(channel)];
  }
  Json normalizationRangeDnRgb = Json::array();
  for (int channel = 0; channel < 3; ++channel) {
    normalizationRangeDnRgb.push_back(
        rangeSums[static_cast<std::size_t>(channel)] /
        rangeCounts[static_cast<std::size_t>(channel)]);
  }

  return {
      {"camera", {
          {"make", boundedCString(raw.imgdata.idata.make)},
          {"model", boundedCString(raw.imgdata.idata.model)},
      }},
      {"capture", {
          {"iso", raw.imgdata.other.iso_speed},
      }},
      {"sensor", {
          {"rawWidth", raw.imgdata.sizes.raw_width},
          {"rawHeight", raw.imgdata.sizes.raw_height},
          {"activeArea", {{"left", left}, {"top", top}, {"width", width}, {"height", height}}},
          {"cfa", "bayer-2x2"},
          {"librawPattern", rawPattern},
          {"rgbPattern", rgbPattern},
          {"blackLevels", blackLevels},
          {"globalBlackLevel", raw.imgdata.color.black},
          {"whiteLevel", raw.imgdata.color.maximum},
          {"normalizationRangeDnRgb", normalizationRangeDnRgb},
      }},
      {"processing", {
          {"demosaic", std::string(demosaic)},
          {"blackSubtraction", "per-cfa-channel"},
          {"whiteNormalization", "per-sensor-white-level"},
          {"cameraWhiteBalanceApplied", false},
          {"cameraColorMatrixApplied", false},
          {"gammaApplied", false},
          {"noiseReductionApplied", false},
          {"highlightRecoveryApplied", false},
          {"embeddedPreviewUsed", false},
      }},
  };
}

[[nodiscard]] Json decodeRequest(const Json& request, const Json& id) {
  const std::string sourceText = requireString(request, "sourcePath");
  const std::string cacheText = requireString(request, "cachePath");
  const Json options = request.value("options", Json::object());
  if (!options.is_object()) {
    throw ProtocolError("INVALID_REQUEST", "options must be an object when supplied");
  }
  std::string demosaic = std::string(kDemosaicName);
  if (options.contains("demosaic")) {
    if (!options["demosaic"].is_string()) {
      throw ProtocolError("UNSUPPORTED_OPTION", "options.demosaic must be a supported string");
    }
    demosaic = options["demosaic"].get<std::string>();
    if (demosaic != kDemosaicName && demosaic != kLegacyDemosaicName && demosaic != kGpuDemosaicName) {
      throw ProtocolError("UNSUPPORTED_OPTION",
                          "Supported demosaic modes are edge-aware-bayer-v2, bilinear-bayer-v1 and gpu-edge-aware-bayer-v2");
    }
  }
  const bool gpuBayer = demosaic == kGpuDemosaicName;
  int previewMaxEdge = 0;
  if (options.contains("maxEdge")) {
    const Json& maxEdge = options["maxEdge"];
    if (!maxEdge.is_number_integer()) {
      throw ProtocolError("INVALID_REQUEST", "options.maxEdge must be an integer when supplied");
    }
    previewMaxEdge = maxEdge.get<int>();
    if (previewMaxEdge < 1 || previewMaxEdge > 8192) {
      throw ProtocolError("INVALID_REQUEST", "options.maxEdge must be between 1 and 8192");
    }
  }

  const fs::path sourcePath = fromUtf8(sourceText);
  const fs::path cachePath = fromUtf8(cacheText);
  if (!sourcePath.is_absolute() || !cachePath.is_absolute()) {
    throw ProtocolError("INVALID_REQUEST", "sourcePath and cachePath must both be absolute paths");
  }
  if (!fs::is_regular_file(sourcePath)) {
    throw ProtocolError("SOURCE_NOT_FOUND", "The RAW source path is not a readable regular file");
  }
  if (fs::exists(cachePath)) {
    throw ProtocolError("CACHE_EXISTS", "Refusing to overwrite an existing RAW cache");
  }

  writeProgress(id, "opening", 0.02);
  LibRaw raw;
#if defined(_WIN32)
  const int openResult = raw.open_file(sourcePath.wstring().c_str());
#else
  const int openResult = raw.open_file(sourcePath.c_str());
#endif
  if (openResult != 0) {
    throw ProtocolError("OPEN_FAILED", std::string("LibRaw could not open source: ") + LibRaw::strerror(openResult));
  }

  writeProgress(id, "unpacking", 0.12);
  const int unpackResult = raw.unpack();
  if (unpackResult != 0) {
    throw ProtocolError("UNPACK_FAILED", std::string("LibRaw could not unpack source: ") + LibRaw::strerror(unpackResult));
  }
  if (!isSupportedBayer(raw)) {
    throw ProtocolError("UNSUPPORTED_CFA",
                        "This sidecar currently accepts only unpacked Bayer RAW data; "
                        "X-Trans, Foveon, sRAW and rendered RGB sources are rejected");
  }

  const int top = static_cast<int>(raw.imgdata.sizes.top_margin);
  const int left = static_cast<int>(raw.imgdata.sizes.left_margin);
  const int height = static_cast<int>(raw.imgdata.sizes.height);
  const int width = static_cast<int>(raw.imgdata.sizes.width);
  if (height <= 0 || width <= 0) {
    throw ProtocolError("INVALID_RAW_LAYOUT", "LibRaw reported an empty active image area");
  }

  // Preview requests are intentionally decoded at their target size instead
  // of materializing a full sensor RGB raster and resizing it afterwards. The
  // sampled source coordinates preserve the original Bayer parity; TIFF
  // export omits maxEdge and therefore always uses a stride of one.
  const int sourceMaximumEdge = std::max(width, height);
  int sampleStride = previewMaxEdge == 0
                         ? 1
                         : std::max(1, (sourceMaximumEdge + previewMaxEdge - 1) / previewMaxEdge);
  // A decimated Bayer grid must advance by an odd source stride so adjacent
  // output pixels retain the original alternating CFA parity.
  if (gpuBayer && sampleStride > 1 && sampleStride % 2 == 0) {
    ++sampleStride;
  }
  const int outputHeight = (height + sampleStride - 1) / sampleStride;
  const int outputWidth = (width + sampleStride - 1) / sampleStride;

  // Bound the decoded raster before any disk write. The parent process
  // enforces the same 80 MP limit, but only after the cache file has been
  // materialized; rejecting here prevents a multi-GB write for oversized or
  // malicious files whose dimensions still fit LibRaw's ushort fields.
  constexpr std::uint64_t kMaximumDecodedPixels = 80'000'000ULL;
  const std::uint64_t outputPixelCount =
      static_cast<std::uint64_t>(outputWidth) * static_cast<std::uint64_t>(outputHeight);
  if (outputPixelCount > kMaximumDecodedPixels) {
    throw ProtocolError("TOO_MANY_PIXELS",
                        "Decoded output exceeds the 80 MP limit; refusing to write the cache");
  }

  const BayerLayout layout = buildBayerLayout(raw, top, left, height, width);
  const fs::path parent = cachePath.parent_path();
  std::error_code filesystemError;
  fs::create_directories(parent, filesystemError);
  if (filesystemError) {
    throw ProtocolError("CACHE_WRITE_FAILED", "Could not create the RAW cache directory");
  }

  static std::atomic<std::uint64_t> cacheSequence{0};
  fs::path temporaryPath = cachePath;
  temporaryPath += ".partial-" + std::to_string(++cacheSequence);
  if (fs::exists(temporaryPath)) {
    throw ProtocolError("CACHE_EXISTS", "Temporary RAW cache path already exists");
  }

  try {
    std::ofstream output(temporaryPath, std::ios::binary | std::ios::trunc);
    if (!output) {
      throw ProtocolError("CACHE_WRITE_FAILED", "Could not open the RAW cache for writing");
    }

    const int outputChannels = gpuBayer ? 1 : kOutputChannels;
    const std::size_t rowByteCount = static_cast<std::size_t>(outputWidth) *
                                     static_cast<std::size_t>(outputChannels) *
                                     sizeof(std::uint16_t);
    std::vector<std::uint8_t> row;
    row.reserve(rowByteCount);
    const int progressStride = std::max(1, outputHeight / 100);

    writeProgress(id, gpuBayer ? "sampling-bayer" : "demosaicing", 0.2);
    for (int y = 0; y < outputHeight; ++y) {
      const int sourceY = std::min(height - 1, y * sampleStride);
      row.clear();
      for (int x = 0; x < outputWidth; ++x) {
        const int sourceX = std::min(width - 1, x * sampleStride);
        if (gpuBayer) {
          appendLe16(row, unitToUInt16(
              normalizedSample(raw, layout, top, left, sourceY, sourceX)));
        } else {
          const auto demosaicFunction = demosaic == kLegacyDemosaicName
                                            ? demosaicChannel
                                            : edgeAwareDemosaicChannel;
          appendLe16(row, unitToUInt16(demosaicFunction(
              raw, layout, top, left, height, width, sourceY, sourceX, 0)));
          appendLe16(row, unitToUInt16(demosaicFunction(
              raw, layout, top, left, height, width, sourceY, sourceX, 1)));
          appendLe16(row, unitToUInt16(demosaicFunction(
              raw, layout, top, left, height, width, sourceY, sourceX, 2)));
        }
      }
      output.write(reinterpret_cast<const char*>(row.data()), static_cast<std::streamsize>(row.size()));
      if (!output) {
        throw ProtocolError("CACHE_WRITE_FAILED", "Writing the RAW cache failed");
      }
      if (y % progressStride == 0 || y + 1 == outputHeight) {
        const double complete = static_cast<double>(y + 1) / static_cast<double>(outputHeight);
        writeProgress(id, "writing", 0.2 + complete * 0.78);
      }
    }
    output.close();
    if (!output) {
      throw ProtocolError("CACHE_WRITE_FAILED", "Finalizing the RAW cache failed");
    }

    fs::rename(temporaryPath, cachePath, filesystemError);
    if (filesystemError) {
      throw ProtocolError("CACHE_WRITE_FAILED", "Could not finalize the RAW cache atomically");
    }
  } catch (...) {
    fs::remove(temporaryPath, filesystemError);
    throw;
  }

  const std::uint64_t bytes = static_cast<std::uint64_t>(outputWidth) *
                              static_cast<std::uint64_t>(outputHeight) *
                              static_cast<std::uint64_t>(gpuBayer ? 1 : kOutputChannels) *
                              sizeof(std::uint16_t);
  Json rgbPattern = Json::array();
  for (const int rawColor : layout.rawColors) {
    rgbPattern.push_back(canonicalColor(rawColor));
  }
  writeProgress(id, "complete", 1.0);
  return {
      {"cachePath", toUtf8(cachePath)},
      {"cacheFormat", std::string(gpuBayer ? kBayerCacheFormat : kCacheFormat)},
      {"width", outputWidth},
      {"height", outputHeight},
      {"channels", gpuBayer ? 1 : kOutputChannels},
      {"bitDepth", 16},
      {"byteOrder", "little-endian"},
      {"bytes", bytes},
      {"sourceDomain", gpuBayer ? "camera-linear-bayer" : "camera-linear-rgb"},
      {"decoderFingerprint", std::string("libraw-") + LibRaw::version() + "+" +
                                 std::string(gpuBayer ? kDemosaicName : std::string_view(demosaic))},
      {"bayerPattern", gpuBayer ? rgbPattern : Json(nullptr)},
      {"sampleStride", sampleStride},
      {"metadata", metadataFor(raw, layout, top, left, height, width,
                                gpuBayer ? kDemosaicName : std::string_view(demosaic))},
  };
}

[[nodiscard]] Json pingResult() {
  return {
      {"protocolVersion", FILMLAB_RAW_WORKER_PROTOCOL_VERSION},
      {"decoderFingerprint", std::string("libraw-") + LibRaw::version() + "+" + std::string(kDemosaicName)},
      {"cacheFormat", std::string(kCacheFormat)},
      {"gpuBayerDemosaic", std::string(kGpuDemosaicName)},
      {"gpuBayerCacheFormat", std::string(kBayerCacheFormat)},
      {"supportedCfa", Json::array({"bayer-2x2"})},
  };
}

[[nodiscard]] Json extractId(const Json& request) {
  const auto found = request.find("id");
  if (found == request.end() || !found->is_string() || found->get_ref<const std::string&>().empty()) {
    throw ProtocolError("INVALID_REQUEST", "Missing non-empty string field: id");
  }
  return *found;
}

}  // namespace

int main() {
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) {
      continue;
    }

    Json id = nullptr;
    try {
      const Json request = Json::parse(line);
      if (!request.is_object()) {
        throw ProtocolError("INVALID_REQUEST", "Each JSON Lines request must be an object");
      }
      id = extractId(request);
      const std::string type = requireString(request, "type");

      if (type == "ping") {
        writeJson({{"id", id}, {"ok", true}, {"result", pingResult()}});
      } else if (type == "decode") {
        writeJson({{"id", id}, {"ok", true}, {"result", decodeRequest(request, id)}});
      } else if (type == "shutdown") {
        writeJson({{"id", id}, {"ok", true}, {"result", {{"stopping", true}}}});
        return 0;
      } else {
        throw ProtocolError("UNSUPPORTED_REQUEST", "Unsupported raw sidecar request type: " + type);
      }
    } catch (const ProtocolError& error) {
      writeFailure(id, error.code(), error.what());
    } catch (const nlohmann::json::exception& error) {
      writeFailure(id, "INVALID_JSON", error.what());
    } catch (const std::exception& error) {
      writeFailure(id, "INTERNAL_ERROR", error.what());
    }
  }

  return 0;
}
