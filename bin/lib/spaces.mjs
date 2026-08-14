import crypto from "crypto";
import fs from "fs";
import path from "path";

import { getAgentflowDataRoot } from "./paths.mjs";

export const SPACES_FILENAME = "spaces.json";

function spacesPath() {
  return path.join(getAgentflowDataRoot(), SPACES_FILENAME);
}

function cleanText(value, max = 200) {
  return String(value || "").trim().slice(0, max);
}

export function normalizeSpaceSlug(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function normalizeSpaceVisibility(value = "public") {
  return String(value || "").trim().toLowerCase() === "private" ? "private" : "public";
}

export function normalizeSpacePagePath(value = "/") {
  const raw = String(value || "").trim();
  if (!raw || raw === "/") return "/";
  const parts = raw.split("/").map((part) => normalizeSpaceSlug(part)).filter(Boolean);
  return parts.length ? `/${parts.join("/")}` : "/";
}

function normalizePage(page = {}, index = 0) {
  const shareId = cleanText(page.shareId, 160);
  if (!shareId) return null;
  const pagePath = normalizeSpacePagePath(page.path || page.route || "/");
  return {
    id: cleanText(page.id, 100) || `page_${crypto.randomBytes(8).toString("hex")}`,
    title: cleanText(page.title, 160) || (pagePath === "/" ? "首页" : pagePath.split("/").filter(Boolean).pop()),
    path: pagePath,
    shareId,
    hidden: page.hidden === true,
    order: Number.isFinite(Number(page.order)) ? Number(page.order) : index,
    createdAt: cleanText(page.createdAt, 80) || new Date().toISOString(),
    updatedAt: cleanText(page.updatedAt, 80) || new Date().toISOString(),
  };
}

function normalizeSpace(space = {}) {
  const ownerId = cleanText(space.ownerId, 100);
  const slug = normalizeSpaceSlug(space.slug);
  if (!ownerId || !slug) return null;
  const pages = (Array.isArray(space.pages) ? space.pages : [])
    .map(normalizePage)
    .filter(Boolean)
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
  return {
    id: cleanText(space.id, 100) || `space_${crypto.randomBytes(8).toString("hex")}`,
    ownerId,
    slug,
    title: cleanText(space.title, 160) || slug,
    description: cleanText(space.description, 1000),
    visibility: normalizeSpaceVisibility(space.visibility),
    status: String(space.status || "active").trim().toLowerCase() === "paused" ? "paused" : "active",
    pages,
    createdAt: cleanText(space.createdAt, 80) || new Date().toISOString(),
    updatedAt: cleanText(space.updatedAt, 80) || new Date().toISOString(),
  };
}

export function readSpaces() {
  const file = spacesPath();
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    const input = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.spaces) ? parsed.spaces : [];
    return input.map(normalizeSpace).filter(Boolean);
  } catch {
    return [];
  }
}

