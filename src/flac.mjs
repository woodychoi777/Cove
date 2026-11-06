import { open } from 'node:fs/promises';

const MAX_METADATA_BYTES = 32 * 1024 * 1024;

export class FlacFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FlacFormatError';
  }
}

export async function readFlacMetadata(filePath) {
  const file = await open(filePath, 'r');
  try {
    const stat = await file.stat();
    const length = Math.min(stat.size, MAX_METADATA_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, 0);
    return parseFlacBuffer(buffer.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}

export function parseFlacBuffer(buffer) {
  if (buffer.length < 8 || buffer.subarray(0, 4).toString('ascii') !== 'fLaC') {
    throw new FlacFormatError('FLAC 파일 헤더를 찾을 수 없습니다.');
  }

  let offset = 4;
  let isLast = false;
  const comments = new Map();
  let streamInfo = {};
  let artwork = null;

  while (!isLast) {
    if (offset + 4 > buffer.length) {
      throw new FlacFormatError('FLAC 메타데이터가 잘렸습니다.');
    }

    const header = buffer[offset];
    isLast = Boolean(header & 0x80);
    const type = header & 0x7f;
    const length = buffer.readUIntBE(offset + 1, 3);
    offset += 4;

    if (offset + length > buffer.length) {
      throw new FlacFormatError('FLAC 메타데이터 블록이 너무 크거나 잘렸습니다.');
    }

    const block = buffer.subarray(offset, offset + length);
    if (type === 0) streamInfo = parseStreamInfo(block);
    if (type === 4) parseVorbisComments(block, comments);
    if (type === 6) {
      const candidate = parsePicture(block);
      if (candidate && (!artwork || candidate.type === 3)) artwork = candidate;
    }
    offset += length;
  }

  const first = (name) => comments.get(name)?.[0] ?? null;
  const yearText = first('DATE') ?? first('YEAR');
  const trackText = first('TRACKNUMBER');
  const discText = first('DISCNUMBER');

  return {
    title: first('TITLE'),
    artist: first('ARTIST') ?? first('ALBUMARTIST'),
    albumArtist: first('ALBUMARTIST') ?? first('ARTIST'),
    album: first('ALBUM'),
    genre: first('GENRE'),
    year: parseLeadingInteger(yearText),
    trackNumber: parseLeadingInteger(trackText),
    discNumber: parseLeadingInteger(discText),
    ...streamInfo,
    artwork
  };
}

function parseStreamInfo(block) {
  if (block.length < 18) return {};
  const packed = block.readBigUInt64BE(10);
  const sampleRate = Number((packed >> 44n) & 0xfffffn);
  const channels = Number((packed >> 41n) & 0x7n) + 1;
  const bitDepth = Number((packed >> 36n) & 0x1fn) + 1;
  const totalSamples = Number(packed & 0xfffffffffn);
  const durationMs = sampleRate > 0 ? Math.round((totalSamples / sampleRate) * 1000) : null;
  return { sampleRate, channels, bitDepth, durationMs };
}

function parseVorbisComments(block, output) {
  let offset = 0;
  if (block.length < 8) return;

  const vendorLength = block.readUInt32LE(offset);
  offset += 4 + vendorLength;
  if (offset + 4 > block.length) return;

  const count = block.readUInt32LE(offset);
  offset += 4;
  for (let index = 0; index < count; index += 1) {
    if (offset + 4 > block.length) break;
    const length = block.readUInt32LE(offset);
    offset += 4;
    if (offset + length > block.length) break;
    const entry = block.subarray(offset, offset + length).toString('utf8');
    offset += length;
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    const key = entry.slice(0, separator).toUpperCase();
    const value = entry.slice(separator + 1);
    if (!output.has(key)) output.set(key, []);
    output.get(key).push(value);
  }
}

function parsePicture(block) {
  try {
    let offset = 0;
    const type = block.readUInt32BE(offset);
    offset += 4;
    const mimeLength = block.readUInt32BE(offset);
    offset += 4;
    const mime = block.subarray(offset, offset + mimeLength).toString('utf8');
    offset += mimeLength;
    const descriptionLength = block.readUInt32BE(offset);
    offset += 4 + descriptionLength;
    const width = block.readUInt32BE(offset);
    const height = block.readUInt32BE(offset + 4);
    offset += 16;
    const dataLength = block.readUInt32BE(offset);
    offset += 4;
    if (offset + dataLength > block.length) return null;
    return { type, mime, width, height, data: Buffer.from(block.subarray(offset, offset + dataLength)) };
  } catch {
    return null;
  }
}

function parseLeadingInteger(value) {
  if (!value) return null;
  const match = String(value).match(/^\s*(\d{1,6})/);
  return match ? Number(match[1]) : null;
}
