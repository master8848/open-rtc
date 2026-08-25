/**
 * Recording chunk encryption (AES-GCM, 12B nonce per chunk).
 * Nonce prepended to ciphertext; server stores opaque bytes + keyId (never the key).
 */
export async function encryptBlob(blob: Blob, key: CryptoKey): Promise<Blob> {
  const plain = new Uint8Array(await blob.arrayBuffer());
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, plain as unknown as BufferSource);
  const out = new Uint8Array(iv.length + (ct as ArrayBuffer).byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct as ArrayBuffer), iv.length);
  return new Blob([out], { type: blob.type });
}
export async function decryptBlob(blob: Blob, key: CryptoKey): Promise<Blob> {
  const data = new Uint8Array(await blob.arrayBuffer());
  if (data.length < 12) throw new Error('decryptBlob: chunk too short');
  const iv = data.slice(0, 12);
  const ct = data.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, ct as unknown as BufferSource);
  return new Blob([new Uint8Array(pt as ArrayBuffer)], { type: blob.type });
}
export async function importRawKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as unknown as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
