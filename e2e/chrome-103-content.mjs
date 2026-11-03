import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { deflateSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { filePanelFixture, checkFilePanel } from "./file-panel.mjs";
import { showSidebarSessions } from "./sidebar.mjs";

const CONTENT_SESSION = "chrome-103-content";
const CONTENT_TITLE = "Chrome103 content fixture";

/**
 * 计算 PNG 和 ZIP 共用的 CRC32 校验值。
 * @param {Buffer} bytes 需要校验的完整字节。
 * @returns {number} 无符号 32 位校验值。
 */
function crc32(bytes) {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

/**
 * 创建 PNG 数据块及 CRC，保证图片夹具不依赖不明来源的 base64 常量。
 * @param {string} type PNG 数据块类型。
 * @param {Buffer} bytes 数据块载荷。
 * @returns {Buffer} 包含长度、类型、载荷和校验值的数据块。
 */
function pngChunk(type, bytes) {
  const body = Buffer.concat([Buffer.from(type), bytes]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * 生成 16×16 蓝色 RGB PNG，用真实解码结果验证图片浏览器。
 * @returns {Buffer} 完整 PNG 文件。
 */
function createPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(16, 0);
  header.writeUInt32BE(16, 4);
  header[8] = 8;
  header[9] = 2;
  const scanlines = Buffer.alloc(16 * 49);
  for (let row = 0; row < 16; row += 1) {
    for (let column = 0; column < 16; column += 1) {
      const offset = row * 49 + 1 + column * 3;
      scanlines[offset] = 39;
      scanlines[offset + 1] = 99;
      scanlines[offset + 2] = 181;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(scanlines)), pngChunk("IEND", Buffer.alloc(0))]);
}

/**
 * 创建不压缩的 ZIP，保持 prepare 函数同步且不依赖安装额外工具。
 * @param {Record<string, string>} entries ZIP 内的相对路径及 UTF-8 内容。
 * @returns {Buffer} 包含本地头、中央目录和结束记录的 ZIP 文件。
 */
function createZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const filename = Buffer.from(name);
    const bytes = Buffer.from(text);
    const checksum = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x21, 14);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(bytes.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, filename, bytes);
    central.push(directory, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const directoryBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directoryBytes, end]);
}

/**
 * 创建包含段落、粗体和表格的最小 OpenXML 文档。
 * @returns {Buffer} 供真实 mammoth 转换链路读取的 DOCX 字节。
 */
function createDocx() {
  return createZip({
    "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/_rels/document.xml.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    "word/document.xml": '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Chrome103 DOCX preview</w:t></w:r></w:p><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Converted bold content</w:t></w:r></w:p><w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4500"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Document table cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>',
  });
}

/**
 * 创建两秒单声道 PCM WAV，避免调用系统录音或下载媒体。
 * @returns {Buffer} 8kHz、16bit PCM WAV 字节。
 */
function createWav() {
  const sampleRate = 8000;
  const samples = sampleRate * 2;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) bytes.writeInt16LE(Math.round(Math.sin(index * 440 * Math.PI * 2 / sampleRate) * 8000), 44 + index * 2);
  return bytes;
}

/**
 * 生成有两个页面和正确交叉引用表的 PDF，不依赖外部程序。
 * @param {number} pageCount 测试文档页数。
 * @returns {Buffer} 可由真实文件 API 返回的 PDF 字节。
 */
function createPdf(pageCount) {
  const chunks = ["%PDF-1.4\n"];
  const offsets = [];
  let size = Buffer.byteLength(chunks[0], "latin1");
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pageCount} /Kids [${Array.from({ length: pageCount }, (_, index) => `${4 + index * 2} 0 R`).join(" ")}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let index = 0; index < pageCount; index += 1) {
    const stream = `BT /F1 24 Tf 40 700 Td (Chrome103 page ${index + 1}) Tj ET\n`;
    bodies.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`);
    bodies.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`);
  }
  for (const [index, body] of bodies.entries()) {
    offsets.push(size);
    const chunk = `${index + 1} 0 obj\n${body}\nendobj\n`;
    chunks.push(chunk);
    size += Buffer.byteLength(chunk, "latin1");
  }
  const xref = size;
  chunks.push(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) chunks.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  chunks.push(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(""), "latin1");
}

/**
 * 在服务启动前创建独立内容会话及项目内文件，所有路径都留在隔离目录。
 * @param {{project: string, sessionDirectory: string, timestamp: string}} options 项目、会话目录及固定时间。
 * @returns {{sessionId: string, title: string, files: Record<string, string>, pdfBytes: number}} 内容测试夹具。
 */
