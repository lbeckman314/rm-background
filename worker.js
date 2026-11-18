// Background removal, run entirely in this browser tab.
//
// Runs in a Web Worker started by app.js. There's no build step: transformers.js
// is loaded from a pinned CDN version, and the model weights from the Hugging
// Face hub.
// Neither ever sees the images - they're only read from the File the page
// posts here, and the mask is posted back.

const LIBRARY = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2";
const MODEL = "briaai/RMBG-1.4";

// Imported on first use, rather than with a top-level import, so that a
// failure (offline, CDN blocked by an extension or network) is caught and
// reported to the page instead of silently killing the worker.
let AutoModel, AutoProcessor, RawImage;

async function importLibrary() {
  if (AutoModel) return;
  let lib;
  try {
    lib = await import(LIBRARY);
  } catch (error) {
    throw new Error(
      `Couldn't download transformers.js from ${new URL(LIBRARY).host}. ` +
        `Check your connection, or whether an extension is blocking it. (${error?.message ?? error})`,
    );
  }
  ({ AutoModel, AutoProcessor, RawImage } = lib);
  // Only fetch from the hub, and keep the weights in the browser's Cache
  // Storage so later visits don't download them again.
  lib.env.allowLocalModels = false;
  lib.env.useBrowserCache = true;
}

// Tried in order: fp16 on the GPU is fastest (~88 MB); 8-bit quantized on
// the CPU (WASM) is the smallest download (~44 MB) and runs everywhere.
const BACKENDS = [
  { device: "webgpu", dtype: "fp16" },
  { device: "wasm", dtype: "q8" },
];

let model = null;
let processor = null;
let backend = null;
let loading = null;

async function hasWebGPU() {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    return Boolean(adapter?.features.has("shader-f16"));
  } catch {
    return false;
  }
}

function progress(info) {
  // Per-file download progress; the page sums these into one bar.
  if (info.status === "progress" || info.status === "done") {
    postMessage({
      type: "download",
      file: info.file,
      loaded: info.loaded ?? info.total ?? 0,
      total: info.total ?? 0,
    });
  }
}

async function load(skip = 0) {
  await importLibrary();
  const gpu = await hasWebGPU();
  const candidates = BACKENDS.slice(skip).filter(
    (b) => b.device !== "webgpu" || gpu,
  );
  let lastError;
  for (const candidate of candidates) {
    try {
      postMessage({ type: "status", message: `Loading model (${candidate.device})…` });
      // RMBG's config.json has a model_type transformers.js doesn't know,
      // so load it as a "custom" model rather than via pipeline().
      [model, processor] = await Promise.all([
        AutoModel.from_pretrained(MODEL, {
          ...candidate,
          config: { model_type: "custom" },
          progress_callback: progress,
        }),
        processor ?? AutoProcessor.from_pretrained(MODEL, { progress_callback: progress }),
      ]);
      backend = candidate;
      postMessage({ type: "ready", device: candidate.device });
      return;
    } catch (error) {
      console.warn(`Couldn't load ${MODEL} on ${candidate.device}`, error);
      lastError = error;
    }
  }
  throw lastError ?? new Error("No supported backend.");
}

// Predict the mask at the model's resolution. Cleaning it up and scaling it
// to the photo happen on the page (mask.js), so they can be re-tuned without
// running the model again.
async function infer(image) {
  const { pixel_values } = await processor(image);
  const [inputName] = model.sessions.model.inputNames;
  const outputs = await model({ [inputName]: pixel_values });
  let prediction = Object.values(outputs)[0][0];
  // Some models output logits rather than probabilities.
  if (prediction.data.some((x) => x < -1e-5 || x > 1 + 1e-5)) prediction = prediction.sigmoid();
  const mask = RawImage.fromTensor(prediction.mul(255).to("uint8"));
  return { mask: mask.data, maskWidth: mask.width, maskHeight: mask.height };
}

async function removeBackground(file) {
  const image = await RawImage.fromBlob(file);
  try {
    return await infer(image);
  } catch (error) {
    // Some GPUs load the model but fail at inference; drop to the CPU once.
    if (backend?.device !== "webgpu") throw error;
    console.warn("WebGPU inference failed, falling back to WASM", error);
    await model.dispose?.();
    await load(BACKENDS.findIndex((b) => b.device === "wasm"));
    return await infer(image);
  }
}

self.addEventListener("message", async ({ data }) => {
  const { id, file } = data;
  try {
    loading ??= load();
    await loading;
    const started = performance.now();
    const result = await removeBackground(file);
    postMessage(
      { type: "result", id, ...result, ms: Math.round(performance.now() - started) },
      [result.mask.buffer],
    );
  } catch (error) {
    loading = null; // allow a retry on the next image
    postMessage({ type: "error", id, message: String(error?.message ?? error) });
  }
});
