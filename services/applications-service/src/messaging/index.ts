import { MessagingProvider } from "./types";
import { TermiiMessagingProvider } from "./termii";
import { SandboxMessagingProvider } from "./sandbox";

export * from "./types";
export * from "./templates";
export * from "./sandbox";
export * from "./termii";

let activeProvider: MessagingProvider | null = null;
const sandboxInstance = new SandboxMessagingProvider();

export function getMessagingProvider(): MessagingProvider {
  if (activeProvider) return activeProvider;

  const providerType = (process.env.MESSAGING_PROVIDER || "").toLowerCase();

  if (providerType === "termii" && process.env.TERMII_API_KEY) {
    activeProvider = new TermiiMessagingProvider();
  } else {
    // Default to Sandbox adapter when in test, dev, or without Termii credentials
    activeProvider = sandboxInstance;
  }

  return activeProvider;
}

export function setMessagingProviderForTest(provider: MessagingProvider | null) {
  activeProvider = provider;
}

export function getSandboxMessagingInstance(): SandboxMessagingProvider {
  return sandboxInstance;
}
