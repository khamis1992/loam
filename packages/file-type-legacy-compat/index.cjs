exports.fromBuffer = async function fromBuffer(buffer) {
  const { fileTypeFromBuffer } = await import("file-type");
  return fileTypeFromBuffer(buffer);
};
