/**
 * The release this build belongs to: package.json's one version
 * (COMMON-PROJECT-SPEC C13 in `second-brain`, CHANGELOG.md at the root). A
 * SERVER-side module: a client component that imported it would ship the whole
 * package.json in its chunk (measured — the bundler keeps every key), so the
 * root layout reads it and hands the string to the account popover as a prop.
 */
import { version } from "../../package.json";

export const APP_VERSION: string = version;
