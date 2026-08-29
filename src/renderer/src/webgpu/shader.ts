export const PARAM_FLOATS = 160;

export const WEBGPU_PREVIEW_SHADER = /* wgsl */ `
struct Source { values: array<f32> };
struct Params { values: array<f32> };

@group(0) @binding(0) var<storage, read> source: Source;
@group(0) @binding(1) var<storage, read> params: Params;

fn p(index: u32) -> f32 { return params.values[index]; }
fn source_width() -> u32 { return u32(p(0u)); }
fn source_height() -> u32 { return u32(p(1u)); }
fn output_width() -> u32 { return u32(p(2u)); }
fn output_height() -> u32 { return u32(p(3u)); }

fn oriented_offset(x: u32, y: u32, channel: u32) -> u32 {
  let quarter = u32(p(4u));
  var sx = x;
  var sy = y;
  if (quarter == 1u) {
    sx = y;
    sy = source_height() - 1u - x;
  } else if (quarter == 2u) {
    sx = source_width() - 1u - x;
    sy = source_height() - 1u - y;
  } else if (quarter == 3u) {
    sx = source_width() - 1u - y;
    sy = x;
  }
  return (sy * source_width() + sx) * 3u + channel;
}

fn sample_oriented(x: u32, y: u32) -> vec3<f32> {
  return vec3<f32>(
    source.values[oriented_offset(x, y, 0u)],
    source.values[oriented_offset(x, y, 1u)],
    source.values[oriented_offset(x, y, 2u)]
  );
}

fn sample_geometry(pixel: vec2<u32>) -> vec3<f32> {
  let rotated = vec2<f32>(pixel) + vec2<f32>(p(10u), p(11u));
  let angle = p(5u);
  var oriented = rotated;
  if (abs(angle) > 1e-10) {
    let relative = rotated - (vec2<f32>(p(8u), p(9u)) * 0.5 - vec2<f32>(0.5));
    let c = cos(angle);
    let s = sin(angle);
    oriented = vec2<f32>(
      c * relative.x + s * relative.y,
      -s * relative.x + c * relative.y
    ) + (vec2<f32>(p(6u), p(7u)) * 0.5 - vec2<f32>(0.5));
  }
  let maximum = vec2<f32>(p(6u) - 1.0, p(7u) - 1.0);
  let at = clamp(oriented, vec2<f32>(0.0), maximum);
  let left = vec2<u32>(floor(at));
  let right = min(left + vec2<u32>(1u), vec2<u32>(u32(p(6u)) - 1u, u32(p(7u)) - 1u));
  let mix_value = at - vec2<f32>(left);
  let upper = mix(sample_oriented(left.x, left.y), sample_oriented(right.x, left.y), mix_value.x);
  let lower = mix(sample_oriented(left.x, right.y), sample_oriented(right.x, right.y), mix_value.x);
  return mix(upper, lower, mix_value.y);
}

fn curve_value(value: f32, channel: u32) -> f32 {
  if (p(26u) < 0.5) { return value; }
  // Slot layout per channel (stride 27): [count][13 inputs][13 outputs].
  // A fitted monotone curve carries up to twelve bin medians plus the
  // physical-origin anchor, so all thirteen points must survive packing.
  let start = 64u + channel * 27u;
  let count = u32(p(start));
  if (count < 2u) { return value; }
  let first_x = p(start + 1u);
  let first_y = p(start + 14u);
  let last_x = p(start + count);
  let last_y = p(start + 13u + count);
  var output = value;
  if (value <= first_x) {
    let x1 = p(start + 2u);
    let y1 = p(start + 15u);
    let slope = clamp((y1 - first_y) / max(x1 - first_x, 1e-20), 0.25, 4.0);
    output = first_y + (value - first_x) * slope;
  } else if (value >= last_x) {
    let previous = count - 1u;
    let x0 = p(start + previous);
    let y0 = p(start + 13u + previous);
    let slope = clamp((last_y - y0) / max(last_x - x0, 1e-20), 0.25, 4.0);
    output = last_y + (value - last_x) * slope;
  } else {
    for (var index = 0u; index < 12u; index = index + 1u) {
      if (index + 1u >= count) { break; }
      let low_x = p(start + 1u + index);
      let high_x = p(start + 2u + index);
      if (value >= low_x && value <= high_x) {
        let low_y = p(start + 14u + index);
        let high_y = p(start + 15u + index);
        output = mix(low_y, high_y, (value - low_x) / max(high_x - low_x, 1e-20));
        break;
      }
    }
  }
  return clamp(output, value - 0.35, value + 0.35);
}

fn normalize_density(value: f32, channel: u32) -> f32 {
  var normalized = max(value, 0.0);
  if (p(19u) > 0.5) {
    normalized = (normalized - p(20u + channel)) / p(23u + channel);
  }
  normalized = curve_value(normalized, channel);
  return clamp(normalized, 0.0, 4.0);
}

fn classic(input: vec3<f32>) -> vec3<f32> {
  let base = vec3<f32>(p(16u), p(17u), p(18u));
  var density = vec3<f32>(0.0);
  for (var channel = 0u; channel < 3u; channel = channel + 1u) {
    var ratio = input[channel] / base[channel];
    if (ratio != ratio || abs(ratio) > 3.0e38) { ratio = 1.0; }
    density[channel] = -log2(max(max(ratio, 0.0), 1e-6)) / log2(10.0);
  }
  let corrected = vec3<f32>(
    normalize_density(density.r, 0u),
    normalize_density(density.g, 1u),
    normalize_density(density.b, 2u)
  );
  let mean_density = (corrected.r + corrected.g + corrected.b) / 3.0;
  let saturated = max(vec3<f32>(0.0), vec3<f32>(mean_density) + (corrected - vec3<f32>(mean_density)) * p(27u));
  var value = max(vec3<f32>(0.0), pow(vec3<f32>(10.0), saturated) - vec3<f32>(1.0));
  value *= vec3<f32>(p(28u), p(29u), p(30u));
  value *= exp2(p(32u));
  if (p(33u) != 1.0) {
    let positive = value > vec3<f32>(0.0);
    let contrasted = 0.18 * exp2(log2(max(value, vec3<f32>(1e-20)) / 0.18) * p(33u));
    value = select(vec3<f32>(0.0), contrasted, positive);
  }
  if (p(34u) > 0.0) {
    let compressed = vec3<f32>(1.0) + (value - vec3<f32>(1.0)) * (1.0 - p(34u));
    value = select(value, compressed, value > vec3<f32>(1.0));
  }
  let luma = dot(value, vec3<f32>(0.2126, 0.7152, 0.0722));
  value = max(vec3<f32>(0.0), vec3<f32>(luma) + (value - vec3<f32>(luma)) * p(35u));
  return value / max(p(31u), 1e-8);
}

fn srgb_to_rec2020(value: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(value, vec3<f32>(0.627403895934699, 0.329283038377883, 0.043313065687418)),
    dot(value, vec3<f32>(0.069097289358232, 0.919540395075459, 0.011362315566309)),
    dot(value, vec3<f32>(0.01639143887515, 0.088013307877226, 0.895595253247624))
  );
}

fn rec2020_to_srgb(value: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(value, vec3<f32>(1.660491002108435, -0.58764113878855, -0.072849863319885)),
    dot(value, vec3<f32>(-0.124550474521591, 1.13289989712596, -0.008349422604369)),
    dot(value, vec3<f32>(-0.018150763354905, -0.100578898008008, 1.118729661362913))
  );
}

fn negadoctor(input_value: vec3<f32>) -> vec3<f32> {
  var input = input_value;
  let working_rec2020 = p(15u) > 0.5;
  if (p(14u) < 0.5 && working_rec2020) { input = srgb_to_rec2020(input); }
  if (p(14u) > 0.5 && !working_rec2020) { input = rec2020_to_srgb(input); }
  input = select(input, vec3<f32>(0.0), input != input);
  input = max(input, vec3<f32>(0.0));
  let dmin = vec3<f32>(p(36u), p(37u), p(38u));
  let shadow = vec3<f32>(p(41u), p(42u), p(43u));
  let high = vec3<f32>(p(44u), p(45u), p(46u));
  let density = -log2(dmin / max(input, vec3<f32>(2.3283064365386963e-10))) / log2(10.0);
  let corrected = high / p(39u) * density + high * p(40u) * shadow;
  let print_linear = max(vec3<f32>(0.0), p(50u) * (vec3<f32>(1.0 + p(47u)) - pow(vec3<f32>(10.0), corrected)));
  var value = pow(print_linear, vec3<f32>(p(48u)));
  if (p(49u) < 1.0) {
    let complement = 1.0 - p(49u);
    let glossy = vec3<f32>(p(49u)) + (vec3<f32>(1.0) - exp(-(value - vec3<f32>(p(49u))) / complement)) * complement;
    value = select(value, glossy, value > vec3<f32>(p(49u)));
  }
  if (working_rec2020) { value = rec2020_to_srgb(value); }
  return value;
}

fn linear_to_srgb(value: vec3<f32>) -> vec3<f32> {
  let clamped = clamp(value, vec3<f32>(0.0), vec3<f32>(1.0));
  let low = clamped * 12.92;
  let high = 1.055 * pow(clamped, vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(high, low, clamped <= vec3<f32>(0.0031308));
}

@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)
  );
  return vec4<f32>(positions[index], 0.0, 1.0);
}

@fragment fn fragment_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let pixel = vec2<u32>(min(vec2<f32>(position.xy), vec2<f32>(f32(output_width() - 1u), f32(output_height() - 1u))));
  let input = sample_geometry(pixel);
  var value = vec3<f32>(0.0);
  if (p(12u) > 0.5) {
    value = negadoctor(input);
  } else {
    value = classic(input);
  }
  for (var channel = 0u; channel < 3u; channel = channel + 1u) {
    if (value[channel] != value[channel] || abs(value[channel]) > 3.0e38) { value[channel] = 0.0; }
  }
  return vec4<f32>(linear_to_srgb(value), 1.0);
}
`;
