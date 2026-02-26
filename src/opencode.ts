import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";

export type Client = OpencodeClient;

export function createClient(baseUrl: string): Client {
  return createOpencodeClient({ baseUrl });
}

export async function createSession(client: Client): Promise<string> {
  const { data } = await client.session.create();
  if (!data) throw new Error("Failed to create session");
  return data.id;
}

export async function modifyFile(
  client: Client,
  sessionId: string,
  prompt: string,
  filePath: string,
): Promise<string> {
  const instruction = [
    prompt,
    "",
    "Return ONLY the modified file contents, wrapped in a single ```csharp code block. Do not include any explanation.",
  ].join("\n");

  // Subscribe to events to stream deltas as they arrive
  const { stream } = await client.event.subscribe();

  const streamDone = (async () => {
    for await (const event of stream) {
      if (!event || typeof event !== "object" || !("type" in event)) continue;
      const e = event as { type: string; properties?: Record<string, unknown> };
      if (e.type === "message.part.delta" && e.properties) {
        const { sessionID, delta } = e.properties as { sessionID: string; delta: string };
        if (sessionID === sessionId) {
          process.stdout.write(delta);
        }
      }
    }
  })();

  const { data } = await client.session.prompt({
    sessionID: sessionId,
    parts: [
      { type: "text", text: instruction },
      {
        type: "file",
        mime: "text/x-csharp",
        filename: filePath,
        url: `file://${filePath}`,
      },
    ],
  });

  // Stream completes when prompt finishes; give it a moment to flush
  await Promise.race([streamDone, new Promise((r) => setTimeout(r, 1000))]);
  process.stdout.write("\n");

  if (!data) throw new Error("No response from LLM");

  return extractCode(data.parts);
}

export async function sendFollowUp(
  client: Client,
  sessionId: string,
  message: string,
): Promise<string> {
  const { stream } = await client.event.subscribe();

  const streamDone = (async () => {
    for await (const event of stream) {
      if (!event || typeof event !== "object" || !("type" in event)) continue;
      const e = event as { type: string; properties?: Record<string, unknown> };
      if (e.type === "message.part.delta" && e.properties) {
        const { sessionID, delta } = e.properties as { sessionID: string; delta: string };
        if (sessionID === sessionId) {
          process.stdout.write(delta);
        }
      }
    }
  })();

  const { data } = await client.session.prompt({
    sessionID: sessionId,
    parts: [{ type: "text", text: message }],
  });

  await Promise.race([streamDone, new Promise((r) => setTimeout(r, 1000))]);
  process.stdout.write("\n");

  if (!data) throw new Error("No response from LLM");

  return extractCode(data.parts);
}

function extractCode(parts: any[]): string {
  const textParts: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && part.text) {
      textParts.push(part.text);
    }
  }
  const text = textParts.join("\n");

  const match = text.match(/```(?:csharp|cs)?\s*\n([\s\S]*?)```/);
  if (match) {
    return match[1].trimEnd() + "\n";
  }

  return text.trimEnd() + "\n";
}
