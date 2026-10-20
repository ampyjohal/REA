import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import type { BinarySessionPort } from "../../../src/application/binary/BinarySessionPort.js";
import { createServer } from "../../../src/server/createServer.js";
import { silentLogger } from "../../../src/logger.js";
import {
  createBinarySessionTargets,
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";

it("forwards beforeOpen through the BinarySessionPort contract", async () => {
  const [target] = await createBinarySessionTargets();
  const concrete = createTestBinarySession(createCacheProvider([]));
  const events: string[] = [];
  const session: BinarySessionPort = new Proxy(concrete, {
    get(instance, property) {
      if (property === "open")
        return (
          path: string,
          options?: Parameters<BinarySessionPort["open"]>[1],
        ) => {
          const beforeOpen = options?.beforeOpen;
          if (beforeOpen === undefined)
            throw new Error("The session port did not receive beforeOpen");
          events.push("beforeOpen received");
          return instance.open(path, {
            ...options,
            beforeOpen: async () => {
              events.push("beforeOpen invoked");
              return await beforeOpen();
            },
          });
        };
      const value: unknown = Reflect.get(instance, property, instance);
      return typeof value === "function" ? value.bind(instance) : value;
    },
  });
  const server = createServer(
    { kind: "session", session },
    { environment: {}, logger: silentLogger },
  );
  const client = new Client({ name: "before-open-contract", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path: target },
    });
    expect(opened.isError).not.toBe(true);
    expect(events).toEqual(["beforeOpen received", "beforeOpen invoked"]);
  } finally {
    await client.close();
    await server.close();
    await concrete.close();
  }
});