export function prepareFullSiteContent({ project, sessionDirectory, timestamp }) {
  mkdirSync(project, { recursive: true });
  mkdirSync(sessionDirectory, { recursive: true });
  const files = Object.fromEntries(Object.entries({
    csv: "compat-content.csv", tsv: "compat-content.tsv", html: "compat-content.html",
    image: "compat-content.png", source: "compat-content.ts", markdown: "compat-content.md",
    pdf: "compat-content.pdf", docx: "compat-content.docx", audio: "compat-content.wav", video: "compat-content.webm", binary: "compat-content.bin",
  }).map(([kind, name]) => [kind, join(project, name)]));
  // CSV 包含跨行字段，验证虚拟表格的源行号而不仅是普通分隔符。
  writeFileSync(files.csv, 'Name,Note,Count\nAlpha,"line one\nline two",7\n' + Array.from({ length: 200 }, (_, index) => `Row ${index},value ${index},${index}\n`).join(""));
  writeFileSync(files.tsv, "Name\tStatus\tCount\nBeta\tReady\t12\nGamma\tPending\t13\n");
  writeFileSync(files.html, filePanelFixture);
  writeFileSync(files.image, createPng());
  writeFileSync(files.docx, createDocx());
  writeFileSync(files.audio, createWav());
  // WebM 由待测浏览器在验收阶段实际编码，此处仅建立列表和会话引用。
  writeFileSync(files.video, Buffer.alloc(0));
  writeFileSync(files.binary, Buffer.from([0x50, 0x49, 0x00, 0x57, 0x45, 0x42, 0xff, 0x10]));
  writeFileSync(files.source, "// Chrome103 source fixture\nexport const compatibilityValue = 103;\n");
  writeFileSync(files.markdown, "# Compatibility file preview\n\n**Markdown file works**\n\n| Name | State |\n| --- | --- |\n| Preview | Ready |\n");
  const pdf = createPdf(2);
  writeFileSync(files.pdf, pdf);
  // 正斜杠加尖括号链接可同时保留 Windows 盘符和带空格的临时目录。
  const links = Object.entries(files).map(([kind, filePath]) => `[Open content ${kind}](<${filePath.replace(/\\/g, "/")}>)`).join("\n\n");
  const markdown = "Chrome103 final answer\n\n**Compatibility strong text** and inline $a^2+b^2=c^2$.\n\n"
    + "```js\nconst chromeCompatibility = 103;\nconsole.log(chromeCompatibility);\n```\n\n"
    + "| Capability | State |\n| --- | --- |\n| Browser | Chrome103 ready |\n| 中文 | 内容正常 |\n\n"
    + "$$\nE = mc^2\n$$\n\n"
    + '```svg\n<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80" viewBox="0 0 160 80"><rect width="160" height="80" fill="#2763b5"/><text x="10" y="45" fill="white">Chrome103 SVG</text></svg>\n```\n\n'
    // HTTPS 链接让 Mermaid 真正执行 sanitize-url 的 URL.canParse 路径。
    + '```mermaid\ngraph TD\n A[Chrome103 Start] --> B[Compatibility Ready]\n click A href "https://example.invalid/chrome103" "Compatibility link"\n```\n\n'
    // 图片目的地不走 Windows link 的协议重写；用相对路径让 MarkdownImage 按 cwd 解析。
    + `![Content image](./${basename(files.image)})\n\n`
    + links + `\n\n[Open content pdf page 2](<${files.pdf.replace(/\\/g, "/")}#page=2>)`;
  const entries = [
    { type: "session", version: 3, id: CONTENT_SESSION, timestamp, cwd: project },
    { type: "message", id: "content-user", parentId: null, timestamp, message: { role: "user", content: CONTENT_TITLE } },
    { type: "message", id: "content-alternate", parentId: "content-user", timestamp, message: { role: "assistant", content: "Chrome103 alternate branch" } },
    { type: "message", id: "content-call", parentId: "content-user", timestamp, message: { role: "assistant", content: [
      { type: "thinking", thinking: "Chrome103 reasoning\nReasoning details remain readable in the old browser." },
      { type: "text", text: "Chrome103 process paragraph" },
      { type: "toolCall", id: "content-tool", name: "bash", arguments: { command: "echo Chrome103 tool output" } },
    ] } },
    { type: "message", id: "content-result", parentId: "content-call", timestamp, message: {
      role: "toolResult", toolCallId: "content-tool", toolName: "bash", isError: false,
      content: [{ type: "text", text: "Chrome103 tool output" }],
    } },
    { type: "message", id: "content-answer", parentId: "content-result", timestamp, message: { role: "assistant", content: [{ type: "text", text: markdown }] } },
  ];
  writeFileSync(join(sessionDirectory, `${timestamp.replace(/[:.]/g, "-")}_${CONTENT_SESSION}.jsonl`), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { sessionId: CONTENT_SESSION, title: CONTENT_TITLE, files, pdfBytes: pdf.length };
}

/**
 * 确认图片已成功解码并且有可见面积，加载占位或错误提示不能通过断言。
 * @param {import('playwright').Locator} image 需要验证的图片。
 */
async function assertDecodedImage(image) {
  await image.waitFor({ state: "visible" });
  await image.scrollIntoViewIfNeeded();
  await image.evaluate(async (element) => {
    await element.decode();
    if (!element.complete || element.naturalWidth <= 0 || element.naturalHeight <= 0) throw new Error("Image did not decode");
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) throw new Error("Image has no rendered area");
  });
}

/**
 * 验证图表原生对话框、缩放、复位以及 Escape 关闭。
 * @param {import('playwright').Page} page 测试页面。
 * @param {string} name 对话框的英文可访问名称。
 */
