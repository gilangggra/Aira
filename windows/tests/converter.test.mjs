// Pure helpers for Aira's local file converter (src/core/converter.ts).

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  engineRequirementLabel,
  fileCategory,
  fileExtension,
  formatBytes,
  isConvertibleFileName,
} = await import("../src/core/converter.ts");

test("extracts lowercase extensions safely", () => {
  assert.equal(fileExtension("clip.MP4"), "mp4");
  assert.equal(fileExtension("C:\\Users\\demo\\slides.pptx"), "pptx");
  assert.equal(fileExtension("/home/user/notes.Markdown"), "markdown");
  assert.equal(fileExtension(".gitignore"), "");
  assert.equal(fileExtension("README"), "");
});

test("classifies media and document formats supported by FFmpeg, LibreOffice, and Pandoc", () => {
  for (const name of ["movie.mp4", "clip.mov", "demo.mkv", "anim.gif", "song.wav", "voice.m4a"]) {
    assert.equal(fileCategory(name), "media", name);
    assert.equal(isConvertibleFileName(name), true, name);
  }
  for (const name of ["report.docx", "sheet.xlsx", "slides.pptx", "book.epub", "notes.md", "file.pdf", "page.html"]) {
    assert.equal(fileCategory(name), "document", name);
    assert.equal(isConvertibleFileName(name), true, name);
  }
  for (const name of ["archive.zip", "app.exe", "script.ts", "photo.png"]) {
    assert.equal(fileCategory(name), "unsupported", name);
    assert.equal(isConvertibleFileName(name), false, name);
  }
});

test("formats byte sizes and engine requirements clearly", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(12 * 1024 * 1024), "12 MB");

  assert.equal(
    engineRequirementLabel({
      id: "mp3",
      label: "Extract MP3",
      ext: "mp3",
      engine: "ffmpeg",
      secondaryEngine: null,
      available: true,
    }),
    "FFmpeg",
  );
  assert.equal(
    engineRequirementLabel({
      id: "pdf",
      label: "PDF",
      ext: "pdf",
      engine: "pandoc",
      secondaryEngine: "libreoffice",
      available: false,
    }),
    "Pandoc + LibreOffice",
  );
});
