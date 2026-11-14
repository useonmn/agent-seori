import { existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/** The path, symlinks resolved when it exists. */
export const real = (path: string): string => (existsSync(path) ? realpathSync(path) : resolve(path));

/** Whether `path` is `dir` or inside it, symlinks resolved. */
export const within = (path: string, dir: string): boolean => {
  const [p, r] = [real(path), real(dir)];
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
};

/**
 * Whether a lane whose directory is `cwd` was asked to start in the checkout seori runs from (`install`, SEORI_SRC).
 * The default install is the checkout at $SEORI_HOME/src. Only a home inside the checkout (the other nesting) is
 * exempt: a folder in it is seori's state, never its code.
 */
export const inInstall = (cwd: string, install: string, home: string): boolean =>
  within(cwd, install) && !(within(home, install) && within(cwd, home));
