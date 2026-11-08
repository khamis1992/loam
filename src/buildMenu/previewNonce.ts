export function attachPreviewNonce<T extends { previewUrl?: string }>(result: T, nonce: string): T & { previewNonce?: string } {
  if (!result.previewUrl) return result;
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new Error('invalid_request');
  return { ...result, previewNonce: nonce };
}