async function checkDiagramDialog(page, name) {
  const dialog = page.getByRole("dialog", { name, exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.evaluate((element) => element.open), true);
  await dialog.getByRole("button", { name: "Zoom in", exact: true }).click();
  assert.equal(await dialog.locator(".mermaid-zoom-value").innerText(), "125%");
  assert.equal(await dialog.locator(".mermaid-zoom-canvas").evaluate((element) => element.style.width), "125%");
  await dialog.getByRole("button", { name: "Zoom out", exact: true }).click();
  assert.equal(await dialog.locator(".mermaid-zoom-value").innerText(), "100%");
  await dialog.getByRole("button", { name: "Zoom in", exact: true }).click();
  await dialog.getByRole("button", { name: "Fit to width", exact: true }).click();
  assert.equal(await dialog.locator(".mermaid-zoom-value").innerText(), "100%");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
}

/**
 * 通过会话 Markdown 链接打开文件，避免在页面上注入内部 React 状态。
 * @param {import('playwright').Page} page 测试页面。
 * @param {string} kind 文件链接标识。
 * @returns {Promise<import('playwright').Locator>} 已显示的文件面板。
 */
async function openContentFile(page, kind) {
  await page.getByRole("link", { name: `Open content ${kind}`, exact: true }).click();
  const panel = page.locator("#file-panel");
  await panel.waitFor({ state: "visible" });
  return panel;
}

/**
 * 用待测浏览器自己的 VP8 编码器录制短视频，不插入测试用假播放器。
 * @param {import('playwright').Page} page 已加载应用的可见页面。
 * @returns {Promise<Buffer>} 160×90 的真实 VP8 WebM 文件字节。
 */
async function recordVideoFixture(page) {
  const bytes = await page.evaluate(async () => {
    const mimeType = 'video/webm;codecs=vp8';
    if (typeof MediaRecorder !== "function" || !MediaRecorder.isTypeSupported(mimeType)) throw new Error("Required fixture codec unsupported: MediaRecorder VP8/WebM");
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    const context = canvas.getContext("2d");
    if (!context || typeof canvas.captureStream !== "function") throw new Error("Required video fixture API unsupported: canvas.captureStream");
    context.fillStyle = "rgb(39,99,181)";
    context.fillRect(0, 0, 160, 90);
    const stream = canvas.captureStream(12);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 100_000 });
    const chunks = [];
    let frame = 0;
    const interval = setInterval(() => {
      context.fillStyle = "rgb(39,99,181)";
      context.fillRect(0, 0, 160, 90);
      context.fillStyle = "rgb(220,70,50)";
      context.fillRect(5 + (frame % 12) * 5, 8, 25, 25);
      frame += 1;
    }, 80);
    let stopTimer;
    let failureTimer;
    try {
      return await new Promise((resolve, reject) => {
        recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
        recorder.onerror = () => reject(new Error("VP8 MediaRecorder failed"));
        recorder.onstop = async () => {
          try {
            const blob = new Blob(chunks, { type: mimeType });
            if (blob.size < 100) throw new Error("VP8 recorder produced no usable media bytes");
            resolve(Array.from(new Uint8Array(await blob.arrayBuffer())));
          } catch (error) { reject(error); }
        };
        failureTimer = setTimeout(() => reject(new Error("VP8 recording did not stop")), 8000);
        recorder.start();
        stopTimer = setTimeout(() => recorder.stop(), 1600);
      });
    } finally {
      clearInterval(interval);
      clearTimeout(stopTimer);
      clearTimeout(failureTimer);
      if (recorder.state !== "inactive") recorder.stop();
      for (const track of stream.getTracks()) track.stop();
    }
  });
  return Buffer.from(bytes);
}

/**
 * 验证实际媒体解码、时钟推进、暂停和 seek；视频还检查解码帧的像素。
 * @param {import('playwright').Page} page 应用页面。
 * @param {"audio"|"video"} kind 需要验证的 FileViewer 媒体分支。
 * @returns {Promise<{duration:number|string,currentTime:number,width?:number,height?:number}>} 实际媒体元数据。
 */
async function checkMediaPlayback(page, kind) {
  const media = page.locator(`#file-panel ${kind}`);
  await media.waitFor();
  assert.notEqual(await media.evaluate((element, mediaKind) => element.canPlayType(mediaKind === "audio" ? "audio/wav" : 'video/webm; codecs="vp8"'), kind), "", `Required ${kind} fixture codec must be supported`);
  // 初次 watch 同步会把 v=1 写入 src；等它完成后再播放，避免把重载当暂停。
  await page.waitForFunction((mediaKind) => {
    const element = document.querySelector(`#file-panel ${mediaKind}`);
    return element && element.currentSrc && new URL(element.currentSrc).searchParams.has("v") && element.readyState >= 1 && !element.error;
  }, kind);
  const metadata = await media.evaluate((element) => ({
    duration: Number.isFinite(element.duration) ? element.duration : String(element.duration),
    width: element.videoWidth, height: element.videoHeight,
  }));
  if (kind === "audio") assert.ok(typeof metadata.duration === "number" && Math.abs(metadata.duration - 2) < 0.1, "PCM WAV duration must be two seconds");
  else {
    assert.equal(metadata.width, 160);
    assert.equal(metadata.height, 90);
  }
  await media.evaluate(async (element) => { element.muted = true; await element.play(); });
  await page.waitForFunction((mediaKind) => {
    const element = document.querySelector(`#file-panel ${mediaKind}`);
    return element && !element.paused && element.currentTime > 0.15 && element.readyState >= 2 && !element.error;
  }, kind);
  await media.evaluate((element) => element.pause());
  assert.equal(await media.evaluate((element) => element.paused), true);
  const currentTime = await media.evaluate(async (element) => {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Media seek did not complete")), 8000);
      element.addEventListener("seeked", () => { clearTimeout(timeout); resolve(); }, { once: true });
      element.currentTime = 0.75;
    });
    if (element.error || element.readyState < 2) throw new Error("Media seek has no decoded frame");
    return element.currentTime;
  });
  assert.ok(Math.abs(currentTime - 0.75) < 0.12, `${kind} must seek to 0.75 seconds`);
  if (kind === "video") {
    const pixel = await media.evaluate((element) => {
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 90;
      const context = canvas.getContext("2d");
      context.drawImage(element, 0, 0);
      return Array.from(context.getImageData(140, 70, 1, 1).data);
    });
    assert.ok(Math.abs(pixel[0] - 39) < 20 && Math.abs(pixel[1] - 99) < 20 && Math.abs(pixel[2] - 181) < 20 && pixel[3] === 255, `Decoded VP8 frame must contain the recorded blue background: ${pixel}`);
  }
  await media.evaluate(async (element) => { await element.play(); });
  await page.waitForFunction((mediaKind) => {
    const element = document.querySelector(`#file-panel ${mediaKind}`);
    return element && !element.paused && element.currentTime > 0.9 && !element.error;
  }, kind);
  await media.evaluate((element) => element.pause());
  assert.equal(await media.evaluate((element) => element.paused), true);
  return { ...metadata, currentTime };
}

