import { parseFile, selectCover } from 'music-metadata';

export const SUPPORTED_AUDIO_EXTENSIONS = new Set(['.flac', '.alac', '.m4a', '.mp3', '.aac', '.ogg']);

export async function analyzeAudioFile(filePath) {
  const metadata = await parseFile(filePath, { duration: true });
  if (!metadata.format.hasAudio) throw new Error('오디오 스트림을 찾을 수 없습니다.');

  const format = normalizeFormat(metadata.format);
  const lossless = Boolean(metadata.format.lossless || format === 'FLAC' || format === 'ALAC');
  if (!lossless && !['MP3', 'AAC', 'VORBIS', 'OPUS'].includes(format)) {
    throw new Error(`지원하지 않는 오디오 코덱입니다: ${metadata.format.codec || metadata.format.container || '알 수 없음'}`);
  }

  const picture = selectCover(metadata.common.picture);
  return {
    title: metadata.common.title || null,
    artist: metadata.common.artist || metadata.common.albumartist || null,
    albumArtist: metadata.common.albumartist || metadata.common.artist || null,
    album: metadata.common.album || null,
    genre: metadata.common.genre?.[0] || null,
    year: metadata.common.year || leadingInteger(metadata.common.date),
    trackNumber: metadata.common.track?.no || null,
    discNumber: metadata.common.disk?.no || null,
    durationMs: metadata.format.duration ? Math.round(metadata.format.duration * 1000) : null,
    sampleRate: metadata.format.sampleRate || null,
    bitDepth: metadata.format.bitsPerSample || null,
    channels: metadata.format.numberOfChannels || null,
    bitrate: metadata.format.bitrate ? Math.round(metadata.format.bitrate) : null,
    format,
    lossless,
    artwork: picture ? {
      mime: picture.format || 'image/jpeg',
      data: Buffer.from(picture.data)
    } : null
  };
}

export function qualityRank(metadata) {
  if (metadata.lossless) {
    const formatPreference = metadata.format === 'FLAC' ? 2 : 1;
    return 1_000_000_000_000 + (metadata.bitDepth || 0) * 1_000_000_000 + (metadata.sampleRate || 0) * 1_000 + formatPreference;
  }
  return metadata.bitrate || 0;
}

export function qualityLabel(metadata) {
  if (metadata.lossless) {
    const detail = [metadata.bitDepth ? `${metadata.bitDepth}-bit` : null, metadata.sampleRate ? `${formatKhz(metadata.sampleRate)} kHz` : null].filter(Boolean).join('/');
    return detail ? `${metadata.format} ${detail}` : `${metadata.format} 무손실`;
  }
  return `${metadata.format} ${metadata.bitrate ? `${Math.round(metadata.bitrate / 1000)} kbps` : '비트레이트 미상'}`;
}

function normalizeFormat(format) {
  const codec = String(format.codec || '').toUpperCase();
  const container = String(format.container || '').toUpperCase();
  if (codec.includes('ALAC')) return 'ALAC';
  if (codec.includes('FLAC') || container.includes('FLAC')) return 'FLAC';
  if (codec.includes('AAC') || container.includes('ADTS')) return 'AAC';
  if (codec.includes('VORBIS')) return 'VORBIS';
  if (codec.includes('OPUS')) return 'OPUS';
  if (codec.includes('MPEG') || codec.includes('MP3') || container.includes('MPEG')) return 'MP3';
  return codec || container || 'UNKNOWN';
}

function leadingInteger(value) {
  const match = String(value || '').match(/^\s*(\d{4})/);
  return match ? Number(match[1]) : null;
}

function formatKhz(sampleRate) {
  return Number((sampleRate / 1000).toFixed(1));
}
