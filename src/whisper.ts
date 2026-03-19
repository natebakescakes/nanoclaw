import { createWriteStream, unlink } from 'fs';
import https from 'https';
import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const WHISPER_MODEL = process.env.WHISPER_MODEL || 'small';
const WHISPER_TIMEOUT = 120_000; // 2 minutes

/**
 * Download a file from Telegram's file CDN into a temp file.
 * Returns the local path, or null on failure.
 */
export async function downloadTelegramFile(
  token: string,
  filePath: string,
): Promise<string | null> {
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const ext = path.extname(filePath) || '.ogg';
  const tmpPath = path.join(os.tmpdir(), `tg-voice-${Date.now()}${ext}`);

  return new Promise((resolve) => {
    const dest = createWriteStream(tmpPath);
    https
      .get(url, (res) => {
        res.pipe(dest);
        dest.on('finish', () => {
          dest.close();
          resolve(tmpPath);
        });
      })
      .on('error', (err) => {
        logger.warn({ err }, 'Failed to download Telegram voice file');
        dest.destroy();
        unlink(tmpPath, () => {});
        resolve(null);
      });
  });
}

/**
 * Transcribe an audio file using the local `whisper` CLI.
 * Returns trimmed transcript text, or null if transcription fails.
 */
export async function transcribeAudio(
  filePath: string,
): Promise<string | null> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'whisper-out-'));
  try {
    const whisperBin = process.env.WHISPER_BIN || 'whisper';
    await execFileAsync(
      whisperBin,
      [
        filePath,
        '--model',
        WHISPER_MODEL,
        '--output_format',
        'txt',
        '--output_dir',
        tmpDir,
        '--fp16',
        'False', // CPU-safe: disable fp16 so it doesn't crash on non-GPU
      ],
      { timeout: WHISPER_TIMEOUT },
    );

    const baseName = path.basename(filePath, path.extname(filePath));
    const txtPath = path.join(tmpDir, `${baseName}.txt`);
    const text = await readFile(txtPath, 'utf-8');
    return text.trim() || null;
  } catch (err) {
    logger.warn({ err }, 'whisper transcription failed');
    return null;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
