export async function signBridgeRequest(
  privateKeyBase64: string,
  operation: string,
  signedAt: string,
  payload: Record<string, unknown>
): Promise<string> {
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    fromBase64(privateKeyBase64),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const message = `${operation}\n${signedAt}\n${stableStringify(payload)}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(message)
  );
  return toBase64(new Uint8Array(signature));
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

export function fromBase64(value: string): ArrayBuffer {
  const decoded = atob(value);
  const out = new ArrayBuffer(decoded.length);
  const bytes = new Uint8Array(out);
  for (let i = 0; i < decoded.length; i += 1) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortJsonValue(obj[key]);
    }
    return sorted;
  }
  return value;
}
