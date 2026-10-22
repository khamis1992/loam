/** Shared in-memory blob store for the §8.1 upload contract.
 *  PUT /blob/:id writes here; the socket layer reads blobs when attaching
 *  files to a Loam task workspace.
 */

const blobs = new Map<string, Buffer>();

export function storeBlob(id: string, data: Buffer): void {
  blobs.set(id, data);
}

export function getBlob(id: string): Buffer | undefined {
  return blobs.get(id);
}

export function hasBlob(id: string): boolean {
  return blobs.has(id);
}

export function deleteBlob(id: string): boolean {
  return blobs.delete(id);
}
