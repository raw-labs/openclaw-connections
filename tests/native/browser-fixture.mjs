(async () => {
  const module = await import(globalThis.connectionsTestEntry);
  if (typeof module.default?.activate !== "function")
    throw Error("Invalid native UI entry");
  document.body.replaceChildren();
  const root = document.createElement("main");
  document.body.append(root);
  const request = globalThis.nativeRequest;
  if (typeof request !== "function") throw Error("Missing native RPC bridge");
  const host = {
    connection: {
      connected: true,
      canRead: true,
      canWrite: true,
      canGrant: true,
      canAdmin: true,
      assistantAgentId: "main",
    },
    request,
    subscribe: () => () => {},
    components: {
      mountDialog(container, props) {
        container.append(props.content);
        return {
          dispose: () => container.replaceChildren(),
          update: (next) => container.replaceChildren(next.content),
        };
      },
    },
    ui: {
      registerPage(page) {
        page.mount(root, { host, signal: new AbortController().signal });
        return () => {};
      },
      registerNavigation: () => () => {},
    },
  };
  module.default.activate(host);
})();