/**
 * 读取真实 PDF 插件状态或其解码后的可访问文字，插件不可观测即失败。
 * @param {import('playwright').Page} page 包含 PDF iframe 的页面。
 * @param {number} expectedPage 期望的当前页码。
 * @returns {Promise<object>} 内置 viewer 的实际状态。
 */
async function checkNativePdfViewer(page, expectedPage) {
  const deadline = Date.now() + 25_000;
  let last = [];
  const cdp = await page.context().newCDPSession(page);
  const sessions = [cdp];
  const attachedFrames = new Set([page.mainFrame()]);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("Accessibility.enable");
    while (Date.now() < deadline) {
      last = [];
      for (const frame of page.frames()) {
        if (!attachedFrames.has(frame)) {
          attachedFrames.add(frame);
          const frameSession = await page.context().newCDPSession(frame).catch(() => null);
          if (frameSession) {
            await frameSession.send("DOM.enable").catch(() => {});
            await frameSession.send("Accessibility.enable").catch(() => {});
            sessions.push(frameSession);
          }
        }
        const state = await frame.evaluate(() => {
          const roots = [document];
          for (let index = 0; index < roots.length; index += 1) {
            for (const element of roots[index].querySelectorAll("*")) {
              if (element.localName === "pdf-viewer") {
                const toolbar = element.shadowRoot?.querySelector("viewer-toolbar, viewer-pdf-toolbar-new, viewer-pdf-toolbar");
                return {
                  method: "native-pdf-viewer-properties", url: location.href,
                  pages: element.docLength_ ?? toolbar?.docLength,
                  page: element.pageNo_ ?? toolbar?.pageNo,
                  progress: element.loadProgress_ ?? toolbar?.loadProgress,
                };
              }
              if (element.shadowRoot) roots.push(element.shadowRoot);
            }
          }
          return { url: location.href, viewer: false };
        }).catch((error) => ({ url: frame.url(), error: error.message }));
        last.push(state);
        if (state.pages === 2 && state.page === expectedPage && state.progress === 100) return state;
      }
      for (const session of sessions) {
        // DevTools 只读 DOM 可以穿过插件的 closed shadow root，页面 JS 则不能。
        const documentTree = await session.send("DOM.getDocument", { depth: -1, pierce: true }).catch(() => null);
        const nodes = documentTree ? [documentTree.root] : [];
        for (let index = 0; index < nodes.length; index += 1) {
          const node = nodes[index];
          nodes.push(...(node.children ?? []), ...(node.shadowRoots ?? []));
          if (node.contentDocument) nodes.push(node.contentDocument);
          if (node.nodeName?.toLowerCase() !== "pdf-viewer") continue;
          const resolved = await session.send("DOM.resolveNode", { nodeId: node.nodeId }).catch(() => null);
          if (!resolved?.object?.objectId) continue;
          const objectId = resolved.object.objectId;
          try {
            const response = await session.send("Runtime.callFunctionOn", {
              objectId, returnByValue: true,
              functionDeclaration: "function() { return { method: 'native-pdf-cdp-properties', pages: this.docLength_, page: this.pageNo_, progress: this.loadProgress_ }; }",
            }).catch(() => null);
            const state = response?.result?.value;
            last.push(state);
            if (state?.pages === 2 && state.page === expectedPage && state.progress === 100) return state;
          } finally {
            await session.send("Runtime.releaseObject", { objectId }).catch(() => {});
          }
        }
        const accessibility = await session.send("Accessibility.getFullAXTree").catch(() => ({ nodes: [] }));
        const expectedText = `Chrome103 page ${expectedPage}`;
        const labels = accessibility.nodes.map((node) => String(node.name?.value ?? "").trim());
        if (labels.includes(expectedText)) {
          // 该文字只存在于 PDF 内容流；不把 iframe URL 或 embed 壳当解码成功。
          return { method: "native-pdf-accessibility-text", decodedText: expectedText,
            pages: labels.includes("Chrome103 page 1") && labels.includes("Chrome103 page 2") ? 2 : null,
            activePage: "not observable through AX; iframe fragment checked separately" };
        }
        last.push({ method: "native-pdf-accessibility-text", decodedTextFound: false, nodeCount: accessibility.nodes.length });
      }
      await delay(200);
    }
    assert.fail(`Native Chromium PDF viewer must expose loaded page ${expectedPage} state or its decoded PDF text; observed ${JSON.stringify(last)}`);
  } finally {
    for (const session of sessions.reverse()) await session.detach().catch(() => {});
  }
}

/**
 * 验证聊天内容与文件浏览器的真实交互；外部模型及 Git diff 用显式模拟隔离。
 * @param {import('playwright').Page} page Chromium103 应用页面。
 * @param {{base:string,project:string,artifacts:string,sessionId:string,record:Function,fixtures:object}} options 服务地址、隔离项目、截图目录、返回会话、覆盖记录器和夹具。
 */
