import { describe, expect, it } from 'vitest';

import { resolveModelFilename, resolveWhisperBin } from './whisper.js';

describe('resolveWhisperBin', () => {
  it('defaults to whisper-cli when nothing is configured', () => {
    expect(resolveWhisperBin()).toBe('whisper-cli');
  });

  it('ignores the legacy python whisper binary name', () => {
    expect(resolveWhisperBin('/home/developer/.local/bin/whisper')).toBe(
      'whisper-cli',
    );
  });

  it('keeps an explicit whisper.cpp binary path', () => {
    expect(resolveWhisperBin('/usr/local/bin/whisper-cli')).toBe(
      '/usr/local/bin/whisper-cli',
    );
  });
});

describe('resolveModelFilename', () => {
  it('maps small to the whisper.cpp model filename', () => {
    expect(resolveModelFilename('small')).toBe('ggml-small.bin');
  });

  it('maps turbo to the large-v3-turbo whisper.cpp filename', () => {
    expect(resolveModelFilename('turbo')).toBe('ggml-large-v3-turbo.bin');
  });

  it('passes through explicit model paths unchanged', () => {
    expect(resolveModelFilename('/models/custom.bin')).toBe(
      '/models/custom.bin',
    );
  });
});
