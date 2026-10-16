/**
 * WebCrypto 辅助（移植/reference：zotero-pdf-translate 的 utils/crypto.ts）。
 * 仅依赖 Zotero 沙箱里可用的 crypto（在 src/index.ts 里通过 defineGlobal("crypto") 注入）。
 */

function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let str = "";
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return ztoolkit.getGlobal("btoa")(str);
}

function hex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/** 生成 32 个小写十六进制字符的随机串（等价于 .NET Guid.NewGuid().ToString("N")）。 */
function randomHex32(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16)) as Uint8Array;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

async function hmacSha256Digest(
  stringToSign: string,
  secretKey: string | ArrayBuffer | Uint8Array,
): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const keyData: BufferSource =
    typeof secretKey === "string" ? enc.encode(secretKey) : (secretKey as BufferSource);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, enc.encode(stringToSign) as BufferSource);
}

async function sha256Digest(message: string): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  return crypto.subtle.digest("SHA-256", enc.encode(message) as BufferSource);
}

function pkcs7Pad(block: Uint8Array | Array<number>): Uint8Array {
  const padding = 16 - block.length;
  const pad = new Uint8Array(padding);
  pad.fill(padding);
  return new Uint8Array([...block, ...pad]);
}

// AES ECB 加密：WebCrypto 不支持 ECB，这里逐块用 CBC（IV=块明文）模拟，等价于 ECB。
async function aesEcbEncrypt(message: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret) as BufferSource,
    {
      name: "AES-CBC",
    },
    false,
    ["encrypt"],
  );

  const encodeStr = new TextEncoder().encode(message);
  const blocks: Uint8Array[] = [];
  for (let i = 0; i < encodeStr.length; i += 16) {
    blocks.push(encodeStr.subarray(i, i + 16));
  }

  if (!blocks.length || blocks[blocks.length - 1].length === 16) {
    blocks.push(pkcs7Pad([]));
  } else {
    blocks[blocks.length - 1] = pkcs7Pad(blocks[blocks.length - 1]);
  }

  const zeros = new Uint8Array(16);
  const encryptedBlocks = await Promise.all(
    blocks.map((block) =>
      crypto.subtle.encrypt(
        {
          name: "AES-CBC",
          iv: block as BufferSource,
        },
        key,
        zeros as BufferSource,
      ),
    ),
  );
  const encrypted = new Uint8Array(encryptedBlocks.length * 16);
  let offset = 0;
  for (const block of encryptedBlocks) {
    encrypted.set(new Uint8Array(block).subarray(0, 16), offset);
    offset += 16;
  }
  return encrypted;
}

export { aesEcbEncrypt, base64, hex, hmacSha256Digest, randomHex32, sha256Digest };
