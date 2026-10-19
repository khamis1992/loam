/** Client-side upload service implementing the §8.1 3-step contract. */

export interface PresignRequest {
  filename: string;
  fileType: string;
  fileSize: number;
}

export interface PresignResponse {
  data: { uploadUrl: string; id: string };
}

export interface CompleteRequest {
  filename: string;
  fileSize: number;
  id: string;
}

export interface CompleteResponse {
  data: { fileUrl: string };
}

export interface Attachment {
  id: string;
  filename: string;
  type: 'file';
  url: string;
  contentType: string;
  fileMetaData: {
    tag: 'upload';
    uploadStatus: 'success';
    uploadProgress: 100;
  };
}

export async function getPresignedUploadUrl(
  apiBase: string,
  request: PresignRequest,
): Promise<PresignResponse> {
  const res = await fetch(`${apiBase}/api/chat/getPresignedUploadUrl`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    throw new Error(`getPresignedUploadUrl failed: ${res.status}`);
  }
  return (await res.json()) as PresignResponse;
}

export async function putFile(uploadUrl: string, file: Blob, contentType: string): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: file,
  });
  if (!res.ok) {
    throw new Error(`PUT upload failed: ${res.status}`);
  }
}

export async function uploadComplete(
  apiBase: string,
  request: CompleteRequest,
): Promise<CompleteResponse> {
  const res = await fetch(`${apiBase}/api/chat/uploadComplete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    throw new Error(`uploadComplete failed: ${res.status}`);
  }
  return (await res.json()) as CompleteResponse;
}

export async function uploadFile(apiBase: string, file: File): Promise<Attachment> {
  const presign = await getPresignedUploadUrl(apiBase, {
    filename: file.name,
    fileType: file.type || 'application/octet-stream',
    fileSize: file.size,
  });

  await putFile(presign.data.uploadUrl, file, file.type || 'application/octet-stream');

  const complete = await uploadComplete(apiBase, {
    filename: file.name,
    fileSize: file.size,
    id: presign.data.id,
  });

  return {
    id: `temp-${presign.data.id}`,
    filename: file.name,
    type: 'file',
    url: complete.data.fileUrl,
    contentType: file.type || 'application/octet-stream',
    fileMetaData: { tag: 'upload', uploadStatus: 'success', uploadProgress: 100 },
  };
}
