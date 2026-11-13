// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { formatRef, parseRef, type SessionRef } from "./runtime/types.ts";

/**
 * A record written when seori still ran on herdr (a herdr pane ref such as `w1:p3`): seori runs on hc only and refuses
 * it with one line naming the file, instead of addressing a terminal that does not exist.
 */
export class HerdrRecord extends Error {
  constructor(where: string, value: string, fix = `remove ${where}`) {
    super(`${where} names the herdr pane ${value}; seori runs on hc only: close that pane and ${fix}`);
  }
}

/** A ref as seori stores and prints it (`hc:t7`): roles.json values, inbox file names and delivery notices use this form. */
export const refText = (ref: SessionRef): string => formatRef(ref);

/** Reads refText back; a value that is not an hc ref was written for herdr and is refused (HerdrRecord). */
export const refFromText = (text: string, where: string, fix?: string): SessionRef => {
  const ref = parseRef(text);
  if (ref === undefined) throw new HerdrRecord(where, text, fix);
  return ref;
};

export const sameSession = (a: SessionRef, b: SessionRef): boolean => a.runtime === b.runtime && a.id === b.id;
