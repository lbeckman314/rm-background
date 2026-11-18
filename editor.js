// One result's editor: draws the cut-out, and handles its toolbar (compare,
// erase/restore brush, crop/rotate/flip, undo/redo) and Fine-tune panel.
//
// Memory: phones (iOS Safari especially) reload the page if it uses too much,
// so everything on screen is drawn from a preview of the photo (see
// PREVIEW_SIZE in app.js), brush layers only exist once you brush, and there
// are no other copies. Settings, strokes and framing are all kept in
// full-resolution photo pixels, so the download re-reads the original file
// and renders it at full resolution, then frees it.
//
// The cut-out is drawn in layers, straight onto the visible canvas through
// the framing (crop, rotation, flip):
//   1. the model's raw mask, cleaned up with the current settings (mask.js)
//      and scaled up from the model's resolution,
//   2. plus everything painted with Restore,
//   3. minus everything painted with Erase,
//   4. keeping the photo only where the result is opaque.
// Changing a setting only redoes step 1, brush strokes are kept as a list
// (replayed when needed), and framing is just a transform, so settings,
// strokes and framing can all change in any order without losing anything.
//
// History: every change (a stroke, a setting, a crop, a reset) records a
// snapshot of { options, strokes, frame }. Strokes are never mutated after
// they're finished, so snapshots can share them and stay small.

import { DEFAULTS, refineMask } from "./mask.js";

const MAX_HISTORY = 200;
const MIN_CROP = 16; // px
const ASPECTS = { free: null, original: "original", "1:1": 1, "4:3": 4 / 3, "16:9": 16 / 9 };

