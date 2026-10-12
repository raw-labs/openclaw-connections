// Host-side test adapter only. Production receives api.runtime.state directly.
import { createPluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-store-runtime";
export function stateRuntime(directory, pluginId = "openclaw-connections") {
  const env = { ...process.env, OPENCLAW_STATE_DIR: directory };
  return {
    openKeyedStore(options) {
      return createPluginStateKeyedStore(pluginId, { ...options, env });
    },
  };
}