export function writeSpaces(spaces = []) {
  const file = spacesPath();
  const normalized = (Array.isArray(spaces) ? spaces : []).map(normalizeSpace).filter(Boolean);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, spaces: normalized }, null, 2)}\n`, "utf-8");
  fs.renameSync(temp, file);
  return normalized;
}

export function listSpacesForUser(userId = "", isAdmin = false) {
  const actor = cleanText(userId, 100);
  return readSpaces().filter((space) => isAdmin || space.ownerId === actor);
}

export function getSpaceById(id = "") {
  const wanted = cleanText(id, 100);
  return readSpaces().find((space) => space.id === wanted) || null;
}

export function getSpaceByRoute(ownerId = "", slug = "") {
  const owner = cleanText(ownerId, 100);
  const safeSlug = normalizeSpaceSlug(slug);
  return readSpaces().find((space) => space.ownerId === owner && space.slug === safeSlug) || null;
}

export function createSpace({ ownerId, slug, title, description = "", visibility = "public" } = {}) {
  const owner = cleanText(ownerId, 100);
  const safeSlug = normalizeSpaceSlug(slug || title);
  if (!owner) return { error: "Missing space owner" };
  if (!safeSlug) return { error: "Space slug must contain letters or numbers" };
  const spaces = readSpaces();
  if (spaces.some((space) => space.ownerId === owner && space.slug === safeSlug)) {
    return { error: "Space slug already exists" };
  }
  const now = new Date().toISOString();
  const space = normalizeSpace({
    id: `space_${crypto.randomBytes(8).toString("hex")}`,
    ownerId: owner,
    slug: safeSlug,
    title: title || safeSlug,
    description,
    visibility,
    pages: [],
    createdAt: now,
    updatedAt: now,
  });
  spaces.push(space);
  writeSpaces(spaces);
  return { space };
}

export function updateSpace(id = "", patch = {}) {
  const spaces = readSpaces();
  const index = spaces.findIndex((space) => space.id === cleanText(id, 100));
  if (index < 0) return { error: "Space not found" };
  const current = spaces[index];
  const nextSlug = patch.slug == null ? current.slug : normalizeSpaceSlug(patch.slug);
  if (!nextSlug) return { error: "Space slug must contain letters or numbers" };
  if (spaces.some((space, itemIndex) => itemIndex !== index && space.ownerId === current.ownerId && space.slug === nextSlug)) {
    return { error: "Space slug already exists" };
  }
  const next = normalizeSpace({
    ...current,
    ...(patch.title == null ? {} : { title: patch.title }),
    ...(patch.description == null ? {} : { description: patch.description }),
    ...(patch.visibility == null ? {} : { visibility: patch.visibility }),
    ...(patch.status == null ? {} : { status: patch.status }),
    slug: nextSlug,
    updatedAt: new Date().toISOString(),
  });
  spaces[index] = next;
  writeSpaces(spaces);
  return { space: next };
}

export function upsertSpacePage(spaceId = "", input = {}) {
  const spaces = readSpaces();
  const spaceIndex = spaces.findIndex((space) => space.id === cleanText(spaceId, 100));
  if (spaceIndex < 0) return { error: "Space not found" };
  const space = spaces[spaceIndex];
  const pagePath = normalizeSpacePagePath(input.path || "/");
  const existingIndex = space.pages.findIndex((page) => page.path === pagePath);
  const previous = existingIndex >= 0 ? space.pages[existingIndex] : {};
  const page = normalizePage({
    ...previous,
    ...input,
    id: previous.id || input.id,
    path: pagePath,
    order: existingIndex >= 0 ? previous.order : space.pages.length,
    createdAt: previous.createdAt || input.createdAt,
    updatedAt: new Date().toISOString(),
  }, existingIndex >= 0 ? existingIndex : space.pages.length);
  if (!page) return { error: "Missing display share" };
  if (existingIndex >= 0) space.pages[existingIndex] = page;
  else space.pages.push(page);
  space.updatedAt = new Date().toISOString();
  spaces[spaceIndex] = normalizeSpace(space);
  writeSpaces(spaces);
  return { space: spaces[spaceIndex], page };
}

export function deleteSpacePage(spaceId = "", pageId = "") {
  const spaces = readSpaces();
  const spaceIndex = spaces.findIndex((space) => space.id === cleanText(spaceId, 100));
  if (spaceIndex < 0) return { error: "Space not found" };
  const before = spaces[spaceIndex].pages.length;
  spaces[spaceIndex].pages = spaces[spaceIndex].pages.filter((page) => page.id !== cleanText(pageId, 100));
  if (spaces[spaceIndex].pages.length === before) return { error: "Space page not found" };
  spaces[spaceIndex].pages = spaces[spaceIndex].pages.map((page, index) => ({ ...page, order: index }));
  spaces[spaceIndex].updatedAt = new Date().toISOString();
  writeSpaces(spaces);
  return { space: spaces[spaceIndex] };
}
