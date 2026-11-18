// Cleans up the model's raw mask. Runs on the page (not in the worker) so
// the fine-tune controls can re-run it instantly, without the model.
//
// Both steps work on the mask at the model's resolution (1024×1024 for
// RMBG-1.4), which is then scaled up to the photo's size when drawn.

export const DEFAULTS = {
  cutoff: 40, // %: confidence below this is background
  softness: 50, // %: confidence range over which edges fade in
  trim: true, // remove narrow areas that reach the image border
  trimWidth: 12, // mask pixels: areas up to ~2× this wide count as narrow
  fill: true, // fill holes inside the subject that the model was unsure about
  fillSize: 5, // %: largest hole to fill, relative to the subject's area
};

// A hole is only filled if the model's median confidence in it is at least
// this. Real background scores close to 0% (gaps between an arm and a body
// included); dark or glossy parts of a subject, like a helmet visor,
// typically score 10-30%. The median, unlike the mean, isn't pulled up by
// the soft rim around a real gap.
const FILL_CONFIDENCE = 0.05 * 255;

// Returns a new alpha mask; `raw` is left untouched.
export function refineMask(raw, w, h, options = DEFAULTS) {
  const alpha = new Uint8ClampedArray(raw);
  levels(alpha, options.cutoff, options.softness);
  if (options.trim && options.trimWidth > 0) trimBorder(alpha, w, h, options.trimWidth);
  if (options.fill && options.fillSize > 0) fillHoles(alpha, raw, w, h, options.fillSize);
  return alpha;
}

// The model marks some background with low confidence rather than none,
// which shows up as faint shadows or haze. Treat anything below the cutoff
// as background, and fade in over `softness` above it, so soft edges stay
// soft.
function levels(alpha, cutoff, softness) {
  const low = (cutoff / 100) * 255;
  const span = Math.max(1, (softness / 100) * 255);
  const scale = 255 / span;
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = (alpha[i] - low) * scale; // Uint8ClampedArray clamps to 0-255
  }
}

// The model sometimes keeps a narrow piece of background attached to the
// subject that runs out of the frame. Find the parts of the mask that are
// much narrower than the subject (by eroding then dilating it, a
// morphological "opening"), and remove the ones that reach the image border.
// Narrow parts of the subject itself usually stop short of the border and
// are kept.
function trimBorder(alpha, w, h, radius) {
  const bits = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) bits[i] = alpha[i] >= 128 ? 1 : 0;
  const opened = morph(morph(bits, w, h, radius, true), w, h, radius, false);

  // Flood-fill each narrow region; clear it if it touches the border.
  const seen = new Uint8Array(alpha.length);
  const region = [];
  for (let start = 0; start < alpha.length; start++) {
    if (!bits[start] || opened[start] || seen[start]) continue;
    region.length = 0;
    region.push(start);
    seen[start] = 1;
    let touchesBorder = false;
    for (let k = 0; k < region.length; k++) {
      const i = region[k];
      const x = i % w;
      const y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (j < 0 || j >= alpha.length || seen[j] || !bits[j] || opened[j]) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === w - 1)) continue;
        seen[j] = 1;
        region.push(j);
      }
    }
    if (touchesBorder) clearWithFringe(alpha, opened, region, w);
  }
}

// The model sometimes removes part of the subject that looks like the
// background, e.g. a dark visor against dark space, leaving a hole. Holes
// that are completely surrounded by the subject, small relative to it, and
// that the model wasn't confident about are filled back in.
//
// A hole here is an enclosed region that isn't fully opaque: its core (below
// 50%) plus the faded rim around it, so filling it leaves no ghost. Whether
// to fill is decided on the core alone.
function fillHoles(alpha, raw, w, h, maxPercent) {
  let subject = 0;
  for (let i = 0; i < alpha.length; i++) if (alpha[i] >= 128) subject++;
  const maxArea = (maxPercent / 100) * subject;

  const seen = new Uint8Array(alpha.length);
  const region = [];
  const histogram = new Uint32Array(256); // of raw confidence in the core
  for (let start = 0; start < alpha.length; start++) {
    if (alpha[start] === 255 || seen[start]) continue;
    histogram.fill(0);
    region.length = 0;
    region.push(start);
    seen[start] = 1;
    let touchesBorder = false;
    let core = 0;
    for (let k = 0; k < region.length; k++) {
      const i = region[k];
      const x = i % w;
      const y = (i - x) / w;
      if (alpha[i] < 128) {
        core++;
        histogram[raw[i]]++;
      }
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (j < 0 || j >= alpha.length || seen[j] || alpha[j] === 255) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === w - 1)) continue;
        seen[j] = 1;
        region.push(j);
      }
    }
    if (touchesBorder || core > maxArea) continue;
    // A faded patch with no transparent core is just a blemish: fill it.
    if (core > 0 && median(histogram, core) < FILL_CONFIDENCE) continue;
    for (const i of region) alpha[i] = 255;
  }
}

function median(histogram, count) {
  let seen = 0;
  for (let value = 0; value < histogram.length; value++) {
    seen += histogram[value];
    if (seen * 2 >= count) return value;
  }
  return 255;
}

// Clear a narrow region, plus its soft edge: the faint (< 50%) pixels within a
// few pixels of it, outside the subject's solid core.
const FRINGE = 3;

function clearWithFringe(alpha, opened, region, w) {
  let frontier = region.slice();
  for (const i of frontier) alpha[i] = 0;
  for (let step = 0; step < FRINGE && frontier.length; step++) {
    const next = [];
    for (const i of frontier) {
      const x = i % w;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (j < 0 || j >= alpha.length || opened[j] || alpha[j] === 0 || alpha[j] >= 128) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === w - 1)) continue;
        alpha[j] = 0;
        next.push(j);
      }
    }
    frontier = next;
  }
}

// Binary erosion (all) or dilation (any) with a (2r+1)-square window, as
// separable horizontal and vertical passes using running sums. Pixels
// outside the image count as set, so subjects cut off by the frame aren't
// eroded from that side.
export function morph(bits, w, h, r, erode) {
  // One pass along `count` lines of `len` pixels, `step` apart.
  const pass = (src, len, count, lineStride, step) => {
    const out = new Uint8Array(src.length);
    const window = 2 * r + 1;
    const outside = erode ? 1 : 0;
    for (let line = 0; line < count; line++) {
      const base = line * lineStride;
      let sum = outside * r; // the r pixels before the start
      for (let i = 0; i <= r; i++) sum += i < len ? src[base + i * step] : outside;
      for (let i = 0; i < len; i++) {
        out[base + i * step] = erode ? (sum === window ? 1 : 0) : sum > 0 ? 1 : 0;
        const add = i + r + 1;
        const drop = i - r;
        sum += (add < len ? src[base + add * step] : outside) - (drop >= 0 ? src[base + drop * step] : outside);
      }
    }
    return out;
  };
  return pass(pass(bits, w, h, w, 1), h, w, 1, w);
}
