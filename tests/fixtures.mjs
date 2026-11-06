export function syntheticFlac() {
  const streamInfo = Buffer.alloc(34);
  const sampleRate = 96_000n;
  const channelsMinusOne = 1n;
  const bitsMinusOne = 23n;
  const totalSamples = 96_000n * 252n;
  const packed = (sampleRate << 44n) | (channelsMinusOne << 41n) | (bitsMinusOne << 36n) | totalSamples;
  streamInfo.writeBigUInt64BE(packed, 10);

  const comments = ['TITLE=Afterglow', 'ARTIST=Mina Vale', 'ALBUM=Blue Hours', 'DATE=2024', 'TRACKNUMBER=1', 'GENRE=Indie Pop'];
  const vendor = Buffer.from('soriseojae-test');
  const parts = [littleEndian(vendor.length), vendor, littleEndian(comments.length)];
  for (const comment of comments) {
    const bytes = Buffer.from(comment);
    parts.push(littleEndian(bytes.length), bytes);
  }
  const vorbis = Buffer.concat(parts);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const mime = Buffer.from('image/png');
  const picture = Buffer.alloc(4 + 4 + mime.length + 4 + 16 + 4 + png.length);
  let pictureOffset = 0;
  picture.writeUInt32BE(3, pictureOffset); pictureOffset += 4;
  picture.writeUInt32BE(mime.length, pictureOffset); pictureOffset += 4;
  mime.copy(picture, pictureOffset); pictureOffset += mime.length;
  picture.writeUInt32BE(0, pictureOffset); pictureOffset += 4;
  picture.writeUInt32BE(1, pictureOffset); pictureOffset += 4;
  picture.writeUInt32BE(1, pictureOffset); pictureOffset += 4;
  picture.writeUInt32BE(8, pictureOffset); pictureOffset += 4;
  picture.writeUInt32BE(0, pictureOffset); pictureOffset += 4;
  picture.writeUInt32BE(png.length, pictureOffset); pictureOffset += 4;
  png.copy(picture, pictureOffset);

  return Buffer.concat([
    Buffer.from('fLaC'), blockHeader(0, streamInfo.length, false), streamInfo,
    blockHeader(4, vorbis.length, false), vorbis,
    blockHeader(6, picture.length, true), picture, Buffer.from([0xff, 0xf8, 0, 0])
  ]);
}

// Real, decodable test audio: mono PCM in FLAC verbatim frames, no external encoder.
export function playableFlac({ title = '테스트 음악', album = '테스트 앨범', artist = '테스트 아티스트', seconds = 6, frequency = 440 } = {}) {
  const sampleRate = 44100, blockSize = 4410, samples = Math.round(seconds * sampleRate);
  const info = Buffer.alloc(34);
  info.writeUInt16BE(blockSize, 0); info.writeUInt16BE(blockSize, 2);
  info.writeBigUInt64BE((BigInt(sampleRate) << 44n) | (15n << 36n) | BigInt(samples), 10);
  const tags = [`TITLE=${title}`, `ALBUM=${album}`, `ARTIST=${artist}`, 'TRACKNUMBER=1'];
  const vendor = Buffer.from('soriseojae-playback-test');
  const comments = [littleEndian(vendor.length), vendor, littleEndian(tags.length)];
  for (const tag of tags) { const bytes = Buffer.from(tag); comments.push(littleEndian(bytes.length), bytes); }
  const vorbis = Buffer.concat(comments);
  const frames = [];
  for (let base = 0, frameIndex = 0; base < samples; base += blockSize, frameIndex++) {
    const size = Math.min(blockSize, samples - base);
    const block = Buffer.alloc(2); block.writeUInt16BE(size - 1);
    const header = Buffer.concat([Buffer.from([0xff, 0xf8, 0x79, 0x08]), Buffer.from(String.fromCodePoint(frameIndex)), block]);
    const pcm = Buffer.alloc(size * 2);
    for (let n = 0; n < size; n++) pcm.writeInt16BE(Math.round(4000 * Math.sin(2 * Math.PI * frequency * (base + n) / sampleRate)), n * 2);
    const frame = Buffer.concat([header, Buffer.from([crc(header, 8, 0x07), 0x02]), pcm]);
    const checksum = Buffer.alloc(2); checksum.writeUInt16BE(crc(frame, 16, 0x8005));
    frames.push(frame, checksum);
  }
  return Buffer.concat([Buffer.from('fLaC'), blockHeader(0, info.length, false), info, blockHeader(4, vorbis.length, true), vorbis, ...frames]);
}

function crc(bytes, bits, polynomial) {
  let value = 0;
  const mask = (1 << bits) - 1;
  for (const byte of bytes) {
    value ^= byte << (bits - 8);
    for (let bit = 0; bit < 8; bit++) value = ((value << 1) ^ ((value & (1 << (bits - 1))) ? polynomial : 0)) & mask;
  }
  return value;
}

// A single valid 20ms Opus silence packet in an Ogg container; no encoder needed.
export function playableOggOpus() {
  const header = Buffer.alloc(19);
  header.write('OpusHead'); header[8] = 1; header[9] = 1;
  header.writeUInt32LE(48000, 12);
  const tags = Buffer.concat([Buffer.from('OpusTags'), littleEndian(4), Buffer.from('Cove'), littleEndian(0)]);
  const page = (packet, seq, flags, granule) => {
    const result = Buffer.alloc(28 + packet.length);
    result.write('OggS'); result[5] = flags;
    result.writeBigUInt64LE(BigInt(granule), 6);
    result.writeUInt32LE(42, 14); result.writeUInt32LE(seq, 18);
    result[26] = 1; result[27] = packet.length; packet.copy(result, 28);
    let crc = 0;
    for (const byte of result) {
      crc ^= byte << 24;
      for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0)) >>> 0;
    }
    result.writeUInt32LE(crc, 22);
    return result;
  };
  return Buffer.concat([page(header, 0, 2, 0), page(tags, 1, 0, 0), page(Buffer.from([0xf8, 0xff, 0xfe]), 2, 4, 960)]);
}

function littleEndian(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function blockHeader(type, length, last) {
  const buffer = Buffer.alloc(4);
  buffer[0] = type | (last ? 0x80 : 0);
  buffer.writeUIntBE(length, 1, 3);
  return buffer;
}