// The editor that keyboard shortcuts act on: the one last used.
let current = null;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// `preview` is the photo scaled down for the screen; `width` and `height` are
// the original's; `loadOriginal()` decodes the original for downloads.
export function createEditor(item, { mask, maskWidth, maskHeight, preview, width, height, loadOriginal }) {
  const scale = preview.width / width; // preview pixels per photo pixel
  const canvas = item.querySelector(".after");
  const before = item.querySelector(".before");
  const compare = item.querySelector(".compare");
  const toolbar = item.querySelector(".toolbar");
  const panel = item.querySelector(".tune");
  const cursor = item.querySelector(".brush-cursor");
  const cropBar = toolbar.querySelector(".crop-bar");
  const cropBox = item.querySelector(".crop-box");
  const cropSize = toolbar.querySelector(".crop-size");
  const settings = panel.querySelectorAll("input[name]");
  const sizeInput = toolbar.querySelector('input[name="brushSize"]');
  const undoButton = toolbar.querySelector(".undo");
  const redoButton = toolbar.querySelector(".redo");

  // Framing. The "view" is the photo turned by `rotation` (90° steps) plus
  // `angle` (fine straightening, -45° to 45°), then mirrored if `flip`, with
  // its origin at the photo's centre. Both turns are clockwise as seen on
  // screen. `crop` is an upright rectangle in the view, always inside the
  // turned photo, so a result never has empty corners.
  const turnedSize = (rotation) => (rotation % 180 ? [height, width] : [width, height]);
  // The view's full extent at a rotation, ignoring the fine angle.
  function fullRect(rotation) {
    const [w, h] = turnedSize(rotation);
    return { x: -w / 2, y: -h / 2, w, h };
  }
  const DEFAULT_FRAME = { rotation: 0, angle: 0, flip: false, crop: fullRect(0) };

  let options = { ...DEFAULTS };
  let strokes = []; // { mode, size (px), points: [[x, y], ...] } in photo pixels
  let frame = DEFAULT_FRAME;
  let tool = "off"; // "off" (compare), "erase", "restore" or "crop"
  const brush = { size: 4 }; // % of the photo's longer side

  const history = [{ options, strokes, frame }];
  let position = 0; // index in history of the current state

  const small = new OffscreenCanvas(maskWidth, maskHeight); // cleaned mask
  let layers = null; // preview-sized { erased, restored }, made on the first stroke
  const brushLayers = () =>
    (layers ??= {
      erased: new OffscreenCanvas(preview.width, preview.height),
      restored: new OffscreenCanvas(preview.width, preview.height),
    });

  // ---- Framing ----

  // Size of the framed output, in whole pixels inside the crop.
  function outputSize(f) {
    return [Math.max(1, Math.floor(f.crop.w + 1e-6)), Math.max(1, Math.floor(f.crop.h + 1e-6))];
  }

  // Photo pixels → view coordinates. Mirroring is applied last, which would
  // reverse the apparent direction of the turn, so the turn is reversed too.
  function viewMatrix(f) {
    const turn = f.rotation + f.angle;
    let m = new DOMMatrix();
    if (f.flip) m = m.scale(-1, 1);
    return m.rotate(f.flip ? -turn : turn).translate(-width / 2, -height / 2);
  }

  // Photo pixels → framed output pixels.
  function matrix(f) {
    return new DOMMatrix().translate(-f.crop.x, -f.crop.y).multiply(viewMatrix(f));
  }

  // While cropping, show the whole turned photo (at its 90° rotation, with
  // the fine angle's corners cut off), with the crop box on top. Otherwise
  // show the committed frame.
  let draft = null;
  let aspect = "free";
  const viewFrame = () => (tool === "crop" ? { ...draft, crop: fullRect(draft.rotation) } : frame);

  // ---- Rendering ----

  function refine() {
    const alpha = refineMask(mask, maskWidth, maskHeight, options);
    const rgba = new Uint8ClampedArray(maskWidth * maskHeight * 4);
    for (let i = 0; i < alpha.length; i++) rgba[i * 4 + 3] = alpha[i];
    small.getContext("2d").putImageData(new ImageData(rgba, maskWidth, maskHeight), 0, 0);
  }

  // Draw the cut-out onto `ctx`, whose transform maps preview pixels to
  // its own pixels. Every source is in preview pixels.
  function drawCutout(ctx) {
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(small, 0, 0, preview.width, preview.height);
    if (layers) {
      ctx.drawImage(layers.restored, 0, 0);
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(layers.erased, 0, 0);
    }
    ctx.globalCompositeOperation = "source-in";
    ctx.drawImage(preview, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  }

  // Draw the cut-out (and the original, if its framing changed) through the
  // current view's framing.
  let beforeFrame = null;
  function present() {
    const f = viewFrame();
    const [outWidth, outHeight] = outputSize(f);
    const viewWidth = Math.max(1, Math.round(outWidth * scale));
    const viewHeight = Math.max(1, Math.round(outHeight * scale));
    // Preview pixels → photo pixels → framed photo pixels → screen pixels.
    const m = new DOMMatrix().scale(scale).multiply(matrix(f)).scale(1 / scale);
    const targets = [[canvas, drawCutout]];
    if (!same(f, beforeFrame)) targets.push([before, (ctx) => ctx.drawImage(preview, 0, 0)]);
    for (const [target, draw] of targets) {
      if (target.width !== viewWidth || target.height !== viewHeight) {
        target.width = viewWidth;
        target.height = viewHeight;
      }
      const ctx = target.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, viewWidth, viewHeight);
      ctx.setTransform(m);
      draw(ctx);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    beforeFrame = f;
    canvas.classList.add("ready");
    if (tool === "crop") placeCropBox();
  }

  // Coalesce redraws to one per frame. Fall back to a timer when frames
  // aren't running (e.g. a background tab), so state never goes stale.
  const WORK = { present: 1, composite: 1, refine: 2 };
  let pending = 0;
  function run() {
    if (!pending) return;
    const todo = pending;
    pending = 0;
    if (todo >= WORK.refine) refine();
    present();
  }
  function schedule(kind) {
    const first = pending === 0;
    pending = Math.max(pending, WORK[kind]);
    if (!first) return;
    requestAnimationFrame(run);
    setTimeout(run, 100);
  }

  // ---- Brush ----

  // Paint one segment of a stroke (in photo pixels) onto a pair of layers
  // drawn at `layerScale`. Each stroke is drawn on its own layer and cleared
  // from the other, so the latest stroke over a spot wins.
  function paint(stroke, from, to, target = brushLayers(), layerScale = scale) {
    const [on, off] = stroke.mode === "erase" ? [target.erased, target.restored] : [target.restored, target.erased];
    for (const [layer, op] of [
      [on, "source-over"],
      [off, "destination-out"],
    ]) {
      const ctx = layer.getContext("2d");
      ctx.setTransform(layerScale, 0, 0, layerScale, 0, 0);
      ctx.globalCompositeOperation = op;
      ctx.beginPath();
      if (from[0] === to[0] && from[1] === to[1]) {
        // A zero-length line draws nothing, even with round caps: use a dot.
        ctx.arc(to[0], to[1], stroke.size / 2, 0, 2 * Math.PI);
        ctx.fillStyle = "#000";
        ctx.fill();
      } else {
        ctx.moveTo(...from);
        ctx.lineTo(...to);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = stroke.size;
        ctx.strokeStyle = "#000";
        ctx.stroke();
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }

  // Redraw all strokes onto the preview layers (dropping them when there are
  // no strokes).
  function replay() {
    if (strokes.length === 0) {
      layers = null;
      return;
    }
    const target = brushLayers();
    const layerScale = scale;
    for (const layer of Object.values(target)) {
      const ctx = layer.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, layer.width, layer.height);
    }
    for (const stroke of strokes) {
      const { points } = stroke;
      for (let i = 0; i < points.length; i++) {
        paint(stroke, points[Math.max(0, i - 1)], points[i], target, layerScale);
      }
    }
  }

  const brushPixels = () => (brush.size / 100) * Math.max(width, height);

  // Pointer position in framed photo pixels (the view at full resolution).
  function toOutput(event) {
    const rect = canvas.getBoundingClientRect();
    const [outWidth, outHeight] = outputSize(viewFrame());
    return [
      ((event.clientX - rect.left) / rect.width) * outWidth,
      ((event.clientY - rect.top) / rect.height) * outHeight,
    ];
  }

  // Pointer position in photo pixels, undoing the framing.
  function toPhoto(event) {
    const [x, y] = toOutput(event);
    const point = matrix(viewFrame()).inverse().transformPoint(new DOMPoint(x, y));
    return [point.x, point.y];
  }

  function moveCursor(event) {
    const rect = canvas.getBoundingClientRect();
    const box = compare.getBoundingClientRect();
    const diameter = brushPixels() * (rect.width / outputSize(viewFrame())[0]);
    cursor.style.width = cursor.style.height = `${diameter}px`;
    cursor.style.left = `${event.clientX - box.left}px`;
    cursor.style.top = `${event.clientY - box.top}px`;
    cursor.hidden = false;
  }

  let active = null; // the stroke being drawn
  const brushing = () => tool === "erase" || tool === "restore";

  compare.addEventListener("pointerdown", (event) => {
    current = editor;
    if (!brushing() || event.button !== 0) return;
    event.preventDefault();
    try {
      compare.setPointerCapture(event.pointerId); // keep the stroke going outside the image
    } catch {
      // Not essential; painting still works without it.
    }
    const point = toPhoto(event);
    active = { mode: tool, size: brushPixels(), points: [point] };
    paint(active, point, point);
    schedule("composite");
  });

  compare.addEventListener("pointermove", (event) => {
    if (!brushing()) return;
    moveCursor(event);
    if (!active) return;
    const point = toPhoto(event);
    paint(active, active.points.at(-1), point);
    active.points.push(point);
    schedule("composite");
  });

  const endStroke = () => {
    if (!active) return;
    strokes = [...strokes, active];
    active = null;
    commit();
  };
  compare.addEventListener("pointerup", endStroke);
  compare.addEventListener("pointercancel", endStroke);
  compare.addEventListener("pointerleave", () => {
    cursor.hidden = true;
  });

  function setBrushSize(size) {
    brush.size = clamp(size, Number(sizeInput.min), Number(sizeInput.max));
    sizeInput.value = brush.size;
    sizeInput.title = `Brush size: ${brush.size}% of the image`;
  }

  sizeInput.addEventListener("input", () => {
    current = editor;
    setBrushSize(Number(sizeInput.value));
  });

  // ---- Tools ----

  function setMode(mode) {
    if (mode === tool) return;
    // Switching away from Crop applies it, like most editors.
    if (tool === "crop") finishCrop(true);
    tool = mode;
    toolbar.querySelectorAll("[data-mode]").forEach((button) => {
      button.setAttribute("aria-checked", String(button.dataset.mode === mode));
    });
    item.dataset.tool = mode;
    // While brushing: show the whole result, with the original faintly
    // visible through removed areas. While cropping: show the whole result
    // with the crop box. Either way the comparison slider is off.
    item.classList.toggle("brushing", brushing());
    item.classList.toggle("cropping", mode === "crop");
    const slider = item.querySelector(".slider");
    compare.style.setProperty("--pos", mode === "off" ? `${slider.value}%` : "100%");
    if (!brushing()) cursor.hidden = true;
    if (mode === "crop") startCrop();
    updateHistoryButtons();
  }

  toolbar.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      current = editor;
      setMode(button.dataset.mode);
    });
  });

  // ---- Crop, rotate and flip ----

  // Whether a view rectangle lies inside the turned photo.
  function insidePhoto(f, rect) {
    const inverse = viewMatrix(f).inverse();
    const tolerance = 0.5; // px, for rounding
    for (const [x, y] of [
      [rect.x, rect.y],
      [rect.x + rect.w, rect.y],
      [rect.x, rect.y + rect.h],
      [rect.x + rect.w, rect.y + rect.h],
    ]) {
      const p = inverse.transformPoint(new DOMPoint(x, y));
      if (p.x < -tolerance || p.y < -tolerance || p.x > width + tolerance || p.y > height + tolerance) return false;
    }
    return true;
  }

  // Shrink a rectangle about its centre until it fits inside the turned
  // photo, first moving the centre towards the photo's if even a tiny one
  // wouldn't fit there. Keeps the rectangle's shape.
  function fitInside(f, rect) {
    if (insidePhoto(f, rect)) return rect;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const at = (size, pull) => {
      const w = rect.w * size;
      const h = rect.h * size;
      return { x: cx * (1 - pull) - w / 2, y: cy * (1 - pull) - h / 2, w, h };
    };
    let pull = 0;
    if (!insidePhoto(f, at(1e-3, 0))) pull = search((t) => insidePhoto(f, at(1e-3, t)), false);
    return at(search((t) => insidePhoto(f, at(t, pull)), true), pull);
  }

  // The furthest step from rectangle `from` (inside) towards `to` that stays
  // inside the turned photo.
  function towards(f, from, to) {
    if (insidePhoto(f, to)) return to;
    const lerp = (t) => ({
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      w: from.w + (to.w - from.w) * t,
      h: from.h + (to.h - from.h) * t,
    });
    return lerp(search((t) => insidePhoto(f, lerp(t)), true));
  }

  // The crop the straighten dial shrinks from: the last crop you chose. Turning
  // the dial shrinks it to fit, and turning back restores it.
  let straightenFrom = null;

  // Set the draft crop (a view rectangle). Choices other than the dial also
  // become what the dial shrinks from.
  function setDraftCrop(crop, { fromDial = false } = {}) {
    draft = { ...draft, crop };
    if (!fromDial) straightenFrom = crop;
    placeCropBox();
  }

  // The draft crop as a box relative to the view's top-left, and back. The
  // crop box handles and aspect presets work in these.
  function draftBox() {
    const full = fullRect(draft.rotation);
    return { x: draft.crop.x - full.x, y: draft.crop.y - full.y, w: draft.crop.w, h: draft.crop.h };
  }
  function boxToCrop(box) {
    const full = fullRect(draft.rotation);
    return { x: box.x + full.x, y: box.y + full.y, w: box.w, h: box.h };
  }

  function placeCropBox() {
    const full = fullRect(draft.rotation);
    const box = draftBox();
    cropBox.style.left = `${(box.x / full.w) * 100}%`;
    cropBox.style.top = `${(box.y / full.h) * 100}%`;
    cropBox.style.width = `${(box.w / full.w) * 100}%`;
    cropBox.style.height = `${(box.h / full.h) * 100}%`;
    const [outWidth, outHeight] = outputSize(draft);
    cropSize.textContent = `${outWidth} × ${outHeight}`;
    angleInput.value = draft.angle;
    angleReset.textContent = formatAngle(draft.angle);
  }

  function ratioFor(name) {
    const value = ASPECTS[name];
    if (value !== "original") return value;
    const [w, h] = turnedSize(draft.rotation);
    return w / h;
  }

  // Fit a box to an aspect ratio, keeping its centre, within the view.
  function fitToRatio(box, ratio, viewWidth, viewHeight) {
    let { w, h } = box;
    if (w / h > ratio) h = w / ratio;
    else w = h * ratio;
    if (w > viewWidth) [w, h] = [viewWidth, viewWidth / ratio];
    if (h > viewHeight) [w, h] = [viewHeight * ratio, viewHeight];
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    return {
      x: clamp(cx - w / 2, 0, viewWidth - w),
      y: clamp(cy - h / 2, 0, viewHeight - h),
      w,
      h,
    };
  }

  function setAspect(name) {
    aspect = name;
    toolbar.querySelectorAll("[data-aspect]").forEach((button) => {
      button.setAttribute("aria-checked", String(button.dataset.aspect === name));
    });
    const ratio = ratioFor(name);
    cropBox.classList.toggle("locked", ratio !== null);
    if (ratio === null) return;
    // The largest box of this shape, centred where the current box is, that
    // fits inside the turned photo.
    const full = fullRect(draft.rotation);
    const box = draftBox();
    const largest = fitToRatio({ x: 0, y: 0, w: full.w, h: full.h }, ratio, full.w, full.h);
    const centred = {
      ...largest,
      x: clamp(box.x + box.w / 2 - largest.w / 2, 0, full.w - largest.w),
      y: clamp(box.y + box.h / 2 - largest.h / 2, 0, full.h - largest.h),
    };
    setDraftCrop(fitInside(draft, boxToCrop(centred)));
  }

  // Turn by 90° (clockwise for positive), taking the crop with it.
  function rotateBy(degrees) {
    const turn = (r) =>
      degrees > 0 ? { x: -(r.y + r.h), y: r.x, w: r.h, h: r.w } : { x: r.y, y: -(r.x + r.w), w: r.h, h: r.w };
    draft = { ...draft, rotation: (draft.rotation + degrees + 360) % 360, crop: turn(draft.crop) };
    straightenFrom = turn(straightenFrom);
    present();
    if (aspect !== "free") setAspect(aspect);
  }

  // Mirror what's shown, crop included. Mirroring also reverses the turn.
  function flip() {
    const mirror = (r) => ({ ...r, x: -(r.x + r.w) });
    draft = {
      ...draft,
      flip: !draft.flip,
      rotation: (360 - draft.rotation) % 360,
      angle: -draft.angle || 0,
      crop: mirror(draft.crop),
    };
    straightenFrom = mirror(straightenFrom);
    present();
  }

  // Straighten by a fine angle. The crop shrinks to keep the corners filled.
  function setAngle(value) {
    const angle = clamp(Math.round(value * 10) / 10, -45, 45) || 0;
    draft = { ...draft, angle };
    setDraftCrop(fitInside(draft, straightenFrom), { fromDial: true });
    present();
  }

  // Crop to the cut-out's bounds (anything at least slightly opaque), plus
  // padding, matching the aspect ratio if one is set.
  function fitToSubject() {
    // Draw the unframed cut-out at preview size, just for this.
    run();
    const { width: pw, height: ph } = preview;
    const scratch = new OffscreenCanvas(pw, ph);
    const scratchContext = scratch.getContext("2d", { willReadFrequently: true });
    drawCutout(scratchContext);
    const data = scratchContext.getImageData(0, 0, pw, ph).data;
    scratch.width = scratch.height = 0;
    // Bounds of the opaque preview pixels' centres, in view coordinates.
    const { a, b, c, d, e, f } = viewMatrix(draft).multiply(new DOMMatrix().scale(1 / scale));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let y = 0; y < ph; y++) {
      const row = y * pw * 4;
      for (let x = 0; x < pw; x++) {
        if (data[row + x * 4 + 3] <= 16) continue;
        const vx = a * (x + 0.5) + c * (y + 0.5) + e;
        const vy = b * (x + 0.5) + d * (y + 0.5) + f;
        if (vx < minX) minX = vx;
        if (vx > maxX) maxX = vx;
        if (vy < minY) minY = vy;
        if (vy > maxY) maxY = vy;
      }
    }
    if (minX > maxX) return; // nothing to fit to
    const pad = 0.04 * Math.max(maxX - minX, maxY - minY) + 1 / scale;
    const full = fullRect(draft.rotation);
    const x0 = Math.max(full.x, minX - pad);
    const y0 = Math.max(full.y, minY - pad);
    let crop = {
      x: x0,
      y: y0,
      w: Math.min(full.x + full.w, maxX + pad) - x0,
      h: Math.min(full.y + full.h, maxY + pad) - y0,
    };
    const ratio = ratioFor(aspect);
    if (ratio !== null) {
      const box = { ...crop, x: crop.x - full.x, y: crop.y - full.y };
      crop = boxToCrop(fitToRatio(box, ratio, full.w, full.h));
    }
    setDraftCrop(fitInside(draft, crop));
  }

  function startCrop() {
    draft = frame;
    straightenFrom = frame.crop;
    aspect = "free";
    toolbar.querySelectorAll("[data-aspect]").forEach((button) => {
      button.setAttribute("aria-checked", String(button.dataset.aspect === "free"));
    });
    cropBox.classList.remove("locked");
    cropBar.hidden = false;
    cropBox.hidden = false;
    present();
  }

  // Leave the crop tool, applying the draft or throwing it away.
  function finishCrop(apply) {
    if (apply && !same(draft, frame)) {
      frame = draft;
      commit();
    }
    draft = null;
    cropBar.hidden = true;
    cropBox.hidden = true;
    tool = "off"; // so present() shows the committed frame
    present();
  }

  const doneCrop = () => setMode("off");
  const cancelCrop = () => {
    draft = frame; // nothing to apply
    setMode("off");
  };

  const angleInput = toolbar.querySelector('input[name="angle"]');
  const angleReset = toolbar.querySelector(".angle-reset");
  angleInput.addEventListener("input", () => setAngle(Number(angleInput.value)));
  angleReset.addEventListener("click", () => setAngle(0));

  toolbar.querySelectorAll("[data-aspect]").forEach((button) => {
    button.addEventListener("click", () => setAspect(button.dataset.aspect));
  });
  toolbar.querySelector(".rotate-left").addEventListener("click", () => rotateBy(-90));
  toolbar.querySelector(".rotate-right").addEventListener("click", () => rotateBy(90));
  toolbar.querySelector(".flip").addEventListener("click", flip);
  toolbar.querySelector(".fit").addEventListener("click", fitToSubject);
  toolbar.querySelector(".done").addEventListener("click", doneCrop);
  toolbar.querySelector(".cancel").addEventListener("click", cancelCrop);

  // Dragging the crop box (move) or its handles (resize), in view pixels,
  // stopping where the box would leave the turned photo.
  let drag = null;
  cropBox.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    current = editor;
    try {
      cropBox.setPointerCapture(event.pointerId);
    } catch {
      // Not essential.
    }
    drag = {
      handle: event.target.dataset.handle ?? "move",
      start: toOutput(event),
      box: draftBox(),
    };
  });

  cropBox.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const [x, y] = toOutput(event);
    const full = fullRect(draft.rotation);
    const moved = dragBox(drag.box, drag.handle, x - drag.start[0], y - drag.start[1], ratioFor(aspect), full.w, full.h);
    setDraftCrop(towards(draft, boxToCrop(drag.box), boxToCrop(moved)));
  });

  const endDrag = () => {
    drag = null;
  };
  cropBox.addEventListener("pointerup", endDrag);
  cropBox.addEventListener("pointercancel", endDrag);

  // ---- History ----

  function commit() {
    history.splice(position + 1); // a new change discards anything redoable
    history.push({ options, strokes, frame });
    if (history.length > MAX_HISTORY) history.shift();
    position = history.length - 1;
    updateHistoryButtons();
  }

  function restore(index) {
    const before = history[position];
    position = index;
    const state = history[position];
    options = state.options;
    frame = state.frame;
    if (state.strokes !== strokes) {
      strokes = state.strokes;
      replay();
    }
    sync();
    updateHistoryButtons();
    schedule(!same(state.options, before.options) ? "refine" : "composite");
  }

  // Undo/redo are off while cropping: Cancel and Done cover that.
  const canUndo = () => position > 0 && !active && tool !== "crop";
  const canRedo = () => position < history.length - 1 && !active && tool !== "crop";
  const undo = () => canUndo() && restore(position - 1);
  const redo = () => canRedo() && restore(position + 1);

  function updateHistoryButtons() {
    undoButton.disabled = !canUndo();
    redoButton.disabled = !canRedo();
  }

  undoButton.addEventListener("click", () => {
    current = editor;
    undo();
  });
  redoButton.addEventListener("click", () => {
    current = editor;
    redo();
  });

  // ---- Settings ----

  const describe = {
    cutoff: (v) => `${v}%`,
    softness: (v) => `${v}%`,
    // Areas up to 2r mask pixels wide are trimmed; as a share of the photo:
    trimWidth: (v) => `${((200 * v) / maskWidth).toFixed(1)}% of the image`,
    fillSize: (v) => `${v}% of the subject`,
  };

  function sync() {
    for (const control of settings) {
      const value = options[control.name];
      if (control.type === "checkbox") control.checked = value;
      else control.value = value;
      const output = panel.querySelector(`output[data-for="${control.name}"]`);
      if (output) output.textContent = describe[control.name](value);
    }
    panel.querySelector('input[name="trimWidth"]').disabled = !options.trim;
    panel.querySelector('input[name="fillSize"]').disabled = !options.fill;
  }

  settings.forEach((control) => {
    // "input" fires continuously while dragging: update the preview live.
    control.addEventListener("input", () => {
      current = editor;
      options = {
        ...options,
        [control.name]: control.type === "checkbox" ? control.checked : Number(control.value),
      };
      sync();
      schedule("refine");
    });
    // "change" fires once the value is settled: record it for undo.
    control.addEventListener("change", () => {
      if (!same(options, history[position].options)) commit();
    });
  });

  panel.querySelector(".reset").addEventListener("click", () => {
    current = editor;
    if (tool === "crop") cancelCrop();
    const clean = same(options, DEFAULTS) && strokes.length === 0 && same(frame, DEFAULT_FRAME);
    if (clean) return;
    options = { ...DEFAULTS };
    strokes = [];
    frame = DEFAULT_FRAME;
    replay();
    sync();
    commit();
    schedule("refine");
  });

  // ---- Public API ----

  const editor = {
    undo,
    redo,
    setMode,
    adjustBrush: (delta) => setBrushSize(brush.size + delta),
    cropping: () => tool === "crop",
    doneCrop,
    cancelCrop,
    // Render the result at full resolution for downloading, from the
    // original file: applies a crop in progress first, so it matches what's
    // on screen, and flattens onto `background` if given. Free the returned
    // canvas (width = 0) when done; nothing full-size is kept.
    async exportCanvas(background = "") {
      if (tool === "crop") doneCrop();
      run();
      const original = await loadOriginal();
      try {
        const [outWidth, outHeight] = outputSize(frame);
        const out = document.createElement("canvas");
        out.width = outWidth;
        out.height = outHeight;
        const ctx = out.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.setTransform(matrix(frame));
        ctx.drawImage(small, 0, 0, width, height);
        // Brush strokes go straight onto the result, in order, so the latest
        // over a spot wins, as on screen, without full-size brush layers.
        for (const stroke of strokes) {
          ctx.globalCompositeOperation = stroke.mode === "erase" ? "destination-out" : "source-over";
          traceStroke(ctx, stroke);
        }
        ctx.globalCompositeOperation = "source-in";
        ctx.drawImage(original, 0, 0);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (background) {
          ctx.globalCompositeOperation = "destination-over";
          ctx.fillStyle = background;
          ctx.fillRect(0, 0, outWidth, outHeight);
        }
        ctx.globalCompositeOperation = "source-over";
        return out;
      } finally {
        original.close();
      }
    },
  };
  current ??= editor;

  refine();
  present();
  sync();
  setBrushSize(brush.size);
  updateHistoryButtons();
  toolbar.hidden = false;
  panel.hidden = false;

  return editor;
}

