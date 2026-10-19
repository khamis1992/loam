/** Decode the bounded PNG/JPEG format accepted by the picture tools. */
export function embeddedPicture(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > 1_400_000 || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) throw Error('Use an embedded PNG/JPEG image below 1 MB');
  const data = Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
  if (value.startsWith('data:image/png') ? !data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : data[0] !== 255 || data[1] !== 216 || data[2] !== 255) throw Error('Invalid image signature');
  return data;
}
