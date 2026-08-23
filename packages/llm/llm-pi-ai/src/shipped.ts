/**
 * Provider routes this adapter ships beside the installed pi-ai catalog.
 *
 * A shipped route is offered by the configurable-provider directory from the
 * moment the plugin mounts, but unlike a catalog route it has no installed
 * entry to default anything from: adopting one still declares its protocol
 * and models in configuration, or lists them through endpoint interrogation.
 * What an entry carries is what configuration surfaces prefill while nothing
 * is stored ??? the display name resolution agrees on, and the endpoint a
 * default installation of that server listens on.
 *
 * @module toh-llm-pi-ai/shipped
 */

/** The facts one shipped route offers a configuration surface. */
export interface ShippedRoute {
  /** Display name resolution and the directory agree on absent a profile's own. */
  displayName: string
  /** Endpoint the route is adopted with before the user edits it. */
  baseURL?: string
}

/**
 * The routes this adapter ships beyond the installed catalog, by route key. A
 * key pi-ai's installed catalog also describes never reaches this map's
 * consumers: the catalog entry wins, keeping one answer per question.
 */
export const SHIPPED_ROUTES: Readonly<Record<string, ShippedRoute>> = {
  // A local Ollama server, adopted through its OpenAI-compatible endpoint;
  // endpoint interrogation lists its models without a credential. The host
  // gateway name covers both a browser served from this machine and one
  // served from a container on the same host.
  'ollama': {
    displayName: 'Ollama (Local)',
    baseURL: 'http://host.docker.internal:11434/v1',
  },
}
