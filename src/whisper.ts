import { createWriteStream, unlink } from 'fs';
import https from 'https';
import { access, mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);
const envConfig = readEnvFile([
  'FFMPEG_BIN',
  'WHISPER_BIN',
  'WHISPER_CPP_BIN',
  'WHISPER_LANGUAGE',
  'WHISPER_MODEL',
  'WHISPER_MODEL_DIR',
  'WHISPER_MODEL_PATH',
  'WHISPER_THREADS',
]);

const WHISPER_TIMEOUT = 120_000; // 2 minutes

const MODEL_FILENAMES: Record<string, string> = {
  tiny: 'ggml-tiny.bin',
  'tiny.en': 'ggml-tiny.en.bin',
  base: 'ggml-base.bin',
  'base.en': 'ggml-base.en.bin',
  small: 'ggml-small.bin',
  'small.en': 'ggml-small.en.bin',
  medium: 'ggml-medium.bin',
  'medium.en': 'ggml-medium.en.bin',
  'large-v1': 'ggml-large-v1.bin',
  'large-v2': 'ggml-large-v2.bin',
  'large-v3': 'ggml-large-v3.bin',
  large: 'ggml-large-v3.bin',
  'large-v3-turbo': 'ggml-large-v3-turbo.bin',
  turbo: 'ggml-large-v3-turbo.bin',
};

function getConfigValue(key: keyof typeof envConfig): string | undefined {
  return process.env[key] || envConfig[key];
}

export function resolveWhisperBin(configuredBin?: string): string {
  if (!configuredBin) return 'whisper-cli';

  const baseName = path.basename(configuredBin);
  if (baseName === 'whisper' || baseName === 'whisper.exe') {
    return 'whisper-cli';
  }

  return configuredBin;
}

export function resolveModelFilename(model: string): string {
  if (model.includes(path.sep) || model.endsWith('.bin')) return model;
  return MODEL_FILENAMES[model] || model;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveWhisperModelPath(model: string): Promise<string> {
  const configuredModelPath = getConfigValue('WHISPER_MODEL_PATH');
  if (configuredModelPath) return configuredModelPath;

  const modelRef = resolveModelFilename(model);
  if (path.isAbsolute(modelRef) || modelRef.includes(path.sep)) {
    return modelRef;
  }

  const configuredModelDir = getConfigValue('WHISPER_MODEL_DIR');
  const candidateDirs = [
    configuredModelDir,
    path.join(process.cwd(), 'models'),
    path.join(process.cwd(), 'whisper.cpp', 'models'),
    path.join(os.homedir(), '.local', 'share', 'whisper.cpp', 'models'),
    path.join(os.homedir(), '.cache', 'whisper.cpp'),
  ].filter((dir): dir is string => Boolean(dir));

  for (const dir of candidateDirs) {
    const candidate = path.join(dir, modelRef);
    if (await pathExists(candidate)) return candidate;
  }

  throw new Error(
    `whisper.cpp model not found: ${modelRef}. Set WHISPER_MODEL_PATH or WHISPER_MODEL_DIR.`,
  );
}

async function normalizeAudio(inputPath: string, outputPath: string): Promise<void> {
  const ffmpegBin = getConfigValue('FFMPEG_BIN') || 'ffmpeg';
  await execFileAsync(
    ffmpegBin,
    [
      '-nostdin',
      '-y',
      '-i',
      inputPath,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      outputPath,
    ],
    { timeout: WHISPER_TIMEOUT },
  );
}

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
 * Transcribe an audio file using local whisper.cpp.
 * Returns trimmed transcript text, or null if transcription fails.
 */
export async function transcribeAudio(
  filePath: string,
): Promise<string | null> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'whisper-out-'));
  try {
    const whisperModel = getConfigValue('WHISPER_MODEL') || 'small';
    const whisperLanguage = getConfigValue('WHISPER_LANGUAGE');
    const whisperThreads = getConfigValue('WHISPER_THREADS');
    const whisperBin = resolveWhisperBin(
      getConfigValue('WHISPER_CPP_BIN') || getConfigValue('WHISPER_BIN'),
    );
    const modelPath = await resolveWhisperModelPath(whisperModel);
    const normalizedAudioPath = path.join(tmpDir, 'input.wav');
    const outputPrefix = path.join(
      tmpDir,
      path.basename(filePath, path.extname(filePath)),
    );

    await normalizeAudio(filePath, normalizedAudioPath);

    const args = [
      '-m',
      modelPath,
      '-f',
      normalizedAudioPath,
      '-otxt',
      '-of',
      outputPrefix,
    ];
    if (whisperLanguage) {
      args.push('-l', whisperLanguage);
    }
    if (whisperThreads) {
      args.push('-t', whisperThreads);
    }

    await execFileAsync(
      whisperBin,
      args,
      { timeout: WHISPER_TIMEOUT },
    );

    const txtPath = `${outputPrefix}.txt`;
    const text = await readFile(txtPath, 'utf-8');
    return text.trim() || null;
  } catch (err) {
    logger.warn({ err }, 'whisper transcription failed');
    return null;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
