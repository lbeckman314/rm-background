// UI for the background remover: queues images for the model (worker.js),
// hands each raw mask to an editor (editor.js), and handles downloads and
// the page's controls.

import { createEditor } from "./editor.js";

const $ = (selector) => document.querySelector(selector);

const drop = $("#drop");
const input = $("#input");
const results = $("#results");
const template = $("#item");
const status = $("#status");
const statusText = $("#status-text");
const progressBar = $("#progress");
const colorInput = $("#color");
const exampleCard = $("#example");
const swatches = document.querySelectorAll(".swatch");

let background = ""; // "" = transparent
let device = "";
let worker = null;
let nextId = 0;
const jobs = new Map(); // id -> { file, item, resolve }
const downloads = new Map(); // model file -> { loaded, total }
let queue = Promise.resolve();

function setStatus(text, value) {
  status.hidden = text === null;
  statusText.textContent = text ?? "";
  if (value === undefined) progressBar.removeAttribute("value");
  else progressBar.value = value;
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.addEventListener("message", ({ data }) => {
    switch (data.type) {
      case "status":
        setStatus(data.message);
        break;
      case "download": {
        downloads.set(data.file, { loaded: data.loaded, total: data.total });
        let loaded = 0;
        let total = 0;
        for (const d of downloads.values()) {
          loaded += d.loaded;
          total += d.total;
        }
        const mb = (n) => (n / 1e6).toFixed(0);
        setStatus(
          `Downloading model, first time only… ${mb(loaded)} / ${mb(total)} MB`,
          total ? loaded / total : undefined,
        );
        break;
      }
      case "ready":
        device = data.device === "webgpu" ? "GPU" : "CPU";
        setStatus(null);
        break;
      case "result":
        finish(data.id, data);
        break;
      case "error":
        finish(data.id, null, data.message);
        break;
    }
  });
  // Only fires if worker.js itself can't be loaded; errors inside it are
  // posted back as "error" messages instead.
  worker.addEventListener("error", (event) => {
    event.preventDefault();
    failAll(
      `Couldn't start the model${event.message ? `: ${event.message}` : ""}. ` +
        "Try reloading the page, or a recent version of Chrome, Edge, Firefox or Safari.",
    );
  });
  return worker;
}

function finish(id, result, error) {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  const { item, file } = job;
  item.querySelector(".pending")?.remove();
  const info = item.querySelector(".info");
  if (!result) {
    item.classList.add("error");
    info.textContent = error ?? "Failed";
    setStatus(null);
    job.resolve();
    return;
  }
  job.resolve();
  const { preview, width, height } = job;
  info.textContent = `${width}×${height} · ${(result.ms / 1000).toFixed(1)} s on ${device}`;
  const editor = createEditor(item, {
    ...result,
    preview,
    width,
    height,
    loadOriginal: () => createImageBitmap(file),
  });
  const button = item.querySelector(".download");
  button.disabled = false;
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Preparing…";
    try {
      const canvas = await editor.exportCanvas(background);
      await download(canvas, file.name);
      canvas.width = canvas.height = 0; // free it now rather than whenever
    } catch (error) {
      setStatus(`Couldn't create the download: ${error.message}`);
    } finally {
      button.textContent = "Download";
      button.disabled = false;
    }
  });
}

// Memory: phones reload the page if it uses too much, and a 12 MP photo is
// ~50 MB once decoded. So decode each photo once, keep only a preview for
// the screen and a smaller copy for the model, and let the original go; the
// editor re-reads the file when downloading.
const PREVIEW_SIZE = 1600; // longest side, px
const MODEL_SIZE = 1024; // shortest side the model needs, px (it works at 1024 × 1024)

function scaled(source, scale) {
  if (scale >= 1) return createImageBitmap(source);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);
  return canvas.transferToImageBitmap();
}

async function prepare(file) {
  const original = await createImageBitmap(file);
  const { width, height } = original;
  try {
    return {
      width,
      height,
      preview: await scaled(original, PREVIEW_SIZE / Math.max(width, height)),
      modelInput: await scaled(original, MODEL_SIZE / Math.min(width, height)),
    };
  } finally {
    original.close();
  }
}

// Fail every queued image with the same message, and reset the worker so
// the next image gets a fresh attempt.
function failAll(message) {
  worker?.terminate();
  worker = null;
  for (const id of [...jobs.keys()]) finish(id, null, "Failed, see the message above");
  setStatus(message);
}