// Binary search on [0, 1] for the boundary of a predicate that's true on
// one side: the largest true t if `ascending`, else the smallest true t.
function search(ok, ascending) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid) === ascending) lo = mid;
    else hi = mid;
  }
  return ascending ? lo : hi;
}

function formatAngle(angle) {
  const sign = angle > 0 ? "+" : angle < 0 ? "−" : "";
  return `${sign}${Math.abs(angle).toFixed(1)}°`;
}

// Draw a whole brush stroke (in the context's current coordinates).
function traceStroke(ctx, { points, size }) {
  ctx.beginPath();
  if (points.length === 1) {
    // A zero-length line draws nothing, even with round caps: use a dot.
    ctx.arc(points[0][0], points[0][1], size / 2, 0, 2 * Math.PI);
    ctx.fillStyle = "#000";
    ctx.fill();
    return;
  }
  ctx.moveTo(...points[0]);
  for (const point of points.slice(1)) ctx.lineTo(...point);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = size;
  ctx.strokeStyle = "#000";
  ctx.stroke();
}

// Resize or move a box (in view pixels) by a drag of (dx, dy) on one of its
// handles. With an aspect ratio, only corners resize, from the opposite corner.
function dragBox(start, handle, dx, dy, ratio, viewWidth, viewHeight) {
  let { x, y, w, h } = start;
  if (handle === "move") {
    return { x: clamp(x + dx, 0, viewWidth - w), y: clamp(y + dy, 0, viewHeight - h), w, h };
  }
  let left = x;
  let top = y;
  let right = x + w;
  let bottom = y + h;
  if (handle.includes("w")) left = clamp(left + dx, 0, right - MIN_CROP);
  if (handle.includes("e")) right = clamp(right + dx, left + MIN_CROP, viewWidth);
  if (handle.includes("n")) top = clamp(top + dy, 0, bottom - MIN_CROP);
  if (handle.includes("s")) bottom = clamp(bottom + dy, top + MIN_CROP, viewHeight);
  if (ratio && handle.length === 2) {
    const anchorX = handle.includes("w") ? right : left;
    const anchorY = handle.includes("n") ? bottom : top;
    let newWidth = right - left;
    let newHeight = bottom - top;
    if (newWidth / newHeight > ratio) newWidth = newHeight * ratio;
    else newHeight = newWidth / ratio;
    const maxWidth = handle.includes("w") ? anchorX : viewWidth - anchorX;
    const maxHeight = handle.includes("n") ? anchorY : viewHeight - anchorY;
    if (newWidth > maxWidth) [newWidth, newHeight] = [maxWidth, maxWidth / ratio];
    if (newHeight > maxHeight) [newWidth, newHeight] = [maxHeight * ratio, maxHeight];
    left = handle.includes("w") ? anchorX - newWidth : anchorX;
    top = handle.includes("n") ? anchorY - newHeight : anchorY;
    right = left + newWidth;
    bottom = top + newHeight;
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

// Keyboard shortcuts for the editor last used. Ignored while typing in a
// text field.
document.addEventListener("keydown", (event) => {
  if (!current) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || /^(TEXTAREA|SELECT)$/.test(target.tagName))) return;
  if (target instanceof HTMLInputElement && !["range", "checkbox", "radio", "button"].includes(target.type)) return;

  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (current.cropping()) {
    if (key === "enter") {
      event.preventDefault();
      current.doneCrop();
    } else if (key === "escape") {
      event.preventDefault();
      current.cancelCrop();
    }
    return;
  }
  if (mod && key === "z") {
    event.preventDefault();
    if (event.shiftKey) current.redo();
    else current.undo();
  } else if (mod && key === "y") {
    event.preventDefault();
    current.redo();
  } else if (!mod && !event.altKey) {
    if (key === "e") current.setMode("erase");
    else if (key === "r") current.setMode("restore");
    else if (key === "k") current.setMode("crop");
    else if (key === "c" || key === "escape") current.setMode("off");
    else if (key === "[") current.adjustBrush(-0.5);
    else if (key === "]") current.adjustBrush(0.5);
  }
});
