import { EventEmitter } from 'node:events';
import type { DeviceAttachmentUploadNotify } from './types.js';

const emitter = new EventEmitter();

export function onDeviceAttachmentUpload(
  cb: (ev: DeviceAttachmentUploadNotify) => void,
): () => void {
  emitter.on('deviceAttachmentUploadNotify', cb as (...args: unknown[]) => void);
  return () => emitter.off('deviceAttachmentUploadNotify', cb as (...args: unknown[]) => void);
}

export function emitDeviceAttachmentUpload(ev: DeviceAttachmentUploadNotify): void {
  emitter.emit('deviceAttachmentUploadNotify', ev);
}
