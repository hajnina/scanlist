/**
 * The demo list, bundled at build time from the shared sample fixture.
 *
 * Importing the *shared* sample (instead of a copy under public/) means the demo can never drift
 * from shared/spec/samples/van-weekly.json, and it exercises the same `?raw` + ts-core path as the
 * golden test. It is a static asset in the bundle, so "Load the demo list" also works offline.
 */
import vanWeeklyRaw from "../../../../shared/spec/samples/van-weekly.json?raw";

export const demoListText: string = vanWeeklyRaw;