// Run one image at a time; the model holds a lot of memory per inference.
// `example` is set for example photos, to show their credit.
function enqueue(file, example = null) {
  const item = template.content.firstElementChild.cloneNode(true);
  item.querySelector(".name").textContent = file.name;
  if (example) showCredit(item.querySelector(".credit"), example);
  item.querySelector(".info").textContent = "Waiting…";
  bindCompare(item);
  applyBackground(item);
  results.prepend(item);
  exampleCard.hidden = true; // results take its place

  queue = queue.then(
    () =>
      new Promise((resolve) => {
        const id = nextId++;
        const job = { file, item, resolve };
        jobs.set(id, job);
        item.querySelector(".info").textContent = "Removing background…";
        prepare(file).then(
          ({ width, height, preview, modelInput }) => {
            Object.assign(job, { width, height, preview });
            // Show the photo while the model runs.
            const before = item.querySelector(".before");
            before.width = preview.width;
            before.height = preview.height;
            before.getContext("2d").drawImage(preview, 0, 0);
            getWorker().postMessage({ id, image: modelInput }, [modelInput]);
          },
          () => finish(id, null, "Couldn't read this image"),
        );
      }),
  );
}

// Wire a before/after comparison's slider.
function bindCompare(container) {
  const compare = container.querySelector(".compare");
  container.querySelector(".slider").addEventListener("input", (e) => {
    if (container.classList.contains("brushing") || container.classList.contains("cropping")) return;
    compare.style.setProperty("--pos", `${e.target.value}%`);
  });
}

function showCredit(element, example) {
  element.textContent = `${example.credit} ${example.license}. `;
  const link = document.createElement("a");
  link.href = example.source;
  link.textContent = "Source";
  element.append(link);
  element.hidden = false;
}

function addFiles(files, example = null) {
  if (location.protocol === "file:") {
    // Browsers don't allow module workers on file:// pages.
    setStatus(
      "This page needs to be served over http(s), not opened from disk. " +
        "In this folder, run `python3 -m http.server 8000` and open http://localhost:8000.",
    );
    return;
  }
  for (const file of files) {
    if (file.type.startsWith("image/")) enqueue(file, example);
  }
}

async function download(canvas, name) {
  const out = await new Promise((r) => canvas.toBlob(r, "image/png"));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(out);
  a.download = `${name.replace(/\.[^.]+$/, "")}-no-bg.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

function applyBackground(item) {
  const wrap = item.querySelector(".after-wrap");
  wrap.style.backgroundColor = background || "";
  wrap.classList.toggle("checker", !background);
}

function selectSwatch(el, value) {
  background = value;
  swatches.forEach((s) => s.setAttribute("aria-checked", String(s === el)));
  results.querySelectorAll(".item").forEach(applyBackground);
  applyBackground(exampleCard);
}

swatches.forEach((swatch) => {
  if (swatch.classList.contains("custom")) return;
  swatch.addEventListener("click", () => selectSwatch(swatch, swatch.dataset.bg ?? ""));
});
colorInput.addEventListener("input", () => {
  const custom = colorInput.closest(".swatch");
  custom.style.setProperty("--sw", colorInput.value);
  selectSwatch(custom, colorInput.value);
});

// ---- Examples ----
//
// The main example is precomputed (examples/astronaut-cutout.webp), so
// seeing it needs no model download. "Try it" and the thumbnails below the
// controls run the real thing on example photos (examples/examples.json).

let examples = [];

async function tryExample(id, button) {
  const example = examples.find((e) => e.id === id);
  if (!example) return;
  button.disabled = true;
  try {
    const response = await fetch(new URL(`./examples/${id}.jpg`, import.meta.url));
    if (!response.ok) throw new Error(response.statusText);
    const blob = await response.blob();
    addFiles([new File([blob], `${id}.jpg`, { type: blob.type || "image/jpeg" })], example);
  } catch (error) {
    setStatus(`Couldn't load the example image: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

bindCompare(exampleCard);
applyBackground(exampleCard);
$("#try-example").addEventListener("click", (e) => tryExample("astronaut", e.currentTarget));

fetch(new URL("./examples/examples.json", import.meta.url))
  .then((r) => r.json())
  .then((data) => {
    examples = data.examples;
    const strip = $("#thumbs");
    for (const example of examples.filter((e) => e.demo)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "thumb";
      button.title = `${example.title}: ${example.tests}`;
      button.setAttribute("aria-label", `Try the ${example.title.toLowerCase()} example`);
      const image = document.createElement("img");
      image.src = `examples/thumbs/${example.id}.jpg`;
      image.alt = "";
      image.loading = "lazy";
      const label = document.createElement("span");
      label.textContent = example.title;
      button.append(image, label);
      button.addEventListener("click", () => tryExample(example.id, button));
      strip.append(button);
    }
    $("#gallery").hidden = strip.children.length === 0;
  })
  .catch(() => {
    // The gallery is optional; the page works without it.
  });

// The photo/file picker allows several at once; the camera (on phones) one
// per shot. Either way each pick adds to the results, so picking again adds
// more rather than replacing.
for (const picker of [input, $("#camera")]) {
  picker.addEventListener("change", () => {
    addFiles(picker.files ?? []);
    picker.value = "";
  });
}
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  addFiles(e.dataTransfer?.files ?? []);
});
document.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) addFiles(files);
});
