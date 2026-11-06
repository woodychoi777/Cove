import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class MusicStore {
  constructor(databasePath) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.db.exec('CREATE TABLE IF NOT EXISTS deleted_track_ids(id INTEGER PRIMARY KEY)');
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artists (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS albums (
        id INTEGER PRIMARY KEY,
        artist_id INTEGER NOT NULL REFERENCES artists(id),
        title TEXT NOT NULL,
        release_year INTEGER,
        genre TEXT,
        artwork_path TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS albums_identity
        ON albums(artist_id, title, COALESCE(release_year, -1));
      CREATE TABLE IF NOT EXISTS tracks (
        id INTEGER PRIMARY KEY,
        album_id INTEGER NOT NULL REFERENCES albums(id),
        artist_id INTEGER NOT NULL REFERENCES artists(id),
        title TEXT NOT NULL,
        disc_number INTEGER,
        track_number INTEGER,
        duration_ms INTEGER,
        is_life_song INTEGER NOT NULL DEFAULT 0,
        lyrics_original TEXT NOT NULL DEFAULT '',
        lyrics_translation TEXT NOT NULL DEFAULT '',
        lyrics_lrc TEXT NOT NULL DEFAULT '',
        lyrics_source_name TEXT NOT NULL DEFAULT '',
        lyrics_file_path TEXT,
        meaning TEXT NOT NULL DEFAULT '',
        favorite_reason TEXT NOT NULL DEFAULT '',
        memory TEXT NOT NULL DEFAULT '',
        play_count INTEGER NOT NULL DEFAULT 0,
        last_played_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS audio_files (
        id INTEGER PRIMARY KEY,
        track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        managed_path TEXT NOT NULL UNIQUE,
        original_name TEXT,
        format TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        sample_rate INTEGER,
        bit_depth INTEGER,
        channels INTEGER,
        bitrate INTEGER,
        lossless INTEGER NOT NULL DEFAULT 0,
        checksum_sha256 TEXT NOT NULL UNIQUE,
        imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        availability TEXT NOT NULL DEFAULT 'available'
      );
      CREATE TABLE IF NOT EXISTS playback_events (
        id INTEGER PRIMARY KEY,
        track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        listened_ms INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS listening_queues (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL,
        track_ids TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS playlist_tracks (
        playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK(position >= 0),
        PRIMARY KEY (playlist_id, track_id), UNIQUE (playlist_id, position)
      );
      CREATE INDEX IF NOT EXISTS playlist_track_lookup ON playlist_tracks(track_id);
      CREATE TABLE IF NOT EXISTS music_interests (
        id INTEGER PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL,
        album TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
        stage TEXT NOT NULL DEFAULT 'discovered' CHECK(stage IN ('discovered','listening','planned','owned')),
        track_id INTEGER REFERENCES tracks(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    this.addColumnIfMissing('tracks', 'lyrics_lrc', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('tracks', 'lyrics_source_name', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('tracks', 'lyrics_file_path', 'TEXT');
    this.addColumnIfMissing('tracks', 'artwork_path', 'TEXT');
    this.addColumnIfMissing('audio_files', 'bitrate', 'INTEGER');
    this.addColumnIfMissing('audio_files', 'lossless', 'INTEGER NOT NULL DEFAULT 0');
    this.db.exec(`
      UPDATE audio_files SET lossless = 1
      WHERE UPPER(format) IN ('FLAC', 'ALAC');
      UPDATE audio_files SET bitrate = (
        SELECT CAST(audio_files.file_size * 8.0 * 1000 / tracks.duration_ms AS INTEGER)
        FROM tracks WHERE tracks.id = audio_files.track_id AND tracks.duration_ms > 0
      )
      WHERE bitrate IS NULL;
    `);
  }

  addColumnIfMissing(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  findByChecksum(checksum) {
    return this.db.prepare(`
      SELECT tracks.id, tracks.title, artists.name AS artist, albums.title AS album,
             audio_files.managed_path AS managedPath
      FROM audio_files
      JOIN tracks ON tracks.id = audio_files.track_id
      JOIN artists ON artists.id = tracks.artist_id
      JOIN albums ON albums.id = tracks.album_id
      WHERE audio_files.checksum_sha256 = ?
    `).get(checksum) ?? null;
  }

  saveImportedTrack(data) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO artists(name) VALUES (?)').run(data.artist);
      const artist = this.db.prepare('SELECT id FROM artists WHERE name = ? COLLATE NOCASE').get(data.artist);
      let album = this.db.prepare(`
        SELECT id FROM albums
        WHERE artist_id = ? AND title = ? AND COALESCE(release_year, -1) = COALESCE(?, -1)
      `).get(artist.id, data.album, data.year);
      if (!album) {
        const result = this.db.prepare(`
          INSERT INTO albums(artist_id, title, release_year, genre, artwork_path)
          VALUES (?, ?, ?, ?, ?)
        `).run(artist.id, data.album, data.year, data.genre, data.artworkPath);
        album = { id: Number(result.lastInsertRowid) };
      } else if (data.artworkPath) {
        this.db.prepare('UPDATE albums SET artwork_path = COALESCE(artwork_path, ?) WHERE id = ?').run(data.artworkPath, album.id);
      }

      const trackResult = this.db.prepare(`
        INSERT INTO tracks(
          id, album_id, artist_id, title, disc_number, track_number, duration_ms,
          lyrics_original, lyrics_lrc, lyrics_source_name, lyrics_file_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        this.db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM (SELECT id FROM tracks UNION ALL SELECT id FROM deleted_track_ids)').get().id,
        album.id, artist.id, data.title, data.discNumber, data.trackNumber, data.durationMs,
        data.lrcText || '', data.lrcText || '', data.lrcSourceName || '', data.lrcPath || null
      );
      const trackId = Number(trackResult.lastInsertRowid);
      this.db.prepare(`UPDATE music_interests SET track_id = ?, stage = 'owned'
        WHERE track_id IS NULL AND title = ? COLLATE NOCASE AND artist = ? COLLATE NOCASE`).run(trackId, data.title, data.artist);
      this.db.prepare(`
        INSERT INTO audio_files(
          track_id, managed_path, original_name, format, file_size,
          sample_rate, bit_depth, channels, bitrate, lossless, checksum_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        trackId, data.managedPath, data.originalName, data.format, data.fileSize,
        data.sampleRate, data.bitDepth, data.channels, data.bitrate,
        data.lossless ? 1 : 0, data.checksum
      );
      this.db.exec('COMMIT');
      return this.getTrack(trackId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deleteTrack(id) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Keep IDs reserved: alarm settings and saved client queues may still reference them.
      this.db.exec('CREATE TABLE IF NOT EXISTS deleted_track_ids(id INTEGER PRIMARY KEY)');
      this.db.prepare('INSERT OR IGNORE INTO deleted_track_ids VALUES (?)').run(id);
      this.db.prepare('UPDATE music_interests SET track_id = NULL WHERE track_id = ?').run(id);
      this.db.prepare('UPDATE playlists SET revision = revision + 1 WHERE id IN (SELECT playlist_id FROM playlist_tracks WHERE track_id = ?)').run(id);
      this.db.prepare('DELETE FROM tracks WHERE id = ?').run(id);
      for (const queue of this.listQueues()) this.db.prepare('UPDATE listening_queues SET track_ids = ? WHERE id = ?').run(JSON.stringify(queue.trackIds.filter(value => value !== id)), queue.id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  listTracks() {
    return this.db.prepare(`
      SELECT tracks.id, tracks.title, tracks.created_at AS createdAt, tracks.album_id AS albumId, tracks.artist_id AS artistId,
             tracks.disc_number AS discNumber, tracks.track_number AS trackNumber,
             tracks.meaning, tracks.favorite_reason AS favoriteReason, tracks.memory,
             tracks.duration_ms AS durationMs, tracks.is_life_song AS isLifeSong,
             tracks.play_count AS playCount, tracks.last_played_at AS lastPlayedAt,
             artists.name AS artist, albums.title AS album, albums.release_year AS year,
             COALESCE(tracks.artwork_path, albums.artwork_path) AS artworkPath, audio_files.format,
             audio_files.file_size AS fileSize, audio_files.sample_rate AS sampleRate,
             audio_files.bit_depth AS bitDepth, audio_files.bitrate,
             audio_files.lossless
      FROM tracks
      JOIN artists ON artists.id = tracks.artist_id
      JOIN albums ON albums.id = tracks.album_id
      JOIN audio_files ON audio_files.track_id = tracks.id
      ORDER BY tracks.created_at DESC, tracks.id DESC
    `).all().map(normalizeTrack);
  }

  getTrack(id) {
    const row = this.db.prepare(`
      SELECT tracks.*, tracks.track_number AS trackNumber, tracks.disc_number AS discNumber,
             tracks.album_id AS albumId, tracks.artist_id AS artistId,
             tracks.duration_ms AS durationMs, tracks.is_life_song AS isLifeSong,
             tracks.lyrics_original AS lyricsOriginal,
             tracks.lyrics_translation AS lyricsTranslation,
             tracks.lyrics_lrc AS lyricsLrc,
             tracks.lyrics_source_name AS lyricsSourceName,
             tracks.lyrics_file_path AS lyricsFilePath,
             tracks.favorite_reason AS favoriteReason,
             tracks.play_count AS playCount, tracks.last_played_at AS lastPlayedAt,
             artists.name AS artist, albums.title AS album, albums.release_year AS year,
             albums.genre, COALESCE(tracks.artwork_path, albums.artwork_path) AS artworkPath,
             audio_files.managed_path AS managedPath, audio_files.original_name AS originalName,
             audio_files.format, audio_files.file_size AS fileSize,
             audio_files.sample_rate AS sampleRate, audio_files.bit_depth AS bitDepth,
             audio_files.channels, audio_files.bitrate, audio_files.lossless,
             audio_files.checksum_sha256 AS checksum,
             audio_files.availability
      FROM tracks
      JOIN artists ON artists.id = tracks.artist_id
      JOIN albums ON albums.id = tracks.album_id
      JOIN audio_files ON audio_files.track_id = tracks.id
      WHERE tracks.id = ?
    `).get(id);
    return row ? normalizeTrack(row) : null;
  }

  recentListening(now = Date.now()) {
    // Events are listened segments, not unique sessions or completed plays.
    // julianday accepts both legacy SQLite UTC timestamps and ISO timestamps.
    return this.db.prepare(`
      SELECT e.track_id AS id, COUNT(*) AS segmentCount, MAX(julianday(e.created_at)) AS lastListenedAt
      FROM playback_events e JOIN tracks t ON t.id = e.track_id
      WHERE julianday(e.created_at) >= julianday(?) AND julianday(e.created_at) <= julianday(?)
        AND e.listened_ms >= MIN(30000, COALESCE(NULLIF(t.duration_ms, 0), 240000) / 2.0)
        AND EXISTS (SELECT 1 FROM audio_files f WHERE f.track_id = t.id)
      GROUP BY e.track_id
      ORDER BY segmentCount DESC, lastListenedAt DESC, e.track_id ASC
      LIMIT 10
    `).all(new Date(now - 7 * 86400000).toISOString(), new Date(now).toISOString());
  }

  updateArtwork(id, artworkPath) {
    const track = this.getTrack(id);
    if (!track) throw new Error('곡을 찾을 수 없습니다.');
    // Unidentified files share a placeholder album, not a release identity.
    const album = String(track.album ?? '').trim();
    if (!album || album === '알 수 없는 앨범') {
      this.db.prepare('UPDATE tracks SET artwork_path = ? WHERE id = ?').run(artworkPath, id);
    } else {
      this.db.prepare('UPDATE albums SET artwork_path = ? WHERE id = ?').run(artworkPath, track.album_id);
    }
    return this.getTrack(id);
  }

  updateTitle(id, value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('곡 이름을 입력해 주세요.');
    const title = value.trim();
    if (title.length > 300) throw new Error('곡 이름은 300자 이하로 입력해 주세요.');
    return this.db.prepare('UPDATE tracks SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING id, title, updated_at AS updatedAt').get(title, id) || null;
  }

  attachAutomaticLyrics(id, { text, sourceName, path }) {
    return this.db.prepare(`UPDATE tracks SET lyrics_original = ?, lyrics_lrc = ?, lyrics_source_name = ?, lyrics_file_path = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND lyrics_original = '' AND lyrics_lrc = ''`).run(text, text, sourceName, path, id).changes > 0;
  }

  updateInfo(id, values, artworkPath) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('곡 정보를 확인해 주세요.');
    const current = this.getTrack(id);
    if (!current) return null;
    const columns = { title: 'title', lyricsOriginal: 'lyrics_original', lyricsTranslation: 'lyrics_translation' };
    for (const key of ['title', 'artist', 'lyricsOriginal', 'lyricsTranslation']) {
      if (!Object.hasOwn(values, key)) continue;
      if (typeof values[key] !== 'string') throw new Error('곡 정보는 텍스트로 입력해 주세요.');
      if (values[key].length > (['title', 'artist'].includes(key) ? 300 : 500000)) throw new Error('입력한 내용이 너무 깁니다.');
    }
    if (Object.hasOwn(values, 'title') && !values.title.trim()) throw new Error('곡 이름을 입력해 주세요.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const keys = Object.keys(columns).filter(key => Object.hasOwn(values, key));
      if (keys.length) this.db.prepare(`UPDATE tracks SET ${keys.map(key => `${columns[key]} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(...keys.map(key => key === 'title' ? values[key].trim() : values[key]), id);
      if (Object.hasOwn(values, 'artist')) {
        // Reassign this track; never rename a shared artist or its other songs.
        const artist = values.artist.trim();
        this.db.prepare('INSERT OR IGNORE INTO artists(name) VALUES (?)').run(artist);
        const row = this.db.prepare('SELECT id FROM artists WHERE name = ? COLLATE NOCASE').get(artist);
        this.db.prepare('UPDATE tracks SET artist_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id, id);
      }
      if (artworkPath) this.updateArtwork(id, artworkPath);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getTrack(id);
  }

  updateNotes(id, values) {
    const current = this.getTrack(id);
    if (!current) return null;
    const columns = { lyricsOriginal: 'lyrics_original', lyricsTranslation: 'lyrics_translation', meaning: 'meaning', favoriteReason: 'favorite_reason', memory: 'memory', isLifeSong: 'is_life_song' };
    const keys = Object.keys(columns).filter(key => Object.hasOwn(values, key));
    if (!keys.length) return current;
    this.db.prepare(`UPDATE tracks SET ${keys.map(key => `${columns[key]} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(...keys.map(key => key === 'isLifeSong' ? (values[key] ? 1 : 0) : String(values[key] ?? '')), id);
    return this.getTrack(id);
  }

  updateComments(id, comment) {
    if (typeof comment !== 'string') throw new Error('코멘트 내용을 확인해 주세요.');
    if (!this.getTrack(id)) return null;
    // Consolidate only on explicit save, in one atomic update. Lyrics and files
    // are outside this write scope, even when a lyric save overlaps it.
    this.db.prepare(`UPDATE tracks SET meaning = '', favorite_reason = '', memory = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(comment, id);
    return this.getTrack(id);
  }

  updateFavorite(id, isLifeSong) {
    if (typeof isLifeSong !== 'boolean') throw new Error('최애곡 선택을 확인해 주세요.');
    const row = this.db.prepare('UPDATE tracks SET is_life_song = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING id, is_life_song AS isLifeSong').get(isLifeSong ? 1 : 0, id);
    return row ? normalizeTrack(row) : null;
  }

  recordPlayback(id, listenedMs, completed) {
    if (!this.getTrack(id)) return null;
    const duration = this.getTrack(id).durationMs || 240_000;
    const validPlay = listenedMs >= Math.min(30_000, duration / 2);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO playback_events(track_id, listened_ms, completed) VALUES (?, ?, ?)
      `).run(id, Math.max(0, Math.round(listenedMs || 0)), completed ? 1 : 0);
      if (validPlay) {
        this.db.prepare(`
          UPDATE tracks SET play_count = play_count + 1,
            last_played_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getTrack(id);
  }

  exportCollection() {
    return {
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      tracks: this.listTracks().map((track) => this.getTrack(track.id)),
      queues: this.listQueues(), interests: this.listInterests(), playlists: this.listPlaylists()
    };
  }

  listPlaylists() {
    const rows = this.db.prepare('SELECT id, name, revision, created_at AS createdAt, updated_at AS updatedAt FROM playlists ORDER BY id').all();
    const items = this.db.prepare('SELECT playlist_id, track_id FROM playlist_tracks ORDER BY playlist_id, position').all();
    const ids = new Map(rows.map(row => [row.id, []]));
    for (const item of items) ids.get(item.playlist_id)?.push(item.track_id);
    return rows.map(row => ({ ...row, trackIds: ids.get(row.id) }));
  }

  getPlaylist(id) {
    const row = this.db.prepare('SELECT id, name, revision, created_at AS createdAt, updated_at AS updatedAt FROM playlists WHERE id = ?').get(id);
    if (!row) throw new PlaylistError(404, 'NOT_FOUND', '삭제되었거나 찾을 수 없는 플레이리스트입니다.');
    return { ...row, trackIds: this.db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position').all(id).map(row => row.track_id) };
  }

  playlistName(value, id = null) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) throw new PlaylistError(400, 'INVALID_NAME', '이름을 1~100자로 입력해 주세요.');
    const name = value.trim().normalize('NFC'), key = name.toLocaleLowerCase('ko');
    const existing = this.db.prepare('SELECT id FROM playlists WHERE name_key = ?').get(key);
    if (existing && existing.id !== id) throw new PlaylistError(409, 'NAME_EXISTS', '같은 이름의 플레이리스트가 있습니다. 다른 이름을 입력해 주세요.');
    return { name, key };
  }

  playlistTransaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  createPlaylist(value) {
    return this.playlistTransaction(() => {
      const { name, key } = this.playlistName(value);
      const result = this.db.prepare('INSERT INTO playlists(name, name_key) VALUES (?, ?)').run(name, key);
      return this.getPlaylist(Number(result.lastInsertRowid));
    });
  }

  requirePlaylistVersion(id, revision) {
    const current = this.getPlaylist(id);
    if (!Number.isSafeInteger(revision) || current.revision !== revision) throw new PlaylistError(409, 'REVISION_CONFLICT', '다른 창에서 변경된 목록입니다. 최신 목록을 불러온 뒤 다시 확인해 주세요.', current);
    return current;
  }

  updatePlaylist(id, values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new PlaylistError(400, 'INVALID_REQUEST', '목록 변경 내용을 확인해 주세요.');
    return this.playlistTransaction(() => {
      const current = this.requirePlaylistVersion(id, values.revision);
      const { name, key } = this.playlistName(values.name === undefined ? current.name : values.name, id);
      if (values.trackIds !== undefined && values.addTrackIds !== undefined) throw new PlaylistError(400, 'INVALID_TRACKS', '곡 추가와 순서 변경을 나누어 요청해 주세요.');
      const input = values.trackIds !== undefined ? values.trackIds : values.addTrackIds;
      if (input !== undefined && (!Array.isArray(input) || input.some(id => !Number.isSafeInteger(id) || id < 1 || !this.db.prepare('SELECT id FROM tracks WHERE id = ?').get(id)))) throw new PlaylistError(400, 'INVALID_TRACKS', '서재에 있는 곡만 추가할 수 있습니다.');
      if (values.trackIds && new Set(values.trackIds).size !== values.trackIds.length) throw new PlaylistError(400, 'DUPLICATE_TRACK', '같은 곡을 목록에 두 번 넣을 수 없습니다.');
      const ids = values.trackIds ?? [...new Set([...current.trackIds, ...(values.addTrackIds || [])])];
      this.db.prepare('UPDATE playlists SET name = ?, name_key = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(name, key, id);
      if (input !== undefined) {
        this.db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(id);
        const insert = this.db.prepare('INSERT INTO playlist_tracks(playlist_id, track_id, position) VALUES (?, ?, ?)');
        ids.forEach((trackId, position) => insert.run(id, trackId, position));
      }
      return this.getPlaylist(id);
    });
  }

  deletePlaylist(id, revision) {
    return this.playlistTransaction(() => {
      this.requirePlaylistVersion(id, revision);
      this.db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
      return { id };
    });
  }

  listQueues() {
    return this.db.prepare('SELECT id, name, track_ids, created_at AS createdAt FROM listening_queues ORDER BY id DESC').all()
      .map(({ track_ids, ...row }) => ({ ...row, trackIds: JSON.parse(track_ids) }));
  }

  saveQueue(values) {
    const name = String(values.name || '').trim().slice(0, 100);
    const ids = values.trackIds;
    if (!name || !Array.isArray(ids) || !ids.length || ids.length > 2000 || ids.some(id => !Number.isInteger(id) || !this.getTrack(id))) {
      throw new Error('이름과 유효한 소장곡 목록(최대 2,000곡)이 필요합니다.');
    }
    const result = this.db.prepare('INSERT INTO listening_queues(name, track_ids) VALUES (?, ?)').run(name, JSON.stringify(ids));
    return this.listQueues().find(row => row.id === Number(result.lastInsertRowid));
  }

  listInterests() {
    return this.db.prepare('SELECT id, title, artist, album, note, stage, track_id AS trackId FROM music_interests ORDER BY id DESC').all();
  }

  saveInterest(values, id = null) {
    const title = String(values.title || '').trim().slice(0, 300);
    const artist = String(values.artist || '').trim().slice(0, 300);
    const stage = String(values.stage || 'discovered');
    if (!title || !artist || !['discovered', 'listening', 'planned', 'owned'].includes(stage)) throw new Error('곡명·아티스트와 관심 단계를 확인해 주세요.');
    const existing = id ? this.listInterests().find(row => row.id === id) : null;
    if (id && !existing) throw new Error('관심 음악을 찾을 수 없습니다.');
    const track = this.listTracks().find(row => row.title.toLowerCase() === title.toLowerCase() && row.artist.toLowerCase() === artist.toLowerCase());
    if (stage === 'owned' && !track) throw new Error('소장 완료로 표시하려면 먼저 해당 음원을 가져오세요.');
    const args = [title, artist, String(values.album || '').trim().slice(0, 300), String(values.note || '').slice(0, 10000), track ? 'owned' : stage, track?.id ?? null];
    if (id) this.db.prepare('UPDATE music_interests SET title=?, artist=?, album=?, note=?, stage=?, track_id=? WHERE id=?').run(...args, id);
    else id = Number(this.db.prepare('INSERT INTO music_interests(title,artist,album,note,stage,track_id) VALUES (?,?,?,?,?,?)').run(...args).lastInsertRowid);
    return this.listInterests().find(row => row.id === id);
  }

  stats() {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS trackCount, COALESCE(SUM(file_size), 0) AS totalBytes,
             COALESCE(SUM(CASE WHEN tracks.is_life_song = 1 THEN 1 ELSE 0 END), 0) AS lifeSongCount
      FROM audio_files JOIN tracks ON tracks.id = audio_files.track_id
    `).get();
    return { trackCount: Number(row.trackCount), totalBytes: Number(row.totalBytes), lifeSongCount: Number(row.lifeSongCount) };
  }

  close() {
    this.db.close();
  }
}

export class PlaylistError extends Error {
  constructor(status, code, message, current = null) {
    super(message); this.status = status; this.code = code; this.current = current;
  }
}

function normalizeTrack(row) {
  const output = { ...row };
  if ('isLifeSong' in output) output.isLifeSong = Boolean(output.isLifeSong);
  if ('lossless' in output) output.lossless = Boolean(output.lossless);
  return output;
}
