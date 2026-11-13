import { type ArgvTemplate, loadHooks, substitute } from "../hooks.ts";
import { type Exec, spawnExec } from "../runtime/index.ts";

// Ported from dori-superagent skills/dori-mode/scripts/src/messenger/voice.ts (e8e238f, MIT), adapted to seori's
// exec and hooks.ts. The speech-to-text engine is whatever the owner configures as hooks.transcribe.

/** A transcription that cannot be produced; the message is one line, fit for stderr or a CLI error. */
export class TranscriptionError extends Error {}

const firstLine = (s: string): string => s.trim().split("\n")[0] ?? "";

/**
 * Runs the hooks.transcribe argv template with `{file}` replaced by `file` and returns its trimmed stdout. When `signal`
 * aborts, the hook's process is killed.
 */
export async function transcribe(exec: Exec, hook: ArgvTemplate | undefined, file: string, signal?: AbortSignal): Promise<string> {
  if (!hook) throw new TranscriptionError("hooks.transcribe is not configured in config.json");
  const [cmd, ...rest] = substitute(hook, { file });
  if (cmd === undefined) throw new TranscriptionError("hooks.transcribe is empty");
  let res;
  let kill: (() => void) | undefined;
  try {
    res = await exec(cmd, rest, {
      onSpawn: (proc) => {
        kill = () => proc.kill();
        if (signal?.aborted) kill();
        else signal?.addEventListener("abort", kill, { once: true });
      },
    });
  } catch (e) {
    throw new TranscriptionError(`transcription failed: ${firstLine(e instanceof Error ? e.message : String(e))}`);
  } finally {
    if (kill) signal?.removeEventListener("abort", kill);
  }
  const text = res.stdout.trim();
  if (res.code !== 0 || !text)
    throw new TranscriptionError(`transcription failed (exit ${res.code}): ${firstLine(res.stderr).slice(0, 160) || "no output"}`);
  return text;
}

/**
 * What an adapter calls for a voice or audio message. `fetchFile` saves the audio and returns its path; it only runs
 * once hooks.transcribe is known to be configured (read per call, so editing config.json needs no restart). When
 * `signal` aborts, the hook's process is killed.
 */
export type VoiceTranscriber = (fetchFile: () => Promise<string>, signal?: AbortSignal) => Promise<string>;

export function voiceTranscriber(root: string, exec: Exec = spawnExec): VoiceTranscriber {
  return async (fetchFile, signal) => {
    const hook = loadHooks(root).transcribe;
    if (!hook) throw new TranscriptionError("hooks.transcribe is not configured in config.json");
    return transcribe(exec, hook, await fetchFile(), signal);
  };
}
