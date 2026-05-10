import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const PYTHON = "/home/ubuntu/rag-platform/.venv/bin/python";
const EXTRACTOR = "/home/ubuntu/rag-platform/scripts/extract_doc.py";

export async function extractDocument(
  bytes: Buffer,
  mimetype: string,
  originalFilename?: string,
): Promise<{ text: string; mime: string; bytesIn: number }> {
  // Pick extension from mime or filename
  let ext = ".bin";
  if (mimetype.includes("pdf")) ext = ".pdf";
  else if (mimetype.includes("wordprocessingml")) ext = ".docx";
  else if (mimetype.includes("spreadsheetml")) ext = ".xlsx";
  else if (originalFilename) {
    const m = originalFilename.match(/\.(pdf|docx|xlsx|xlsm)$/i);
    if (m) ext = "." + m[1].toLowerCase();
  }
  if (ext === ".bin") throw new Error(`unsupported document mimetype: ${mimetype}`);

  const tmp = path.join(os.tmpdir(), `wa-doc-${Date.now()}${ext}`);
  await fs.writeFile(tmp, bytes);
  try {
    const text = await new Promise<string>((resolve, reject) => {
      const child = spawn(PYTHON, [EXTRACTOR, tmp]);
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => { out += d.toString("utf-8"); });
      child.stderr.on("data", (d: Buffer) => { err += d.toString("utf-8"); });
      child.on("close", (code: number | null) => {
        if (code === 0) resolve(out);
        else reject(new Error(`extract_doc.py exit ${code}: ${err.slice(0, 300)}`));
      });
    });
    return { text, mime: mimetype, bytesIn: bytes.length };
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}