export async function checkFullSiteContent(page, { base, project, artifacts, sessionId, record, fixtures }) {
  const browserMajor = page.context().browser().version().split(".")[0];
  const originalViewport = page.viewportSize();
  const routes = [];
  const initialPages = new Set(page.context().pages());
  const preferences = await page.evaluate(() => Object.fromEntries(["pi-tool-preset", "pi-sidebar-width", "pi-right-panel-width"].map((key) => [key, localStorage.getItem(key)])));
  try {
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto(`${base}/?session=${fixtures.sessionId}`, { waitUntil: "domcontentloaded" });
    const answer = page.locator('[data-entry-id="content-answer"]').last();
    await answer.getByText("Compatibility strong text", { exact: true }).waitFor();
    assert.equal(await answer.locator("strong").innerText(), "Compatibility strong text");
    assert.equal(await answer.getByRole("cell", { name: "Chrome103 ready", exact: true }).count(), 1);
    assert.ok(await answer.locator(".katex").count() >= 2, "Inline and display math must both render");
    const code = answer.locator(".markdown-code-block").filter({ has: page.locator(".markdown-code-lang", { hasText: /^js$/ }) });
    await code.locator("pre").waitFor();
    assert.match(await code.locator("pre").innerText(), /const chromeCompatibility = 103/);
    await code.getByRole("button", { name: "Copy", exact: true }).click();
    await code.getByRole("button", { name: "Copied", exact: true }).waitFor();
    const math = answer.locator(".markdown-math-display");
    await math.hover();
    await math.getByRole("button", { name: "Copy", exact: true }).click();
    await math.getByRole("button", { name: "Copied", exact: true }).waitFor();
    record("content.markdown", "real-session: strong/table/inline+display KaTeX rendered; JavaScript and display-math copy report success; clipboard bytes not inspected");

    const process = page.getByRole("button", { name: /^Process details/ });
    if (await process.getAttribute("aria-expanded") !== "true") await process.click();
    const thinking = page.getByRole("button", { name: /^Thinking/ });
    if (await thinking.getAttribute("aria-expanded") !== "true") await thinking.click();
    await page.getByText("Reasoning details remain readable in the old browser.", { exact: false }).waitFor();
    await page.getByRole("button", { name: /bash.*echo Chrome103 tool output/ }).click();
    await page.getByText("Chrome103 tool output", { exact: true }).waitFor();
    await thinking.click();
    await process.click();
    assert.equal(await thinking.count(), 0);
    record("content.process", "real-session: opened process details, expanded deferred thinking and bash result, verified their text, collapsed both");

    const svg = answer.locator(".markdown-code-block").filter({ has: page.locator(".markdown-code-lang", { hasText: /^svg$/ }) });
    await assertDecodedImage(svg.locator("img"));
    await svg.getByTitle("Show SVG source", { exact: true }).click();
    assert.match(await svg.locator("pre").innerText(), /Chrome103 SVG/);
    await svg.getByTitle("Preview SVG image", { exact: true }).click();
    await assertDecodedImage(svg.locator("img"));
    await svg.getByRole("button", { name: "Open image viewer", exact: true }).click();
    await assertDecodedImage(page.getByRole("dialog", { name: "SVG image viewer", exact: true }).locator("img"));
    await checkDiagramDialog(page, "SVG image viewer");
    record("content.svg", "real-session: decoded SVG image; source/preview round trip; native dialog zoom in/out/reset/Escape");

    const mermaid = answer.locator(".markdown-code-block").filter({ has: page.locator(".markdown-code-lang", { hasText: /^mermaid$/ }) });
    // MarkdownBody 显式启用 defaultPreview，先通过实际控件切到源码才有 pre。
    await mermaid.getByTitle("Show Mermaid source", { exact: true }).click();
    assert.match(await mermaid.locator("pre").innerText(), /https:\/\/example.invalid\/chrome103/);
    await mermaid.getByTitle("Preview Mermaid diagram", { exact: true }).click();
    const graph = mermaid.locator(".mermaid-preview-button svg");
    await graph.waitFor();
    assert.match(await graph.textContent(), /Chrome103 Start/);
    assert.match(await graph.textContent(), /Compatibility Ready/);
    assert.equal(await graph.evaluate((element) => element.getBoundingClientRect().width > 0), true);
    await mermaid.getByRole("button", { name: "Open diagram viewer", exact: true }).click();
    await checkDiagramDialog(page, "Mermaid diagram viewer");
    await mermaid.getByTitle("Show Mermaid source", { exact: true }).click();
    await mermaid.locator("pre").waitFor();
    record("content.mermaid", "real-session: source with HTTPS click href renders graph nodes; viewer zoom/reset/Escape; source restored; no external link navigation");

    const imageTrigger = answer.getByRole("button", { name: "Preview image: Content image", exact: true });
    await assertDecodedImage(imageTrigger.locator("img"));
    await imageTrigger.click();
    const imageDialog = page.getByRole("dialog", { name: "Preview image", exact: true });
    await assertDecodedImage(imageDialog.locator("img"));
    assert.equal(await imageDialog.evaluate((element) => element.open), true);
    await page.keyboard.press("Escape");
    await imageDialog.waitFor({ state: "detached" });
    assert.equal(await imageTrigger.getAttribute("aria-expanded"), "false");
    record("content.image-dialog", "real-session: decoded Markdown PNG, opened native preview dialog, Escape closes it and resets expanded state");
    await page.screenshot({ path: join(artifacts, `${browserMajor}-fullsite-content-markdown.png`) });

    let panel = await openContentFile(page, "csv");
    const csvTable = panel.getByRole("table");
    await csvTable.waitFor();
    assert.equal(await csvTable.getAttribute("aria-rowcount"), "202");
    await csvTable.getByRole("cell", { name: "line one line two", exact: true }).waitFor();
    // 真正滚动虚拟列表，确认尾行挂载，不能只断言总行数元数据。
    await csvTable.evaluate((element) => {
      const scroll = element.parentElement;
      scroll.scrollTop = scroll.scrollHeight;
    });
    await csvTable.getByRole("cell", { name: "Row 199", exact: true }).waitFor();
    await panel.getByRole("button", { name: "Source", exact: true }).click();
    await panel.locator(".file-source-line").first().waitFor();
    assert.match(await panel.innerText(), /Name,Note,Count/);
    await panel.getByRole("button", { name: "Preview", exact: true }).click();
    await csvTable.waitFor();
    record("files.csv", "real-file-api: parsed quoted multiline cell, 202 rows, scrolled virtual table to Row 199, source/preview round trip");

    panel = await openContentFile(page, "tsv");
    await panel.getByRole("table").waitFor();
    assert.equal(await panel.getByRole("columnheader", { name: "Status", exact: true }).count(), 1);
    await panel.getByRole("cell", { name: "Pending", exact: true }).waitFor();
    assert.equal(await panel.getByRole("cell", { name: "Pending", exact: true }).count(), 1);
    record("files.tsv", "real-file-api: TSV preview has Status header and Pending data cell");

    panel = await openContentFile(page, "markdown");
    await panel.getByRole("button", { name: "Preview", exact: true }).click();
    await panel.getByRole("heading", { name: "Compatibility file preview", exact: true }).waitFor();
    assert.equal(await panel.locator("strong").innerText(), "Markdown file works");
    assert.equal(await panel.getByRole("cell", { name: "Ready", exact: true }).count(), 1);
    record("files.markdown", "real-file-api: file Preview renders heading, strong text and table cell");

    // 成熟 helper 从文件树首次打开 HTML；预先打开会让其全局 title 匹配到标签栏和正文。
    await checkFilePanel(page, fixtures.files.html);
    panel = await openContentFile(page, "html");
    const previewButton = panel.getByRole("button", { name: "Preview", exact: true });
    if (await previewButton.getAttribute("aria-pressed") !== "true") await previewButton.click();
    const frame = panel.frameLocator("iframe");
    await frame.locator("#notes").fill("Chrome103 preview note");
    await frame.locator("#filter").selectOption({ label: "Pending" });
    assert.equal(await frame.locator("#notes").inputValue(), "Chrome103 preview note");
    assert.equal(await frame.locator("#filter").inputValue(), "Pending");
    await panel.getByRole("button", { name: "Source", exact: true }).click();
    await panel.locator(".file-source-line").first().waitFor();
    assert.match(await panel.innerText(), /HTML preview state must survive layout changes/);
    await panel.getByRole("button", { name: "Preview", exact: true }).click();
    await frame.locator("#notes").waitFor();
    record("files.html-panel", "real-file-api: edited iframe input/select; reused width/state regression covering two full-width round trips and hide/reopen; source/preview toggle");

    panel = await openContentFile(page, "image");
    await assertDecodedImage(panel.locator("img"));
    assert.equal(await panel.locator("img").evaluate((element) => element.naturalWidth), 16);
    record("files.image", "real-file-api: PNG file viewer decodes fixture with expected natural width");

    panel = await openContentFile(page, "docx");
    const docxFrame = panel.frameLocator("iframe");
    await docxFrame.getByText("Chrome103 DOCX preview", { exact: true }).waitFor();
    assert.equal(await docxFrame.locator("strong").innerText(), "Converted bold content");
    assert.equal(await docxFrame.getByRole("cell", { name: "Document table cell", exact: true }).count(), 1);
    assert.equal(await panel.locator("iframe").getAttribute("sandbox"), "allow-same-origin");
    assert.ok(new URL(await panel.locator("iframe").getAttribute("src"), base).searchParams.get("type") === "preview");
    record("files.docx", "real-file-api: generated OpenXML ZIP converted by actual mammoth preview endpoint; sandbox iframe contains document paragraph, bold formatting and table cell");

    await openContentFile(page, "audio");
    const audioState = await checkMediaPlayback(page, "audio");
    record("files.audio", `real-file-api: generated 8kHz 16bit PCM WAV; decoded two-second metadata; playback clock advanced, paused, seeked to ${audioState.currentTime}, resumed and paused; muted to keep CI quiet; compressed audio codecs not covered`);

    // 待测浏览器编码的视频写回隔离文件，后续 metadata、Range 和播放都走真实 API。
    await page.bringToFront();
    const videoBytes = await recordVideoFixture(page);
    writeFileSync(fixtures.files.video, videoBytes);
    await openContentFile(page, "video");
    const videoState = await checkMediaPlayback(page, "video");
    record("files.video", `real-file-api: browser-recorded VP8/WebM (${videoBytes.length} actual bytes); decoded ${videoState.width}x${videoState.height} frame pixels; play/pause/seek/resume verified; metadata duration=${videoState.duration}; H264/MP4 and other codecs not covered`);

    panel = await openContentFile(page, "binary");
    await panel.getByText("Binary file: no preview. Download it to open it.", { exact: true }).waitFor();
    assert.equal(await panel.locator(".file-source-line").count(), 0);
    const downloadEvent = page.waitForEvent("download");
    // files.download 的真实英文是 Download file；此处选正文下载入口以区别工具栏同名链接。
    await panel.locator("a.file-viewer-mode-button[download]").click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), basename(fixtures.files.binary));
    const downloadPath = join(artifacts, `${browserMajor}-fullsite-binary-download.bin`);
    await download.saveAs(downloadPath);
    assert.deepEqual(readFileSync(downloadPath), readFileSync(fixtures.files.binary));
    record("files.binary", "real-file-api: NUL-containing unknown .bin has binary notice and no source rows; explicit Download produces expected filename and byte-identical file");

    const diffRoute = /\/api\/git\/diff(?:\?|$)/;
    const diffHandler = async (route) => {
      const requested = new URL(route.request().url()).searchParams.get("path");
      // Markdown 链接用正斜杠，Windows 夹具来自 path.join；按本机路径语义比较。
      const requestedPath = requested?.replace(/\\/g, "/");
      const sourcePath = fixtures.files.source.replace(/\\/g, "/");
      const samePath = process.platform === "win32"
        ? requestedPath?.toLowerCase() === sourcePath.toLowerCase()
        : requestedPath === sourcePath;
      if (!samePath) return route.fallback();
      return route.fulfill({ json: { supported: true, status: "modified", filePath: fixtures.files.source,
        patch: "diff --git a/compat-content.ts b/compat-content.ts\n--- a/compat-content.ts\n+++ b/compat-content.ts\n@@ -1,2 +1,2 @@\n // Chrome103 source fixture\n-export const compatibilityValue = 102;\n+export const compatibilityValue = 103;\n" } });
    };
    await page.route(diffRoute, diffHandler);
    routes.push([diffRoute, diffHandler]);
    panel = await openContentFile(page, "source");
    await panel.locator(".file-source-line").first().waitFor();
    assert.match(await panel.innerText(), /compatibilityValue = 103/);
    await panel.getByRole("button", { name: "Diff", exact: true }).click();
    await panel.locator(".file-diff-line-content").filter({ hasText: "compatibilityValue = 102" }).waitFor();
    await panel.locator(".file-diff-line-content").filter({ hasText: "compatibilityValue = 103" }).waitFor();
    await panel.getByRole("button", { name: "Source", exact: true }).click();
    await panel.locator(".file-source-line").first().waitFor();
    record("files.diff", "mocked-service: isolated /api/git/diff patch; real source file; switched Source/Diff/Source and verified removed 102 and added 103 lines");

    panel = await openContentFile(page, "pdf page 2");
    const pdfFrame = panel.locator("iframe");
    await pdfFrame.waitFor();
    assert.match(await pdfFrame.getAttribute("src"), /#page=2$/);
    const pdfUrl = new URL(await pdfFrame.getAttribute("src"), base);
    const pdfResponse = await page.request.get(pdfUrl.href.split("#")[0]);
    assert.equal(pdfResponse.status(), 200);
    assert.match(pdfResponse.headers()["content-type"], /application\/pdf/);
    const pdfBytes = await pdfResponse.body();
    assert.equal(pdfBytes.length, fixtures.pdfBytes);
    assert.equal(pdfBytes.subarray(0, 8).toString(), "%PDF-1.4");
    await openContentFile(page, "pdf");
    await page.waitForFunction(() => {
      const frame = document.querySelector("#file-panel iframe");
      return frame && !frame.getAttribute("src").includes("#page=");
    });
    assert.equal((await pdfFrame.getAttribute("src")).includes("#page="), false);
    await openContentFile(page, "pdf page 2");
    await page.waitForFunction(() => document.querySelector("#file-panel iframe")?.getAttribute("src").endsWith("#page=2"));
    assert.match(await pdfFrame.getAttribute("src"), /#page=2$/);
    record("files.pdf-integration", "real-file-api: application/pdf bytes/header/length validated; iframe page=2 → no fragment → page=2; native plugin verification recorded separately when CHROME_103_NATIVE_PDF=1");
    if (process.env.CHROME_103_NATIVE_PDF === "1") {
      const nativePdf = await checkNativePdfViewer(page, 2);
      record("files.pdf-native", `real-browser-plugin: ${JSON.stringify(nativePdf)}; native PDF raster pixels are not compared`);
      await pdfFrame.screenshot({ path: join(artifacts, `${browserMajor}-fullsite-native-pdf-page-2.png`) });
    }
    await page.screenshot({ path: join(artifacts, `${browserMajor}-fullsite-content-files.png`) });
    await panel.getByRole("button", { name: "Hide file panel", exact: true }).click();

    // 分支读取走真实 context API；仅截获会启动 AgentSession 的同步命令。
    const branchRoute = `**/api/agent/${fixtures.sessionId}`;
    const branchHandler = (route) => {
      if (route.request().method() !== "POST" || route.request().postDataJSON()?.type !== "navigate_tree") return route.fallback();
      return route.fulfill({ json: { success: true, data: {} } });
    };
    await page.route(branchRoute, branchHandler);
    routes.push([branchRoute, branchHandler]);
    await page.getByRole("button", { name: "Branches", exact: true }).click();
    const branchCommand = page.waitForRequest((request) => new URL(request.url()).pathname === `/api/agent/${fixtures.sessionId}` && request.method() === "POST");
    await page.getByText("Chrome103 alternate branch", { exact: true }).click();
    await page.locator('[data-entry-id="content-alternate"]').getByText("Chrome103 alternate branch", { exact: true }).waitFor();
    assert.equal((await branchCommand).postDataJSON().type, "navigate_tree");
    assert.equal(await page.locator('[data-entry-id="content-answer"]').count(), 0);
    record("chat.branches", "real-session-context + mocked-service navigate_tree acknowledgement: selected alternate answer, original rich answer leaves transcript; no AgentSession started");
    await page.goto(`${base}/?session=${fixtures.sessionId}`, { waitUntil: "domcontentloaded" });
    const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
    if (await showSidebar.isVisible()) await showSidebar.click();
    await showSidebarSessions(page);
    await page.getByRole("button", { name: "Search conversations", exact: true }).click();
    const search = page.locator("#session-search-input");
    await search.fill(CONTENT_TITLE);
    const searchHit = page.locator("#session-sidebar-panel-sessions button").filter({ has: page.locator("mark", { hasText: CONTENT_TITLE }) });
    await searchHit.waitFor();
    await searchHit.click();
    assert.equal(new URL(page.url()).searchParams.get("session"), fixtures.sessionId);
    await search.fill("");
    await search.press("Escape");
    const row = page.locator(".session-tree-session").filter({ has: page.locator(".session-tree-title", { hasText: CONTENT_TITLE }) });
    await row.getByRole("button", { name: "More actions", exact: true }).click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    assert.ok(await menu.getByRole("menuitem").count() >= 3);
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    record("chat.search-menu", "real-session-api: searched unique content fixture, clicked result, opened session row action menu and dismissed with Escape; destructive actions not invoked");

    const modelRoute = /\/api\/models(?:\?|$)/;
    const models = Array.from({ length: 10 }, (_, index) => ({ provider: "compat", id: index === 0 ? "model-one" : index === 1 ? "model-two" : `model-${index}`,
      name: index === 0 ? "Compatibility One" : index === 1 ? "Compatibility Two" : `Compatibility Extra ${index}`, reasoning: true }));
    const modelHandler = (route) => route.fulfill({ json: {
      models: Object.fromEntries(models.map((model) => [`${model.provider}:${model.id}`, model.name])),
      modelList: models,
      defaultModel: { provider: "compat", modelId: "model-one" }, defaultThinkingLevel: "medium", savedDefaultThinkingLevel: null,
      thinkingLevels: { "compat:model-one": ["off", "low", "medium", "high"], "compat:model-two": ["off", "low", "medium", "high"] }, thinkingLevelMaps: {}, thinkingLevelPins: {},
    } });
    await page.route(modelRoute, modelHandler);
    routes.push([modelRoute, modelHandler]);
    await page.goto(`${base}/?cwd=${encodeURIComponent(project)}`, { waitUntil: "domcontentloaded" });
    const modelTrigger = page.locator(".model-selector.is-toolbar > button");
    await modelTrigger.filter({ hasText: "Compatibility One" }).waitFor();
    // 新建按钮应回到可编辑的新会话，选择器只改本地草稿而不调用模型。
    await page.locator(".sidebar-new-button").click();
    await page.locator(".chat-input-textarea").fill("Chrome103 unsent draft");
    assert.equal(new URL(page.url()).searchParams.has("session"), false);
    await modelTrigger.click();
    await page.getByRole("textbox", { name: "Filter models…", exact: true }).fill("Two");
    await page.getByRole("option").filter({ hasText: "Compatibility Two" }).click();
    await modelTrigger.filter({ hasText: "Compatibility Two" }).waitFor();
    const reasoning = page.getByRole("button", { name: "Change reasoning level", exact: true });
    await reasoning.click();
    await page.getByRole("option").filter({ has: page.getByText("high", { exact: true }) }).click();
    assert.match(await reasoning.innerText(), /high/);
    const tools = page.getByRole("button", { name: "Change tool preset", exact: true });
    await tools.click();
    await page.getByRole("button", { name: /^chat-only\s/ }).click();
    assert.match(await tools.getAttribute("title"), /Chat only/);
    await tools.click();
    await page.getByRole("button", { name: /^read-only\s/ }).click();
    assert.match(await tools.getAttribute("title"), /read-only/);
    assert.equal(await page.locator(".chat-input-textarea").inputValue(), "Chrome103 unsent draft");
    await page.locator(".chat-input-textarea").fill("");
    record("chat.composer-selectors", "mocked-service: ten-model /api/models catalog; New composer; filter/select model Two, reasoning high, chat-only/read-only presets; unsent draft retained; no model request or credential use");
  } finally {
    for (const [pattern, handler] of routes.reverse()) await page.unroute(pattern, handler).catch(() => {});
    for (const extraPage of page.context().pages()) if (!initialPages.has(extraPage)) await extraPage.close().catch(() => {});
    // 关闭内容测试创建的文件标签，不把监听器和预览窗口留给后续模块。
    await page.keyboard.press("Escape").catch(() => {});
    const showPanel = page.getByRole("button", { name: "Show file panel", exact: true });
    if (await showPanel.isVisible()) await showPanel.click().catch(() => {});
    for (const filePath of Object.values(fixtures.files)) {
      const close = page.locator("#file-panel").getByRole("button", { name: `Close ${basename(filePath)}`, exact: true });
      if (await close.count()) await close.click({ force: true }).catch(() => {});
    }
    await page.evaluate((saved) => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    }, preferences).catch(() => {});
    if (originalViewport) await page.setViewportSize(originalViewport);
    await page.goto(`${base}/?session=${sessionId}`, { waitUntil: "domcontentloaded" });
  }
}
