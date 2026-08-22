/**
 * Directory-picker browsing surface, node half. Pure UI plugin: the empty
 * apply exists so the plugin appears in the host cordis.yml / Loader; the
 * browser half ships via exports["./client"], discovered through the
 * package.json toh.client declaration. The listing and creation primitives it
 * drives live in `@buckeyestudio/toh-host-directory-picker-browse`.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
