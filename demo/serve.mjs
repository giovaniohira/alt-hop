// Serves the real frontend (src/) with the fake backend injected.
// node demo/serve.mjs  ->  http://localhost:5174/#add
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL("../src/", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const mock = new URL("./mock.js", import.meta.url);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  try {
    if (path === "/__mock.js") {
      res.writeHead(200, { "content-type": types[".js"] });
      return res.end(await readFile(mock));
    }
    const file = path === "/" ? "index.html" : normalize(path).replace(/^([\\/]|\.\.)+/, "");
    let body = await readFile(join(root, file));
    if (file === "index.html") body = String(body).replace("<script", '<script src="/__mock.js"></script><script');
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(5174, () => console.log("demo on http://localhost:5174"));
