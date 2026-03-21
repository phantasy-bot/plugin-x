import { createRoot } from "react-dom/client";

import {
  registerPluginAdminSurface,
  type PluginAdminNativeMountContext,
} from "@phantasy/agent/plugin-admin-ui";

import { XAdminApp } from "./x-admin-app";

function mountXPluginSurface(
  rootElement: HTMLElement,
  context: PluginAdminNativeMountContext,
): () => void {
  const root = createRoot(rootElement);
  root.render(<XAdminApp context={context} />);
  return () => root.unmount();
}

const registration = {
  mount(rootElement: HTMLElement, context: PluginAdminNativeMountContext) {
    return mountXPluginSurface(rootElement, context);
  },
};

registerPluginAdminSurface("x", registration);
registerPluginAdminSurface("x-plugin", registration);
