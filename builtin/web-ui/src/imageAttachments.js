export const IMAGE_TOKEN_RE = /\[image\s+(\d+)\]/gi;

export function normalizeImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter((item) => item && typeof item === "object")
    .map((item, index) => ({
      id: String(item.id || `image-${index + 1}`),
      label: String(item.label || `image ${index + 1}`),
      name: String(item.name || `image-${index + 1}`),
      mimeType: String(item.mimeType || item.type || "image/png"),
      dataUrl: String(item.dataUrl || item.data || ""),
    }))
    .filter((item) => item.dataUrl.startsWith("data:image/"));
}

export function nextImageLabel(images) {
  return `image ${normalizeImages(images).length + 1}`;
}

export function appendImageToken(body, label) {
  const text = String(body || "");
  const token = `[${label}]`;
  if (!text.trim()) return token;
  return `${text.replace(/[ \t]+$/u, "")} ${token}`;
}

export function filterImagesReferencedByBody(images, body) {
  const list = normalizeImages(images);
  const text = String(body || "");
  const labels = new Set();
  IMAGE_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = IMAGE_TOKEN_RE.exec(text))) {
    labels.add(`image ${match[1]}`.toLowerCase());
  }
  if (labels.size === 0) return [];
  return list.filter((item) => labels.has(String(item.label || "").toLowerCase()));
}

export function renderImagesForPrompt(images) {
  const list = normalizeImages(images);
  if (list.length === 0) return "";
  const blocks = list.map((item, index) => {
    const label = item.label || `image ${index + 1}`;
    return [
      `### [${label}]`,
      `name: ${item.name || label}`,
      `mimeType: ${item.mimeType || "image/png"}`,
      `dataUrl: ${item.dataUrl}`,
    ].join("\n");
  });
  return `## 图片附件\n\n${blocks.join("\n\n")}`;
}

export function readImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!file || !String(file.type || "").startsWith("image/")) {
      reject(new Error("Only image files are supported"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        name: file.name || "image",
        mimeType: file.type || "image/png",
        dataUrl: String(reader.result || ""),
      });
    };
    reader.onerror = () => reject(reader.error || new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });
}

export function imageFilesFromClipboardEvent(event) {
  const items = Array.from(event?.clipboardData?.items || []);
  return items
    .filter((item) => item.kind === "file" && String(item.type || "").startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);
}

export function imageFilesFromDropEvent(event) {
  return Array.from(event?.dataTransfer?.files || []).filter((file) => String(file.type || "").startsWith("image/"));
}

export async function addImageFiles({ files, body, images }) {
  const incoming = Array.from(files || []);
  if (incoming.length === 0) return null;
  let nextBody = String(body || "");
  const nextImages = normalizeImages(images);
  for (const file of incoming) {
    const payload = await readImageFile(file);
    const label = nextImageLabel(nextImages);
    nextImages.push({
      id: `${Date.now().toString(36)}-${nextImages.length + 1}`,
      label,
      ...payload,
    });
    nextBody = appendImageToken(nextBody, label);
  }
  return { body: nextBody, images: nextImages };
}
