import struct, wave, math, sys
# Generate a short two-tone WAV (two "speakers" at different pitches saying nothing)
# This tests the pipeline end-to-end: WAV bytes -> server -> JSON with segments.
sr = 16000
out = wave.open(sys.argv[1], "w")
out.setnchannels(1); out.setsampwidth(2); out.setframerate(sr)
frames = []
for i in range(sr):  # 1s at 200Hz
    frames.append(int(12000 * math.sin(2 * math.pi * 200 * i / sr)))
for i in range(sr):  # 1s at 400Hz
    frames.append(int(12000 * math.sin(2 * math.pi * 400 * i / sr)))
out.writeframes(struct.pack("<" + "h" * len(frames), *frames))
out.close()
print("wav written:", sys.argv[1])
