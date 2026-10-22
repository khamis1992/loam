export interface UploadConfig {
  /** Public base URL used to build PUT/GET blob URLs. May be a getter so the port can be resolved after bind. */
  baseUrl: string | (() => string);
  /** Directory where uploaded bytes are stored. Defaults to a temp directory. */
  storageDir?: string;
}

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

/** Attachment as sent in user_message (§7.2). */
export interface Attachment {
  id: string;
  filename: string;
  type: 'file';
  url: string;
  contentType: string;
  fileMetaData?: {
    tag: 'upload';
    uploadStatus: 'success' | 'uploading' | 'error';
    uploadProgress: number;
  };
}

/** Server-side file record. */
export interface StoredFile {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  path: string;
}

export interface DeviceAttachmentUploadNotify {
  type: 'deviceAttachmentUploadNotify';
  id: string;
  timestamp: number;
  targetEventId: string;
  path: string;
  status: 'done' | 'failed';
  url: string;
  contentType: string;
  contentLength: number;
}
