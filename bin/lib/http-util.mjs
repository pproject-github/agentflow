/**
 * 两个最基础的 HTTP 工具。
 *
 * 独立成模块只有一个原因：路由拆分出去之后，`json(res, ...)` / `readBody(req)` 在两个文件
 * 里都要以**同名标识符**出现——搬走的路由体一行都不改，靠的就是这个。
 */

/**
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {unknown} obj
 */
export function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function readBody(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let exceeded = false;
    req.on("data", (chunk) => {
      if (exceeded) return;
      const value = Buffer.from(chunk);
      total += value.length;
      if (total > maxBytes) {
        exceeded = true;
        chunks.length = 0;
        return;
      }
      chunks.push(value);
    });
    req.on("end", () => {
      if (exceeded) {
        const error = new Error(`Request body exceeds ${maxBytes} bytes`);
        error.status = 413;
        reject(error);
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}
